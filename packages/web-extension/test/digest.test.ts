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
