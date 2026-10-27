/**
 * Read an earlier recording (`recording-*.zip`) so it can be replayed through
 * the rules (`probe`) or turned into a guided flow (`learn`).
 */
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import type {
  ActionRecord,
  NetworkRequest,
} from '../../web-extension/src/evidence/types.ts';

export type Recording = {
  name: string;
  actions: ActionRecord[];
  network: NetworkRequest[];
};

export function readRecording(path: string): Recording {
  const files = unzipSync(new Uint8Array(readFileSync(path)), {
    filter: (f) => f.name === 'network/index.json' || f.name === 'actions.json',
  });
  const net = files['network/index.json'];
  if (!net)
    throw new Error(
      `${path}: no network/index.json (is this a recording-*.zip?)`,
    );
  const raw = JSON.parse(strFromU8(net)) as (NetworkRequest & {
    sameAs?: string;
  })[];

  // A repeat of an identical call keeps its timing but points at the first
  // occurrence for headers and bodies; put the payload back.
  const byId = new Map(raw.map((r) => [r.requestId, r]));
  const network = raw.map((r) => {
    if (!r.sameAs) return r;
    const first = byId.get(r.sameAs);
    return first
      ? {
          ...r,
          requestHeaders: first.requestHeaders,
          responseHeaders: first.responseHeaders,
          requestBody: first.requestBody,
          responseBody: first.responseBody,
        }
      : r;
  });
  network.sort((a, b) => a.startTime - b.startTime);

  const act = files['actions.json'];
  const actions = act ? (JSON.parse(strFromU8(act)) as ActionRecord[]) : [];
  return { name: path.split('/').pop() ?? path, actions, network };
}
