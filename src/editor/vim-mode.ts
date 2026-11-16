/**
 * Vim mode - modal editing for moving around a document and cutting
 * cards from the keyboard.
 *
 * Toggled by the `toggleVimMode` ribbon command (command bar, or bind a
 * key in Settings; no default key). The on/off state persists in
 * localStorage. Off, the plugin is completely inert. It is also inert
 * in read mode, and modifier chords and F-keys always pass through, so
 * every existing binding keeps working in every mode.
 *
 * NORMAL mode swallows bare keys and interprets them:
 *
 *   Motions     h l 0 ^ $        within the paragraph (a paragraph is
 *                                a vim "line"; h/l never leave it)
 *               w b e            words, crossing paragraphs
 *               j k              visual lines (sticky column)
 *               { }              previous / next paragraph start
 *               [[ ]]            previous / next heading
 *               gg G             first / last paragraph
 *               f t F T + char   find in paragraph
 *   Operators   d c y            delete / change / yank
 *               gh gu ge gb      highlight / underline / emphasis (x2)
 *               gc gx            cite / clear to Normal
 *               (MARK_OPS: each runs the real ribbon command, so the
 *               result is exactly what the F-key would have done)
 *   Targets     any motion, a text object (iw aw is as ip ap), or the
 *               operator again for the whole paragraph (dd, yy, ghgh).
 *               A charwise motion never operates past the edge of the
 *               current paragraph; j k gg G operate on whole paragraphs.
 *   Other       x D C p P u Ctrl-r .  i a I A o O  v V
 *   Counts      3w, d2w, 3dd, 5x
 *
 * VISUAL (v) and VISUAL LINE (V) extend the selection with motions and
 * text objects, then take one operator. Like vim, v includes the
 * character under the cursor. A mouse selection made in normal mode is
 * a visual selection, so drag + `gh` works.
 *
 * INSERT mode passes everything through; Escape returns to normal.
 *
 * Deliberate simplifications:
 *   - The cursor is ProseMirror's caret; normal mode shades the
 *     character after it. It may rest past the last character of a
 *     paragraph (vim's `virtualedit=onemore`).
 *   - One unnamed register, internal (formatting survives a yank/put);
 *     the system clipboard is untouched, Mod-C / Mod-V still work.
 *   - `.` repeats d / x / p / mark operators by replaying their keys;
 *     it does not replay text typed in insert mode.
 */

import { Plugin, PluginKey, Selection, TextSelection, type Command } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode, Slice } from 'prosemirror-model';
import { classifyChar, bareUnitAtIndex, queryUnitAtIndex } from './word-break.js';
import { TYPE_TO_LEVEL } from './headings.js';
import { readModePlugin } from './read-mode-plugin.js';
import { setIcon } from './icons';
import type { RibbonCommandId } from './ribbon-commands.js';

export interface VimModeDeps {
  /** Builds a real ribbon command with the editor's live context. */
  buildCommand: (id: RibbonCommandId) => Command;
}

/** Operators that apply formatting: key sequence -> ribbon command. */
const MARK_OPS: Record<string, RibbonCommandId> = {
  gh: 'applyHighlight',
  gu: 'applyUnderline',
  ge: 'applyEmphasis',
  gb: 'applyEmphasis',
  gc: 'applyCite',
  gx: 'clearToNormal',
};

type Mode = 'normal' | 'insert' | 'visual' | 'vline';
const MODE_LABELS: Record<Mode, string> = {
  normal: 'NORMAL',
  insert: 'INSERT',
  visual: 'VISUAL',
  vline: 'V-LINE',
};

const VIM_ENABLED_KEY = 'cardmirror.vimMode.v1';
const REDO_KEY = '\x12'; // Ctrl-r, as one buffer character

// Module-global ON PURPOSE (same reason as morph mode): the plugin set
// rebuilds on every reconfigure and multi-pane builds one instance per
// pane, and none of that may silently change the mode.
let enabled = (() => {
  try {
    return localStorage.getItem(VIM_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
})();
let mode: Mode = 'normal';
let pending = '';
let register: { slice: Slice; linewise: boolean } | null = null;
let lastChange = '';
let goalX: number | null = null;
let deps: VimModeDeps | null = null;
let indicator: HTMLDivElement | null = null;
const views = new Set<EditorView>();

const vimKey = new PluginKey('cm-vim-mode');

// ─── Parsing ───────────────────────────────────────────────────────

export interface ParsedKeys {
  count: number;
  op?: string;
  motion?: string;
  object?: string;
  /** Operator doubled (dd, ghgh): the whole paragraph. */
  line?: boolean;
  cmd?: string;
}

const OP_RE = /^(?:[dcy]|g[huebcx])/;
const MOTION_RE = /^(?:gg|\]\]|\[\[|[ftFT][\s\S]|[hjklwbe0^$G{}])$/;
const MOTION_PREFIX_RE = /^(?:g|\]|\[|[ftFT])$/;
const OBJECT_RE = /^[ia][wps]$/;
const LINEWISE_MOTION_RE = /^(?:j|k|gg|G)$/;

/** Parse a key buffer. 'more' = valid so far, keep reading; 'bad' =
 *  not a command, drop the buffer. */
export function parseKeys(buf: string, visual: boolean): ParsedKeys | 'more' | 'bad' {
  let s = buf;
  let count = 1;
  const takeCount = (): void => {
    const m = /^[1-9]\d*/.exec(s);
    if (!m) return;
    count *= Number(m[0]);
    s = s.slice(m[0].length);
  };
  takeCount();
  if (!s) return 'more';
  const op = OP_RE.exec(s)?.[0];
  if (op) {
    s = s.slice(op.length);
    if (visual) return s ? 'bad' : { count, op };
    takeCount();
    if (!s) return 'more';
    if (s === op) return { count, op, line: true };
    if (OBJECT_RE.test(s)) return { count, op, object: s };
    if (MOTION_RE.test(s)) return { count, op, motion: s };
    return MOTION_PREFIX_RE.test(s) || /^[ia]$/.test(s) ? 'more' : 'bad';
  }
  if (MOTION_RE.test(s)) return { count, motion: s };
  if (MOTION_PREFIX_RE.test(s)) return 'more';
  if (visual && OBJECT_RE.test(s)) return { count, object: s };
  if (visual && /^[ia]$/.test(s)) return 'more';
  const cmds = visual ? 'vVx' : `xDCiaIAoOpPuvV.${REDO_KEY}`;
  return s.length === 1 && cmds.includes(s) ? { count, cmd: s } : 'bad';
}

// ─── Document helpers ──────────────────────────────────────────────

/** The textblock around `pos`. `text` has exactly one character per
 *  document position (inline leaves become U+FFFC), so a text index
 *  plus `start` is a document position. */
function block(doc: PMNode, pos: number): { start: number; end: number; text: string } {
  const $p = doc.resolve(pos);
  return {
    start: $p.start(),
    end: $p.end(),
    text: $p.parent.textBetween(0, $p.parent.content.size, undefined, '￼'),
  };
}

function nextBlockStart(doc: PMNode, pos: number): number | null {
  const s = Selection.findFrom(doc.resolve(doc.resolve(pos).after()), 1, true);
  return s ? s.from : null;
}

function prevBlockEnd(doc: PMNode, pos: number): number | null {
  const s = Selection.findFrom(doc.resolve(doc.resolve(pos).before()), -1, true);
  return s ? s.from : null;
}

/** One position right, unless that would leave the textblock. */
function clampInc(doc: PMNode, pos: number): number {
  return pos < doc.resolve(pos).end() ? pos + 1 : pos;
}

/** One position left, unless that would leave the textblock. */
function clampDec(doc: PMNode, pos: number): number {
  return pos > doc.resolve(pos).start() ? pos - 1 : pos;
}

type Cls = 'word' | 'space' | 'punct';
function cls(ch: string | undefined): Cls {
  if (ch === undefined) return 'space';
  const c = classifyChar(ch);
  return c === 'tab' ? 'space' : c;
}

/** Index of the next word start after `i`, or null if the block has none. */
function wordFwd(text: string, i: number): number | null {
  const n = text.length;
  let j = i;
  const c = cls(text[j]);
  if (c !== 'space') while (j < n && cls(text[j]) === c) j++;
  while (j < n && cls(text[j]) === 'space') j++;
  return j < n ? j : null;
}

/** Index of the word start before `i`, or null if the block has none. */
function wordBack(text: string, i: number): number | null {
  let j = i - 1;
  while (j >= 0 && cls(text[j]) === 'space') j--;
  if (j < 0) return null;
  const c = cls(text[j]);
  while (j > 0 && cls(text[j - 1]) === c) j--;
  return j;
}

/** Index of the last char of the next word end after `i`, or null. */
function wordEnd(text: string, i: number): number | null {
  const n = text.length;
  let j = i + 1;
  while (j < n && cls(text[j]) === 'space') j++;
  if (j >= n) return null;
  const c = cls(text[j]);
  while (j + 1 < n && cls(text[j + 1]) === c) j++;
  return j;
}

function headingStarts(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name in TYPE_TO_LEVEL) out.push(pos + 1);
    return !node.isTextblock;
  });
  return out;
}

/** j / k: the position on the next / previous visual line closest to
 *  the sticky column. Purely geometric (coordsAtPos), so it works for
 *  lines scrolled out of view, which posAtCoords does not. */
function lineMove(view: EditorView, pos: number, dir: 1 | -1): number {
  const doc = view.state.doc;
  const cur = view.coordsAtPos(pos);
  const x = (goalX ??= cur.left);
  let b = block(doc, pos);
  let p = pos;
  let line: { top: number; bottom: number } | null = null;
  let best = pos;
  let bestDx = Infinity;
  // ponytail: linear scan, one coordsAtPos per character of at most two
  // visual lines; binary-search the line break if j/k ever feels slow.
  for (let n = 0; n < 2000; n++) {
    p += dir;
    if (p < b.start || p > b.end) {
      if (line) break;
      const adj = dir > 0 ? nextBlockStart(doc, b.end) : prevBlockEnd(doc, b.start);
      if (adj === null) break;
      b = block(doc, adj);
      p = adj;
    }
    const c = view.coordsAtPos(p);
    const from = line ?? cur;
    const sameLine = dir > 0 ? c.top < from.bottom - 1 : c.bottom > from.top + 1;
    if (!line) {
      if (sameLine) continue;
      line = c;
    } else if (!sameLine) break;
    const dx = Math.abs(c.left - x);
    if (dx < bestDx) {
      bestDx = dx;
      best = p;
    }
  }
  return best;
}

/** Destination of one application of `key` from `pos`. */
function motion(view: EditorView, key: string, pos: number): number {
  const doc = view.state.doc;
  const b = block(doc, pos);
  const i = pos - b.start;
  if (/^[ftFT]/.test(key)) {
    const fwd = key[0] === 'f' || key[0] === 't';
    const till = key[0] === 't' || key[0] === 'T';
    if (!fwd && i === 0) return pos;
    const j = fwd ? b.text.indexOf(key[1]!, i + 1) : b.text.lastIndexOf(key[1]!, i - 1);
    if (j < 0) return pos;
    return b.start + (till ? j - (fwd ? 1 : -1) : j);
  }
  switch (key) {
    case 'h': return Math.max(b.start, pos - 1);
    case 'l': return Math.min(b.end, pos + 1);
    case '0': return b.start;
    case '^': return b.start + Math.max(0, b.text.search(/\S/));
    case '$': return b.end;
    case 'w': {
      const j = wordFwd(b.text, i);
      return j !== null ? b.start + j : (nextBlockStart(doc, pos) ?? b.end);
    }
    case 'b': {
      const j = wordBack(b.text, i);
      if (j !== null) return b.start + j;
      const pe = prevBlockEnd(doc, pos);
      if (pe === null) return b.start;
      const pb = block(doc, pe);
      return pb.start + (wordBack(pb.text, pb.text.length) ?? 0);
    }
    case 'e': {
      const j = wordEnd(b.text, i);
      if (j !== null) return b.start + j;
      const ns = nextBlockStart(doc, pos);
      if (ns === null) return b.end;
      const nb = block(doc, ns);
      return nb.start + (wordEnd(nb.text, -1) ?? 0);
    }
    case '}': return nextBlockStart(doc, pos) ?? b.end;
    case '{': {
      if (pos > b.start) return b.start;
      const pe = prevBlockEnd(doc, pos);
      return pe === null ? pos : doc.resolve(pe).start();
    }
    case 'gg': return Selection.atStart(doc).from;
    case 'G': return doc.resolve(Selection.atEnd(doc).from).start();
    case ']]': return headingStarts(doc).find((s) => s > pos) ?? pos;
    case '[[': return headingStarts(doc).reverse().find((s) => s < pos) ?? pos;
    // Visual line mode selects whole paragraphs, so it steps by paragraph.
    case 'j': return mode === 'vline' ? (nextBlockStart(doc, pos) ?? pos) : lineMove(view, pos, 1);
    case 'k': return mode === 'vline' ? (prevBlockEnd(doc, pos) ?? pos) : lineMove(view, pos, -1);
  }
  return pos;
}

interface Range {
  from: number;
  to: number;
  linewise?: boolean;
}

function objectRange(doc: PMNode, pos: number, obj: string): Range | null {
  const b = block(doc, pos);
  if (obj[1] === 'p') return { from: b.start, to: b.end, linewise: obj === 'ap' };
  if (!b.text) return null;
  const i = Math.min(pos - b.start, b.text.length - 1);
  if (obj[1] === 'w') {
    const u = (obj === 'aw' ? queryUnitAtIndex : bareUnitAtIndex)(b.text, i);
    return { from: b.start + u.from, to: b.start + u.to };
  }
  // ponytail: a sentence ends at [.!?] plus closing quotes/brackets and
  // whitespace, so abbreviations ("U.S. policy") split early. Swap in
  // Intl.Segmenter('en', { granularity: 'sentence' }) if that bites.
  let from = 0;
  for (const m of b.text.matchAll(/[.!?]+["')\]”’]*(\s+|$)/g)) {
    const end = m.index! + m[0].length;
    if (i < end) {
      return { from: b.start + from, to: b.start + end - (obj === 'is' ? m[1]!.length : 0) };
    }
    from = end;
  }
  return { from: b.start + from, to: b.end };
}

// ─── Selection + mode plumbing ─────────────────────────────────────

function setSel(view: EditorView, anchor: number, head = anchor): void {
  const { state } = view;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)).scrollIntoView());
}

/** The characters a visual selection runs between: `a` where it was
 *  started, `h` where the cursor is. Derived from the selection rather
 *  than stored, so a mouse selection is a visual selection too. */
function visualEnds(sel: Selection): { a: number; h: number } {
  const { anchor: a, head: h } = sel;
  if (mode === 'vline' || a === h) return { a, h };
  const doc = sel.$head.doc;
  return h > a ? { a, h: clampDec(doc, h) } : { a: clampDec(doc, a), h };
}

function setVisual(view: EditorView, a: number, h: number): void {
  const doc = view.state.doc;
  if (mode === 'vline') {
    const $a = doc.resolve(a);
    const $h = doc.resolve(h);
    if (h >= a) setSel(view, $a.start(), $h.end());
    else setSel(view, $a.end(), $h.start());
  } else if (h >= a) setSel(view, a, clampInc(doc, h));
  else setSel(view, clampInc(doc, a), h);
}

/** A non-empty selection in normal mode (mouse drag, Shift-arrows) is
 *  a visual selection; an emptied one is back to normal. */
function syncMode(sel: Selection): void {
  if (mode === 'normal' && !sel.empty) mode = 'visual';
  else if (mode === 'visual' && sel.empty) mode = 'normal';
}

function setMode(view: EditorView, m: Mode): void {
  mode = m;
  pending = '';
  // Meta-only transaction: the block cursor is a decoration, and
  // decorations only recompute on a state update.
  view.dispatch(view.state.tr.setMeta(vimKey, m));
  renderIndicator();
}

function renderIndicator(): void {
  if (typeof document === 'undefined') return;
  if (!enabled) {
    indicator?.remove();
    indicator = null;
    return;
  }
  if (!indicator) {
    // ponytail: shares the morph chip's corner; the two overlap if both
    // modes are armed at once. Offset one when somebody does that.
    indicator = document.createElement('div');
    indicator.className = 'pmd-vim-chip';
    const badge = document.createElement('span');
    badge.className = 'pmd-vim-chip-badge';
    badge.textContent = 'Vim';
    const echo = document.createElement('span');
    echo.className = 'pmd-vim-chip-echo';
    const off = document.createElement('button');
    off.type = 'button';
    off.className = 'pmd-vim-chip-off';
    off.title = 'Turn off Vim mode';
    setIcon(off, 'close', { label: 'Turn off Vim mode' });
    off.addEventListener('click', () => toggleVimMode());
    indicator.append(badge, echo, off);
    document.body.appendChild(indicator);
  }
  indicator.dataset['mode'] = mode;
  const shown = pending.replace(REDO_KEY, '^R');
  indicator.querySelector('.pmd-vim-chip-echo')!.textContent =
    MODE_LABELS[mode] + (shown ? ` ${shown}` : '');
}

/** The `toggleVimMode` ribbon command's implementation. */
export function toggleVimMode(): void {
  enabled = !enabled;
  mode = 'normal';
  pending = '';
  try {
    localStorage.setItem(VIM_ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    /* storage unavailable: the toggle still holds for this session */
  }
  renderIndicator();
  for (const v of views) v.dispatch(v.state.tr.setMeta(vimKey, enabled));
}

// ─── Execution ─────────────────────────────────────────────────────

function runOp(view: EditorView, op: string, from: number, to: number, linewise: boolean): void {
  const { state } = view;
  const doc = state.doc;
  const $f = doc.resolve(from);
  const $t = doc.resolve(to);
  if (linewise) {
    from = $f.start();
    to = $t.end();
  }
  const markCmd = MARK_OPS[op];
  if (markCmd) {
    if (from === to || !deps) return;
    setSel(view, from, to);
    deps.buildCommand(markCmd)(view.state, view.dispatch, view);
    const s = view.state;
    const at = s.doc.resolve(Math.min(from, s.doc.content.size));
    view.dispatch(s.tr.setSelection(Selection.near(at)));
    return;
  }
  register = { slice: linewise ? doc.slice($f.before(), $t.after()) : doc.slice(from, to), linewise };
  if (op === 'y') {
    setSel(view, from);
    return;
  }
  const tr = state.tr;
  // dd removes the paragraph nodes themselves where the schema allows
  // it and something would be left in the parent; otherwise (a card's
  // tag, the document's only paragraph) it just empties them.
  const parent = $f.node(-1);
  const first = $f.index(-1);
  const last = $t.indexAfter(-1);
  const removable =
    linewise &&
    op === 'd' &&
    $f.start(-1) === $t.start(-1) &&
    last - first < parent.childCount &&
    parent.canReplace(first, last);
  if (removable) tr.delete($f.before(), $t.after());
  else tr.delete(from, to);
  tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(from))));
  view.dispatch(tr.scrollIntoView());
  if (op === 'c') setMode(view, 'insert');
}

function paste(view: EditorView, before: boolean): void {
  if (!register) return;
  const { state } = view;
  const pos = state.selection.head;
  const $p = state.doc.resolve(pos);
  const { slice, linewise } = register;
  const at = linewise ? (before ? $p.before() : $p.after()) : before ? pos : clampInc(state.doc, pos);
  const tr = state.tr.replaceRange(at, at, slice);
  const landed = linewise ? Math.min(at + 1, tr.doc.content.size) : tr.mapping.map(at, 1);
  tr.setSelection(Selection.near(tr.doc.resolve(landed), linewise ? 1 : -1));
  view.dispatch(tr.scrollIntoView());
}

/** o / O: open a paragraph below / above by pressing Enter at the
 *  paragraph's edge, so the app's own Enter rules (tags, cards, cite
 *  lines) decide what kind of paragraph that is. */
function openLine(view: EditorView, above: boolean): void {
  const b = block(view.state.doc, view.state.selection.head);
  setSel(view, above ? b.start : b.end);
  mode = 'insert'; // so this plugin lets the synthetic Enter through
  const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter' });
  view.someProp('handleKeyDown', (f) => f(view, enter));
  if (above) {
    const s = view.state;
    const prev = Selection.findFrom(s.doc.resolve(s.selection.$head.before()), -1, true);
    if (prev) view.dispatch(s.tr.setSelection(prev));
  }
  setMode(view, 'insert');
}

function execute(view: EditorView, p: ParsedKeys, keys: string): void {
  const { state } = view;
  const doc = state.doc;
  const sel = state.selection;
  if (p.motion !== 'j' && p.motion !== 'k') goalX = null;
  const moveFrom = (pos: number): number => {
    let d = pos;
    for (let n = 0; n < p.count; n++) d = motion(view, p.motion!, d);
    return d;
  };

  if (mode !== 'normal') {
    const { a, h } = visualEnds(sel);
    if (p.motion) return setVisual(view, a, moveFrom(h));
    if (p.object) {
      const r = objectRange(doc, h, p.object);
      if (r) setSel(view, r.from, r.to);
      return;
    }
    if (p.cmd === 'v' || p.cmd === 'V') {
      const target: Mode = p.cmd === 'v' ? 'visual' : 'vline';
      if (mode === target) {
        setSel(view, h);
        return setMode(view, 'normal');
      }
      mode = target;
      setVisual(view, a, h);
      return setMode(view, target);
    }
    runOp(view, p.op ?? 'd', sel.from, sel.to, mode === 'vline');
    if ((mode as Mode) !== 'insert') setMode(view, 'normal');
    return;
  }

  const pos = sel.head;
  if (p.op) {
    let r: Range | null = { from: pos, to: pos, linewise: true };
    if (p.line) {
      for (let n = 1; n < p.count; n++) r.to = nextBlockStart(doc, r.to) ?? r.to;
    } else if (p.object) {
      r = objectRange(doc, pos, p.object);
    } else {
      let dest = moveFrom(pos);
      const linewise = LINEWISE_MOTION_RE.test(p.motion!);
      if (!linewise) {
        const b = block(doc, pos);
        dest = Math.max(b.start, Math.min(b.end, dest));
        if (dest === pos) return;
        // e, f and t land ON the last character they cover.
        if (dest > pos && /^[eft]/.test(p.motion!)) dest = Math.min(b.end, dest + 1);
      }
      r = { from: Math.min(pos, dest), to: Math.max(pos, dest), linewise };
    }
    if (!r) return;
    runOp(view, p.op, r.from, r.to, !!r.linewise);
    if (p.op !== 'y' && p.op !== 'c') lastChange = keys;
    return;
  }
  if (p.motion) return setSel(view, moveFrom(pos));

  const b = block(doc, pos);
  const run = (id: RibbonCommandId): void => {
    for (let n = 0; n < p.count; n++) deps?.buildCommand(id)(view.state, view.dispatch, view);
  };
  switch (p.cmd) {
    case 'x': {
      const to = Math.min(b.end, pos + p.count);
      if (to === pos) return;
      runOp(view, 'd', pos, to, false);
      lastChange = keys;
      return;
    }
    case 'D':
      runOp(view, 'd', pos, b.end, false);
      lastChange = keys;
      return;
    case 'C': return runOp(view, 'c', pos, b.end, false);
    case 'i': return setMode(view, 'insert');
    case 'a':
      setSel(view, clampInc(doc, pos));
      return setMode(view, 'insert');
    case 'I':
      setSel(view, b.start);
      return setMode(view, 'insert');
    case 'A':
      setSel(view, b.end);
      return setMode(view, 'insert');
    case 'o': return openLine(view, false);
    case 'O': return openLine(view, true);
    case 'p':
    case 'P':
      paste(view, p.cmd === 'P');
      lastChange = keys;
      return;
    case 'u': return run('undo');
    case REDO_KEY: return run('redo');
    case 'v':
    case 'V':
      mode = p.cmd === 'v' ? 'visual' : 'vline';
      setVisual(view, pos, pos);
      return setMode(view, mode);
    case '.':
      for (const k of lastChange) feed(view, k);
      return;
  }
}

function feed(view: EditorView, key: string): void {
  pending += key;
  const parsed = parseKeys(pending, mode !== 'normal');
  if (parsed !== 'more') {
    const keys = pending;
    pending = '';
    if (parsed !== 'bad') execute(view, parsed, keys);
  }
  renderIndicator();
}

/** Returns true when the key was consumed. */
function handleKey(view: EditorView, event: KeyboardEvent): boolean {
  if (mode === 'insert') {
    if (event.key !== 'Escape') return false;
    const { empty, head, $head } = view.state.selection;
    if (empty && head > $head.start()) setSel(view, head - 1);
    setMode(view, 'normal');
    return true;
  }
  let sel = view.state.selection;
  syncMode(sel);
  if (event.key === 'Escape') {
    if (mode === 'normal' && !pending) return false; // not ours: let it close whatever it closes
    if (mode !== 'normal' && sel instanceof TextSelection) setSel(view, visualEnds(sel).h);
    setMode(view, 'normal');
    return true;
  }
  const redo = event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'r';
  if (!redo && (event.ctrlKey || event.metaKey || event.altKey)) return false;
  // Never edit from normal mode by accident.
  if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter') return true;
  if (event.key.length !== 1) return false;
  if (!(sel instanceof TextSelection)) {
    // Node / cell / all selections: everything below thinks in text
    // positions, so move to the nearest text selection first.
    sel = TextSelection.between(sel.$anchor, sel.$head);
    if (!(sel instanceof TextSelection)) return true;
    view.dispatch(view.state.tr.setSelection(sel));
    syncMode(sel);
  }
  feed(view, redo ? REDO_KEY : event.key);
  return true;
}

export function vimModePlugin(d: VimModeDeps): Plugin {
  deps = d;
  const active = (view: EditorView): boolean =>
    enabled && !readModePlugin.getState(view.state)?.on;
  return new Plugin({
    key: vimKey,
    props: {
      handleKeyDown(view, event) {
        if (!active(view) || event.isComposing) return false;
        try {
          return handleKey(view, event);
        } catch (err) {
          // The schema has shapes a generic delete / put cannot fit; a
          // logged no-op beats a thrown keystroke.
          console.warn('[vim-mode]', err);
          pending = '';
          return true;
        }
      },
      handleTextInput(view) {
        return active(view) && mode !== 'insert';
      },
      decorations(state) {
        if (!enabled || mode !== 'normal' || readModePlugin.getState(state)?.on) return null;
        const { empty, head, $head } = state.selection;
        if (!empty || !$head.parent.inlineContent || head >= $head.end()) return null;
        return DecorationSet.create(state.doc, [
          Decoration.inline(head, head + 1, { class: 'pmd-vim-cursor' }),
        ]);
      },
    },
    view(view) {
      views.add(view);
      renderIndicator();
      return {
        update(v) {
          if (!enabled || !v.hasFocus()) return;
          const before = mode;
          syncMode(v.state.selection);
          if (mode !== before) renderIndicator();
        },
        destroy() {
          views.delete(view);
        },
      };
    },
  });
}
