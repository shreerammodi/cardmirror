/**
 * Auto-numbering positional pass (NUMBERING_PLAN.md §2). These pin the counting
 * semantics — number continues across skips, sub is subordinate + skip-
 * transparent, restart resets both — against the worked examples in the plan.
 */
import { describe, it, expect } from 'vitest';
import { type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { computeNumbering, toLetters, type NumRole } from '../../src/editor/numbering.js';
import { createSelfRefNode, isSelfRef } from '../../src/editor/self-transclusion.js';

function card(tag: string, role: NumRole = 'none', restart = false): PMNode {
  return schema.nodes['card']!.createChecked({ numRole: role, numRestart: restart }, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text('body')),
  ]);
}
function analytic(tag: string, role: NumRole = 'none', restart = false): PMNode {
  return schema.nodes['analytic_unit']!.createChecked({ numRole: role, numRestart: restart }, [
    schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text('body')),
  ]);
}
function block(text: string, restart = true): PMNode {
  return schema.nodes['block']!.create({ id: newHeadingId(), numRestart: restart }, schema.text(text));
}
function blockId(text: string, id: string): PMNode {
  return schema.nodes['block']!.create({ id, numRestart: true }, schema.text(text));
}
function pocket(text: string): PMNode {
  return schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(text));
}
function doc(...children: PMNode[]): PMNode {
  return schema.nodes['doc']!.create(null, children);
}

/** Label text for every card/analytic in document order; '·' for a skipped one. */
function labels(d: PMNode): string[] {
  const map = computeNumbering(d).cards;
  const out: string[] = [];
  d.descendants((node, pos) => {
    const t = node.type.name;
    if (t === 'card' || t === 'analytic_unit') {
      out.push(map.get(pos)?.text ?? '·');
      return false;
    }
    if (t === 'transclusion_ref') return true; // count real cards inside a copy
    if (t === 'pocket' || t === 'hat' || t === 'block' || t === 'self_ref') return false;
    return true;
  });
  return out;
}

describe('toLetters — bijective base-26', () => {
  it('maps 1→a … 26→z, then 27→aa, 28→ab', () => {
    expect([1, 2, 26, 27, 28, 52, 53].map(toLetters)).toEqual(['a', 'b', 'z', 'aa', 'ab', 'az', 'ba']);
  });
});

describe('computeNumbering — §2 worked examples', () => {
  it('numbers continue across skips; trailing subs belong to the last number', () => {
    // 1, 2, 3, none, 4, none, 5, none, a, b
    expect(
      labels(
        doc(
          card('A', 'number'),
          card('B', 'number'),
          card('C', 'number'),
          card('skip'),
          card('D', 'number'),
          card('skip'),
          card('E', 'number'),
          card('skip'),
          card('s1', 'sub'),
          card('s2', 'sub'),
        ),
      ),
    ).toEqual(['1', '2', '3', '·', '4', '·', '5', '·', 'a', 'b']);
  });

  it('sub resets under each new number (1, a, b, 2, c → 1, a, b, 2, a)', () => {
    expect(
      labels(
        doc(
          card('A', 'number'),
          card('a', 'sub'),
          card('b', 'sub'),
          card('B', 'number'),
          card('c', 'sub'),
        ),
      ),
    ).toEqual(['1', 'a', 'b', '2', 'a']);
  });

  it('a skip between subs is a gap: number, sub, skip, sub → 1, a, ·, b', () => {
    expect(
      labels(doc(card('A', 'number'), card('a', 'sub'), card('skip'), card('b', 'sub'))),
    ).toEqual(['1', 'a', '·', 'b']);
  });

  it('a card `restart` starts the number over (1,2,3,[restart],1,2,3)', () => {
    expect(
      labels(
        doc(
          card('A', 'number'),
          card('B', 'number'),
          card('C', 'number'),
          card('D', 'number', true), // restart here
          card('E', 'number'),
          card('F', 'number'),
        ),
      ),
    ).toEqual(['1', '2', '3', '1', '2', '3']);
  });

  it('restart also resets the sub counter', () => {
    expect(
      labels(
        doc(
          card('A', 'number'),
          card('a', 'sub'),
          card('B', 'sub', true), // restart on a sub card: both counters reset
          card('c', 'sub'),
        ),
      ),
      // First number → 1, sub a; then restart clears both, this card is a sub → a; next sub → b.
    ).toEqual(['1', 'a', 'a', 'b']);
  });
});

describe('computeNumbering — scope boundaries', () => {
  it('each block restarts the count by default', () => {
    expect(
      labels(
        doc(
          block('One'),
          card('A', 'number'),
          card('B', 'number'),
          block('Two'),
          card('C', 'number'),
          card('D', 'number'),
        ),
      ),
    ).toEqual(['1', '2', '1', '2']);
  });

  it('a "continue" block (numRestart false) carries the count across the heading', () => {
    expect(
      labels(
        doc(
          block('One'),
          card('A', 'number'),
          card('B', 'number'),
          block('Two', false), // continue
          card('C', 'number'),
          card('D', 'number'),
        ),
      ),
    ).toEqual(['1', '2', '3', '4']);
  });

  it('a pocket always starts a fresh scope', () => {
    expect(
      labels(
        doc(
          card('A', 'number'),
          card('B', 'number'),
          pocket('New part'),
          card('C', 'number'),
        ),
      ),
    ).toEqual(['1', '2', '1']);
  });

  it('analytic units count exactly like cards', () => {
    expect(
      labels(doc(analytic('A', 'number'), card('b', 'sub'), analytic('B', 'number'))),
    ).toEqual(['1', 'a', '2']);
  });
});

describe('computeNumbering — linked copies participate', () => {
  it('real cards inside a linked copy are counted in document order', () => {
    // A transclusion_ref (linked copy) holding two number cards, between two others.
    const copy = schema.nodes['transclusion_ref']!.createChecked(
      {
        source_ref: 'S.cmir',
        source_ref_base: 'doc',
        source_heading_id: 'H',
        source_content_hash: 'x',
      },
      [card('X', 'number'), card('Y', 'number')],
    );
    expect(labels(doc(card('A', 'number'), copy, card('B', 'number')))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });
});

describe('computeNumbering — live views flow through the host count (§7)', () => {
  // A source section under `src`, projected by a live view placed earlier.
  const doc0 = doc(
    card('A', 'number'), //                → 1
    createSelfRefNode(schema, 'src', '↳ Source'), // window projects [X, Y]
    card('B', 'number'), //                → continues AFTER the window
    blockId('Source', 'src'), //                    resets the count for the real source
    card('X', 'number'), //                real source card → 1 here
    card('Y', 'sub'), //                   real source card → a here
  );
  function selfPos(d: PMNode): number {
    let p = -1;
    d.descendants((n, pos) => {
      if (p < 0 && isSelfRef(n)) p = pos;
    });
    return p;
  }

  it('the window shows HOST-positional numbers for its projected cards', () => {
    const { windows } = computeNumbering(doc0);
    const labels = windows.get(selfPos(doc0))!;
    expect(labels).toBeTruthy();
    // X is a number and Y a sub; here they follow card A (=1), so 2 then a —
    // different from their 1 / a at their real positions after the block reset.
    expect(labels.map((l) => (l ? l.text : '·'))).toEqual(['2', 'a']);
  });

  it('a card after the window continues the count through it', () => {
    // A=1, window contributes 2 (X), then B continues at 3.
    expect(labels(doc0)).toEqual(['1', '3', '1', 'a']); // A, B, X, Y (real positions)
  });

  it('a projected skip pushes null (keeps index alignment with the DOM)', () => {
    const d = doc(
      createSelfRefNode(schema, 'src', '↳ Source'),
      blockId('Source', 'src'),
      card('X', 'number'),
      card('mid'), // role none — a skip
      card('Y', 'sub'),
    );
    const labels2 = computeNumbering(d).windows.get(0)!;
    expect(labels2.map((l) => (l ? l.text : '·'))).toEqual(['1', '·', 'a']);
  });
});

describe('computeNumbering — default doc is inert', () => {
  it('a doc with no roles set produces no numbers', () => {
    expect(labels(doc(card('A'), card('B'), block('X'), card('C')))).toEqual(['·', '·', '·']);
  });
});
