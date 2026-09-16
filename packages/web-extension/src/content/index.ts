import Browser from 'webextension-polyfill';
import { nanoid } from 'nanoid';
import {
  type CaptureDigestResponseMessage,
  type EvidenceCaptureConfig,
  type LocalData,
  LocalDataKey,
  RecorderStatus,
  ServiceName,
  type RecordStartedMessage,
  type RecordStoppedMessage,
  MessageName,
  type EmitEventMessage,
  EventName,
} from '~/types';
import Channel from '~/utils/channel';
import { isInCrossOriginIFrame } from '~/utils';

const channel = new Channel();

void (() => {
  window.addEventListener(
    'message',
    (
      event: MessageEvent<{
        message: MessageName;
      }>,
    ) => {
      if (event.source !== window) return;
      if (event.data.message === MessageName.RecordScriptReady)
        void respondToRecordScriptReady();
    },
  );
  if (isInCrossOriginIFrame()) {
    void initCrossOriginIframe();
  } else if (window === window.top) {
    void initMainPage();
  }
})();

async function initMainPage() {
  let startResponseCb: ((response: RecordStartedMessage) => void) | undefined =
    undefined;
  channel.provide(ServiceName.StartRecord, async () => {
    startRecord();
    return new Promise((resolve) => {
      startResponseCb = (response) => {
        resolve(response);
      };
    });
  });
  let stopResponseCb: ((response: RecordStoppedMessage) => void) | undefined =
    undefined;
  channel.provide(ServiceName.StopRecord, () => {
    window.postMessage({ message: MessageName.StopRecord });
    return new Promise((resolve) => {
      stopResponseCb = (response: RecordStoppedMessage) => {
        stopResponseCb = undefined;
        resolve(response);
      };
    });
  });

  const digestCallbacks = new Map<
    string,
    (payload: { digest: unknown; appMapNodes: unknown[] }) => void
  >();
  channel.provide(ServiceName.CaptureDigest, () => {
    const requestId = nanoid();
    window.postMessage(
      { message: MessageName.CaptureDigestRequest, requestId },
      location.origin,
    );
    return new Promise((resolve) => {
      // Bounded wait: if inject.ts isn't running (recording isn't
      // active, or the page navigated mid-request), never hang the
      // caller forever.
      const timeout = setTimeout(() => {
        digestCallbacks.delete(requestId);
        resolve(undefined);
      }, 5000);
      digestCallbacks.set(requestId, (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });
  });

  window.addEventListener(
    'message',
    (
      event: MessageEvent<
        | RecordStartedMessage
        | RecordStoppedMessage
        | EmitEventMessage
        | {
            message: MessageName;
          }
      >,
    ) => {
      if (event.source !== window) return;
      else if (
        event.data.message === MessageName.RecordStarted &&
        startResponseCb
      )
        startResponseCb(event.data as RecordStartedMessage);
      else if (
        event.data.message === MessageName.RecordStopped &&
        stopResponseCb
      ) {
        // On firefox, the event.data is immutable, so we need to clone it to avoid errors.
        const data = { ...(event.data as RecordStoppedMessage) };
        stopResponseCb(data);
      } else if (event.data.message === MessageName.EmitEvent)
        channel.emit(
          EventName.ContentScriptEmitEvent,
          (event.data as EmitEventMessage).event,
        );
      else if (event.data.message === MessageName.CaptureDigestResponse) {
        const data = event.data as CaptureDigestResponseMessage;
        const cb = digestCallbacks.get(data.requestId);
        if (cb) {
          digestCallbacks.delete(data.requestId);
          cb({ digest: data.digest, appMapNodes: data.appMapNodes });
        }
      }
    },
  );

  const localData = (await Browser.storage.local.get()) as LocalData;
  if (
    localData?.[LocalDataKey.recorderStatus]?.status ===
    RecorderStatus.RECORDING
  ) {
    startRecord();
  }
}

async function initCrossOriginIframe() {
  Browser.storage.local.onChanged.addListener((change) => {
    if (change[LocalDataKey.recorderStatus]) {
      const statusChange = change[LocalDataKey.recorderStatus];
      const newStatus =
        statusChange.newValue as LocalData[LocalDataKey.recorderStatus];
      if (newStatus.status === RecorderStatus.RECORDING) startRecord();
      else
        window.postMessage(
          { message: MessageName.StopRecord },
          location.origin,
        );
    }
  });
  const localData = (await Browser.storage.local.get()) as LocalData;
  if (
    localData?.[LocalDataKey.recorderStatus]?.status ===
    RecorderStatus.RECORDING
  )
    startRecord();
}

function startRecord() {
  const scriptEl = document.createElement('script');
  scriptEl.src = Browser.runtime.getURL('content/inject.js');
  document.documentElement.appendChild(scriptEl);
  scriptEl.onload = () => {
    document.documentElement.removeChild(scriptEl);
  };
}

/**
 * inject.ts (main world) announces it has loaded and is ready to receive
 * its start-recording config; this content script (isolated world) reads
 * the per-session evidence-capture config the background script left in
 * storage.local (see background/index.ts) and forwards it along with
 * rrweb's own recordCrossOriginIframes option.
 */
async function respondToRecordScriptReady() {
  const localData = (await Browser.storage.local.get(
    LocalDataKey.evidenceConfig,
  )) as LocalData | undefined;
  const evidenceConfig: EvidenceCaptureConfig =
    localData?.[LocalDataKey.evidenceConfig] ?? {};
  window.postMessage(
    {
      message: MessageName.StartRecord,
      config: {
        recordCrossOriginIframes: true,
      },
      evidenceConfig,
    },
    location.origin,
  );
}
