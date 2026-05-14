# prosemirror-debate

A ProseMirror-based editor that interoperates with **Advanced Verbatim**
(the project owner's fork of [Verbatim](https://github.com/ashtarcommunications/verbatim),
the de facto Microsoft Word add-in for US policy/LD/PF debate).

Project status: **active development.** Schema, lossless docx round-trip
(including tables, cell/table properties, indent, paragraph spacing,
hyperlinks via element + field-code forms, super/sub/strike, and more),
the editor UI ribbon (style hotkeys, color pickers, formatting panel,
Doc / Card / Table dropdown menus, keybinding editor, read mode,
shrink/condense pipeline, Select Similar Formatting, Fix Formatting
Gaps, Convert Analytics to Tags, Remove Hyperlinks), a nav-pane outline
with copy-drag, and a CLI for manual verification are landed. Multi-doc
workspace, send-to-speech, search, and other features per
[`ARCHITECTURE.md`](./ARCHITECTURE.md) come next.

## Where to read

- [`PROJECT.md`](./PROJECT.md) — high-level orientation, headline design decisions.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — full design: schema, multi-doc workspace, read mode, send-to-speech, search, transclusion, integration boundaries.
- [`NOTES-verbatim.md`](./NOTES-verbatim.md) — Verbatim's docx data model + real-world observations from the example docs.
- [`NOTES-custom-macros.md`](./NOTES-custom-macros.md) — Advanced Verbatim's custom macros, effect-level inventory.
- [`DECISIONS.md`](./DECISIONS.md) — append-only implementation decision log.

## Setup

Requires Node.js 22+ (we test on 24 LTS).

```sh
npm install
npm test          # run all tests
npm run test:bench # performance benchmarks
npm run typecheck # strict TypeScript check
```

## Round-trip a docx

The CLI imports a Verbatim/Advanced-Verbatim docx, normalizes it through
our schema, and re-exports a fresh docx:

```sh
npm run round-trip path/to/input.docx [path/to/output.docx]
```

The output is fully native to Verbatim — same canonical style ids, same
direct-formatting conventions. Stylepox and other non-Verbatim cruft is
dropped on import (per [`ARCHITECTURE.md §3, §16`](./ARCHITECTURE.md)).

## Public API

```ts
import {
  schema,        // the ProseMirror schema
  fromDocx,      // .docx bytes → ProseMirror doc
  toDocx,        // ProseMirror doc → .docx bytes
  exportDoc,     // schema doc → { documentXml, relsXml }
  importDoc,     // document.xml → schema doc
  newHeadingId,  // generate a fresh stable heading UUID
} from 'prosemirror-debate';
```

### Example: read a docx, modify, write it back

```ts
import { fromDocx, toDocx } from 'prosemirror-debate';
import { readFile, writeFile } from 'node:fs/promises';

const buf = await readFile('input.docx');
const doc = await fromDocx(buf);

// `doc` is a ProseMirror Node — walk it, transform it, edit it...
console.log(`${doc.nodeSize} chars in tree`);

const out = await toDocx(doc);
await writeFile('output.docx', out);
```

### Schema highlights

```
doc:        sequence of block-level kinds
pocket:     Heading 1 paragraph (with stable id)
hat:        Heading 2 paragraph (with stable id)
block:      Heading 3 paragraph (with stable id)
card:       structured: tag (card_body | undertag | cite_paragraph | analytic | table)*
tag:        Heading 4 (only inside card)
cite_paragraph, card_body: body paragraphs inside cards
analytic:   outline-4 paragraph (Analytic style; can be standalone or in-card)
undertag:   Undertag-styled paragraph
paragraph:  unstyled body text (first-class — can sit between any nodes)
table:      table_row+ (at doc level OR inside a card / analytic_unit)
table_row:  (table_cell | table_header)+
table_cell: paragraph+
```

Every paragraph-like textblock carries round-trip-only attrs
`indent` (left indent in OOXML dxa) and `spacing` (verbatim
`<w:spacing>` map). Tables carry `rawTblPr` (table-level borders /
style / shading captured opaquely); cells carry `rawTcPr`
(per-cell borders, shading, vAlign).

Marks: `cite_mark`, `underline_mark`, `underline_direct`,
`emphasis_mark`, `undertag_mark`, `analytic_mark`, plus direct
formatting `bold`, `italic`, `strikethrough`, `superscript`,
`subscript`, `link`, `highlight`, `font_color`, `font_size`,
`shading`, `pilcrow_marker`, `font_family`, `comment_range`
(anchors a thread to a range of text).

See [`src/schema/`](./src/schema/) for full specs and
[`ARCHITECTURE.md §4`](./ARCHITECTURE.md) for design rationale.

## Round-trip fidelity

Verified on three real working docs from the project owner
(`reference-docs/example docs/`):

| File                          | Cards | Heading IDs | Highlights | Underlines | #555555 refs | #D2D2D2 shading |
|-------------------------------|------:|------------:|-----------:|-----------:|-------------:|----------------:|
| Aff - Merp! (1.8 MB)          |   362 |    preserved|     10,903 |     17,791 |        2,621 |             684 |
| DA - Reconciliation (1.0 MB)  |   321 |    preserved|     11,035 |     15,350 |          ≥1k |             411 |
| CP - Bifurcation PIC (252 KB) |    50 |    preserved|      1,481 |      1,807 |            0 |               0 |

All counts survive round-trip exactly. See `tests/round-trip/` for the
verifying tests.

## Performance baseline

(One-shot import + export on the example docs, taken from
`benchmarks/round-trip.bench.ts`. Single-threaded Node 24 LTS, x86_64 Linux.)

| File                                | Import   | Export   | Round-trip |
|-------------------------------------|---------:|---------:|-----------:|
| CP - Bifurcation PIC vs Fed Workers |    76 ms |    62 ms |     130 ms |
| DA - Reconciliation                 |   397 ms |   262 ms |     642 ms |
| Aff - Merp!                         |   528 ms |   304 ms |     826 ms |

Well within tolerable bounds for tournament-day use; further optimization
deferred until specific operations require it.

## License

(TBD — currently private.)
