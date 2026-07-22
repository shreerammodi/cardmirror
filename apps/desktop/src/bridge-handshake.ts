/**
 * cardmirror-bridge — the published cross-app handshake standard.
 * A shared per-platform directory where each debate app writes
 * `<appId>.json` on launch (atomic), deletes it on quit, and rotates
 * its token per session. CardMirror mirrors its fast-paste endpoint
 * here as kind "editor"; flowing apps register as kind "flow".
 * All cross-app transport is brokered HERE — renderer plugins never
 * see tokens or sockets.
 */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const BRIDGE_SCHEMA = 1;
export const BRIDGE_TOKEN_HEADER = 'X-Bridge-Token';
const PING_TIMEOUT_MS = 1500;
const POST_TIMEOUT_MS = 3000;
const APP_ID_RE = /^[a-z0-9][a-z0-9-]*$/i;

export interface FlowAppInfo {
  id: string;
  app: string;
  appVersion: string;
  schema: number;
  kind: 'flow';
}
export type FlowPostResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: 'no-such-app' | 'app-not-running' | 'timeout' | 'bad-response' };

interface HandshakeFile {
  schema: number;
  app: string;
  appVersion: string;
  kind: string;
  port: number;
  token: string;
  pid: number;
}

export function bridgeDirPath(): string {
  if (process.env['CARDMIRROR_BRIDGE_DIR']) return process.env['CARDMIRROR_BRIDGE_DIR'];
  if (process.platform === 'linux') {
    const base = process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'cardmirror-bridge');
  }
  return path.join(app.getPath('appData'), 'cardmirror-bridge');
}

export async function writeCardmirrorHandshake(port: number, token: string): Promise<void> {
  const dir = bridgeDirPath();
  const data: HandshakeFile = {
    schema: BRIDGE_SCHEMA,
    app: 'cardmirror',
    appVersion: app.getVersion(),
    kind: 'editor',
    port,
    token,
    pid: process.pid,
  };
  const finalPath = path.join(dir, 'cardmirror.json');
  const tmpPath = `${finalPath}.tmp`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.rename(tmpPath, finalPath);
}

export async function deleteCardmirrorHandshake(): Promise<void> {
  await fs.unlink(path.join(bridgeDirPath(), 'cardmirror.json')).catch(() => {});
}

async function readHandshake(appId: string): Promise<HandshakeFile | null> {
  if (!APP_ID_RE.test(appId)) return null;
  try {
    const raw = await fs.readFile(path.join(bridgeDirPath(), `${appId}.json`), 'utf8');
    const obj = JSON.parse(raw) as Partial<HandshakeFile>;
    if (
      typeof obj.port !== 'number' ||
      typeof obj.token !== 'string' ||
      typeof obj.kind !== 'string' ||
      typeof obj.app !== 'string'
    ) {
      return null;
    }
    return {
      schema: typeof obj.schema === 'number' ? obj.schema : 0,
      app: obj.app,
      appVersion: typeof obj.appVersion === 'string' ? obj.appVersion : '',
      kind: obj.kind,
      port: obj.port,
      token: obj.token,
      pid: typeof obj.pid === 'number' ? obj.pid : 0,
    };
  } catch {
    return null;
  }
}

/** Headers-only deadline — fine for ping, which never reads a body. */
function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
}

async function ping(hs: HandshakeFile): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `http://127.0.0.1:${hs.port}/ping`,
      { headers: { [BRIDGE_TOKEN_HEADER]: hs.token } },
      PING_TIMEOUT_MS,
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Live flow apps only — a stale handshake (crashed app) fails the
 *  ping and is skipped. Tokens never leave this module. */
export async function scanFlowApps(): Promise<FlowAppInfo[]> {
  let names: string[];
  try {
    names = await fs.readdir(bridgeDirPath());
  } catch {
    return [];
  }
  const out: FlowAppInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    const hs = await readHandshake(id);
    if (!hs || hs.kind !== 'flow') continue;
    if (await ping(hs)) {
      out.push({ id, app: hs.app, appVersion: hs.appVersion, schema: hs.schema, kind: 'flow' });
    }
  }
  return out;
}

export async function flowPost(
  appId: string,
  route: string,
  body: unknown,
): Promise<FlowPostResult> {
  const hs = await readHandshake(appId);
  if (!hs || hs.kind !== 'flow') return { ok: false, error: 'no-such-app' };
  const routePath = route.startsWith('/') ? route : `/${route}`;
  // One deadline covers connect, headers, AND the body read: a peer that
  // sends headers then stalls the body must still map to 'timeout'.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), POST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${hs.port}${routePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [BRIDGE_TOKEN_HEADER]: hs.token },
      body: JSON.stringify(body ?? {}),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') return { ok: false, error: 'timeout' };
    return { ok: false, error: 'app-not-running' };
  }
  try {
    return { ok: true, status: res.status, body: await res.json() };
  } catch (err) {
    if ((err as Error).name === 'AbortError') return { ok: false, error: 'timeout' };
    return { ok: false, error: 'bad-response' };
  } finally {
    clearTimeout(timer);
  }
}
