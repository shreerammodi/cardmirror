// @vitest-environment jsdom
/**
 * Regression: outage recovery when the OUTBOUND retry succeeds before
 * the SSE stream reconnects (send retry caps at 30s, stream backoff at
 * 60s — after a minutes-long outage the inversion is the common case).
 * The original defect advanced each session's catch-up cursor to its
 * OWN posted seq, silently skipping the partner's concurrent outage
 * updates forever; new edits then parked in Loro's causal-dependency
 * queue and nothing visibly synced despite both chips claiming synced.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { mkView, settle, sleep, simpleDoc, docText, typeAfter } from './_loro-helpers.js';

let mock: RoomsMock;
let client: RoomsClient;

beforeAll(async () => {
  mock = await startRoomsMock();
  client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
});
afterAll(async () => {
  await mock.close();
});

describe('reconnect ordering', () => {
  it('converges when sends drain before streams reconnect', async () => {
    // Streams reconnect SLOWLY (≥2.5s) while the send retry (1s) wins
    // the race — the production inversion, compressed.
    const SLOW_STREAM = { flushMs: 25, minBackoffMs: 2500, maxBackoffMs: 3000, catchUpMs: 60_000 };
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('travel day prep document'),
      client,
      ...SLOW_STREAM,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const joiner = await CollabSession.join({
      ...decodeShareCode(shareCode)!,
      client,
      ...SLOW_STREAM,
    });
    const joinView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(80);
    expect(docText(joinView.state.doc)).toContain('travel day prep document');

    // Total outage; both sides edit while dark.
    mock.pause();
    host.restart();
    joiner.restart();
    await sleep(60);
    typeAfter(hostView, 'travel day', ' HOSTEDIT');
    typeAfter(joinView, 'prep document', ' JOINEREDIT');
    await sleep(100); // flush timers queue the edits; posts fail
    expect(host.queuedUpdates + joiner.queuedUpdates).toBeGreaterThan(0);

    // Relay returns. Send retries (~1s) fire while streams are still in
    // their ≥2.5s backoff — both sides post their queued updates FIRST.
    mock.resume();
    await sleep(5500); // sends drain (~1s), streams reconnect (~2.5-3s), catch-up heals

    expect(joinView.state.doc.eq(hostView.state.doc)).toBe(true);
    const t = docText(hostView.state.doc);
    expect(t).toContain('HOSTEDIT');
    expect(t).toContain('JOINEREDIT');

    // And LIVE edits flow again after recovery.
    typeAfter(hostView, 'HOSTEDIT', ' postrecovery');
    await sleep(300);
    expect(docText(joinView.state.doc)).toContain('postrecovery');

    await joiner.stop();
    await host.stop();
    hostView.destroy();
    joinView.destroy();
  }, 20_000);

  it('reconnects while the user types continuously (nudge must not abort handshakes)', async () => {
    // The original heuristic restarted the stream on every send success
    // while it wasn't connected — with a non-instant hello, steady
    // typing aborted every handshake before its hello and push delivery
    // never resumed. flushMs(40) < helloDelay(150) reproduces that.
    mock.setHelloDelay(150);
    try {
      const FAST = { flushMs: 40, minBackoffMs: 30, maxBackoffMs: 80, catchUpMs: 60_000 };
      const { session: host, shareCode } = await CollabSession.host({
        pmDoc: simpleDoc('steady typing document'),
        client,
        ...FAST,
      });
      const hostView = mkView(host.plugins());
      await settle();
      host.start();
      const joiner = await CollabSession.join({ ...decodeShareCode(shareCode)!, client, ...FAST });
      const joinView = mkView(joiner.plugins());
      await settle();
      joiner.start();
      await sleep(400); // initial hellos (150ms delay) land

      // Outage, then revival with the host typing NON-STOP through the
      // entire recovery window.
      mock.pause();
      host.restart();
      joiner.restart();
      await sleep(60);
      mock.resume();
      for (let i = 0; i < 30; i++) {
        typeAfter(hostView, 'steady', ` w${i}`);
        await sleep(60);
        if (i === 20) {
          // The defining assertion: push delivery must be flowing WHILE
          // the host is still typing. The thrash bug only recovered
          // after typing stopped, so early words never arrive mid-burst.
          expect(docText(joinView.state.doc)).toContain('w5');
        }
      }
      await sleep(600); // let the last flush + push land

      expect(docText(joinView.state.doc)).toContain('w29');
      expect(joinView.state.doc.eq(hostView.state.doc)).toBe(true);
      await joiner.stop();
      await host.stop();
      hostView.destroy();
      joinView.destroy();
    } finally {
      mock.setHelloDelay(0);
    }
  }, 20_000);
});

describe('stale-instance watchdog', () => {
  it('reconnects when own posts stop echoing on the stream', async () => {
    // Zombie-deploy simulation: the stream stays open (heartbeats fine)
    // but receives no pushes — posts are acked by "another instance".
    // The self-echo watchdog must notice and hard-restart the stream.
    const FAST = { flushMs: 30, minBackoffMs: 20, maxBackoffMs: 60, catchUpMs: 60_000, echoTimeoutMs: 250 };
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('watchdog doc'),
      client,
      ...FAST,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const joiner = await CollabSession.join({ ...decodeShareCode(shareCode)!, client, ...FAST });
    const joinView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(100);

    const attemptsBefore = mock.streamAttempts();
    mock.mutePush(true); // zombie mode: acks, no fan-out
    typeAfter(hostView, 'watchdog', ' STALE');
    await sleep(700); // echo deadline (250ms) passes -> watchdog restarts
    expect(mock.streamAttempts()).toBeGreaterThan(attemptsBefore);
    mock.mutePush(false);
    typeAfter(hostView, 'watchdog', ' LIVE');
    await sleep(400);
    expect(docText(joinView.state.doc)).toContain('LIVE');
    // The muted-window edit arrives too (catch-up on the reconnect hello).
    expect(docText(joinView.state.doc)).toContain('STALE');
    expect(joinView.state.doc.eq(hostView.state.doc)).toBe(true);
    await joiner.stop();
    await host.stop();
    hostView.destroy();
    joinView.destroy();
  }, 20_000);
});
