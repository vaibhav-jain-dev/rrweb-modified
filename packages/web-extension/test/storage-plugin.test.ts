import { describe, expect, it, vi } from 'vitest';
import { initStorageObserver } from '~/content/plugins/storage';
import type { StorageDelta } from '~/evidence/types';

/**
 * happy-dom's `localStorage`/`sessionStorage` are Proxy-backed internally
 * (property assignment is special-cased for the key/value item syntax),
 * so `storage.setItem = wrapped` - which works as a normal own-property
 * override in real Chrome, the target environment - does not actually
 * intercept calls under happy-dom. A plain mock object exercises the same
 * `initStorageObserver`/`patch()` code path without fighting that gap.
 */
function makeMockStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
    getItem: (key: string) => data.get(key) ?? null,
    key: (i: number) => Array.from(data.keys())[i] ?? null,
  } as Storage;
}

function makeMockWindow(local: Storage, session: Storage) {
  const listeners = new Map<string, EventListener>();
  return {
    localStorage: local,
    sessionStorage: session,
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Parameters<typeof initStorageObserver>[1];
}

describe('initStorageObserver', () => {
  it('emits a redacted delta on setItem', () => {
    const local = makeMockStorage();
    const win = makeMockWindow(local, makeMockStorage());
    const events: StorageDelta[] = [];
    const stop = initStorageObserver((e) => events.push(e), win);
    local.setItem('auth_token', 'super-secret');
    local.setItem('filter', 'pending');
    expect(events).toEqual([
      expect.objectContaining({ key: 'auth_token', op: 'set', value: '[REDACTED:storage-key]', area: 'local' }),
      expect.objectContaining({ key: 'filter', op: 'set', value: 'pending', area: 'local' }),
    ]);
    stop();
  });

  it('emits a delta on removeItem and clear', () => {
    const local = makeMockStorage();
    const win = makeMockWindow(local, makeMockStorage());
    const events: StorageDelta[] = [];
    const stop = initStorageObserver((e) => events.push(e), win);
    local.setItem('x', '1');
    local.removeItem('x');
    local.clear();
    expect(events.map((e) => e.op)).toEqual(['set', 'remove', 'clear']);
    stop();
  });

  it('tags sessionStorage writes with area "session"', () => {
    const local = makeMockStorage();
    const session = makeMockStorage();
    const win = makeMockWindow(local, session);
    const events: StorageDelta[] = [];
    const stop = initStorageObserver((e) => events.push(e), win);
    session.setItem('draft', 'unsaved text');
    expect(events).toEqual([expect.objectContaining({ area: 'session', key: 'draft' })]);
    stop();
  });

  it('still calls through to the real storage after emitting', () => {
    const local = makeMockStorage();
    const win = makeMockWindow(local, makeMockStorage());
    const stop = initStorageObserver(vi.fn(), win);
    local.setItem('a', 'b');
    expect(local.getItem('a')).toBe('b');
    stop();
  });

  it('stop() restores the original methods so no further events are emitted', () => {
    const local = makeMockStorage();
    const win = makeMockWindow(local, makeMockStorage());
    const events: StorageDelta[] = [];
    const stop = initStorageObserver((e) => events.push(e), win);
    stop();
    local.setItem('after-stop', 'x');
    expect(events).toEqual([]);
  });
});
