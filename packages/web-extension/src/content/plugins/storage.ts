/**
 * rrweb RecordPlugin: captures localStorage/sessionStorage as redacted,
 * key-level deltas - never a full periodic dump. Patches setItem/
 * removeItem/clear on both storages (mirroring the `patch()` approach
 * \@rrweb/utils and the network-record plugin already use for fetch/XHR)
 * and also listens for the native `storage` event, which fires for
 * changes made from *other* tabs/frames on the same origin.
 */
import type { IWindow, RecordPlugin } from '@rrweb/types';
import { patch } from '@rrweb/utils';
import { redactStorageValue } from '~/evidence/redact';
import type { StorageDelta } from '~/evidence/types';
import { STORAGE_PLUGIN_NAME } from '~/evidence/plugin-names';
export { STORAGE_PLUGIN_NAME };

export type StoragePluginOptions = Record<string, never>;

function areaOf(win: IWindow, storage: Storage): 'local' | 'session' {
  return storage === win.localStorage ? 'local' : 'session';
}

export function initStorageObserver(
  cb: (payload: StorageDelta) => void,
  win: IWindow,
): () => void {
  const unpatches: (() => void)[] = [];

  function patchStorage(storage: Storage) {
    const area = areaOf(win, storage);
    unpatches.push(
      patch(storage, 'setItem', ((original: Storage['setItem']) =>
        function (this: Storage, key: string, value: string) {
          cb({
            t: Date.now(),
            area,
            key,
            op: 'set',
            value: redactStorageValue(key, value),
          });
          return original.call(this, key, value);
        }) as (...args: unknown[]) => unknown),
    );
    unpatches.push(
      patch(storage, 'removeItem', ((original: Storage['removeItem']) =>
        function (this: Storage, key: string) {
          cb({ t: Date.now(), area, key, op: 'remove' });
          return original.call(this, key);
        }) as (...args: unknown[]) => unknown),
    );
    unpatches.push(
      patch(storage, 'clear', ((original: Storage['clear']) =>
        function (this: Storage) {
          cb({ t: Date.now(), area, key: '*', op: 'clear' });
          return original.call(this);
        }) as (...args: unknown[]) => unknown),
    );
  }

  try {
    patchStorage(win.localStorage);
  } catch {
    // storage may be inaccessible (e.g. sandboxed iframe) - degrade quietly
  }
  try {
    patchStorage(win.sessionStorage);
  } catch {
    // ignore
  }

  const storageEventHandler = (e: StorageEvent) => {
    if (!e.key) return; // e.key is null for a clear() from another context
    cb({
      t: Date.now(),
      area: 'local', // the native `storage` event only fires for localStorage
      key: e.key,
      op: e.newValue === null ? 'remove' : 'set',
      value: e.newValue === null ? undefined : redactStorageValue(e.key, e.newValue),
    });
  };
  win.addEventListener('storage', storageEventHandler);

  return () => {
    unpatches.forEach((fn) => fn());
    win.removeEventListener('storage', storageEventHandler);
  };
}

export function getRecordStoragePlugin(): RecordPlugin<StoragePluginOptions> {
  return {
    name: STORAGE_PLUGIN_NAME,
    observer: (cb, win) => initStorageObserver(cb as (p: StorageDelta) => void, win),
    options: {},
  };
}
