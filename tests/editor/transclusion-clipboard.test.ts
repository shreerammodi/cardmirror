/**
 * Clipboard handling for live zones. Any zone content on the clipboard pastes as
 * a PLAIN cached copy (its cards), never a live link — a partial in-zone copy
 * must not drag the whole zone's linkage along, and a paste can't nest a zone.
 * The flatten also corrects the slice's open depths so pasted headings keep their
 * formatting.
 */
import { describe, expect, it } from 'vitest';
import { Fragment, Node as PMNode, Slice } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  createTransclusionNode,
  contentHash,
  fragmentHasZone,
  flattenZones,
  flattenZonesInSlice,
  isTransclusionNode,
} from '../../src/editor/transclusion.js';
import { flattenNestedZones, dropEmptyZones } from '../../src/schema/migrate.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function zone(children: PMNode[]): PMNode {
  const content = Fragment.fromArray(children);
  return createTransclusionNode(
    schema,
    { source_ref: 'S.cmir', source_ref_base: 'doc', source_heading_id: 'H', source_content_hash: contentHash(content) },
    content,
  );
}
function count(frag: Fragment): { zones: number; cards: number } {
  let zones = 0;
  let cards = 0;
  const walk = (n: PMNode): void => {
    if (isTransclusionNode(n)) zones++;
    if (n.type.name === 'card') cards++;
    n.content.forEach(walk);
  };
  frag.forEach(walk);
  return { zones, cards };
}
function hasLiveRef(frag: Fragment): boolean {
  let found = false;
  const walk = (n: PMNode): void => {
    if (isTransclusionNode(n)) found = true;
    n.content.forEach(walk);
  };
  frag.forEach(walk);
  return found;
}

describe('clipboard live-zone handling', () => {
  it('fragmentHasZone detects a zone (and its absence)', () => {
    expect(fragmentHasZone(Fragment.fromArray([zone([card('A', 'a')])]))).toBe(true);
    expect(fragmentHasZone(Fragment.fromArray([card('A', 'a')]))).toBe(false);
  });

  it('a whole-zone slice pastes as plain cached cards (no live link)', () => {
    const s = new Slice(Fragment.fromArray([zone([card('A', 'a'), card('B', 'b')])]), 0, 0);
    const out = flattenZonesInSlice(s);
    expect(count(out.content)).toEqual({ zones: 0, cards: 2 });
    expect(hasLiveRef(out.content)).toBe(false);
    const text = out.content.textBetween(0, out.content.size, ' ');
    expect(text).toContain('a');
    expect(text).toContain('b');
  });

  it('a partial in-zone copy pastes plain and keeps the cards fully formed', () => {
    // A within-zone copy captures the cards it overlaps, with no zone wrapper and
    // no lingering link — refreshing the source can never reach this pasted copy.
    const s = new Slice(Fragment.fromArray([card('C', 'c'), zone([card('Z', 'z-ev')])]), 0, 0);
    const out = flattenZonesInSlice(s);
    expect(count(out.content)).toEqual({ zones: 0, cards: 2 });
    expect(hasLiveRef(out.content)).toBe(false);
    expect(out.content.textBetween(0, out.content.size, ' ')).toContain('z-ev');
  });

  it('drops one open level when a leading/trailing zone wrapper is stripped', () => {
    // When the captured slice opens (or closes) inside an edge zone, removing that
    // wrapper node must decrement the matching open depth — otherwise the pasted
    // headings land one level too deep and lose their formatting.
    const s = new Slice(Fragment.fromArray([zone([card('A', 'a')])]), 1, 1);
    const out = flattenZonesInSlice(s);
    expect(out.openStart).toBe(0);
    expect(out.openEnd).toBe(0);
    expect(count(out.content)).toEqual({ zones: 0, cards: 1 });
  });

  it('leaves open depths untouched when the edges are not zones', () => {
    const s = new Slice(Fragment.fromArray([card('C', 'c'), zone([card('Z', 'z-ev')]), card('D', 'd')]), 1, 1);
    const out = flattenZonesInSlice(s);
    expect(out.openStart).toBe(1);
    expect(out.openEnd).toBe(1);
    expect(count(out.content)).toEqual({ zones: 0, cards: 3 });
  });

  it('flattenZones unwraps a nested zone to plain content', () => {
    const inner = zone([card('Inner', 'inner-ev')]);
    const flat = flattenZones(Fragment.fromArray([card('C', 'c'), inner]));
    expect(count(flat)).toEqual({ zones: 0, cards: 2 });
    expect(flat.textBetween(0, flat.size, ' ')).toContain('inner-ev');
  });

  it('dropEmptyZones (load migration) removes a zero-content zone, keeps the rest', () => {
    const empty = createTransclusionNode(
      schema,
      { source_ref: 'S.cmir', source_ref_base: 'doc', source_heading_id: 'H', source_content_hash: 'x' },
      Fragment.empty,
    );
    const full = zone([card('A', 'a-ev')]);
    const doc = schema.nodes['doc']!.create(null, [full, empty, card('Sib', 's-ev')]);
    const healed = dropEmptyZones(doc);
    let zones = 0;
    healed.descendants((n) => {
      if (isTransclusionNode(n)) zones++;
      return true;
    });
    expect(zones).toBe(1); // the empty one is gone, the populated one stays
    expect(healed.textContent).toContain('a-ev');
    expect(healed.textContent).toContain('s-ev');
  });

  it('dropEmptyZones is a no-op when every zone has content (returns same node)', () => {
    const doc = schema.nodes['doc']!.create(null, [zone([card('A', 'a-ev')]), card('B', 'b-ev')]);
    expect(dropEmptyZones(doc)).toBe(doc);
  });

  it('flattenNestedZones (load migration) unwraps a zone-in-zone, keeping the outer', () => {
    const inner = zone([card('Inner', 'inner-ev')]);
    const outer = zone([card('C', 'c'), inner]); // a zone containing a nested zone
    const migrated = flattenNestedZones(schema.nodes['doc']!.create(null, [outer, card('Sib', 's')]));
    let zones = 0;
    migrated.descendants((n) => {
      if (isTransclusionNode(n)) zones++;
      return true;
    });
    expect(zones).toBe(1); // only the outer zone survives
    expect(migrated.textContent).toContain('inner-ev');
  });
});
