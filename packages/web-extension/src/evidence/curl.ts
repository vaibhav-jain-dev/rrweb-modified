/**
 * Render a NetworkRequest as a cURL command. Operates on already-redacted
 * requests (this module never re-derives redaction) - it just formats.
 */
import type { NetworkRequest } from './types';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function toCurl(req: NetworkRequest): string {
  const parts = [`curl -X ${req.method || 'GET'}`, shellQuote(req.url)];
  for (const [key, value] of Object.entries(req.requestHeaders ?? {})) {
    parts.push(`-H ${shellQuote(`${key}: ${value}`)}`);
  }
  if (req.requestBody) {
    parts.push(`--data-raw ${shellQuote(req.requestBody)}`);
  }
  return parts.join(' \\\n  ');
}

export function toCurlScript(requests: NetworkRequest[]): string {
  return requests
    .map(
      (r) =>
        `# ${r.method ?? 'GET'} ${r.url} -> ${r.status ?? '(no response)'}\n${toCurl(r)}\n`,
    )
    .join('\n');
}
