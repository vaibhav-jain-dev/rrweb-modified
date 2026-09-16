import { describe, expect, it } from 'vitest';
import { mergeManifestLayer } from '~/utils/manifest';

describe('mergeManifestLayer', () => {
  it('unions array-valued keys instead of overwriting them', () => {
    const target: Record<string, unknown> = {
      permissions: ['activeTab', 'storage'],
    };
    mergeManifestLayer(target, { permissions: ['debugger'] });
    expect(target.permissions).toEqual(['activeTab', 'storage', 'debugger']);
  });

  it('de-duplicates when the same value appears in both layers', () => {
    const target: Record<string, unknown> = { permissions: ['storage'] };
    mergeManifestLayer(target, { permissions: ['storage', 'tabs'] });
    expect(target.permissions).toEqual(['storage', 'tabs']);
  });

  it('overwrites non-array keys as a plain assignment would', () => {
    const target: Record<string, unknown> = { manifest_version: 2 };
    mergeManifestLayer(target, { manifest_version: 3 });
    expect(target.manifest_version).toBe(3);
  });

  it('adds a new array key untouched when the target has none yet', () => {
    const target: Record<string, unknown> = {};
    mergeManifestLayer(target, { permissions: ['debugger'] });
    expect(target.permissions).toEqual(['debugger']);
  });
});
