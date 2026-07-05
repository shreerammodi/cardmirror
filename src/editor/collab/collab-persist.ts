/**
 * Live-session persistence manager (M3).
 *
 * Attached alongside installSeams for every hosted/joined/resumed
 * session: on a short cadence (and on pagehide, the last reliable
 * moment before a kill) it writes the session's CRDT state to the
 * collab store as increments over the last persisted version —
 * steady-state writes are keystroke-sized, and every COMPACT_EVERY
 * increments the record is rebased onto a fresh snapshot. Cleared on
 * explicit Leave/End and on remote tombstone; a crash leaves the
 * record behind, which is the whole point — the home screen's
 * Sessions list resumes from it.
 */

import type { CollabSession } from './collab-session.js';
import {
  deleteSessionRecord,
  loadSessionRecord,
  saveSessionRecord,
  type PersistedSessionRecord,
} from './collab-store.js';

const PERSIST_MS = 2_500;
const COMPACT_EVERY = 40;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface PersistHandle {
  /** Force a write now (used at attach and before teardown). */
  flush(): Promise<void>;
  /** Stop persisting AND delete the record (Leave/End/tombstone). */
  clear(): Promise<void>;
  /** Stop persisting, keep the record (app-driven teardown paths that
   *  should stay resumable). */
  dispose(): void;
}

export function attachSessionPersistence(
  session: CollabSession,
  shareCode: string,
  getDocTitle: () => string,
): PersistHandle {
  let disposed = false;
  // Writes are serialized through a promise tail so an explicit
  // flush() AWAITS any in-flight write instead of silently no-oping
  // past it (the attach-time initial write races an immediate flush).
  let tail: Promise<void> = Promise.resolve();
  // In-memory mirror of the stored record; rebuilt from scratch when
  // absent so a resume continues the SAME record.
  let record: PersistedSessionRecord | null = null;

  const writeInner = async (): Promise<void> => {
    if (disposed) return;
    try {
      if (!record) {
        record = (await loadSessionRecord(session.roomId)) ?? null;
      }
      const meta = session.persistMeta();
      if (
        record &&
        record.increments.length < COMPACT_EVERY &&
        bytesEqual(record.persistedVersion, session.encodedVersion())
      ) {
        // Doc unchanged — refresh the cursor/sent metadata only when
        // they moved (otherwise skip the write entirely).
        if (record.lastSeq === meta.lastSeq && bytesEqual(record.sentVersion, meta.sentVersion)) {
          return;
        }
        record = {
          ...record,
          lastSeq: meta.lastSeq,
          sentVersion: meta.sentVersion,
          docTitle: getDocTitle(),
          updatedAt: Date.now(),
        };
        await saveSessionRecord(record);
        return;
      }
      if (record && record.increments.length < COMPACT_EVERY) {
        const inc = session.exportSince(record.persistedVersion);
        record = {
          ...record,
          increments: [...record.increments, inc.bytes],
          persistedVersion: inc.version,
          lastSeq: meta.lastSeq,
          sentVersion: meta.sentVersion,
          docTitle: getDocTitle(),
          updatedAt: Date.now(),
        };
      } else {
        // First write, or compaction due: rebase onto a full snapshot.
        record = {
          roomId: session.roomId,
          shareCode,
          role: session.role,
          lastSeq: meta.lastSeq,
          sentVersion: meta.sentVersion,
          snapshot: session.exportSnapshot(),
          increments: [],
          persistedVersion: session.encodedVersion(),
          docTitle: getDocTitle(),
          updatedAt: Date.now(),
        };
      }
      await saveSessionRecord(record);
    } catch {
      /* storage denied/full — persistence degrades, the session still works */
    }
  };

  const write = (): Promise<void> => {
    tail = tail.then(writeInner);
    return tail;
  };

  const timer = setInterval(() => void write(), PERSIST_MS);
  const onPageHide = (): void => void write();
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onPageHide);
  void write();

  const stop = (): void => {
    disposed = true;
    clearInterval(timer);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onPageHide);
  };

  return {
    flush: () => write(),
    clear: async () => {
      stop();
      await deleteSessionRecord(session.roomId);
    },
    dispose: stop,
  };
}
