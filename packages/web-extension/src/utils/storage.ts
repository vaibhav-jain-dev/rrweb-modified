import { openDB, type IDBPDatabase } from 'idb';
import type { eventWithTime } from '@rrweb/types';
import type { Session } from '~/types';

/**
 * Storage related functions with indexedDB.
 */

const EventDbName = 'events';
const EventStoreName = 'events'; // legacy store: one row holding the whole array
const ChunkStoreName = 'chunks'; // v2 store: many small rows, appended incrementally
const EventDbVersion = 2;

type EventData = {
  id: string;
  events: eventWithTime[];
};

/**
 * A chunk of events appended during an in-progress recording. Chunks are
 * written incrementally (see `appendEventChunk`) so that a service worker
 * eviction mid-recording loses at most one un-flushed chunk instead of the
 * entire session - unlike the legacy `events` store, which was only written
 * once, when the user pressed Stop.
 */
type EventChunk = {
  /** auto-incrementing primary key */
  chunkId?: number;
  sessionId: string;
  seq: number;
  events: eventWithTime[];
};

export async function getEventStore(): Promise<IDBPDatabase<unknown>> {
  return openDB(EventDbName, EventDbVersion, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore(EventStoreName, {
          keyPath: 'id',
          autoIncrement: false,
        });
      }
      if (oldVersion < 2) {
        const chunkStore = db.createObjectStore(ChunkStoreName, {
          keyPath: 'chunkId',
          autoIncrement: true,
        });
        chunkStore.createIndex('sessionId', 'sessionId', { unique: false });
      }
    },
  });
}

/**
 * Append one chunk of events for a session that is still recording. Safe to
 * call frequently (e.g. every 250ms) - each call is a single small write,
 * not a read-modify-write of the whole session.
 */
export async function appendEventChunk(
  sessionId: string,
  seq: number,
  events: eventWithTime[],
) {
  if (events.length === 0) return;
  const db = await getEventStore();
  await db.add(ChunkStoreName, { sessionId, seq, events } as EventChunk);
}

/**
 * Remove all incremental chunks for a session, e.g. once they have been
 * consolidated into a single `events` row, or the session was discarded.
 */
export async function clearEventChunks(sessionId: string) {
  const db = await getEventStore();
  const tx = db.transaction(ChunkStoreName, 'readwrite');
  const index = tx.store.index('sessionId');
  let cursor = await index.openCursor(IDBKeyRange.only(sessionId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

async function getEventChunks(
  db: IDBPDatabase<unknown>,
  sessionId: string,
): Promise<eventWithTime[]> {
  const chunks = (await db.getAllFromIndex(
    ChunkStoreName,
    'sessionId',
    sessionId,
  )) as EventChunk[];
  return chunks
    .sort((a, b) => a.seq - b.seq)
    .flatMap((chunk) => chunk.events);
}

/**
 * Read all events for a session, preferring incremental chunks (an
 * in-progress or not-yet-consolidated recording) and falling back to the
 * legacy single-row store (an already-finished, already-consolidated
 * session, or one recorded before chunking existed).
 */
export async function getEvents(id: string): Promise<eventWithTime[]> {
  const db = await getEventStore();
  const chunked = await getEventChunks(db, id);
  if (chunked.length > 0) return chunked;
  const data = (await db.get(EventStoreName, id)) as EventData | undefined;
  return data?.events ?? [];
}

const SessionStoreName = 'sessions';
export async function getSessionStore() {
  return openDB<Session>(SessionStoreName, 1, {
    upgrade(db) {
      // Create a store of objects
      db.createObjectStore(SessionStoreName, {
        // The 'id' property of the object will be the key.
        keyPath: 'id',
        // If it isn't explicitly set, create a value by auto incrementing.
        autoIncrement: false,
      });
    },
  });
}

/**
 * Create the session row up front, before any events exist. Called at
 * Start, not Stop, so that a session (and its chunks) are discoverable even
 * if the service worker is evicted before the user presses Stop.
 */
export async function createSession(session: Session) {
  const store = await getSessionStore();
  await store.add(SessionStoreName, session);
}

/**
 * Create a session with its full events array already known up front -
 * used by the "Import Session" flow (a complete recording arriving as a
 * JSON file), not by live recording, which uses `createSession` +
 * `appendEventChunk` + `finalizeSession` instead.
 */
export async function addSession(session: Session, events: eventWithTime[]) {
  const eventStore = await getEventStore();
  await eventStore.put(EventStoreName, { id: session.id, events });
  const store = await getSessionStore();
  await store.add(SessionStoreName, session);
}

/**
 * Consolidate a finished recording's chunks into the legacy single-row
 * `events` store and update the session metadata. Consolidating keeps
 * long-term storage (and `downloadSessions`/the player) simple, while
 * `appendEventChunk` is what keeps recording itself eviction-safe.
 */
export async function finalizeSession(session: Session) {
  const db = await getEventStore();
  const events = await getEventChunks(db, session.id);
  if (events.length > 0) {
    await db.put(EventStoreName, { id: session.id, events } as EventData);
  }
  await clearEventChunks(session.id);
  const store = await getSessionStore();
  await store.put(SessionStoreName, session);
}

export async function updateSession(
  session: Session,
  events?: eventWithTime[],
) {
  if (events) {
    const db = await getEventStore();
    await db.put(EventStoreName, { id: session.id, events } as EventData);
  }
  const store = await getSessionStore();
  await store.put(SessionStoreName, session);
}

export async function getSession(id: string) {
  const store = await getSessionStore();
  return store.get(SessionStoreName, id) as Promise<Session>;
}

export async function getAllSessions() {
  const store = await getSessionStore();
  const sessions = (await store.getAll(SessionStoreName)) as Session[];
  return sessions.sort((a, b) => b.createTimestamp - a.createTimestamp);
}

export async function deleteSession(id: string) {
  const eventStore = await getEventStore();
  const sessionStore = await getSessionStore();
  await Promise.all([
    clearEventChunks(id),
    eventStore.delete(EventStoreName, id),
    sessionStore.delete(SessionStoreName, id),
  ]);
}

export async function deleteSessions(ids: string[]) {
  const eventStore = await getEventStore();
  const sessionStore = await getSessionStore();
  const eventTransition = eventStore.transaction(EventStoreName, 'readwrite');
  const sessionTransition = sessionStore.transaction(
    SessionStoreName,
    'readwrite',
  );
  const promises = [];
  for (const id of ids) {
    promises.push(clearEventChunks(id));
    promises.push(eventTransition.store.delete(id));
    promises.push(sessionTransition.store.delete(id));
  }
  await Promise.all(promises).then(() => {
    return Promise.all([eventTransition.done, sessionTransition.done]);
  });
}

export async function downloadSessions(ids: string[]) {
  for (const sessionId of ids) {
    const events = await getEvents(sessionId);
    const session = await getSession(sessionId);
    const blob = new Blob([JSON.stringify({ session, events }, null, 2)], {
      type: 'application/json',
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session.name}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/**
 * A second IndexedDB database, separate from the rrweb `events` DB above,
 * for the evidence layer's own structured records: actions, network
 * requests, console entries, storage deltas, and UI digests. One generic
 * chunk store shared by all five kinds (rather than five near-identical
 * stores) keyed by session, kept small and append-only for the same
 * eviction-safety reason as `appendEventChunk`.
 */

export type EvidenceKind =
  | 'action'
  | 'network'
  | 'console'
  | 'storage'
  | 'digest'
  | 'screenshot'
  | 'redaction';

const EvidenceDbName = 'evidence';
const EvidenceChunkStoreName = 'evidence_chunks';
const EvidenceBlobStoreName = 'evidence_blobs';
const EvidenceDbVersion = 1;

type EvidenceChunk = {
  chunkId?: number;
  sessionId: string;
  kind: EvidenceKind;
  seq: number;
  items: unknown[];
};

/** Binary payloads (screenshots) kept out of the chunk store proper so a
 * chunk read for, say, network requests never has to skip over image
 * bytes. */
type EvidenceBlob = {
  id: string; // caller-chosen, e.g. `${sessionId}/${path}`
  sessionId: string;
  blob: Blob;
};

export async function getEvidenceStore(): Promise<IDBPDatabase<unknown>> {
  return openDB(EvidenceDbName, EvidenceDbVersion, {
    upgrade(db) {
      const chunkStore = db.createObjectStore(EvidenceChunkStoreName, {
        keyPath: 'chunkId',
        autoIncrement: true,
      });
      chunkStore.createIndex('sessionId', 'sessionId', { unique: false });
      db.createObjectStore(EvidenceBlobStoreName, { keyPath: 'id', autoIncrement: false });
    },
  });
}

export async function appendEvidenceChunk(
  sessionId: string,
  kind: EvidenceKind,
  seq: number,
  items: unknown[],
) {
  if (items.length === 0) return;
  const db = await getEvidenceStore();
  await db.add(EvidenceChunkStoreName, { sessionId, kind, seq, items } as EvidenceChunk);
}

export async function getEvidenceItems<T>(sessionId: string, kind: EvidenceKind): Promise<T[]> {
  const db = await getEvidenceStore();
  const chunks = (await db.getAllFromIndex(
    EvidenceChunkStoreName,
    'sessionId',
    sessionId,
  )) as EvidenceChunk[];
  return chunks
    .filter((c) => c.kind === kind)
    .sort((a, b) => a.seq - b.seq)
    .flatMap((c) => c.items) as T[];
}

export async function clearEvidenceChunks(sessionId: string) {
  const db = await getEvidenceStore();
  const tx = db.transaction(EvidenceChunkStoreName, 'readwrite');
  const index = tx.store.index('sessionId');
  let cursor = await index.openCursor(IDBKeyRange.only(sessionId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function putEvidenceBlob(sessionId: string, id: string, blob: Blob) {
  const db = await getEvidenceStore();
  await db.put(EvidenceBlobStoreName, { id, sessionId, blob } as EvidenceBlob);
}

export async function getEvidenceBlob(id: string): Promise<Blob | undefined> {
  const db = await getEvidenceStore();
  const row = (await db.get(EvidenceBlobStoreName, id)) as EvidenceBlob | undefined;
  return row?.blob;
}

export async function getEvidenceBlobsForSession(
  sessionId: string,
): Promise<{ id: string; blob: Blob }[]> {
  const db = await getEvidenceStore();
  const all = (await db.getAll(EvidenceBlobStoreName)) as EvidenceBlob[];
  return all.filter((b) => b.sessionId === sessionId).map(({ id, blob }) => ({ id, blob }));
}

export async function clearEvidenceForSession(sessionId: string) {
  await clearEvidenceChunks(sessionId);
  const db = await getEvidenceStore();
  const tx = db.transaction(EvidenceBlobStoreName, 'readwrite');
  const all = (await tx.store.getAll()) as EvidenceBlob[];
  await Promise.all(
    all.filter((b) => b.sessionId === sessionId).map((b) => tx.store.delete(b.id)),
  );
  await tx.done;
}
