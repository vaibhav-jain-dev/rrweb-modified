/**
 * Network relevance tiering. Deliberately NOT a URL blocklist: relevance
 * is a weighted score over several weak signals, so a request is never
 * silently dropped just because its host looks like an ad/analytics
 * domain. Every request keeps its computed tier; "noise" requests are
 * still counted and summarized in the export, never discarded outright.
 */
import type { NetworkRequest, UIDigest } from './types';
import type { NetworkExclusionRule } from '~/types';
import { matchesAnyExclusion } from './network-exclusions';

const STATIC_RESOURCE_TYPES = new Set([
  'stylesheet',
  'image',
  'img',
  'font',
  'media',
  'favicon',
  'icon',
]);

const KNOWN_ANALYTICS_HOST_HINTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'hotjar.com',
  'sentry.io',
  'fullstory.com',
  'intercom.io',
  'amplitude.com',
  'facebook.net',
  'clarity.ms',
];

export type ClassifyContext = {
  pageOrigin: string;
  apiOrigins?: string[];
  actionWindowStart?: number;
  actionWindowEnd?: number;
  postActionDigest?: UIDigest;
  hasConsoleError?: boolean;
  /** User-configured (or default-recommended) exclusion rules - see
   * evidence/network-exclusions.ts. A match always tiers as `noise`,
   * regardless of score, so telemetry/preflight/static-asset traffic never
   * crowds out real backend calls in the "pure backend" evidence view. */
  excludeRules?: NetworkExclusionRule[];
};

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function looksLikeApiOrigin(url: string, apiOrigins: string[] = []): boolean {
  try {
    const origin = new URL(url).origin;
    return apiOrigins.includes(origin);
  } catch {
    return false;
  }
}

function responseAppearsInDigest(req: NetworkRequest, digest?: UIDigest): boolean {
  if (!digest || !req.responseBody) return false;
  try {
    const parsed: unknown = JSON.parse(req.responseBody);
    const values = new Set<string>();
    collectScalars(parsed, values, 0);
    const haystack = new Set([...digest.textAtoms, ...digest.hiddenAtoms]);
    for (const v of values) {
      if (haystack.has(v)) return true;
    }
  } catch {
    // not JSON - can't cheaply compare
  }
  return false;
}

function collectScalars(value: unknown, out: Set<string>, depth: number) {
  if (depth > 4 || out.size > 200) return;
  if (value === null || value === undefined) return;
  if (typeof value === 'string' && value.length > 0 && value.length <= 200) {
    out.add(value.trim());
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.add(String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => collectScalars(v, out, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((v) =>
      collectScalars(v, out, depth + 1),
    );
  }
}

/**
 * Score a request's relevance. Higher = more likely to matter to someone
 * debugging what the app did. Each signal is additive and independently
 * weak; no single signal (including a known-analytics host) is decisive.
 */
export function scoreRequest(req: NetworkRequest, ctx: ClassifyContext): number {
  let score = 0;

  const type = req.resourceType?.toLowerCase();
  if (type && STATIC_RESOURCE_TYPES.has(type)) score -= 3;
  if (type === 'xhr' || type === 'fetch' || type === 'xmlhttprequest') score += 4;
  if (type === 'document' || type === 'navigation') score += 3;

  if (isSameOrigin(req.url, ctx.pageOrigin)) score += 2;
  if (looksLikeApiOrigin(req.url, ctx.apiOrigins)) score += 3;

  const host = hostOf(req.url);
  if (host && KNOWN_ANALYTICS_HOST_HINTS.some((h) => host.includes(h))) score -= 2;

  if (req.actionSeq !== undefined) score += 3;

  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') score += 2;

  if (req.status !== undefined && req.status >= 400) score += 6;
  if (req.failed) score += 6;

  if (responseAppearsInDigest(req, ctx.postActionDigest)) score += 4;

  if (ctx.hasConsoleError) score += 1;

  const contentType = req.responseHeaders?.['content-type'] ?? req.responseHeaders?.['Content-Type'];
  if (contentType?.includes('json')) score += 2;
  if (contentType?.includes('html') && type !== 'document') score -= 1;

  return score;
}

export function classifyRequest(
  req: NetworkRequest,
  ctx: ClassifyContext,
): 'primary' | 'secondary' | 'noise' {
  if (matchesAnyExclusion(req, ctx.excludeRules)) return 'noise';
  if (req.failed || (req.status !== undefined && req.status >= 400)) return 'primary';
  const score = scoreRequest(req, ctx);
  if (score >= 6) return 'primary';
  if (score >= 1) return 'secondary';
  return 'noise';
}

export function classifyAll(
  requests: NetworkRequest[],
  ctx: ClassifyContext,
): NetworkRequest[] {
  return requests.map((r) => ({ ...r, tier: classifyRequest(r, ctx) }));
}
