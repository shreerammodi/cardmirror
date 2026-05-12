import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import {
  computeMinHalfPoints,
  fontSizeClassPlugin,
} from '../../src/editor/font-size-class-plugin.js';
import { DecorationSet } from 'prosemirror-view';

const HP_4PT = 8;
const HP_8PT = 16;
const HP_11PT = 22;
const HP_13PT = 26;

function fontSize(hp: number) {
  return schema.marks['font_size']!.create({ halfPoints: hp });
}

function bodyPara(...children: ReturnType<typeof schema.text>[]) {
  return schema.nodes['card_body']!.create(null, children);
}

describe('font-size-class plugin (computeMinHalfPoints)', () => {
  it('uniform 4pt paragraph → min is 8 (4pt half-points)', () => {
    const p = bodyPara(schema.text('all small', [fontSize(HP_4PT)]));
    expect(computeMinHalfPoints(p)).toBe(HP_4PT);
  });

  it('paragraph with no font_size marks → caps at default 22 (11pt)', () => {
    const p = bodyPara(schema.text('default sized'));
    expect(computeMinHalfPoints(p)).toBe(HP_11PT);
  });

  it('mixed 4pt + 11pt (untagged) paragraph → min is 8', () => {
    const p = bodyPara(
      schema.text('small ', [fontSize(HP_4PT)]),
      schema.text('then default'),
    );
    expect(computeMinHalfPoints(p)).toBe(HP_4PT);
  });

  it('mixed 4pt + 11pt (explicitly tagged) paragraph → min is 8', () => {
    const p = bodyPara(
      schema.text('small ', [fontSize(HP_4PT)]),
      schema.text('larger', [fontSize(HP_11PT)]),
    );
    expect(computeMinHalfPoints(p)).toBe(HP_4PT);
  });

  it('uniformly larger-than-default (13pt) → caps at default 22', () => {
    // The function caps at DEFAULT_HALF_POINTS — only sizes smaller
    // than default cause a decoration to be emitted. Larger uniform
    // text gets no class, so reporting 22 here is the correct contract.
    const p = bodyPara(schema.text('big', [fontSize(HP_13PT)]));
    expect(computeMinHalfPoints(p)).toBe(HP_11PT);
  });

  it('empty paragraph → default 22', () => {
    const p = schema.nodes['card_body']!.create(null, []);
    expect(computeMinHalfPoints(p)).toBe(HP_11PT);
  });

  it('paragraph with multiple small sizes picks the smallest', () => {
    const p = bodyPara(
      schema.text('eight ', [fontSize(HP_8PT)]),
      schema.text('four ', [fontSize(HP_4PT)]),
      schema.text('eight again', [fontSize(HP_8PT)]),
    );
    expect(computeMinHalfPoints(p)).toBe(HP_4PT);
  });
});

// ---- Mixed-bare-text shrink suppression ----

function tag(t: string) {
  return schema.nodes['tag']!.create({ id: 'x' }, schema.text(t));
}
function card(...children: import('prosemirror-model').Node[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function makeDoc(children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function decorationsForBodyPara(
  para: import('prosemirror-model').Node,
): { class?: string; style?: string }[] {
  // Mount in a minimal doc and read the plugin's decoration set.
  const doc = makeDoc([card(tag('T'), para)]);
  const state = EditorState.create({ doc, plugins: [fontSizeClassPlugin] });
  const set = fontSizeClassPlugin.getState(state) as DecorationSet;
  let result: { class?: string; style?: string }[] = [];
  set.find().forEach((d) => {
    const spec = (d as unknown as { type: { attrs: { class?: string; style?: string } } }).type.attrs;
    result.push(spec);
  });
  return result;
}

describe('font-size-class plugin — mixed-bare-text decoration', () => {
  it('applies pmd-fs-shrunk when ALL text has explicit small font_size', () => {
    const p = bodyPara(
      schema.text('all 8pt body', [fontSize(HP_8PT)]),
    );
    const decos = decorationsForBodyPara(p);
    const shrunk = decos.find((d) => d.class === 'pmd-fs-shrunk');
    expect(shrunk).toBeDefined();
    expect(shrunk!.style).toContain('font-size: 8pt');
    // No bare text → no inline bare-protection decorations.
    expect(decos.find((d) => d.style?.includes('font-size: 11pt'))).toBeUndefined();
  });

  it('shrinks AND emits inline bare-protection decoration when bare text is mixed with shrunk text', () => {
    // After a condense merge (or a manual font_size selection), a
    // paragraph may end up with some bare text alongside text marked
    // 8pt. The plugin shrinks the paragraph's own font-size to 8pt
    // so 8pt-only lines collapse, and emits an inline decoration
    // over each bare range that pins it back to 11pt + the body
    // line-height — so mixed lines (or lines that wrap to contain
    // only bare text) still render at body size.
    const p = bodyPara(
      schema.text('plain bare text '), // no font_size mark
      schema.text('shrunk piece', [fontSize(HP_8PT)]),
    );
    const decos = decorationsForBodyPara(p);
    const shrunk = decos.find((d) => d.class === 'pmd-fs-shrunk');
    expect(shrunk).toBeDefined();
    expect(shrunk!.style).toContain('font-size: 8pt');
    const bare = decos.find((d) => d.style?.includes('font-size: 11pt'));
    expect(bare).toBeDefined();
    expect(bare!.style).toContain('line-height: var(--pmd-line-height)');
  });

  it('does NOT apply pmd-fs-shrunk for a fully-bare default-size paragraph (no marks)', () => {
    const p = bodyPara(schema.text('Lorem ipsum'));
    const decos = decorationsForBodyPara(p);
    expect(decos.find((d) => d.class === 'pmd-fs-shrunk')).toBeUndefined();
    expect(decos.find((d) => d.style?.includes('font-size: 11pt'))).toBeUndefined();
  });

  it('does NOT emit a bare-protection decoration for text carrying a named-style mark', () => {
    // Underline-marked text already gets its font-size pinned by
    // `.pmd-fs-shrunk .pmd-underline`, so an extra inline decoration
    // would be redundant (and would override the user's custom
    // --pmd-size-underline if they set one).
    const underline = schema.marks['underline_mark']!.create();
    const p = bodyPara(
      schema.text('underlined ', [underline]),
      schema.text('then 8pt', [fontSize(HP_8PT)]),
    );
    const decos = decorationsForBodyPara(p);
    expect(decos.find((d) => d.class === 'pmd-fs-shrunk')).toBeDefined();
    expect(decos.find((d) => d.style?.includes('font-size: 11pt'))).toBeUndefined();
  });
});
