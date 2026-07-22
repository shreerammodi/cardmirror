/**
 * Per-plugin enabled flags — localStorage blob, pins-store style.
 * Install state (which plugins exist) lives on disk with main; this
 * store only remembers which ones the user switched on.
 */
const STORAGE_KEY = 'pmd-plugins';

interface PluginsBlob {
  enabled: Record<string, boolean>;
}

function read(): PluginsBlob {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PluginsBlob>;
      if (parsed && typeof parsed === 'object' && parsed.enabled && typeof parsed.enabled === 'object') {
        return { enabled: parsed.enabled };
      }
    }
  } catch {
    /* fall through */
  }
  return { enabled: {} };
}

function write(blob: PluginsBlob): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  } catch {
    /* quota — non-fatal */
  }
}

export function isPluginEnabled(id: string): boolean {
  return read().enabled[id] === true;
}

export function setPluginEnabled(id: string, on: boolean): void {
  const blob = read();
  blob.enabled[id] = on;
  write(blob);
}
