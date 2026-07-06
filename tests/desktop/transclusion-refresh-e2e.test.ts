// @vitest-environment node
/**
 * End-to-end refresh DATA path over a real filesystem: write a source `.cmir`,
 * resolve a relative ref through the desktop path-safety layer, read + gunzip +
 * parse it, and extract the section. Everything the `host:read-cmir-file`
 * handler does except the Electron IPC transport (boilerplate).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { serializeNative, parseNative } from '../../src/native/index.js';
import { extractSection } from '../../src/editor/transclusion.js';
import { resolveCmirCandidates } from '../../apps/desktop/src/transclusion-path.js';

function heading(type: string, text: string, id: string): PMNode {
  return schema.nodes[type]!.create({ id }, schema.text(text));
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

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'cardmirror-transclusion-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Simulate the handler: resolve candidates, read the first that exists, parse,
 *  extract the section under `headingId`. */
function refresh(
  docPath: string,
  sourceRef: string,
  base: 'doc' | 'root',
  roots: string[],
  headingId: string,
) {
  const candidates = resolveCmirCandidates(docPath, sourceRef, base, roots);
  for (const abs of candidates) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch {
      continue;
    }
    const parsed = parseNative(new Uint8Array(bytes)).doc;
    return extractSection(parsed, headingId);
  }
  return { candidates, unreadable: true } as const;
}

describe('refresh data path over real files', () => {
  it('root-relative ref resolves, reads, parses, and extracts the section', () => {
    const impacts = path.join(root, 'Impacts');
    mkdirSync(impacts);
    const srcPath = path.join(impacts, 'Src.cmir');
    writeFileSync(srcPath, serializeNative(doc([heading('block', 'Warming', 'wid'), card('T1', 'e1'), card('T2', 'e2')])));

    const docPath = path.join(root, 'Speeches', '1AC.cmir'); // need not exist on disk
    const section = refresh(docPath, 'Impacts/Src.cmir', 'root', [root], 'wid');
    expect(section && 'cachedContent' in section).toBe(true);
    const s = section as ReturnType<typeof extractSection>;
    expect(s!.cachedContent!.length).toBe(2);
    expect(JSON.stringify(s!.cachedContent)).toContain('e1');
    // header excluded
    expect(JSON.stringify(s!.cachedContent)).not.toContain('Warming');
  });

  it('doc-relative ref (../Impacts/Src.cmir) resolves the same file', () => {
    const impacts = path.join(root, 'Impacts');
    mkdirSync(impacts);
    writeFileSync(path.join(impacts, 'Src.cmir'), serializeNative(doc([heading('block', 'W', 'wid'), card('T', 'ev')])));
    const docPath = path.join(root, 'Speeches', '1AC.cmir');
    const section = refresh(docPath, '../Impacts/Src.cmir', 'doc', [root], 'wid');
    expect((section as ReturnType<typeof extractSection>)!.cachedContent!.length).toBe(1);
  });

  it('a traversal ref cannot read a file outside the root (defense in depth)', () => {
    // Plant a file OUTSIDE the root and try to reach it.
    const outside = mkdtempSync(path.join(os.tmpdir(), 'cardmirror-outside-'));
    writeFileSync(path.join(outside, 'secret.cmir'), serializeNative(doc([heading('block', 'S', 'sid'), card('T', 'secret')])));
    const docPath = path.join(root, 'Speeches', '1AC.cmir');
    const rel = path.relative(path.dirname(docPath), path.join(outside, 'secret.cmir'));
    const out = refresh(docPath, rel, 'doc', [root], 'sid');
    // No candidates → unreadable; the secret is never read.
    expect('unreadable' in (out as object)).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it('a missing source file yields no candidates read (unreachable)', () => {
    const docPath = path.join(root, 'Speeches', '1AC.cmir');
    const out = refresh(docPath, 'Impacts/Gone.cmir', 'root', [root], 'wid');
    expect('unreadable' in (out as object)).toBe(true);
  });

  it('teammate machine: same root-relative ref, different absolute root', () => {
    // Emulate Bob: a different temp root, same internal structure + ref.
    const impacts = path.join(root, 'Impacts');
    mkdirSync(impacts);
    writeFileSync(path.join(impacts, 'Src.cmir'), serializeNative(doc([heading('block', 'W', 'wid'), card('T', 'shared ev')])));
    const bobDoc = path.join(root, 'Tournaments', 'R1', 'Doc.cmir');
    const section = refresh(bobDoc, 'Impacts/Src.cmir', 'root', [root], 'wid');
    expect(JSON.stringify((section as ReturnType<typeof extractSection>)!.cachedContent)).toContain('shared ev');
  });
});
