/**
 * Secrets for a dev environment. Looked up in the environment first, then in a
 * KEY=VALUE file kept outside any repo (`~/.rrweb-replay/secrets.env`, or the
 * path in REPLAY_SECRETS_FILE), e.g. `REPLAY_SECRET_PASSWORD=...`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const file = () => process.env.REPLAY_SECRETS_FILE ?? join(homedir(), '.rrweb-replay', 'secrets.env');

export function secretKey(name: string): string {
  return `REPLAY_SECRET_${name.toUpperCase()}`;
}

export function getSecret(name: string): string | undefined {
  const key = secretKey(name);
  if (process.env[key] !== undefined) return process.env[key];
  const path = file();
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] === key) return m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}
