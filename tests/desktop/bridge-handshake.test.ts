// @vitest-environment node
// The `electron` import inside bridge-handshake.ts resolves to
// tests/desktop/_electron-stub.ts via the vitest alias in
// vitest.config.ts, same as the other desktop-module tests.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  bridgeDirPath,
  writeCardmirrorHandshake,
  deleteCardmirrorHandshake,
  scanFlowApps,
  flowPost,
  BRIDGE_TOKEN_HEADER,
} from '../../apps/desktop/src/bridge-handshake.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-bridge-'));
  process.env['CARDMIRROR_BRIDGE_DIR'] = dir;
});
afterEach(async () => {
  delete process.env['CARDMIRROR_BRIDGE_DIR'];
  await fs.rm(dir, { recursive: true, force: true });
});

function listen(handler: http.RequestListener): Promise<{ port: number; close: () => void }> {
  const { promise, resolve } = Promise.withResolvers<{ port: number; close: () => void }>();
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    resolve({ port: addr.port, close: () => server.close() });
  });
  return promise;
}

async function writeFlowHandshake(id: string, port: number, token = 'tok'): Promise<void> {
  await fs.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({ schema: 1, app: id, appVersion: '1.0.0', kind: 'flow', port, token, pid: 1 }),
  );
}

describe('handshake dir', () => {
  it('honors the CARDMIRROR_BRIDGE_DIR override', () => {
    expect(bridgeDirPath()).toBe(dir);
  });
  it('writes and deletes the cardmirror mirror file', async () => {
    await writeCardmirrorHandshake(17699, 'secret');
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'cardmirror.json'), 'utf8'));
    expect(raw).toMatchObject({ app: 'cardmirror', kind: 'editor', port: 17699, token: 'secret' });
    await deleteCardmirrorHandshake();
    await expect(fs.readFile(path.join(dir, 'cardmirror.json'))).rejects.toThrow();
  });
});

describe('scanFlowApps', () => {
  it('returns live flow apps only, with the token sent on ping', async () => {
    let sawToken = '';
    const live = await listen((req, res) => {
      sawToken = String(req.headers[BRIDGE_TOKEN_HEADER.toLowerCase()] ?? '');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await writeFlowHandshake('ebb', live.port, 'tok-live');
    await writeFlowHandshake('dead', 1, 'tok-dead'); // nothing listens on port 1
    await fs.writeFile(path.join(dir, 'broken.json'), '{not json');
    await writeCardmirrorHandshake(17699, 's'); // kind editor — excluded
    const apps = await scanFlowApps();
    expect(apps.map((a) => a.id)).toEqual(['ebb']);
    expect(sawToken).toBe('tok-live');
    live.close();
  });
});

describe('flowPost', () => {
  it('POSTs with the token header and returns parsed JSON', async () => {
    let got: unknown = null;
    const live = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        got = { url: req.url, token: req.headers[BRIDGE_TOKEN_HEADER.toLowerCase()], body: JSON.parse(Buffer.concat(chunks).toString()) };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, sheet: '2AC' }));
      });
    });
    await writeFlowHandshake('ebb', live.port, 'tok');
    const res = await flowPost('ebb', '/flow/send', { mode: 'column' });
    expect(res).toEqual({ ok: true, status: 200, body: { ok: true, sheet: '2AC' } });
    expect(got).toMatchObject({ url: '/flow/send', token: 'tok', body: { mode: 'column' } });
    live.close();
  });
  it('maps a missing app and a dead app to typed errors', async () => {
    expect(await flowPost('nope', '/x', {})).toEqual({ ok: false, error: 'no-such-app' });
    await writeFlowHandshake('dead', 1);
    expect(await flowPost('dead', '/x', {})).toEqual({ ok: false, error: 'app-not-running' });
  });
  it('rejects out-of-range and non-integer ports', async () => {
    await writeFlowHandshake('badport', 0); // helper writes port 0
    await writeFlowHandshake('floatport', 1.5 as any);
    expect(await flowPost('badport', '/x', {})).toEqual({ ok: false, error: 'no-such-app' });
    expect(await flowPost('floatport', '/x', {})).toEqual({ ok: false, error: 'no-such-app' });
  });
  it('ignores oversized handshake files even when otherwise valid', async () => {
    let pinged = false;
    const live = await listen((_req, res) => {
      pinged = true;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    // Valid flow handshake, live port, but padded past the 64 KiB cap.
    await fs.writeFile(
      path.join(dir, 'big.json'),
      JSON.stringify({
        schema: 1,
        app: 'big',
        appVersion: 'x'.repeat(70 * 1024),
        kind: 'flow',
        port: live.port,
        token: 'tok',
        pid: 1,
      }),
    );
    expect((await scanFlowApps()).map((a) => a.id)).not.toContain('big');
    expect(pinged).toBe(false); // skipped before any ping
    live.close();
  });
  it('rejects uppercase app ids even with a valid handshake on disk', async () => {
    let pinged = false;
    const live = await listen((_req, res) => {
      pinged = true;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    // A complete, live handshake at Ebb.json — only the uppercase id
    // must reject it (the published contract is lowercase-only).
    await writeFlowHandshake('Ebb', live.port, 'tok');
    expect(await flowPost('Ebb', '/x', {})).toEqual({ ok: false, error: 'no-such-app' });
    expect(pinged).toBe(false);
    live.close();
  });
  it('maps a stalled body to timeout, not a hang', { timeout: 10_000 }, async () => {
    const live = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.write('{"ok":'); // headers + partial body, then stall
    });
    await writeFlowHandshake('stall', live.port);
    expect(await flowPost('stall', '/x', {})).toEqual({ ok: false, error: 'timeout' });
    live.close();
  });
});
