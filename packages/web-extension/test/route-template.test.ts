import { describe, expect, it } from 'vitest';
import { templateEndpoint, templateRoute } from '~/evidence/route-template';

describe('templateRoute', () => {
  it('replaces identifiers in path segments and query values, keeping everything else', () => {
    const route =
      '/home/c/8a3602a6-ce9c-4eef-8f96-343d3b160650/p/68c536780617959688182237/f/68c536780617959688182238/dashboard?viewMode=pipeline&viewId=default&loanId=6a623ce76d236412cfa935c2';
    expect(templateRoute(route)).toBe(
      '/home/c/:id/p/:id/f/:id/dashboard?viewMode=pipeline&viewId=default&loanId=:id',
    );
  });

  it('leaves ordinary routes alone', () => {
    expect(templateRoute('/login')).toBe('/login');
    expect(templateRoute('/applications?status=pending')).toBe('/applications?status=pending');
    expect(templateRoute('')).toBe('');
  });

  it('treats long numeric keys as ids but short ones as part of the route', () => {
    expect(templateRoute('/loans/202600722/edit')).toBe('/loans/:id/edit');
    expect(templateRoute('/api/v1/items')).toBe('/api/v1/items');
  });
});

describe('templateEndpoint', () => {
  it('is the method and the templated path, without the query', () => {
    expect(
      templateEndpoint('GET', 'https://api.example.test/lms/api/user/v1/loan-application/6a623ce76d236412cfa935c2/data?lightweight=true'),
    ).toBe('GET /lms/api/user/v1/loan-application/:id/data');
  });
});
