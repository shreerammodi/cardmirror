/**
 * `Element.scrollIntoView` with cv:auto-aware refinement.
 *
 * Cards (`.pmd-card`, `.pmd-pocket`, `.pmd-hat`, `.pmd-block`,
 * `.pmd-analytic-unit`) carry `content-visibility: auto` with a
 * `contain-intrinsic-size` placeholder. Off-screen subtrees skip
 * layout and the browser substitutes the placeholder height for
 * any scroll-position math. A plain `scrollIntoView` on a deep
 * heading therefore lands imprecisely the first time.
 *
 * Algorithm — optimistic + refine:
 *   1. Call `scrollIntoView({ block })`. With cv:auto's placeholder
 *      heights, the browser may land the target imprecisely — but
 *      the scroll causes Chromium to materialize the cards around
 *      the new viewport position, including the target.
 *   2. Wait one frame. Read `target.getBoundingClientRect().top`.
 *      The target is now materialized, so this returns its real
 *      on-screen y-position.
 *   3. If it's within tolerance of the requested alignment, done.
 *      If not, re-issue `scrollIntoView` — this time using the
 *      target's real position (it's materialized now) and any
 *      newly-materialized neighbors' real heights. Each iteration
 *      brings more layout truth into the system.
 *   4. Cap at MAX_REFINE_ITERATIONS to defend against pathological
 *      cases where late-arriving layout work prevents convergence
 *      (image / font load mid-iteration, etc.). Worst case: the
 *      user sees the target within ~one viewport of the requested
 *      alignment, which is much better than a multi-second pause.
 *
 * What this used to do (and no longer does): a previous
 * implementation unconditionally added a force-materialize class
 * to the editor (cv:visible !important on every card) and read
 * `editor.offsetHeight` before scrolling. That style-cascade +
 * full-doc layout pass cost ~2 s on a 2000-card Verbatim — and
 * crucially, paid that cost on EVERY nav-pane click, even when
 * the target was already on-screen and didn't need any new
 * materialization. The optimistic path here trades precision-on-
 * first-try for never-paying-the-full-doc-layout: clicks where
 * the target is already visible cost a few ms, and clicks into
 * fresh regions pay only what cv:auto would have charged anyway
 * for the destination cards.
 *
 * cv:auto's editing-perf benefit (commit `314944a`) is preserved
 * end-to-end — we never flip cv:auto off, so per-keystroke layout
 * stays scoped to the cursor's containing card.
 */

import type { EditorView } from 'prosemirror-view';

/** Find the nearest scrolling-overflow ancestor of `el`. Returns the
 *  element if one exists, or `null` to fall back to the viewport.
 *  Used so the convergence check below anchors `desiredTop` to the
 *  scroller's visible region instead of assuming the window scrolls
 *  — which stopped being true in single-doc once `#app` became a
 *  bounded scroller (see `style.css` `body:not(.pmd-multi-doc) #app`
 *  rule), and was already false for multi-pane's `.pmd-pane-body`. */
function nearestScroller(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const cs = getComputedStyle(cur);
    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return cur;
    cur = cur.parentElement;
  }
  return null;
}

/** Max iterations for the refine loop. With force-materialize gone,
 *  the initial scroll uses cv:auto placeholder heights and may land
 *  imprecisely; expect 1–3 refine passes in the warm path, more
 *  on cold-deep-target paths where each iteration brings only a
 *  little more layout truth into the system. The cap bounds worst-
 *  case latency rather than guaranteeing convergence — if we cap
 *  out, the target is on screen, just not perfectly aligned. The
 *  number is deliberately generous: iterations that aren't needed
 *  drop on their own via the tolerance early-exit, so a higher
 *  cap only costs frames in worst-case paths that already weren't
 *  converging at the previous cap. */
const MAX_REFINE_ITERATIONS = 10;

/** Convergence tolerance in CSS pixels. */
const REFINE_TOLERANCE_PX = 1;

export type PreciseScrollBlock = 'start' | 'center';

export function preciseScrollIntoView(
  _view: EditorView,
  target: HTMLElement,
  block: PreciseScrollBlock = 'start',
): void {
  if (!target.isConnected) return;

  // Optimistic initial scroll. Browser uses whatever layout it
  // already has — placeholder heights for cv:auto-skipped cards,
  // real heights for materialized ones. May land imprecisely on
  // first call when the target's region was never visited.
  target.scrollIntoView({ behavior: 'auto', block });

  // Where the target should be after a precise scroll, in viewport
  // pixels. `block: 'start'` puts it at the top of the scroller's
  // visible region; `'center'` puts it at the vertical middle.
  // Both `getBoundingClientRect().top` (read below) and the scroller's
  // own rect are viewport-relative, so the convergence check
  // `Math.abs(rect.top - desiredTop)` works in either coordinate
  // space. Falls back to viewport bounds when there's no scrolling
  // ancestor (e.g., tests or DOM detached states).
  const scroller = nearestScroller(target);
  const sb = scroller
    ? scroller.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight };
  const desiredTop = block === 'center' ? (sb.top + sb.bottom) / 2 : sb.top;

  let iterations = 1;
  const refine = (): void => {
    if (!target.isConnected) return;
    const rect = target.getBoundingClientRect();
    // Converged: target is within tolerance. Exit.
    if (Math.abs(rect.top - desiredTop) < REFINE_TOLERANCE_PX) return;
    // Out of budget. The target is on screen but possibly not at
    // the exact alignment. Better than a multi-second pause; user
    // sees ~one viewport's worth of misalignment at worst.
    if (iterations >= MAX_REFINE_ITERATIONS) return;
    iterations++;
    // Re-issue scrollIntoView. Each iteration brings more cards
    // into materialization (the previous scroll's destination
    // region is now painted), refining the layout state the
    // browser's alignment math runs against. Mirrors the "click
    // the nav-pane entry twice for precision" pattern that works
    // empirically — except we automate it inside one click.
    //
    // No "position didn't change → bail" guard: that was the bug
    // in an earlier version. When the placeholder-based layout
    // makes scrollIntoView land at the same wrong spot two frames
    // in a row, we still need to keep iterating because each scroll
    // *attempts* further materialization even when its visible
    // result doesn't shift. The MAX_REFINE_ITERATIONS budget is the
    // real safety net.
    target.scrollIntoView({ behavior: 'auto', block });
    requestAnimationFrame(refine);
  };
  requestAnimationFrame(refine);
}
