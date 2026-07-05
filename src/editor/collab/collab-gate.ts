/**
 * Collaboration-session feature gate. DORMANT BY DEFAULT.
 *
 * Co-editing is a DESKTOP-ONLY feature. The web edition categorically
 * has no server-dependent capabilities, so the gate is hard-closed on
 * a browser host before any flag is consulted — neither the build-time
 * `VITE_COLLAB` nor the runtime `localStorage['pmd-collab']` flip can
 * open it in the browser. (A future Tauri desktop host reports a
 * non-`browser` kind and is treated like Electron.)
 *
 * On a desktop host, enablement is still deliberately unreachable for
 * packaged release builds:
 *   - dev/build: `VITE_COLLAB=1` in the environment at vite time, or
 *   - a manual `localStorage['pmd-collab'] = '1'` console flip.
 * Flipping the feature on for a release is a code change here (the
 * same posture as the pairing entitlement flag: an env var cannot
 * reach a packaged app).
 *
 * Zero heavy imports — this module is consulted from the main editor
 * path; `host` is already on that path (types-only wrappers), and
 * everything Loro/collab loads lazily only after the gate opens.
 */

import { getHost } from '../host/index.js';

export function collabEnabled(): boolean {
  // Web edition: no server-dependent capabilities, period. This is the
  // categorical guarantee — no build-time or runtime flag overrides it.
  try {
    if (getHost().kind === 'browser') return false;
  } catch {
    /* no host resolvable → treat as not-desktop, stay closed */
    return false;
  }
  try {
    if ((import.meta as { env?: Record<string, string> }).env?.['VITE_COLLAB'] === '1') return true;
  } catch {
    /* no import.meta.env outside vite */
  }
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('pmd-collab') === '1';
  } catch {
    return false;
  }
}

/** Dev-only relay config injected at vite build time, so the web dev
 *  build can reach a rooms-capable relay without the Electron-only
 *  Card Sharing settings fields. Falls through (null) in packaged
 *  builds, where the vars are never set. */
export function collabDevRelay(): { url: string; token: string } | null {
  try {
    const env = (import.meta as { env?: Record<string, string> }).env;
    const url = (env?.['VITE_COLLAB_RELAY'] ?? '').trim();
    const token = (env?.['VITE_COLLAB_TOKEN'] ?? '').trim();
    if (url && token) return { url, token };
  } catch {
    /* no import.meta.env outside vite */
  }
  return null;
}
