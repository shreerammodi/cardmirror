/**
 * Voice IPC wiring (SPEC-voice.md §12 item 2). One recognition session
 * at a time, owned by the window that started it; that window receives
 * `voice:event` / `voice:level`. Audio flows renderer→main as raw PCM
 * over a fire-and-forget channel and is proxied to a **forked worker
 * process** that owns the recognizer — decode is synchronous FFI work,
 * and isolating it means an engine stall or crash can never block or
 * kill the main process (a vosk grammar-swap abort and lgraph decode
 * bursts both did exactly that when the service ran in-process).
 */
import { app, ipcMain, systemPreferences } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VoiceStartOptions, VoiceStartResult } from './types';

let worker: ChildProcess | null = null;
let ownerWebContentsId: number | null = null;
/** Owner-lifecycle listeners, removed in stopSession so repeated
 *  starts don't stack handlers. */
let ownerCleanup: (() => void) | null = null;

function libFileName(): string {
  if (process.platform === 'win32') return 'libvosk.dll';
  if (process.platform === 'darwin') return 'libvosk.dylib';
  return 'libvosk.so';
}

/** The base recognition model is not bundled in the installer — it's a
 *  one-time download into userData (like the large model), so the many
 *  users who never enable voice don't carry ~230 MB they'll never use.
 *  libvosk IS bundled: it's small, and shipping native code inside the
 *  signed artifact avoids the Gatekeeper/library-validation issues a
 *  downloaded .dylib would raise. */
const BASE_MODEL_NAME = 'vosk-model-en-us-0.22-lgraph';
const BASE_MODEL_URL = `https://alphacephei.com/vosk/models/${BASE_MODEL_NAME}.zip`;

function baseModelDir(): string {
  return path.join(app.getPath('userData'), 'voice-models', BASE_MODEL_NAME);
}

function baseModelPresent(): boolean {
  // `graph/` is the lgraph model's characteristic subdir (the fetch
  // script keys its skip-check on the same).
  return fs.existsSync(path.join(baseModelDir(), 'graph'));
}

/** Locate libvosk (bundled) + the base model. Model search order:
 *  1. CARDMIRROR_VOICE_DIR (expects <dir>/<libvosk> and <dir>/model/)
 *  2. userData download (the default — see BASE_MODEL_NAME)
 *  3. packaged resources (legacy fat installs; also the dev/`--full`
 *     build) → resources/voice/model/
 *  4. dev fallback: the recognizer spike's downloads in the repo
 *  libvosk is resolved independently (it's always bundled), so a
 *  userData-only model still pairs with the shipped lib.
 *  The two paths are returned independently (null for whichever is
 *  missing) — callers must tell "model not downloaded yet" (the
 *  common, recoverable case: offer the download) apart from "libvosk
 *  missing" (a broken install); an all-or-nothing null would make the
 *  download offer unreachable on a fresh install. */
function resolveVoiceAssets(): { libPath: string | null; modelDir: string | null } {
  const libCandidates: string[] = [];
  const modelCandidates: string[] = [];
  const envDir = process.env.CARDMIRROR_VOICE_DIR;
  if (envDir) {
    libCandidates.push(path.join(envDir, libFileName()));
    modelCandidates.push(path.join(envDir, 'model'));
  }
  modelCandidates.push(baseModelDir());
  libCandidates.push(path.join(process.resourcesPath, 'voice', libFileName()));
  modelCandidates.push(path.join(process.resourcesPath, 'voice', 'model'));
  if (!app.isPackaged) {
    const spike = path.join(__dirname, '..', '..', '..', '..', 'spikes', 'voice-recognizer');
    libCandidates.push(path.join(spike, 'lib', libFileName()));
    modelCandidates.push(path.join(spike, 'models', BASE_MODEL_NAME));
  }
  const libPath = libCandidates.find((p) => fs.existsSync(p)) ?? null;
  const modelDir = modelCandidates.find((p) => fs.existsSync(p)) ?? null;
  return { libPath, modelDir };
}

/** Filesystem path to the forked recognizer worker. In a packaged
 *  build the worker is forked under a REAL Node (execPath: nodeBin),
 *  which has no asar support and so cannot load worker.js from inside
 *  app.asar — the require fails with MODULE_NOT_FOUND. electron-builder's
 *  `asarUnpack` keeps dist/voice/** (and koffi) on disk under
 *  app.asar.unpacked; rewrite the path to point there. In dev __dirname
 *  is an ordinary directory with no `app.asar` segment, so the replace
 *  is a no-op and the real dist path is used. */
function resolveWorkerPath(): string {
  const p = path.join(__dirname, 'worker.js');
  return p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function nodeBinName(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

/** Node runtime downloaded alongside the large model, in userData. */
function downloadedNodePath(): string {
  return path.join(app.getPath('userData'), 'voice-runtime', nodeBinName());
}

/** The worker needs a REAL Node runtime: Electron's binary (even with
 *  ELECTRON_RUN_AS_NODE) uses Chromium's allocator, which SIGTRAPs on
 *  the large dictation model's multi-GB allocations; system Node loads
 *  it fine. Resolution order:
 *   1. CARDMIRROR_NODE env
 *   2. userData download (fetched with the large model)
 *   3. packaged resources (legacy fat installs; also the dev/`--full`
 *      build)
 *   4. system node on PATH
 *  Falling back to electron-as-node still works for the STANDARD
 *  model; the large model is then disabled with an explicit flag. */
function resolveNodeBinary(): string | null {
  const candidates = [
    process.env.CARDMIRROR_NODE,
    // userData download (fetched with the large model)
    downloadedNodePath(),
    // legacy fat install (also the dev/`--full` build)
    path.join(process.resourcesPath, 'voice', nodeBinName()),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const found = execSync(process.platform === 'win32' ? 'where node' : 'command -v node', {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')[0];
    if (found && fs.existsSync(found)) return found;
  } catch {
    /* no system node */
  }
  return null;
}

const NODE_VERSION = 'v22.12.0';

/** Fetch the standalone Node runtime into userData/voice-runtime. Only
 *  the large dictation model needs it; kept out of the base install.
 *  No-op if already present or if a suitable binary is already
 *  resolvable (system node covers it). Reuses the shared
 *  `downloadInFlight` guard held by the caller. */
async function ensureDownloadedNodeRuntime(sender: Electron.WebContents): Promise<void> {
  if (fs.existsSync(downloadedNodePath())) return;
  const archMap: Record<string, { pkg: string; inner: string; bin: string }> = {
    'linux': {
      pkg: `node-${NODE_VERSION}-linux-x64.tar.gz`,
      inner: `node-${NODE_VERSION}-linux-x64`,
      bin: 'bin/node',
    },
    'darwin': {
      pkg: `node-${NODE_VERSION}-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`,
      inner: `node-${NODE_VERSION}-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
      bin: 'bin/node',
    },
    'win32': {
      pkg: `node-${NODE_VERSION}-win-x64.zip`,
      inner: `node-${NODE_VERSION}-win-x64`,
      bin: 'node.exe',
    },
  };
  const spec = archMap[process.platform];
  if (!spec) return;
  const root = path.join(app.getPath('userData'), 'voice-runtime');
  const pkgPath = path.join(root, spec.pkg);
  const extractDir = path.join(root, '_extract');
  try {
    fs.mkdirSync(root, { recursive: true });
    if (!sender.isDestroyed()) {
      sender.send('voice:download-progress', { model: 'node-runtime', pct: 0 });
    }
    const res = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/${spec.pkg}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!res.ok) throw new Error(`node runtime HTTP ${res.status}`);
    fs.writeFileSync(pkgPath, Buffer.from(await res.arrayBuffer()));
    fs.mkdirSync(extractDir, { recursive: true });
    const { execFile } = await import('node:child_process');
    const run = (cmd: string, args: string[]) =>
      new Promise<void>((resolve, reject) =>
        execFile(cmd, args, (err) => (err ? reject(err) : resolve())),
      );
    if (spec.pkg.endsWith('.zip')) {
      try {
        await run('unzip', ['-oq', pkgPath, '-d', extractDir]);
      } catch {
        await run('tar', ['-xf', pkgPath, '-C', extractDir]);
      }
    } else {
      await run('tar', ['-xf', pkgPath, '-C', extractDir]);
    }
    fs.copyFileSync(path.join(extractDir, spec.inner, spec.bin), downloadedNodePath());
    fs.chmodSync(downloadedNodePath(), 0o755);
  } finally {
    fs.rmSync(pkgPath, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function stopSession(): void {
  worker?.kill();
  worker = null;
  ownerWebContentsId = null;
  ownerCleanup?.();
  ownerCleanup = null;
}

const LARGE_MODEL_NAME = 'vosk-model-en-us-0.22';
const LARGE_MODEL_URL = `https://alphacephei.com/vosk/models/${LARGE_MODEL_NAME}.zip`;

function largeModelDir(): string {
  return path.join(app.getPath('userData'), 'voice-models', LARGE_MODEL_NAME);
}

function largeModelPresent(): boolean {
  return fs.existsSync(path.join(largeModelDir(), 'am'));
}

/** Serializes ALL voice downloads (base model, large model, node
 *  runtime) — the large model alone is 1.8 GB, so overlapping fetches
 *  would thrash bandwidth and disk. A single flag also keeps the
 *  progress channel unambiguous (one download reporting at a time). */
let downloadInFlight = false;

/** Stream `url` to `zipPath` under `root`, report percent to `sender`,
 *  then extract into `root`. Shared by the base + large model
 *  downloads. Caller owns the `downloadInFlight` guard and the
 *  present-check. `label` tags progress so a renderer can distinguish
 *  which asset is downloading. */
async function downloadAndExtract(
  url: string,
  root: string,
  zipName: string,
  sender: Electron.WebContents,
  label: 'base-model' | 'large-model',
): Promise<{ ok: boolean; error?: string }> {
  const zipPath = path.join(root, zipName);
  try {
    fs.mkdirSync(root, { recursive: true });
    // 30-minute overall ceiling — a stalled download must not pin
    // `downloadInFlight` forever.
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(zipPath);
    const reader = res.body.getReader();
    let received = 0;
    let lastPct = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      await new Promise<void>((resolve, reject) =>
        out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve())),
      );
      const pct = total ? Math.floor((received / total) * 100) : 0;
      if (pct !== lastPct && !sender.isDestroyed()) {
        lastPct = pct;
        sender.send('voice:download-progress', {
          model: label,
          pct,
          receivedMB: Math.round(received / 1e6),
        });
      }
    }
    await new Promise<void>((resolve) => out.end(() => resolve()));
    if (!sender.isDestroyed()) {
      sender.send('voice:download-progress', { model: label, pct: 100, extracting: true });
    }
    // Async extraction — `execFileSync` of a 1.8 GB zip freezes the
    // whole main process.
    const { execFile } = await import('node:child_process');
    const run = (cmd: string, args: string[]) =>
      new Promise<void>((resolve, reject) =>
        execFile(cmd, args, (err) => (err ? reject(err) : resolve())),
      );
    try {
      await run('unzip', ['-oq', zipPath, '-d', root]);
    } catch {
      await run('tar', ['-xf', zipPath, '-C', root]);
    }
    fs.rmSync(zipPath, { force: true });
    return { ok: true };
  } catch (err) {
    fs.rmSync(zipPath, { force: true });
    return { ok: false, error: String(err) };
  }
}

/** Download + extract the base recognition model (~130 MB) into
 *  userData on first use, streaming progress to the requesting
 *  renderer. This is the model voice control needs to run at all. */
async function downloadBaseModel(sender: Electron.WebContents): Promise<{ ok: boolean; error?: string }> {
  if (baseModelPresent()) return { ok: true };
  if (downloadInFlight) return { ok: false, error: 'download-in-progress' };
  downloadInFlight = true;
  try {
    const root = path.join(app.getPath('userData'), 'voice-models');
    const r = await downloadAndExtract(BASE_MODEL_URL, root, `${BASE_MODEL_NAME}.zip`, sender, 'base-model');
    if (!r.ok) return r;
    return baseModelPresent() ? { ok: true } : { ok: false, error: 'extract-failed' };
  } finally {
    downloadInFlight = false;
  }
}

/** Download + extract the opt-in large dictation model (~1.8 GB) into
 *  userData, plus the standalone Node runtime it requires (the large
 *  model SIGTRAPs under Electron's Chromium allocator; only a real Node
 *  binary loads it — see resolveNodeBinary). Both are fetched here so a
 *  fresh install carries neither until the user opts into the large
 *  model. */
async function downloadLargeModel(sender: Electron.WebContents): Promise<{ ok: boolean; error?: string }> {
  if (largeModelPresent()) return { ok: true };
  if (downloadInFlight) return { ok: false, error: 'download-in-progress' };
  downloadInFlight = true;
  try {
    const root = path.join(app.getPath('userData'), 'voice-models');
    const r = await downloadAndExtract(LARGE_MODEL_URL, root, `${LARGE_MODEL_NAME}.zip`, sender, 'large-model');
    if (!r.ok) return r;
    if (!largeModelPresent()) return { ok: false, error: 'extract-failed' };
    // Best-effort: fetch the Node runtime the large model needs. A
    // failure here isn't fatal — voice-start falls back to system node,
    // else electron-as-node with the large model disabled.
    await ensureDownloadedNodeRuntime(sender).catch(() => {});
    return { ok: true };
  } finally {
    downloadInFlight = false;
  }
}

export function registerVoiceIpc(): void {
  ipcMain.handle(
    'host:voice-start',
    async (event, opts: VoiceStartOptions = {}): Promise<VoiceStartResult> => {
      const sender = event.sender;
      if (worker && ownerWebContentsId !== sender.id) {
        return { ok: false, error: 'voice-in-use' };
      }
      // macOS: the renderer's getUserMedia can "succeed" yet deliver a
      // SILENT track until the OS-level microphone permission is granted —
      // the audio graph runs but every sample is zero. Ask for (and, on
      // first use, prompt for) access before capture starts. Requires
      // NSMicrophoneUsageDescription in the Info.plist (see package.json
      // build.mac.extendInfo); a no-op once granted, and a no-op off macOS.
      if (process.platform === 'darwin') {
        try {
          const granted = await systemPreferences.askForMediaAccess('microphone');
          if (!granted) return { ok: false, error: 'voice-mic-denied' };
        } catch {
          return { ok: false, error: 'voice-mic-denied' };
        }
      }
      if (worker) stopSession(); // same window restarting — rebuild cleanly
      const found = resolveVoiceAssets();
      const libPath = found.libPath;
      const modelDir = opts.modelDir ?? found.modelDir;
      if (!libPath || !modelDir || !fs.existsSync(modelDir)) {
        // Distinguish "the model needs downloading" (the common,
        // recoverable case now that it's not bundled) from a genuinely
        // broken install where libvosk itself is missing.
        return {
          ok: false,
          error: libPath ? 'voice-model-missing' : 'voice-assets-missing',
        };
      }
      const assets = { libPath, modelDir };

      // Plain Node child, NOT utilityProcess (see resolveNodeBinary).
      // Advanced serialization structured-clones the audio chunks.
      const nodeBin = resolveNodeBinary();
      const wantLarge = opts.dictationModel === 'large' && largeModelPresent();
      const largeUnsupported = wantLarge && !nodeBin;
      const child = fork(resolveWorkerPath(), [], {
        ...(nodeBin
          ? { execPath: nodeBin, env: { ...process.env } }
          : { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }),
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      worker = child;
      ownerWebContentsId = sender.id;

      const started = await new Promise<VoiceStartResult>((resolve) => {
        // 60 s: the large dictation model alone takes ~10 s to load
        // warm, more on cold disk cache.
        const timeout = setTimeout(() => resolve({ ok: false, error: 'voice-worker-timeout' }), 60000);
        child.once('message', (m: { type: string; modelLoadMs?: number; error?: string }) => {
          clearTimeout(timeout);
          if (m.type === 'started') resolve({ ok: true, modelLoadMs: m.modelLoadMs });
          else resolve({ ok: false, error: m.error ?? 'voice-worker-error' });
        });
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve({ ok: false, error: 'voice-worker-died' });
        });
        child.send({
          type: 'start',
          libPath: assets.libPath,
          modelDir: assets.modelDir,
          dictationModelDir: wantLarge && nodeBin ? largeModelDir() : undefined,
          rmsGate: opts.rmsGate,
          minWordConf: opts.minWordConf,
          autoSleepSeconds: opts.autoSleepSeconds,
        });
      });
      if (!started.ok) {
        // Tear down the session only if this child still owns it — a
        // NEWER session may have replaced `worker`, and this stale
        // failure path must not kill it.
        if (worker === child) stopSession();
        else child.kill();
        return started;
      }
      if (opts.dictationModel === 'large' && !largeModelPresent()) {
        started.largeDictationMissing = true;
      }
      if (largeUnsupported) started.largeDictationUnsupported = true;

      child.on('message', (m: { type: string; event?: unknown; level?: unknown }) => {
        if (sender.isDestroyed()) return;
        if (m.type === 'event') sender.send('voice:event', m.event);
        else if (m.type === 'level') sender.send('voice:level', m.level);
      });
      child.on('exit', (code) => {
        // Crash isolation: the editor survives; the session just ends —
        // and the renderer is TOLD, so it doesn't keep capturing into a
        // dead session with the pill stuck on "listening".
        if (worker === child) {
          console.error(`voice: worker exited (code ${code})`);
          if (!sender.isDestroyed()) {
            sender.send('voice:event', { kind: 'ended', reason: `recognizer exited (${code ?? '?'})` });
          }
          stopSession();
        }
      });
      const onGone = (): void => {
        if (ownerWebContentsId === sender.id) stopSession();
      };
      sender.once('destroyed', onGone);
      // Reload/navigation keeps the same webContents id but loses the
      // renderer-side session — without these the worker (and a loaded
      // multi-GB model) would run on with no consumer.
      sender.once('did-start-navigation', onGone);
      sender.once('render-process-gone', onGone);
      ownerCleanup = () => {
        sender.removeListener('destroyed', onGone);
        sender.removeListener('did-start-navigation', onGone);
        sender.removeListener('render-process-gone', onGone);
      };
      return started;
    },
  );

  ipcMain.handle('host:voice-stop', async (event) => {
    if (ownerWebContentsId === event.sender.id) stopSession();
  });

  // Fire-and-forget PCM stream — `send`, not `invoke`: no per-chunk
  // round-trip, and a dropped chunk costs ms of audio, not state.
  ipcMain.on('host:voice-audio', (event, chunk: ArrayBuffer) => {
    if (ownerWebContentsId !== event.sender.id || !worker) return;
    if (!(chunk instanceof ArrayBuffer)) return; // never crash the worker
    try {
      worker.send({ type: 'audio', chunk });
    } catch {
      // Worker exited between the null-check and the post — the exit
      // handler is about to clean up; dropping one chunk is fine.
    }
  });

  // True native key synthesis for voice "press <key>" — DOM-dispatched
  // KeyboardEvents are untrusted and can't drive default actions in
  // real inputs.
  const SEND_KEYS: Record<string, string> = {
    enter: 'Return', tab: 'Tab', escape: 'Escape', up: 'Up', down: 'Down',
    left: 'Left', right: 'Right', space: 'Space', backspace: 'Backspace',
  };
  ipcMain.handle('host:voice-send-key', async (event, key: string) => {
    if (ownerWebContentsId !== event.sender.id) return;
    const keyCode = SEND_KEYS[key];
    if (!keyCode) return;
    event.sender.sendInputEvent({ type: 'keyDown', keyCode });
    if (key === 'space') event.sender.sendInputEvent({ type: 'char', keyCode: ' ' });
    event.sender.sendInputEvent({ type: 'keyUp', keyCode });
  });

  ipcMain.handle('host:voice-set-vocabulary', async (event, docText: string) => {
    if (ownerWebContentsId !== event.sender.id || !worker) return;
    worker.send({ type: 'vocab', text: typeof docText === 'string' ? docText : '' });
  });

  ipcMain.handle('host:voice-dictation-model-info', async () => ({
    present: largeModelPresent(),
    downloading: downloadInFlight,
  }));

  ipcMain.handle('host:voice-download-dictation-model', async (event) =>
    downloadLargeModel(event.sender),
  );

  // Base recognition model (the one voice control needs to run) — a
  // first-use download, not a bundled asset.
  ipcMain.handle('host:voice-base-model-info', async () => ({
    present: baseModelPresent(),
    downloading: downloadInFlight,
  }));

  ipcMain.handle('host:voice-download-base-model', async (event) =>
    downloadBaseModel(event.sender),
  );

  // Delete installed models to reclaim disk space. Only the userData copy is
  // removed (a `--full` install's bundled `resources/voice/model` or a
  // CARDMIRROR_VOICE_DIR copy is not user-managed). Refused mid-download.
  // Safe while voice is running — the worker holds the model in memory; the
  // next `voiceStart` re-checks presence and offers a re-download if missing.
  ipcMain.handle('host:voice-delete-dictation-model', async () => {
    if (downloadInFlight) return { ok: false, error: 'A download is in progress.' };
    try {
      fs.rmSync(largeModelDir(), { recursive: true, force: true });
      // The bundled-Node runtime is fetched only for the large model — remove
      // it too so deleting actually frees the space it cost.
      fs.rmSync(path.join(app.getPath('userData'), 'voice-runtime'), {
        recursive: true,
        force: true,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('host:voice-delete-base-model', async () => {
    if (downloadInFlight) return { ok: false, error: 'A download is in progress.' };
    try {
      fs.rmSync(baseModelDir(), { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Native clipboard ops for voice editing verbs — webContents.copy/
  // cut/paste are the same paths as Mod-C/X/V, so ProseMirror slice
  // semantics and structural paste rules are inherited (spec §5).
  ipcMain.handle('host:voice-clipboard', async (event, op: 'copy' | 'cut' | 'paste') => {
    if (op === 'copy') event.sender.copy();
    else if (op === 'cut') event.sender.cut();
    else if (op === 'paste') event.sender.paste();
  });
}
