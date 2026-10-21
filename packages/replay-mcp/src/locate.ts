/**
 * Find the element a step meant. The recorded locator first; then the other
 * selectors the recorder saved; then role + accessible name; then text. All
 * of them are polled until the step's time limit, because on a slow API the
 * element often just has not rendered yet.
 */
import type { Locator, Page } from 'playwright';
import type { Step } from './types.ts';

const ROLE = /^role=([a-z]+)(?:\[name="([\s\S]*)"\])?$/;

export function toLocator(page: Page, spec: string): Locator {
  if (spec.startsWith('css=')) return page.locator(spec.slice(4));
  const m = ROLE.exec(spec);
  if (m) {
    const name = m[2];
    return page.getByRole(m[1] as Parameters<Page['getByRole']>[0], name ? { name, exact: true } : undefined);
  }
  return page.locator(spec);
}

export type Found = { locator: Locator; via: string; repaired: boolean };

async function firstVisible(loc: Locator): Promise<Locator | null> {
  const n = Math.min(await loc.count(), 6);
  for (let i = 0; i < n; i++) {
    const one = loc.nth(i);
    if (await one.isVisible().catch(() => false)) return one;
  }
  return null;
}

/** `a > b > svg > path` → `a > b > svg`, `a > b`: the clickable thing around a tiny icon. */
function ancestors(spec: string): string[] {
  if (!spec.startsWith('css=')) return [];
  const parts = spec.slice(4).split(' > ');
  const out: string[] = [];
  for (let drop = 1; drop <= 3 && parts.length - drop >= 2; drop++) out.push(`css=${parts.slice(0, parts.length - drop).join(' > ')}`);
  return out;
}

export function candidateSpecs(step: Step, late = false): string[] {
  const specs = [...step.candidates];
  if (late && ['click', 'dblclick', 'toggle'].includes(step.type)) specs.push(...ancestors(step.locator ?? ''));
  const name = step.name?.replace(/​/g, '').trim();
  if (name) {
    if (step.role) specs.push(`role=${step.role}[name="${name}"]`);
    specs.push(`text=${name}`);
  }
  return [...new Set(specs)];
}

export async function findLocator(page: Page, step: Step, timeoutMs: number): Promise<Found | null> {
  if (candidateSpecs(step).length === 0) return null;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  do {
    // the ancestors of a tiny icon are only tried once the exact selectors have had half the time
    const late = Date.now() - startedAt > timeoutMs / 2;
    for (const spec of candidateSpecs(step, late)) {
      try {
        const visible = await firstVisible(spec.startsWith('text=') ? page.getByText(spec.slice(5), { exact: true }) : toLocator(page, spec));
        if (visible) return { locator: visible, via: spec, repaired: spec !== step.locator };
      } catch {
        // an unparsable selector or a page mid-navigation: try the next one
      }
    }
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  return null;
}
