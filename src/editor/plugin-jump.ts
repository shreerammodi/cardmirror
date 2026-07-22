/**
 * Shared jump resolution for plugin provenance tokens — used by
 * api.jumpToSource (local window) and the inbound /jump host.
 * Resolution order per spec 4.3: heading UUID, then text anchor.
 */
import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { collectHeadings } from './headings.js';
import { resolveDescriptor } from './learn-anchor.js';
import { parseSourceToken, type SourcePayload } from './plugin-source-token.js';
import type { JumpResult } from './plugin-api.js';

export function resolveJumpInView(view: EditorView, payload: SourcePayload): boolean {
  const { doc } = view.state;
  if (payload.headingId) {
    const entry = collectHeadings(doc, { skipCite: true }).find(
      (h) => h.id === payload.headingId,
    );
    if (entry) {
      select(view, entry.pos + 1);
      return true;
    }
  }
  if (payload.anchor) {
    const r = resolveDescriptor(doc, payload.anchor);
    if (r) {
      select(view, r.from);
      return true;
    }
  }
  return false;
}

function select(view: EditorView, pos: number): void {
  const tr = view.state.tr;
  tr.setSelection(TextSelection.create(tr.doc, Math.min(pos, tr.doc.content.size)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Resolve a token against THIS window's doc. 'not-mine' = valid token
 *  for a different docId (the caller escalates to the main-process
 *  broadcast). */
export function jumpToTokenInView(
  view: EditorView,
  currentDocId: string | null,
  token: string,
): JumpResult | 'not-mine' {
  const payload = parseSourceToken(token);
  if (!payload) return { ok: false, error: 'bad-request' };
  if (!currentDocId || currentDocId !== payload.docId) return 'not-mine';
  if (resolveJumpInView(view, payload)) return { ok: true };
  return { ok: false, error: 'not-found', docTitle: payload.docTitle };
}
