// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { jumpToTokenInView } from '../../src/editor/plugin-jump.js';
import { mintSourceToken } from '../../src/editor/plugin-source-token.js';

function heading(type: string, text: string, id = newHeadingId()) {
  return schema.nodes[type]!.create({ id }, schema.text(text));
}
function makeView(doc: any) {
  let state = EditorState.create({ doc });
  return {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
    focus() {},
  } as any;
}

const id = newHeadingId();
const doc = schema.nodes['doc']!.createChecked(null, [
  heading('block', 'One'),
  heading('block', 'Target heading', id),
]);

describe('jumpToTokenInView', () => {
  it('jumps to a heading by UUID', () => {
    const view = makeView(doc);
    const token = mintSourceToken({ docId: 'd1', docTitle: 'T', headingId: id, anchor: null });
    expect(jumpToTokenInView(view, 'd1', token)).toEqual({ ok: true });
    expect(view.state.doc.resolve(view.state.selection.from).parent.textContent).toBe(
      'Target heading',
    );
  });
  it('falls back to the text anchor when the UUID is gone', () => {
    const view = makeView(doc);
    const token = mintSourceToken({
      docId: 'd1',
      docTitle: 'T',
      headingId: newHeadingId(), // not in the doc
      anchor: { quote: 'Target heading', prefix: '', suffix: '', approxPos: 5 },
    });
    expect(jumpToTokenInView(view, 'd1', token)).toEqual({ ok: true });
  });
  it("reports not-mine for another doc's token", () => {
    const view = makeView(doc);
    const token = mintSourceToken({ docId: 'other', docTitle: 'O', headingId: id, anchor: null });
    expect(jumpToTokenInView(view, 'd1', token)).toBe('not-mine');
  });
  it('reports not-found with the docTitle when nothing resolves', () => {
    const view = makeView(doc);
    const token = mintSourceToken({
      docId: 'd1',
      docTitle: 'T',
      headingId: newHeadingId(),
      anchor: { quote: 'absent text zzz', prefix: '', suffix: '', approxPos: 0 },
    });
    expect(jumpToTokenInView(view, 'd1', token)).toEqual({
      ok: false,
      error: 'not-found',
      docTitle: 'T',
    });
  });
  it('reports bad-request for garbage tokens', () => {
    const view = makeView(doc);
    expect(jumpToTokenInView(view, 'd1', 'garbage')).toEqual({ ok: false, error: 'bad-request' });
  });
});
