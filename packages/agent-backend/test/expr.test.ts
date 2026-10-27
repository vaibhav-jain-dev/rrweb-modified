import { describe, expect, it } from 'vitest';
import {
  evaluate,
  getPath,
  interpolate,
  looseEquals,
  resolveRef,
  resolveValue,
} from '../src/expr.ts';
import { matchEndpoint, statusMatches } from '../src/endpoint.ts';
import { rec } from './helpers.ts';
import { requestScope } from '../src/lane.ts';

describe('getPath', () => {
  const data = { a: { b: [{ c: 1 }, { c: 2 }] }, 'x-user': 'u1' };
  it('walks dots and indexes', () => {
    expect(getPath(data, 'a.b[1].c')).toBe(2);
    expect(getPath(data, 'a.b.length')).toBe(2);
    expect(getPath(data, 'a.b.last.c')).toBe(2);
  });
  it('returns undefined for anything missing instead of throwing', () => {
    expect(getPath(data, 'a.z.y')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
    expect(getPath(data, 'a.b[9].c')).toBeUndefined();
  });
});

describe('references', () => {
  const r = rec(
    'PATCH',
    'https://h/lms/api/user/v1/loan-application/6a62d0b46ccb69068d608083/data?x=1',
    {
      req: { f1: { value: 10 }, f2: { value: 'a' } },
      res: { data: { _id: 'abc' } },
      status: 200,
    },
  );
  const scope = requestScope(r);

  it('reads request, response and path', () => {
    expect(resolveRef('$res.body.data._id', scope)).toBe('abc');
    expect(resolveRef('$res.status', scope)).toBe(200);
    expect(resolveRef('$path[0]', scope)).toBe('6a62d0b46ccb69068d608083');
    expect(resolveRef('$query.x', scope)).toBe('1');
  });
  it('applies pipes', () => {
    expect(resolveRef('$req.body | keys', scope)).toEqual(['f1', 'f2']);
    expect(resolveRef('$req.body | mapvalues(value)', scope)).toEqual({
      f1: 10,
      f2: 'a',
    });
    expect(resolveRef('$req.body | length', scope)).toBe(2);
  });
  it('treats non-$ strings as literals and recurses through structures', () => {
    expect(
      resolveValue({ a: '$res.status', b: ['x', '$path[0]'] }, scope),
    ).toEqual({
      a: 200,
      b: ['x', '6a62d0b46ccb69068d608083'],
    });
  });
  it('rejects unknown pipes rather than guessing', () => {
    expect(() => resolveRef('$req.body | eval(1)', scope)).toThrow(
      /unknown pipe/,
    );
  });
  it('leaves unknown names undefined', () => {
    expect(resolveRef('$nope.x', scope)).toBeUndefined();
  });
});

describe('interpolate', () => {
  it('fills known names and leaves unknown ones visible', () => {
    expect(
      interpolate('Loan {n} has {count} rows {missing}', {
        n: 'L-7',
        count: 3,
      }),
    ).toBe('Loan L-7 has 3 rows {missing}');
  });
});

describe('assertions', () => {
  it('compares ids and numbers the way a person would', () => {
    expect(looseEquals('12', 12)).toBe(true);
    expect(looseEquals({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true);
    expect(looseEquals('a', 'b')).toBe(false);
    expect(looseEquals(null, undefined)).toBe(true);
  });
  it('has_item matches an item on every given key', () => {
    const rows = [
      { _id: '1', status: 'open' },
      { _id: '2', status: 'waived' },
    ];
    expect(evaluate('has_item', rows, { _id: '2', status: 'waived' }).ok).toBe(
      true,
    );
    expect(evaluate('has_item', rows, { _id: '2', status: 'open' }).ok).toBe(
      false,
    );
    expect(evaluate('has_item', 'nope', { a: 1 }).ok).toBe(false);
  });
  it('includes_map names the keys that differ', () => {
    const out = evaluate('includes_map', { a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/2 differ/);
    expect(evaluate('includes_map', { a: 1, b: 2 }, { a: 1 }).ok).toBe(true);
  });
  it('covers the numeric and string operators', () => {
    expect(evaluate('gte', 3, 2).ok).toBe(true);
    expect(evaluate('lt', 3, 2).ok).toBe(false);
    expect(evaluate('in', 'a', ['a', 'b']).ok).toBe(true);
    expect(evaluate('contains', 'hello', 'ell').ok).toBe(true);
    expect(evaluate('regex', 'abc123', '\\d+').ok).toBe(true);
    expect(evaluate('regex', 'abc', '(').ok).toBe(false);
    expect(evaluate('exists', 0, undefined).ok).toBe(true);
    expect(evaluate('missing', undefined, undefined).ok).toBe(true);
  });
});

describe('endpoint matching', () => {
  it('matches :name segments and trailing slashes', () => {
    expect(matchEndpoint('POST /a/:id/b', 'POST', '/a/123/b')).toBe(true);
    expect(matchEndpoint('POST /a/:id/b', 'post', '/a/123/b/')).toBe(true);
    expect(matchEndpoint('POST /a/:id/b', 'GET', '/a/123/b')).toBe(false);
    expect(matchEndpoint('POST /a/:id/b', 'POST', '/a/123/c')).toBe(false);
    expect(matchEndpoint('POST /a/:id', 'POST', '/a/123/extra')).toBe(false);
  });
  it('supports * method and ** rest', () => {
    expect(matchEndpoint('* /a/:id', 'DELETE', '/a/9')).toBe(true);
    expect(matchEndpoint('GET /a/**', 'GET', '/a/b/c/d')).toBe(true);
  });
  it('does not let a :name match an empty segment', () => {
    expect(matchEndpoint('POST /a/:id/b', 'POST', '/a//b')).toBe(false);
  });
});

describe('status matching', () => {
  it('handles classes, lists, comparisons and wildcard', () => {
    expect(statusMatches('2xx', 201, false)).toBe(true);
    expect(statusMatches('2xx', 404, false)).toBe(false);
    expect(statusMatches('200,201', 201, false)).toBe(true);
    expect(statusMatches('>=400', 409, false)).toBe(true);
    expect(statusMatches('*', undefined, true)).toBe(true);
  });
  it('never treats a failed request as a success status', () => {
    expect(statusMatches('2xx', 200, true)).toBe(false);
  });
});
