/**
 * Rooms-relay endpoint resolution, factored out of collab-ui so LIGHT
 * consumers (the invite seed prefetcher, fired from the always-loaded
 * Receive pill) can build a RoomsClient without pulling the Loro wasm
 * chunk. Resolution order: settings → dev env → baked desktop default
 * (same base + shared token card sharing uses).
 */

import { settings } from '../settings.js';
import { getElectronHost } from '../host/index.js';
import { collabDevRelay } from './collab-gate.js';
import { RoomsClient } from './room-client.js';

/** Baked relay endpoint from the desktop main process — resolved once,
 *  used as the LAST fallback so packaged builds work with zero setup.
 *  '' fields mean web edition / old preload / nothing baked. */
let bakedRelay: { url: string; token: string } | null = null;

export async function ensureBakedRelay(): Promise<void> {
  if (bakedRelay) return;
  try {
    bakedRelay = (await getElectronHost()?.collabRelayDefaults()) ?? { url: '', token: '' };
  } catch {
    bakedRelay = { url: '', token: '' };
  }
}

export function relayClient(): RoomsClient | null {
  const dev = collabDevRelay();
  const url = (
    settings.get('pairingRelayUrl').trim() ||
    dev?.url ||
    bakedRelay?.url ||
    ''
  ).replace(/\/+$/, '');
  const token = settings.get('pairingRelayToken').trim() || dev?.token || bakedRelay?.token || '';
  if (!url || !token) return null;
  return new RoomsClient({ baseUrl: () => url, token: () => token });
}
