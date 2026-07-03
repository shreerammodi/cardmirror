/**
 * Dispatch the doc-repair pass through a live view (both peers run it
 * after a merge; determinism + idempotence make them converge). Test
 * plumbing only — production wiring dispatches with sync/normalizer
 * metas via the session layer.
 */

import type { EditorView } from 'prosemirror-view';
import { buildDocRepairTr } from '../../src/doc-repair.js';

export function repairView(view: EditorView): boolean {
  const tr = buildDocRepairTr(view.state);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}
