/**
 * ProseMirror mark specs.
 *
 * Two families of marks:
 *
 * 1. Named-style emphasis marks — round-trip to a Word character style:
 *    - cite_mark   ↔ rStyle "Style13ptBold" (Cite)
 *    - underline_mark ↔ rStyle "StyleUnderline" + direct <w:u w:val="single"/>
 *      (dual representation per NOTES-verbatim.md §5 gotcha #1)
 *    - emphasis_mark ↔ rStyle "Emphasis"
 *    - undertag_mark ↔ rStyle "UndertagChar"
 *    - analytic_mark ↔ rStyle "AnalyticChar"
 *
 * 2. Direct-formatting marks — round-trip to OOXML run properties:
 *    - bold      ↔ <w:b/>
 *    - italic    ↔ <w:i/> + <w:iCs/>
 *    - superscript ↔ <w:vertAlign w:val="superscript"/>
 *    - subscript ↔ <w:vertAlign w:val="subscript"/>
 *    - link      ↔ <w:hyperlink>...</w:hyperlink>  (URL in attrs)
 *    - highlight ↔ <w:highlight w:val="..."/>      (named color)
 *    - font_color ↔ <w:color w:val="..."/>         (RGB hex)
 *    - font_size ↔ <w:sz w:val="..."/>             (half-points)
 *    - shading   ↔ <w:shd w:fill="..."/>           (RGB hex; protected highlight)
 */

import type { MarkSpec } from 'prosemirror-model';

/** No-attribute named-style mark template. */
function namedStyleMark(): MarkSpec {
  return {
    inclusive: true,
  };
}

export const marks: { [name: string]: MarkSpec } = {
  // -------- Outermost: per-run font size --------
  // `font_size` is listed first so it renders as the OUTERMOST DOM
  // wrapper. CSS paints an inline element's background/border on a box
  // sized by its OWN font-size, not its descendants'. Putting font_size
  // outermost means visible wrappers (emphasis box, highlight band,
  // strikethrough line, etc.) inherit the per-run size and size their
  // boxes correctly when the user scales text up or down. Order within
  // this object literal sets mark rank: earlier = lower rank = outer
  // DOM. Word treats direct `<w:sz>` as overriding a character style's
  // size, so this also matches OOXML semantics.

  font_size: {
    inclusive: true,
    attrs: {
      // Half-points (OOXML convention): 22 = 11pt, 24 = 12pt, 26 = 13pt, etc.
      halfPoints: {
        default: 22,
        validate: (v: unknown) =>
          typeof v === 'number' && Number.isInteger(v) && v > 0,
      },
    },
    parseDOM: [
      {
        tag: 'span[data-half-points]',
        getAttrs: (dom: HTMLElement) => {
          const v = dom.getAttribute('data-half-points');
          const n = v ? parseInt(v, 10) : 22;
          return { halfPoints: Number.isFinite(n) ? n : 22 };
        },
      },
    ],
    toDOM: (mark) => {
      const hp = Number(mark.attrs['halfPoints'] ?? 22);
      return [
        'span',
        {
          style: `font-size: ${hp / 2}pt`,
          'data-half-points': String(hp),
        },
        0,
      ];
    },
  },

  // -------- Named-style emphasis marks --------

  cite_mark: {
    ...namedStyleMark(),
    // The three named-style "evidence" marks are mutually exclusive
    // — at most one of {cite, underline, emphasis} on any character.
    // Symmetric so that whichever mark is being added via tr.addMark
    // strips the others automatically. For passive coexistence
    // (legacy import data carrying overlapping marks), the named-
    // style normalizer plugin enforces cite/emphasis precedence over
    // underline.
    excludes: 'cite_mark underline_mark emphasis_mark',
    parseDOM: [{ tag: 'span.pmd-cite' }],
    toDOM: () => ['span', { class: 'pmd-cite' }, 0],
  },

  underline_mark: {
    ...namedStyleMark(),
    excludes: 'cite_mark underline_mark emphasis_mark',
    parseDOM: [{ tag: 'span.pmd-underline' }],
    toDOM: () => ['span', { class: 'pmd-underline' }, 0],
  },

  /**
   * Direct underline (no named style). Used in structural textblocks
   * (tag / analytic / pocket / hat / block / undertag) where applying
   * the named-style "Underline" would semantically mis-classify the
   * text. Round-trips to a bare `<w:u w:val="single"/>` with no
   * `<w:rStyle/>`. The named-style-normalizer plugin keeps the
   * body-vs-structural invariant (no underline_direct in body, no
   * underline_mark in structural).
   */
  underline_direct: {
    inclusive: true,
    parseDOM: [{ tag: 'u' }],
    toDOM: () => ['u', 0],
  },

  emphasis_mark: {
    ...namedStyleMark(),
    excludes: 'cite_mark underline_mark emphasis_mark',
    parseDOM: [{ tag: 'span.pmd-emphasis' }],
    toDOM: () => ['span', { class: 'pmd-emphasis' }, 0],
  },

  undertag_mark: {
    ...namedStyleMark(),
    parseDOM: [{ tag: 'span.pmd-undertag-mark' }],
    toDOM: () => ['span', { class: 'pmd-undertag-mark' }, 0],
  },

  analytic_mark: {
    ...namedStyleMark(),
    parseDOM: [{ tag: 'span.pmd-analytic-mark' }],
    toDOM: () => ['span', { class: 'pmd-analytic-mark' }, 0],
  },

  /**
   * Pilcrow marker — a non-inclusive mark applied to the 6-pt `¶`
   * characters Branch B inserts at original paragraph boundaries.
   * Non-inclusive so the cursor adjacent to a pilcrow doesn't pick
   * up its formatting and typing nearby stays at the surrounding
   * text size. Round-trips as `<w:r><w:rPr><w:sz w:val="12"/></w:rPr>
   * <w:t>¶</w:t></w:r>` — the exporter writes the equivalent of a
   * 6-pt `font_size` mark for any run carrying this marker, and the
   * importer recognizes the same pattern on the way back in.
   */
  pilcrow_marker: {
    inclusive: false,
    parseDOM: [{ tag: 'span.pmd-pilcrow' }],
    toDOM: () => ['span', { class: 'pmd-pilcrow' }, 0],
  },

  // -------- Direct-formatting marks --------

  bold: {
    inclusive: true,
    parseDOM: [
      { tag: 'b' },
      { tag: 'strong' },
      { style: 'font-weight', getAttrs: (v) => /^(bold|[5-9]\d{2})/.test(String(v)) && null },
    ],
    toDOM: () => ['strong', 0],
  },

  italic: {
    inclusive: true,
    parseDOM: [
      { tag: 'i' },
      { tag: 'em' },
      { style: 'font-style=italic' },
    ],
    toDOM: () => ['em', 0],
  },

  /**
   * Strikethrough — `<w:strike/>` in OOXML. Renders as `<s>`. We don't
   * differentiate single-strike vs double-strike (`<w:dstrike/>`); the
   * importer maps both to this mark and the exporter writes single-strike.
   */
  strikethrough: {
    inclusive: true,
    parseDOM: [
      { tag: 's' },
      { tag: 'strike' },
      { tag: 'del' },
      { style: 'text-decoration', getAttrs: (v) => /line-through/.test(String(v)) && null },
    ],
    toDOM: () => ['s', 0],
  },

  /**
   * Vertical alignment — `<w:vertAlign w:val="superscript|subscript"/>`
   * in OOXML. Two separate marks so the natural ProseMirror mark
   * lifecycle (toggle, exclude) handles mutual exclusion; a single
   * baseline of normal is the absence of either mark. Renders as
   * native `<sup>` / `<sub>` so browsers handle the baseline shift
   * and ~0.83em font scaling without per-mark CSS.
   */
  superscript: {
    inclusive: true,
    excludes: 'superscript subscript',
    parseDOM: [
      { tag: 'sup' },
      { style: 'vertical-align', getAttrs: (v) => /super/.test(String(v)) && null },
    ],
    toDOM: () => ['sup', 0],
  },

  subscript: {
    inclusive: true,
    excludes: 'superscript subscript',
    parseDOM: [
      { tag: 'sub' },
      { style: 'vertical-align', getAttrs: (v) => /sub/.test(String(v)) && null },
    ],
    toDOM: () => ['sub', 0],
  },

  link: {
    inclusive: false,
    attrs: {
      href: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom: HTMLElement) => ({
          href: dom.getAttribute('href') ?? '',
        }),
      },
    ],
    toDOM: (mark) => [
      'a',
      { href: String(mark.attrs['href'] ?? '') },
      0,
    ],
  },

  /**
   * Shading — `<w:shd w:fill="…"/>`, an RGB background that survives
   * Word's "remove highlighting" (which only strips `<w:highlight>`).
   * Verbatim's `HighlightToBackgroundColor` uses this as "protected
   * highlight" (canonically D2D2D2 grey). Defined BEFORE `highlight`
   * so highlight nests inside shading in the DOM — when both marks
   * coexist on the same run, highlight's background wins visually.
   */
  shading: {
    inclusive: true,
    attrs: {
      // Hex RGB, no leading "#"
      color: {
        default: 'D2D2D2',
        validate: (v: unknown) =>
          typeof v === 'string' && /^[0-9a-fA-F]{6}$/.test(v),
      },
    },
    parseDOM: [
      {
        tag: 'span[data-shading]',
        getAttrs: (dom: HTMLElement) => ({
          color: dom.getAttribute('data-shading') ?? 'D2D2D2',
        }),
      },
    ],
    toDOM: (mark) => [
      'span',
      {
        style: `background-color: #${String(mark.attrs['color'] ?? 'D2D2D2')}`,
        'data-shading': String(mark.attrs['color'] ?? 'D2D2D2'),
      },
      0,
    ],
  },

  highlight: {
    inclusive: true,
    attrs: {
      // OOXML highlight values: "yellow", "green", "cyan", "magenta", "blue",
      // "red", "darkBlue", "darkCyan", "darkGreen", "darkMagenta", "darkRed",
      // "darkYellow", "darkGray", "lightGray", "black", "none"
      color: {
        default: 'yellow',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    parseDOM: [
      { tag: 'mark', getAttrs: () => ({ color: 'yellow' }) },
      {
        tag: 'span.pmd-highlight',
        getAttrs: (dom: HTMLElement) => ({
          color: dom.dataset['highlight'] ?? 'yellow',
        }),
      },
    ],
    // Render as <span class="pmd-highlight"> rather than <mark>. Class-
    // based targeting is more robust than the bare `mark` element
    // selector — ProseMirror's view layer can normalize element names
    // in ways that defeat element-typed CSS rules in some cases.
    // Emphasis box padding is intentionally 0 so the highlight bg
    // reaches the box's inner border edge with no white gap, even
    // though emphasis is OUTER to highlight in mark rank (a continuous
    // emphasis run renders as ONE `.pmd-emphasis` span regardless of
    // which sub-runs carry highlight — no phantom internal borders).
    toDOM: (mark) => [
      'span',
      {
        class: 'pmd-highlight',
        'data-highlight': String(mark.attrs['color'] ?? 'yellow'),
      },
      0,
    ],
  },

  font_color: {
    inclusive: true,
    attrs: {
      // Hex string, no leading "#" (OOXML convention): "555555", "1F3864", etc.
      color: {
        default: '000000',
        validate: (v: unknown) =>
          typeof v === 'string' && /^[0-9a-fA-F]{6}$/.test(v),
      },
    },
    parseDOM: [
      {
        tag: 'span[data-color]',
        getAttrs: (dom: HTMLElement) => ({
          color: dom.getAttribute('data-color') ?? '000000',
        }),
      },
    ],
    toDOM: (mark) => [
      'span',
      {
        style: `color: #${String(mark.attrs['color'] ?? '000000')}`,
        'data-color': String(mark.attrs['color'] ?? '000000'),
      },
      0,
    ],
  },

  /**
   * Per-run font family override. Round-trips to OOXML `<w:rFonts>`
   * (importer reads w:ascii / w:hAnsi / w:cs; exporter emits all three
   * to the same value). Intentionally NOT rendered in the editor — the
   * mark is data-only, with a span wrapper carrying a `data-font-family`
   * attribute. The body font (settings.bodyFont) governs how the editor
   * renders. Round-trip preserves the user's per-run font overrides
   * verbatim regardless.
   */
  font_family: {
    inclusive: true,
    attrs: {
      name: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    parseDOM: [
      {
        tag: 'span[data-font-family]',
        getAttrs: (dom: HTMLElement) => ({
          name: dom.getAttribute('data-font-family') ?? '',
        }),
      },
    ],
    toDOM: (mark) => [
      'span',
      {
        'data-font-family': String(mark.attrs['name'] ?? ''),
      },
      0,
    ],
  },

  /**
   * Comment anchor — references a thread in the comments plugin
   * state via `threadId`. Non-inclusive so typing past either end
   * of a commented range doesn't extend the anchor. Renders as a
   * span with a `data-comment-id` attribute the CSS uses to draw
   * the subtle inline indicator. Thread content (author / text /
   * replies) lives in plugin state, not on the mark.
   *
   * Round-trips as `<w:commentRangeStart>` / `<w:commentRangeEnd>`
   * brackets in document.xml; the actual comment data goes into
   * `word/comments.xml` (+ `word/commentsExtended.xml` for thread
   * relationships).
   */
  comment_range: {
    inclusive: false,
    attrs: {
      threadId: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    parseDOM: [
      {
        tag: 'span[data-comment-id]',
        getAttrs: (dom: HTMLElement) => ({
          threadId: dom.getAttribute('data-comment-id') ?? '',
        }),
      },
    ],
    toDOM: (mark) => [
      'span',
      {
        class: 'pmd-comment-range',
        'data-comment-id': String(mark.attrs['threadId'] ?? ''),
      },
      0,
    ],
  },

};
