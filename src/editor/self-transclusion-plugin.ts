/**
 * Live re-render for `self_ref` windows.
 *
 * A window's NodeView projects the source section resolved from the CURRENT doc,
 * but `NodeView.update` only fires when the node itself or its decorations
 * change — not when some *other* part of the doc (the source section) is edited.
 * This plugin bridges that: on every doc change it hashes each window's resolved
 * projection and stamps it as a node decoration (`data-src-hash`). When a source
 * edit changes that hash, the decoration's attrs change, so ProseMirror calls
 * the NodeView's `update`, which re-resolves and re-renders. When nothing the
 * window mirrors changed, the hash is identical and no update fires — so
 * unrelated edits cost one hash, not a re-render.
 *
 * No document mutation, no history, no dirty flag — decorations only.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { contentHash } from './transclusion.js';
import { isSelfRef, makeProjectionResolver } from './self-transclusion.js';

export const selfRefPluginKey = new PluginKey<DecorationSet>('selfRefLiveRender');

function buildDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  // One resolver shared across every window (memoized — chained views resolve
  // once total, not once per window).
  const resolveProjection = makeProjectionResolver(doc);
  doc.descendants((node, pos) => {
    if (!isSelfRef(node)) return true;
    const p = resolveProjection(String(node.attrs['source_heading_id'] ?? ''));
    // The hash folds in the resolved content plus the missing/cycle state, so any
    // change the window should reflect flips it.
    const hash = `${p.missing ? 'M' : ''}${p.cycle ? 'C' : ''}:${contentHash(p.content)}`;
    decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-src-hash': hash }));
    return false; // atom — nothing to descend into
  });
  return DecorationSet.create(doc, decos);
}

export function makeSelfRefPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: selfRefPluginKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc),
      apply: (tr, value, _old, newState) =>
        tr.docChanged ? buildDecorations(newState.doc) : value,
    },
    props: {
      decorations(state) {
        return selfRefPluginKey.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}
