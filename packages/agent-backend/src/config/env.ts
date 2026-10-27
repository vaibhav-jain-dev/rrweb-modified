import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Read an env file in either `KEY=value` or `KEY: value` form (the latter is
 * what `~/projects/.env.mongo` uses). Values are returned, never logged.
 */
export function readEnvFile(path: string): Record<string, string> {
  const text = readFileSync(expandHome(path), 'utf8');
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  const looksLikeDotenv = lines.some((l) =>
    /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.test(l),
  );
  if (looksLikeDotenv) {
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      )
        v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  }
  const parsed = parseYaml(text) as unknown;
  if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v !== null && v !== undefined) out[k] = String(v);
    }
  }
  return out;
}

/** `$NAME` / `${NAME}` substitution from an env map, for sources.yaml values. */
export function substituteEnv(
  value: string,
  env: Record<string, string | undefined>,
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)\b/g,
    (whole, a?: string, b?: string) => {
      const name = a ?? b!;
      const v = env[name];
      return v === undefined ? whole : v;
    },
  );
}
