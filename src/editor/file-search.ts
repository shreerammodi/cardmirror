/**
 * Command-palette file search (the `f` prefix) — pure logic.
 *
 * Two layers, both on-demand (no persistent index yet; see
 * ARCHITECTURE.md §11 "corpus search"):
 *   1. File layer  — match `.cmir` filenames recursively found under
 *      the configured search root (the palette does the I/O).
 *   2. Object layer — once a file is picked, parse it and surface its
 *      structural objects (blocks / tags / cites / …) so the user can
 *      search WITHIN it and insert one. Each object carries the doc
 *      slice that gets inserted, mirroring quick cards / dropzone.
 *
 * Matching is the same order-independent multi-token substring AND
 * ranking the rest of the palette uses (see quick-cards-match.ts) —
 * "block search style", not edit-distance fuzz.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { collectHeadings, computeHeadingRange } from './headings.js';

/** Structural object kinds that can appear in within-file results. */
export type FileObjectKind = 'pocket' | 'hat' | 'block' | 'tag' | 'cite' | 'analytic';

/** All kinds, in outline order — the order the settings checklist
 *  shows them and the order results group in. */
export const FILE_OBJECT_KINDS: FileObjectKind[] = [
  'pocket',
  'hat',
  'block',
  'tag',
  'cite',
  'analytic',
];

export const FILE_OBJECT_KIND_LABELS: Record<FileObjectKind, string> = {
  pocket: 'Pocket',
  hat: 'Hat',
  block: 'Block',
  tag: 'Tag',
  cite: 'Cite',
  analytic: 'Analytic',
};

/** Short badge text shown on a within-file result row. */
export const FILE_OBJECT_KIND_BADGES: Record<FileObjectKind, string> = {
  pocket: 'POC',
  hat: 'HAT',
  block: 'BLK',
  tag: 'TAG',
  cite: 'CITE',
  analytic: 'ANL',
};

/** A `.cmir` file discovered under the search root. */
export interface FileEntry {
  /** Absolute path (open target). */
  path: string;
  /** Path relative to the search root (for the dir hint). */
  relPath: string;
  /** Bare filename (the match + display target). */
  name: string;
  /** Last-modified time — the version key for the warm cache. */
  mtimeMs: number;
}

/** A structural object inside a parsed file — a search hit (flat). */
export interface FileObject {
  kind: FileObjectKind;
  /** Match + display text (heading text, or the cite string). */
  label: string;
  /** Secondary text — the owning tag for a cite, else ''. */
  detail: string;
  /** For a `tag` object, the cite text of its card (author/date), so a
   *  tag is findable by its citation — mirrors Ctrl-F, which can match
   *  a tag's card via the cite_paragraph. Used for matching AND shown
   *  as the row's secondary text. Undefined when the card has no cite. */
  cite?: string;
  /** Doc range to slice on insert. Sliced lazily from the kept parsed
   *  doc (the palette holds it for the dive), so a dive never eagerly
   *  builds or holds a slice for every object. */
  from: number;
  to: number;
}

/** One row of a file's outline (the nav-pane-style browse) — the full
 *  structural hierarchy, indented by `level`. Cites are not headings, so
 *  they never appear here; they only surface when you type a query. */
export interface OutlineEntry {
  /** 1 Pocket · 2 Hat · 3 Block · 4 Tag/Analytic. */
  level: number;
  kind: FileObjectKind;
  label: string;
  from: number;
  to: number;
}

/** Bare filename from a path/relPath (handles `/` and `\`). */
export function baseName(p: string): string {
  const m = p.split(/[\\/]/);
  return m[m.length - 1] ?? p;
}

/** Openable format of a listed file, by extension. The file scan yields
 *  only `.cmir` and `.docx`, so anything not `.docx` is treated as `cmir`. */
export function fileFormat(pathOrName: string): 'cmir' | 'docx' {
  return /\.docx$/i.test(pathOrName) ? 'docx' : 'cmir';
}

/** Display name for a listed file: the openable extension (.cmir/.docx)
 *  stripped, since the result row badges the format separately. Other dots
 *  in the name are left intact. */
export function stripFileExt(name: string): string {
  return name.replace(/\.(cmir|docx)$/i, '');
}

/** Directory portion of a relPath ('' for a top-level file). */
export function dirName(relPath: string): string {
  const i = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
  return i < 0 ? '' : relPath.slice(0, i);
}

/** Order-independent multi-token substring AND-match + ranking by
 *  first-token position (prefix matches float up), then input order. */
function rankByTokens<T>(items: readonly T[], query: string, text: (t: T) => string): T[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...items];
  const t0 = tokens[0]!;
  return items
    .map((item, i) => ({ item, i, t: text(item).toLowerCase() }))
    .filter(({ t }) => tokens.every((tok) => t.includes(tok)))
    .sort((a, b) => {
      const d = a.t.indexOf(t0) - b.t.indexOf(t0);
      return d !== 0 ? d : a.i - b.i;
    })
    .map(({ item }) => item);
}

export function searchFiles(files: readonly FileEntry[], query: string): FileEntry[] {
  return rankByTokens(files, query, (f) => f.name);
}

export function searchFileObjects(objects: readonly FileObject[], query: string): FileObject[] {
  // Match a tag by its label OR its card's cite text, so searching an
  // author/date surfaces the owning tag. Label leads the matched string
  // so a label hit still ranks above a cite-only hit.
  return rankByTokens(objects, query, (o) => (o.cite ? `${o.label} ${o.cite}` : o.label));
}

/**
 * Walk a parsed `.cmir` doc once and produce both:
 *   - `objects`: the flat, searchable hits of the enabled kinds (+ cites)
 *   - `outline`: the full structural hierarchy for the nav-pane-style
 *     browse, every heading with its level (cites excluded — not headings)
 *
 * Each carries a doc range, not a materialized slice: the caller keeps
 * the parsed doc and slices on insert, so a dive doesn't build a slice
 * for every heading up front. Insertion granularity (confirmed with the
 * user) is whatever `computeHeadingRange` returns:
 *   - tag / cite           → the enclosing card (tag + body)
 *   - block / hat / pocket  → the heading + everything under it
 *   - analytic              → the analytic unit / card
 *
 * Cites aren't a heading type: each tag entry carries the cite text of
 * its card, so a `cite` object piggybacks on the tag entry (same range).
 */
export function extractFile(
  doc: PMNode,
  enabled: ReadonlySet<FileObjectKind>,
): { objects: FileObject[]; outline: OutlineEntry[] } {
  const needCite = enabled.has('cite');
  // Always collect cite text: a tag is searchable by its cite even when
  // the standalone `cite` object kind is off (that only gates the
  // separate CITE rows below).
  const entries = collectHeadings(doc);
  const objects: FileObject[] = [];
  const outline: OutlineEntry[] = [];
  for (const entry of entries) {
    const kind = entry.type as FileObjectKind; // pocket/hat/block/tag/analytic
    const range = computeHeadingRange(doc, entry);
    if (!range) continue;
    const { from, to } = range;
    const label = entry.text.trim();
    // Outline: the full structure, independent of the enabled set.
    outline.push({ level: entry.level, kind, label, from, to });
    // Search hits: enabled kinds (with a label), plus cites.
    if (enabled.has(kind) && label !== '') {
      const obj: FileObject = { kind, label, detail: '', from, to };
      // Carry the card's cite on the tag so it's findable by citation.
      if (kind === 'tag' && entry.cite) obj.cite = entry.cite;
      objects.push(obj);
    }
    if (needCite && entry.type === 'tag' && entry.cite) {
      objects.push({ kind: 'cite', label: entry.cite.trim(), detail: label, from, to });
    }
  }
  return { objects, outline };
}
