import { describe, expect, it } from 'vitest';
import {
  redactHeaders,
  redactJson,
  redactBody,
  redactUrl,
  redactStorageValue,
  redactValueShapes,
  shouldMaskInput,
  type RedactionReport,
} from '~/evidence/redact';

describe('redactHeaders', () => {
  it('redacts denylisted headers but keeps their length', () => {
    const report: RedactionReport = {};
    const out = redactHeaders(
      { Authorization: 'Bearer abc123', 'X-Request-Id': 'r-1' },
      report,
    )!;
    expect(out.Authorization).toMatch(/^\[REDACTED:header\] \(len=13\)$/);
    expect(out['X-Request-Id']).toBe('r-1');
    expect(report.header).toBe(1);
  });

  it('leaves ordinary headers untouched', () => {
    const out = redactHeaders({ 'Content-Type': 'application/json' })!;
    expect(out['Content-Type']).toBe('application/json');
  });
});

describe('redactJson', () => {
  it('redacts denylisted keys at any depth', () => {
    const report: RedactionReport = {};
    const out = redactJson(
      { user: { name: 'Ada', password: 'hunter2' }, apiKey: 'xyz' },
      report,
    );
    expect(out).toEqual({
      user: { name: 'Ada', password: '[REDACTED:key]' },
      apiKey: '[REDACTED:key]',
    });
    expect(report.key).toBe(2);
  });

  it('keeps ordinary business data intact', () => {
    const out = redactJson({ status: 'pending', count: 24, active: true });
    expect(out).toEqual({ status: 'pending', count: 24, active: true });
  });
});

describe('redactBody', () => {
  it('redacts credential keys inside a JSON body', () => {
    const out = redactBody('{"password":"hunter2","status":"ok"}', 'application/json');
    expect(JSON.parse(out!)).toEqual({ password: '[REDACTED:key]', status: 'ok' });
  });

  it('redacts a JWT-shaped value even under a non-denylisted key', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactBody(`note=${jwt}`, 'text/plain');
    expect(out).not.toContain(jwt);
    expect(decodeURIComponent(out!)).toContain('[REDACTED:jwt]');
  });

  it('redacts a value under a denylisted key even without a recognizable shape', () => {
    const out = redactBody('token=opaque-server-issued-value', 'text/plain');
    expect(out).toBe('token=%5BREDACTED%3Akey%5D');
  });

  it('leaves ordinary response bodies untouched', () => {
    const out = redactBody('{"applications":[{"id":1,"status":"pending"}]}', 'application/json');
    expect(JSON.parse(out!)).toEqual({ applications: [{ id: 1, status: 'pending' }] });
  });
});

describe('redactUrl', () => {
  it('redacts denylisted query params', () => {
    const out = redactUrl('https://api.example.com/x?token=abc&status=pending');
    expect(out).toContain('status=pending');
    expect(out).not.toContain('token=abc');
    expect(out).toContain('%5BREDACTED');
  });

  it('leaves ordinary URLs untouched', () => {
    const url = 'https://api.example.com/applications?status=pending';
    expect(redactUrl(url)).toBe(url);
  });
});

describe('redactStorageValue', () => {
  it('fully redacts denylisted keys', () => {
    expect(redactStorageValue('auth_token', 'secret-value')).toBe('[REDACTED:storage-key]');
  });

  it('keeps ordinary keys', () => {
    expect(redactStorageValue('filter', 'pending')).toBe('pending');
  });
});

describe('redactValueShapes', () => {
  it('redacts Bearer tokens embedded in text', () => {
    const out = redactValueShapes('curl -H "Authorization: Bearer sk-abcdef123456"');
    expect(out).not.toContain('sk-abcdef123456');
  });
});

describe('shouldMaskInput', () => {
  it('always masks password inputs', () => {
    expect(shouldMaskInput({ type: 'password' })).toBe(true);
  });

  it('masks fields whose name matches the credential denylist', () => {
    expect(shouldMaskInput({ type: 'text', name: 'api_key' })).toBe(true);
  });

  it('does not mask ordinary fields', () => {
    expect(shouldMaskInput({ type: 'text', name: 'status' })).toBe(false);
  });
});
