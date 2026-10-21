import type { BrowserContext, Route } from 'playwright';

export type SlowRange = [minMs: number, maxMs: number];

/** Delay every fetch/XHR by a random amount, to see how the app copes with a slow server. */
export async function enableSlow(context: BrowserContext, range: SlowRange): Promise<() => Promise<void>> {
  const match = () => true;
  const handler = async (route: Route) => {
    const type = route.request().resourceType();
    if (type !== 'fetch' && type !== 'xhr') return route.continue().catch(() => undefined);
    const [min, max] = range;
    await new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
    await route.continue().catch(() => undefined);
  };
  await context.route(match, handler);
  return () => context.unroute(match, handler);
}
