import { describe, expect, it } from 'vitest';
import { serializeNetwork } from '~/evidence/network-export';
import type { NetworkRequest } from '~/evidence/types';

function req(overrides: Partial<NetworkRequest>): NetworkRequest {
  return {
    requestId: 'r0',
    method: 'GET',
    url: 'https://api.example.test/data',
    status: 200,
    startTime: 0,
    ...overrides,
  };
}

describe('serializeNetwork', () => {
  it('keeps the full request on first occurrence of a given method/url/status/body', () => {
    const r = req({ responseBody: '{"a":1}' });
    expect(serializeNetwork([r])).toEqual([r]);
  });

  it('collapses a repeated identical response into a sameAs pointer, keeping its own timing', () => {
    const first = req({
      requestId: 'r0',
      responseBody: '{"a":1}',
      responseHeaders: { 'content-type': 'application/json' },
      startTime: 1000,
      endTime: 1050,
    });
    const repeat = req({
      requestId: 'r1',
      responseBody: '{"a":1}',
      responseHeaders: { 'content-type': 'application/json' },
      startTime: 5000,
      endTime: 5040,
      actionSeq: 3,
    });

    const out = serializeNetwork([first, repeat]) as Record<string, unknown>[];

    expect(out[0]).toEqual(first);
    expect(out[1]).toMatchObject({
      requestId: 'r1',
      sameAs: 'r0',
      startTime: 5000,
      endTime: 5040,
      actionSeq: 3,
    });
    // heavy payload fields must not be duplicated on the repeat
    expect(out[1]).not.toHaveProperty('responseBody');
    expect(out[1]).not.toHaveProperty('responseHeaders');
    expect(out[1]).not.toHaveProperty('requestHeaders');
    expect(out[1]).not.toHaveProperty('requestBody');
  });

  it('does not collapse requests that differ in status even if the URL matches', () => {
    const ok = req({ requestId: 'r0', status: 200, responseBody: '{}' });
    const failed = req({ requestId: 'r1', status: 500, responseBody: '{}' });
    const out = serializeNetwork([ok, failed]);
    expect(out).toEqual([ok, failed]);
  });

  it('does not collapse requests whose response body actually differs', () => {
    const a = req({ requestId: 'r0', responseBody: '{"a":1}' });
    const b = req({ requestId: 'r1', responseBody: '{"a":2}' });
    const out = serializeNetwork([a, b]);
    expect(out).toEqual([a, b]);
  });

  it('drops the payload of noise-tier and asset requests, keeping the entry itself', () => {
    const noise = req({
      requestId: 'n0',
      url: 'https://sentry.example.test/envelope',
      tier: 'noise',
      resourceType: 'Fetch',
      responseBody: '{"ok":true}',
      responseHeaders: { 'content-type': 'application/json' },
      actionSeq: 2,
    });
    const script = req({
      requestId: 's0',
      url: 'https://app.example.test/_next/static/chunk.js',
      tier: 'secondary',
      resourceType: 'Script',
      responseBody: 'x'.repeat(1000),
    });
    const api = req({ requestId: 'a0', tier: 'primary', resourceType: 'Fetch', responseBody: '{"a":1}' });
    const bare = req({ requestId: 'b0', tier: 'noise', resourceType: 'Image' });

    const out = serializeNetwork([noise, script, api, bare]) as Record<string, unknown>[];

    expect(out[0]).toMatchObject({ requestId: 'n0', tier: 'noise', actionSeq: 2, payloadOmitted: 'noise' });
    expect(out[0]).not.toHaveProperty('responseBody');
    expect(out[0]).not.toHaveProperty('responseHeaders');
    expect(out[1]).toMatchObject({ requestId: 's0', payloadOmitted: 'asset' });
    expect(out[1]).not.toHaveProperty('responseBody');
    expect(out[2]).toEqual(api); // the app's own API call keeps everything
    expect(out[3]).not.toHaveProperty('payloadOmitted'); // nothing was there to omit
  });

  it('points every repeat back to the first occurrence, not the immediately preceding one', () => {
    const first = req({ requestId: 'r0', responseBody: 'x' });
    const second = req({ requestId: 'r1', responseBody: 'x' });
    const third = req({ requestId: 'r2', responseBody: 'x' });
    const out = serializeNetwork([first, second, third]) as Record<string, unknown>[];
    expect(out[1].sameAs).toBe('r0');
    expect(out[2].sameAs).toBe('r0');
  });
});
