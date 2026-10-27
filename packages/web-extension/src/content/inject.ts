import { record } from 'rrweb';
import type { recordOptions } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import type { RecordPlugin } from '@rrweb/types';
import { getRecordConsolePlugin } from '@rrweb/rrweb-plugin-console-record';
import { getRecordNetworkPlugin } from '@rrweb/rrweb-plugin-network-record';
import {
  MessageName,
  type EvidenceCaptureConfig,
  type RecordStartedMessage,
} from '~/types';
import { isInCrossOriginIFrame } from '~/utils';
import { getRecordInteractionPlugin } from './plugins/interaction';
import { getRecordStoragePlugin } from './plugins/storage';
import { buildDigest } from '~/evidence/digest';
import { extractAppMapNodes } from '~/evidence/appmap';

/**
 * This script is injected into both main page and cross-origin IFrames
 * through <script> tags. It runs in the page's MAIN world - required so
 * rrweb (and our own plugins) can patch the page's real fetch/XHR/console
 * and see real DOM event targets, none of which are reachable from the
 * isolated-world content script.
 */

let stopFn: (() => void) | null = null;

/** The content script stops waiting for a digest after 5s; one requested
 * longer ago than this would only block the page for an answer nobody reads. */
const STALE_DIGEST_REQUEST_MS = 4000;

/** Run when the page's main thread is free (input, rendering and the app's
 * own work first), but no later than `timeout`. */
function whenIdle(fn: () => void, timeout: number) {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn, { timeout });
  else setTimeout(fn, 0);
}

function buildPlugins(evidenceConfig: EvidenceCaptureConfig): RecordPlugin[] {
  const plugins: RecordPlugin[] = [
    getRecordInteractionPlugin({ maskSelectors: evidenceConfig.maskSelectors }) as RecordPlugin,
    getRecordStoragePlugin() as RecordPlugin,
    getRecordConsolePlugin({ level: ['error', 'warn', 'log', 'info'] }),
  ];
  if (evidenceConfig.useFallbackNetwork) {
    plugins.push(getRecordNetworkPlugin({ recordHeaders: true, recordBody: true }));
  }
  return plugins;
}

function startRecord(
  config: recordOptions<eventWithTime>,
  evidenceConfig: EvidenceCaptureConfig,
) {
  stopFn =
    record({
      emit: (event) => {
        postMessage({
          message: MessageName.EmitEvent,
          event,
        });
      },
      plugins: buildPlugins(evidenceConfig),
      ...config,
    }) || null;
  postMessage({
    message: MessageName.RecordStarted,
    startTimestamp: Date.now(),
  } as RecordStartedMessage);
}

const messageHandler = (
  event: MessageEvent<{
    message: MessageName;
    config?: recordOptions<eventWithTime>;
    evidenceConfig?: EvidenceCaptureConfig;
    requestId?: string;
    sentAt?: number;
  }>,
) => {
  if (event.source !== window) return;
  const data = event.data;
  const eventHandler = {
    [MessageName.StartRecord]: () => {
      startRecord(data.config || {}, data.evidenceConfig || {});
    },
    [MessageName.StopRecord]: () => {
      if (stopFn) {
        try {
          stopFn();
        } catch (e) {
          //
        }
      }
      postMessage({
        message: MessageName.RecordStopped,
        endTimestamp: Date.now(),
      });
      window.removeEventListener('message', messageHandler);
    },
    [MessageName.CaptureDigestRequest]: () => {
      whenIdle(() => {
        if (data.sentAt !== undefined && Date.now() - data.sentAt > STALE_DIGEST_REQUEST_MS) return;
        // route is passed as-is (pathname + search); a real router's
        // notion of "route" (with param placeholders) isn't reachable
        // generically from outside the app, so the URL path is the
        // portable choice here.
        const route = location.pathname + location.search;
        const digest = buildDigest(document, route);
        const appMapNodes = extractAppMapNodes(document, route, 0);
        postMessage({
          message: MessageName.CaptureDigestResponse,
          requestId: data.requestId,
          digest,
          appMapNodes,
        });
      }, 1000);
    },
  } as Record<MessageName, () => void>;
  if (eventHandler[data.message]) eventHandler[data.message]();
};

/**
 * Only post message in the main page.
 */
function postMessage(message: unknown) {
  if (!isInCrossOriginIFrame()) window.postMessage(message, location.origin);
}

window.addEventListener('message', messageHandler);

window.postMessage(
  {
    message: MessageName.RecordScriptReady,
  },
  location.origin,
);
