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
  /** Read the system clipboard's plain-text content. Used by the
   *  F2 (Paste Plain) command on Electron — bypasses the Chromium
   *  web clipboard-permission UI that forces the web edition into
   *  a sticky-toggle workaround. */
  clipboardReadText: () => ipcRenderer.invoke('host:clipboard-read-text'),

  /** Open the native directory-picker dialog. Used by the
   *  settings UI for the "default folder" rows. Returns the
   *  chosen absolute path or null if the user cancelled. */
  pickDirectory: (opts?: { defaultPath?: string; title?: string }) =>
    ipcRenderer.invoke('host:pick-directory', opts),

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
    markAsSpeech?: boolean;
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

  /** Doc-lifecycle reporting for the main-process speech-doc
   *  registry. Renderers call register on mount and unregister on
   *  close, so main knows where each uid lives. */
  docRegister: (uid: string) => ipcRenderer.invoke('host:doc-register', uid),
  docUnregister: (uid: string) =>
    ipcRenderer.invoke('host:doc-unregister', uid),

  /** Set / clear / read the current speech-doc designation. Main
   *  broadcasts `speech:changed` to every window after any state
   *  change so UIs stay in sync. */
  speechSet: (uid: string | null) =>
    ipcRenderer.invoke('host:speech-set', uid),
  speechGet: () => ipcRenderer.invoke('host:speech-get'),

  /** Subscribe to speech-state broadcasts. The handler receives the
   *  current `{ uid }` (uid is null when no speech doc is flagged). */
  onSpeechChanged(handler: (state: { uid: string | null }) => void): () => void {
    const listener = (_evt: unknown, state: { uid: string | null }): void =>
      handler(state);
    ipcRenderer.on('speech:changed', listener);
    return () => ipcRenderer.removeListener('speech:changed', listener);
  },

  /** Send a serialized PM slice to whatever window owns the speech
   *  doc. Returns whether the slice was delivered (`delivered:
   *  true`) or why not (`delivered: false, reason: ...`). */
  speechSendSlice: (payload: { sliceJson: unknown; atEnd: boolean }) =>
    ipcRenderer.invoke('host:speech-send-slice', payload),

  /** Subscribe to incoming speech-doc slices. The handler receives
   *  `{ uid, sliceJson, atEnd }` and is responsible for applying
   *  the slice to its local view that matches uid. */
  onIncomingSpeechSlice(
    handler: (payload: { uid: string; sliceJson: unknown; atEnd: boolean }) => void,
  ): () => void {
    const listener = (
      _evt: unknown,
      payload: { uid: string; sliceJson: unknown; atEnd: boolean },
    ): void => handler(payload);
    ipcRenderer.on('speech:incoming-slice', listener);
    return () =>
      ipcRenderer.removeListener('speech:incoming-slice', listener);
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
