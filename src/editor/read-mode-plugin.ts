/**
 * Read-mode decoration plugin.
 *
 * Tags each text node with one of two CSS classes:
 *   - `pmd-rm-keep`  — read-aloud content; visible in read mode
 *   - `pmd-rm-hide`  — non-read-aloud filler; hidden in read mode
 *
 * The decision is made per text node based on its parent paragraph and
 * its marks:
 *   - In `cite_paragraph`: keep iff carrying `cite_mark`.
 *   - In `card_body` / `paragraph` / `undertag`: keep iff carrying `highlight`.
 *   - Elsewhere (heading paragraphs etc.): no decoration — block-level
 *     CSS handles whether they show.
 *
 * The decorations are emitted only when read mode is *active*; with
 * read mode off there's nothing to render and we keep an empty set.
 * Toggling the setting fires a meta-flagged no-op transaction
 * (`PMD_READ_MODE_TOGGLE`) so the plugin can rebuild the set on
 * demand.
 *
 * Doc edits trigger an *incremental* update: existing decorations get
 * mapped through the transaction (positions adjust), then decorations
 * inside the touched region (expanded to top-level container) are
 * recomputed. This is O(touched-region) instead of O(whole-doc) per
 * keystroke — the dominant typing-latency win for large docs.
 *
 * Why the plugin instead of pure CSS: marks nest in the rendered DOM
 * (a highlight inside an underline ends up inside the underline's
 * span). Targeting "non-read-aloud text" via CSS specificity races
 * against the nested wrapper structure; tagging text nodes directly
 * with a per-node class avoids that entirely.
 */

import { Plugin } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { undo, redo, undoDepth, redoDepth } from 'prosemirror-history';
import { changedRange, expandToTopLevel } from './decoration-range.js';
import {
  toggleReadingMarker,
  isReadingMarkerColor,
  READING_MARKER_META,
  READ_MODE_UNDO_META,
} from './reading-marker.js';

/** Meta key used to flip read mode on or off for a specific view.
 *  The meta value is the *desired* state — `true` turns read mode
 *  on, `false` turns it off. (Earlier this was a boolean
 *  "recompute" flag and the plugin re-read the global
 *  `settings.readMode` itself, but that broke once multi-doc made
 *  read mode per-pane state — the global setting stays `false`
 *  while individual panes flip on, and the plugin's text-hiding
 *  decorations never got emitted.) */
export const PMD_READ_MODE_TOGGLE = 'pmdReadModeToggle';

interface ReadModeState {
  on: boolean;
  decorations: DecorationSet;
  /** `undoDepth` captured when read mode was entered. In read mode, undo is
   *  allowed only while the current depth exceeds this — i.e. only the
   *  marker edits added since entry are undoable, never earlier edits. */
  baseUndoDepth: number;
  /** Whether a marker edit has been made since entering read mode. Gates
   *  redo so it can't re-apply a pre-read-mode undo (dropping a marker
   *  clears the redo stack, so once dirtied, redo only touches markers). */
  dirtied: boolean;
}

export const readModePlugin: Plugin<ReadModeState> = new Plugin<ReadModeState>({
  state: {
    init() {
      // Always start OFF — the dispatching code path
      // (`applyReadMode` / `applyReadModeToTarget`) sends a toggle
      // meta the moment a view should be in read mode, so per-view
      // state starts in a known-good baseline regardless of any
      // global setting.
      return { on: false, decorations: DecorationSet.empty, baseUndoDepth: 0, dirtied: false };
    },
    apply(tr, prev, _oldState, newState) {
      const meta = tr.getMeta(PMD_READ_MODE_TOGGLE);
      if (meta !== undefined) {
        const on = meta === true;
        return {
          on,
          decorations: on ? computeFullSet(newState.doc) : DecorationSet.empty,
          // Snapshot the undo depth on entry so read-mode undo only reverses
          // edits (markers) made from here on.
          baseUndoDepth: on ? undoDepth(newState) : prev.baseUndoDepth,
          dirtied: false,
        };
      }
      if (!tr.docChanged) return prev;
      if (!prev.on) return prev;

      // A marker edit (not an undo/redo) dirties read mode → redo is allowed.
      const dirtied = prev.dirtied || tr.getMeta(READING_MARKER_META) === true;

      const range = changedRange(tr);
      if (!range) {
        return { ...prev, decorations: prev.decorations.map(tr.mapping, tr.doc), dirtied };
      }

      // Map existing decorations through the change, then replace any
      // that fall inside the recompute window.
      const expanded = expandToTopLevel(tr.doc, range.from, range.to);
      const mapped = prev.decorations.map(tr.mapping, tr.doc);
      const stale = mapped.find(expanded.from, expanded.to);
      const fresh = computeDecorationsInRange(tr.doc, expanded.from, expanded.to);
      return { ...prev, decorations: mapped.remove(stale).add(tr.doc, fresh), dirtied };
    },
  },
  props: {
    decorations(state) {
      return readModePlugin.getState(state)?.decorations;
    },
    // Read mode keeps the editor editable (so the caret is placeable) but
    // blocks edits via `filterTransaction` below. Space and Enter do
    // nothing else here, so they're the effortless way to drop/remove a
    // reading-position marker at the podium. The command's bound shortcut
    // (Mod-Shift-D) still works via the normal keymap.
    handleDOMEvents: {
      keydown(view, event) {
        if (!readModePlugin.getState(view.state)?.on) return false;
        const bare = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
        if (bare && (event.key === 'Enter' || event.key === ' ' || event.code === 'Space')) {
          if (toggleReadingMarker(view)) {
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
    },
  },
  // Read mode's lock: while on, reject any document change except the
  // reading-marker edit and the (already-bounded) marker undo/redo.
  // Selection moves and meta-only transactions (no doc change) pass, so the
  // cursor stays usable for placing a marker.
  filterTransaction(tr, state) {
    if (!readModePlugin.getState(state)?.on) return true;
    if (!tr.docChanged) return true;
    return tr.getMeta(READING_MARKER_META) === true || tr.getMeta(READ_MODE_UNDO_META) === true;
  },
});

/** Undo — but in read mode, only as far back as the markers dropped since
 *  read mode was entered (never earlier edits). Outside read mode, plain
 *  undo. Bound to Mod-Z. */
export const readModeAwareUndo: Command = (state, dispatch, view) => {
  const rm = readModePlugin.getState(state);
  if (rm?.on) {
    if (undoDepth(state) <= rm.baseUndoDepth) return true; // nothing marker-ish to undo
    return undo(state, dispatch ? (tr) => dispatch(tr.setMeta(READ_MODE_UNDO_META, true)) : undefined, view);
  }
  return undo(state, dispatch, view);
};

/** Redo — in read mode, only marker edits undone since entry (a dropped
 *  marker clears any earlier redo, so `dirtied` means redo is marker-only).
 *  Outside read mode, plain redo. Bound to Mod-Y / Mod-Shift-Z. */
export const readModeAwareRedo: Command = (state, dispatch, view) => {
  const rm = readModePlugin.getState(state);
  if (rm?.on) {
    if (!rm.dirtied || redoDepth(state) === 0) return true;
    return redo(state, dispatch ? (tr) => dispatch(tr.setMeta(READ_MODE_UNDO_META, true)) : undefined, view);
  }
  return redo(state, dispatch, view);
};

/** Read mode keeps a text node visible iff it carries the paragraph's
 *  read-aloud mark — or is a red reading-position marker (so the marker
 *  you drop while reading actually shows). */
function isReadKept(child: PMNode, markName: string): boolean {
  return child.marks.some(
    (m) =>
      m.type.name === markName ||
      (m.type.name === 'font_color' && isReadingMarkerColor(m.attrs['color'] as string)),
  );
}

function computeFullSet(doc: PMNode): DecorationSet {
  return DecorationSet.create(doc, computeDecorationsInRange(doc, 0, doc.content.size));
}

/**
 * Build the decoration list for text nodes whose start position lies
 * within [from, to]. Callers pass a `from`/`to` already expanded to
 * top-level container boundaries so partial paragraphs aren't
 * visited mid-traversal.
 *
 * Two-pass per paragraph: for each kept text node we look at the
 * *next* text child. End-of-run (next node is hidden, or no next
 * node) gets a widget-decoration separator inserted AT the
 * boundary. The widget renders outside any mark wrappers — a plain
 * `<span>` containing a space — so the separator inherits no
 * emphasis box / highlight background. Mid-run kept spans (e.g.
 * a single highlighted phrase split into pieces by a bold sub-mark)
 * get no separator, so the highlight band reads continuously.
 */
function computeDecorationsInRange(doc: PMNode, from: number, to: number): Decoration[] {
  const decos: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    const name = node.type.name;
    let markName: string | null = null;
    if (name === 'cite_paragraph') markName = 'cite_mark';
    else if (name === 'card_body' || name === 'paragraph' || name === 'undertag') {
      markName = 'highlight';
    }
    if (markName) {
      decorateParagraph(node, pos, markName, decos);
      // We've already walked this paragraph's inline children; don't
      // recurse into them again from the outer nodesBetween.
      return false;
    }
    return true;
  });
  return decos;
}

/** Build the separator widget's DOM. A bare `<span>` containing a
 *  single space character. Lives as a sibling of the mark wrappers
 *  rather than a child, so emphasis boxes / highlight backgrounds
 *  don't bleed into the gap. */
function makeRunSeparator(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'pmd-rm-separator';
  span.textContent = ' ';
  // Widgets are inherently non-editable in PM; the explicit attr
  // here is belt-and-suspenders against any DOM mutation paths
  // that might otherwise try to step inside it.
  span.contentEditable = 'false';
  return span;
}

/** Walk one paragraph's direct text children in order. For each
 *  kept text node, decide whether it ends a run; if so, emit a
 *  widget separator at the boundary. */
function decorateParagraph(
  para: PMNode,
  paraPos: number,
  markName: string,
  decos: Decoration[],
): void {
  interface Item { pos: number; nodeSize: number; keep: boolean }
  const items: Item[] = [];
  para.forEach((child, offset) => {
    if (!child.isText || !child.text) return;
    const keep = isReadKept(child, markName);
    items.push({ pos: paraPos + 1 + offset, nodeSize: child.nodeSize, keep });
  });
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.keep) {
      decos.push(
        Decoration.inline(item.pos, item.pos + item.nodeSize, {
          class: 'pmd-rm-keep',
        }),
      );
      // End-of-run boundary: drop a sibling-level separator widget
      // at the position where the next inline content begins.
      const next = items[i + 1];
      const endsRun = !next || !next.keep;
      if (endsRun) {
        decos.push(
          Decoration.widget(item.pos + item.nodeSize, makeRunSeparator, {
            side: 1,
            ignoreSelection: true,
          }),
        );
      }
    } else {
      decos.push(
        Decoration.inline(item.pos, item.pos + item.nodeSize, {
          class: 'pmd-rm-hide',
        }),
      );
    }
  }
}
