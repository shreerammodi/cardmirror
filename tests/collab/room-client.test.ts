/**
 * Rooms transport against the in-process mock: REST round-trips,
 * snapshot-aware paging, typed errors, and the SSE stream's hello /
 * update / presence / end handling with reconnect.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RoomsClient, RoomsError, RoomStream, type RoomUpdate } from '../../src/editor/collab/room-client.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';

let mock: RoomsMock;
let client: RoomsClient;

beforeAll(async () => {
  mock = await startRoomsMock();
  client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
});
afterAll(async () => {
  await mock.close();
});

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RoomsClient', () => {
  it('creates rooms, appends updates, pages them back', async () => {
    const roomId = await client.createRoom();
    const s1 = await client.postUpdate(roomId, bytes('one'));
    const s2 = await client.postUpdate(roomId, bytes('two'));
    expect(s2).toBeGreaterThan(s1);
    const page = await client.fetchUpdates(roomId, 0);
    expect(page.updates.map((u) => text(u.blob))).toEqual(['one', 'two']);
    expect(page.lastSeq).toBe(s2);
    const tail = await client.fetchUpdates(roomId, s1);
    expect(tail.updates.map((u) => text(u.blob))).toEqual(['two']);
  });

  it('serves the snapshot to joiners and truncates the log', async () => {
    const roomId = await client.createRoom();
    const s1 = await client.postUpdate(roomId, bytes('seed'));
    await client.postUpdate(roomId, bytes('after-snap'));
    await client.postSnapshot(roomId, btoa('SNAP'), s1);
    const page = await client.fetchUpdates(roomId, 0);
    expect(text(page.snapshot!.blob)).toBe('SNAP');
    expect(page.snapshot!.coversThroughSeq).toBe(s1);
    expect(page.updates.map((u) => text(u.blob))).toEqual(['after-snap']);
  });

  it('maps 404/410 to typed errors', async () => {
    await expect(client.fetchUpdates('nope', 0)).rejects.toMatchObject({ status: 404 });
    const roomId = await client.createRoom();
    await client.deleteRoom(roomId);
    const err = await client.fetchUpdates(roomId, 0).catch((e: RoomsError) => e);
    expect(err).toBeInstanceOf(RoomsError);
    expect((err as RoomsError).status).toBe(410);
  });
});

describe('RoomStream', () => {
  it('delivers hello, live updates, presence, and end', async () => {
    const roomId = await client.createRoom();
    await client.postUpdate(roomId, bytes('pre'));
    const events: string[] = [];
    const updates: RoomUpdate[] = [];
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token,
      roomId,
      minBackoffMs: 20,
      maxBackoffMs: 50,
      callbacks: {
        onHello: (lastSeq) => events.push(`hello:${lastSeq}`),
        onUpdate: (u) => updates.push(u),
        onPresence: (b) => events.push(`presence:${text(b)}`),
        onEnded: () => events.push('ended'),
        onFull: () => events.push('full'),
      },
    });
    stream.start();
    await sleep(50);
    expect(events[0]).toMatch(/^hello:\d+$/);
    await client.postUpdate(roomId, bytes('live'));
    await client.postPresence(roomId, bytes('cursor'));
    await sleep(50);
    expect(updates.map((u) => text(u.blob))).toEqual(['live']);
    expect(events).toContain('presence:cursor');
    await client.deleteRoom(roomId);
    await sleep(50);
    expect(events).toContain('ended');
    expect(stream.running).toBe(false);
  });

  it('reconnects after a transport outage and re-hellos', async () => {
    const roomId = await client.createRoom();
    const hellos: number[] = [];
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token,
      roomId,
      minBackoffMs: 20,
      maxBackoffMs: 60,
      callbacks: {
        onHello: (n) => hellos.push(n),
        onUpdate: () => {},
        onPresence: () => {},
        onEnded: () => {},
        onFull: () => {},
      },
    });
    stream.start();
    await sleep(50);
    expect(hellos.length).toBe(1);
    mock.pause();
    stream.restart(); // drop the live socket; retries now hit 503s
    await sleep(120);
    mock.resume();
    await sleep(200);
    expect(hellos.length).toBeGreaterThanOrEqual(2);
    stream.stop();
  });

  it('nudge never aborts an in-flight handshake; restart does', async () => {
    // The send loop calls nudge() on every success — during a slow
    // handshake that must be a no-op, or steady typing aborts every
    // connection before its hello (the field-observed starvation).
    mock.setHelloDelay(150);
    try {
      const roomId = await client.createRoom();
      let hellos = 0;
      const stream = new RoomStream({
        baseUrl: () => mock.url,
        token: () => mock.token,
        roomId,
        minBackoffMs: 20,
        maxBackoffMs: 50,
        callbacks: {
          onHello: () => hellos++,
          onUpdate: () => {},
          onPresence: () => {},
          onEnded: () => {},
          onFull: () => {},
        },
      });
      const before = mock.streamAttempts();
      stream.start();
      await sleep(40); // mid-handshake (hello still 110ms away)
      stream.nudge();
      stream.nudge();
      stream.nudge();
      await sleep(200);
      expect(hellos).toBe(1);
      expect(mock.streamAttempts() - before).toBe(1); // no extra connects
      stream.restart(); // the hard variant DOES abort + reconnect
      await sleep(250);
      expect(hellos).toBe(2);
      expect(mock.streamAttempts() - before).toBe(2);
      stream.stop();
    } finally {
      mock.setHelloDelay(0);
    }
  });

  it('reports room-full as terminal', async () => {
    const roomId = await client.createRoom();
    const holders: RoomStream[] = [];
    const mkStream = (cb: { onFull?: () => void } = {}) =>
      new RoomStream({
        baseUrl: () => mock.url,
        token: () => mock.token,
        roomId,
        minBackoffMs: 20,
        maxBackoffMs: 50,
        callbacks: {
          onHello: () => {},
          onUpdate: () => {},
          onPresence: () => {},
          onEnded: () => {},
          onFull: cb.onFull ?? (() => {}),
        },
      });
    for (let i = 0; i < 10; i++) {
      const s = mkStream();
      s.start();
      holders.push(s);
    }
    await sleep(80);
    expect(mock.streamCount(roomId)).toBe(10);
    let full = false;
    const eleventh = mkStream({ onFull: () => (full = true) });
    eleventh.start();
    await sleep(60);
    expect(full).toBe(true);
    expect(eleventh.running).toBe(false);
    for (const s of holders) s.stop();
  });
});
