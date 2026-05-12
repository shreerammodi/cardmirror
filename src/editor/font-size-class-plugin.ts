/**
 * Font-size class plugin.
 *
 * Tags each body paragraph with `pmd-fs-shrunk` plus an inline
 * `style="font-size: Xpt; line-height: Y"` reflecting the *smallest*
 * font-size among its text nodes. The inline style lowers the
 * paragraph element's own font-size, which shrinks the paragraph's
 * strut so uniformly-small paragraphs can pack tightly.
 *
 * Why this is needed: `font_size` is a mark, so it renders as inline
 * `<span style="font-size: ...">`. The wrapping `<p>` element keeps
 * the inherited body size, and CSS line-boxes always include a hidden
 * "strut" at the block element's own font-size × line-height. Without
 * this plugin, a paragraph whose every span is 4pt still has a
 * ~15.4pt-tall strut (11pt × 1.4), and lines never collapse below
 * that.
 *
 * Mixed-font paragraphs (per-line strut): on a paragraph with both
 * 11pt body text and 8pt citations, naively shrinking the paragraph
 * to 8pt would cascade-shrink the 11pt bare text too. To avoid that
 * while still letting 8pt-only lines collapse to ~8pt of vertical
 * space, the plugin also emits an `Decoration.inline` over each
 * UNPROTECTED bare-text range — text that carries no font_size mark
 * and no named-style mark — pinning its font-size + line-height
 * back to the body default via inline style. CSS's line-box-takes-
 * the-tallest rule then produces Word-like behavior: lines with
 * only marked-small content size to the paragraph's shrunk strut,
 * lines with bare content size to the bare decoration's strut,
 * mixed lines size to the taller of the two.
 *
 * Why named-style cascade is contained: scoped CSS rules
 * (`.pmd-fs-shrunk .pmd-underline`, etc.) pin the named-style mark
 * wrappers' font-size *only when inside a shrunk paragraph*. Cite
 * has its own unconditional font-size. So named-style-marked text
 * is "self-protecting" — the bare-text decoration only targets
 * text whose marks include none of font_size / cite_mark /
 * underline_mark / emphasis_mark / undertag_mark / analytic_mark.
 *
 * Why inline style instead of size-specific classes: arbitrary
 * font_size mark values (any half-points integer) need to map to a
 * font-size — pre-enumerated CSS rules would have gaps for unusual
 * values (e.g. 3pt, 2pt, 5.5pt). Inline style handles any value.
 *
 * Per-keystroke incremental update: existing decorations get mapped
 * through each transaction; only paragraphs in the touched
 * (top-level-expanded) range are recomputed. This keeps typing latency
 * O(touched-region) instead of O(whole-doc) on large docs.
 */

import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { changedRange, expandToTopLevel } from './decoration-range.js';

const BODY_PARA_TYPES = new Set([
  'card_body',
  'paragraph',
  'cite_paragraph',
  'undertag',
]);

/** OOXML default body size: 11pt = 22 half-points. */
const DEFAULT_HALF_POINTS = 22;

export const fontSizeClassPlugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
  state: {
    init(_, { doc }) {
      return computeFullSet(doc);
    },
    apply(tr, prev) {
      if (!tr.docChanged) return prev;

      const range = changedRange(tr);
      if (!range) return prev.map(tr.mapping, tr.doc);

      const expanded = expandToTopLevel(tr.doc, range.from, range.to);
      const mapped = prev.map(tr.mapping, tr.doc);
      const stale = mapped.find(expanded.from, expanded.to);
      const fresh = computeDecorationsInRange(tr.doc, expanded.from, expanded.to);
      return mapped.remove(stale).add(tr.doc, fresh);
    },
  },
  props: {
    decorations(state) {
      return fontSizeClassPlugin.getState(state);
    },
  },
});

function computeFullSet(doc: PMNode): DecorationSet {
  return DecorationSet.create(doc, computeDecorationsInRange(doc, 0, doc.content.size));
}

function computeDecorationsInRange(doc: PMNode, from: number, to: number): Decoration[] {
  const decos: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!BODY_PARA_TYPES.has(node.type.name)) return;
    const stats = computeFontSizeStats(node);
    if (stats.min >= DEFAULT_HALF_POINTS) return;

    const fontSizePt = stats.min / 2;
    const lineHeight = lineHeightFor(stats.min);
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'pmd-fs-shrunk',
        style: `font-size: ${fontSizePt}pt; line-height: ${lineHeight}`,
      }),
    );

    // Pin each unprotected-bare text range to the body default so
    // mixed-font paragraphs render with per-line strut: 8pt-only
    // lines collapse to the shrunk paragraph strut, bare 11pt lines
    // grow via the inline decoration's own line-height contribution.
    let offset = 1; // first inline position inside the paragraph
    node.forEach((child) => {
      if (child.isText && textNeedsBareProtection(child)) {
        const start = pos + offset;
        const end = start + child.nodeSize;
        decos.push(
          Decoration.inline(start, end, {
            style:
              `font-size: ${DEFAULT_HALF_POINTS / 2}pt;` +
              ` line-height: var(--pmd-line-height)`,
          }),
        );
      }
      offset += child.nodeSize;
    });
  });
  return decos;
}

/**
 * Marks whose presence on a text node means the run already gets a
 * size from somewhere other than the paragraph cascade:
 * - font_size: explicit inline size from the mark itself.
 * - cite_mark: `.pmd-cite { font-size: var(--pmd-size-cite) }` — always.
 * - underline_mark / emphasis_mark / undertag_mark / analytic_mark:
 *   `.pmd-fs-shrunk .pmd-* { font-size: var(--pmd-size-*) }` — when
 *   inside a shrunk paragraph (= the only case we'd consider inline
 *   decoration anyway).
 *
 * Text carrying any of these marks doesn't need the bare-text inline
 * decoration; everything else does, so its size won't cascade-shrink
 * with the paragraph.
 */
const SIZE_OWNING_MARKS = new Set([
  'font_size',
  'cite_mark',
  'underline_mark',
  'emphasis_mark',
  'undertag_mark',
  'analytic_mark',
]);

function textNeedsBareProtection(child: PMNode): boolean {
  return !child.marks.some((m) => SIZE_OWNING_MARKS.has(m.type.name));
}

/**
 * Smallest `font_size` half-points value across all text nodes in
 * `para`, capped at the default 22 (11pt). Text without a `font_size`
 * mark counts as the default. Retained as a public helper for tests
 * and any external consumers; the plugin itself uses
 * `computeFontSizeStats` for the bare-text check.
 */
export function computeMinHalfPoints(para: PMNode): number {
  return computeFontSizeStats(para).min;
}

interface FontSizeStats {
  min: number;
  max: number;
  /** True if any text node has no `font_size` mark (i.e., its size
   *  comes from CSS / paragraph defaults rather than direct formatting). */
  hasBare: boolean;
}

function computeFontSizeStats(para: PMNode): FontSizeStats {
  let min = DEFAULT_HALF_POINTS;
  let max = DEFAULT_HALF_POINTS;
  let hasBare = false;
  para.descendants((child) => {
    if (!child.isText || !child.text) return;
    const fontSizeMark = child.marks.find((m) => m.type.name === 'font_size');
    if (!fontSizeMark) {
      hasBare = true;
      return;
    }
    const hp = Number(fontSizeMark.attrs['halfPoints'] ?? DEFAULT_HALF_POINTS);
    if (hp < min) min = hp;
    if (hp > max) max = hp;
  });
  return { min, max, hasBare };
}

/**
 * Line-height multiplier scaled by the shrunk size. Smaller text packs
 * tighter; sizes near the default ease toward the body's 1.2. Mixed
 * lines (containing larger named-style content) aren't affected — the
 * larger spans' own line-height dictates the line-box.
 */
function lineHeightFor(hp: number): number {
  if (hp <= 12) return 1;     // ≤ 6pt
  if (hp <= 14) return 1.05;  // 7pt
  if (hp <= 16) return 1.1;   // 8pt
  if (hp <= 18) return 1.15;  // 9pt
  if (hp <= 20) return 1.2;   // 10pt
  return 1.2;                 // ≥ 11pt (shouldn't hit; default isn't decorated)
}
