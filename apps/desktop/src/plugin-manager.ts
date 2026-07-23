/**
 * Plugin install/update from GitHub releases (Obsidian model).
 * A plugin repo publishes two release assets: `cardmirror-plugin.json`
 * (manifest) and `plugin.js` (built bundle). Installed plugins live in
 * userData/plugins/<id>/ — one directory per plugin, next to the
 * legacy cardcutter.global.js FILE, which listInstalled skips.
 */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export const MANIFEST_NAME = 'cardmirror-plugin.json';
export const BUNDLE_NAME = 'plugin.js';
const PLUGIN_API_VERSION = 1; // keep in sync with src/editor/plugin-registry.ts
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_ID_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/i; // Windows device names
const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 MiB per release asset

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  apiVersion: number;
  minAppVersion?: string;
  /** Source repo ("owner/repo"), stamped at install time so update
   *  checks know where the plugin came from. */
  repo?: string;
}

export function parseRepoRef(input: string): { owner: string; repo: string } | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  let m = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m) {
    m = /^https:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(s);
  }
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

/** Semver-ish compare good enough for x.y.z and x.y.z-beta.N. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { main: number[]; pre: (number | string)[] | null } => {
    const [main = '', pre] = v.split('-', 2);
    return {
      main: main.split('.').map((n) => parseInt(n, 10) || 0),
      pre: pre === undefined ? null : pre.split('.').map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p)),
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.main[i] ?? 0) - (pb.main[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1; // release > prerelease
  if (pb.pre === null) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

export function validateManifest(
  obj: unknown,
): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  const m = obj as Partial<PluginManifest> | null;
  if (!m || typeof m !== 'object') return { ok: false, error: 'manifest is not an object' };
  if (typeof m.id !== 'string' || !ID_RE.test(m.id) || RESERVED_ID_RE.test(m.id)) {
    return { ok: false, error: 'bad plugin id' };
  }
  if (typeof m.name !== 'string' || !m.name) return { ok: false, error: 'missing name' };
  if (typeof m.version !== 'string' || !m.version) return { ok: false, error: 'missing version' };
  if (m.apiVersion !== PLUGIN_API_VERSION) {
    return { ok: false, error: `plugin needs apiVersion ${String(m.apiVersion)}; this CardMirror supports ${PLUGIN_API_VERSION}` };
  }
  return { ok: true, manifest: m as PluginManifest };
}

/**
 * Guard against id hijack: a second repo publishing a manifest with an
 * id already owned by an installed plugin would overwrite it. Returns an
 * error message to block, or null to allow. Same-repo reinstall (the
 * update path) is allowed; a missing stored repo on the existing install
 * (pre-repo-field manifests) can't be proven to match, so it blocks —
 * uninstall + reinstall is the recovery.
 */
export function checkInstallCollision(
  existing: PluginManifest | undefined,
  ref: string,
): string | null {
  if (!existing) return null;
  if (existing.repo && existing.repo === ref) return null;
  return `A different plugin ("${existing.repo ?? 'unknown source'}") already owns the id "${existing.id}". Uninstall it first.`;
}

async function readInstalledManifest(id: string): Promise<PluginManifest | undefined> {
  try {
    const raw = await fs.readFile(path.join(pluginDir(id), MANIFEST_NAME), 'utf8');
    const v = validateManifest(JSON.parse(raw));
    return v.ok ? v.manifest : undefined;
  } catch {
    return undefined;
  }
}

function pluginsRootDir(): string {
  return path.join(app.getPath('userData'), 'plugins');
}
function pluginDir(id: string): string {
  return path.join(pluginsRootDir(), id);
}

interface GithubAsset { name: string; browser_download_url: string; }
interface GithubRelease { tag_name: string; assets: GithubAsset[]; }

async function fetchLatestRelease(owner: string, repo: string): Promise<GithubRelease | null> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cardmirror' },
  });
  if (!res.ok) return null;
  return (await res.json()) as GithubRelease;
}

async function downloadAsset(release: GithubRelease, name: string): Promise<string | null> {
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) return null;
  const res = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'cardmirror' },
  });
  if (!res.ok) return null;
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) return null;
  const text = await res.text();
  if (text.length > MAX_ASSET_BYTES) return null;
  return text;
}

export async function installFromGithub(
  ref: string,
): Promise<{ ok: true; plugin: PluginManifest } | { ok: false; error: string }> {
  const parsed = parseRepoRef(ref);
  if (!parsed) return { ok: false, error: 'Enter a GitHub URL or owner/repo.' };
  let release: GithubRelease | null;
  try {
    release = await fetchLatestRelease(parsed.owner, parsed.repo);
  } catch {
    return { ok: false, error: 'Could not reach GitHub.' };
  }
  if (!release) return { ok: false, error: 'No releases found for that repository.' };
  const manifestText = await downloadAsset(release, MANIFEST_NAME).catch(() => null);
  const bundleText = await downloadAsset(release, BUNDLE_NAME).catch(() => null);
  if (!manifestText || !bundleText) {
    return { ok: false, error: `The latest release must attach ${MANIFEST_NAME} and ${BUNDLE_NAME}.` };
  }
  let manifestObj: unknown;
  try {
    manifestObj = JSON.parse(manifestText);
  } catch {
    return { ok: false, error: `${MANIFEST_NAME} is not valid JSON.` };
  }
  const v = validateManifest(manifestObj);
  if (!v.ok) return { ok: false, error: v.error };
  if (v.manifest.minAppVersion && compareVersions(app.getVersion(), v.manifest.minAppVersion) < 0) {
    return { ok: false, error: `This plugin needs CardMirror ${v.manifest.minAppVersion} or newer.` };
  }
  const ownerRepo = `${parsed.owner}/${parsed.repo}`;
  const collision = checkInstallCollision(await readInstalledManifest(v.manifest.id), ownerRepo);
  if (collision) return { ok: false, error: collision };
  // Persist the source repo so checkPluginUpdate (and the settings UI)
  // know where this install came from. Written into the saved manifest,
  // not just returned — the info must survive an app restart.
  v.manifest.repo = ownerRepo;
  const savedManifestText = JSON.stringify(v.manifest, null, 2);
  const dir = pluginDir(v.manifest.id);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, text] of [
    [MANIFEST_NAME, savedManifestText],
    [BUNDLE_NAME, bundleText],
  ] as const) {
    const finalPath = path.join(dir, name);
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, text);
    await fs.rename(tmpPath, finalPath);
  }
  return { ok: true, plugin: v.manifest };
}

export async function listInstalled(): Promise<PluginManifest[]> {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await fs.readdir(pluginsRootDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: PluginManifest[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue; // skips cardcutter.global.js
    try {
      const raw = await fs.readFile(path.join(pluginsRootDir(), e.name, MANIFEST_NAME), 'utf8');
      const v = validateManifest(JSON.parse(raw));
      if (!v.ok || v.manifest.id !== e.name) continue;
      // The version gate applies at load too, not just install: an app
      // downgrade must not boot a plugin built for a newer CardMirror.
      // ponytail: incompatible installs hidden, not listed as disabled
      if (v.manifest.minAppVersion && compareVersions(app.getVersion(), v.manifest.minAppVersion) < 0) {
        console.warn(`[plugins] ${e.name} needs CardMirror ${v.manifest.minAppVersion}; skipping`);
        continue;
      }
      out.push(v.manifest);
    } catch {
      /* skip broken installs */
    }
  }
  return out;
}

export async function readPluginSource(id: string): Promise<string | null> {
  if (!ID_RE.test(id)) return null;
  try {
    return await fs.readFile(path.join(pluginDir(id), BUNDLE_NAME), 'utf8');
  } catch {
    return null;
  }
}

export async function uninstallPlugin(id: string): Promise<void> {
  if (!ID_RE.test(id)) return;
  await fs.rm(pluginDir(id), { recursive: true, force: true });
}

export async function checkPluginUpdate(
  id: string,
  repoRef: string,
): Promise<{ ok: true; current: string; latest: string; hasUpdate: boolean } | { ok: false; error: string }> {
  const installed = (await listInstalled()).find((p) => p.id === id);
  if (!installed) return { ok: false, error: 'not installed' };
  const parsed = parseRepoRef(repoRef);
  if (!parsed) return { ok: false, error: 'bad repo ref' };
  let release: GithubRelease | null;
  try {
    release = await fetchLatestRelease(parsed.owner, parsed.repo);
  } catch {
    return { ok: false, error: 'Could not reach GitHub.' };
  }
  if (!release) return { ok: false, error: 'No releases found.' };
  const manifestText = await downloadAsset(release, MANIFEST_NAME).catch(() => null);
  if (!manifestText) return { ok: false, error: 'Release has no manifest.' };
  try {
    const latest = (JSON.parse(manifestText) as PluginManifest).version;
    return {
      ok: true,
      current: installed.version,
      latest,
      hasUpdate: compareVersions(latest, installed.version) > 0,
    };
  } catch {
    return { ok: false, error: 'Bad manifest in release.' };
  }
}
