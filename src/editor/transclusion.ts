/**
 * Transclusion "live zones" — core logic (see TRANSCLUSION_PLAN.md).
 *
 * A live zone (`transclusion_ref` node) renders the contents under a heading
 * in another CardMirror file. This module is the PURE, view-independent core:
 * extracting a section from a source doc, hashing it, building the node,
 * detaching it back to plain content, computing the doc-relative source path,
 * and the cycle-identity helpers. The NodeView (transclusion-nodeview.ts) and
 * the commands/IPC glue (transclusion-commands.ts) build on this.
 *
 * Nothing here touches the DOM or Electron, so it is fully unit-testable.
 */
import { Fragment, Slice } from 'prosemirror-model';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { NodeSelection } from 'prosemirror-state';
import type { Selection } from 'prosemirror-state';
import {
  collectHeadings,
  computeHeadingRange,
  TYPE_LABEL,
} from './headings.js';

export const TRANSCLUSION_NODE = 'transclusion_ref';

/** Hard cap on how deep nested live zones render before we stop and show a
 *  placeholder. Snapshots are finite so this is a perf/pathology backstop,
 *  not a correctness guard — see TRANSCLUSION_PLAN.md §7. */
export const MAX_NEST_DEPTH = 8;

export type SourceRefBase = 'doc' | 'root';

export interface TransclusionAttrs {
  source_ref: string;
  source_ref_base: SourceRefBase;
  source_heading_id: string;
  content_hash: string;
  cached_content: unknown[] | null;
  last_refreshed: number;
  source_label: string;
}

export interface ExtractResult {
  /** `Fragment.toJSON()` (array of node JSON) or null when the section is
   *  empty — suitable to store directly in `cached_content`. */
  cachedContent: unknown[] | null;
  /** Stable hash of the cached fragment, for staleness comparison. */
  contentHash: string;
  /** The target heading's own text (for the breadcrumb). */
  headingLabel: string;
  /** Schema type of the target heading (pocket/hat/block/tag/analytic). */
  headingType: string;
}

export function isTransclusionNode(node: PMNode | null | undefined): boolean {
  return !!node && node.type.name === TRANSCLUSION_NODE;
}

/**
 * Extract the transcludable content under `headingId` from a source doc.
 *
 * - pocket / hat / block → the contents BELOW the header (the header line
 *   itself excluded), down to the next heading of equal-or-higher level.
 * - tag / analytic → the whole card / analytic_unit (tagline included).
 *
 * Returns null if the heading id isn't present in the doc.
 */
export function extractSection(doc: PMNode, headingId: string): ExtractResult | null {
  if (!headingId) return null;
  const entry = collectHeadings(doc, { skipCite: true }).find((h) => h.id === headingId);
  if (!entry) return null;
  const range = computeHeadingRange(doc, entry);
  if (!range) return null;

  let from = range.from;
  if (entry.type !== 'tag' && entry.type !== 'analytic') {
    // pocket/hat/block: drop the header line, keep everything under it.
    const node = doc.nodeAt(entry.pos);
    if (!node) return null;
    from = entry.pos + node.nodeSize;
  }
  const to = range.to;
  if (to < from) return null;

  const slice = doc.slice(from, to);
  const frag = slice.content;
  const cachedContent = frag.size > 0 ? (frag.toJSON() as unknown[] | null) : null;
  return {
    cachedContent: cachedContent ?? null,
    contentHash: hashFragmentJSON(cachedContent ?? null),
    headingLabel: entry.text.trim() || TYPE_LABEL[entry.type] || entry.type,
    headingType: entry.type,
  };
}

/** Deserialize a `cached_content` value into a Fragment, tolerating any
 *  malformed shape (returns an empty Fragment rather than throwing, so a
 *  corrupt cache can never white-screen the editor). */
export function fragmentFromCache(schema: Schema, cache: unknown): Fragment {
  if (cache == null) return Fragment.empty;
  try {
    return Fragment.fromJSON(schema, cache as Parameters<typeof Fragment.fromJSON>[1]);
  } catch {
    return Fragment.empty;
  }
}

/** Build a `transclusion_ref` node from attrs (missing fields defaulted). */
export function createTransclusionNode(
  schema: Schema,
  attrs: Partial<TransclusionAttrs>,
): PMNode {
  const type = schema.nodes[TRANSCLUSION_NODE];
  if (!type) throw new Error('transclusion_ref not registered in schema');
  return type.create({
    source_ref: attrs.source_ref ?? '',
    source_ref_base: attrs.source_ref_base ?? 'doc',
    source_heading_id: attrs.source_heading_id ?? '',
    content_hash: attrs.content_hash ?? '',
    cached_content: attrs.cached_content ?? null,
    last_refreshed: attrs.last_refreshed ?? 0,
    source_label: attrs.source_label ?? '',
  });
}

/** The stable identity of a zone's target — `source_ref` + heading id.
 *  Used to detect cycles across nested-zone rendering. */
export const ZONE_ID_SEP = '\u0000';
export function zoneIdentity(node: PMNode): string {
  // NUL separator: it can never appear in a path or a UUID, unlike a space
  // (real Dropbox paths contain spaces, e.g. "Debate Files").
  return `${String(node.attrs['source_ref'] ?? '')}${ZONE_ID_SEP}${String(node.attrs['source_heading_id'] ?? '')}`;
}

/**
 * The content a Detach should leave behind: the zone's cached fragment as a
 * Slice, ready to replace the node. Heading ids inside are rewritten so a
 * detached copy never shares a UUID with the source (which would confuse the
 * nav pane and future transclusions). Returns an empty Slice for an empty
 * cache (the zone then just vanishes on detach).
 */
export function detachSlice(
  schema: Schema,
  node: PMNode,
  freshId: () => string,
): Slice {
  const frag = fragmentFromCache(schema, node.attrs['cached_content']);
  if (frag.size === 0) return Slice.empty;
  return new Slice(rewriteHeadingIdsInFragment(frag, freshId), 0, 0);
}

/** Rewrite every heading id in a fragment to a fresh UUID (deep). Mirrors the
 *  drag-copy id-rewrite so a materialized/detached section can't collide ids
 *  with its source. */
export function rewriteHeadingIdsInFragment(
  frag: Fragment,
  freshId: () => string,
): Fragment {
  const mapped: PMNode[] = [];
  frag.forEach((child) => mapped.push(rewriteHeadingIdsInNode(child, freshId)));
  return Fragment.fromArray(mapped);
}

function rewriteHeadingIdsInNode(node: PMNode, freshId: () => string): PMNode {
  const hasId = typeof node.attrs['id'] === 'string' && node.attrs['id'];
  const newContent = node.content.size
    ? rewriteHeadingIdsInFragment(node.content, freshId)
    : node.content;
  if (hasId) {
    return node.type.create({ ...node.attrs, id: freshId() }, newContent, node.marks);
  }
  if (newContent !== node.content) {
    return node.type.create(node.attrs, newContent, node.marks);
  }
  return node;
}

/** All zone identities that appear as DIRECT children of a fragment. Zones
 *  only ever appear at the top level of a section (the schema forbids them
 *  inside cards), so a shallow scan is complete. Used for the picker's
 *  direct-cycle check. */
export function directZoneIdentities(frag: Fragment): Set<string> {
  const out = new Set<string>();
  frag.forEach((child) => {
    if (child.type.name === TRANSCLUSION_NODE) out.add(zoneIdentity(child));
  });
  return out;
}

/** If the current selection is a NodeSelection over a live zone, return it. */
export function selectedTransclusion(
  selection: Selection,
): { node: PMNode; pos: number } | null {
  if (selection instanceof NodeSelection && isTransclusionNode(selection.node)) {
    return { node: selection.node, pos: selection.from };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hashing — a stable, cross-machine content hash of the cached fragment.
// ---------------------------------------------------------------------------

/** Deterministic hash of a `cached_content` value. Two machines that extract
 *  byte-identical source sections produce the same hash, so staleness is a
 *  cheap compare. `null`/empty hashes to a fixed sentinel. */
export function hashFragmentJSON(json: unknown): string {
  if (json == null) return 'empty';
  return cyrb53(stableStringify(json)).toString(36);
}

/** JSON.stringify with object keys sorted recursively, so attr-key insertion
 *  order can't perturb the hash across machines. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** cyrb53 — a fast, well-distributed 53-bit string hash (public domain). */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// ---------------------------------------------------------------------------
// Doc-relative path — store source refs relative to the transcluding doc so
// they survive different absolute roots across machines (TRANSCLUSION_PLAN §3).
// ---------------------------------------------------------------------------

/** Split a file path into segments, tolerating both `/` and `\` separators
 *  and a leading drive letter, so it works for Dropbox paths on any OS. */
function splitPath(p: string): { drive: string; segs: string[]; absolute: boolean } {
  let s = p.replace(/\\/g, '/');
  let drive = '';
  const driveMatch = s.match(/^([a-zA-Z]:)\//);
  if (driveMatch) {
    drive = driveMatch[1]!.toUpperCase();
    s = s.slice(driveMatch[1]!.length);
  }
  const absolute = s.startsWith('/') || drive !== '';
  const segs = s.split('/').filter((seg) => seg !== '' && seg !== '.');
  return { drive, segs, absolute };
}

/**
 * Compute the path to `toFile` relative to the DIRECTORY of `fromFile`, using
 * forward slashes. Returns null if the two live on different drives (no
 * relative path exists) — the caller then can't make a portable ref.
 *
 *   relativeSourceRef('/a/b/Doc.cmir', '/a/c/Src.cmir') === '../c/Src.cmir'
 */
export function relativeSourceRef(fromFile: string, toFile: string): string | null {
  const from = splitPath(fromFile);
  const to = splitPath(toFile);
  if (from.drive !== to.drive) return null;
  // Directory of fromFile = its segments minus the filename.
  const fromDir = from.segs.slice(0, -1);
  const toSegs = to.segs;
  let common = 0;
  while (
    common < fromDir.length &&
    common < toSegs.length &&
    fromDir[common] === toSegs[common]
  ) {
    common++;
  }
  const up = fromDir.length - common;
  const rel = [...Array(up).fill('..'), ...toSegs.slice(common)];
  return rel.length ? rel.join('/') : '.';
}

/** True if `target` is inside directory `base` (or is `base` itself). Pure
 *  string form of the desktop `isWithin`; used at insert time in the renderer. */
export function isWithinPure(base: string, target: string): boolean {
  const b = splitPath(base);
  const t = splitPath(target);
  if (b.drive !== t.drive) return false;
  if (t.segs.length < b.segs.length) return false;
  for (let i = 0; i < b.segs.length; i++) {
    if (b.segs[i] !== t.segs[i]) return false;
  }
  return true;
}

/** Path of `target` relative to directory `base` (forward slashes), or null if
 *  `target` isn't inside `base`. */
export function rootRelative(base: string, target: string): string | null {
  if (!isWithinPure(base, target)) return null;
  const b = splitPath(base);
  const t = splitPath(target);
  const rel = t.segs.slice(b.segs.length);
  return rel.length ? rel.join('/') : '.';
}

/**
 * Choose how to store a source ref (user's shared-Dropbox insight): prefer
 * **root-relative** when the transcluding doc AND the source both live under the
 * same configured library root — that ref survives the doc being moved around
 * inside the shared folder, and every teammate has the folder configured. Fall
 * back to **doc-relative** otherwise. Returns null if no portable ref exists
 * (e.g. different Windows drives with no shared root).
 */
export function chooseSourceRef(
  docPath: string,
  sourceAbs: string,
  roots: readonly string[],
): { ref: string; base: SourceRefBase } | null {
  for (const root of roots) {
    if (!root) continue;
    if (isWithinPure(root, docPath) && isWithinPure(root, sourceAbs)) {
      const ref = rootRelative(root, sourceAbs);
      if (ref && ref !== '.') return { ref, base: 'root' };
    }
  }
  const rel = relativeSourceRef(docPath, sourceAbs);
  return rel ? { ref: rel, base: 'doc' } : null;
}
