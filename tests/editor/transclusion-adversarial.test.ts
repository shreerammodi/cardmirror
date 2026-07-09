// @vitest-environment jsdom
/**
 * Adversarial transclusion probes — hand-crafted degenerate states the random
 * fuzzers rarely build, checking the resolution / flatten / round-trip paths stay
 * robust (no throw, no runaway, valid output): dangling & malformed source ids,
 * duplicate & non-heading targets, empty-section projections, mutual / self
 * cycles, very deep reference chains and structural nesting (stack depth), and
 * clipboard slices that cut through a zone.
 */
import { describe, it, expect } from 'vitest';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  isSelfRef,
  createSelfRefNode,
  resolveSelfProjection,
  flattenSelfRefs,
  flattenSelfRefsInSlice,
} from '../../src/editor/self-transclusion.js';
import { createTransclusionNode, isTransclusionNode, SELF_SOURCE_REF } from '../../src/editor/transclusion.js';
import { buildInDocCopyAttrs } from '../../src/editor/transclusion-actions.js';
import { computeNumbering } from '../../src/editor/numbering.js';
import { serializeNative, parseNative } from '../../src/native/index.js';
import { toDocx } from '../../src/export/index.js';
import { fromDocx } from '../../src/import/index.js';

const block = (text: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(text));
function card(tag: string, body: string, id = newHeadingId()): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
const doc = (children: PMNode[]): PMNode => schema.nodes['doc']!.createChecked(null, children);
const selfRef = (id: string): PMNode => createSelfRefNode(schema, id, '↳');
function copyOf(cards: PMNode[], sourceHeadingId = 'H'): PMNode {
  return createTransclusionNode(
    schema,
    { source_ref: 'S.cmir', source_ref_base: 'doc', source_heading_id: sourceHeadingId },
    Fragment.fromArray(cards),
  );
}
function countSelfRefs(d: PMNode): number {
  let n = 0;
  d.descendants((x) => {
    if (isSelfRef(x)) n++;
    return true;
  });
  return n;
}
/** Every robustness invariant that must hold on any doc. */
function assertRobust(d: PMNode, label: string): void {
  expect(() => d.check(), `${label}: valid`).not.toThrow();
  expect(() => computeNumbering(d), `${label}: numbering`).not.toThrow();
  d.descendants((n) => {
    if (isSelfRef(n)) {
      expect(() => resolveSelfProjection(d, String(n.attrs['source_heading_id'] ?? '')), `${label}: resolve`).not.toThrow();
    }
    return true;
  });
  expect(() => flattenSelfRefs(d, newHeadingId), `${label}: flatten`).not.toThrow();
  expect(countSelfRefs(flattenSelfRefs(d, newHeadingId)), `${label}: flatten drops views`).toBe(0);
  expect(() => parseNative(serializeNative(d)), `${label}: .cmir`).not.toThrow();
}

describe('adversarial — malformed / dangling source ids', () => {
  it('empty, whitespace, and non-existent source ids resolve to missing (no crash)', () => {
    for (const id of ['', '   ', 'does-not-exist', SELF_SOURCE_REF, '\n\t']) {
      const p = resolveSelfProjection(doc([block('B', 'b'), card('C', 'c'), selfRef(id)]), id);
      expect(p.missing || p.content.size === 0, `id="${id}"`).toBe(true);
    }
    const d = doc([block('B', 'b'), card('C', 'c'), selfRef(''), selfRef('nope'), selfRef('   ')]);
    assertRobust(d, 'dangling ids');
  });

  it('a source id pointing at a non-heading node does not crash', () => {
    // Point at a card_body / paragraph id-ish string that isn't a heading.
    const d = doc([block('B', 'b'), card('C', 'c'), selfRef('c'), selfRef('b')]);
    assertRobust(d, 'non-heading target');
  });
});

describe('adversarial — duplicate & ambiguous headings', () => {
  it('two headings sharing an id resolve deterministically without crashing', () => {
    const d = doc([
      block('Dup one', 'dup'),
      card('A', 'a-body'),
      block('Middle', 'mid'),
      block('Dup two', 'dup'),
      card('B', 'b-body'),
      block('End', 'end'),
      selfRef('dup'),
    ]);
    const p1 = resolveSelfProjection(d, 'dup');
    const p2 = resolveSelfProjection(d, 'dup');
    expect(p1.content.eq(p2.content), 'deterministic across calls').toBe(true);
    assertRobust(d, 'duplicate ids');
  });
});

describe('adversarial — empty / degenerate sections', () => {
  it('a heading with an empty section projects nothing', () => {
    const d = doc([block('Empty', 'empty'), block('Next', 'next'), card('C', 'c'), selfRef('empty')]);
    const p = resolveSelfProjection(d, 'empty');
    expect(p.missing).toBe(false);
    expect(p.content.size).toBe(0);
    // buildInDocCopyAttrs must refuse an empty section (no phantom copy).
    expect(buildInDocCopyAttrs(d, 'empty').ok).toBe(false);
    assertRobust(d, 'empty section');
  });

  it('a section made entirely of live views (no real content) is safe', () => {
    const d = doc([
      block('G', 'g'),
      card('GC', 'g-ev'),
      block('H', 'h'),
      selfRef('g'),
      selfRef('g'),
      selfRef('g'),
      block('End', 'end'),
      selfRef('h'),
    ]);
    assertRobust(d, 'views-only section');
  });
});

describe('adversarial — cycles', () => {
  it('a self-containing section (the heading references itself) terminates', () => {
    const d = doc([block('X', 'x'), card('C', 'c'), selfRef('x'), block('End', 'end')]);
    const p = resolveSelfProjection(d, 'x');
    expect(p.cycle).toBe(true);
    assertRobust(d, 'self-cycle');
  });

  it('a 3-way mutual cycle (A→B→C→A) terminates and drops the back-edge', () => {
    const d = doc([
      block('A', 'a'), card('CA', 'a-ev'), selfRef('b'),
      block('B', 'b'), card('CB', 'b-ev'), selfRef('c'),
      block('C', 'c'), card('CC', 'c-ev'), selfRef('a'),
      block('End', 'end'),
    ]);
    const p = resolveSelfProjection(d, 'a');
    expect(p.cycle).toBe(true);
    assertRobust(d, '3-cycle');
  });
});

describe('adversarial — extreme depth (stack safety)', () => {
  it('a very long reference chain (1000 links) resolves without overflow', () => {
    const kids: PMNode[] = [];
    const D = 1000;
    for (let k = 0; k < D; k++) {
      kids.push(block(`B${k}`, `b${k}`));
      kids.push(k < D - 1 ? selfRef(`b${k + 1}`) : card('Leaf', 'leaf-body'));
    }
    const d = doc(kids);
    const p = resolveSelfProjection(d, 'b0');
    expect(p.missing).toBe(false);
    // The chain bottoms out at the single leaf card.
    let bodies = 0;
    p.content.descendants((n) => {
      if (n.type.name === 'card_body') bodies++;
      return true;
    });
    expect(bodies).toBe(1);
    expect(() => flattenSelfRefs(d, newHeadingId)).not.toThrow();
  });

  it('a deeply nested copy chain (400 deep) flattens on load without overflow', () => {
    // Nested transclusion_ref — mimics an old/synced doc the editor wouldn't
    // produce; the load path (flattenNestedZones) collapses it.
    let node = card('Deep', 'deep-body');
    for (let k = 0; k < 400; k++) {
      node = createTransclusionNode(
        schema,
        { source_ref: 'S.cmir', source_ref_base: 'doc', source_heading_id: 'H' },
        Fragment.fromArray([node]),
      );
    }
    const built = schema.nodes['doc']!.create(null, [node]);
    expect(() => parseNative(serializeNative(built))).not.toThrow();
    const rt = parseNative(serializeNative(built)).doc;
    expect(() => rt.check()).not.toThrow();
    // The nesting collapsed: one top-level copy holding the leaf card.
    expect(rt.childCount).toBe(1);
    expect(isTransclusionNode(rt.child(0))).toBe(true);
    let inner = 0;
    rt.child(0).descendants((n) => {
      if (isTransclusionNode(n)) inner++;
      return true;
    });
    expect(inner, 'no nested copies remain').toBe(0);
  });
});

describe('adversarial — clipboard slices that cut a zone', () => {
  it('flattening a slice open through a copy containing a live view stays valid', () => {
    // A copy holding [card, self_ref→g, card]; slice from inside the first card to
    // inside the last, so openStart/openEnd cut INTO the copy.
    const src = doc([
      block('G', 'g'),
      card('GC', 'g-ev'),
      block('Home', 'home'),
      copyOf([card('First', 'first'), selfRef('g'), card('Last', 'last')]),
      block('End', 'end'),
    ]);
    // Locate positions inside the copy's first and last card bodies.
    let from = -1;
    let to = -1;
    src.descendants((n, pos) => {
      if (n.type.name === 'card_body') {
        if (n.textContent === 'first') from = pos + 1;
        if (n.textContent === 'last') to = pos + 1;
      }
      return true;
    });
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const slice = src.slice(from, to);
    const flat = flattenSelfRefsInSlice(slice, src, newHeadingId);
    // No live view survives, and the open depths are preserved as a valid Slice.
    let refs = 0;
    flat.content.descendants((n) => {
      if (isSelfRef(n)) refs++;
      return true;
    });
    expect(refs).toBe(0);
    expect(flat).toBeInstanceOf(Slice);
    // The flattened slice re-inserts cleanly (PM validates the replace).
    const target = doc([block('T', 't'), card('anchor', 'anchor-body')]);
    let bodyAt = -1;
    target.descendants((n, pos) => {
      if (bodyAt < 0 && n.type.name === 'card_body') bodyAt = pos + 1;
      return true;
    });
    expect(() => target.replace(bodyAt, bodyAt, flat)).not.toThrow();
    expect(() => target.replace(bodyAt, bodyAt, flat).check()).not.toThrow();
  });
});

describe('adversarial — round-trips of degenerate docs', () => {
  it('.docx round-trip of a doc full of cycles + dangling views (via the flatten path) is safe', async () => {
    const d = doc([
      block('A', 'a'), card('CA', 'a-ev', 'ta'), selfRef('b'), selfRef('missing'),
      block('B', 'b'), card('CB', 'b-ev', 'tb'), selfRef('a'),
      block('End', 'end'),
    ]);
    // The real export path flattens live views first (docx has no live-window
    // concept). That must resolve the cycles/dangles to plain cards, no crash.
    const exported = flattenSelfRefs(d, newHeadingId);
    expect(countSelfRefs(exported)).toBe(0);
    const rt = await fromDocx(await toDocx(exported));
    expect(rt).toBeTruthy();
  });
});
