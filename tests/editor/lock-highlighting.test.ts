/**
 * Lock Highlighting — converts a card body's highlights to the protected
 * gray shading in place, freeing the highlight layer. Unlike Create
 * Reference it never grays the text, never resizes it, and leaves existing
 * shading alone.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { lockHighlighting } from '../../src/editor/create-reference.js';

const { nodes, marks } = schema;
const GRAY = 'C0C0C0';

function tag(text: string) {
  return nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function body(...inline: PMNode[]) {
  return nodes['card_body']!.create(null, inline);
}
function card(...children: PMNode[]) {
  return nodes['card']!.createChecked(null, children);
}
function doc(...children: PMNode[]) {
  return nodes['doc']!.createChecked(null, children);
}
const t = (text: string, ...m: Mark[]) => schema.text(text, m);
const hl = (color = 'yellow'): Mark => marks['highlight']!.create({ color });

/** Select the full content of the first node of `typeName`. */
function selectContentOf(d: PMNode, typeName: string): EditorState {
  let from = -1;
  let to = -1;
  d.descendants((n, p) => {
    if (from === -1 && n.type.name === typeName) {
      from = p + 1;
      to = p + n.nodeSize - 1;
    }
  });
  const s = EditorState.create({ doc: d });
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, from, to)));
}

/** Place a collapsed cursor inside the first node of `typeName`. */
function cursorIn(d: PMNode, typeName: string): EditorState {
  let pos = -1;
  d.descendants((n, p) => {
    if (pos === -1 && n.type.name === typeName) pos = p + 1;
  });
  const s = EditorState.create({ doc: d });
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, pos)));
}

/** The first text run inside the first node of `parentType`. */
function firstRunIn(d: PMNode, parentType: string): PMNode {
  let found: PMNode | null = null;
  d.descendants((n, _p, parent) => {
    if (found) return false;
    if (n.isText && parent?.type.name === parentType) found = n;
    return true;
  });
  if (!found) throw new Error(`no ${parentType} text run`);
  return found;
}

function run(state: EditorState, cmd: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}

/** The first text node in the first card_body, with its mark info. */
function firstBodyRun(d: PMNode): PMNode {
  let found: PMNode | null = null;
  d.descendants((n, _p, parent) => {
    if (found) return false;
    if (n.isText && parent?.type.name === 'card_body') found = n;
    return true;
  });
  if (!found) throw new Error('no card_body text run');
  return found;
}
const markNames = (n: PMNode): string[] => n.marks.map((m) => m.type.name).sort();
const shadingColor = (n: PMNode): string | undefined =>
  n.marks.find((m) => m.type.name === 'shading')?.attrs['color'] as string | undefined;

describe('lockHighlighting', () => {
  it('converts highlight to gray shading in place, dropping the highlight', () => {
    const d = doc(card(tag('T'), body(t('read', hl()), t(' rest'))));
    const next = run(selectContentOf(d, 'card_body'), lockHighlighting());
    expect(next).not.toBeNull();
    const runNode = firstBodyRun(next!.doc);
    expect(runNode.text).toBe('read');
    expect(markNames(runNode)).toEqual(['shading']);
    expect(shadingColor(runNode)).toBe(GRAY);
  });

  it('never grays the text and never changes font size', () => {
    const sized = marks['font_size']!.create({ halfPoints: 24 });
    const d = doc(card(tag('T'), body(schema.text('read', [hl(), sized]))));
    const next = run(selectContentOf(d, 'card_body'), lockHighlighting());
    const runNode = firstBodyRun(next!.doc);
    // No font_color added; font_size preserved unchanged.
    expect(runNode.marks.some((m) => m.type.name === 'font_color')).toBe(false);
    const fs = runNode.marks.find((m) => m.type.name === 'font_size');
    expect(fs?.attrs['halfPoints']).toBe(24);
    expect(markNames(runNode)).toEqual(['font_size', 'shading']);
  });

  it('preserves other formatting marks on the run', () => {
    const bold = marks['bold']!.create();
    const d = doc(card(tag('T'), body(schema.text('read', [hl(), bold]))));
    const next = run(selectContentOf(d, 'card_body'), lockHighlighting());
    expect(markNames(firstBodyRun(next!.doc))).toEqual(['bold', 'shading']);
  });

  it('leaves an existing shading mark untouched (drops only the highlight)', () => {
    const shaded = marks['shading']!.create({ color: 'FF0000' });
    const d = doc(card(tag('T'), body(schema.text('read', [hl(), shaded]))));
    const next = run(selectContentOf(d, 'card_body'), lockHighlighting());
    const runNode = firstBodyRun(next!.doc);
    expect(markNames(runNode)).toEqual(['shading']);
    expect(shadingColor(runNode)).toBe('FF0000'); // not overwritten to gray
  });

  it('no-ops when the card body has no highlights', () => {
    const d = doc(card(tag('T'), body(t('plain text'))));
    expect(run(selectContentOf(d, 'card_body'), lockHighlighting())).toBeNull();
  });

  it('with a selection, locks across the tag and body (selection-scoped)', () => {
    const d = doc(card(schema.nodes['tag']!.create({ id: newHeadingId() }, t('TAG', hl())), body(t('read', hl()))));
    // Select from inside the tag through the body.
    let tagFrom = -1;
    let bodyTo = -1;
    d.descendants((n, p) => {
      if (n.type.name === 'tag') tagFrom = p + 1;
      if (n.type.name === 'card_body') bodyTo = p + n.nodeSize - 1;
    });
    const s = EditorState.create({ doc: d });
    const state = s.apply(s.tr.setSelection(TextSelection.create(s.doc, tagFrom, bodyTo)));
    const next = run(state, lockHighlighting());
    expect(next).not.toBeNull();
    expect(markNames(firstRunIn(next!.doc, 'tag'))).toEqual(['shading']);
    expect(markNames(firstRunIn(next!.doc, 'card_body'))).toEqual(['shading']);
  });

  it('with no selection, locks the whole enclosing card (tag included)', () => {
    const d = doc(
      card(schema.nodes['tag']!.create({ id: newHeadingId() }, t('TAG', hl())), body(t('read', hl()))),
    );
    // Cursor in the body, no selection → whole card is scoped.
    const next = run(cursorIn(d, 'card_body'), lockHighlighting());
    expect(next).not.toBeNull();
    expect(shadingColor(firstRunIn(next!.doc, 'tag'))).toBe(GRAY);
    expect(shadingColor(firstRunIn(next!.doc, 'card_body'))).toBe(GRAY);
  });

  it('with no selection, no-ops when the cursor is not in a card (a pocket)', () => {
    // Must NOT lock a whole block/hat/pocket — only cards are card-scoped.
    const d = doc(schema.nodes['pocket']!.create({ id: newHeadingId() }, t('read', hl())));
    expect(run(cursorIn(d, 'pocket'), lockHighlighting())).toBeNull();
  });

  it('with no selection, locks the enclosing analytic_unit', () => {
    const d = doc(
      schema.nodes['analytic_unit']!.createChecked(null, [
        schema.nodes['analytic']!.create({ id: newHeadingId() }, t('point', hl())),
      ]),
    );
    const next = run(cursorIn(d, 'analytic'), lockHighlighting());
    expect(next).not.toBeNull();
    expect(shadingColor(firstRunIn(next!.doc, 'analytic'))).toBe(GRAY);
  });
});
