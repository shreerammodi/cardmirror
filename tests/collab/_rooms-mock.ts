/**
 * In-process rooms relay for collab tests: the same wire contract as
 * `relay/server.py`'s rooms endpoints, in-memory, on an ephemeral port.
 * `pause()`/`resume()` simulate the relay being unreachable (every
 * request 503s) so offline-queue behavior is testable. Prefixed `_` so
 * the vitest glob skips it.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

interface Room {
  updates: Array<{ seq: number; blob: string }>;
  snapshot: { blob: string; coversThroughSeq: number } | null;
  tombstoned: boolean;
  streams: Set<http.ServerResponse>;
}

export interface RoomsMock {
  /** Base URL including the `/relay` prefix. */
  url: string;
  token: string;
  pause(): void;
  resume(): void;
  /** Delay before the stream's hello frame (simulates handshake latency
   *  so restart-thrash bugs are reproducible). 0 disables. */
  setHelloDelay(ms: number): void;
  close(): Promise<void>;
  streamCount(roomId: string): number;
  updateCount(roomId: string): number;
  /** Total stream CONNECT attempts (incl. ones that never helloed). */
  streamAttempts(): number;
  /** Zombie-instance simulation: store + ack posts but skip stream
   *  fan-out (streams stay open with heartbeats, receiving nothing). */
  mutePush(on: boolean): void;
}

const MAX_STREAMS_PER_ROOM = 10;
const PAGE = 200;

export function startRoomsMock(): Promise<RoomsMock> {
  const token = 'mock-token';
  const rooms = new Map<string, Room>();
  let seqCounter = 0;
  let paused = false;
  let helloDelayMs = 0;
  let streamAttempts = 0;
  let pushMuted = false;

  const json = (res: http.ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const roomOr = (res: http.ServerResponse, id: string): Room | null => {
    const room = rooms.get(id);
    if (!room) {
      json(res, 404, { error: 'no such room' });
      return null;
    }
    if (room.tombstoned) {
      json(res, 410, { error: 'session ended' });
      return null;
    }
    return room;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const path = url.pathname;
    if (paused) return json(res, 503, { error: 'paused' });
    if (req.headers.authorization !== `Bearer ${token}`) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const m = /^\/relay\/rooms(?:\/([^/]+)(?:\/([a-z]+))?)?$/.exec(path);
    if (!m) return json(res, 404, { error: 'not found' });
    const [, roomId, sub] = m;

    if (req.method === 'POST' && !roomId) {
      const id = randomUUID().replace(/-/g, '');
      rooms.set(id, { updates: [], snapshot: null, tombstoned: false, streams: new Set() });
      return json(res, 201, { roomId: id });
    }
    if (!roomId) return json(res, 404, { error: 'not found' });

    if (req.method === 'DELETE' && !sub) {
      const room = rooms.get(roomId);
      if (!room) return json(res, 404, { error: 'no such room' });
      if (!room.tombstoned) {
        room.tombstoned = true;
        room.updates = [];
        room.snapshot = null;
        const frame = `data: {"t":"end"}\n\n`;
        for (const s of room.streams) {
          s.write(frame);
          s.end();
        }
        room.streams.clear();
      }
      return json(res, 204);
    }

    if (req.method === 'POST' && sub === 'updates') {
      const room = roomOr(res, roomId);
      if (!room) return;
      const raw = await readBody(req);
      if (raw.length === 0) return json(res, 400, { error: 'empty update' });
      const seq = ++seqCounter;
      const blob = raw.toString('base64');
      room.updates.push({ seq, blob });
      if (!pushMuted) {
        const frame = `data: ${JSON.stringify({ t: 'u', seq, blob })}\n\n`;
        for (const s of room.streams) s.write(frame);
      }
      return json(res, 202, { seq });
    }

    if (req.method === 'GET' && sub === 'updates') {
      const room = roomOr(res, roomId);
      if (!room) return;
      const after = parseInt(url.searchParams.get('after') ?? '0', 10);
      const out: Record<string, unknown> = {};
      let floor = after;
      if (room.snapshot && after < room.snapshot.coversThroughSeq) {
        out['snapshot'] = room.snapshot;
        floor = room.snapshot.coversThroughSeq;
      }
      const rows = room.updates.filter((u) => u.seq > floor).slice(0, PAGE);
      out['updates'] = rows;
      out['more'] = rows.length === PAGE;
      out['lastSeq'] = rows.length ? rows[rows.length - 1]!.seq : floor;
      return json(res, 200, out);
    }

    if (req.method === 'POST' && sub === 'snapshot') {
      const room = roomOr(res, roomId);
      if (!room) return;
      const body = JSON.parse((await readBody(req)).toString('utf8')) as {
        blob: string;
        coversThroughSeq: number;
      };
      if (!room.snapshot || body.coversThroughSeq > room.snapshot.coversThroughSeq) {
        room.snapshot = { blob: body.blob, coversThroughSeq: body.coversThroughSeq };
        room.updates = room.updates.filter((u) => u.seq > body.coversThroughSeq);
      }
      return json(res, 204);
    }

    if (req.method === 'POST' && sub === 'presence') {
      const raw = await readBody(req);
      const room = rooms.get(roomId);
      if (room && !room.tombstoned) {
        const frame = `data: ${JSON.stringify({ t: 'p', blob: raw.toString('base64') })}\n\n`;
        for (const s of room.streams) s.write(frame);
      }
      return json(res, 202, {});
    }

    if (req.method === 'GET' && sub === 'stream') {
      streamAttempts++;
      const room = roomOr(res, roomId);
      if (!room) return;
      if (room.streams.size >= MAX_STREAMS_PER_ROOM) {
        return json(res, 409, { error: 'room is full' });
      }
      const lastSeq = room.updates.length
        ? room.updates[room.updates.length - 1]!.seq
        : (room.snapshot?.coversThroughSeq ?? 0);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const sendHello = () => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`event: hello\ndata: {"lastSeq":${lastSeq}}\n\n`);
        room.streams.add(res);
      };
      if (helloDelayMs > 0) setTimeout(sendHello, helloDelayMs);
      else sendHello();
      req.on('close', () => room.streams.delete(res));
      return;
    }

    return json(res, 404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/relay`,
        token,
        pause: () => {
          paused = true;
        },
        resume: () => {
          paused = false;
        },
        setHelloDelay: (ms) => {
          helloDelayMs = ms;
        },
        mutePush: (on) => {
          pushMuted = on;
        },
        close: () =>
          new Promise<void>((r) => {
            for (const room of rooms.values()) for (const s of room.streams) s.destroy();
            server.close(() => r());
            server.closeAllConnections?.();
          }),
        streamCount: (id) => rooms.get(id)?.streams.size ?? 0,
        streamAttempts: () => streamAttempts,
        updateCount: (id) => rooms.get(id)?.updates.length ?? 0,
      });
    });
  });
}
