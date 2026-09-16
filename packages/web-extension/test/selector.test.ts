import { describe, expect, it } from 'vitest';
import { buildSelector, looksGenerated } from '~/evidence/selector';

function render(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

describe('buildSelector', () => {
  it('prefers a data-testid attribute', () => {
    render('<button data-testid="filter-pending">Pending</button>');
    const el = document.querySelector('button')!;
    const result = buildSelector(el, document);
    expect(result.selector).toBe('[data-testid="filter-pending"]');
  });

  it('falls back to a minimal CSS path when nothing stable is unique', () => {
    render('<div><span>a</span><span>b</span></div>');
    const spans = document.querySelectorAll('span');
    const result = buildSelector(spans[1], document);
    expect(document.querySelectorAll(result.selector)).toHaveLength(1);
    expect(document.querySelector(result.selector)).toBe(spans[1]);
  });

  it('every candidate selector resolves to exactly the target element', () => {
    render(
      '<form><label for="s">Status</label><select id="s" name="status"><option>Pending</option></select></form>',
    );
    const el = document.querySelector('select')!;
    const result = buildSelector(el, document);
    for (const candidate of result.selectorCandidates) {
      if (candidate.startsWith('role=') || candidate.startsWith('label=')) continue;
      expect(document.querySelectorAll(candidate)).toHaveLength(1);
      expect(document.querySelector(candidate)).toBe(el);
    }
  });

  it('builds a role locator from accessible name', () => {
    render('<button>Approve</button>');
    const el = document.querySelector('button')!;
    const result = buildSelector(el, document);
    expect(result.selectorCandidates).toContain('role=button[name="Approve"]');
  });

  it('deprioritizes a generated-looking id in favor of a stable selector', () => {
    render('<button id=":r3:" name="approve-btn">Approve</button>');
    const el = document.querySelector('button')!;
    const result = buildSelector(el, document);
    expect(result.selector).not.toBe('#\\:r3\\:');
  });
});

describe('looksGenerated', () => {
  it('flags React useId-style ids', () => {
    expect(looksGenerated(':r0:')).toBe(true);
  });

  it('flags emotion/styled-components hashes', () => {
    expect(looksGenerated('css-1a2b3c4')).toBe(true);
  });

  it('does not flag ordinary author-chosen ids', () => {
    expect(looksGenerated('status-filter')).toBe(false);
    expect(looksGenerated('submit-button')).toBe(false);
  });
});
