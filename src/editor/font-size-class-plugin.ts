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
 * Why named-style cascade is contained: scoped CSS rules
 * (`.pmd-fs-shrunk .pmd-underline`, etc.) pin the named-style mark
 * wrappers' font-size *only when inside a shrunk paragraph*. In
 * non-shrunk contexts (headings, normal body), they inherit naturally
 * — so underlined text in a Tag still renders at the Tag's 13pt. Only
 * truly bare text (no marks at all, rare in body paragraphs) cascades
 * to the small size.
 *
 * Min, not max: in mixed-size lines (small connective + named-style
 * evidence), CSS's line-box-takes-the-tallest rule means the larger
 * spans dictate line height. Using the min therefore only changes the
 * strut, which is what matters in the uniform-small case and is a
 * no-op in the mixed-size case.
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
    // Don't shrink the paragraph element if there's any bare text
    // (text with no `font_size` mark). The shrink works by lowering
    // the paragraph's font-size; named-style mark wrappers
    // (.pmd-underline et al.) re-pin themselves via the
    // `.pmd-fs-shrunk .pmd-*` rules, but truly bare text inherits
    // the small size and gets visibly squished. This used to be
    // "rare" in body paragraphs, but a condense merge can bring
    // bare text in (e.g., from a doc-level paragraph spliced into
    // a card_body with shrunken content). Skipping when mixed
    // keeps the bare text at body size.
    if (stats.hasBare) return;

    const fontSizePt = stats.min / 2;
    const lineHeight = lineHeightFor(stats.min);
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'pmd-fs-shrunk',
        style: `font-size: ${fontSizePt}pt; line-height: ${lineHeight}`,
      }),
    );
  });
  return decos;
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
