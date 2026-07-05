/**
 * Relay broker — the outgoing side of cross-machine card sharing.
 *
 * Transport-agnostic by design: in desktop v1 it hands the send to the
 * Electron main process (which holds the relay URL + token and does the
 * actual POSTs — one per recipient), so no secret ever reaches a
 * renderer. The web edition (deferred) would POST directly from here;
 * the seam is left in place so that drops in without a caller rewrite.
 *
 * Receiving is NOT here — it's driven by the main-process poller, which
 * feeds the inbox store (`inbox-store.ts`) via `pairing:inbox-changed`.
 */

import { getElectronHost } from '../host/index.js';

/** The minimal card shape sent over the wire — the dropzone's existing
 *  serialized slice plus a label and node kind. */
export interface SendItem {
  label: string;
  type: string;
  /** `Slice.toJSON()` — carries inline base64 images already. */
  sliceJson: unknown;
}

export interface SendResult {
  /** Recipients the relay accepted. */
  ok: number;
  /** Recipients that failed (network / relay error). */
  fail: number;
}

class RelayClient {
  /** Whether sending is possible right now (desktop + a configured main
   *  poller). The send pill also gates on having partners. */
  canSend(): boolean {
    const electron = getElectronHost();
    return !!electron?.pairingSend;
  }

  /** Push one card to each recipient code. Returns per-recipient tallies
   *  so the caller can confirm a real delivery before flashing "sent".
   *  `minReceiverVersion` overrides the config-level compatibility floor
   *  for THIS message — item types newer than the card format (session
   *  invites) declare the version that understands them. */
  async send(
    recipientCodes: string[],
    item: SendItem,
    opts?: { via?: string; minReceiverVersion?: string },
  ): Promise<SendResult> {
    const targets = Array.from(new Set(recipientCodes.filter(Boolean)));
    if (targets.length === 0) return { ok: 0, fail: 0 };

    const electron = getElectronHost();
    if (!electron?.pairingSend) {
      // Web edition has no main-process sender yet (deferred).
      return { ok: 0, fail: targets.length };
    }
    try {
      const res = await electron.pairingSend({
        recipientCodes: targets,
        item,
        via: opts?.via,
        minReceiverVersion: opts?.minReceiverVersion,
      });
      return { ok: res?.ok ?? 0, fail: res?.fail ?? 0 };
    } catch {
      return { ok: 0, fail: targets.length };
    }
  }
}

export const relayClient = new RelayClient();
