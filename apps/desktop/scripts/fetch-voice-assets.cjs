#!/usr/bin/env node
/**
 * Fetch the voice recognition assets (libvosk + the lgraph model) into
 * resources/voice/ for electron-builder's extraResources. Idempotent —
 * skips anything already present. In the dev repo, the recognizer
 * spike's downloads act as a local cache (no network needed).
 *
 * Layout produced (matches voice/ipc.ts resolution):
 *   resources/voice/libvosk.{so,dylib,dll} (+ runtime DLLs on win32)
 *   resources/voice/model/                 (vosk-model-en-us-0.22-lgraph)
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VOSK_VERSION = '0.3.45';
// vosk stopped shipping prebuilt macOS binaries after 0.3.42 — there is
// no osx zip or macOS wheel for 0.3.45 on either GitHub or PyPI, so the
// darwin build pins to 0.3.42. Its libvosk.dylib is a universal2
// (arm64 + x86_64) binary, so it runs natively on both Apple Silicon and
// Intel, and its C API is compatible with the 0.22 model we ship.
const VOSK_MAC_VERSION = '0.3.42';
const MODEL_NAME = 'vosk-model-en-us-0.22-lgraph';
const MODEL_URL = `https://alphacephei.com/vosk/models/${MODEL_NAME}.zip`;

const PLATFORMS = {
  linux: { version: VOSK_VERSION, zip: `vosk-linux-x86_64-${VOSK_VERSION}.zip`, lib: 'libvosk.so' },
  darwin: { version: VOSK_MAC_VERSION, zip: `vosk-osx-${VOSK_MAC_VERSION}.zip`, lib: 'libvosk.dylib' },
  win32: { version: VOSK_VERSION, zip: `vosk-win64-${VOSK_VERSION}.zip`, lib: 'libvosk.dll' },
};

const plat = PLATFORMS[process.platform];
if (!plat) {
  console.error(`fetch-voice-assets: unsupported platform ${process.platform}`);
  process.exit(1);
}

const root = path.join(__dirname, '..');
const dest = path.join(root, 'resources', 'voice');
const destLib = path.join(dest, plat.lib);
const destModel = path.join(dest, 'model');
const spike = path.join(root, '..', '..', 'spikes', 'voice-recognizer');

fs.mkdirSync(dest, { recursive: true });

function extract(zipPath, into) {
  fs.mkdirSync(into, { recursive: true });
  try {
    execFileSync('unzip', ['-oq', zipPath, '-d', into], { stdio: 'inherit' });
  } catch {
    // Windows/macOS runners: bsdtar reads zip archives.
    execFileSync('tar', ['-xf', zipPath, '-C', into], { stdio: 'inherit' });
  }
}

async function download(url, to) {
  console.log(`fetch-voice-assets: downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

/** Copy every shared library from an extracted vosk dir (win32 ships
 *  companion runtime DLLs that must sit beside libvosk.dll). */
function copyLibs(fromDir) {
  for (const entry of fs.readdirSync(fromDir)) {
    if (/\.(so|dylib|dll)$/.test(entry)) {
      fs.copyFileSync(path.join(fromDir, entry), path.join(dest, entry));
    }
  }
}

async function ensureLib() {
  if (fs.existsSync(destLib)) return;
  const spikeLib = path.join(spike, 'lib', plat.lib);
  if (fs.existsSync(spikeLib)) {
    console.log('fetch-voice-assets: copying libvosk from spike cache');
    copyLibs(path.join(spike, 'lib'));
    return;
  }
  const url = `https://github.com/alphacep/vosk-api/releases/download/v${plat.version}/${plat.zip}`;
  const tmpZip = path.join(dest, '_lib.zip');
  const tmpDir = path.join(dest, '_lib');
  await download(url, tmpZip);
  extract(tmpZip, tmpDir);
  copyLibs(path.join(tmpDir, plat.zip.replace('.zip', '')));
  fs.rmSync(tmpZip);
  fs.rmSync(tmpDir, { recursive: true });
}

async function ensureModel() {
  if (fs.existsSync(path.join(destModel, 'graph'))) return;
  const spikeModel = path.join(spike, 'models', MODEL_NAME);
  if (fs.existsSync(spikeModel)) {
    console.log('fetch-voice-assets: copying model from spike cache');
    fs.cpSync(spikeModel, destModel, { recursive: true });
    return;
  }
  const tmpZip = path.join(dest, '_model.zip');
  const tmpDir = path.join(dest, '_model');
  await download(MODEL_URL, tmpZip);
  extract(tmpZip, tmpDir);
  fs.renameSync(path.join(tmpDir, MODEL_NAME), destModel);
  fs.rmSync(tmpZip);
  fs.rmSync(tmpDir, { recursive: true });
}

/** A real Node runtime for the voice worker: Electron's binary (any
 *  mode) uses Chromium's allocator, which SIGTRAPs loading the large
 *  dictation model. ~30 MB compressed, extracted to resources/voice. */
const NODE_VERSION = 'v22.12.0';
const NODE_PLATFORMS = {
  linux: { pkg: `node-${NODE_VERSION}-linux-x64.tar.gz`, bin: 'bin/node', out: 'node' },
  darwin: {
    pkg: `node-${NODE_VERSION}-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`,
    bin: 'bin/node',
    out: 'node',
  },
  win32: { pkg: `node-${NODE_VERSION}-win-x64.zip`, bin: 'node.exe', out: 'node.exe' },
};

async function ensureNode() {
  const nplat = NODE_PLATFORMS[process.platform];
  if (!nplat) return;
  const outPath = path.join(dest, nplat.out);
  if (fs.existsSync(outPath)) return;
  // Dev shortcut: reuse the system node binary when present (same
  // platform by definition).
  try {
    const { execSync } = require('node:child_process');
    const sys = execSync(process.platform === 'win32' ? 'where node' : 'command -v node', {
      encoding: 'utf8',
    }).trim().split('\n')[0];
    if (sys && fs.existsSync(sys)) {
      console.log('fetch-voice-assets: copying node runtime from system');
      fs.copyFileSync(fs.realpathSync(sys), outPath);
      fs.chmodSync(outPath, 0o755);
      return;
    }
  } catch { /* fall through to download */ }
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${nplat.pkg}`;
  const tmpPkg = path.join(dest, '_node_pkg');
  const tmpDir = path.join(dest, '_node');
  await download(url, tmpPkg);
  extract(tmpPkg, tmpDir);
  const inner = nplat.pkg.replace(/\.(tar\.gz|zip)$/, '');
  fs.copyFileSync(path.join(tmpDir, inner, nplat.bin), outPath);
  fs.chmodSync(outPath, 0o755);
  fs.rmSync(tmpPkg);
  fs.rmSync(tmpDir, { recursive: true });
}

(async () => {
  await ensureLib();
  await ensureModel();
  await ensureNode();
  console.log(`fetch-voice-assets: ready at ${dest}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
