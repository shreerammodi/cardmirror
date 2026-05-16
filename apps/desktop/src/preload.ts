/**
 * Electron preload script.
 *
 * Runs in an isolated bridging context between the main process and
 * the renderer. Exposes a narrow `window.electronAPI` surface via
 * Electron's `contextBridge` so the renderer can call into native
 * code without having full Node access.
 *
 * The shape exposed here matches the `ElectronAPI` interface
 * declared inside `src/editor/host/electron-host.ts`. If you add a
 * method here, mirror it there (and ideally in the cross-platform
 * Host interface so BrowserHost grows the same capability).
 */

import { contextBridge, ipcRenderer } from 'electron';

interface FileFilter {
  name: string;
  extensions: string[];
}

interface JournalEntry {
  uid: string;
  filename: string;
  handle: string | null;
  format: 'cmir' | 'docx' | null;
  savedAt: string;
  bytes: Uint8Array;
}

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: (opts: { filters: FileFilter[] }) =>
    ipcRenderer.invoke('host:open-file', opts),

  saveAs: (
    suggestedName: string,
    bytes: Uint8Array,
    opts: { filters: FileFilter[] },
  ) => ipcRenderer.invoke('host:save-as', suggestedName, bytes, opts),

  saveExisting: (handle: string, bytes: Uint8Array) =>
    ipcRenderer.invoke('host:save-existing', handle, bytes),

  /** Crash-recovery journal API. Stores per-doc snapshots under
   *  `app.getPath('userData')/journals/{uid}.cmir-journal`. */
  writeJournal: (entry: JournalEntry) =>
    ipcRenderer.invoke('host:write-journal', entry),
  readJournals: () => ipcRenderer.invoke('host:read-journals'),
  deleteJournal: (uid: string) =>
    ipcRenderer.invoke('host:delete-journal', uid),

  /** Spawn a new BrowserWindow, optionally pre-loaded with a doc. */
  spawnWindow: (payload: {
    filename: string;
    bytes: Uint8Array;
    handle: string | null;
    format: 'cmir' | 'docx' | null;
    uid: string | null;
  } | null) => ipcRenderer.invoke('host:spawn-window', payload),

  /** Called once at renderer boot to retrieve any initial-doc
   *  payload the spawning window stashed for us. Null when the
   *  window was opened blank. */
  getInitialDoc: () => ipcRenderer.invoke('host:get-initial-doc'),

  /** Mode-switch helper: tell main to broadcast
   *  `'mode-switch:please-close'` to every other open window and
   *  resolve once they've all closed. */
  journalAndCloseOtherWindows: () =>
    ipcRenderer.invoke('host:journal-and-close-other-windows'),

  /** Close this renderer's window programmatically. Called by the
   *  please-close handler after journaling. */
  closeSelf: () => ipcRenderer.invoke('host:close-self'),

  /** Subscribe to mode-switch please-close broadcasts. Returns an
   *  unsubscribe handle. */
  onPleaseCloseForModeSwitch(handler: () => void): () => void {
    const listener = (): void => handler();
    ipcRenderer.on('mode-switch:please-close', listener);
    return () => ipcRenderer.removeListener('mode-switch:please-close', listener);
  },

  /** Subscribe to native-menu commands. Main process broadcasts
   *  `'menu-command'` events to the focused window's webContents
   *  whenever the user picks File → Open / Save / etc. The
   *  renderer routes them through its existing ribbon-command
   *  registry. */
  onMenuCommand(handler: (command: string) => void): () => void {
    const listener = (_evt: unknown, command: string): void => handler(command);
    ipcRenderer.on('menu-command', listener);
    return () => ipcRenderer.removeListener('menu-command', listener);
  },
});
