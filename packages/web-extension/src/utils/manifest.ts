/**
 * Layer a manifest fragment onto the accumulated manifest. A plain
 * `Object.assign` would let a later, narrower layer (e.g. `v3.chrome`)
 * silently replace an array-valued key such as `permissions` that an
 * earlier, broader layer (e.g. the top-level `common`) already populated -
 * instead of adding to it. Array-valued keys are unioned; everything else
 * keeps normal overwrite semantics.
 */
export function mergeManifestLayer(
  target: Record<string, unknown>,
  layer: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(layer)) {
    const existing = target[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      // `Array.isArray` narrows to `any[]`, not `unknown[]` - re-typed
      // explicitly so the spread below isn't an unsafe `any` spread.
      const existingItems = existing as unknown[];
      const newItems = value as unknown[];
      target[key] = Array.from(new Set([...existingItems, ...newItems]));
    } else {
      target[key] = value;
    }
  }
}
