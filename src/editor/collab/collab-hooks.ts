/**
 * Zero-dependency seams between the always-loaded editor core and the
 * lazily-loaded collab module (which pulls in the Loro wasm — never on
 * the startup path).
 *
 * The transaction tagger runs inside `dispatchTransaction` BEFORE
 * `state.apply`, so metas it sets are visible to every
 * `filterTransaction` (read mode, AI edit coordinator). The active
 * collab module registers a tagger that stamps the sync-origin meta on
 * the Loro binding's remote transactions; with no session active this
 * is a null-check per dispatch.
 *
 * The plugin source lets `buildEditorPlugins` include a live session's
 * binding plugins, and signals that the session owns undo (the CRDT
 * undo manager reverts only this peer's edits — prosemirror-history
 * cannot guarantee that once remote transactions interleave).
 */

import type { Command, Plugin, Transaction } from 'prosemirror-state';

export interface CollabPluginSource {
  /** Binding plugins for the active session (sync, undo, cursors). */
  plugins(): Plugin[];
  /** True while the session owns undo — `history()` is excluded and
   *  Mod-Z / Mod-Y route to `undo` / `redo` below. */
  ownsUndo(): boolean;
  undo: Command;
  redo: Command;
}

let tagger: ((tr: Transaction) => void) | null = null;
let pluginSource: CollabPluginSource | null = null;

export function setCollabTransactionTagger(fn: ((tr: Transaction) => void) | null): void {
  tagger = fn;
}

/** Called from dispatchTransaction on every tr; no-op when dormant. */
export function tagCollabTransaction(tr: Transaction): void {
  tagger?.(tr);
}

export function setCollabPluginSource(src: CollabPluginSource | null): void {
  pluginSource = src;
}

export function collabPluginSource(): CollabPluginSource | null {
  return pluginSource;
}

/** Invite-join seam: the Receive pill (always-loaded pairing UI) hands a
 *  share code from a `room-invite` inbox item to the lazily-loaded collab
 *  module. Registered from editor/index.ts alongside the other collab
 *  ribbon wiring; null while the collab gate is closed. */
let inviteJoiner: ((shareCode: string) => void) | null = null;

export function setCollabInviteJoiner(fn: ((shareCode: string) => void) | null): void {
  inviteJoiner = fn;
}

export function collabInviteJoiner(): ((shareCode: string) => void) | null {
  return inviteJoiner;
}
