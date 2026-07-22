// tests/editor/plugin-source-token.test.ts
import { describe, expect, it } from 'vitest';
import {
  mintSourceToken,
  parseSourceToken,
  type SourcePayload,
} from '../../src/editor/plugin-source-token.js';

const payload: SourcePayload = {
  docId: 'doc-123',
  docTitle: 'AT Cap K — «weird» título.docx',
  headingId: 'a1b2c3d4-0000-0000-0000-000000000000',
  anchor: { quote: 'Perm solves', prefix: 'before ', suffix: ' after', approxPos: 42 },
};

describe('source token', () => {
  it('round-trips a payload, unicode included', () => {
    const token = mintSourceToken(payload);
    expect(token.startsWith('cmsrc1.')).toBe(true);
    expect(parseSourceToken(token)).toEqual(payload);
  });
  it('round-trips null headingId and null anchor', () => {
    const p: SourcePayload = { docId: 'd', docTitle: '', headingId: null, anchor: null };
    expect(parseSourceToken(mintSourceToken(p))).toEqual(p);
  });
  it('rejects a wrong prefix', () => {
    const token = mintSourceToken(payload).replace(/^cmsrc1/, 'cmsrc9');
    expect(parseSourceToken(token)).toBeNull();
  });
  it('rejects garbage and non-strings', () => {
    expect(parseSourceToken('cmsrc1.!!!not-base64!!!')).toBeNull();
    expect(parseSourceToken('no-dot-here')).toBeNull();
    expect(parseSourceToken(undefined as unknown as string)).toBeNull();
  });
  it('rejects a payload without docId', () => {
    const bare = 'cmsrc1.' + Buffer.from(JSON.stringify({ docTitle: 'x' })).toString('base64url');
    expect(parseSourceToken(bare)).toBeNull();
  });
});
