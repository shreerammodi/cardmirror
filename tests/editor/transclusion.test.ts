/**
 * Transclusion core logic — extraction, hashing, relative paths, detach,
 * schema round-trip. Pure (no DOM / no Electron).
 */
import { describe, expect, it } from 'vitest';
import { Fragment, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  extractSection,
  hashFragmentJSON,
  relativeSourceRef,
  createTransclusionNode,
  detachSlice,
  fragmentFromCache,
  directZoneIdentities,
  zoneIdentity,
  TRANSCLUSION_NODE,
} from '../../src/editor/transclusion.js';

// --- doc builders -----------------------------------------------------------

function heading(type: string, text: string, id: string): PMNode {
  return schema.nodes[type]!.create({ id }, text ? schema.text(text) : undefined);
}
function body(text: string): PMNode {
  return schema.nodes['card_body']!.create(null, text ? schema.text(text) : undefined);
}
function card(tagText: string, tagId: string, bodyText = 'evidence'): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    heading('tag', tagText, tagId),
    body(bodyText),
  ]);
}
function doc(children: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, children);
}

// Fixture: P > B1 {c1,c2} > B2 {c3}
const idP = 'id-pocket';
const idB1 = 'id-block-1';
const idB2 = 'id-block-2';
const idT1 = 'id-tag-1';
const idT2 = 'id-tag-2';
const idT3 = 'id-tag-3';
function fixture(): PMNode {
  return doc([
    heading('pocket', 'P', idP),
    heading('block', 'B1', idB1),
    card('T1', idT1),
    card('T2', idT2),
    heading('block', 'B2', idB2),
    card('T3', idT3),
  ]);
}

describe('extractSection — the resolution rule', () => {
  it('block target: contents below the header, header excluded, stops at next equal level', () => {
    const res = extractSection(fixture(), idB1);
    expect(res).not.toBeNull();
    const content = res!.cachedContent!;
    // Two cards under B1, and NO block header node.
    expect(content.map((n) => (n as { type: string }).type)).toEqual(['card', 'card']);
    // The excluded header B1 does not appear.
    expect(JSON.stringify(content)).not.toContain('"B1"');
    // Stops before B2.
    expect(JSON.stringify(content)).not.toContain('"B2"');
    expect(JSON.stringify(content)).not.toContain('"T3"');
    // But the cards' OWN tags survive (they're sub-content, not the target).
    expect(JSON.stringify(content)).toContain('"T1"');
    expect(JSON.stringify(content)).toContain('"T2"');
  });

  it('tag target: the whole card, tagline included', () => {
    const res = extractSection(fixture(), idT1);
    expect(res).not.toBeNull();
    const content = res!.cachedContent!;
    expect(content.map((n) => (n as { type: string }).type)).toEqual(['card']);
    expect(JSON.stringify(content)).toContain('"T1"'); // tagline kept
    expect(JSON.stringify(content)).toContain('"evidence"');
    expect(JSON.stringify(content)).not.toContain('"T2"');
  });

  it('pocket target: everything under it, down to end of doc when no next pocket', () => {
    const res = extractSection(fixture(), idP);
    const s = JSON.stringify(res!.cachedContent);
    expect(s).toContain('"B1"');
    expect(s).toContain('"B2"');
    expect(s).toContain('"T3"');
    expect(s).not.toContain('"P"'); // header excluded
  });

  it('missing heading id → null', () => {
    expect(extractSection(fixture(), 'nonexistent')).toBeNull();
    expect(extractSection(fixture(), '')).toBeNull();
  });

  it('empty section → null cached content (not a crash)', () => {
    // A block with nothing under it, at end of doc.
    const d = doc([heading('block', 'Empty', 'id-empty')]);
    const res = extractSection(d, 'id-empty');
    expect(res).not.toBeNull();
    expect(res!.cachedContent).toBeNull();
    expect(res!.contentHash).toBe('empty');
  });
});

describe('hashFragmentJSON — stable + sensitive', () => {
  it('is deterministic for equal content', () => {
    const a = extractSection(fixture(), idB1)!;
    const b = extractSection(fixture(), idB1)!;
    expect(a.contentHash).toBe(b.contentHash);
  });
  it('changes when content changes', () => {
    const a = extractSection(fixture(), idB1)!;
    const c = extractSection(fixture(), idB2)!; // different section
    expect(a.contentHash).not.toBe(c.contentHash);
  });
  it('is insensitive to object key order (cross-machine safety)', () => {
    expect(hashFragmentJSON([{ a: 1, b: 2 }])).toBe(hashFragmentJSON([{ b: 2, a: 1 }]));
  });
  it('null/empty is a fixed sentinel', () => {
    expect(hashFragmentJSON(null)).toBe('empty');
  });
});

describe('relativeSourceRef — doc-relative, cross-machine portable', () => {
  it('sibling directory', () => {
    expect(relativeSourceRef('/a/b/Doc.cmir', '/a/c/Src.cmir')).toBe('../c/Src.cmir');
  });
  it('same directory', () => {
    expect(relativeSourceRef('/a/b/Doc.cmir', '/a/b/Src.cmir')).toBe('Src.cmir');
  });
  it('nested deeper', () => {
    expect(relativeSourceRef('/a/Doc.cmir', '/a/b/c/Src.cmir')).toBe('b/c/Src.cmir');
  });
  it('windows separators + drive', () => {
    expect(relativeSourceRef('C:\\Users\\x\\Dropbox\\Doc.cmir', 'C:\\Users\\x\\Dropbox\\Imp\\Src.cmir')).toBe('Imp/Src.cmir');
  });
  it('different drive → null (no portable ref)', () => {
    expect(relativeSourceRef('C:\\a\\Doc.cmir', 'D:\\a\\Src.cmir')).toBeNull();
  });
  it('resolving the ref back lands on the source (posix)', () => {
    // ../c/Src.cmir from /a/b/ === /a/c/Src.cmir
    const ref = relativeSourceRef('/a/b/Doc.cmir', '/a/c/Src.cmir')!;
    expect(ref).toBe('../c/Src.cmir');
  });
});

describe('schema round-trip through .cmir JSON', () => {
  it('a doc with a live zone survives toJSON → fromJSON with attrs intact', () => {
    const section = extractSection(fixture(), idB1)!;
    const zone = createTransclusionNode(schema, {
      source_ref: '../Impacts/Src.cmir',
      source_heading_id: idB1,
      content_hash: section.contentHash,
      cached_content: section.cachedContent,
      last_refreshed: 1720000000000,
      source_label: 'Src › B1',
    });
    const d = doc([heading('block', 'My header', 'id-mine'), zone]);
    const round = schema.nodeFromJSON(d.toJSON());
    let found: PMNode | null = null;
    round.descendants((n) => {
      if (n.type.name === TRANSCLUSION_NODE) found = n;
      return true;
    });
    expect(found).not.toBeNull();
    const f = found! as PMNode;
    expect(f.attrs['source_ref']).toBe('../Impacts/Src.cmir');
    expect(f.attrs['source_heading_id']).toBe(idB1);
    expect(f.attrs['content_hash']).toBe(section.contentHash);
    expect(f.attrs['last_refreshed']).toBe(1720000000000);
    expect(f.attrs['source_label']).toBe('Src › B1');
    // The cached fragment deserializes back to the two cards.
    const frag = fragmentFromCache(schema, f.attrs['cached_content']);
    expect(frag.childCount).toBe(2);
    expect(frag.child(0).type.name).toBe('card');
  });

  it('malformed cached_content never throws (returns empty fragment)', () => {
    expect(fragmentFromCache(schema, 'garbage').size).toBe(0);
    expect(fragmentFromCache(schema, { not: 'an array' }).size).toBe(0);
    expect(fragmentFromCache(schema, [{ type: 'no_such_node' }]).size).toBe(0);
    expect(fragmentFromCache(schema, null).size).toBe(0);
  });
});

describe('detachSlice — materialize with fresh ids', () => {
  it('replaces a zone with its cached cards, heading ids rewritten', () => {
    const section = extractSection(fixture(), idB1)!;
    const zone = createTransclusionNode(schema, {
      source_heading_id: idB1,
      cached_content: section.cachedContent,
      content_hash: section.contentHash,
    });
    let counter = 0;
    const slice = detachSlice(schema, zone, () => `fresh-${counter++}`);
    expect(slice.content.childCount).toBe(2);
    // Original source tag ids must NOT survive into the detached copy.
    const s = JSON.stringify(slice.content.toJSON());
    expect(s).not.toContain(idT1);
    expect(s).not.toContain(idT2);
    expect(s).toContain('fresh-0');
    expect(s).toContain('fresh-1');
  });

  it('empty cache → empty slice (zone just vanishes)', () => {
    const zone = createTransclusionNode(schema, { cached_content: null });
    const slice = detachSlice(schema, zone, () => 'x');
    expect(slice.content.size).toBe(0);
  });
});

describe('cycle identity helpers', () => {
  it('zoneIdentity encodes both source_ref and heading id', () => {
    const z = createTransclusionNode(schema, { source_ref: 'a.cmir', source_heading_id: 'h1' });
    const id = zoneIdentity(z);
    expect(id.includes('a.cmir')).toBe(true);
    expect(id.includes('h1')).toBe(true);
  });
  it('distinct (ref, heading) pairs get distinct identities; equal pairs match', () => {
    const a1 = createTransclusionNode(schema, { source_ref: 'a.cmir', source_heading_id: 'h1' });
    const a2 = createTransclusionNode(schema, { source_ref: 'a.cmir', source_heading_id: 'h1' });
    const b = createTransclusionNode(schema, { source_ref: 'a.cmir', source_heading_id: 'h2' });
    const c = createTransclusionNode(schema, { source_ref: 'b.cmir', source_heading_id: 'h1' });
    expect(zoneIdentity(a1)).toBe(zoneIdentity(a2));
    expect(zoneIdentity(a1)).not.toBe(zoneIdentity(b));
    expect(zoneIdentity(a1)).not.toBe(zoneIdentity(c));
  });
  it('directZoneIdentities finds top-level zones in a fragment', () => {
    const z1 = createTransclusionNode(schema, { source_ref: 'a.cmir', source_heading_id: 'h1' });
    const z2 = createTransclusionNode(schema, { source_ref: 'b.cmir', source_heading_id: 'h2' });
    const frag = Fragment.fromArray([z1, body('x'), z2]);
    const ids = directZoneIdentities(frag);
    expect(ids.has(zoneIdentity(z1))).toBe(true);
    expect(ids.has(zoneIdentity(z2))).toBe(true);
    expect(ids.size).toBe(2);
  });
});
