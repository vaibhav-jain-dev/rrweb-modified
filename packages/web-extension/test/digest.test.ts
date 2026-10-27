import { describe, expect, it } from 'vitest';
import { buildDigest, diffDigests } from '~/evidence/digest';

function render(html: string) {
  document.body.innerHTML = html;
}

const TABLE_24 = (rows: number, extra = '') => `
  <table>
    <thead><tr><th>ID</th><th>Status</th></tr></thead>
    <tbody>${Array.from({ length: rows }, (_, i) => `<tr><td>${i}</td><td>Pending</td></tr>`).join('')}</tbody>
  </table>${extra}
`;

describe('buildDigest', () => {
  it('extracts a table as a collection with columns and count', () => {
    render(TABLE_24(24));
    const digest = buildDigest(document, '/applications');
    expect(digest.collections).toHaveLength(1);
    expect(digest.collections[0].count).toBe(24);
    expect(digest.collections[0].columns).toEqual(['ID', 'Status']);
  });

  it('captures counters like "24 results"', () => {
    render('<p>Showing 24 results</p>');
    const digest = buildDigest(document, '/applications');
    expect(digest.counters.results).toBe(24);
  });

  it('separates visible text from hidden (display:none) text', () => {
    render('<div>Visible text</div><div style="display:none">Hidden text</div>');
    // happy-dom has no layout engine - it reports a zero-size box for
    // every element regardless of CSS, so give the "visible" div a real
    // size the way a real browser's layout would. The hidden div is left
    // alone: `display:none` is itself enough for computeVisibility to
    // mark it dom-only-hidden, with or without a size.
    const visibleDiv = document.body.children[0];
    Object.defineProperty(visibleDiv, 'getBoundingClientRect', {
      value: () => ({ width: 50, height: 10 }),
    });
    const digest = buildDigest(document, '/x');
    expect(digest.textAtoms).toContain('Visible text');
    expect(digest.hiddenAtoms).toContain('Hidden text');
    expect(digest.textAtoms).not.toContain('Hidden text');
  });

  it('separates aria-hidden text into hiddenAtoms even if visually sized', () => {
    render('<div style="width:10px;height:10px" aria-hidden="true">Ghost text</div>');
    const el = document.body.firstElementChild!;
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ width: 10, height: 10 }),
    });
    const digest = buildDigest(document, '/x');
    expect(digest.hiddenAtoms).toContain('Ghost text');
    expect(digest.textAtoms).not.toContain('Ghost text');
  });

  it('records control state (disabled, checked)', () => {
    render('<input type="checkbox" checked disabled aria-label="Include archived" />');
    const digest = buildDigest(document, '/x');
    const control = digest.controls.find((c) => c.role === 'checkbox');
    expect(control?.checked).toBe(true);
    expect(control?.disabled).toBe(true);
  });

  it('produces the same digestHash for identical content', () => {
    render(TABLE_24(5));
    const a = buildDigest(document, '/x');
    render(TABLE_24(5));
    const b = buildDigest(document, '/x');
    expect(a.digestHash).toBe(b.digestHash);
  });

  it('produces a different digestHash when row count changes', () => {
    render(TABLE_24(5));
    const a = buildDigest(document, '/x');
    render(TABLE_24(7));
    const b = buildDigest(document, '/x');
    expect(a.digestHash).not.toBe(b.digestHash);
  });
});

describe('buildDigest on a long page', () => {
  function onScreen(el: Element) {
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 10, width: 50, height: 10, top: 10, left: 0, right: 50, bottom: 20 }),
    });
  }

  it('records the page size and leaves `truncated` off a page within the caps', () => {
    render(TABLE_24(5));
    const digest = buildDigest(document, '/x');
    expect(digest.elementCount).toBe(document.getElementsByTagName('*').length);
    expect(digest.truncated).toBeUndefined();
  });

  it('caps controls, keeps the ones on screen and reports the total', () => {
    render(Array.from({ length: 400 }, (_, i) => `<button>Item ${i}</button>`).join(''));
    const buttons = Array.from(document.querySelectorAll('button'));
    buttons.slice(390, 395).forEach(onScreen);
    const digest = buildDigest(document, '/feed');
    expect(digest.controls.length).toBeLessThanOrEqual(300);
    expect(digest.truncated?.controls).toBe(400);
    const names = digest.controls.map((c) => c.name);
    for (let i = 390; i < 395; i++) expect(names).toContain(`Item ${i}`);
    // still in document order
    expect(names.indexOf('Item 390')).toBeGreaterThan(names.indexOf('Item 0'));
  });

  it('keeps the largest collections when there are too many', () => {
    const small = Array.from({ length: 60 }, () => '<ul><li>tag a</li><li>tag b</li></ul>').join('');
    const feed = `<ul id="feed">${Array.from({ length: 30 }, (_, i) => `<li>Post ${i}</li>`).join('')}</ul>`;
    render(small + feed);
    const digest = buildDigest(document, '/feed');
    expect(digest.truncated?.collections).toBe(61);
    expect(digest.collections.some((c) => c.selector === '#feed' && c.count === 30)).toBe(true);
  });

  it('counts every control in the hash, not only the listed ones', () => {
    render(Array.from({ length: 400 }, (_, i) => `<button>Item ${i}</button>`).join(''));
    const before = buildDigest(document, '/feed');
    document.body.insertAdjacentHTML('beforeend', '<button>Item 400</button>');
    const after = buildDigest(document, '/feed');
    expect(after.digestHash).not.toBe(before.digestHash);
  });
});

describe('diffDigests', () => {
  it('reports a row-count change in the requested "24 -> 7" shape', () => {
    render(TABLE_24(24));
    const before = buildDigest(document, '/applications');
    render(TABLE_24(7));
    const after = buildDigest(document, '/applications');
    const diff = diffDigests(before, after);
    expect(diff.summary.some((s) => /24.*→.*7/.test(s))).toBe(true);
    expect(diff.collectionChanges[0]).toMatchObject({ countBefore: 24, countAfter: 7 });
  });

  it('reports a route change', () => {
    render('<div>a</div>');
    const before = buildDigest(document, '/applications');
    const after = buildDigest(document, '/applications/123');
    const diff = diffDigests(before, after);
    expect(diff.routeChanged).toEqual({ before: '/applications', after: '/applications/123' });
  });

  it('produces no changes for an identical digest', () => {
    render(TABLE_24(5));
    const before = buildDigest(document, '/x');
    const after = buildDigest(document, '/x');
    const diff = diffDigests(before, after);
    expect(diff.summary).toEqual([]);
  });

  it('reports a control value change', () => {
    render('<select aria-label="Status"><option value="all">All</option></select>');
    const before = buildDigest(document, '/x');
    (document.querySelector('select') as HTMLSelectElement).value = 'pending';
    const after = buildDigest(document, '/x');
    const diff = diffDigests(before, after);
    expect(diff.controlChanges).toHaveLength(1);
  });
});
