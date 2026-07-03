/**
 * CollabSession — one collaboration session: a LoroDoc, the encrypted
 * room transport, and the sync discipline between them.
 *
 * Data flow:
 *   outbound  editor → LoroSyncPlugin → LoroDoc → (flush timer)
 *             export update-since-lastSent → encrypt → POST /updates
 *   inbound   SSE update frame (or catch-up GET) → decrypt →
 *             importBatch → Loro events → LoroSyncPlugin → editor
 *
 * Version bookkeeping invariant: everything covered by `lastSentVersion`
 * has either been queued for send or arrived from remote. `applyRemote`
 * therefore SYNCHRONOUSLY exports any un-flushed local diff before
 * importing (export is cheap and synchronous; only the POST is async) —
 * otherwise the next flush would re-export freshly imported remote ops
 * and echo them back to the room (harmless — updates are idempotent —
 * but wasteful at travel-day scale).
 *
 * Delivery discipline (mirrors card sharing): the stream is push-first;
 * every (re)connect hello triggers a catch-up fetch from our own cursor,
 * and a low-frequency catch-up timer heals stream frames the server shed
 * under backpressure. A shed frame is at worst a temporarily missing
 * causal dependency — Loro queues ops whose deps are absent and applies
 * them when the catch-up supplies the rest.
 *
 * The seed state travels as the room's FIRST regular update (a Loro
 * snapshot blob is just importable data), so joining is uniformly
 * "fetch everything after 0". The snapshot ENDPOINT is only compaction:
 * the host periodically uploads an encrypted snapshot so the server can
 * truncate the log and joins stay fast on long sessions.
 */

import { LoroDoc } from 'loro-crdt';
import type { Node as PMNode } from 'prosemirror-model';
import type { Plugin } from 'prosemirror-state';
import { EditorState } from 'prosemirror-state';
import { LoroSyncPlugin, updateLoroToPmState } from 'loro-prosemirror';
import { schema } from '../../schema/index.js';
import {
  bytesToBase64,
  decryptBlob,
  encryptBlob,
  encodeShareCode,
  generateRoomKeyBytes,
  importRoomKey,
} from './collab-crypto.js';
import { RoomsClient, RoomsError, RoomStream, type RoomUpdate } from './room-client.js';

type SyncDoc = Parameters<typeof LoroSyncPlugin>[0]['doc'];

/** Mirrors loro-prosemirror's configLoroTextStyle: PM `inclusive` is the
 *  local statement of Peritext expand behavior; the CRDT-level config
 *  makes CONCURRENT boundary insertions honor the same intent. Must be
 *  set before any ops are created on the doc. */
function configTextStyle(doc: LoroDoc): void {
  doc.configTextStyle(
    Object.fromEntries(
      Object.entries(schema.marks).map(([name, type]) => [
        name,
        { expand: type.spec.inclusive !== false ? ('after' as const) : ('none' as const) },
      ]),
    ),
  );
}

export interface CollabSessionCallbacks {
  /** Connection or queue state changed (drives the sync-status UI). */
  onStatus?: (status: { connected: boolean; queuedUpdates: number }) => void;
  /** The session ended (host ended it, or the room was GC'd). Terminal. */
  onEnded?: () => void;
  /** The room is at participant capacity. Terminal for this attempt. */
  onFull?: () => void;
  /** Encrypted presence blob from a peer (cursor layer decodes). */
  onPresence?: (blob: Uint8Array) => void;
}

export interface CollabSessionOptions {
  client: RoomsClient;
  roomId: string;
  key: CryptoKey;
  role: 'host' | 'participant';
  callbacks?: CollabSessionCallbacks;
  /** Outbound debounce; keystrokes within a window coalesce into one
   *  wire update. */
  flushMs?: number;
  /** Belt-and-suspenders catch-up cadence while streaming (heals shed
   *  push frames). */
  catchUpMs?: number;
  /** Stream backoff bounds, injectable for tests. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Host compaction cadence: upload an encrypted snapshot every N
   *  posted updates. */
  snapshotEvery?: number;
}

export class CollabSession {
  readonly loroDoc: LoroDoc;
  readonly roomId: string;
  readonly role: 'host' | 'participant';

  private readonly client: RoomsClient;
  private readonly key: CryptoKey;
  private readonly callbacks: CollabSessionCallbacks;
  private readonly flushMs: number;
  private readonly catchUpMs: number;
  private readonly snapshotEvery: number;

  private stream: RoomStream | null = null;
  private lastSeq = 0;
  private lastSentVersion: ReturnType<LoroDoc['version']>;
  private outQueue: Uint8Array[] = [];
  private sending = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private catchUpTimer: ReturnType<typeof setInterval> | null = null;
  private sendRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private ended = false;
  private postedCount = 0;
  private catchUpRunning = false;

  private constructor(opts: CollabSessionOptions & { loroDoc: LoroDoc }) {
    this.loroDoc = opts.loroDoc;
    this.roomId = opts.roomId;
    this.role = opts.role;
    this.client = opts.client;
    this.key = opts.key;
    this.callbacks = opts.callbacks ?? {};
    this.flushMs = opts.flushMs ?? 500;
    this.catchUpMs = opts.catchUpMs ?? 300_000;
    this.snapshotEvery = opts.snapshotEvery ?? 50;
    this.lastSentVersion = this.loroDoc.version();
    this.streamOpts = {
      minBackoffMs: opts.minBackoffMs,
      maxBackoffMs: opts.maxBackoffMs,
    };
  }

  private streamOpts: { minBackoffMs?: number; maxBackoffMs?: number };

  /** Start a session on the current document. Uploads the seed state as
   *  update #1 and returns the share code alongside the session. */
  static async host(opts: {
    pmDoc: PMNode;
    client: RoomsClient;
    callbacks?: CollabSessionCallbacks;
    flushMs?: number;
    catchUpMs?: number;
    minBackoffMs?: number;
    maxBackoffMs?: number;
    snapshotEvery?: number;
  }): Promise<{ session: CollabSession; shareCode: string }> {
    const keyBytes = generateRoomKeyBytes();
    const key = await importRoomKey(keyBytes);
    const roomId = await opts.client.createRoom();

    const loroDoc = new LoroDoc();
    configTextStyle(loroDoc);
    updateLoroToPmState(loroDoc as SyncDoc, new Map(), EditorState.create({ doc: opts.pmDoc }));
    loroDoc.commit();

    const session = new CollabSession({ ...opts, roomId, key, role: 'host', loroDoc });
    const seed = loroDoc.export({ mode: 'snapshot' });
    const seq = await opts.client.postUpdate(roomId, await encryptBlob(key, seed));
    session.lastSeq = seq;
    session.lastSentVersion = loroDoc.version();
    return { session, shareCode: encodeShareCode(roomId, keyBytes) };
  }

  /** Join an existing session; resolves once the backlog (seed + tail)
   *  is imported, so the caller mounts views against a populated doc. */
  static async join(opts: {
    roomId: string;
    keyBytes: Uint8Array;
    client: RoomsClient;
    callbacks?: CollabSessionCallbacks;
    flushMs?: number;
    catchUpMs?: number;
    minBackoffMs?: number;
    maxBackoffMs?: number;
  }): Promise<CollabSession> {
    const key = await importRoomKey(opts.keyBytes);
    const loroDoc = new LoroDoc();
    configTextStyle(loroDoc);
    const session = new CollabSession({
      ...opts,
      key,
      role: 'participant',
      loroDoc,
    });
    await session.catchUp();
    return session;
  }

  /** The ProseMirror plugins that bind an EditorView to this session.
   *  Fresh instances per view; the LoroDoc is the shared state. */
  plugins(): Plugin[] {
    return [LoroSyncPlugin({ doc: this.loroDoc as SyncDoc })];
  }

  start(): void {
    if (this.ended || this.stream) return;
    this.stream = new RoomStream({
      baseUrl: this.client.opts.baseUrl,
      token: this.client.opts.token,
      fetchImpl: this.client.opts.fetchImpl,
      roomId: this.roomId,
      minBackoffMs: this.streamOpts.minBackoffMs,
      maxBackoffMs: this.streamOpts.maxBackoffMs,
      callbacks: {
        onHello: () => {
          this.connected = true;
          this.emitStatus();
          void this.catchUp();
          void this.drainQueue();
        },
        onUpdate: (u) => void this.applyRemote(u),
        onPresence: (blob) => {
          void (async () => {
            try {
              this.callbacks.onPresence?.(await decryptBlob(this.key, blob));
            } catch {
              /* wrong-key or corrupt presence frame — drop */
            }
          })();
        },
        onEnded: () => this.handleEnded(),
        onFull: () => {
          this.callbacks.onFull?.();
        },
      },
    });
    this.stream.start();
    this.flushTimer = setInterval(() => this.flush(), this.flushMs);
    this.catchUpTimer = setInterval(() => void this.catchUp(), this.catchUpMs);
  }

  /** Leave the session (participant) or just stop syncing: final flush
   *  attempt, then tear down timers and the stream. */
  async stop(): Promise<void> {
    this.flush();
    await this.drainQueue().catch(() => {});
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.catchUpTimer) clearInterval(this.catchUpTimer);
    if (this.sendRetryTimer) clearTimeout(this.sendRetryTimer);
    this.flushTimer = this.catchUpTimer = null;
    this.sendRetryTimer = null;
    this.stream?.stop();
    this.stream = null;
    this.connected = false;
  }

  /** End the session for everyone (host action): tombstones the room. */
  async end(): Promise<void> {
    await this.stop();
    try {
      await this.client.deleteRoom(this.roomId);
    } catch {
      /* already gone */
    }
    this.handleEnded();
  }

  /** Wake-from-sleep hook. */
  restart(): void {
    this.stream?.restart();
  }

  get queuedUpdates(): number {
    return this.outQueue.length;
  }

  // --- outbound ---

  /** Export any local ops since the last flush into the send queue.
   *  Synchronous by design so `applyRemote` can call it pre-import. */
  flush(): void {
    if (this.ended) return;
    this.loroDoc.commit();
    const version = this.loroDoc.version();
    // An empty diff still exports a ~22-byte header blob, so gate on the
    // version vector actually advancing (compare() === 0 means equal).
    if (version.compare(this.lastSentVersion) === 0) return;
    const diff = this.loroDoc.export({ mode: 'update', from: this.lastSentVersion });
    this.lastSentVersion = version;
    this.outQueue.push(diff);
    this.emitStatus();
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.sending || this.ended) return;
    this.sending = true;
    try {
      while (this.outQueue.length > 0) {
        const blob = this.outQueue[0]!;
        try {
          const seq = await this.client.postUpdate(this.roomId, await encryptBlob(this.key, blob));
          this.outQueue.shift();
          this.postedCount++;
          this.sendRetryMs = 1000;
          this.connected = true;
          if (seq > this.lastSeq) this.lastSeq = seq;
          this.emitStatus();
          if (this.role === 'host' && this.postedCount % this.snapshotEvery === 0) {
            void this.uploadSnapshot();
          }
        } catch (err) {
          if (err instanceof RoomsError && err.status === 410) {
            this.handleEnded();
            return;
          }
          if (err instanceof RoomsError && err.status >= 400 && err.status < 500 && err.status !== 409) {
            // Unpostable (413 etc.) — dropping would lose data; keep it
            // queued and let the retry surface the stall in the status.
          }
          this.connected = false;
          this.emitStatus();
          this.scheduleSendRetry();
          return;
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private sendRetryMs = 1000;

  private scheduleSendRetry(): void {
    if (this.sendRetryTimer || this.ended) return;
    const jitter = 0.7 + Math.random() * 0.6;
    const delay = this.sendRetryMs * jitter;
    this.sendRetryMs = Math.min(this.sendRetryMs * 2, 30_000);
    this.sendRetryTimer = setTimeout(() => {
      this.sendRetryTimer = null;
      void this.drainQueue();
    }, delay);
  }

  // --- inbound ---

  private async applyRemote(u: RoomUpdate): Promise<void> {
    if (this.ended || u.seq <= this.lastSeq) return;
    let plain: Uint8Array;
    try {
      plain = await decryptBlob(this.key, u.blob);
    } catch {
      // Wrong key or corrupt ciphertext: skip the frame but do NOT
      // advance the cursor past it silently — mark it consumed so one
      // bad frame can't wedge the stream, and rely on the doc's causal
      // dependency queue to surface real gaps.
      this.lastSeq = u.seq;
      return;
    }
    this.flush(); // capture local diff before import (see module doc)
    this.loroDoc.importBatch([plain]);
    this.lastSentVersion = this.loroDoc.version();
    this.lastSeq = u.seq;
    this.sendRetryMs = 1000;
  }

  /** Fetch and import everything after our cursor (join, reconnect,
   *  and the periodic shed-frame healer). */
  async catchUp(): Promise<void> {
    if (this.ended || this.catchUpRunning) return;
    this.catchUpRunning = true;
    try {
      for (;;) {
        const page = await this.client.fetchUpdates(this.roomId, this.lastSeq);
        const blobs: Uint8Array[] = [];
        if (page.snapshot && page.snapshot.coversThroughSeq > this.lastSeq) {
          blobs.push(await decryptBlob(this.key, page.snapshot.blob));
        }
        for (const u of page.updates) {
          if (u.seq <= this.lastSeq) continue;
          try {
            blobs.push(await decryptBlob(this.key, u.blob));
          } catch {
            /* skip undecryptable frame (see applyRemote) */
          }
        }
        if (blobs.length > 0) {
          this.flush();
          this.loroDoc.importBatch(blobs);
          this.lastSentVersion = this.loroDoc.version();
        }
        if (page.lastSeq > this.lastSeq) this.lastSeq = page.lastSeq;
        if (!page.more) break;
      }
      this.connected = true;
      this.emitStatus();
    } catch (err) {
      if (err instanceof RoomsError && err.status === 410) {
        this.handleEnded();
        return;
      }
      this.connected = false;
      this.emitStatus();
    } finally {
      this.catchUpRunning = false;
    }
  }

  // --- presence ---

  async sendPresence(blob: Uint8Array): Promise<void> {
    if (this.ended) return;
    try {
      await this.client.postPresence(this.roomId, await encryptBlob(this.key, blob));
    } catch {
      /* presence is fire-and-forget */
    }
  }

  // --- compaction ---

  private async uploadSnapshot(): Promise<void> {
    try {
      this.loroDoc.commit();
      const covers = this.lastSeq;
      const snapshot = this.loroDoc.export({ mode: 'snapshot' });
      const sealed = await encryptBlob(this.key, snapshot);
      await this.client.postSnapshot(this.roomId, bytesToBase64(sealed), covers);
    } catch {
      /* compaction is best-effort; the log just stays longer */
    }
  }

  private emitStatus(): void {
    this.callbacks.onStatus?.({ connected: this.connected, queuedUpdates: this.outQueue.length });
  }

  private handleEnded(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.catchUpTimer) clearInterval(this.catchUpTimer);
    if (this.sendRetryTimer) clearTimeout(this.sendRetryTimer);
    this.flushTimer = this.catchUpTimer = null;
    this.sendRetryTimer = null;
    this.stream?.stop();
    this.stream = null;
    this.connected = false;
    this.callbacks.onEnded?.();
  }
}
