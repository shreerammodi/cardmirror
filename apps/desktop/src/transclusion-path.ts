/**
 * Path safety for transclusion refresh (desktop).
 *
 * Given the transcluding document's own absolute path and a RELATIVE source
 * ref, resolve the ref against the doc's directory and HARD-SCOPE the result to
 * the configured library roots (or the doc's own folder), rejecting any `..`
 * escape. The ref can travel inside a document authored by someone else, so
 * this is a real security boundary — see TRANSCLUSION_PLAN.md §3.2.
 *
 * Pure (only `node:path`), so it's unit-tested in
 * tests/desktop/transclusion-path.test.ts and reused by the `host:read-cmir-file`
 * handler in main.ts.
 */
import * as path from 'node:path';

/** True if `target` is `base` itself or sits inside it (no `..` escape). */
export function isWithin(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
  );
}

export type SourceRefBase = 'doc' | 'root';

/**
 * Resolve a `.cmir` ref to the ordered list of safe absolute candidate paths.
 *
 * - base 'doc': resolve against the doc's directory; allow it inside any library
 *   root or the doc's own folder (one candidate).
 * - base 'root': resolve against EACH configured library root and keep the ones
 *   that stay inside their own root — the ref is root-relative, so it lands on
 *   the shared folder regardless of its absolute prefix on this machine. Order
 *   follows the roots list; the caller reads the first that exists.
 *
 * A candidate must be a `.cmir` and pass containment; anything else is dropped,
 * so a hostile ref can't escape the safe roots (TRANSCLUSION_PLAN.md §3.2).
 */
export function resolveCmirCandidates(
  docPath: string,
  sourceRef: string,
  base: SourceRefBase,
  roots: readonly string[],
): string[] {
  if (!docPath || !sourceRef) return [];
  const cleanRoots = roots.filter((r) => typeof r === 'string' && r !== '');
  const out: string[] = [];
  const consider = (abs: string, allowed: string[]): void => {
    if (path.extname(abs).toLowerCase() !== '.cmir') return;
    if (allowed.some((b) => isWithin(b, abs))) out.push(abs);
  };
  if (base === 'root') {
    for (const root of cleanRoots) {
      let abs: string;
      try {
        abs = path.resolve(root, sourceRef);
      } catch {
        continue;
      }
      consider(abs, [root]);
    }
  } else {
    let abs: string;
    try {
      abs = path.resolve(path.dirname(docPath), sourceRef);
    } catch {
      return out;
    }
    consider(abs, [...cleanRoots, path.dirname(docPath)]);
  }
  return [...new Set(out)];
}

/** Single doc-relative resolution — first (only) candidate for base 'doc'. */
export function resolveCmirRef(
  docPath: string,
  sourceRef: string,
  roots: readonly string[],
): string | null {
  return resolveCmirCandidates(docPath, sourceRef, 'doc', roots)[0] ?? null;
}
