import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { initInteractionObserver } from '~/content/plugins/interaction';
import type { ActionRecord } from '~/evidence/types';

function render(html: string) {
  document.body.innerHTML = html;
}

function mockWin() {
  return window as unknown as Parameters<typeof initInteractionObserver>[1];
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('initInteractionObserver: click', () => {
  it('emits a click action with the accessible name and selector', () => {
    render('<button data-testid="approve">Approve</button>');
    const events: ActionRecord[] = [];
    const stop = initInteractionObserver((e) => events.push(e), mockWin(), {}, undefined);
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'click' });
    expect(events[0].target?.accessibleName).toBe('Approve');
    expect(events[0].target?.selector).toBe('[data-testid="approve"]');
    stop();
  });
});

describe('initInteractionObserver: input debouncing', () => {
  it('coalesces rapid input events into a single action after the debounce window', () => {
    render('<input type="text" name="q" />');
    const events: ActionRecord[] = [];
    const stop = initInteractionObserver((e) => events.push(e), mockWin(), { inputDebounceMs: 800 }, undefined);
    const input = document.querySelector('input')!;
    for (const char of 'pending') {
      input.value += char;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(100);
    }
    expect(events).toHaveLength(0); // still within the debounce window
    vi.advanceTimersByTime(800);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'input', value: 'pending', keystrokes: 7 });
    stop();
  });
});

describe('initInteractionObserver: masking', () => {
  it('never emits a value or accessible-name text for a password field', () => {
    render('<input type="password" name="password" />');
    const events: ActionRecord[] = [];
    const stop = initInteractionObserver((e) => events.push(e), mockWin(), {}, undefined);
    const input = document.querySelector('input')!;
    input.value = 'hunter2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(1000);
    expect(events).toHaveLength(1);
    expect(events[0].value).toBeUndefined();
    expect(events[0].target?.attrs.value).toBeUndefined();
    stop();
  });

  it('masks a field matched by a caller-supplied mask selector', () => {
    render('<input type="text" class="ssn-field" />');
    const events: ActionRecord[] = [];
    const stop = initInteractionObserver(
      (e) => events.push(e),
      mockWin(),
      { maskSelectors: ['.ssn-field'] },
      undefined,
    );
    const input = document.querySelector('input')!;
    input.value = '123-45-6789';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(1000);
    expect(events[0].value).toBeUndefined();
    stop();
  });
});

describe('initInteractionObserver: toggle / select', () => {
  it('emits a toggle action for a checkbox change', () => {
    render('<input type="checkbox" aria-label="Include archived" />');
    const events: ActionRecord[] = [];
    const stop = initInteractionObserver((e) => events.push(e), mockWin(), {}, undefined);
    const el = document.querySelector('input')! as HTMLInputElement;
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'toggle', value: 'true' });
    stop();
  });

  it('emits a select action for a <select> change with the selected option label', () => {
    render('<select aria-label="Status"><option value="all">All</option><option value="pending">Pending</option></select>');
    const events: ActionRecord[] = [];
    const stop = initInteractionObserver((e) => events.push(e), mockWin(), {}, undefined);
    const el = document.querySelector('select')! as HTMLSelectElement;
    el.value = 'pending';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'select', value: 'Pending' });
    stop();
  });
});

describe('initInteractionObserver: key', () => {
  it('emits a key action only for Enter/Escape/Tab, not arbitrary keys', () => {
    render('<input type="text" />');
    const events: ActionRecord[] = [];
    const stop = initInteractionObserver((e) => events.push(e), mockWin(), {}, undefined);
    const el = document.querySelector('input')!;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'key', value: 'Enter' });
    stop();
  });
});

describe('initInteractionObserver: teardown', () => {
  it('stop() removes all listeners and cancels pending debounced timers', () => {
    render('<button>Go</button><input type="text" />');
    const events: ActionRecord[] = [];
    const stop = initInteractionObserver((e) => events.push(e), mockWin(), {}, undefined);
    document.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }));
    stop();
    vi.advanceTimersByTime(2000);
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(events).toEqual([]);
  });
});
