/**
 * CDP console/error capture. Complements the in-page console-record rrweb
 * plugin (which stays on regardless, as a fallback and for replay) with
 * two things CDP alone can give us: `Log.entryAdded`, which surfaces
 * browser-level errors (CORS, CSP, mixed-content, network errors) that
 * never reach the page's own console, and `Runtime.exceptionThrown` for
 * uncaught exceptions with a real stack trace.
 */
import { onCdpEvent } from './attach';
import { redactValueShapes, type RedactionReport } from '~/evidence/redact';
import type { ConsoleRecord } from '~/evidence/types';

type CdpConsoleApiCalled = {
  type: string;
  args?: { value?: unknown; description?: string }[];
  timestamp: number;
};

type CdpExceptionThrown = {
  timestamp: number;
  exceptionDetails: {
    text?: string;
    exception?: { description?: string };
    stackTrace?: { callFrames?: { functionName?: string; url?: string; lineNumber?: number }[] };
  };
};

type CdpLogEntryAdded = {
  entry: { source: string; level: string; text: string; timestamp: number };
};

function stringifyArg(arg: { value?: unknown; description?: string }): string {
  if (arg.description) return arg.description;
  if (typeof arg.value === 'string') return arg.value;
  try {
    return JSON.stringify(arg.value);
  } catch {
    return String(arg.value);
  }
}

function mapLevel(type: string): ConsoleRecord['level'] {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning' || type === 'warn') return 'warn';
  if (type === 'debug') return 'debug';
  if (type === 'info') return 'info';
  return 'log';
}

export function attachConsoleCapture(
  tabId: number,
  sink: (entry: ConsoleRecord) => void,
  report?: RedactionReport,
): () => void {
  return onCdpEvent(tabId, (method, params) => {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const p = params as unknown as CdpConsoleApiCalled;
        const text = (p.args ?? []).map(stringifyArg).join(' ');
        sink({
          t: Date.now(),
          level: mapLevel(p.type),
          text: redactValueShapes(text, report).slice(0, 2000),
          source: 'console',
        });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const p = params as unknown as CdpExceptionThrown;
        const details = p.exceptionDetails;
        const text = details.exception?.description ?? details.text ?? 'Uncaught exception';
        const stack = details.stackTrace?.callFrames
          ?.slice(0, 10)
          .map((f) => `${f.functionName || '(anonymous)'} @ ${f.url ?? '?'}:${f.lineNumber ?? '?'}`);
        sink({
          t: Date.now(),
          level: 'error',
          text: redactValueShapes(text, report).slice(0, 2000),
          source: 'exception',
          stack,
        });
        break;
      }
      case 'Log.entryAdded': {
        const p = params as unknown as CdpLogEntryAdded;
        sink({
          t: Date.now(),
          level: p.entry.level === 'error' ? 'error' : p.entry.level === 'warning' ? 'warn' : 'log',
          text: redactValueShapes(p.entry.text, report).slice(0, 2000),
          source: 'browser-log',
        });
        break;
      }
      default:
        break;
    }
  });
}
