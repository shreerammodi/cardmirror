/**
 * ElectronHost — the Host implementation for the Electron desktop
 * wrapper. Delegates every operation to the main process via the
 * preload-exposed `window.electronAPI`. The renderer never touches
 * Node directly; the bridge is intentionally narrow.
 *
 * Handles are plain strings (absolute file paths) — structured-clone
 * across IPC, no serialization tricks needed.
 */

import type {
  FileFilter,
  Host,
  JournalEntry,
  OpenFileOptions,
  OpenedFile,
  SaveAsOptions,
  SaveResult,
  SpawnWindowPayload,
} from './types.js';

/** The shape we expect the preload script to expose. Defined here
 *  (and not imported from the desktop workspace) so the editor
 *  doesn't take a build-time dependency on Electron-specific code. */
interface ElectronAPI {
  openFile(opts: { filters: FileFilter[] }): Promise<{
    name: string;
    bytes: Uint8Array;
    handle: string;
  } | null>;
  saveAs(
    suggestedName: string,
    bytes: Uint8Array,
    opts: { filters: FileFilter[] },
  ): Promise<{ name: string; handle: string } | null>;
  saveExisting(handle: string, bytes: Uint8Array): Promise<void>;
  writeJournal(entry: JournalEntry): Promise<void>;
  readJournals(): Promise<JournalEntry[]>;
  deleteJournal(uid: string): Promise<void>;
  spawnWindow(payload: SpawnWindowPayload | null): Promise<void>;
  getInitialDoc(): Promise<SpawnWindowPayload | null>;
  journalAndCloseOtherWindows(): Promise<void>;
  closeSelf(): Promise<void>;
  onPleaseCloseForModeSwitch(handler: () => void): () => void;
  /** Subscribe to menu-driven commands from the native menu bar.
   *  Returns an unsubscribe handle. */
  onMenuCommand(handler: (command: string) => void): () => void;
}

function api(): ElectronAPI {
  const x = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
  if (!x) throw new Error('ElectronHost selected but window.electronAPI is missing.');
  return x;
}

export class ElectronHost implements Host {
  readonly kind = 'electron' as const;
  readonly supportsInPlaceSave = true;
  readonly journalsSupported = true;
  readonly canSpawnWindow = true;

  async openFile(opts: OpenFileOptions = {}): Promise<OpenedFile | null> {
    const result = await api().openFile({ filters: opts.filters ?? [] });
    if (!result) return null;
    // Normalize the bytes — IPC sometimes hands us a Buffer-like
    // object (Node's `Buffer extends Uint8Array`); wrapping
    // guarantees a plain Uint8Array view that downstream code can
    // pass to `fromDocxFull` etc.
    return {
      name: result.name,
      bytes: result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes),
      handle: result.handle,
    };
  }

  async saveAs(
    suggestedName: string,
    bytes: Uint8Array,
    opts: SaveAsOptions = {},
  ): Promise<SaveResult | null> {
    const result = await api().saveAs(suggestedName, bytes, {
      filters: opts.filters ?? [],
    });
    if (!result) return null;
    return { name: result.name, handle: result.handle };
  }

  async saveExisting(handle: unknown, bytes: Uint8Array): Promise<void> {
    if (typeof handle !== 'string') {
      throw new Error(
        'ElectronHost: saveExisting requires a string path handle.',
      );
    }
    await api().saveExisting(handle, bytes);
  }

  async writeJournal(entry: JournalEntry): Promise<void> {
    await api().writeJournal(entry);
  }

  async readJournals(): Promise<JournalEntry[]> {
    const raw = await api().readJournals();
    // Normalize bytes — they may arrive as a Buffer-shaped object
    // after the structured clone. Same defensive wrap as openFile.
    return raw.map((entry) => ({
      ...entry,
      bytes: entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes as ArrayBufferLike),
    }));
  }

  async deleteJournal(uid: string): Promise<void> {
    await api().deleteJournal(uid);
  }

  async spawnWindow(payload: SpawnWindowPayload | null): Promise<void> {
    await api().spawnWindow(payload);
  }

  async getInitialDoc(): Promise<SpawnWindowPayload | null> {
    const result = await api().getInitialDoc();
    if (!result) return null;
    return {
      ...result,
      bytes: result.bytes instanceof Uint8Array
        ? result.bytes
        : new Uint8Array(result.bytes as ArrayBufferLike),
    };
  }

  /** Mode-switch helper. Asks main to broadcast a please-close
   *  message to every other window and resolve once they've all
   *  closed. The originating renderer then journals its own doc
   *  and reloads. */
  async journalAndCloseOtherWindows(): Promise<void> {
    await api().journalAndCloseOtherWindows();
  }

  /** Programmatic "close this window." Called by the please-close
   *  handler after the renderer finishes journaling. */
  async closeSelf(): Promise<void> {
    await api().closeSelf();
  }

  /** Subscribe to mode-switch please-close broadcasts. */
  onPleaseCloseForModeSwitch(handler: () => void): () => void {
    return api().onPleaseCloseForModeSwitch(handler);
  }

  /** Subscribe to menu-driven commands from the native menu bar.
   *  Mirrors the preload's `onMenuCommand` API. Returns an unsubscribe
   *  function. Not part of the cross-platform Host interface — only
   *  the desktop shell exposes a menu, so this is ElectronHost-only. */
  onMenuCommand(handler: (command: string) => void): () => void {
    return api().onMenuCommand(handler);
  }
}
