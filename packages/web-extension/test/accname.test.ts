import { describe, expect, it } from 'vitest';
import { computeAccessibleName, computeVisibility } from '~/evidence/accname';

function render(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

describe('computeAccessibleName', () => {
  it('prefers aria-label over text content', () => {
    const el = render('<button aria-label="Close dialog">X</button>');
    expect(computeAccessibleName(el)).toBe('Close dialog');
  });

  it('resolves aria-labelledby to referenced element text', () => {
    document.body.innerHTML =
      '<span id="lbl">Status filter</span><select aria-labelledby="lbl"></select>';
    const el = document.querySelector('select')!;
    expect(computeAccessibleName(el)).toBe('Status filter');
  });

  it('uses an associated <label for>', () => {
    document.body.innerHTML = '<label for="s">Status</label><select id="s"></select>';
    const el = document.querySelector('select')!;
    expect(computeAccessibleName(el)).toBe('Status');
  });

  it('falls back to text content for a button', () => {
    const el = render('<button>Approve</button>');
    expect(computeAccessibleName(el)).toBe('Approve');
  });

  it('falls back to alt text for an image', () => {
    const el = render('<img alt="Company logo" />');
    expect(computeAccessibleName(el)).toBe('Company logo');
  });
});

describe('computeVisibility', () => {
  it('marks a display:none element as dom-only-hidden', () => {
    const el = render('<div style="display:none">hi</div>');
    expect(computeVisibility(el)).toBe('dom-only-hidden');
  });

  it('marks aria-hidden as dom-only-hidden even if visually sized', () => {
    document.body.innerHTML =
      '<div style="width:10px;height:10px" aria-hidden="true">hi</div>';
    const el = document.body.firstElementChild!;
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ width: 10, height: 10 }),
    });
    expect(computeVisibility(el)).toBe('dom-only-hidden');
  });

  it('marks a disabled but visible control as visible-disabled', () => {
    document.body.innerHTML = '<button style="width:10px;height:10px" disabled>Go</button>';
    const el = document.body.firstElementChild as HTMLButtonElement;
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ width: 10, height: 10 }),
    });
    expect(computeVisibility(el)).toBe('visible-disabled');
  });
});
