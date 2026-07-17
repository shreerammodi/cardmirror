// @vitest-environment jsdom
/**
 * The drag hit-test's scroll gate must survive pane re-parenting.
 * Regression: `findNavScrollGate` cached the nearest scrolling ancestor
 * and revalidated it with `isConnected` only — but the multi-pane shell
 * re-parents nav sections between containers when panes are rearranged,
 * leaving the cached gate connected (as another slot's scroller) while
 * no longer an ancestor of this panel. Every drag hit-test was then
 * gated against the wrong rect and returned null: no drop indicator
 * ever lit anywhere in the affected doc, and drops snapped back, until
 * the doc was closed and reopened (field report 2026-07-17, three-pane).
 */
import { describe, it, expect } from 'vitest';
import { NavigationPanel } from '../../src/editor/nav-panel.js';

function scroller(): HTMLDivElement {
  const el = document.createElement('div');
  el.style.overflowY = 'auto';
  document.body.appendChild(el);
  return el;
}

/** Reach the private gate finder (TS-private only). */
function gateOf(nav: NavigationPanel): HTMLElement {
  return (nav as unknown as { findNavScrollGate(): HTMLElement }).findNavScrollGate();
}
function rootOf(nav: NavigationPanel): HTMLElement {
  return (nav as unknown as { root: HTMLElement }).root;
}

describe('nav drag scroll gate across re-parenting', () => {
  it('recomputes the gate when the panel moves to a different scroller', () => {
    const paneA = scroller();
    const nav = new NavigationPanel(paneA);

    expect(gateOf(nav)).toBe(paneA); // cached

    // Rearrange panes: the shell moves this panel's DOM into another
    // slot's scroller. Pane A stays in the document.
    const paneB = scroller();
    paneB.appendChild(rootOf(nav));

    // A stale-but-connected cache must not win — the gate has to be an
    // ancestor of the panel again.
    const gate = gateOf(nav);
    expect(gate).toBe(paneB);
    expect(gate.contains(rootOf(nav))).toBe(true);
  });

  it('still caches while the gate remains the panel ancestor', () => {
    const pane = scroller();
    const nav = new NavigationPanel(pane);
    expect(gateOf(nav)).toBe(pane);
    expect(gateOf(nav)).toBe(pane); // second call served from cache
  });
});
