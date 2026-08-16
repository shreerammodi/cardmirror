/**
 * The shared in-flight narration composer (ai/clod.ts) — the one
 * function behind the thinking pill's stage line and every toast that
 * narrates an in-flight AI step. Regression tests for the clod-mode
 * fixes: a configured persona name must show (the pill used to
 * hardcode "Clod"), and stage strings must compose as sentences in
 * BOTH modes (reformat-all's "Cite 3 of 12" used to render as
 * "Clod is Cite 3 of 12…").
 */
import { describe, expect, it } from 'vitest';
import { inFlightLine } from '../../src/editor/ai/clod.js';

describe('inFlightLine', () => {
  it('clod off: capitalized gerund with ellipsis', () => {
    expect(inFlightLine('finding optional sections', false, 'Clod')).toBe(
      'Finding optional sections…',
    );
  });

  it('clod on: persona voice', () => {
    expect(inFlightLine('finding optional sections', true, 'Clod')).toBe(
      'Clod is finding optional sections…',
    );
  });

  it('clod on: the CONFIGURED name, not a hardcoded Clod', () => {
    expect(inFlightLine('skeletonizing', true, 'Debra')).toBe('Debra is skeletonizing…');
  });

  it('blank persona name falls back to Clod', () => {
    expect(inFlightLine('pruning for redundancy', true, '   ')).toBe(
      'Clod is pruning for redundancy…',
    );
  });

  it('reformat-all stage strings read as sentences in both modes', () => {
    const stage = 'reformatting cites · 3 of 12 rewritten · Esc to stop';
    expect(inFlightLine(stage, false, 'Clod')).toBe(
      'Reformatting cites · 3 of 12 rewritten · Esc to stop…',
    );
    expect(inFlightLine(stage, true, 'Clod')).toBe(
      'Clod is reformatting cites · 3 of 12 rewritten · Esc to stop…',
    );
    expect(inFlightLine('stopping after the cites in flight', true, 'Clod')).toBe(
      'Clod is stopping after the cites in flight…',
    );
  });
});
