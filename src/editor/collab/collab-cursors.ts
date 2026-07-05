/**
 * Presence cursors (M4, in v1 by decision) + AI-lease advertisement.
 *
 * Transport: the room's presence channel — encrypted fan-out frames the
 * relay never stores (hot path at cursor-move rates; a lost frame just
 * means a briefly stale cursor). Every frame carries a 1-byte type:
 *
 *   0x01  loro EphemeralStore bytes — partner cursor/selection state.
 *         loro-prosemirror's cursor plugin does all the hard parts
 *         (PM selection → stable loro cursors → decorations); we only
 *         pipe its store's local updates out and apply remote bytes in.
 *   0x02  lease advertisement JSON — "AI is editing here" (§4.6,
 *         NON-enforcing). Raw PM positions, valid when converged and
 *         advisory always: the partner maps them through local edits
 *         and repaints on each re-broadcast (every LEASE_MS while any
 *         lease is held, cleared when none are).
 *
 * Throttling: local cursor updates coalesce to ≤1 frame per
 * CURSOR_THROTTLE_MS (trailing edge, so the final resting position
 * always ships). A 15s keepalive re-broadcast defeats the ephemeral
 * store's timeout while the user reads without moving the caret.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import { CursorEphemeralStore, LoroEphemeralCursorPlugin } from 'loro-prosemirror';
import type { PeerID } from 'loro-crdt';
import { settings } from '../settings.js';
import type { CollabSession } from './collab-session.js';
import { leasedRanges } from '../ai/edit-coordinator.js';

const FRAME_CURSOR = 0x01;
const FRAME_LEASE = 0x02;
const CURSOR_THROTTLE_MS = 120;
const KEEPALIVE_MS = 15_000;
const LEASE_MS = 2_000;
const STORE_TIMEOUT_MS = 45_000;

/** Deterministic per-peer cursor color: readable on light and dark
 *  themes (fixed S/L, hue from the peer id). */
export function peerColor(peerId: string): string {
  let h = 0;
  for (const ch of peerId) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 70%, 45%)`;
}

function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

interface LeaseAd {
  /** Sender's loro peer id — the receiver drops its own echoes (the
   *  relay's presence fan-out includes the poster's own stream). */
  peer: string;
  /** Sender's display name for the tag ("Priya's AI"). */
  name: string;
  ranges: { from: number; to: number; label: string }[];
}

const leaseAdsKey = new PluginKey<DecorationSet>('collab-lease-ads');

export interface CursorsHandle {
  /** Session plugins: the stock cursor plugin + the lease-ad renderer. */
  plugins(): Plugin[];
  /** Feed an incoming (decrypted) presence frame. */
  applyRemote(bytes: Uint8Array): void;
  /** Peer ids currently visible in the presence store (self excluded).
   *  Best-effort: with cursors disabled nothing broadcasts, so this
   *  goes empty — callers must degrade safely (the repair leader gate
   *  falls back to everyone-repairs, which idempotence makes safe). */
  visiblePeers(): string[];
  dispose(): void;
}

export function installCursorPresence(
  session: CollabSession,
  getView: () => EditorView | null,
): CursorsHandle {
  const peerId = session.loroDoc.peerIdStr as PeerID;
  const store = new CursorEphemeralStore(peerId, STORE_TIMEOUT_MS);
  let disposed = false;

  // --- outbound: cursor bytes, throttled trailing-edge ---
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingBytes: Uint8Array | null = null;
  const unsubLocal = store.subscribeLocalUpdates((bytes: Uint8Array) => {
    if (disposed || !cursorsEnabled()) return;
    pendingBytes = bytes;
    sendTimer ??= setTimeout(() => {
      sendTimer = null;
      if (pendingBytes && !disposed) void session.sendPresence(frame(FRAME_CURSOR, pendingBytes));
      pendingBytes = null;
    }, CURSOR_THROTTLE_MS);
  });

  // Keepalive: the store expires idle entries; a reading (not typing)
  // partner must not vanish. Re-setting the local state re-emits it.
  const keepalive = setInterval(() => {
    if (disposed || !cursorsEnabled()) return;
    const local = store.getLocal();
    if (local) store.setLocal(local);
  }, KEEPALIVE_MS);

  const user = {
    name: settings.get('pairingDisplayName').trim() || 'Partner',
    color: peerColor(peerId),
  };

  // --- outbound: lease ads on a slow heartbeat ---
  let lastLeaseCount = 0;
  const leaseTimer = setInterval(() => {
    if (disposed) return;
    const view = getView();
    if (!view) return;
    const ranges = leasedRanges(view.state).map((r) => ({ ...r, label: 'AI' }));
    if (ranges.length === 0 && lastLeaseCount === 0) return; // nothing, and nothing to clear
    lastLeaseCount = ranges.length;
    const ad: LeaseAd = { peer: peerId, name: user.name, ranges };
    void session.sendPresence(frame(FRAME_LEASE, new TextEncoder().encode(JSON.stringify(ad))));
  }, LEASE_MS);

  // --- inbound lease rendering ---
  const applyLeaseAd = (ad: LeaseAd): void => {
    // The relay fans presence back to the poster's own stream — the
    // sender must not render its own advertisement on top of the real
    // local AI-working box (field: "partner's AI" on the running machine).
    if (ad.peer === peerId) return;
    const view = getView();
    if (!view || view.isDestroyed) return;
    const who = (ad.name || 'Partner').trim() || 'Partner';
    const decos = ad.ranges
      .filter((r) => r.from >= 0 && r.to > r.from && r.to <= view.state.doc.content.size)
      .flatMap((r) => [
        Decoration.inline(r.from, r.to, { class: 'pmd-collab-lease-ad' }),
        Decoration.widget(r.from, () => {
          const tag = document.createElement('span');
          tag.className = 'pmd-collab-lease-ad-tag';
          tag.textContent = `✦ ${who}'s ${r.label}`;
          return tag;
        }),
      ]);
    const tr = view.state.tr.setMeta(leaseAdsKey, DecorationSet.create(view.state.doc, decos));
    view.dispatch(tr);
  };

  const leaseAdsPlugin = new Plugin<DecorationSet>({
    key: leaseAdsKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, prev) {
        const next = tr.getMeta(leaseAdsKey) as DecorationSet | undefined;
        if (next) return next;
        // Advisory ranges ride along with local edits between
        // re-broadcasts; each fresh ad replaces them wholesale.
        return prev.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return leaseAdsKey.getState(state);
      },
    },
  });

  return {
    plugins(): Plugin[] {
      if (!cursorsEnabled()) return [leaseAdsPlugin];
      return [
        LoroEphemeralCursorPlugin(store, {
          user,
          // Per-peer selection tint (the stock default is one fixed
          // yellow for everyone).
          createSelection: (peer) => ({
            class: 'loro-selection',
            style: `background-color: ${peerColor(peer).replace(')', ', 0.22)').replace('hsl', 'hsla')}`,
          }),
        }),
        leaseAdsPlugin,
      ];
    },
    visiblePeers(): string[] {
      try {
        return Object.keys(store.getAllStates()).filter((p) => p !== peerId);
      } catch {
        return [];
      }
    },
    applyRemote(bytes: Uint8Array): void {
      if (disposed || bytes.length < 2) return;
      const type = bytes[0];
      const payload = bytes.subarray(1);
      if (type === FRAME_CURSOR) {
        try {
          store.apply(payload); // expiry is the store's own timer
        } catch {
          /* malformed/foreign frame — drop */
        }
      } else if (type === FRAME_LEASE) {
        try {
          applyLeaseAd(JSON.parse(new TextDecoder().decode(payload)) as LeaseAd);
        } catch {
          /* malformed — drop */
        }
      }
    },
    dispose(): void {
      disposed = true;
      unsubLocal();
      clearInterval(keepalive);
      clearInterval(leaseTimer);
      if (sendTimer) clearTimeout(sendTimer);
    },
  };
}

function cursorsEnabled(): boolean {
  return settings.get('collabShowCursors');
}
