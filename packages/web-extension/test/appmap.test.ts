import { describe, expect, it } from 'vitest';
import { emptyAppMap, extractAppMapNodes, mergeAppMapNodes, recordNavigationEdge } from '~/evidence/appmap';
import { findAppMapCandidates } from '~/evidence/reconcile';

function render(html: string) {
  document.body.innerHTML = html;
}

describe('mergeIntoAppMap', () => {
  it('discovers nav items, tabs, and tables into the map', () => {
    render(`
      <nav><a href="/apps">Applications</a><a href="/settings">Settings</a></nav>
      <div role="tablist"><button role="tab">Pending</button><button role="tab">Approved</button></div>
      <table><thead><tr><th>ID</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
    `);
    const nodes = extractAppMapNodes(document, '/apps', 1);
    const map = mergeAppMapNodes(emptyAppMap(), nodes);
    expect(map.nodes.some((n) => n.kind === 'nav-item' && n.label === 'Applications')).toBe(true);
    expect(map.nodes.filter((n) => n.kind === 'tab')).toHaveLength(2);
    expect(map.nodes.some((n) => n.kind === 'table')).toBe(true);
  });

  it('identifies a tab nested inside another tab context as nested-tab', () => {
    render(`
      <div role="tab">
        <div role="tab">Inner</div>
      </div>
    `);
    const nodes = extractAppMapNodes(document, '/x', 1);
    const map = mergeAppMapNodes(emptyAppMap(), nodes);
    expect(map.nodes.some((n) => n.kind === 'nested-tab')).toBe(true);
  });

  it('accumulates states across multiple observations without duplicating nodes', () => {
    render('<nav><a href="/a">A</a></nav>');
    let map = mergeAppMapNodes(emptyAppMap(), extractAppMapNodes(document, '/x', 1));
    expect(map.nodes).toHaveLength(1);

    render('<nav><a href="/a" style="display:none">A</a></nav>');
    map = mergeAppMapNodes(map, extractAppMapNodes(document, '/x', 2));
    expect(map.nodes).toHaveLength(1); // same selector -> merged, not duplicated
    expect(map.nodes[0].states.length).toBeGreaterThanOrEqual(1);
  });
});

describe('recordNavigationEdge', () => {
  it('adds a route node and an edge from the previous route', () => {
    const map = emptyAppMap();
    map.nodes.push({
      kind: 'route',
      id: 'route:/a:/a',
      selector: '/a',
      route: '/a',
      firstSeenAction: 0,
      states: ['visible-usable'],
    });
    recordNavigationEdge(map, '/a', '/b');
    expect(map.nodes.some((n) => n.route === '/b')).toBe(true);
    expect(map.edges).toHaveLength(1);
  });
});

describe('findAppMapCandidates', () => {
  it('flags a nav item that was visible-usable but never reached (unreachable_nav)', () => {
    const map = emptyAppMap();
    map.nodes.push({
      kind: 'nav-item',
      id: 'nav:/x:.link',
      label: 'Reports',
      selector: '.link',
      route: '/x',
      firstSeenAction: 1,
      states: ['visible-usable'],
      // no reachedBy - never clicked
    });
    const findings = findAppMapCandidates(map, []);
    expect(findings.some((f) => f.kind === 'unreachable_nav')).toBe(true);
  });

  it('does not flag a nav item that was actually reached (negative case)', () => {
    const map = emptyAppMap();
    map.nodes.push({
      kind: 'nav-item',
      id: 'nav:/x:.link',
      label: 'Reports',
      selector: '.link',
      route: '/x',
      firstSeenAction: 1,
      states: ['visible-usable'],
      reachedBy: 3,
    });
    const findings = findAppMapCandidates(map, []);
    expect(findings.some((f) => f.kind === 'unreachable_nav')).toBe(false);
  });

  it('flags a table with a page-size-shaped row count and no pagination control as missing_pagination', () => {
    const map = emptyAppMap();
    const digest = {
      url: '', route: '/x', title: '', capturedAt: 0, headings: [], landmarks: [],
      collections: [{ key: 'k', selector: 'table', count: 20 }],
      controls: [], status: [], counters: {}, textAtoms: [], hiddenAtoms: [], digestHash: 'h',
    };
    const findings = findAppMapCandidates(map, [digest]);
    expect(findings.some((f) => f.kind === 'missing_pagination')).toBe(true);
  });

  it('does not flag missing_pagination when a pagination control exists on the route (negative case)', () => {
    const map = emptyAppMap();
    map.nodes.push({
      kind: 'pagination',
      id: 'pg:/x:.pager',
      selector: '.pager',
      route: '/x',
      firstSeenAction: 1,
      states: ['visible-usable'],
    });
    const digest = {
      url: '', route: '/x', title: '', capturedAt: 0, headings: [], landmarks: [],
      collections: [{ key: 'k', selector: 'table', count: 20 }],
      controls: [], status: [], counters: {}, textAtoms: [], hiddenAtoms: [], digestHash: 'h',
    };
    const findings = findAppMapCandidates(map, [digest]);
    expect(findings.some((f) => f.kind === 'missing_pagination')).toBe(false);
  });

  it('does not flag an arbitrary row count that does not look page-sized (negative case)', () => {
    const map = emptyAppMap();
    const digest = {
      url: '', route: '/x', title: '', capturedAt: 0, headings: [], landmarks: [],
      collections: [{ key: 'k', selector: 'table', count: 7 }],
      controls: [], status: [], counters: {}, textAtoms: [], hiddenAtoms: [], digestHash: 'h',
    };
    const findings = findAppMapCandidates(map, [digest]);
    expect(findings.some((f) => f.kind === 'missing_pagination')).toBe(false);
  });
});
