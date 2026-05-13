/**
 * Workspace-scoped drag controller.
 *
 * Coordinates header drag-and-drop within the nav pane (Phase 1) and
 * — eventually — between the nav pane and the editor surface, and
 * between separate documents in a multi-doc workspace.
 *
 * Architecture: source(s) call `begin(session)` to start a drag.
 * Surfaces register pointer-hit handlers and tell the controller which
 * drop target the cursor is over via `setHoverTarget`. When the pointer
 * is released the active surface calls `commit()`; cancellation goes
 * through `cancel()`. Subscribers (nav pane, eventually the editor
 * view) listen for state changes to render drag visuals.
 *
 * For Phase 1 we support a single-item, same-view drop. Multi-item
 * (Phase 2) and cross-view (Phase 3) extend this without changing the
 * shape — `DragSession.items` is already plural.
 */

import type { EditorView } from 'prosemirror-view';
import type { EditorState, Transaction } from 'prosemirror-state';
import { Fragment, type Node as PMNode, Slice } from 'prosemirror-model';
import { newHeadingId } from '../schema/ids.js';

export interface DragItem {
  /** Doc position range covering the dragged unit (heading + its
   *  subtree, or a card/analytic_unit container). */
  from: number;
  to: number;
  /** Stable heading id, when one exists. */
  id: string | null;
  /** Schema type name (pocket / hat / block / card / analytic_unit). */
  type: string;
  /** Outline level (1–4). */
  level: number;
  /** Display label for the pickup pill (the heading's text). */
  label: string;
}

export interface DragSession {
  /** The view the source content lives in. */
  view: EditorView;
  /** All items being dragged, in document order. */
  items: DragItem[];
}

export interface DropTarget {
  /** The view the drop should land in. (Same as session.view in
   *  Phase 1 — a future cross-doc commit can land in another view.) */
  view: EditorView;
  /** Document position to insert at, in the target view's current doc. */
  insertPos: number;
}

type DragEvent = 'begin' | 'move' | 'end';
type Listener = (event: DragEvent) => void;

/**
 * A drop-target surface (nav pane, editor surface, eventually
 * other-document panes). Surfaces register at attach time; the
 * controller queries each on every pointermove during a drag and
 * picks the closest hit.
 */
export interface DragSurface {
  /** Test whether the pointer is over a drop slot owned by this
   *  surface. Return null when not. */
  hitTest(clientX: number, clientY: number):
    | { el: HTMLElement; insertPos: number; dy: number }
    | null;
  /** Highlight the given indicator element (or none). The controller
   *  passes the winner across all surfaces; losing surfaces receive
   *  `null` and should clear their highlight. */
  highlight(el: HTMLElement | null): void;
}

class DragControllerImpl {
  private session: DragSession | null = null;
  private hoverTarget: DropTarget | null = null;
  private pointerX = 0;
  private pointerY = 0;
  private copyMode = false;
  private listeners: Set<Listener> = new Set();
  private surfaces: Set<DragSurface> = new Set();

  isActive(): boolean {
    return this.session !== null;
  }

  getSession(): DragSession | null {
    return this.session;
  }

  getHoverTarget(): DropTarget | null {
    return this.hoverTarget;
  }

  getPointer(): { x: number; y: number } {
    return { x: this.pointerX, y: this.pointerY };
  }

  /** Whether the active drag is in "copy" mode (Ctrl on Windows/Linux,
   *  Option on macOS held by the user). Refreshed by the drag source
   *  on pointermove + key events so visuals can track in real time. */
  isCopyMode(): boolean {
    return this.copyMode;
  }

  setCopyMode(copy: boolean): void {
    if (this.copyMode === copy) return;
    this.copyMode = copy;
    this.notify('move');
  }

  begin(session: DragSession): void {
    this.session = session;
    this.hoverTarget = null;
    this.copyMode = false;
    this.notify('begin');
  }

  setPointer(x: number, y: number): void {
    this.pointerX = x;
    this.pointerY = y;
    this.notify('move');
  }

  setHoverTarget(target: DropTarget | null): void {
    if (this.hoverTarget === target) return;
    this.hoverTarget = target;
    this.notify('move');
  }

  /**
   * Apply the drop. Returns true on success, false on no-op (e.g.,
   * drop-on-self). Cancels and returns false if no hover target.
   *
   * `opts.copy` (default false) duplicates the source instead of
   * moving — the original stays in place, a clone with fresh heading
   * IDs lands at the drop target.
   */
  commit(opts: { copy?: boolean } = {}): boolean {
    if (!this.session) return false;
    if (!this.hoverTarget) {
      this.cancel();
      return false;
    }
    const { view: srcView, items } = this.session;
    const { view: tgtView, insertPos } = this.hoverTarget;

    // Phase 1+2: any number of items, same view only. Cross-view
    // (Phase 3) is added later.
    if (items.length === 0 || srcView !== tgtView) {
      this.cancel();
      return false;
    }

    const tr = opts.copy
      ? buildCopyTransaction(srcView.state, items, insertPos)
      : buildMoveTransaction(srcView.state, items, insertPos);
    if (!tr) {
      this.cancel();
      return false;
    }
    srcView.dispatch(tr.scrollIntoView());

    this.session = null;
    this.hoverTarget = null;
    this.copyMode = false;
    this.notify('end');
    return true;
  }

  cancel(): void {
    if (!this.session) return;
    this.session = null;
    this.hoverTarget = null;
    this.copyMode = false;
    this.notify('end');
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  registerSurface(surface: DragSurface): () => void {
    this.surfaces.add(surface);
    return () => this.surfaces.delete(surface);
  }

  /**
   * Query every registered surface for a hit, pick the closest, and
   * apply the result: highlight the winner's indicator, clear losing
   * surfaces, set the controller's hover target. Used by drag-source
   * pointermove handlers to keep all surfaces consistent.
   */
  dispatchHit(clientX: number, clientY: number): void {
    if (!this.session) return;
    let winner:
      | { surface: DragSurface; el: HTMLElement; insertPos: number; dy: number }
      | null = null;
    for (const surface of this.surfaces) {
      const hit = surface.hitTest(clientX, clientY);
      if (!hit) continue;
      if (!winner || hit.dy < winner.dy) winner = { ...hit, surface };
    }
    for (const surface of this.surfaces) {
      surface.highlight(winner && winner.surface === surface ? winner.el : null);
    }
    if (winner) {
      this.setHoverTarget({ view: this.session.view, insertPos: winner.insertPos });
    } else {
      this.setHoverTarget(null);
    }
  }

  private notify(event: DragEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        // Don't let one subscriber's error break others.
        console.error('drag listener error', err);
      }
    }
  }
}

/** Workspace-wide singleton. */
export const dragController = new DragControllerImpl();

/**
 * Build a single transaction that cuts the source range(s) and
 * re-inserts them at `insertPos`. Returns null on a no-op (drop on
 * self, or `insertPos` falls inside one of the dragged items'
 * source ranges).
 *
 * Multi-item: items are inserted at the target in their original
 * document order. Cuts happen in reverse-document order so earlier
 * cuts don't shift later sources' positions before we read their
 * content. Slice extraction happens before any deletion to avoid
 * reading from a mutated doc.
 */
export function buildMoveTransaction(
  state: EditorState,
  items: DragItem[],
  insertPos: number,
): Transaction | null {
  if (items.length === 0) return null;
  // Reject if target is strictly inside any source range. Boundary
  // positions (= from or = to) are valid drop slots — for multi-item
  // drag, an unmoved sibling's boundary is the natural drop point
  // adjacent to a moved item.
  for (const item of items) {
    if (insertPos > item.from && insertPos < item.to) return null;
  }

  // Capture content before mutating (need original doc positions).
  const ascending = [...items].sort((a, b) => a.from - b.from);
  const slices = ascending.map((item) => state.doc.slice(item.from, item.to));

  // Cut in reverse-document order so earlier-position cuts don't
  // invalidate later items' positions.
  const tr = state.tr;
  const descending = [...items].sort((a, b) => b.from - a.from);
  for (const item of descending) {
    tr.delete(item.from, item.to);
  }

  // Map the target through every cut, then insert items in original
  // document order, advancing the local target by each insertion.
  let target = tr.mapping.map(insertPos);
  for (const slice of slices) {
    tr.insert(target, slice.content);
    target += slice.content.size;
  }
  return tr;
}

/**
 * Build a single transaction that duplicates the source range(s) and
 * inserts the clone(s) at `insertPos`. The original stays in place.
 * Heading IDs in the cloned subtree are rewritten with fresh values
 * via `rewriteHeadingIds` so the workspace's id-uniqueness invariant
 * (per ARCHITECTURE §4 / §12) holds after the duplicate lands. Used
 * by the nav-pane copy-drag (Ctrl on Windows/Linux, Option on macOS).
 *
 * Returns null on a no-op (`insertPos` strictly inside a source range
 * — "copy into self" recurses indefinitely). Boundary positions are
 * still rejected because the hit-test surfaces don't produce them
 * anyway and rejecting keeps the same predicate as the move path.
 */
export function buildCopyTransaction(
  state: EditorState,
  items: DragItem[],
  insertPos: number,
): Transaction | null {
  if (items.length === 0) return null;
  for (const item of items) {
    if (insertPos > item.from && insertPos < item.to) return null;
  }

  const ascending = [...items].sort((a, b) => a.from - b.from);
  const slices = ascending.map((item) =>
    rewriteHeadingIds(state.doc.slice(item.from, item.to)),
  );

  const tr = state.tr;
  let target = insertPos;
  for (const slice of slices) {
    tr.insert(target, slice.content);
    target += slice.content.size;
  }
  return tr;
}

/** Walk a slice and replace every non-null `attrs.id` with a fresh
 *  `newHeadingId()`. Only nodes whose schema declares an `id` attr
 *  populated with a string get rewritten (pocket / hat / block / tag /
 *  analytic — see `headingAttrs` in `schema/nodes.ts`). Nodes without
 *  an id attr or with a default-null id pass through unchanged. */
function rewriteHeadingIds(slice: Slice): Slice {
  return new Slice(
    rewriteFragment(slice.content),
    slice.openStart,
    slice.openEnd,
  );
}

function rewriteFragment(frag: Fragment): Fragment {
  const children: PMNode[] = [];
  frag.forEach((child) => children.push(rewriteNode(child)));
  return Fragment.fromArray(children);
}

function rewriteNode(node: PMNode): PMNode {
  // Text nodes are immutable and can't be reconstructed via
  // `type.create` — and they never carry an id attr anyway, so leave
  // them alone. Inline leaves (image) likewise have no id.
  if (node.isText) return node;
  const newContent = node.isLeaf
    ? node.content
    : rewriteFragment(node.content);
  const hasIdAttr =
    node.attrs && typeof node.attrs['id'] === 'string' && node.attrs['id'];
  const nextAttrs = hasIdAttr
    ? { ...node.attrs, id: newHeadingId() }
    : node.attrs;
  return node.type.create(nextAttrs, newContent, node.marks);
}
