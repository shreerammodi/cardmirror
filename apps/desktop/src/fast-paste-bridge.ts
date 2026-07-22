/**
 * Fast Debate Paste integration — main-process HTTP server.
 *
 * Wire contract: `reference-docs/cardmirror-integration-spec.md`
 * (and the F2 fix companion note in the same folder).
 *
 * Boundary contract:
 *   - Bind `127.0.0.1` only (never 0.0.0.0). Off the network entirely.
 *   - Per-launch random token via `crypto.randomBytes`. Constant-time
 *     compare on `X-FDP-Token` for both endpoints.
 *   - Discovery file at `app.getPath('userData')/fast-paste-bridge.json`,
 *     atomic tmp-then-rename write on start, deleted on `before-quit`.
 *   - Prefer port 17699; on `EADDRINUSE` retry with `listen(0)` and
 *     record the actual port in the discovery file.
 *   - Optionally reject requests carrying an `Origin` / `Referer`
 *     header to blunt DNS-rebinding from a page in the user's browser.
 *
 * Routes:
 *   - `GET  /ping`   → `{ok, app, appVersion, schema, hasActiveDoc}`.
 *   - `POST /insert` → forwards to the focused window's renderer via
 *     `external:insert-text` IPC and awaits the renderer's
 *     `external:insert-result` reply (with a hard timeout so the
 *     client never hangs and can fall back to its keystroke path).
 *
 * Routing is just the focused window (or any window if none is
 * focused) — the client activates the target CardMirror window
 * before calling, so there's no per-doc / per-window addressing.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const PREFERRED_PORT = 17699;
const SCHEMA_VERSION = 2;
const TOKEN_BYTES = 24;
/** Hard timeout the client also enforces at 1500ms — keep ours
 *  slightly under so the server fails fast before the client
 *  cancels its own request and falls back to keystrokes. */
const RENDERER_ACK_TIMEOUT_MS = 1200;

interface DiscoveryFile {
  schema: number;
  port: number;
  token: string;
  pid: number;
  app: string;
  appVersion: string;
}

interface InsertPayload {
  text?: unknown;
  role?: unknown;
  newParagraph?: unknown;
  omitted?: unknown;
}

interface RendererAck {
  requestId: string;
  ok: boolean;
  error?: string;
  docTitle?: string;
}

interface JumpAck {
  requestId: string;
  ok: boolean;
  error?: string;
}

let serverState: { server: http.Server; token: string; port: number } | null = null;

const pendingAcks = new Map<string, {
  resolve: (ack: RendererAck) => void;
  timer: NodeJS.Timeout;
}>();

const pendingJumpAcks = new Map<string, {
  resolve: (ack: JumpAck) => void;
  timer: NodeJS.Timeout;
}>();

function discoveryFilePath(): string {
  return path.join(app.getPath('userData'), 'fast-paste-bridge.json');
}

async function writeDiscoveryFile(token: string, port: number): Promise<void> {
  const data: DiscoveryFile = {
    schema: SCHEMA_VERSION,
    port,
    token,
    pid: process.pid,
    app: 'cardmirror',
    appVersion: app.getVersion(),
  };
  const finalPath = discoveryFilePath();
  const tmpPath = `${finalPath}.tmp`;
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.rename(tmpPath, finalPath);
}

async function deleteDiscoveryFile(): Promise<void> {
  await fs.unlink(discoveryFilePath()).catch(() => {});
}

function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function checkToken(req: http.IncomingMessage, token: string): boolean {
  // Schema 2 accepts the cross-app X-Bridge-Token header alongside
  // the legacy FDP one; both compare constant-time.
  const header = req.headers['x-bridge-token'] ?? req.headers['x-fdp-token'];
  if (typeof header !== 'string') return false;
  return constantTimeEqual(header, token);
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readRequestBody(req: http.IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (c: Buffer) => {
      received += c.length;
      if (received > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function normalizeRole(value: unknown): 'card' | 'cite' | 'inline' {
  if (value === 'cite') return 'cite';
  if (value === 'inline') return 'inline';
  // Unknown values degrade to `card` per §10.
  return 'card';
}

function focusedRenderTarget(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  // The client activates the target window before calling, so
  // we should almost always have a focused window. Fall back to
  // the first available window so a non-focused-but-running app
  // can still serve `/ping` and not look broken.
  const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return all.length > 0 ? all[0]! : null;
}

function dispatchToRenderer(payload: InsertPayload): Promise<RendererAck> {
  return new Promise((resolve) => {
    const win = focusedRenderTarget();
    if (!win) {
      resolve({ requestId: '', ok: false, error: 'no-target-doc' });
      return;
    }
    const requestId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingAcks.delete(requestId);
      resolve({ requestId, ok: false, error: 'internal' });
    }, RENDERER_ACK_TIMEOUT_MS);
    pendingAcks.set(requestId, { resolve, timer });
    win.webContents.send('external:insert-text', {
      requestId,
      text: typeof payload.text === 'string' ? payload.text : '',
      role: normalizeRole(payload.role),
      newParagraph:
        typeof payload.newParagraph === 'boolean' ? payload.newParagraph : true,
      omitted: payload.omitted === true,
    });
  });
}

function onRendererAck(_evt: unknown, ack: RendererAck): void {
  if (!ack || typeof ack.requestId !== 'string') return;
  const pending = pendingAcks.get(ack.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingAcks.delete(ack.requestId);
  pending.resolve(ack);
}

function onJumpAck(_evt: unknown, ack: JumpAck): void {
  if (!ack || typeof ack.requestId !== 'string') return;
  const pending = pendingJumpAcks.get(ack.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingJumpAcks.delete(ack.requestId);
  pending.resolve(ack);
}

function dispatchJumpTo(win: BrowserWindow, source: string): Promise<JumpAck> {
  return new Promise((resolve) => {
    const requestId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingJumpAcks.delete(requestId);
      resolve({ requestId, ok: false, error: 'not-mine' });
    }, RENDERER_ACK_TIMEOUT_MS);
    pendingJumpAcks.set(requestId, { resolve, timer });
    win.webContents.send('external:jump', { requestId, source });
  });
}

/** Minimal token peek — main only needs docTitle for the
 *  doc-not-open message; full parsing stays renderer-side. */
function docTitleFromToken(source: string): string | undefined {
  const dot = source.indexOf('.');
  if (dot < 0) return undefined;
  try {
    const obj = JSON.parse(
      Buffer.from(source.slice(dot + 1), 'base64url').toString('utf8'),
    ) as { docTitle?: unknown };
    return typeof obj.docTitle === 'string' && obj.docTitle ? obj.docTitle : undefined;
  } catch {
    return undefined;
  }
}

/** Ask each window in turn to resolve the token; the first ok wins and
 *  its window is focused. Exported for the host:plugin-jump IPC. */
export async function broadcastJump(
  source: string,
): Promise<{ ok: boolean; error?: string; docTitle?: string }> {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  let sawBadRequest = false;
  let sawNotFound = false;
  for (const win of wins) {
    const ack = await dispatchJumpTo(win, source);
    if (ack.ok) {
      win.show();
      win.focus();
      return { ok: true };
    }
    if (ack.error === 'bad-request') sawBadRequest = true;
    if (ack.error === 'not-found') sawNotFound = true;
  }
  if (sawBadRequest) return { ok: false, error: 'bad-request' };
  if (sawNotFound) return { ok: false, error: 'not-found' };
  const docTitle = docTitleFromToken(source);
  return { ok: false, error: 'doc-not-open', ...(docTitle ? { docTitle } : {}) };
}
let ipcSubscribed = false;

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
): Promise<void> {
  // Optional Origin / Referer rejection — anything carrying either
  // header almost certainly came from a browser page, which has no
  // business talking to us. Plain `curl` / the FDP client do not
  // set these.
  if (req.headers['origin'] || req.headers['referer']) {
    jsonResponse(res, 403, { ok: false, error: 'unauthorized' });
    return;
  }

  if (!checkToken(req, token)) {
    jsonResponse(res, 403, { ok: false, error: 'unauthorized' });
    return;
  }

  const url = req.url ?? '';
  if (req.method === 'GET' && url === '/ping') {
    const hasActiveDoc = !!focusedRenderTarget();
    jsonResponse(res, 200, {
      ok: true,
      app: 'cardmirror',
      appVersion: app.getVersion(),
      schema: SCHEMA_VERSION,
      hasActiveDoc,
    });
    return;
  }

  if (req.method === 'POST' && url === '/insert') {
    let bodyText: string;
    try {
      bodyText = await readRequestBody(req);
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    let payload: InsertPayload;
    try {
      payload = JSON.parse(bodyText) as InsertPayload;
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    if (typeof payload.text !== 'string') {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    const ack = await dispatchToRenderer(payload);
    // Map error → status code per §4.5.
    if (ack.ok) {
      jsonResponse(res, 200, { ok: true, inserted: true, docTitle: ack.docTitle });
      return;
    }
    if (ack.error === 'no-target-doc' || ack.error === 'doc-readonly') {
      jsonResponse(res, 200, { ok: false, error: ack.error });
      return;
    }
    if (ack.error === 'bad-request') {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    jsonResponse(res, 500, { ok: false, error: ack.error ?? 'internal' });
    return;
  }

  if (req.method === 'POST' && url === '/jump') {
    let payload: { source?: unknown };
    try {
      payload = JSON.parse(await readRequestBody(req)) as { source?: unknown };
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    if (typeof payload.source !== 'string' || !payload.source) {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    const result = await broadcastJump(payload.source);
    if (result.ok) {
      jsonResponse(res, 200, { ok: true });
      return;
    }
    if (result.error === 'bad-request') {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    jsonResponse(res, 200, {
      ok: false,
      error: result.error,
      ...(result.docTitle ? { docTitle: result.docTitle } : {}),
    });
    return;
  }

  jsonResponse(res, 404, { ok: false, error: 'bad-request' });
}

function tryListen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      resolve(actualPort);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startFastPasteBridge(): Promise<void> {
  if (serverState) return;
  if (!ipcSubscribed) {
    ipcMain.on('external:insert-result', onRendererAck);
    ipcMain.on('external:jump-result', onJumpAck);
    ipcSubscribed = true;
  }

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, token);
  });

  let port: number;
  try {
    port = await tryListen(server, PREFERRED_PORT);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      port = await tryListen(server, 0);
    } else {
      // Some other fatal listen error — drop the server and don't
      // write the discovery file. The client will read no file →
      // fall back to keystrokes, which is exactly what we want.
      return;
    }
  }

  try {
    await writeDiscoveryFile(token, port);
  } catch {
    // Can't write discovery file (permission, disk full, …). Bail
    // gracefully — same outcome as not starting the server: the
    // client falls back to its keystroke path.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return;
  }
  serverState = { server, token, port };
}

export async function stopFastPasteBridge(): Promise<void> {
  if (!serverState) {
    // No server, but a stale discovery file may exist from a prior
    // crash — clean it up anyway so the next launch starts fresh.
    await deleteDiscoveryFile();
    return;
  }
  const { server } = serverState;
  serverState = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const pending of pendingAcks.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ requestId: '', ok: false, error: 'internal' });
  }
  pendingAcks.clear();
  for (const pending of pendingJumpAcks.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ requestId: '', ok: false, error: 'not-mine' });
  }
  pendingJumpAcks.clear();
  // Drop the IPC subscription so a subsequent `start` re-installs
  // it cleanly. Production only ever calls `start` once per app
  // lifetime, but tests cycle the bridge across describe/it blocks
  // and would otherwise carry a stale subscription that the stub
  // can't see.
  if (ipcSubscribed) {
    const im = ipcMain as unknown as {
      removeListener?: (ch: string, l: (...args: never[]) => void) => void;
    };
    im.removeListener?.('external:insert-result', onRendererAck);
    im.removeListener?.('external:jump-result', onJumpAck);
    ipcSubscribed = false;
  }
  await deleteDiscoveryFile();
}

/** Test/diagnostic accessor — returns the running port + token,
 *  or null if the server isn't running. Production code never
 *  needs this; tests use it to issue requests against an
 *  ephemeral port. */
export function getRunningEndpoint(): { port: number; token: string } | null {
  if (!serverState) return null;
  return { port: serverState.port, token: serverState.token };
}
