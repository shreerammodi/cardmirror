/**
 * Auto-numbering positional pass (NUMBERING_PLAN.md §2). These pin the counting
 * semantics — number continues across skips, sub is subordinate + skip-
 * transparent, restart resets both — against the worked examples in the plan.
 */
import { describe, it, expect } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { computeNumbering, toLetters, type NumRole } from '../../src/editor/numbering.js';

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
    if (t === 'transclusion_ref' || t === 'self_ref') return true; // count real inner cards
    if (t === 'pocket' || t === 'hat' || t === 'block') return false;
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
  // A live view holds its mirrored cards as REAL children; they're counted in
  // document order at their real positions, exactly like a linked copy's.
  function view(children: PMNode[]): PMNode {
    return schema.nodes['self_ref']!.create(
      { source_heading_id: 'src', source_label: '↳ Source' },
      Fragment.fromArray(children),
    );
  }
  const doc0 = doc(
    card('A', 'number'), //                              → 1
    view([card('X', 'number'), card('Y', 'sub')]), //    mirrored cards → X=2, Y=a
    card('B', 'number'), //                              → 3, continues past the window
  );

  it('the window cards get HOST-positional numbers and the count continues past it', () => {
    // A=1, X (in the window) continues at 2, its sub Y=a, then B continues at 3.
    expect(labels(doc0)).toEqual(['1', '2', 'a', '3']); // A, X, Y, B
  });

  it('a skip card inside the window keeps the count (no number, no reset)', () => {
    const d = doc(view([card('X', 'number'), card('mid'), card('Y', 'sub')]), card('after', 'number'));
    expect(labels(d)).toEqual(['1', '·', 'a', '2']); // X=1, mid=skip, Y=a, after=2
  });
});

describe('computeNumbering — default doc is inert', () => {
  it('a doc with no roles set produces no numbers', () => {
    expect(labels(doc(card('A'), card('B'), block('X'), card('C')))).toEqual(['·', '·', '·']);
  });
});
