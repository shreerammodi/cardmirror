/**
 * Verbatim Flow bridge (Windows only).
 *
 * The renderer can't speak COM, so the main process drives a bundled
 * Windows-PowerShell helper (`resources/flow/verbatim-flow.ps1`) that
 * talks to the standard Excel object model — exactly what the Verbatim
 * Word add-in does, requiring NO modification to Verbatim Flow.
 *
 * The helper runs as ONE long-lived process. Spawning `powershell.exe`
 * cold (CLR load + the OS scanning the launch) costs a second or more —
 * on a VM, several. Paying that once and then streaming newline-delimited
 * JSON requests over its stdin keeps every send/pull after the first in
 * the low-millisecond range. The host starts lazily on the first verb,
 * can be pre-warmed explicitly (the `startFlowHost` command / the
 * start-on-launch setting), respawns if it dies, and is killed on quit.
 *
 * On non-Windows hosts every call resolves to a benign "windows-only"
 * result and nothing is spawned.
 */

import { app, ipcMain } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

type Verb = 'available' | 'send' | 'pull' | 'create' | 'ping';
type Json = Record<string, unknown>;

// Per-request ceiling. COM verbs are fast; if one hasn't answered by now
// the host is wedged (e.g. a modal stuck in Excel), so we fail it and tear
// the host down — a desynced request/response stream can't be trusted, and
// the next call respawns a clean one.
const REQUEST_TIMEOUT_MS = 20_000;

function helperScriptPath(): string {
  // Packaged: extraResources puts it under resourcesPath/flow. Dev: it
  // lives in apps/desktop/resources/flow (main.js runs from dist/).
  return app.isPackaged
    ? path.join(process.resourcesPath, 'flow', 'verbatim-flow.ps1')
    : path.join(__dirname, '..', 'resources', 'flow', 'verbatim-flow.ps1');
}

let child: ChildProcessWithoutNullStreams | null = null;
let stdoutBuf = '';
let nextId = 1;
/** The request currently awaiting a response (the protocol is strictly
 *  one-in-flight: Excel COM is single-threaded and responses are matched
 *  in FIFO order). */
let inflight: { resolve: (v: Json) => void; timer: NodeJS.Timeout } | null = null;
const queue: Array<{ line: string; resolve: (v: Json) => void }> = [];

/** Fail the in-flight + all queued requests and drop the host. */
function teardown(reason: string): void {
  const err: Json = { ok: false, available: false, error: reason };
  if (inflight) {
    clearTimeout(inflight.timer);
    inflight.resolve(err);
    inflight = null;
  }
  while (queue.length) queue.shift()!.resolve(err);
  stdoutBuf = '';
  if (child) {
    const c = child;
    child = null;
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Feed the next queued request to the host if it's idle. The per-request
 *  timeout starts here (when it goes in-flight), not at enqueue, so a
 *  request waiting behind a slow one gets its full window. */
function pump(): void {
  if (inflight || queue.length === 0 || !child) return;
  const next = queue.shift()!;
  const timer = setTimeout(() => teardown('flow host timed out'), REQUEST_TIMEOUT_MS);
  inflight = { resolve: next.resolve, timer };
  try {
    child.stdin.write(next.line + '\n');
  } catch {
    teardown('flow host write failed');
  }
}

/** Resolve the in-flight request with one parsed response line. */
function handleLine(line: string): void {
  const text = line.trim();
  if (!text) return;
  let obj: Json;
  try {
    obj = JSON.parse(text) as Json;
  } catch {
    obj = { ok: false, error: `bad helper output: ${text.slice(0, 200)}` };
  }
  const cur = inflight;
  inflight = null;
  if (cur) {
    clearTimeout(cur.timer);
    cur.resolve(obj);
  }
  pump();
}

/** Spawn the persistent PowerShell host. Idempotent; returns false only
 *  when it genuinely can't start (non-Windows, or spawn threw). */
function startHost(): boolean {
  if (process.platform !== 'win32') return false;
  if (child) return true;
  let c: ChildProcessWithoutNullStreams;
  try {
    c = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperScriptPath()],
      { windowsHide: true },
    );
  } catch {
    return false;
  }
  child = c;
  stdoutBuf = '';
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', (d: string) => {
    stdoutBuf += d;
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      handleLine(line);
    }
  });
  // Drain stderr so a chatty error can't fill the pipe and wedge the
  // child; we don't surface it (verb errors come back as JSON).
  c.stderr.setEncoding('utf8');
  c.stderr.on('data', () => {});
  // A broken stdin pipe surfaces here; swallow so it doesn't crash main —
  // the matching 'exit' tears the host down.
  c.stdin.on('error', () => {});
  c.on('error', () => {
    if (child === c) teardown('flow host failed to start');
  });
  c.on('exit', () => {
    // Only tear down if THIS child is still the active one (a fresh start
    // may already have replaced it).
    if (child === c) teardown('flow host exited');
  });
  return true;
}

/** Send one verb to the host and await its JSON response. */
function runVerb(verb: Verb, opts: { payload?: unknown; force?: boolean } = {}): Promise<Json> {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, available: false, error: 'windows-only' });
  }
  if (!child && !startHost()) {
    return Promise.resolve({ ok: false, error: 'powershell-unavailable' });
  }
  return new Promise((resolve) => {
    const id = nextId++;
    const req: Json = { id, verb };
    if (opts.payload !== undefined) req.payload = opts.payload;
    if (opts.force) req.force = true;
    const line = JSON.stringify(req);
    queue.push({ line, resolve });
    pump();
  });
}

/** Register the Flow IPC channels. Safe to call on any platform — the
 *  handlers just resolve "windows-only" off Windows. */
export function registerFlowIpc(): void {
  ipcMain.handle('host:flow-available', () => runVerb('available'));
  ipcMain.handle('host:flow-send', (_e, payload: { cells: string[] }, force?: boolean) =>
    runVerb('send', { payload, force: !!force }),
  );
  ipcMain.handle('host:flow-pull', () => runVerb('pull'));
  ipcMain.handle('host:flow-create', (_e, templatePath?: string) =>
    runVerb('create', { payload: templatePath ? { templatePath } : {} }),
  );
  // Pre-warm: spin the host up (paying the cold start now) and confirm it
  // answers, without touching Excel.
  ipcMain.handle('host:flow-start', () => runVerb('ping'));

  // Never leave an orphaned PowerShell behind.
  app.on('before-quit', () => teardown('app quitting'));
}
