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

export function registerPluginDefinition(
  def: PluginDefinition,
): { ok: true } | { ok: false; error: string } {
  if (!makeApi) return { ok: false, error: 'plugin system not initialized' };
  if (!def || typeof def !== 'object') return { ok: false, error: 'bad definition' };
  if (typeof def.id !== 'string' || !def.id) return { ok: false, error: 'missing plugin id' };
  if (def.apiVersion !== PLUGIN_API_VERSION) {
    return {
      ok: false,
      error: `unsupported apiVersion ${String(def.apiVersion)} (this CardMirror supports ${PLUGIN_API_VERSION})`,
    };
  }
  if (plugins.has(def.id)) return { ok: false, error: `plugin "${def.id}" already registered` };
  if (!Array.isArray(def.commands)) return { ok: false, error: 'commands must be an array' };
  for (const c of def.commands) {
    if (typeof c.id !== 'string' || !c.id.startsWith(`${def.id}.`)) {
      return { ok: false, error: `command id "${String(c.id)}" must start with "${def.id}."` };
    }
    if (typeof c.label !== 'string' || !c.label) {
      return { ok: false, error: `command "${c.id}" has no label` };
    }
    if (typeof c.run !== 'function') {
      return { ok: false, error: `command "${c.id}" has no run function` };
    }
    if (commands.has(c.id)) return { ok: false, error: `command id "${c.id}" already registered` };
  }
  const api = makeApi(def.id);
  plugins.set(def.id, { def, api });
  for (const c of def.commands) commands.set(c.id, { pluginId: def.id, cmd: c });
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
      console.log(`[plugins] registered ${def.id} (${def.commands.length} commands)`);
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
    showToast(`${plugin.def.name}: command failed — ${(err as Error).message}`);
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
