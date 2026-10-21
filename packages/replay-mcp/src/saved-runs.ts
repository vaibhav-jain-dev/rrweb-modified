/** A patch that ran clean is kept beside the recording so a rerun needs no model. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import type { Patch } from './patch.ts';

const dirFor = (zip: string) => join(dirname(zip), `${basename(zip, '.zip')}.runs`);

export function patchId(patch: Patch | undefined): string {
  return createHash('sha1').update(JSON.stringify(patch ?? {})).digest('hex').slice(0, 8);
}

export function saveRun(zip: string, name: string | undefined, patch: Patch | undefined): string {
  const dir = dirFor(zip);
  mkdirSync(dir, { recursive: true });
  const id = name ?? patchId(patch);
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(patch ?? {}, null, 2));
  return id;
}

export function loadSavedRun(zip: string, id: string): Patch {
  const file = join(dirFor(zip), `${id}.json`);
  if (!existsSync(file)) throw new Error(`no saved run "${id}" (have: ${listSavedRuns(zip).join(', ') || 'none'})`);
  return JSON.parse(readFileSync(file, 'utf8')) as Patch;
}

export function listSavedRuns(zip: string): string[] {
  const dir = dirFor(zip);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
}
