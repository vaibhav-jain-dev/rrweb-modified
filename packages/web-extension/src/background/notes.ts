/**
 * The recorder's comments, persisted the moment they are made. Each start/
 * done is appended to the evidence store immediately, and the open list
 * lives in chrome.storage.local, so neither depends on anything held in the
 * service worker's memory - Chrome may stop and restart that mid-recording.
 */
import { nanoid } from 'nanoid';
import Browser from 'webextension-polyfill';
import { LocalDataKey, type LocalData, type OpenNote } from '~/types';
import type { NoteEvent } from '~/evidence/types';
import { appendEvidenceChunk } from '~/utils/storage';

// Read-modify-write on the open list must not interleave: two quick
// clicks would each read the same list and one would be lost.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

async function readOpen(): Promise<OpenNote[]> {
  const stored = (await Browser.storage.local.get(LocalDataKey.openNotes)) as Partial<LocalData>;
  return stored[LocalDataKey.openNotes] ?? [];
}

async function writeOpen(open: OpenNote[]) {
  await Browser.storage.local.set({ [LocalDataKey.openNotes]: open });
}

// The chunk's `seq` only orders chunks of one kind; folding sorts events by
// time, so a timestamp-plus-random seq is unique enough without a counter
// that a restart would reset.
const noteSeq = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

/** Open a note now. If another is open the new one is its child. */
export function addNote(sessionId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return Promise.resolve();
  return serialized(async () => {
    const open = await readOpen();
    const parent = open[open.length - 1];
    const note: OpenNote = {
      id: nanoid(8),
      text: trimmed,
      startedAt: Date.now(),
      depth: parent ? parent.depth + 1 : 0,
    };
    const event: NoteEvent = { kind: 'start', id: note.id, parentId: parent?.id, text: note.text, t: note.startedAt };
    await appendEvidenceChunk(sessionId, 'note', noteSeq(), [event]);
    await writeOpen([...open, note]);
  });
}

/** Mark a note done - the innermost open one without an id. Closing an
 * outer note closes everything inside it. */
export function doneNote(sessionId: string, id?: string): Promise<void> {
  return serialized(async () => {
    const open = await readOpen();
    const index = id ? open.findIndex((n) => n.id === id) : open.length - 1;
    if (index < 0) return;
    const t = Date.now();
    const events: NoteEvent[] = open
      .slice(index)
      .reverse()
      .map((n) => ({ kind: 'done', id: n.id, t }));
    await appendEvidenceChunk(sessionId, 'note', noteSeq(), events);
    await writeOpen(open.slice(0, index));
  });
}
