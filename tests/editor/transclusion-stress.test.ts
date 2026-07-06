// @vitest-environment jsdom
/**
 * Stress / abuse coverage for live zones: real .cmir gzip round-trip, position
 * variants, schema enforcement, huge sections, unicode, id collisions, and
 * hostile cache shapes. If any of these throws or loses data, the feature is
 * not shippable.
 */
import { describe, expect, it } from 'vitest';
import { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { serializeNative, parseNative } from '../../src/native/index.js';
import {
  extractSection,
  createTransclusionNode,
  fragmentFromCache,
  detachSlice,
  hashFragmentJSON,
  isTransclusionNode,
  TRANSCLUSION_NODE,
} from '../../src/editor/transclusion.js';
import { populateZoneBody } from '../../src/editor/transclusion-nodeview.js';

function heading(type: string, text: string, id: string): PMNode {
  return schema.nodes[type]!.create({ id }, text ? schema.text(text) : undefined);
}
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function doc(children: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, children);
}
function findZone(d: PMNode): PMNode | null {
  let z: PMNode | null = null;
  d.descendants((n) => {
    if (isTransclusionNode(n)) z = n;
    return true;
  });
  return z;
}

describe('real .cmir gzip round-trip', () => {
  it('a doc with a live zone survives serializeNative → parseNative with cache intact', () => {
    const src = doc([heading('block', 'B', 'bid'), card('T1', 'e1'), card('T2', 'e2')]);
    const section = extractSection(src, 'bid')!;
    const zone = createTransclusionNode(schema, {
      source_ref: 'Impacts/Src.cmir',
      source_ref_base: 'root',
      source_heading_id: 'bid',
      content_hash: section.contentHash,
      cached_content: section.cachedContent,
      last_refreshed: 1720000000000,
      source_label: 'Src › B',
    });
    const d = doc([heading('block', 'Mine', newHeadingId()), zone, schema.nodes['paragraph']!.create()]);

    const bytes = serializeNative(d);
    const round = parseNative(bytes).doc;
    const z = findZone(round)!;
    expect(z).toBeTruthy();
    expect(z.attrs['source_ref']).toBe('Impacts/Src.cmir');
    expect(z.attrs['source_ref_base']).toBe('root');
    expect(z.attrs['source_heading_id']).toBe('bid');
    expect(z.attrs['content_hash']).toBe(section.contentHash);
    expect(z.attrs['last_refreshed']).toBe(1720000000000);
    const frag = fragmentFromCache(schema, z.attrs['cached_content']);
    expect(frag.childCount).toBe(2);
    expect(JSON.stringify(z.attrs['cached_content'])).toContain('e1');
  });

  it('zones at the start, middle, and end of a doc all round-trip', () => {
    const mk = () =>
      createTransclusionNode(schema, {
        source_heading_id: 'h',
        cached_content: [card('T', 'body').toJSON()],
      });
    const d = doc([
      mk(),
      schema.nodes['paragraph']!.create(null, schema.text('mid')),
      mk(),
      heading('block', 'B', newHeadingId()),
      mk(),
    ]);
    const round = parseNative(serializeNative(d)).doc;
    let zones = 0;
    round.descendants((n) => {
      if (isTransclusionNode(n)) zones++;
      return true;
    });
    expect(zones).toBe(3);
  });
});

describe('schema enforcement', () => {
  it('forbids a live zone inside a card (zones live only at the doc root)', () => {
    const zone = createTransclusionNode(schema, { cached_content: null });
    expect(() =>
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('T')),
        zone,
      ]),
    ).toThrow();
  });
});

describe('huge sections', () => {
  it('extracts, hashes, round-trips, and renders a 200-card section', () => {
    const cards: PMNode[] = [];
    for (let i = 0; i < 200; i++) cards.push(card(`Tag ${i}`, `evidence ${i}`));
    const src = doc([heading('block', 'Big', 'big'), ...cards]);
    const section = extractSection(src, 'big')!;
    expect(section.cachedContent!.length).toBe(200);
    expect(section.contentHash).not.toBe('empty');

    const zone = createTransclusionNode(schema, {
      source_heading_id: 'big',
      cached_content: section.cachedContent,
      content_hash: section.contentHash,
    });
    const round = parseNative(serializeNative(doc([zone]))).doc;
    expect(fragmentFromCache(schema, findZone(round)!.attrs['cached_content']).childCount).toBe(200);

    const target = document.createElement('div');
    const empty = populateZoneBody(target, schema, zone);
    expect(empty).toBe(false);
    expect(target.querySelectorAll('.pmd-card').length).toBe(200);
  });
});

describe('unicode + odd content', () => {
  it('preserves emoji / accents in headings and labels through extract + round-trip', () => {
    const src = doc([heading('block', 'Réchauffement 🌍 — «impact»', 'u'), card('Tág', 'évidence 日本語')]);
    const section = extractSection(src, 'u')!;
    expect(JSON.stringify(section.cachedContent)).toContain('日本語');
    const zone = createTransclusionNode(schema, {
      source_heading_id: 'u',
      cached_content: section.cachedContent,
      source_label: 'Fichier › Réchauffement 🌍',
    });
    const round = parseNative(serializeNative(doc([zone]))).doc;
    const z = findZone(round)!;
    expect(z.attrs['source_label']).toBe('Fichier › Réchauffement 🌍');
    expect(JSON.stringify(z.attrs['cached_content'])).toContain('évidence 日本語');
  });
});

describe('extraction edge cases', () => {
  it('heading at end of doc with nothing under it → empty cache', () => {
    const d = doc([card('T', 'x'), heading('block', 'End', 'end')]);
    const section = extractSection(d, 'end')!;
    expect(section.cachedContent).toBeNull();
  });

  it('duplicate heading ids: extraction is deterministic (first match)', () => {
    // Pathological (ids should be unique) but must not crash or be random.
    const d = doc([
      heading('block', 'First', 'dup'),
      card('A', 'aaa'),
      heading('block', 'Second', 'dup'),
      card('B', 'bbb'),
    ]);
    const a = extractSection(d, 'dup');
    const b = extractSection(d, 'dup');
    expect(a).not.toBeNull();
    expect(a!.contentHash).toBe(b!.contentHash); // stable, not random
    // First block's section is the cards up to the second block.
    expect(JSON.stringify(a!.cachedContent)).toContain('aaa');
    expect(JSON.stringify(a!.cachedContent)).not.toContain('bbb');
  });
});

describe('hostile cache shapes never throw', () => {
  it('extract/hash/detach/render all tolerate junk', () => {
    expect(() => hashFragmentJSON({ a: [1, 2, { b: null }] })).not.toThrow();
    expect(hashFragmentJSON([])).not.toBe('empty'); // empty array is not the null sentinel
    // detach a zone whose cache is garbage → empty slice, no throw.
    const bad = schema.nodes[TRANSCLUSION_NODE]!.create({ cached_content: [{ type: 'nope' }] });
    let slice;
    expect(() => {
      slice = detachSlice(schema, bad, newHeadingId);
    }).not.toThrow();
    expect(slice!.content.size).toBe(0);
    // render garbage → empty placeholder.
    const target = document.createElement('div');
    expect(() => populateZoneBody(target, schema, bad)).not.toThrow();
    expect(target.querySelector('[data-kind="empty"]')).toBeTruthy();
  });
});
