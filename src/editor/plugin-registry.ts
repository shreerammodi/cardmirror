/**
 * Plugin registry — the only place plugin bundles register. A bundle
 * (loaded by the desktop host) calls `window.__registerCardMirrorPlugin`
 * with a versioned definition; the registry validates it, mints the
 * plugin's capability api object, and indexes its commands so the
 * ribbon/palette/keymap chokepoints can find them. Card-cutter-port
 * precedent: if nothing registers, everything stays inert.
 */
import { showToast } from './toast.js';
import type { CardMirrorPluginApi } from './plugin-api.js';

export const PLUGIN_API_VERSION = 1;

export interface PluginCommandDef {
  /** Must start with `<pluginId>.` */
  id: string;
  label: string;
  keywords?: readonly string[];
  defaultKey?: string | string[] | null;
  run: (api: CardMirrorPluginApi) => void | Promise<void>;
}

export interface PluginDefinition {
  id: string;
  name: string;
  apiVersion: number;
  commands: PluginCommandDef[];
}

declare global {
  interface Window {
    __registerCardMirrorPlugin?: (def: PluginDefinition) => void;
  }
}

interface RegisteredPlugin {
  def: PluginDefinition;
  api: CardMirrorPluginApi;
}

const plugins = new Map<string, RegisteredPlugin>();
const commands = new Map<string, { pluginId: string; cmd: PluginCommandDef }>();
let makeApi: ((pluginId: string) => CardMirrorPluginApi) | null = null;

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function registerPluginDefinition(
  def: PluginDefinition,
): { ok: true } | { ok: false; error: string } {
  if (!makeApi) return { ok: false, error: 'plugin system not initialized' };
  if (!def || typeof def !== 'object') return { ok: false, error: 'bad definition' };
  if (typeof def.id !== 'string' || !def.id) return { ok: false, error: 'missing plugin id' };
  if (!PLUGIN_ID_RE.test(def.id)) return { ok: false, error: `invalid plugin id "${def.id}"` };
  if (typeof def.name !== 'string' || !def.name) return { ok: false, error: 'missing plugin name' };
  if (def.apiVersion !== PLUGIN_API_VERSION) {
    return {
      ok: false,
      error: `unsupported apiVersion ${String(def.apiVersion)} (this CardMirror supports ${PLUGIN_API_VERSION})`,
    };
  }
  // Ids this plugin already owns — so a re-registration (e.g. re-enable
  // re-runs the bundle) doesn't trip the global command-collision check
  // against its own previously-registered commands.
  const ownIds = new Set(
    [...commands.entries()].filter(([, e]) => e.pluginId === def.id).map(([id]) => id),
  );
  const raw = def.commands;
  const cmds = Array.isArray(raw) ? [...raw] : null;
  if (!cmds) return { ok: false, error: 'commands must be an array' };
  const seen = new Set<string>();
  const snapshots: PluginCommandDef[] = [];
  const prefix = `${def.id}.`;
  for (const c of cmds) {
    // Read every field exactly once — a stateful getter must not be able
    // to pass validation with one value and register a different one.
    const { id, label, keywords, defaultKey, run } = c;
    if (typeof id !== 'string' || !id.startsWith(prefix) || id.length === prefix.length) {
      return { ok: false, error: `command id "${String(id)}" must start with "${prefix}"` };
    }
    if (typeof label !== 'string' || !label) {
      return { ok: false, error: `command "${id}" has no label` };
    }
    if (typeof run !== 'function') {
      return { ok: false, error: `command "${id}" has no run function` };
    }
    if (keywords !== undefined && !isStringArray(keywords)) {
      return { ok: false, error: `command "${id}" has invalid keywords` };
    }
    if (
      defaultKey !== undefined &&
      defaultKey !== null &&
      typeof defaultKey !== 'string' &&
      !isStringArray(defaultKey)
    ) {
      return { ok: false, error: `command "${id}" has invalid defaultKey` };
    }
    if ((commands.has(id) && !ownIds.has(id)) || seen.has(id)) {
      return { ok: false, error: `command id "${id}" already registered` };
    }
    seen.add(id);
    snapshots.push({ id, label, keywords, defaultKey, run });
  }
  if (plugins.has(def.id)) {
    // Already registered: an identical command-id list is a silent no-op
    // success (the re-enable path); any difference still rejects.
    const same = seen.size === ownIds.size && [...seen].every((id) => ownIds.has(id));
    if (same) return { ok: true };
    return { ok: false, error: `plugin "${def.id}" already registered` };
  }
  const api = makeApi(def.id);
  plugins.set(def.id, { def, api });
  for (const c of snapshots) commands.set(c.id, { pluginId: def.id, cmd: c });
  return { ok: true };
}

/** Install the window global. `createApi` mints one capability object
 *  per plugin id (dependency-injected so tests can stub it). */
export function installPluginRegistry(
  createApi: (pluginId: string) => CardMirrorPluginApi,
): void {
  makeApi = createApi;
  window.__registerCardMirrorPlugin = (def) => {
    const res = registerPluginDefinition(def);
    if (res.ok) {
      const count = [...commands.values()].filter((c) => c.pluginId === def.id).length;
      console.log(`[plugins] registered ${def.id} (${count} commands)`);
    } else {
      console.warn(`[plugins] registration rejected: ${res.error}`);
      showToast(`Plugin failed to load: ${res.error}`);
    }
  };
}

export function pluginCommandIds(): string[] {
  return [...commands.keys()];
}
export function isPluginCommandId(id: string): boolean {
  return commands.has(id);
}
export function pluginCommandLabel(id: string): string | null {
  return commands.get(id)?.cmd.label ?? null;
}
export function pluginCommandKeywords(id: string): readonly string[] {
  return commands.get(id)?.cmd.keywords ?? [];
}
export function pluginDefaultKey(id: string): string | string[] | null {
  return commands.get(id)?.cmd.defaultKey ?? null;
}

/** Run a plugin command by id. Never throws: sync and async failures
 *  both log and toast with the plugin's name. */
export function runPluginCommand(id: string): boolean {
  const entry = commands.get(id);
  if (!entry) return false;
  const plugin = plugins.get(entry.pluginId);
  if (!plugin) return false;
  const report = (err: unknown): void => {
    console.error(`[plugins] ${id} failed:`, err);
    const message = err instanceof Error ? err.message : String(err);
    showToast(`${plugin.def.name}: command failed — ${message}`);
  };
  try {
    const r = entry.cmd.run(plugin.api);
    if (r && typeof (r as Promise<void>).catch === 'function') {
      void (r as Promise<void>).catch(report);
    }
  } catch (err) {
    report(err);
  }
  return true;
}

export function registeredPlugins(): { id: string; name: string }[] {
  return [...plugins.values()].map((p) => ({ id: p.def.id, name: p.def.name }));
}

export function resetPluginRegistryForTests(): void {
  plugins.clear();
  commands.clear();
  makeApi = null;
  if (typeof window !== 'undefined') delete window.__registerCardMirrorPlugin;
}
