/**
 * docId stamping/reading on raw `.cmir` bytes — must work over both the
 * new gzip-compressed container and legacy plaintext files, and stamping
 * must preserve the input's container format.
 */

import { describe, expect, it } from 'vitest';
import { readDocIdFromBytes, stampDocId } from '../src/docid.js';
import { serializeNative, parseNative } from '../src/native/index.js';
import { isGzip } from '../src/native/codec.js';
import { schema, newHeadingId } from '../src/schema/index.js';

function sampleBytes(): Uint8Array {
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Title')),
    schema.nodes['paragraph']!.create(null, schema.text('Body.')),
  ]);
  return serializeNative(doc); // gzip-compressed
}

function legacyPlaintext(): Uint8Array {
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['paragraph']!.create(null, schema.text('Legacy.')),
  ]);
  return new TextEncoder().encode(
    JSON.stringify({
      format: 'cardmirror-doc',
      formatVersion: 1,
      createdBy: 'CardMirror 0.1.0-alpha.12',
      createdAt: '2026-06-01T00:00:00.000Z',
      doc: doc.toJSON(),
    }),
  );
}

describe('docId on .cmir bytes', () => {
  it('reads null when absent, the value when present (compressed)', async () => {
    const bytes = sampleBytes();
    expect(await readDocIdFromBytes(bytes, 'cmir')).toBeNull();
    const stamped = await stampDocId(bytes, 'cmir', 'doc-123');
    expect(await readDocIdFromBytes(stamped, 'cmir')).toBe('doc-123');
  });

  it('keeps a compressed file compressed when stamping', async () => {
    const bytes = sampleBytes();
    expect(isGzip(bytes)).toBe(true);
    const stamped = await stampDocId(bytes, 'cmir', 'doc-123');
    expect(isGzip(stamped)).toBe(true);
    // The stamped file still parses and carries the docId.
    expect(parseNative(stamped).docId).toBe('doc-123');
  });

  it('keeps a legacy plaintext file plaintext when stamping', async () => {
    const bytes = legacyPlaintext();
    expect(isGzip(bytes)).toBe(false);
    expect(await readDocIdFromBytes(bytes, 'cmir')).toBeNull();
    const stamped = await stampDocId(bytes, 'cmir', 'legacy-9');
    expect(isGzip(stamped)).toBe(false);
    expect(stamped[0]).toBe(0x7b); // still `{`
    expect(await readDocIdFromBytes(stamped, 'cmir')).toBe('legacy-9');
    expect(parseNative(stamped).docId).toBe('legacy-9');
  });
});
