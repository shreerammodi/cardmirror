/**
 * Dropzone shelf store — a small reactive store for the in-memory
 * scratch-space items that the dropzone bubble visualizes.
 *
 * Two backends, same surface:
 *   - **Electron**: state lives in main, mutations flow through IPC,
 *     `dropzone:changed` broadcasts keep every window's local cache
 *     in sync. Survives renderer reloads (multi-pane mode toggle is
 *     a renderer reload) because main isn't reloaded.
 *   - **Web**: state lives in `sessionStorage`. Single window only,
 *     but survives the in-tab reload that the multi-pane toggle
 *     fires. Cleared on tab close per the same "no cross-session
 *     persistence" rule.
 *
 * Subscribers are notified on every state change. The renderer UI
 * (dropzone-ui.ts) is the only intended consumer.
 */

import { getElectronHost } from './host/index.js';

export interface DropzoneItem {
  id: string;
  label: string;
  /** Source schema-node type for the badge color. One of the
   *  values DragItem.type uses: pocket / hat / block / tag /
   *  analytic / card / analytic_unit, or `'text'` for an inline
   *  selection slice, or `''` when unknown. */
  type: string;
  /** Serialized PM Slice (via `Slice.toJSON()`). Stored opaquely
   *  here — only the UI / drag code parses it. */
  sliceJson: unknown;
  createdAt: number;
}

type Listener = (items: DropzoneItem[]) => void;

const SESSION_STORAGE_KEY = 'pmd-dropzone-items';

class DropzoneStore {
  private items: DropzoneItem[] = [];
  private listeners: Set<Listener> = new Set();
  private hostUnsubscribe: (() => void) | null = null;
  private initialized = false;

  /** Eagerly load from whichever backend is active. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const electron = getElectronHost();
    if (electron) {
      // Pull the current main-process state, then subscribe so we
      // stay in sync as other windows mutate.
      try {
        this.items = await electron.dropzoneList();
      } catch {
        this.items = [];
      }
      this.hostUnsubscribe = electron.onDropzoneChanged((items) => {
        this.items = items;
        this.fire();
      });
    } else {
      // Web path — sessionStorage. Storage events let us hear writes
      // from other tabs on the same origin, but the multi-pane
      // toggle is a same-tab reload so the on-init read alone covers
      // the survival case the user asked for.
      this.items = readSessionItems();
      window.addEventListener('storage', (e) => {
        if (e.key !== SESSION_STORAGE_KEY) return;
        this.items = readSessionItems();
        this.fire();
      });
    }
    this.fire();
  }

  /** Snapshot of current items, in insertion order (most-recent
   *  add is last). UI displays newest first by reversing. */
  list(): DropzoneItem[] {
    return this.items;
  }

  async add(item: DropzoneItem): Promise<void> {
    const electron = getElectronHost();
    if (electron) {
      await electron.dropzoneAdd(item);
      // Optimistic local update — main will broadcast back too, but
      // the UI feels snappier when this returns instantly.
      this.items = [...this.items.filter((x) => x.id !== item.id), item];
      this.fire();
    } else {
      this.items = [...this.items.filter((x) => x.id !== item.id), item];
      writeSessionItems(this.items);
      this.fire();
    }
  }

  async remove(id: string): Promise<void> {
    const electron = getElectronHost();
    if (electron) {
      await electron.dropzoneRemove(id);
      this.items = this.items.filter((x) => x.id !== id);
      this.fire();
    } else {
      this.items = this.items.filter((x) => x.id !== id);
      writeSessionItems(this.items);
      this.fire();
    }
  }

  async clear(): Promise<void> {
    const electron = getElectronHost();
    if (electron) {
      await electron.dropzoneClear();
      this.items = [];
      this.fire();
    } else {
      this.items = [];
      writeSessionItems(this.items);
      this.fire();
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private fire(): void {
    for (const fn of this.listeners) fn(this.items);
  }
}

function readSessionItems(): DropzoneItem[] {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Tolerate malformed entries — keep the well-shaped ones.
    return parsed.filter(
      (e): e is DropzoneItem =>
        e &&
        typeof e === 'object' &&
        typeof e.id === 'string' &&
        typeof e.label === 'string' &&
        typeof e.createdAt === 'number',
    ).map((e: DropzoneItem) => ({ ...e, type: typeof e.type === 'string' ? e.type : '' }));
  } catch {
    return [];
  }
}

function writeSessionItems(items: DropzoneItem[]): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Quota / disabled storage — silently drop. The renderer cache
    // still works for the current window; we just lose cross-reload
    // survival.
  }
}

export const dropzoneStore = new DropzoneStore();
