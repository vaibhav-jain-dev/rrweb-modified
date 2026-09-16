import { describe, expect, it } from 'vitest';
import { matchesAnyExclusion, RECOMMENDED_NETWORK_EXCLUSIONS } from '~/evidence/network-exclusions';
import { classifyRequest } from '~/evidence/classify';
import type { NetworkRequest } from '~/evidence/types';

function req(overrides: Partial<NetworkRequest>): NetworkRequest {
  return {
    requestId: 'r1',
    method: 'GET',
    url: 'https://api.example.test/data',
    startTime: 0,
    status: 200,
    ...overrides,
  };
}

describe('matchesAnyExclusion', () => {
  it('matches a Sentry ingest host against the recommended *.sentry.* rule', () => {
    const rule = matchesAnyExclusion(
      req({ url: 'https://o123.ingest.us.sentry.io/api/456/envelope/' }),
      RECOMMENDED_NETWORK_EXCLUSIONS,
    );
    expect(rule?.id).toBe('sentry');
  });

  it('matches OPTIONS preflights by method, not host', () => {
    const rule = matchesAnyExclusion(
      req({ method: 'OPTIONS', url: 'https://api.example.test/data' }),
      RECOMMENDED_NETWORK_EXCLUSIONS,
    );
    expect(rule?.id).toBe('cors-preflight');
  });

  it('does not match a real backend API host', () => {
    const rule = matchesAnyExclusion(
      req({ url: 'https://dev-ecs-api-gateway.example.com/lms/api/v1/profile-config' }),
      RECOMMENDED_NETWORK_EXCLUSIONS,
    );
    expect(rule).toBeUndefined();
  });

  it('a disabled rule never matches', () => {
    const rule = matchesAnyExclusion(
      req({ url: 'https://o123.ingest.us.sentry.io/envelope/' }),
      RECOMMENDED_NETWORK_EXCLUSIONS.map((r) =>
        r.id === 'sentry' ? { ...r, enabled: false } : r,
      ),
    );
    expect(rule).toBeUndefined();
  });

  it('supports comma-separated globs within one rule', () => {
    const rule = matchesAnyExclusion(
      req({ url: 'https://www.googletagmanager.com/gtag/js' }),
      RECOMMENDED_NETWORK_EXCLUSIONS,
    );
    expect(rule?.id).toBe('google-analytics');
  });

  it('matches a custom user-added pattern', () => {
    const rule = matchesAnyExclusion(req({ url: 'https://telemetry.internal.test/beacon' }), [
      { id: 'custom', label: 'Internal telemetry', pattern: '*.internal.test*', enabled: true },
    ]);
    expect(rule?.id).toBe('custom');
  });
});

describe('classifyRequest with excludeRules', () => {
  it('tiers an excluded request as noise even though it would otherwise score primary', () => {
    const sentryPost = req({
      method: 'POST',
      url: 'https://o123.ingest.us.sentry.io/api/456/envelope/',
      actionSeq: 0,
    });
    const tier = classifyRequest(sentryPost, {
      pageOrigin: 'https://app.example.test',
      excludeRules: RECOMMENDED_NETWORK_EXCLUSIONS,
    });
    expect(tier).toBe('noise');
  });

  it('leaves a real backend call unaffected by exclusion rules', () => {
    const apiCall = req({
      url: 'https://app.example.test/api/v1/loan-application/1/data',
      actionSeq: 0,
    });
    const tier = classifyRequest(apiCall, {
      pageOrigin: 'https://app.example.test',
      apiOrigins: ['https://app.example.test'],
      excludeRules: RECOMMENDED_NETWORK_EXCLUSIONS,
    });
    expect(tier).toBe('primary');
  });
});
