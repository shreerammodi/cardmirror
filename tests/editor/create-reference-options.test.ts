/**
 * Create Reference customization options — buildReferenceNodes, the
 * pure node builder behind the clipboard command. Covers the four
 * option axes: includeHeading, shrink/shrinkPt, highlightMode, and
 * useGray50 (plus the default composition of all of them).
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  buildReferenceNodes,
  referenceHeadingText,
  type CreateReferenceOptions,
} from '../../src/editor/create-reference.js';

const { nodes, marks } = schema;

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
const fs = (pt: number): Mark => marks['font_size']!.create({ halfPoints: pt * 2 });

/** Select the full content of the first card_body. */
function selectBody(d: PMNode): EditorState {
  let from = -1;
  let to = -1;
  d.descendants((n, p) => {
    if (from === -1 && n.type.name === 'card_body') {
      from = p + 1;
      to = p + n.nodeSize - 1;
    }
  });
  const s = EditorState.create({ doc: d });
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, from, to)));
}

const effectivePt = () => 11;

const DEFAULTS: CreateReferenceOptions = {
  includeHeading: true,
  delimiter: '<<',
  includeCite: true,
  customHeading: '',
  headingBold: false,
  headingItalic: false,
  headingEmphasized: false,
  headingUnderlined: false,
  shrink: true,
  shrinkPt: 3,
  highlightMode: 'shading',
  useGray50: false,
};

const markOf = (n: PMNode, name: string): Mark | undefined =>
  n.marks.find((m) => m.type.name === name);
const firstRun = (n: PMNode): PMNode => {
  let found: PMNode | null = null;
  n.descendants((c) => {
    if (!found && c.isText) found = c;
    return !found;
  });
  if (!found) throw new Error('no text run');
  return found;
};

describe('buildReferenceNodes options', () => {
  const simpleDoc = () => doc(card(tag('T'), body(t('read', hl()))));

  it('defaults: heading + shrunken, black, protected-grey body', () => {
    const out = buildReferenceNodes(selectBody(simpleDoc()), effectivePt, DEFAULTS);
    expect(out).not.toBeNull();
    expect(out!.map((n) => n.type.name)).toEqual(['paragraph', 'card_body']);
    // Heading: plain text, no marks (no cite on this card).
    expect(out![0]!.textContent).toBe('<<FOR REFERENCE>>');
    expect(firstRun(out![0]!).marks).toHaveLength(0);
    const run = firstRun(out![1]!);
    expect(markOf(run, 'font_size')?.attrs['halfPoints']).toBe(16); // 11pt − 3pt
    expect(markOf(run, 'font_color')?.attrs['color']).toBe('000000');
    expect(markOf(run, 'highlight')).toBeUndefined();
    expect(markOf(run, 'shading')?.attrs['color']).toBe('C0C0C0');
  });

  it('includeHeading off: body paragraphs only', () => {
    const out = buildReferenceNodes(selectBody(simpleDoc()), effectivePt, {
      ...DEFAULTS,
      includeHeading: false,
    });
    expect(out!.map((n) => n.type.name)).toEqual(['card_body']);
  });

  it('shrink off: existing font sizes kept, none added', () => {
    const d = doc(card(tag('T'), body(t('big', fs(14)), t(' plain'))));
    const out = buildReferenceNodes(selectBody(d), effectivePt, {
      ...DEFAULTS,
      shrink: false,
    });
    const [big, plain] = [...Array(2)].map((_, i) => out![1]!.child(i));
    expect(markOf(big!, 'font_size')?.attrs['halfPoints']).toBe(28); // untouched
    expect(markOf(plain!, 'font_size')).toBeUndefined(); // still no mark
  });

  it('shrinkPt is honored and floors at 1pt', () => {
    const out5 = buildReferenceNodes(selectBody(simpleDoc()), effectivePt, {
      ...DEFAULTS,
      shrinkPt: 5,
    });
    expect(markOf(firstRun(out5![1]!), 'font_size')?.attrs['halfPoints']).toBe(12); // 6pt
    const out20 = buildReferenceNodes(selectBody(simpleDoc()), effectivePt, {
      ...DEFAULTS,
      shrinkPt: 20,
    });
    expect(markOf(firstRun(out20![1]!), 'font_size')?.attrs['halfPoints']).toBe(2); // 1pt floor
  });

  it('highlightMode convert: background in the highlight\'s own color', () => {
    const d = doc(card(tag('T'), body(t('a', hl('yellow')), t('b', hl('cyan')))));
    const out = buildReferenceNodes(selectBody(d), effectivePt, {
      ...DEFAULTS,
      highlightMode: 'convert',
    });
    const [a, b] = [out![1]!.child(0), out![1]!.child(1)];
    expect(markOf(a!, 'highlight')).toBeUndefined();
    expect(markOf(a!, 'shading')?.attrs['color']).toBe('FFFF00');
    expect(markOf(b!, 'shading')?.attrs['color']).toBe('00FFFF');
  });

  it('highlightMode keep: highlight retained, no shading added', () => {
    const out = buildReferenceNodes(selectBody(simpleDoc()), effectivePt, {
      ...DEFAULTS,
      highlightMode: 'keep',
    });
    const run = firstRun(out![1]!);
    expect(markOf(run, 'highlight')?.attrs['color']).toBe('yellow');
    expect(markOf(run, 'shading')).toBeUndefined();
  });

  it('highlightMode remove: highlight stripped, no shading added', () => {
    const out = buildReferenceNodes(selectBody(simpleDoc()), effectivePt, {
      ...DEFAULTS,
      highlightMode: 'remove',
    });
    const run = firstRun(out![1]!);
    expect(markOf(run, 'highlight')).toBeUndefined();
    expect(markOf(run, 'shading')).toBeUndefined();
  });

  it('useGray50 colors the body but never the heading', () => {
    const out = buildReferenceNodes(selectBody(simpleDoc()), effectivePt, {
      ...DEFAULTS,
      useGray50: true,
    });
    expect(firstRun(out![0]!).marks).toHaveLength(0);
    expect(markOf(firstRun(out![1]!), 'font_color')?.attrs['color']).toBe('808080');
  });

  it('returns null on an empty selection', () => {
    const s = EditorState.create({ doc: simpleDoc() });
    expect(buildReferenceNodes(s, effectivePt, DEFAULTS)).toBeNull();
  });

  it('uses the cite from the card in the heading', () => {
    const cite = marks['cite_mark']!.create();
    const d = doc(card(tag('T'), body(t('Smith 24', cite), t(' read'))));
    const out = buildReferenceNodes(selectBody(d), effectivePt, DEFAULTS);
    expect(out![0]!.textContent).toBe('<<SMITH 24 FOR REFERENCE>>');
  });
});

describe('referenceHeadingText', () => {
  const H = { delimiter: '<<' as const, includeCite: true, customHeading: '' };

  it('default heading with and without a cite', () => {
    expect(referenceHeadingText('Smith 24', H)).toBe('<<SMITH 24 FOR REFERENCE>>');
    expect(referenceHeadingText('', H)).toBe('<<FOR REFERENCE>>');
  });

  it('honors the delimiter choice', () => {
    expect(referenceHeadingText('Smith 24', { ...H, delimiter: '[[' })).toBe(
      '[[SMITH 24 FOR REFERENCE]]',
    );
    expect(referenceHeadingText('Smith 24', { ...H, delimiter: '{' })).toBe(
      '{SMITH 24 FOR REFERENCE}',
    );
  });

  it('includeCite off drops the cite', () => {
    expect(referenceHeadingText('Smith 24', { ...H, includeCite: false })).toBe(
      '<<FOR REFERENCE>>',
    );
  });

  it('custom heading places the cite at %Cite% (any case)', () => {
    expect(
      referenceHeadingText('Smith 24', { ...H, customHeading: 'READ %Cite% LATER' }),
    ).toBe('<<READ SMITH 24 LATER>>');
    expect(
      referenceHeadingText('Smith 24', { ...H, customHeading: 'see %cite%' }),
    ).toBe('<<see SMITH 24>>');
  });

  it('custom heading without %Cite% prepends the cite', () => {
    expect(referenceHeadingText('Smith 24', { ...H, customHeading: 'ORIGINAL' })).toBe(
      '<<SMITH 24 ORIGINAL>>',
    );
  });

  it('custom heading with includeCite off empties the token cleanly', () => {
    expect(
      referenceHeadingText('Smith 24', {
        ...H,
        includeCite: false,
        customHeading: 'READ %Cite% LATER',
      }),
    ).toBe('<<READ LATER>>');
    // Token-only custom heading falls back to the default label
    // rather than emitting empty brackets.
    expect(
      referenceHeadingText('Smith 24', { ...H, includeCite: false, customHeading: '%Cite%' }),
    ).toBe('<<FOR REFERENCE>>');
  });
});

describe('buildReferenceNodes — heading marks', () => {
  const mkDoc = () => doc(card(tag('T'), body(t('read', hl()))));
  const headingRun = (opts: CreateReferenceOptions): PMNode => {
    const out = buildReferenceNodes(selectBody(mkDoc()), effectivePt, opts)!;
    return firstRun(out[0]!);
  };

  it('default: heading carries no bold/italic/emphasis/underline', () => {
    const run = headingRun(DEFAULTS);
    for (const m of ['bold', 'italic', 'emphasis_mark', 'underline_mark']) {
      expect(markOf(run, m)).toBeUndefined();
    }
  });

  it('bold and italic apply independently and together', () => {
    expect(markOf(headingRun({ ...DEFAULTS, headingBold: true }), 'bold')).toBeDefined();
    expect(markOf(headingRun({ ...DEFAULTS, headingItalic: true }), 'italic')).toBeDefined();
    const both = headingRun({ ...DEFAULTS, headingBold: true, headingItalic: true });
    expect(markOf(both, 'bold')).toBeDefined();
    expect(markOf(both, 'italic')).toBeDefined();
  });

  it('emphasized applies the emphasis mark; underlined applies the underline mark', () => {
    expect(markOf(headingRun({ ...DEFAULTS, headingEmphasized: true }), 'emphasis_mark')).toBeDefined();
    expect(markOf(headingRun({ ...DEFAULTS, headingUnderlined: true }), 'underline_mark')).toBeDefined();
  });

  it('emphasis wins when both emphasis and underline are set', () => {
    const run = headingRun({ ...DEFAULTS, headingEmphasized: true, headingUnderlined: true });
    expect(markOf(run, 'emphasis_mark')).toBeDefined();
    expect(markOf(run, 'underline_mark')).toBeUndefined();
  });

  it('heading marks do not leak onto the body paragraphs', () => {
    const out = buildReferenceNodes(selectBody(mkDoc()), effectivePt, {
      ...DEFAULTS,
      headingBold: true,
      headingUnderlined: true,
    })!;
    const bodyRun = firstRun(out[1]!); // out[0] is the heading, out[1] is a body paragraph
    expect(markOf(bodyRun, 'bold')).toBeUndefined();
    expect(markOf(bodyRun, 'underline_mark')).toBeUndefined();
  });
});
