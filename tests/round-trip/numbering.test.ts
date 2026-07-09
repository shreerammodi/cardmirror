/**
 * Auto-numbering `.docx` round-trip (NUMBERING_PLAN.md §5 / §8 fixtures). The
 * skeleton (numRole / numRestart) maps to Word numbering on export and is
 * reconstructed from numId/ilvl on import — so the RENDERED numbers survive a
 * trip through Word. Covers the two gnarly cases the plan calls out: continuation
 * across a block boundary, and a mid-list restart.
 */
import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { toDocx } from '../../src/export/index.js';
import { fromDocx } from '../../src/import/index.js';
import { computeNumbering, type NumRole } from '../../src/editor/numbering.js';

function card(tag: string, role: NumRole = 'none', restart = false): PMNode {
  return schema.nodes['card']!.createChecked({ numRole: role, numRestart: restart }, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text('body')),
  ]);
}
function block(text: string, restart = true): PMNode {
  return schema.nodes['block']!.create({ id: newHeadingId(), numRestart: restart }, schema.text(text));
}
function doc(...kids: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, kids);
}
async function roundTrip(d: PMNode): Promise<PMNode> {
  return fromDocx(await toDocx(d));
}
/** [role, restart] of each card in document order. */
function cardSkeleton(d: PMNode): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  d.forEach((n) => {
    if (n.type.name === 'card' || n.type.name === 'analytic_unit') {
      out.push([n.attrs['numRole'] as string, n.attrs['numRestart'] as boolean]);
    }
  });
  return out;
}
/** Rendered label text of each card in document order; '·' for a skip. */
function labels(d: PMNode): string[] {
  const map = computeNumbering(d).cards;
  const out: string[] = [];
  d.descendants((n, pos) => {
    if (n.type.name === 'card' || n.type.name === 'analytic_unit') {
      out.push(map.get(pos)?.text ?? '·');
      return false;
    }
    return n.type.name === 'doc' || n.type.name === 'transclusion_ref';
  });
  return out;
}

describe('numbering round-trip — roles', () => {
  it('number + sub survive a docx round-trip', async () => {
    const rt = await roundTrip(doc(card('A', 'number'), card('B', 'sub'), card('C', 'number')));
    expect(cardSkeleton(rt)).toEqual([
      ['number', false],
      ['sub', false],
      ['number', false],
    ]);
    expect(labels(rt)).toEqual(['1', 'a', '2']);
  });

  it('an un-numbered doc stays un-numbered (no numbering.xml)', async () => {
    const rt = await roundTrip(doc(card('A'), card('B')));
    expect(cardSkeleton(rt)).toEqual([
      ['none', false],
      ['none', false],
    ]);
  });
});

describe('numbering round-trip — §8 fixtures', () => {
  it('a mid-list restart survives (numbers restart at the same card)', async () => {
    const rt = await roundTrip(
      doc(card('A', 'number'), card('B', 'number'), card('C', 'number', true), card('D', 'number')),
    );
    // C carries the restart; numbers go 1,2,1,2.
    expect(cardSkeleton(rt)).toEqual([
      ['number', false],
      ['number', false],
      ['number', true],
      ['number', false],
    ]);
    expect(labels(rt)).toEqual(['1', '2', '1', '2']);
  });

  it('continuation across a block boundary survives', async () => {
    const rt = await roundTrip(
      doc(
        block('One'),
        card('A', 'number'),
        card('B', 'number'),
        block('Two', false), // continue
        card('C', 'number'),
        card('D', 'number'),
      ),
    );
    // The count flows across the continue block: 1,2,3,4.
    expect(labels(rt)).toEqual(['1', '2', '3', '4']);
    // And the block is reconstructed as continue.
    const two = rt.child(3);
    expect(two.type.name).toBe('block');
    expect(two.attrs['numRestart']).toBe(false);
  });

  it('a default (restart) block boundary survives', async () => {
    const rt = await roundTrip(
      doc(block('One'), card('A', 'number'), card('B', 'number'), block('Two'), card('C', 'number')),
    );
    // Each block restarts: 1,2,1.
    expect(labels(rt)).toEqual(['1', '2', '1']);
    expect(rt.child(3).attrs['numRestart']).toBe(true);
  });
});
