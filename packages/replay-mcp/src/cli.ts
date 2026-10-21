/**
 * node src/cli.ts <recording.zip> [--set 18.value="check 2"]... [--skip 7,8]
 *   [--range 2,19] [--patch file.json] [--reuse name] [--save name]
 *   [--slow 3000,8000] [--list]
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { PatchSchema } from './patch.ts';
import type { Patch } from './patch.ts';
import { Service } from './service.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    set: { type: 'string', multiple: true },
    skip: { type: 'string' },
    range: { type: 'string' },
    patch: { type: 'string' },
    reuse: { type: 'string' },
    save: { type: 'string' },
    slow: { type: 'string' },
    list: { type: 'boolean' },
    continue: { type: 'boolean' },
  },
});
const zip = positionals[0];
if (!zip) {
  console.error('usage: node src/cli.ts <recording.zip> [--list] [--set 18.value=…] [--skip 7,8] [--range a,b] [--patch f.json] [--reuse n] [--save n] [--slow min,max]');
  process.exit(2);
}

const nums = (s?: string) => (s ? s.split(',').map(Number) : undefined);
let patch: Patch | undefined = values.patch ? PatchSchema.parse(JSON.parse(readFileSync(values.patch, 'utf8'))) : undefined;
if (values.set || values.skip || values.range) {
  const set = Object.fromEntries((values.set ?? []).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const range = nums(values.range);
  patch = PatchSchema.parse({ ...patch, set: { ...patch?.set, ...set }, skip: [...(patch?.skip ?? []), ...(nums(values.skip) ?? [])], range: range as [number, number] | undefined });
}

const svc = new Service();
console.log(svc.load(zip));
if (values.list) process.exit(0);
const slow = nums(values.slow) as [number, number] | undefined;
const out = await svc.run({ patch, reuse: values.reuse, save: values.save, slow, continueOnDiverge: values.continue, log: (m) => console.error(`  ${m}`) });
console.log(`\n${out}`);
await svc.close();
process.exit(out.startsWith('ok') ? 0 : 1);
