/**
 * CardMirror desktop — Electron main process.
 *
 * Responsibilities:
 *   - Create and manage the BrowserWindow that hosts the renderer.
 *   - Drive native open/save dialogs and read/write files from disk
 *     in response to renderer IPC. (Renderer-side Host abstraction
 *     in `src/editor/host/electron-host.ts`.)
 *   - Define the native menu bar; menu picks dispatch to the
 *     renderer as `'menu-command'` events, where they get routed
 *     through the same ribbon-command registry as keyboard
 *     shortcuts and ribbon buttons.
 *
 * Phase 3 scope (this file's job): native file I/O + menus. Phase 4
 * (autosave) and Phase 5 (packaged builds) layer on top.
 */

import {
  app,
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  dialog,
  ipcMain,
} from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const DEV_SERVER_URL = 'http://localhost:5173';

interface FileFilter {
  name: string;
  extensions: string[];
}

let mainWindow: BrowserWindow | null = null;

/** Optional initial-doc payload handed to a freshly-spawned window's
 *  renderer when it asks `host:get-initial-doc` at boot. Lets the
 *  spawning renderer pre-load a file into the new window without
 *  going through the file dialog again. Keyed by `BrowserWindow.id`. */
interface InitialDocPayload {
  filename: string;
  bytes: unknown; // arrives from renderer as Uint8Array / Buffer / ArrayBuffer
  handle: string | null;
  format: 'cmir' | 'docx' | null;
  uid: string | null;
}
const pendingInitialDocs = new Map<number, InitialDocPayload>();

function createWindow(initialDoc?: InitialDocPayload): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'CardMirror',
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Stash the initial doc (if any) BEFORE loading the renderer so
  // the renderer's `host:get-initial-doc` call at boot finds it.
  if (initialDoc) {
    pendingInitialDocs.set(win.id, initialDoc);
  }

  if (!app.isPackaged) {
    void win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(
      path.join(__dirname, '..', '..', '..', '..', 'dist', 'index.html'),
    );
  }

  // Track the focused window so menu commands fire at the right
  // place when multiple windows exist.
  win.on('focus', () => {
    mainWindow = win;
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    pendingInitialDocs.delete(win.id);
  });

  mainWindow = win;
  return win;
}

/** Find the BrowserWindow that owns the renderer making an IPC
 *  call. Falls back to the focused window when sender lookup fails
 *  (shouldn't, but be defensive). */
function ownerWindow(sender: Electron.WebContents): BrowserWindow | null {
  return (
    BrowserWindow.fromWebContents(sender) ??
    BrowserWindow.getFocusedWindow() ??
    mainWindow
  );
}

/** Convert IPC-transferred bytes (which can arrive as a plain
 *  Uint8Array view, a Node Buffer, or even a structured-cloned
 *  ArrayBuffer depending on Electron version) into a Buffer the
 *  fs API will accept. */
function bytesToBuffer(bytes: unknown): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  throw new TypeError('Unsupported bytes payload — expected Uint8Array / ArrayBuffer / Buffer.');
}

// ─── IPC handlers ──────────────────────────────────────────────────

ipcMain.handle('host:open-file', async (event, opts: { filters?: FileFilter[] }) => {
  const win = ownerWindow(event.sender);
  const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
    properties: ['openFile'],
    filters: opts?.filters?.length ? opts.filters : [],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0]!;
  const bytes = await fs.readFile(filePath);
  return {
    name: path.basename(filePath),
    bytes: new Uint8Array(bytes),
    handle: filePath,
  };
});

ipcMain.handle(
  'host:save-as',
  async (
    event,
    suggestedName: string,
    bytes: unknown,
    opts: { filters?: FileFilter[] },
  ) => {
    const win = ownerWindow(event.sender);
    const result = await dialog.showSaveDialog(win ?? new BrowserWindow({ show: false }), {
      defaultPath: suggestedName,
      filters: opts?.filters?.length ? opts.filters : [],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, bytesToBuffer(bytes));
    return {
      name: path.basename(result.filePath),
      handle: result.filePath,
    };
  },
);

ipcMain.handle('host:save-existing', async (_event, handle: string, bytes: unknown) => {
  if (typeof handle !== 'string' || handle.length === 0) {
    throw new Error('host:save-existing: handle must be a non-empty path string.');
  }
  await fs.writeFile(handle, bytesToBuffer(bytes));
});

// ─── Crash-recovery journals ───────────────────────────────────────
// Each open doc gets one journal file at
//   {userData}/journals/{uid}.cmir-journal
// containing a small JSON envelope plus the doc bytes as base64.
// Written debounced after every doc-changing edit; cleared on save
// or explicit close; scanned at startup so a crash gets surfaced
// to the user as a recovery offer.

interface JournalEntryIpc {
  uid: string;
  filename: string;
  handle: string | null;
  format: 'cmir' | 'docx' | null;
  savedAt: string;
  bytes: unknown;
}

function journalsDir(): string {
  return path.join(app.getPath('userData'), 'journals');
}

function journalPathFor(uid: string): string {
  // Sanitize uid → filename. UIDs are app-generated so they're
  // already safe (alphanumeric + dashes), but a strict filter
  // defends against future formats.
  const safe = uid.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(journalsDir(), `${safe}.cmir-journal`);
}

async function ensureJournalsDir(): Promise<void> {
  await fs.mkdir(journalsDir(), { recursive: true });
}

ipcMain.handle('host:write-journal', async (_event, entry: JournalEntryIpc) => {
  if (!entry || typeof entry.uid !== 'string' || !entry.uid) {
    throw new Error('host:write-journal: entry.uid is required.');
  }
  await ensureJournalsDir();
  const buf = bytesToBuffer(entry.bytes);
  // Wrap the doc bytes in a small JSON envelope so the file is
  // self-describing. base64 the doc bytes (cmir JSON text → b64 →
  // ASCII string we can stick inside the outer JSON). Slight size
  // overhead but keeps the file fully readable / inspectable.
  const envelope = {
    uid: entry.uid,
    filename: entry.filename,
    handle: entry.handle,
    format: entry.format,
    savedAt: entry.savedAt,
    bytesB64: buf.toString('base64'),
  };
  await fs.writeFile(journalPathFor(entry.uid), JSON.stringify(envelope));
});

ipcMain.handle('host:read-journals', async () => {
  let entries: string[];
  try {
    entries = await fs.readdir(journalsDir());
  } catch (err) {
    // Dir doesn't exist yet → no journals to read.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const results: JournalEntryIpc[] = [];
  for (const name of entries) {
    if (!name.endsWith('.cmir-journal')) continue;
    const fullPath = path.join(journalsDir(), name);
    try {
      const text = await fs.readFile(fullPath, 'utf8');
      const parsed = JSON.parse(text);
      if (typeof parsed?.uid !== 'string' || typeof parsed?.bytesB64 !== 'string') continue;
      results.push({
        uid: parsed.uid,
        filename: typeof parsed.filename === 'string' ? parsed.filename : 'Untitled',
        handle: typeof parsed.handle === 'string' ? parsed.handle : null,
        format: parsed.format === 'cmir' || parsed.format === 'docx' ? parsed.format : null,
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(0).toISOString(),
        bytes: new Uint8Array(Buffer.from(parsed.bytesB64, 'base64')),
      });
    } catch (err) {
      // Skip corrupt journal files rather than blocking startup.
      console.warn(`Skipping corrupt journal ${name}:`, err);
    }
  }
  return results;
});

ipcMain.handle('host:delete-journal', async (_event, uid: string) => {
  if (typeof uid !== 'string' || !uid) return;
  try {
    await fs.unlink(journalPathFor(uid));
  } catch (err) {
    // Already gone is fine.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
});

// ─── Multi-window: spawn + initial-doc handshake ──────────────────
// Renderers in "windows mode" (multiDocWorkspace = false on
// Electron) call `host:spawn-window` to open a new BrowserWindow,
// optionally with an initial doc already loaded. The freshly-
// spawned window's renderer calls `host:get-initial-doc` once at
// boot to retrieve the payload (or `null` if it was just opened
// blank). Main owns the pending-map keyed by window id.

ipcMain.handle('host:spawn-window', async (_event, payload: InitialDocPayload | null) => {
  // Defensive normalization of `payload.bytes` — IPC may have
  // transferred it as a Buffer / typed array. Store as-is; the
  // renderer will normalize at read time too.
  createWindow(payload ?? undefined);
});

ipcMain.handle('host:get-initial-doc', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const payload = pendingInitialDocs.get(win.id);
  if (!payload) return null;
  pendingInitialDocs.delete(win.id);
  return payload;
});

// ─── Mode-switch: journal-and-close other windows ─────────────────
// When the user toggles `multiDocWorkspace` in window A, every
// OTHER open window needs to journal its current doc and close
// before A reloads — so the post-reload recovery flow can pick up
// every doc and restore them in the new layout. Each renderer
// listens for `'mode-switch:please-close'`; on receipt it journals
// the current doc and calls `host:close-self`. We wait for the
// `closed` event on each before resolving, with a generous timeout
// fallback so a hung renderer doesn't strand the originating window.

const MODE_SWITCH_CLOSE_TIMEOUT_MS = 10000;

ipcMain.handle('host:journal-and-close-other-windows', async (event) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  const others = BrowserWindow.getAllWindows().filter(
    (w) => w !== sender && !w.isDestroyed(),
  );
  await Promise.all(
    others.map(
      (w) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (!w.isDestroyed()) w.destroy();
            resolve();
          }, MODE_SWITCH_CLOSE_TIMEOUT_MS);
          w.once('closed', () => {
            clearTimeout(timer);
            resolve();
          });
          w.webContents.send('mode-switch:please-close');
        }),
    ),
  );
});

ipcMain.handle('host:close-self', async (event) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (sender && !sender.isDestroyed()) sender.close();
});

// ─── Native menu bar ───────────────────────────────────────────────

/** Send a menu-command IPC event to the currently focused window. */
function dispatchMenuCommand(command: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return;
  win.webContents.send('menu-command', command);
}

function buildMenu(): Menu {
  const isMac = process.platform === 'darwin';

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'New Document',
        accelerator: 'CmdOrCtrl+Alt+N',
        click: () => dispatchMenuCommand('newDocument'),
      },
      {
        label: 'Open…',
        accelerator: 'CmdOrCtrl+O',
        click: () => dispatchMenuCommand('openFile'),
      },
      { type: 'separator' },
      {
        label: 'Save',
        accelerator: 'CmdOrCtrl+S',
        click: () => dispatchMenuCommand('save'),
      },
      {
        label: 'Save As…',
        accelerator: 'Shift+CmdOrCtrl+S',
        click: () => dispatchMenuCommand('saveAs'),
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    fileMenu,
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];

  return Menu.buildFromTemplate(template);
}

// ─── App lifecycle ─────────────────────────────────────────────────

void app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
