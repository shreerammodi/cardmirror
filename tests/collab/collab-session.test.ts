// @vitest-environment jsdom
/**
 * End-to-end session test: two full editor peers (real schema, real
 * LoroSyncPlugin, real encrypted transport) syncing through the
 * in-process rooms relay — seed propagation, live convergence, the
 * offline→reconnect travel-day cycle, the P1 highlight-union regression
 * through the whole stack, and session end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import {
  mkView,
  settle,
  sleep,
  simpleDoc,
  mixedDoc,
  docText,
  findText,
  rangeFullyMarked,
  addMarkOn,
  typeAfter,
} from './_loro-helpers.js';

let mock: RoomsMock;
let client: RoomsClient;

beforeAll(async () => {
  mock = await startRoomsMock();
  client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
});
afterAll(async () => {
  await mock.close();
});

const FAST = { flushMs: 25, minBackoffMs: 20, maxBackoffMs: 60, catchUpMs: 60_000 };

async function hostAndJoin(seedDoc = mixedDoc()) {
  const { session: host, shareCode } = await CollabSession.host({
    pmDoc: seedDoc,
    client,
    ...FAST,
  });
  const hostView = mkView(host.plugins());
  await settle();
  host.start();

  const decoded = decodeShareCode(shareCode)!;
  const joiner = await CollabSession.join({ ...decoded, client, ...FAST });
  const joinView = mkView(joiner.plugins());
  await settle();
  joiner.start();
  await sleep(80);
  return { host, hostView, joiner, joinView };
}

describe('collab session end-to-end', () => {
  it('propagates the seed to a joiner', async () => {
    const seed = mixedDoc();
    const { host, hostView, joiner, joinView } = await hostAndJoin(seed);
    expect(joinView.state.doc.eq(seed)).toBe(true);
    expect(hostView.state.doc.eq(seed)).toBe(true);
    await joiner.stop();
    await host.stop();
  });

  it('converges live concurrent edits in both directions', async () => {
    const { host, hostView, joiner, joinView } = await hostAndJoin();
    typeAfter(hostView, 'quick fox', ' swiftly');
    typeAfter(joinView, 'lazy dog', ' sleeping');
    await sleep(250);
    expect(joinView.state.doc.eq(hostView.state.doc)).toBe(true);
    const t = docText(hostView.state.doc);
    expect(t).toContain('quick fox swiftly');
    expect(t).toContain('lazy dog sleeping');
    await joiner.stop();
    await host.stop();
  });

  it('survives the travel-day cycle: offline queue, edits both sides, reconnect merge', async () => {
    const { host, hostView, joiner, joinView } = await hostAndJoin();

    mock.pause();
    host.restart(); // sever live sockets so the outage is total
    joiner.restart();
    await sleep(60);

    typeAfter(hostView, 'riverbank', ' upstream');
    typeAfter(joinView, 'evidence text', ' and warrants');
    await sleep(120); // flush timers run; posts fail; queues hold
    expect(host.queuedUpdates + joiner.queuedUpdates).toBeGreaterThan(0);
    expect(docText(hostView.state.doc)).not.toBe(docText(joinView.state.doc));

    mock.resume();
    await sleep(500); // reconnect (backoff ≤60ms) + hello catch-up + drain
    expect(joinView.state.doc.eq(hostView.state.doc)).toBe(true);
    const t = docText(hostView.state.doc);
    expect(t).toContain('riverbank upstream');
    expect(t).toContain('evidence text and warrants');
    await joiner.stop();
    await host.stop();
  });

  it('preserves the highlight union through the full stack (P1 regression)', async () => {
    const { host, hostView, joiner, joinView } = await hostAndJoin(
      simpleDoc('The quick fox jumped over the lazy dog tonight.'),
    );
    mock.pause();
    host.restart();
    joiner.restart();
    await sleep(60);
    const green = schema.marks['highlight']!.create({ color: 'green' });
    addMarkOn(hostView, 'The quick fox', green);
    addMarkOn(joinView, 'fox jumped over', green);
    await sleep(120);
    mock.resume();
    await sleep(500);
    expect(joinView.state.doc.eq(hostView.state.doc)).toBe(true);
    const union = findText(hostView.state.doc, 'The quick fox jumped over');
    expect(
      rangeFullyMarked(hostView.state.doc, union.from, union.to, schema.marks['highlight']!, {
        color: 'green',
      }),
    ).toBe(true);
    await joiner.stop();
    await host.stop();
  });

  it('ends the session for everyone (host end → participant onEnded)', async () => {
    let joinerEnded = false;
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('to end'),
      client,
      ...FAST,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const joiner = await CollabSession.join({
      ...decodeShareCode(shareCode)!,
      client,
      ...FAST,
      callbacks: { onEnded: () => (joinerEnded = true) },
    });
    const jView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(80);
    await host.end();
    await sleep(100);
    expect(joinerEnded).toBe(true);
    hostView.destroy();
    jView.destroy();
  });
});

describe('room-history integrity (compaction-loss self-heal)', () => {
  it('P14: a compaction that destroyed a peer\'s ops is detected and repaired by the audit', async () => {
    const mock = await startRoomsMock();
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    try {
      // Host + joiner, both online; joiner contributes edits.
      const { session: host, shareCode } = await CollabSession.host({
        pmDoc: simpleDoc('the shared travel-day doc'),
        client,
        flushMs: 40,
        minBackoffMs: 30,
        maxBackoffMs: 60,
      });
      const hostView = mkView(host.plugins());
      await settle();
      host.start();
      const decoded = decodeShareCode(shareCode)!;
      const joiner = await CollabSession.join({
        ...decoded,
        client,
        flushMs: 40,
        minBackoffMs: 30,
        maxBackoffMs: 60,
      });
      const joinerView = mkView(joiner.plugins());
      await settle();
      joiner.start();
      await sleep(300);
      typeAfter(joinerView, 'shared', ' JOINER-EDIT');
      await sleep(300);
      expect(docText(hostView.state.doc)).toContain('JOINER-EDIT');

      // SIMULATED FIELD CORRUPTION: a compaction snapshot exported from
      // a doc that LACKS the joiner's ops, covering their stored seqs —
      // the relay truncates the log and the joiner's history is gone
      // from the room (pre-guard hosts could do this while imports were
      // pending). The bogus snapshot comes from a doc holding ONLY the
      // room's first blob (the host-only seed).
      const { importRoomKey, encryptBlob: seal, bytesToBase64: b64 } = await import(
        '../../src/editor/collab/collab-crypto.js'
      );
      const key = await importRoomKey(decoded.keyBytes);
      const hostOnly = new (await import('loro-crdt')).LoroDoc();
      // First room update = the seed snapshot (host-only history).
      const firstPage = await client.fetchUpdates(host.roomId, 0);
      // find the earliest blob (the seed) and import just that
      const { decryptBlob: open_ } = await import('../../src/editor/collab/collab-crypto.js');
      const earliest = firstPage.snapshot
        ? firstPage.snapshot.blob
        : firstPage.updates[0]!.blob;
      hostOnly.import(await open_(key, earliest));
      const lastSeq = (await client.fetchUpdates(host.roomId, 0)).lastSeq;
      const bogus = hostOnly.export({ mode: 'snapshot' });
      await client.postSnapshot(host.roomId, b64(await seal(key, bogus)), lastSeq);

      // The room's stored history now lacks the joiner's ops. A FRESH
      // participant (like a resumed host after cache loss) can't see them:
      const fresh = await CollabSession.join({ ...decoded, client, flushMs: 40 });
      const freshView = mkView(fresh.plugins());
      await settle();
      expect(docText(freshView.state.doc)).not.toContain('JOINER-EDIT');

      // THE HEAL: the joiner's audit sees the room missing its acked ops
      // and reposts full history.
      await joiner.auditRoomHistory();
      await fresh.catchUp();
      await settle();
      expect(docText(freshView.state.doc)).toContain('JOINER-EDIT');

      await fresh.stop();
      await joiner.stop();
      await host.stop();
      hostView.destroy();
      joinerView.destroy();
      freshView.destroy();
    } finally {
      await mock.close();
    }
  }, 25_000);
});

describe('large documents (413 avoidance via chunked updates)', () => {
  it('P15: oversized seeds and updates ship as cap-sized chunks and still converge', async () => {
    const mock = await startRoomsMock();
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    try {
      // A tiny per-update limit forces BOTH paths: the seed exceeds it
      // (chunk-seeded room) and so does a big paste later.
      const { session: host, shareCode } = await CollabSession.host({
        pmDoc: simpleDoc('the enormous master file body that will not fit in one update'),
        client,
        flushMs: 40,
        minBackoffMs: 30,
        maxBackoffMs: 60,
        updateByteLimit: 400,
      });
      const hostView = mkView(host.plugins());
      await settle();
      host.start();

      // Joiner consumes the snapshot-fast-path seed.
      const joiner = await CollabSession.join({
        ...decodeShareCode(shareCode)!,
        client,
        flushMs: 40,
        minBackoffMs: 30,
        maxBackoffMs: 60,
        updateByteLimit: 400,
      });
      const joinerView = mkView(joiner.plugins());
      await settle();
      joiner.start();
      await sleep(300);
      expect(docText(joinerView.state.doc)).toContain('master file body');

      // Oversized edit (a paste bigger than the update cap) drains via
      // the snapshot fallback and reaches the partner.
      typeAfter(hostView, 'enormous', ' ' + 'BIGPASTE'.repeat(120));
      await sleep(600);
      expect(docText(joinerView.state.doc)).toContain('BIGPASTE'.repeat(3));

      // The room's stored state stays coherent for a fresh join.
      const fresh = await CollabSession.join({ ...decodeShareCode(shareCode)!, client, flushMs: 40 });
      const freshView = mkView(fresh.plugins());
      await settle();
      expect(docText(freshView.state.doc)).toContain('BIGPASTE');
      expect(docText(freshView.state.doc)).toContain('master file body'); // seed content intact

      await fresh.stop();
      await joiner.stop();
      await host.stop();
      hostView.destroy();
      joinerView.destroy();
      freshView.destroy();
    } finally {
      await mock.close();
    }
  }, 25_000);
});

describe('delivery-cursor discipline (shed frames must not create gaps)', () => {
  it('P16: a shed push is recovered by catch-up even when later frames arrive', async () => {
    const mock = await startRoomsMock();
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    try {
      const { session: a, shareCode } = await CollabSession.host({
        pmDoc: simpleDoc('three peer shed test'),
        client,
        flushMs: 40,
        minBackoffMs: 30,
        maxBackoffMs: 60,
      });
      const aView = mkView(a.plugins());
      await settle();
      a.start();
      const decoded = decodeShareCode(shareCode)!;
      const mkPeer = async () => {
        const s = await CollabSession.join({
          ...decoded,
          client,
          flushMs: 40,
          minBackoffMs: 30,
          maxBackoffMs: 60,
          catchUpMs: 600_000, // no periodic catch-up — the test drives it
        });
        const v = mkView(s.plugins());
        await settle();
        s.start();
        return { s, v };
      };
      const b = await mkPeer();
      const c = await mkPeer();
      await sleep(300);

      // A's edit posts while pushes are muted: stored in the room,
      // delivered to NOBODY's stream.
      mock.mutePush(true);
      typeAfter(aView, 'three', ' LOST-EDIT');
      await sleep(250);
      mock.mutePush(false);

      // B's edit (causally independent of A's) pushes normally — C's
      // stream sees a frame ABOVE the shed one. The old cursor logic
      // jumped past the shed row here, making it unfetchable forever.
      typeAfter(b.v, 'peer', ' AFTER');
      await sleep(300);
      expect(docText(c.v.state.doc)).toContain('AFTER');

      // Catch-up must still find the shed row (cursor never jumped it).
      await c.s.catchUp();
      await settle();
      expect(docText(c.v.state.doc)).toContain('LOST-EDIT');
      await b.s.catchUp();
      await settle();
      expect(docText(b.v.state.doc)).toContain('LOST-EDIT');

      await c.s.stop();
      await b.s.stop();
      await a.stop();
      aView.destroy();
      b.v.destroy();
      c.v.destroy();
    } finally {
      await mock.close();
    }
  }, 25_000);
});

describe('send-completeness (the field one-way desync)', () => {
  it('P17: plugin-generated repair/heal ops always reach the relay (no silent send-drop)', async () => {
    const { LoroDoc } = await import('loro-crdt');
    const { LoroUndoPlugin } = await import('loro-prosemirror');
    const { collabInvariantHealPlugin } = await import(
      '../../src/editor/collab/collab-invariants.js'
    );
    const { collabRepairPlugin } = await import('../../src/editor/collab/collab-repair.js');
    const { importRoomKey, decryptBlob } = await import(
      '../../src/editor/collab/collab-crypto.js'
    );
    const { schema } = await import('../../src/schema/index.js');
    const { TextSelection } = await import('prosemirror-state');
    const { EditorState } = await import('prosemirror-state');
    const { EditorView } = await import('prosemirror-view');

    const mock = await startRoomsMock();
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    try {
      // Seed a card whose body text peers will concurrently underline /
      // emphasize — overlapping exclusive marks trigger the repair sweep,
      // whose appendTransaction-generated ops were the ones that leaked.
      const seed = schema.node('doc', null, [
        schema.node('card', null, [
          schema.node('tag', { id: 'h1' }, [schema.text('the tag line for this card')]),
          schema.node('card_body', null, [
            schema.text('a fairly long body sentence that both debaters will mark up concurrently now'),
          ]),
        ]),
      ]);
      const { session: host, shareCode } = await CollabSession.host({
        pmDoc: seed,
        client,
        flushMs: 40,
        catchUpMs: 100000,
        minBackoffMs: 30,
        maxBackoffMs: 60,
        snapshotEvery: 100000,
      });
      const decoded = decodeShareCode(shareCode)!;
      const sessions = [host];
      for (let i = 1; i < 3; i++) {
        sessions.push(
          await CollabSession.join({
            ...decoded,
            client,
            flushMs: 40,
            catchUpMs: 100000,
            minBackoffMs: 30,
            maxBackoffMs: 60,
          }),
        );
      }
      // FULL production plugin stack (heal + every-peer repair) — the
      // stack that surfaced the leak; bare LoroSyncPlugin does not.
      const views = sessions.map((s) => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        return new EditorView(el, {
          state: EditorState.create({
            schema,
            plugins: [
              ...s.plugins(),
              LoroUndoPlugin({ doc: s.loroDoc }),
              collabInvariantHealPlugin(),
              collabRepairPlugin(() => true),
            ],
          }),
        });
      });
      await settle();
      for (const s of sessions) s.start();
      await sleep(200);

      // Concurrent overlapping marks, faster than the flush window.
      const marks = [schema.marks['underline_mark']!, schema.marks['emphasis_mark']!];
      for (let round = 0; round < 20; round++) {
        for (let i = 0; i < views.length; i++) {
          const v = views[i]!;
          const r = findText(v.state.doc, 'body sentence');
          const from = r.from + (round % 5);
          v.dispatch(v.state.tr.addMark(from, from + 6, marks[i % 2]!.create()));
        }
        await sleep(12);
      }
      // Drain.
      for (let i = 0; i < 60; i++) {
        for (const s of sessions) s.flush();
        await sleep(100);
        if (sessions.every((s) => s.debugState().queued === 0 && !s.debugState().pendingImports)) break;
      }
      for (const s of sessions) await s.catchUp().catch(() => {});
      await sleep(300);

      // Reconstruct the relay's full doc from seq 0.
      const key = await importRoomKey(decoded.keyBytes);
      const relayDoc = new LoroDoc();
      let after = 0;
      for (;;) {
        const page = await client.fetchUpdates(host.roomId, after);
        const blobs: Uint8Array[] = [];
        if (page.snapshot && after < page.snapshot.coversThroughSeq) {
          blobs.push(await decryptBlob(key, page.snapshot.blob));
        }
        for (const u of page.updates) blobs.push(await decryptBlob(key, u.blob));
        if (blobs.length) relayDoc.importBatch(blobs);
        after = page.lastSeq;
        if (!page.more) break;
      }
      const relayVer = relayDoc.version().toJSON() as Map<string, number>;

      // THE INVARIANT: the relay holds every op each peer authored. A
      // leak shows as relayVer[peer] < the peer's own counter.
      for (const s of sessions) {
        const peer = s.loroDoc.peerIdStr;
        const own = (s.loroDoc.version().toJSON() as Map<string, number>).get(peer as never) ?? 0;
        const atRelay = relayVer.get(peer as never) ?? 0;
        expect(atRelay, `relay missing ${own - atRelay} of peer ${peer.slice(0, 5)}'s ops`).toBe(own);
      }
      // And with the relay complete, the peers converge and stay valid.
      expect(views[1]!.state.doc.eq(views[0]!.state.doc)).toBe(true);
      expect(views[2]!.state.doc.eq(views[0]!.state.doc)).toBe(true);
      for (const v of views) expect(() => v.state.doc.check()).not.toThrow();

      for (const s of sessions) await s.stop();
      for (const v of views) v.destroy();
    } finally {
      await mock.close();
    }
  }, 25_000);
});
