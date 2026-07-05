// @vitest-environment jsdom
/**
 * The categorical guarantee: co-editing is desktop-only. On a browser
 * host the gate is hard-closed BEFORE any flag is read, so neither the
 * build-time `VITE_COLLAB` nor the runtime `localStorage['pmd-collab']`
 * console flip can turn on a server-dependent capability in the web
 * edition. On a desktop host the existing dormant-by-default posture is
 * unchanged (flag required).
 *
 * getHost() caches the resolved host at module scope, so each case
 * resets the module registry and re-imports the gate with the desired
 * `window.electronAPI` presence already in place.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

type WinStub = { electronAPI?: unknown };

async function loadGate(): Promise<() => boolean> {
  vi.resetModules();
  const mod = await import('../../src/editor/collab/collab-gate.js');
  return mod.collabEnabled;
}

afterEach(() => {
  delete (window as unknown as WinStub).electronAPI;
  localStorage.removeItem('pmd-collab');
  vi.unstubAllEnvs();
});

describe('collabEnabled — categorical web disable', () => {
  it('browser host + localStorage flip → still disabled', async () => {
    delete (window as unknown as WinStub).electronAPI; // browser host
    localStorage.setItem('pmd-collab', '1');
    expect((await loadGate())()).toBe(false);
  });

  it('browser host + VITE_COLLAB=1 → still disabled', async () => {
    delete (window as unknown as WinStub).electronAPI;
    vi.stubEnv('VITE_COLLAB', '1');
    expect((await loadGate())()).toBe(false);
  });

  it('desktop host + localStorage flip → enabled', async () => {
    (window as unknown as WinStub).electronAPI = {}; // Electron host
    localStorage.setItem('pmd-collab', '1');
    expect((await loadGate())()).toBe(true);
  });

  it('desktop host + no flag → disabled (dormant by default)', async () => {
    (window as unknown as WinStub).electronAPI = {};
    localStorage.removeItem('pmd-collab');
    expect((await loadGate())()).toBe(false);
  });
});
