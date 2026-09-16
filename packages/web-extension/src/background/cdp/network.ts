/**
 * CDP-sourced network capture. Correlates Network.requestWillBeSent /
 * responseReceived / loadingFinished / loadingFailed by requestId, fetches
 * bodies via Network.getResponseBody once a request finishes, and
 * redacts before ever handing a NetworkRequest to the caller's sink -
 * nothing unredacted leaves this module.
 */
import { onCdpEvent, sendCommand } from './attach';
import {
  redactBody,
  redactHeaders,
  redactUrl,
  type RedactionReport,
} from '~/evidence/redact';
import type { NetworkRequest } from '~/evidence/types';

const MAX_BODY_BYTES = 256 * 1024;

type PendingRequest = {
  requestId: string;
  method: string;
  url: string;
  resourceType?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string | null;
  startTime: number;
  initiatorStack?: string[];
};

type CdpRequestWillBeSent = {
  requestId: string;
  request: { method: string; url: string; headers?: Record<string, string>; postData?: string };
  type?: string;
  timestamp: number;
  wallTime: number;
  initiator?: { type: string; stack?: { callFrames?: { functionName?: string; url?: string; lineNumber?: number }[] } };
};

type CdpResponseReceived = {
  requestId: string;
  response: { status: number; statusText: string; headers?: Record<string, string>; mimeType?: string };
  timestamp: number;
};

type CdpLoadingFinished = { requestId: string; timestamp: number };
type CdpLoadingFailed = { requestId: string; timestamp: number; errorText: string; canceled?: boolean };

export function attachNetworkCapture(
  tabId: number,
  sink: (req: NetworkRequest) => void,
  report?: RedactionReport,
): () => void {
  const pending = new Map<string, PendingRequest>();
  const wallTimeOffset = new Map<string, number>(); // CDP monotonic-clock -> Date.now() offset

  const unsubscribe = onCdpEvent(tabId, (method, params) => {
    switch (method) {
      case 'Network.requestWillBeSent': {
        const p = params as unknown as CdpRequestWillBeSent;
        wallTimeOffset.set(p.requestId, p.wallTime * 1000 - p.timestamp * 1000);
        pending.set(p.requestId, {
          requestId: p.requestId,
          method: p.request.method,
          url: redactUrl(p.request.url, report),
          resourceType: p.type,
          requestHeaders: redactHeaders(p.request.headers, report),
          requestBody: p.request.postData
            ? redactBody(p.request.postData, p.request.headers?.['content-type'], report)
            : undefined,
          startTime: p.wallTime * 1000,
          initiatorStack: p.initiator?.stack?.callFrames
            ?.slice(0, 5)
            .map((f) => `${f.functionName || '(anonymous)'} @ ${f.url ?? '?'}:${f.lineNumber ?? '?'}`),
        });
        break;
      }
      case 'Network.responseReceived': {
        const p = params as unknown as CdpResponseReceived;
        const req = pending.get(p.requestId);
        if (!req) break;
        (req as PendingRequest & { status?: number; statusText?: string; responseHeaders?: Record<string, string>; mimeType?: string }).status =
          p.response.status;
        (req as PendingRequest & { statusText?: string }).statusText = p.response.statusText;
        (req as PendingRequest & { responseHeaders?: Record<string, string> }).responseHeaders =
          redactHeaders(p.response.headers, report);
        (req as PendingRequest & { mimeType?: string }).mimeType = p.response.mimeType;
        break;
      }
      case 'Network.loadingFinished': {
        const p = params as unknown as CdpLoadingFinished;
        void finalize(p.requestId, false);
        break;
      }
      case 'Network.loadingFailed': {
        const p = params as unknown as CdpLoadingFailed;
        void finalize(p.requestId, true, (params as unknown as CdpLoadingFailed).errorText);
        break;
      }
      default:
        break;
    }
  });

  async function finalize(requestId: string, failed: boolean, errorText?: string) {
    const req = pending.get(requestId) as
      | (PendingRequest & {
          status?: number;
          statusText?: string;
          responseHeaders?: Record<string, string>;
          mimeType?: string;
        })
      | undefined;
    if (!req) return;
    pending.delete(requestId);
    wallTimeOffset.delete(requestId);

    let responseBody: string | null = null;
    let bodyTruncated = false;
    if (!failed) {
      const bodyResult = await sendCommand<{ body: string; base64Encoded: boolean }>(
        tabId,
        'Network.getResponseBody',
        { requestId },
      );
      if (bodyResult) {
        const raw = bodyResult.base64Encoded
          ? decodeBase64Safe(bodyResult.body)
          : bodyResult.body;
        if (raw !== undefined) {
          bodyTruncated = raw.length > MAX_BODY_BYTES;
          const truncated = bodyTruncated ? raw.slice(0, MAX_BODY_BYTES) : raw;
          responseBody = redactBody(truncated, req.mimeType, report);
        }
      }
    }

    const endTime = Date.now();
    sink({
      requestId,
      method: req.method,
      url: req.url,
      status: req.status,
      statusText: req.statusText,
      resourceType: req.resourceType,
      requestHeaders: req.requestHeaders,
      responseHeaders: req.responseHeaders,
      requestBody: req.requestBody ?? null,
      responseBody,
      bodyTruncated,
      startTime: req.startTime,
      endTime,
      duration: endTime - req.startTime,
      failed,
      errorText,
      initiator: req.initiatorStack ? { type: 'script', stack: req.initiatorStack } : undefined,
    });
  }

  return unsubscribe;
}

function decodeBase64Safe(base64: string): string | undefined {
  try {
    // Response bodies (images, fonts, etc.) that are base64-encoded and
    // not text aren't useful to redact/render as text; represent them as
    // a short placeholder rather than emitting binary garbage.
    const binary = atob(base64);
    // Deliberately matching tab/LF/CR plus printable ASCII, to
    // heuristically detect a text body.
    // eslint-disable-next-line no-control-regex
    const isProbablyText = /^[\x09\x0A\x0D\x20-\x7E]*$/.test(binary.slice(0, 200));
    return isProbablyText ? binary : `[evidence] binary body (${binary.length} bytes, base64)`;
  } catch {
    return undefined;
  }
}
