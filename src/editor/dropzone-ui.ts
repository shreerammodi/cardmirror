/**
 * Dropzone bubble — cross-window scratch shelf for dragged content.
 * Pinned to the bottom of the nav pane.
 *
 * UI:
 *   - Closed: small grey pill with item count.
 *   - Drag-over: blue accept-state, slightly widened, matches the
 *     nav-pane + editor drop indicator color tokens.
 *   - Open: the whole root expands UPWARD inside the nav pane,
 *     revealing a header + scrollable list above the pill. The
 *     list wraps long item labels rather than ellipsing them.
 *
 * Drag-in: registers a DragSurface with `dragController`. The
 *   surface's `absorb` extracts each session item's slice and
 *   pushes it into `dropzoneStore`. The drop-target highlight
 *   class is cleared on 'end' so the bubble shrinks back after
 *   commit (otherwise the controller's last hit-test win sticks).
 *
 * Drag-out: each row starts a `virtual` drag session via
 *   `dragController.begin(...)` on pointerdown + threshold move.
 *   The controller routes the drop through normal surfaces.
 *
 * Store: `dropzoneStore` (electron-aware) holds the cross-window
 *   state. One DropzoneController per nav-pane; they all share
 *   content through the store.
 */

import { Slice } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { dragController, type DragItem, type DragSurface } from './drag-controller.js';
import { dropzoneStore, type DropzoneItem } from './dropzone-store.js';
import { schema } from '../schema/index.js';

interface DropzoneMountOptions {
  parent: HTMLElement;
  getFocusedView: () => EditorView | null;
}

export class DropzoneController {
  private root!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private listEl!: HTMLUListElement;
  private bubble!: HTMLButtonElement;
  private countBadge!: HTMLSpanElement;
  private items: DropzoneItem[] = [];
  private open = false;
  private surface: DragSurface | null = null;
  private unregisterSurface: (() => void) | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeController: (() => void) | null = null;
  private getFocusedView: () => EditorView | null = () => null;
  private dragOutSource: {
    startX: number;
    startY: number;
    item: DropzoneItem;
    started: boolean;
  } | null = null;

  mount(opts: DropzoneMountOptions): void {
    this.getFocusedView = opts.getFocusedView;

    this.root = document.createElement('div');
    this.root.className = 'pmd-dropzone-root';
    this.root.dataset['open'] = 'false';

    // Inline panel — sits above the bubble inside the root, shown
    // when open. Grows upward as the root is anchored to the nav
    // pane's bottom edge.
    this.panel = document.createElement('div');
    this.panel.className = 'pmd-dropzone-panel';

    const header = document.createElement('div');
    header.className = 'pmd-dropzone-panel-header';
    const title = document.createElement('span');
    title.className = 'pmd-dropzone-panel-title';
    title.textContent = 'Shelf';
    header.appendChild(title);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'pmd-dropzone-panel-clear';
    clear.textContent = 'Clear';
    clear.title = 'Remove every shelf item';
    clear.addEventListener('click', (e) => {
      e.stopPropagation();
      void dropzoneStore.clear();
    });
    header.appendChild(clear);
    this.panel.appendChild(header);

    this.listEl = document.createElement('ul');
    this.listEl.className = 'pmd-dropzone-list';
    this.panel.appendChild(this.listEl);

    this.root.appendChild(this.panel);

    // Bubble — the always-visible toggle. Clicking it expands the
    // root upward into the nav pane.
    this.bubble = document.createElement('button');
    this.bubble.type = 'button';
    this.bubble.className = 'pmd-dropzone-bubble';
    this.bubble.setAttribute('aria-label', 'Dropzone shelf');
    this.bubble.title = 'Dropzone — drag content here, click to expand';

    const icon = document.createElement('span');
    icon.className = 'pmd-dropzone-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/><path d="M12 14V4"/><path d="M8 8l4-4 4 4"/></svg>';
    this.bubble.appendChild(icon);

    this.countBadge = document.createElement('span');
    this.countBadge.className = 'pmd-dropzone-count';
    this.countBadge.hidden = true;
    this.bubble.appendChild(this.countBadge);

    this.bubble.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setOpen(!this.open);
    });

    this.root.appendChild(this.bubble);
    opts.parent.appendChild(this.root);

    // Drag surface — bubble + panel both act as the drop target so
    // the user can drop onto either when the shelf is open.
    this.surface = {
      hitTest: (clientX, clientY) => {
        const inside = (rect: DOMRect): boolean =>
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom;
        const bubbleRect = this.bubble.getBoundingClientRect();
        const panelRect = this.open ? this.panel.getBoundingClientRect() : null;
        if (!inside(bubbleRect) && !(panelRect && inside(panelRect))) return null;
        return {
          el: this.bubble,
          insertPos: 0,
          dy: 0,
          absorb: (items) => this.absorbItems(items),
        };
      },
      highlight: (el) => {
        const active = el !== null;
        this.bubble.classList.toggle('pmd-dropzone-bubble-drop-target', active);
        this.root.classList.toggle('pmd-dropzone-root-drop-target', active);
      },
    };
    this.unregisterSurface = dragController.registerSurface(this.surface);

    void dropzoneStore.init().then(() => {
      this.items = dropzoneStore.list();
      this.renderList();
      this.renderBubble();
    });
    this.unsubscribeStore = dropzoneStore.subscribe((items) => {
      this.items = items;
      this.renderList();
      this.renderBubble();
    });

    // End-of-drag cleanup — controller doesn't proactively clear
    // surface highlights when a session ends, so we do it here so
    // the bubble shrinks back after a successful commit (or
    // cancel).
    this.unsubscribeController = dragController.subscribe((event) => {
      if (event === 'end') {
        this.surface?.highlight(null);
        this.endDragOut();
      }
    });

    document.addEventListener('pointerdown', this.onDocumentPointerDown);
  }

  unmount(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);
    this.unsubscribeStore?.();
    this.unsubscribeController?.();
    this.unregisterSurface?.();
    this.root.remove();
  }

  // ---- Rendering ----------------------------------------------------

  private renderBubble(): void {
    const n = this.items.length;
    this.countBadge.hidden = n === 0;
    this.countBadge.textContent = String(n);
    this.bubble.classList.toggle('pmd-dropzone-bubble-empty', n === 0);
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.root.dataset['open'] = open ? 'true' : 'false';
    this.bubble.classList.toggle('pmd-dropzone-bubble-open', open);
  }

  private renderList(): void {
    this.listEl.innerHTML = '';
    if (this.items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'pmd-dropzone-empty';
      empty.textContent =
        'Drag a card, heading, or selection onto the pill below. Shelf items are shared across windows for this session.';
      this.listEl.appendChild(empty);
      return;
    }
    // Newest first.
    for (const item of [...this.items].reverse()) {
      this.listEl.appendChild(this.renderRow(item));
    }
  }

  private renderRow(item: DropzoneItem): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'pmd-dropzone-row';

    const badge = document.createElement('span');
    const { kind, label: typeLabel } = typeBadge(item.type);
    badge.className = `pmd-dropzone-row-type pmd-dropzone-row-type-${kind}`;
    badge.textContent = typeLabel;
    row.appendChild(badge);

    const label = document.createElement('span');
    label.className = 'pmd-dropzone-row-label';
    label.textContent = item.label;
    label.title = item.label;
    row.appendChild(label);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pmd-dropzone-row-delete';
    del.title = 'Remove from shelf';
    del.setAttribute('aria-label', 'Remove');
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void dropzoneStore.remove(item.id);
    });
    row.appendChild(del);

    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('.pmd-dropzone-row-delete')) return;
      this.dragOutSource = {
        startX: e.clientX,
        startY: e.clientY,
        item,
        started: false,
      };
      window.addEventListener('pointermove', this.onDragOutPointerMove);
      window.addEventListener('pointerup', this.onDragOutPointerUp);
      e.preventDefault();
    });

    return row;
  }

  // ---- Drag-in (controller absorb) ----------------------------------

  private async absorbItems(items: DragItem[]): Promise<void> {
    const session = dragController.getSession();
    if (!session) return;
    const srcView = session.view;
    for (const item of items) {
      const slice = item.prebuilt ?? srcView.state.doc.slice(item.from, item.to);
      const sliceJson = slice.toJSON();
      const label = deriveLabel(slice, item);
      const id = newId();
      await dropzoneStore.add({
        id,
        label,
        type: item.type || inferTypeFromSlice(slice),
        sliceJson,
        createdAt: Date.now(),
      });
    }
  }

  // ---- Drag-out -----------------------------------------------------

  private onDragOutPointerMove = (e: PointerEvent): void => {
    const src = this.dragOutSource;
    if (!src) return;
    if (!src.started) {
      const dx = e.clientX - src.startX;
      const dy = e.clientY - src.startY;
      if (dx * dx + dy * dy < 16) return;
      src.started = this.beginDragOut(src.item);
      if (!src.started) {
        this.endDragOut();
        return;
      }
    }
    dragController.setPointer(e.clientX, e.clientY);
    dragController.dispatchHit(e.clientX, e.clientY);
  };

  private onDragOutPointerUp = (_e: PointerEvent): void => {
    if (!this.dragOutSource) return;
    if (this.dragOutSource.started) {
      dragController.commit({ copy: true });
    }
    this.endDragOut();
  };

  private beginDragOut(item: DropzoneItem): boolean {
    const view = this.getFocusedView();
    if (!view) return false;
    let slice: Slice;
    try {
      slice = Slice.fromJSON(schema, item.sliceJson as Parameters<typeof Slice.fromJSON>[1]);
    } catch {
      return false;
    }
    const dragItem: DragItem = {
      from: 0,
      to: 0,
      id: null,
      type: item.type || 'dropzone',
      level: 0,
      label: item.label,
      prebuilt: slice,
    };
    dragController.begin({ view, items: [dragItem], virtual: true });
    return true;
  }

  private endDragOut(): void {
    if (!this.dragOutSource) return;
    window.removeEventListener('pointermove', this.onDragOutPointerMove);
    window.removeEventListener('pointerup', this.onDragOutPointerUp);
    this.dragOutSource = null;
  }

  // ---- Click-outside ------------------------------------------------

  private onDocumentPointerDown = (e: PointerEvent): void => {
    if (!this.open) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (this.root.contains(t)) return;
    this.setOpen(false);
  };
}

function newId(): string {
  return `dz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveLabel(slice: Slice, item: DragItem): string {
  if (item.label && item.label.trim()) {
    const l = item.label.trim();
    return l.length > 120 ? l.slice(0, 118) + '…' : l;
  }
  const text = slice.content.textBetween(0, slice.content.size, ' ', ' ').trim();
  if (text) return text.length > 120 ? text.slice(0, 118) + '…' : text;
  return item.type ? `(${item.type})` : '(item)';
}

/** Map a schema-node type to a badge kind + visible label. The
 *  kind feeds the CSS variant class for the badge color; the
 *  label is the short uppercase chip text. */
function typeBadge(type: string): { kind: string; label: string } {
  switch (type) {
    case 'pocket': return { kind: 'pocket', label: 'POCKET' };
    case 'hat': return { kind: 'hat', label: 'HAT' };
    case 'block': return { kind: 'block', label: 'BLOCK' };
    case 'tag': return { kind: 'tag', label: 'TAG' };
    case 'analytic': return { kind: 'analytic', label: 'ANALYTIC' };
    case 'card': return { kind: 'card', label: 'CARD' };
    case 'card_body': return { kind: 'card', label: 'BODY' };
    case 'cite_paragraph': return { kind: 'cite', label: 'CITE' };
    case 'analytic_unit': return { kind: 'analytic', label: 'ANALYTIC' };
    case 'undertag': return { kind: 'tag', label: 'UNDERTAG' };
    case 'paragraph': return { kind: 'text', label: 'TEXT' };
    case 'text': return { kind: 'text', label: 'TEXT' };
    default: return { kind: 'generic', label: 'ITEM' };
  }
}

/** Best-effort type inference from a slice's top-level node when
 *  the source DragItem didn't carry one (e.g., a raw text-selection
 *  drag from the editor). */
function inferTypeFromSlice(slice: Slice): string {
  if (slice.content.childCount === 0) return 'text';
  const first = slice.content.firstChild;
  return first ? first.type.name : 'text';
}
