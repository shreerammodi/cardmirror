// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  sentToRenderer,
  ipcListeners,
  resetElectronStub,
  setMockFocusedWindow,
  setMockAllWindows,
  makeMockWindow,
} from './_electron-stub.js';
import * as bridge from '../../apps/desktop/src/fast-paste-bridge.js';

const tmpRoot = path.join(os.tmpdir(), `cardmirror-bridge-test-${process.pid}`);

async function fetchJson(opts: {
  method: 'GET' | 'POST';
  path: string;
  port: number;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  // No keep-alive: undici's global pool can hand a later test a socket
  // the previous test's server.close() already destroyed (Node ≥19
  // closes idle connections), which surfaces as a load-sensitive
  // "TypeError: fetch failed". Each request gets a fresh socket; this
  // also lets afterEach's close() resolve without idle-socket waits.
  headers['connection'] ??= 'close';
  if (opts.token) headers['x-fdp-token'] = opts.token;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const doFetch = async (): Promise<{ status: number; json: any }> => {
    const res = await fetch(`http://127.0.0.1:${opts.port}${opts.path}`, {
      method: opts.method,
      headers,
      body,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* tolerate */ }
    return { status: res.status, json };
  };
  try {
    return await doFetch();
  } catch {
    // One retry on connect-level failure only (HTTP error statuses
    // return normally above and still hit the assertions). A loopback
    // server this test just started gets one second chance under
    // parallel-suite load; a real bridge bug fails the retry too.
    await new Promise((r) => setTimeout(r, 50));
    return doFetch();
  }
}

function fireRendererAck(ack: any): void {
  const listeners = ipcListeners.get('external:insert-result') ?? [];
  for (const l of listeners) l(null, ack);
}

describe('fast-paste-bridge', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = path.join(tmpRoot, `t-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(userDataDir, { recursive: true });
    resetElectronStub(userDataDir);
    await bridge.startFastPasteBridge();
  });

  afterEach(async () => {
    await bridge.stopFastPasteBridge();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('writes discovery file with port + token + appVersion on start', async () => {
    const ep = bridge.getRunningEndpoint();
    expect(ep).not.toBeNull();
    const data = JSON.parse(
      await fs.readFile(path.join(userDataDir, 'fast-paste-bridge.json'), 'utf-8'),
    );
    expect(data).toMatchObject({
      app: 'cardmirror',
      schema: 2,
      appVersion: 'TEST-1.2.3',
      port: ep!.port,
      token: ep!.token,
    });
    expect(typeof data.pid).toBe('number');
  });

  it('GET /ping with valid token returns full shape', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({ method: 'GET', path: '/ping', port: ep.port, token: ep.token });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ok: true,
      app: 'cardmirror',
      appVersion: 'TEST-1.2.3',
      schema: 2,
      hasActiveDoc: true,
    });
  });

  it('GET /ping with no token → 403', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({ method: 'GET', path: '/ping', port: ep.port });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('GET /ping with wrong token → 403', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({ method: 'GET', path: '/ping', port: ep.port, token: 'wrong' });
    expect(r.status).toBe(403);
  });

  it('rejects requests carrying an Origin header (DNS-rebinding guard)', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'GET',
      path: '/ping',
      port: ep.port,
      token: ep.token,
      headers: { origin: 'http://evil.example.com' },
    });
    expect(r.status).toBe(403);
  });

  it('rejects requests carrying a Referer header', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'GET',
      path: '/ping',
      port: ep.port,
      token: ep.token,
      headers: { referer: 'http://evil.example.com/page' },
    });
    expect(r.status).toBe(403);
  });

  it('POST /insert dispatches to renderer and resolves with docTitle on ok ack', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST',
      path: '/insert',
      port: ep.port,
      token: ep.token,
      body: { text: 'hello', role: 'card', newParagraph: true },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(sentToRenderer).toHaveLength(1);
    const sent = sentToRenderer[0]!;
    expect(sent.channel).toBe('external:insert-text');
    expect(sent.payload).toMatchObject({ text: 'hello', role: 'card', newParagraph: true });
    expect(typeof sent.payload.requestId).toBe('string');
    fireRendererAck({ requestId: sent.payload.requestId, ok: true, docTitle: 'mydoc.cmir' });
    const r = await inserted;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, inserted: true, docTitle: 'mydoc.cmir' });
  });

  it('POST /insert: no-target-doc ack → 200 ok:false', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    await new Promise((r) => setTimeout(r, 20));
    fireRendererAck({ requestId: sentToRenderer[0]!.payload.requestId, ok: false, error: 'no-target-doc' });
    const r = await inserted;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: false, error: 'no-target-doc' });
  });

  it('POST /insert: doc-readonly ack → 200 ok:false', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    await new Promise((r) => setTimeout(r, 20));
    fireRendererAck({ requestId: sentToRenderer[0]!.payload.requestId, ok: false, error: 'doc-readonly' });
    const r = await inserted;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: false, error: 'doc-readonly' });
  });

  it('POST /insert: internal ack → 500', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    await new Promise((r) => setTimeout(r, 20));
    fireRendererAck({ requestId: sentToRenderer[0]!.payload.requestId, ok: false, error: 'internal' });
    const r = await inserted;
    expect(r.status).toBe(500);
  });

  it('POST /insert with non-string text → 400 bad-request', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { role: 'card', newParagraph: true },
    });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'bad-request' });
  });

  it('POST /insert with malformed JSON → 400', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const res = await fetch(`http://127.0.0.1:${ep.port}/insert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fdp-token': ep.token },
      body: '{ broken',
    });
    expect(res.status).toBe(400);
  });

  it('unknown route → 404', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({ method: 'GET', path: '/banana', port: ep.port, token: ep.token });
    expect(r.status).toBe(404);
  });

  it('unknown role degrades to "card" (per §10)', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'mystery', newParagraph: true },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(sentToRenderer[0]!.payload.role).toBe('card');
    fireRendererAck({ requestId: sentToRenderer[0]!.payload.requestId, ok: true });
    await inserted;
  });

  it('no focused window → no-target-doc returned without renderer round-trip', async () => {
    setMockFocusedWindow(null);
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: false, error: 'no-target-doc' });
    expect(sentToRenderer).toHaveLength(0);
  });

  it('stop deletes the discovery file', async () => {
    const file = path.join(userDataDir, 'fast-paste-bridge.json');
    await fs.access(file);
    await bridge.stopFastPasteBridge();
    await expect(fs.access(file)).rejects.toBeTruthy();
    // Restart so afterEach can stop a server cleanly.
    await bridge.startFastPasteBridge();
  });
  describe('POST /jump', () => {
    it('rejects a missing token', async () => {
      const ep = bridge.getRunningEndpoint()!;
      const r = await fetchJson({
        method: 'POST', path: '/jump', port: ep.port,
        body: { source: 'x' },
      });
      expect(r.status).toBe(403);
    });

    it('accepts the token in X-Bridge-Token', async () => {
      const ep = bridge.getRunningEndpoint()!;
      const r = await fetchJson({
        method: 'GET', path: '/ping', port: ep.port,
        headers: { 'x-bridge-token': ep.token },
      });
      expect(r.status).toBe(200);
      expect((r.json as { schema: number }).schema).toBe(2);
    });

    it('400s on a body without a source string', async () => {
      const ep = bridge.getRunningEndpoint()!;
      const r = await fetchJson({
        method: 'POST', path: '/jump', port: ep.port, token: ep.token,
        body: {},
      });
      expect(r.status).toBe(400);
    });

    it('reports doc-not-open with the docTitle when no window matches', async () => {
      // The stub's default window would swallow the jump broadcast
      // and run out the ack timeout; clear it so getAllWindows()
      // returns [] and the no-window path resolves immediately.
      setMockFocusedWindow(null);
      const ep = bridge.getRunningEndpoint()!;
      const source =
        'cmsrc1.' +
        Buffer.from(JSON.stringify({ docId: 'd', docTitle: 'AT Cap K.docx' })).toString('base64url');
      const r = await fetchJson({
        method: 'POST', path: '/jump', port: ep.port, token: ep.token,
        body: { source },
      });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: false, error: 'doc-not-open', docTitle: 'AT Cap K.docx' });
    });

    it('400s a source without the cmsrc1 prefix, with no broadcast', async () => {
      const ep = bridge.getRunningEndpoint()!;
      const source =
        'x.' + Buffer.from(JSON.stringify({ docTitle: 'forged' })).toString('base64url');
      const r = await fetchJson({
        method: 'POST', path: '/jump', port: ep.port, token: ep.token,
        body: { source },
      });
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ ok: false, error: 'bad-request' });
      expect(r.json.docTitle).toBeUndefined();
      // The bad prefix short-circuits before any window is asked to jump.
      expect(sentToRenderer.some((s) => s.channel === 'external:jump')).toBe(false);
    });

    it('answers even when a window is destroyed mid-broadcast', async () => {
      // Only window in the broadcast throws on send (render process gone);
      // the dispatch guard must resolve not-mine instead of rejecting and
      // hanging the /jump route.
      setMockAllWindows([makeMockWindow({ sendThrows: true })]);
      const ep = bridge.getRunningEndpoint()!;
      const source =
        'cmsrc1.' +
        Buffer.from(JSON.stringify({ docId: 'd', docTitle: 'Gone.docx' })).toString('base64url');
      const r = await fetchJson({
        method: 'POST', path: '/jump', port: ep.port, token: ep.token,
        body: { source },
      });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: false, error: 'doc-not-open', docTitle: 'Gone.docx' });
    });
  });
});
