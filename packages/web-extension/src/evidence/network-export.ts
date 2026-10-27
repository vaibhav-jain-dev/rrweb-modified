/**
 * Serialize network requests for export, collapsing repeats of the exact
 * same call (same method/url/status/body - e.g. a polling GET that keeps
 * returning unchanged data) to a `{ sameAs: <requestId> }` pointer instead
 * of re-storing the headers/body every time. Unlike digest dedup, timing
 * and log fields (startTime, endTime, duration, actionSeq, tier, ...) are
 * kept on every occurrence, never folded away - each occurrence is still a
 * real event that happened at a real time, only the heavy repeated
 * payload is deduplicated.
 */
import type { NetworkRequest } from './types';

// A separator no URL or body can contain, spelled out so the key is readable.
const SEP = '\u0000';

function contentKey(req: NetworkRequest): string {
  return [req.method, req.url, req.status ?? '', req.requestBody ?? '', req.responseBody ?? ''].join(SEP);
}

/** Resource types whose bodies are what an evidence reader is after: the
 * app's own API traffic. Scripts, stylesheets, images and the like are the
 * bulk of a real recording's bytes (a Next.js chunk alone was 260 KB; the
 * extension's own inject.js another 210 KB) and nobody reads them. */
const PAYLOAD_RESOURCE_TYPES = new Set(['fetch', 'xhr', 'document', 'other']);

/** Whether requests of this CDP resource type carry API data worth a body. */
export function isPayloadResourceType(resourceType: string | undefined): boolean {
  return PAYLOAD_RESOURCE_TYPES.has((resourceType ?? 'other').toLowerCase());
}

/** A request whose payload is kept in the index. `noise`-tier requests were
 * excluded by a settings rule, so their bodies are never wanted; non-API
 * resource types carry code and assets, not data. The entry itself - method,
 * URL, status, timing, tier - always stays, so nothing about *what happened*
 * is lost, only bytes nobody was going to read. curl.sh is unaffected: it
 * reads the undeduped bundle. */
export function keepsPayload(req: NetworkRequest): boolean {
  if (req.tier === 'noise') return false;
  return isPayloadResourceType(req.resourceType);
}

export function serializeNetwork(requests: NetworkRequest[]): unknown[] {
  const firstRequestIdByContent = new Map<string, string>();
  return requests.map((req) => {
    if (!keepsPayload(req)) {
      const { requestHeaders, responseHeaders, requestBody, responseBody, ...meta } = req;
      const hadPayload =
        requestHeaders !== undefined ||
        responseHeaders !== undefined ||
        (requestBody ?? null) !== null ||
        (responseBody ?? null) !== null;
      return hadPayload ? { ...meta, payloadOmitted: req.tier === 'noise' ? 'noise' : 'asset' } : meta;
    }
    const key = contentKey(req);
    const firstId = firstRequestIdByContent.get(key);
    if (firstId === undefined) {
      firstRequestIdByContent.set(key, req.requestId);
      return req;
    }
    return {
      requestId: req.requestId,
      method: req.method,
      url: req.url,
      status: req.status,
      statusText: req.statusText,
      resourceType: req.resourceType,
      bodyTruncated: req.bodyTruncated,
      startTime: req.startTime,
      endTime: req.endTime,
      duration: req.duration,
      failed: req.failed,
      errorText: req.errorText,
      initiator: req.initiator,
      actionSeq: req.actionSeq,
      ambiguous: req.ambiguous,
      completedAfterSettle: req.completedAfterSettle,
      tier: req.tier,
      sameAs: firstId,
    };
  });
}
