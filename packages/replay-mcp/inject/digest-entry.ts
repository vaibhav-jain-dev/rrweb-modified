import { buildDigest, diffDigests } from '../../web-extension/src/evidence/digest.ts';

(window as unknown as { __rrDigest: (route: string) => unknown }).__rrDigest = (route) =>
  buildDigest(document, route);

(window as unknown as { __rrDiff: (a: unknown, b: unknown) => string[] }).__rrDiff = (a, b) =>
  diffDigests(a as Parameters<typeof diffDigests>[0], b as Parameters<typeof diffDigests>[1]).summary;
