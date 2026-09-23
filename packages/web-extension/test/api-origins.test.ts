import { describe, expect, it } from 'vitest';
import { classifyRequest, inferApiOrigins } from '~/evidence/classify';
import type { NetworkRequest } from '~/evidence/types';

function req(overrides: Partial<NetworkRequest>): NetworkRequest {
  return { requestId: 'r', method: 'GET', url: 'https://app.example.test/', status: 200, startTime: 0, ...overrides };
}

describe('inferApiOrigins', () => {
  it('is every origin that answered a fetch or XHR with JSON, busiest first', () => {
    const requests = [
      req({ url: 'https://gateway.example.test/lms/api/v1/a', resourceType: 'Fetch', responseHeaders: { 'content-type': 'application/json' } }),
      req({ url: 'https://gateway.example.test/lms/api/v1/b', resourceType: 'XHR', responseHeaders: { 'Content-Type': 'application/json; charset=utf-8' } }),
      req({ url: 'https://app.example.test/home?_rsc=1', resourceType: 'Fetch', responseHeaders: { 'content-type': 'text/x-component' } }),
      req({ url: 'https://app.example.test/api/session', resourceType: 'Fetch', responseHeaders: { 'content-type': 'application/json' } }),
      req({ url: 'https://images.example.test/icon.png', resourceType: 'Image', responseHeaders: { 'content-type': 'image/png' } }),
      req({ url: 'https://cdn.example.test/chunk.js', resourceType: 'Script', responseHeaders: { 'content-type': 'application/json' } }),
      // Telemetry answers JSON too, and is not the app's API.
      req({ url: 'https://o123.ingest.us.sentry.io/api/1/envelope/', resourceType: 'Fetch', responseHeaders: { 'content-type': 'application/json' } }),
      req({ url: 'https://metrics.example.test/collect', resourceType: 'Fetch', responseHeaders: { 'content-type': 'application/json' }, tier: 'noise' }),
    ];
    expect(inferApiOrigins(requests)).toEqual(['https://gateway.example.test', 'https://app.example.test']);
  });

  it('lets a gateway call outrank an icon from the page origin', () => {
    const page = 'https://app.example.test';
    const gateway = req({
      url: 'https://gateway.example.test/lms/api/v1/loan-application/1/data',
      resourceType: 'Fetch',
      responseHeaders: { 'content-type': 'application/json' },
      actionSeq: 2,
    });
    const icon = req({ url: `${page}/_next/image?url=x`, resourceType: 'Image', actionSeq: 2 });
    const ctx = { pageOrigin: page, apiOrigins: [page, ...inferApiOrigins([gateway, icon])] };
    expect(classifyRequest(gateway, ctx)).toBe('primary');
    expect(classifyRequest(icon, ctx)).not.toBe('primary');
  });
});
