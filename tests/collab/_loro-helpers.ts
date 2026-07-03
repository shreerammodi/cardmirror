/**
 * Shared collab-test plumbing: Loro-bound EditorView peers over the real
 * schema, seed-doc builders, and PM inspection helpers. Prefixed `_` so
 * the vitest glob skips it. jsdom environment required (EditorView).
 */

import { EditorState, type Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode, Mark, MarkType } from 'prosemirror-model';
import { LoroDoc } from 'loro-crdt';
import { LoroSyncPlugin, updateLoroToPmState } from 'loro-prosemirror';
import { schema, newHeadingId } from '../../src/schema/index.js';

type SyncDoc = Parameters<typeof LoroSyncPlugin>[0]['doc'];

/** Flush loro-prosemirror's setTimeout(0) init + Loro's microtask events. */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function mkView(plugins: Plugin[]): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const state = EditorState.create({ schema, plugins });
  return new EditorView(el, { state });
}

function textStyleConfig() {
  return Object.fromEntries(
    Object.entries(schema.marks).map(([name, type]) => [
      name,
      { expand: type.spec.inclusive !== false ? ('after' as const) : ('none' as const) },
    ]),
  );
}

export interface LoroPeer {
  view: EditorView;
  ldoc: LoroDoc;
  doc(): PMNode;
  exportAll(): Uint8Array;
  import(blob: Uint8Array): void;
  destroy(): void;
}

/** N peers seeded with identical CRDT history (snapshot clone), each
 *  bound to its own EditorView — the bake-off adapter, loro-only. */
export async function createLoroPeers(seed: PMNode, n: number): Promise<LoroPeer[]> {
  const seedDoc = new LoroDoc();
  seedDoc.configTextStyle(textStyleConfig());
  updateLoroToPmState(seedDoc as SyncDoc, new Map(), EditorState.create({ doc: seed }));
  seedDoc.commit();
  const snapshot = seedDoc.export({ mode: 'snapshot' });
  const peers: LoroPeer[] = [];
  for (let i = 0; i < n; i++) {
    const ldoc = new LoroDoc();
    ldoc.import(snapshot);
    const view = mkView([LoroSyncPlugin({ doc: ldoc as SyncDoc })]);
    peers.push({
      view,
      ldoc,
      doc: () => view.state.doc,
      exportAll: () => {
        ldoc.commit();
        return ldoc.export({ mode: 'update' });
      },
      import: (blob) => {
        ldoc.import(blob);
      },
      destroy: () => view.destroy(),
    });
  }
  await settle();
  return peers;
}

/** Exchange full updates among all peers until quiescent. */
export async function syncAll(peers: LoroPeer[]): Promise<void> {
  for (let round = 0; round < 3; round++) {
    for (const a of peers) {
      for (const b of peers) {
        if (a !== b) b.import(a.exportAll());
      }
    }
    await settle();
  }
}

// --- seed docs ---

export function para(text: string): PMNode {
  return schema.nodes['paragraph']!.create(null, text ? [schema.text(text)] : []);
}

export function cardNode(tagText: string, bodyTexts: string[]): PMNode {
  return schema.nodes['card']!.create(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, tagText ? [schema.text(tagText)] : []),
    ...bodyTexts.map((t) =>
      schema.nodes['card_body']!.create(null, t ? [schema.text(t)] : []),
    ),
  ]);
}

export function tableNode(rows: number, cols: number, label = 'c'): PMNode {
  const rowNodes: PMNode[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: PMNode[] = [];
    for (let c = 0; c < cols; c++) {
      cells.push(schema.nodes['table_cell']!.create(null, [para(`${label}${r}${c}`)]));
    }
    rowNodes.push(schema.nodes['table_row']!.create(null, cells));
  }
  return schema.nodes['table']!.create(null, rowNodes);
}

export function docOf(...children: PMNode[]): PMNode {
  return schema.nodes['doc']!.create(null, children);
}

export function simpleDoc(text: string): PMNode {
  return docOf(para(text));
}

export function mixedDoc(): PMNode {
  return docOf(
    para('Resolved: the quick fox jumped over the lazy dog near the riverbank today.'),
    cardNode('Warming causes conflict', [
      'Rising temperatures drive resource scarcity and mass migration across borders.',
    ]),
    tableNode(2, 3),
    para('Second analytic paragraph with more evidence text to edit concurrently here.'),
  );
}

// --- inspection ---

/** Absolute [from, to) of the first occurrence of `text` within a
 *  textblock (searches concatenated block text, so mark-split runs
 *  still match). */
export function findText(d: PMNode, text: string): { from: number; to: number } {
  let result: { from: number; to: number } | null = null;
  d.descendants((node, pos) => {
    if (result) return false;
    if (node.isTextblock) {
      const idx = node.textContent.indexOf(text);
      if (idx >= 0) result = { from: pos + 1 + idx, to: pos + 1 + idx + text.length };
      return false;
    }
    return true;
  });
  if (!result) throw new Error(`findText: "${text}" not found`);
  return result;
}

/** True iff every text position in [from,to) carries the mark (attrs
 *  subset-matched when given). */
export function rangeFullyMarked(
  d: PMNode,
  from: number,
  to: number,
  markType: MarkType,
  attrs?: Record<string, unknown>,
): boolean {
  let ok = true;
  d.nodesBetween(from, to, (node) => {
    if (!node.isText || !ok) return !node.isText;
    const mark = markType.isInSet(node.marks);
    if (!mark) {
      ok = false;
      return false;
    }
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if ((mark.attrs as Record<string, unknown>)[k] !== v) {
          ok = false;
          return false;
        }
      }
    }
    return false;
  });
  return ok;
}

export function docText(d: PMNode): string {
  return d.textBetween(0, d.content.size, '\n', '');
}

export function addMarkOn(view: EditorView, text: string, mark: Mark): void {
  const r = findText(view.state.doc, text);
  view.dispatch(view.state.tr.addMark(r.from, r.to, mark));
}

export function typeAfter(view: EditorView, afterText: string, insert: string): void {
  const r = findText(view.state.doc, afterText);
  view.dispatch(view.state.tr.insertText(insert, r.to));
}

/** Per-table array of per-row effective column widths. */
export function tableShapes(d: PMNode): number[][] {
  const shapes: number[][] = [];
  d.descendants((node) => {
    if (node.type.name !== 'table') return true;
    const rows: number[] = [];
    node.forEach((row) => {
      let w = 0;
      row.forEach((cell) => {
        w += (cell.attrs['colspan'] as number) ?? 1;
      });
      rows.push(w);
    });
    shapes.push(rows);
    return false;
  });
  return shapes;
}
