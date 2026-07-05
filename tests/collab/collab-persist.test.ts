// @vitest-environment jsdom
/**
 * M3 session persistence: the crash-resume contract. The load-bearing
 * property: a session nuked while OFFLINE resumes with its unsent
 * edits intact AND MERGEABLE — the persisted CRDT carries the peer
 * history, and the persisted sentVersion makes the first post-resume
 * flush send exactly the unsent diff.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import { attachSessionPersistence } from '../../src/editor/collab/collab-persist.js';
import {
  listSessionRecords,
  loadSessionRecord,
  deleteSessionRecord,
  savePrefetch,
  loadPrefetch,
} from '../../src/editor/collab/collab-store.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { settle, sleep, simpleDoc, docText, typeAfter, mkView } from './_loro-helpers.js';

let mock: RoomsMock;
let client: RoomsClient;

beforeAll(async () => {
  mock = await startRoomsMock();
  client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
});
afterAll(async () => {
  await mock.close();
});

describe('M3 session persistence', () => {
  it('offline edits survive a nuke: resume flushes the unsent diff to the partner', async () => {
    // Host a session and get a partner attached.
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('shared prep doc'),
      client,
      flushMs: 40,
      minBackoffMs: 30,
      maxBackoffMs: 60,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const partner = await CollabSession.join({
      ...decodeShareCode(shareCode)!,
      client,
      flushMs: 40,
      minBackoffMs: 30,
      maxBackoffMs: 60,
    });
    const partnerView = mkView(partner.plugins());
    await settle();
    partner.start();
    await sleep(300);

    // Online edit — reaches the relay.
    typeAfter(hostView, 'shared', ' ONLINE');
    await sleep(300);
    expect(docText(partnerView.state.doc)).toContain('ONLINE');

    // Relay dies; host keeps typing (unsent), then the app "nukes".
    mock.pause();
    typeAfter(hostView, 'ONLINE', ' UNSENT-EDIT');
    await sleep(200); // flush ticks run, sends fail, edits stay local
    const persistedSnapshot = host.exportSnapshot();
    const meta = host.persistMeta();
    await host.stop().catch(() => {});
    hostView.destroy();

    // The unsent edit predates the "crash": sentVersion must NOT cover it.
    // Resume from the captured state.
    const resumed = await CollabSession.resume({
      roomId: host.roomId,
      keyBytes: decodeShareCode(shareCode)!.keyBytes,
      role: 'host',
      snapshot: persistedSnapshot,
      increments: [],
      lastSeq: meta.lastSeq,
      sentVersion: meta.sentVersion,
      client,
      flushMs: 40,
      minBackoffMs: 30,
      maxBackoffMs: 60,
    });
    const resumedView = mkView(resumed.plugins());
    await settle();
    expect(docText(resumedView.state.doc)).toContain('UNSENT-EDIT'); // content survived

    mock.resume();
    resumed.start();
    await sleep(600);

    // The partner receives the edit that had never reached the relay.
    expect(docText(partnerView.state.doc)).toContain('UNSENT-EDIT');
    await resumed.stop();
    await partner.stop();
    partnerView.destroy();
    resumedView.destroy();
  }, 20_000);

  it('the persistence manager writes, compacts metadata, and clear() deletes', async () => {
    const { session, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('persist me'),
      client,
      flushMs: 40,
    });
    const view = mkView(session.plugins());
    await settle();
    session.start();

    const handle = attachSessionPersistence(session, shareCode, () => 'Persist Me Doc');
    await handle.flush();
    let record = await loadSessionRecord(session.roomId);
    expect(record).not.toBeNull();
    expect(record!.shareCode).toBe(shareCode);
    expect(record!.role).toBe('host');
    expect(record!.docTitle).toBe('Persist Me Doc');
    expect(record!.snapshot.length).toBeGreaterThan(0);

    // Edit → next write captures it as an increment (or refreshed meta).
    typeAfter(view, 'persist', ' MORE');
    await sleep(100);
    await handle.flush();
    record = await loadSessionRecord(session.roomId);
    const covered = record!.increments.length > 0 || record!.snapshot.length > 0;
    expect(covered).toBe(true);

    // Resume from what the MANAGER wrote (snapshot + increments).
    const resumed = await CollabSession.resume({
      roomId: session.roomId,
      keyBytes: decodeShareCode(shareCode)!.keyBytes,
      role: record!.role,
      snapshot: record!.snapshot,
      increments: record!.increments,
      lastSeq: record!.lastSeq,
      sentVersion: record!.sentVersion,
      client,
    });
    const resumedView = mkView(resumed.plugins());
    await settle();
    expect(docText(resumedView.state.doc)).toContain('MORE');

    await handle.clear();
    expect(await loadSessionRecord(session.roomId)).toBeNull();
    expect((await listSessionRecords()).some((r) => r.roomId === session.roomId)).toBe(false);
    await session.stop();
    await resumed.stop();
    view.destroy();
    resumedView.destroy();
  }, 20_000);

  it('a prefetched seed joins fully offline and syncs on reconnect', async () => {
    // Host seeds a room while online.
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('prefetched doc body'),
      client,
      flushMs: 40,
    });
    const decoded = decodeShareCode(shareCode)!;

    // "Invite receipt": prefetch stores the ENCRYPTED backlog.
    const page = await client.fetchUpdates(host.roomId, 0);
    const blobs: Uint8Array[] = [];
    if (page.snapshot) blobs.push(page.snapshot.blob);
    for (const u of page.updates) blobs.push(u.blob);
    await savePrefetch({ roomId: host.roomId, blobs, lastSeq: page.lastSeq, fetchedAt: Date.now() });
    expect((await loadPrefetch(host.roomId))!.blobs.length).toBeGreaterThan(0);

    // Fully offline join from the prefetch (join would fail).
    mock.pause();
    await expect(
      CollabSession.join({ ...decoded, client, minBackoffMs: 30, maxBackoffMs: 60 }),
    ).rejects.toThrow();

    const pre = (await loadPrefetch(host.roomId))!;
    const { importRoomKey, decryptBlob } = await import(
      '../../src/editor/collab/collab-crypto.js'
    );
    const key = await importRoomKey(decoded.keyBytes);
    const decrypted = await Promise.all(pre.blobs.map((b) => decryptBlob(key, b)));
    const offline = await CollabSession.resume({
      roomId: host.roomId,
      keyBytes: decoded.keyBytes,
      role: 'participant',
      snapshot: decrypted[0]!,
      increments: decrypted.slice(1),
      lastSeq: pre.lastSeq,
      client,
      flushMs: 40,
      minBackoffMs: 30,
      maxBackoffMs: 60,
    });
    const offView = mkView(offline.plugins());
    await settle();
    expect(docText(offView.state.doc)).toContain('prefetched doc body');

    // Type while offline; reconnect; the host receives it.
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    typeAfter(offView, 'prefetched', ' OFFLINE-JOIN');
    offline.start();
    await sleep(200);
    mock.resume();
    // Recovery is organic (stream backoff + send retry, initial retry
    // 1s) — poll rather than racing a fixed sleep.
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      await sleep(150);
      seen = docText(hostView.state.doc).includes('OFFLINE-JOIN');
    }
    expect(seen).toBe(true);

    await deleteSessionRecord(host.roomId);
    await offline.stop();
    await host.stop();
    offView.destroy();
    hostView.destroy();
  }, 20_000);
});
