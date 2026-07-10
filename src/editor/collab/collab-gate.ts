/**
 * Collaboration-session feature gate.
 *
 * Co-editing is a DESKTOP-ONLY feature: the web edition categorically has
 * no server-dependent capabilities, so the gate stays hard-closed on a
 * browser host. On any desktop host — Electron, or a future non-`browser`
 * kind like Tauri — co-editing is ON by default.
 *
 * (It was dormant behind the build-time `VITE_COLLAB` flag / the runtime
 * `localStorage['pmd-collab']` console flip while the feature was in
 * development; those toggles are gone now that it ships enabled.)
 *
 * Zero heavy imports — this module is consulted from the main editor
 * path; `host` is already on that path (types-only wrappers), and
 * everything Loro/collab loads lazily only after the gate opens.
 */

import { getHost } from '../host/index.js';

export function collabEnabled(): boolean {
  // On desktop (Electron / a future non-browser host) co-editing is on; the
  // web edition has no server-dependent capabilities, so it stays off there.
  // This browser exclusion is the categorical guarantee.
  try {
    return getHost().kind !== 'browser';
  } catch {
    /* no host resolvable → treat as not-desktop, stay closed */
    return false;
  }
}

/** Dev-only relay config injected at vite build time, so the web dev
 *  build can reach a rooms-capable relay without the Electron-only
 *  Collaboration settings fields. Falls through (null) in packaged
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
