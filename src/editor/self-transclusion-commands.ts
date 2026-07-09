/**
 * Intra-document live window ("self-transclusion") — view-operating commands.
 *
 * Insert / re-pick / jump / unlink / delete for `self_ref` windows, plus the
 * minimal in-document section picker shared by insert and re-pick. All of this
 * is thin over the pure core (self-transclusion.ts); a window is a by-reference,
 * read-only projection, so there is no sync/merge/conflict machinery here.
 */

import { TextSelection, NodeSelection, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { newHeadingId } from '../schema/index.js';
import { collectHeadings, computeHeadingRange } from './headings.js';
import { preciseScrollIntoView } from './precise-scroll.js';
import { rewriteHeadingIdsInFragment, enclosingZonePos } from './transclusion.js';
import {
  buildInDocCopyAttrs,
  insertZoneAtSelection,
  buildZoneErrorMessage,
} from './transclusion-actions.js';
import { showToast } from './toast.js';
import {
  SELF_REF_NODE,
  isSelfRef,
  createSelfRefNode,
  resolveSelfProjection,
} from './self-transclusion.js';

/** If the current selection is a whole-node selection ON a live view (`self_ref`
 *  atom), its document position; otherwise null. The nav caret-tracker uses this
 *  to light the window's projected row(s) instead of the heading above it. */
export function selfRefSelectionPos(state: EditorState): number | null {
  const sel = state.selection;
  return sel instanceof NodeSelection && isSelfRef(sel.node) ? sel.from : null;
}

/** [from, to] of a heading's section content — mirrors extractSection's range
 *  (the header line dropped for grouping headings) so the cycle guard matches. */
function sectionRange(view: EditorView, headingId: string): { from: number; to: number } | null {
  const doc = view.state.doc;
  const entry = collectHeadings(doc, { skipCite: true }).find((h) => h.id === headingId);
  if (!entry) return null;
  const range = computeHeadingRange(doc, entry);
  if (!range) return null;
  let from = range.from;
  if (entry.type !== 'tag' && entry.type !== 'analytic') {
    const node = doc.nodeAt(entry.pos);
    if (!node) return null;
    from = entry.pos + node.nodeSize;
  }
  return from <= range.to ? { from, to: range.to } : null;
}

/** Insert a `self_ref` at the cursor mirroring the section under `headingId`.
 *  Read-only projection — no content is copied into the doc. */
export function insertSelfRef(view: EditorView, headingId: string): boolean {
  const entry = collectHeadings(view.state.doc, { skipCite: true }).find((h) => h.id === headingId);
  if (!entry) return false;
  const label = `↳ ${entry.text?.trim() || 'Section'}`;
  const node = createSelfRefNode(view.state.schema, headingId, label);
  const { $from, from } = view.state.selection;
  // If the cursor sits inside a linked copy, a live view dropped there would stack
  // two rails (a nested transclusion updating from a different source). Shunt it
  // out to just after the enclosing zone — mirrors how the linked-copy insert
  // escapes to the top level (`insertZoneAtSelection`).
  const zonePos = enclosingZonePos(view.state.doc, $from.pos);
  if (zonePos !== null) {
    const zone = view.state.doc.nodeAt(zonePos);
    const insertPos = zonePos + (zone?.nodeSize ?? 0);
    let tr = view.state.tr.insert(insertPos, node);
    try {
      tr = tr.setSelection(NodeSelection.create(tr.doc, insertPos));
    } catch {
      /* selection placement is best-effort */
    }
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }
  const tr = view.state.tr.replaceSelectionWith(node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size))));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Re-point the `self_ref` at `pos` to a different section. */
export function repointSelfRef(view: EditorView, pos: number, headingId: string): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isSelfRef(node)) return false;
  const entry = collectHeadings(view.state.doc, { skipCite: true }).find((h) => h.id === headingId);
  if (!entry) return false;
  const label = `↳ ${entry.text?.trim() || 'Section'}`;
  view.dispatch(
    view.state.tr.setNodeMarkup(pos, undefined, { source_heading_id: headingId, source_label: label }),
  );
  return true;
}

/** Scroll to (and place the cursor at) the mirrored source heading. */
export function jumpToSelfRefSource(view: EditorView, headingId: string): boolean {
  const entry = collectHeadings(view.state.doc, { skipCite: true }).find((h) => h.id === headingId);
  if (!entry) return false;
  try {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, entry.pos + 1)));
    view.focus();
  } catch {
    /* position shifted — still try to scroll */
  }
  try {
    const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(headingId) : headingId;
    const target = view.dom.querySelector<HTMLElement>(`[data-id="${sel}"]`);
    if (target) {
      preciseScrollIntoView(view, target);
      return true;
    }
    const at = view.domAtPos(entry.pos);
    let el: Node | null = at.node;
    while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;
    if (el instanceof HTMLElement) preciseScrollIntoView(view, el);
  } catch {
    /* not laid out — the selection alone lands near it */
  }
  return true;
}

/** Unlink: freeze the current projection into real, editable cards in place and
 *  stop tracking. The projected content is a copy of live content, so its
 *  heading ids are re-stamped fresh to preserve doc-wide uniqueness. */
export function unlinkSelfRef(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isSelfRef(node)) return false;
  const headingId = String(node.attrs['source_heading_id'] ?? '');
  const projection = resolveSelfProjection(view.state.doc, headingId);
  const content = rewriteHeadingIdsInFragment(projection.content, newHeadingId);
  const tr = content.size
    ? view.state.tr.replaceWith(pos, pos + node.nodeSize, content)
    : view.state.tr.delete(pos, pos + node.nodeSize); // empty/missing source → just remove
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Delete the window node. */
export function deleteSelfRef(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isSelfRef(node)) return false;
  view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
  view.focus();
  return true;
}

/** Minimal floating picker of THIS doc's headings. Shared by insert (cursor at
 *  `guardPos`) and re-pick (the window at `guardPos`). Skips empty headings and
 *  the section that contains `guardPos` (mirroring your own container is an
 *  immediate cycle — deeper cycles are caught at render). Self-contained. */
export function openSelfRefPicker(
  view: EditorView,
  opts: { title: string; guardPos: number },
  onPick: (headingId: string) => void,
): void {
  const doc = view.state.doc;
  const options = collectHeadings(doc, { skipCite: true }).filter((h) => {
    if (!h.id || h.zonePos !== null || !h.text.trim()) return false;
    const section = resolveSelfProjection(doc, h.id);
    if (section.missing || section.content.size === 0) return false;
    const range = sectionRange(view, h.id); // cycle guard — don't mirror our own container
    if (range && opts.guardPos >= range.from && opts.guardPos <= range.to) return false;
    return true;
  });

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,0.28)';
  const box = document.createElement('div');
  box.style.cssText =
    'min-width:280px;max-width:min(460px,90vw);max-height:70vh;overflow:auto;' +
    'background:var(--pmd-color-surface,#fff);color:var(--pmd-color-text,#111);' +
    'border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.35);padding:10px 0';
  const title = document.createElement('div');
  title.textContent = opts.title;
  title.style.cssText = 'padding:6px 16px 8px;font-weight:600;font-size:13px;opacity:0.8';
  box.appendChild(title);

  const close = (): void => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  if (!options.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No eligible sections in this document.';
    empty.style.cssText = 'padding:8px 16px;opacity:0.7;font-size:13px';
    box.appendChild(empty);
  }
  for (const h of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = h.text.trim();
    btn.style.cssText =
      `display:block;width:100%;text-align:left;border:0;background:none;cursor:pointer;` +
      `font:inherit;color:inherit;padding:6px 16px 6px ${16 + Math.max(0, h.level - 1) * 14}px`;
    btn.addEventListener('mouseenter', () => (btn.style.background = 'rgba(127,127,127,0.14)'));
    btn.addEventListener('mouseleave', () => (btn.style.background = 'none'));
    btn.addEventListener('click', () => {
      close();
      onPick(h.id!);
      view.focus();
    });
    box.appendChild(btn);
  }

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey, true);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

/** Insert: pick a section of this doc to mirror; drop a window at the cursor. */
export function openInsertSelfRef(view: EditorView): void {
  openSelfRefPicker(
    view,
    { title: 'Live view of a section of this document', guardPos: view.state.selection.from },
    (headingId) => insertSelfRef(view, headingId),
  );
}

/** Insert an in-doc LINKED COPY (editable snapshot) of the section under
 *  `headingId`. Unlike a live view, this bakes the content in and is
 *  refreshable. */
export function insertInDocCopy(view: EditorView, headingId: string): boolean {
  const outcome = buildInDocCopyAttrs(view.state.doc, headingId);
  if (!outcome.ok || !outcome.attrs) {
    showToast(buildZoneErrorMessage(outcome.reason));
    return false;
  }
  return insertZoneAtSelection(view, outcome.attrs, outcome.content);
}

/** Insert-copy: pick a section of this doc, drop an editable linked copy. */
export function openInsertInDocCopy(view: EditorView): void {
  openSelfRefPicker(
    view,
    { title: 'Copy a section of this document (linked)', guardPos: view.state.selection.from },
    (headingId) => insertInDocCopy(view, headingId),
  );
}

/** Re-pick: re-point an existing window to a different section. */
export function openRepickSelfRef(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isSelfRef(node)) return;
  openSelfRefPicker(
    view,
    { title: 'Re-point this live view to a section of this document', guardPos: pos },
    (headingId) => repointSelfRef(view, pos, headingId),
  );
}

export { SELF_REF_NODE };
