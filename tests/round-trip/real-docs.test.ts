/**
 * Round-trip tests against real Verbatim documents.
 *
 * Strategy:
 *   1. Import the example .docx file from reference-docs/example docs/.
 *   2. Verify the resulting schema doc has expected high-level structure.
 *   3. Re-export to .docx and re-import.
 *   4. Verify the round-tripped doc has the same structure as the first import.
 *
 * Per ARCHITECTURE.md §3, lossless round-trip means semantic equivalence
 * for everything Verbatim and Advanced Verbatim treat as semantic. We
 * don't promise byte equivalence (rsids, generation timestamps, etc.).
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fromDocx } from '../../src/import/index.js';
import { toDocx } from '../../src/export/index.js';
import type { Node as PMNode } from 'prosemirror-model';

const EXAMPLE_DOCS_DIR = path.resolve(
  process.cwd(),
  'reference-docs/example docs',
);

interface NodeCounts {
  pocket: number;
  hat: number;
  block: number;
  card: number;
  analytic: number;
  undertag: number;
  paragraph: number;
  image: number;
  table: number;
  table_row: number;
  table_cell: number;
  totalParagraphs: number;
  totalTextLength: number;
}

function countNodes(doc: PMNode): NodeCounts {
  const counts: Record<string, number> = {
    pocket: 0,
    hat: 0,
    block: 0,
    card: 0,
    analytic: 0,
    undertag: 0,
    paragraph: 0,
    image: 0,
    table: 0,
    table_row: 0,
    table_cell: 0,
    totalParagraphs: 0,
    totalTextLength: 0,
  };
  doc.descendants((node) => {
    const n = node.type.name;
    if (n in counts) {
      counts[n]! += 1;
    }
    if (
      n === 'pocket' || n === 'hat' || n === 'block' || n === 'tag' ||
      n === 'analytic' || n === 'undertag' || n === 'cite_paragraph' ||
      n === 'card_body' || n === 'paragraph'
    ) {
      counts['totalParagraphs']! += 1;
    }
    if (node.isText) {
      counts['totalTextLength']! += node.text?.length ?? 0;
    }
    return true;
  });
  return counts as unknown as NodeCounts;
}

interface DocFixture {
  filename: string;
  expected: Partial<NodeCounts>;
}

const FIXTURES: DocFixture[] = [
  {
    filename: 'Aff - Merp!.docx',
    // From the real-doc survey (NOTES-verbatim.md §6):
    // Pockets 7, Hats 29, Blocks 162, Tags 362, Analytics 38, Undertags 1
    // Paragraphs 3244, Words 242,634
    expected: {
      pocket: 7,
      hat: 29,
      block: 162,
      // card count ≈ tag count from survey
      card: 362,
      // analytic count includes both standalone and in-card
      // (the survey number is total occurrences)
    },
  },
  {
    filename: 'DA - Reconciliation.docx',
    expected: {
      pocket: 6,
      hat: 21,
      block: 136,
      card: 321,
    },
  },
  {
    filename: 'CP - Bifurcation PIC vs Fed Workers.docx',
    expected: {
      pocket: 0, // CP has no Heading1 paragraphs
      hat: 2,
      block: 26,
      card: 50,
    },
  },
  {
    // Has 4 tables, 28 rows, 103 cells (after vMerge collapse).
    filename: 'Retrenchment TAP - 26-27.docx',
    expected: {
      table: 4,
      table_row: 28,
      table_cell: 103,
    },
  },
];

describe('round-trip: real example docs', () => {
  for (const fixture of FIXTURES) {
    describe(fixture.filename, () => {
      let originalBytes: Uint8Array;
      let imported: PMNode;
      let importCounts: NodeCounts;
      let roundTripped: PMNode;
      let roundTripCounts: NodeCounts;

      beforeAll(async () => {
        const filePath = path.join(EXAMPLE_DOCS_DIR, fixture.filename);
        const buf = await readFile(filePath);
        originalBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        imported = await fromDocx(originalBytes);
        importCounts = countNodes(imported);
        const exportedBytes = await toDocx(imported);
        roundTripped = await fromDocx(exportedBytes);
        roundTripCounts = countNodes(roundTripped);
      }, /* timeout */ 60000);

      it('imports without error', () => {
        expect(imported.type.name).toBe('doc');
        expect(importCounts.totalParagraphs).toBeGreaterThan(0);
      });

      it('matches expected structural counts from the survey', () => {
        const counts = importCounts as unknown as Record<string, number>;
        for (const [k, v] of Object.entries(fixture.expected)) {
          if (typeof v === 'number') {
            expect(counts[k], `${k} count for ${fixture.filename}`).toBe(v);
          }
        }
      });

      it('preserves text length through round-trip', () => {
        expect(roundTripCounts.totalTextLength).toBe(importCounts.totalTextLength);
      });

      it('preserves heading counts through round-trip', () => {
        expect(roundTripCounts.pocket).toBe(importCounts.pocket);
        expect(roundTripCounts.hat).toBe(importCounts.hat);
        expect(roundTripCounts.block).toBe(importCounts.block);
        expect(roundTripCounts.card).toBe(importCounts.card);
        expect(roundTripCounts.analytic).toBe(importCounts.analytic);
      });

      it('preserves heading IDs through round-trip', () => {
        const ids1 = collectHeadingIds(imported);
        const ids2 = collectHeadingIds(roundTripped);
        expect(ids2.size).toBe(ids1.size);
        for (const id of ids1) {
          expect(ids2.has(id), `id ${id} should survive round-trip`).toBe(true);
        }
      });

      it('preserves total paragraph count through round-trip', () => {
        expect(roundTripCounts.totalParagraphs).toBe(importCounts.totalParagraphs);
      });

      it('preserves image count through round-trip', () => {
        expect(roundTripCounts.image).toBe(importCounts.image);
      });
    });
  }
});

function collectHeadingIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    const id = node.attrs?.['id'];
    if (typeof id === 'string' && id.length > 0) {
      ids.add(id);
    }
    return true;
  });
  return ids;
}
