// @vitest-environment jsdom
/**
 * A provenance token has to survive the user MOVING the line it names.
 *
 * The whole point of a token is that a companion app can come back to the
 * same line later: ebb sends an argument in, keeps the token on the cell it
 * came from, and rewrites that line whenever the debater edits the cell. A
 * cut and paste is the ordinary way a line moves inside a document, and
 * before the paste kept heading ids it minted a new one for every pasted
 * heading - which orphaned the token's heading id, dropped resolution onto
 * the text anchor, and answered `not-found` once the move had changed the
 * surrounding context. The line was still on screen; the link to it was
 * gone.
 *
 * The control is the copy: a duplicate must NOT capture the token, or an
 * edit in the companion app would rewrite whichever copy resolution
 * happened to hit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DOMSerializer, DOMParser as PMDOMParser, Slice } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildPastePlugin } from '../../src/editor/paste-plugin.js';
import { installExternalInsertHost } from '../../src/editor/external-insert-host.js';
import { replaceTokenInView } from '../../src/editor/external-replace.js';
import { resolveSourceRange } from '../../src/editor/plugin-source-range.js';
import { parseSourceToken } from '../../src/editor/plugin-source-token.js';

const DOC_ID = 'doc-1';

const ctx = {
  condenseOnPaste: () => false,
  paragraphIntegrity: () => false,
  usePilcrows: () => false,
  smartPasteConversion: () => false,
  headingMode: () => 'strict' as const,
};

function analytic(text: string) {
  return schema.nodes['analytic_unit']!.createChecked(null, [
    schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text(text)),
  ]);
}

/** A doc of three analytics with the paste plugin live, so pastes run the
 *  same `transformPasted` the app does. */
function build(): { view: EditorView; cleanup: () => void } {
  const doc = schema.nodes['doc']!.createChecked(null, [
    analytic('arg one'),
    analytic('arg two'),
    analytic('arg three'),
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView(container, {
    state: EditorState.create({ doc, plugins: [buildPastePlugin(ctx)] }),
  });
  return { view, cleanup: () => { view.destroy(); container.remove(); } };
}

/** Put the caret at the end of the analytic whose text is `text`. */
function caretAfter(view: EditorView, text: string): void {
  let pos = -1;
  view.state.doc.descendants((node, at) => {
    if (pos !== -1) return false;
    if (node.type.name === 'analytic_unit' && node.textContent === text) {
      pos = at + node.nodeSize;
      return false;
    }
    return true;
  });
  // `near`, not `create`: the position past a unit's closing token is not
  // itself an inline position, and PM warns rather than snapping.
  view.dispatch(
    view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos - 1))),
  );
}

/** The token ebb would be holding: send one line in through the insert
 *  host and keep the provenance the ack carries. */
function sendLine(view: EditorView, text: string): string {
  let handler: ((req: unknown) => void) | null = null;
  const acks: { sources?: string[] }[] = [];
  (window as unknown as Record<string, unknown>).electronAPI = {
    onExternalInsertRequest: (h: (req: unknown) => void) => {
      handler = h;
      return () => { handler = null; };
    },
    sendExternalInsertResult: (r: { sources?: string[] }) => { acks.push(r); },
  };
  const off = installExternalInsertHost({
    getFocusedView: () => view,
    getFocusedDocTitle: () => 'doc.cmir',
    getDocIdentity: () => ({ docId: DOC_ID, docTitle: 'doc.cmir' }),
  });
  handler!({ requestId: 'r1', text, role: 'analytic', newParagraph: true, omitted: false });
  off();
  delete (window as unknown as Record<string, unknown>).electronAPI;
  const token = acks[0]?.sources?.[0];
  expect(token, 'the insert answered with provenance').toBeTruthy();
  return token!;
}

/** The unit whose text is `text`, as the clipboard would carry it. */
function clipboardSlice(view: EditorView, text: string): Slice {
  let node: ReturnType<typeof analytic> | null = null;
  view.state.doc.forEach((child) => {
    if (child.textContent === text) node = child;
  });
  const div = document.createElement('div');
  div.appendChild(
    DOMSerializer.fromSchema(schema).serializeFragment(
      schema.nodes['doc']!.createChecked(null, [node!]).content,
    ),
  );
  return PMDOMParser.fromSchema(schema).parseSlice(div);
}

/** Delete the unit holding `text` - the cut half of Cmd+X. */
function cut(view: EditorView, text: string): void {
  let from = -1;
  let to = -1;
  view.state.doc.forEach((child, offset) => {
    if (child.textContent === text) { from = offset; to = offset + child.nodeSize; }
  });
  view.dispatch(view.state.tr.delete(from, to));
}

/**
 * Paste `slice` at the top-level boundary after the unit holding `after`,
 * through the plugin's own transform.
 *
 * An explicit position rather than a caret: what is under test is the id
 * pass, and a caret inside a textblock would have PM merge the pasted unit
 * into that block instead of dropping it in beside it.
 */
function pasteAfter(view: EditorView, slice: Slice, after: string): void {
  let at = -1;
  view.state.doc.forEach((child, offset) => {
    if (child.textContent === after) at = offset + child.nodeSize;
  });
  const plugin = buildPastePlugin(ctx);
  const transformed = plugin.props.transformPasted!.call(plugin, slice, view, false);
  view.dispatch(view.state.tr.replace(at, at, transformed));
}

function texts(view: EditorView): string[] {
  const out: string[] = [];
  view.state.doc.forEach((child) => out.push(child.textContent));
  return out;
}

describe('a provenance token across a move', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  it('still names the line after a cut and paste, and a rewrite lands on it', () => {
    const built = build();
    cleanup = built.cleanup;
    const view = built.view;

    caretAfter(view, 'arg two');
    const token = sendLine(view, 'sent from the flow');
    expect(texts(view)).toContain('sent from the flow');

    // Cmd+X, caret elsewhere, Cmd+V: the same line, further down.
    const slice = clipboardSlice(view, 'sent from the flow');
    cut(view, 'sent from the flow');
    pasteAfter(view, slice, 'arg three');
    expect(texts(view)).toEqual([
      'arg one',
      'arg two',
      'arg three',
      'sent from the flow',
    ]);

    const payload = parseSourceToken(token)!;
    const range = resolveSourceRange(view.state.doc, payload);
    expect(range, 'the token resolves after the move').not.toBeNull();
    expect(view.state.doc.textBetween(range!.from, range!.to)).toBe('sent from the flow');

    // The route ebb takes on the debater's next edit to that cell.
    const res = replaceTokenInView(view, DOC_ID, token, 'sharpened in the flow');
    expect(res).toMatchObject({ ok: true });
    expect(texts(view)).toEqual([
      'arg one',
      'arg two',
      'arg three',
      'sharpened in the flow',
    ]);
  });

  it('keeps naming the original when the line is copied, not moved', () => {
    const built = build();
    cleanup = built.cleanup;
    const view = built.view;

    caretAfter(view, 'arg one');
    const token = sendLine(view, 'sent from the flow');

    // Cmd+C, Cmd+V: the original stays, so the duplicate is a new line.
    const slice = clipboardSlice(view, 'sent from the flow');
    pasteAfter(view, slice, 'arg three');
    expect(texts(view).filter((t) => t === 'sent from the flow')).toHaveLength(2);

    const res = replaceTokenInView(view, DOC_ID, token, 'sharpened in the flow');
    expect(res).toMatchObject({ ok: true });
    // The first one is the line that was sent; the copy is untouched.
    expect(texts(view)).toEqual([
      'arg one',
      'sharpened in the flow',
      'arg two',
      'arg three',
      'sent from the flow',
    ]);
  });
});
