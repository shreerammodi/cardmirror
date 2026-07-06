/**
 * Live zones flatten to their cached content on .docx export, dropping the
 * transclusion identity (TRANSCLUSION_PLAN.md §10). The .cmir path preserves
 * the node (covered in tests/editor/transclusion.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { exportDoc } from '../../src/export/index.js';
import { extractSection, createTransclusionNode } from '../../src/editor/transclusion.js';

function heading(type: string, text: string, id: string): PMNode {
  return schema.nodes[type]!.create({ id }, text ? schema.text(text) : undefined);
}
function body(text: string): PMNode {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}
function card(tagText: string, bodyText: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    heading('tag', tagText, newHeadingId()),
    body(bodyText),
  ]);
}
function doc(children: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, children);
}

/** Build a source doc, extract a block section, and return a zone node whose
 *  cache is that section. */
function zoneFor(sourceChildren: PMNode[], headingId: string): PMNode {
  const src = doc(sourceChildren);
  const section = extractSection(src, headingId);
  return createTransclusionNode(schema, {
    source_ref: '../Impacts/Src.cmir',
    source_heading_id: headingId,
    content_hash: section?.contentHash ?? '',
    cached_content: section?.cachedContent ?? null,
    source_label: 'Src to Block',
  });
}

describe('docx flatten', () => {
  it('emits the cached cards as ordinary content; drops the zone identity', () => {
    const blockId = 'src-block';
    const zone = zoneFor(
      [heading('block', 'Category Header', blockId), card('First Tag', 'first evidence'), card('Second Tag', 'second evidence')],
      blockId,
    );
    const d = doc([heading('block', 'My Own Header', newHeadingId()), zone]);
    const { documentXml } = exportDoc(d);

    // The cached cards' text is present (flattened into the doc).
    expect(documentXml).toContain('First Tag');
    expect(documentXml).toContain('first evidence');
    expect(documentXml).toContain('Second Tag');
    expect(documentXml).toContain('second evidence');
    // The author's own header is present.
    expect(documentXml).toContain('My Own Header');
    // The excluded source category header is NOT present.
    expect(documentXml).not.toContain('Category Header');
    // No trace of the transclusion identity in the output.
    expect(documentXml).not.toContain('transclusion');
    expect(documentXml).not.toContain('Src.cmir');
    // Still a valid docx body.
    expect(documentXml).toContain('<w:body>');
    expect(documentXml).toContain('</w:document>');
  });

  it('an empty / unresolved zone emits nothing (no crash, valid doc)', () => {
    const zone = createTransclusionNode(schema, {
      source_ref: '../gone.cmir',
      source_heading_id: 'missing',
      cached_content: null,
    });
    const d = doc([heading('block', 'Only Header', newHeadingId()), zone]);
    const { documentXml } = exportDoc(d);
    expect(documentXml).toContain('Only Header');
    expect(documentXml).toContain('</w:document>');
  });

  it('a malformed cache emits nothing rather than throwing', () => {
    const zone = schema.nodes['transclusion_ref']!.create({
      cached_content: [{ type: 'no_such_node_type' }],
    });
    const d = doc([zone, schema.nodes['paragraph']!.create(null, schema.text('after'))]);
    expect(() => exportDoc(d)).not.toThrow();
    const { documentXml } = exportDoc(d);
    expect(documentXml).toContain('after');
  });

  it('nested zones flatten too', () => {
    // Inner zone caches one card.
    const innerId = 'inner-block';
    const inner = zoneFor([heading('block', 'Inner Cat', innerId), card('Inner Tag', 'inner ev')], innerId);
    // Outer zone's cache contains the inner zone plus a plain card.
    const outer = createTransclusionNode(schema, {
      source_ref: '../a.cmir',
      source_heading_id: 'outer',
      cached_content: [inner.toJSON(), card('Outer Tag', 'outer ev').toJSON()],
    });
    const d = doc([outer]);
    const { documentXml } = exportDoc(d);
    expect(documentXml).toContain('inner ev');
    expect(documentXml).toContain('outer ev');
    expect(documentXml).not.toContain('transclusion');
  });
});
