/**
 * Recommended network exclusions for the "pure backend" evidence view -
 * telemetry, static assets, and CORS preflights that show up in every
 * capture but never represent the app's own backend API. Ships as
 * enabled-by-default rules the user can individually deselect (or add to)
 * from the extension's Settings page; see NetworkExclusionRule in types.ts.
 */
import type { NetworkExclusionRule } from '~/types';
import type { NetworkRequest } from './types';

export const RECOMMENDED_NETWORK_EXCLUSIONS: NetworkExclusionRule[] = [
  {
    id: 'sentry',
    label: 'Sentry (error/session telemetry)',
    pattern: '*.sentry.*',
    enabled: true,
    builtin: true,
  },
  {
    id: 'google-analytics',
    label: 'Google Analytics / Tag Manager',
    pattern: '*google-analytics.com*,*googletagmanager.com*,*doubleclick.net*',
    enabled: true,
    builtin: true,
  },
  {
    id: 'segment',
    label: 'Segment',
    pattern: '*segment.io*,*segment.com*',
    enabled: true,
    builtin: true,
  },
  {
    id: 'mixpanel',
    label: 'Mixpanel',
    pattern: '*mixpanel.com*',
    enabled: true,
    builtin: true,
  },
  {
    id: 'hotjar',
    label: 'Hotjar',
    pattern: '*hotjar.com*',
    enabled: true,
    builtin: true,
  },
  {
    id: 'fullstory',
    label: 'FullStory',
    pattern: '*fullstory.com*',
    enabled: true,
    builtin: true,
  },
  {
    id: 'intercom',
    label: 'Intercom',
    pattern: '*intercom.io*',
    enabled: true,
    builtin: true,
  },
  {
    id: 'amplitude',
    label: 'Amplitude',
    pattern: '*amplitude.com*',
    enabled: true,
    builtin: true,
  },
  {
    id: 'clarity',
    label: 'Microsoft Clarity',
    pattern: '*clarity.ms*',
    enabled: true,
    builtin: true,
  },
  {
    id: 'facebook-pixel',
    label: 'Facebook Pixel',
    pattern: '*facebook.net*',
    enabled: true,
    builtin: true,
  },
  {
    id: 'cors-preflight',
    label: 'CORS preflight requests (OPTIONS)',
    pattern: 'method:OPTIONS',
    enabled: true,
    builtin: true,
  },
  {
    id: 'extension-internal',
    label: "The extension's own injected scripts",
    pattern: 'chrome-extension://*,moz-extension://*',
    enabled: true,
    builtin: true,
  },
];

/** Glob (`*` = any run of characters) to RegExp, case-insensitive. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** A rule's `pattern` may hold several comma-separated globs. */
function matchesPattern(req: NetworkRequest, pattern: string): boolean {
  if (pattern.startsWith('method:')) {
    return req.method?.toUpperCase() === pattern.slice('method:'.length).toUpperCase();
  }
  const host = hostOf(req.url);
  return pattern
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .some((glob) => globToRegExp(glob).test(host) || globToRegExp(glob).test(req.url));
}

export function matchesAnyExclusion(
  req: NetworkRequest,
  rules: NetworkExclusionRule[] = [],
): NetworkExclusionRule | undefined {
  return rules.find((rule) => rule.enabled && matchesPattern(req, rule.pattern));
}
