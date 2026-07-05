import { describe, it, expect } from 'vitest';
import { SettingsStore } from '../../src/editor/settings.js';
import { resolveStarredTarget } from '../../src/editor/pairing/send-to-starred.js';

// SettingsStore.replaceAll runs everything through sanitize(), so these exercise
// the pairing sanitizers (sanitizePairingPartners/Groups/Starred).
describe('pairing settings sanitize', () => {
  it('dedupes recipients by code and drops fully-empty entries', () => {
    const s = new SettingsStore();
    s.replaceAll({
      pairingPartners: [
        { code: 'cmk1.aaa', name: 'Alice' },
        { code: 'cmk1.aaa', name: 'Alice (dup code)' },
        { code: '', name: '' },
        { code: 'cmk1.bbb', name: 'Bob' },
      ],
    });
    expect(s.get('pairingPartners').map((p) => p.code)).toEqual(['cmk1.aaa', 'cmk1.bbb']);
  });

  it('groups require a label and drop members that are not known recipients', () => {
    const s = new SettingsStore();
    s.replaceAll({
      pairingPartners: [{ code: 'cmk1.aaa', name: 'Alice' }],
      pairingGroups: [
        { id: 'grp-1', label: 'Squad', memberCodes: ['cmk1.aaa', 'cmk1.ghost'] },
        { id: 'grp-2', label: '', memberCodes: ['cmk1.aaa'] },
      ],
    });
    const groups = s.get('pairingGroups');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('Squad');
    expect(groups[0]?.memberCodes).toEqual(['cmk1.aaa']); // ghost member pruned
  });

  it('keeps a starred recipient/group that exists', () => {
    const s = new SettingsStore();
    s.replaceAll({
      pairingPartners: [{ code: 'cmk1.aaa', name: 'Alice' }],
      pairingGroups: [{ id: 'grp-1', label: 'Squad', memberCodes: ['cmk1.aaa'] }],
      pairingStarred: { kind: 'partner', ref: 'cmk1.aaa' },
    });
    expect(s.get('pairingStarred')).toEqual({ kind: 'partner', ref: 'cmk1.aaa' });

    s.replaceAll({
      pairingPartners: [{ code: 'cmk1.aaa', name: 'Alice' }],
      pairingGroups: [{ id: 'grp-1', label: 'Squad', memberCodes: ['cmk1.aaa'] }],
      pairingStarred: { kind: 'group', ref: 'grp-1' },
    });
    expect(s.get('pairingStarred')).toEqual({ kind: 'group', ref: 'grp-1' });
  });

  it('clears a starred ref whose recipient/group no longer exists', () => {
    const s = new SettingsStore();
    s.replaceAll({
      pairingPartners: [{ code: 'cmk1.aaa', name: 'Alice' }],
      pairingStarred: { kind: 'partner', ref: 'cmk1.gone' },
    });
    expect(s.get('pairingStarred')).toBeNull();

    const s2 = new SettingsStore();
    s2.replaceAll({ pairingStarred: { kind: 'group', ref: 'grp-gone' } });
    expect(s2.get('pairingStarred')).toBeNull();
  });

  it('rejects a malformed starred value', () => {
    const s = new SettingsStore();
    s.replaceAll({ pairingStarred: 'nonsense' });
    expect(s.get('pairingStarred')).toBeNull();
  });
});

describe('resolveStarredTarget', () => {
  const partners = [
    { code: 'cmk1.aaa', name: 'Alice' },
    { code: 'cmk1.bbb', name: 'Bob' },
  ];
  const groups = [{ id: 'grp-1', label: 'Squad', memberCodes: ['cmk1.aaa', 'cmk1.bbb'] }];

  it('returns null when nothing is starred', () => {
    expect(resolveStarredTarget(null, partners, groups)).toBeNull();
  });

  it('resolves a starred recipient to its code + name label', () => {
    expect(resolveStarredTarget({ kind: 'partner', ref: 'cmk1.aaa' }, partners, groups)).toEqual({
      codes: ['cmk1.aaa'],
      label: 'Alice',
    });
  });

  it('falls back to the code as the label when the recipient has no name', () => {
    expect(resolveStarredTarget({ kind: 'partner', ref: 'cmk1.aaa' }, [{ code: 'cmk1.aaa', name: '' }], [])).toEqual({
      codes: ['cmk1.aaa'],
      label: 'cmk1.aaa',
    });
  });

  it('returns null for a starred recipient that is gone', () => {
    expect(resolveStarredTarget({ kind: 'partner', ref: 'cmk1.gone' }, partners, groups)).toBeNull();
  });

  it('resolves a starred group to its member codes + a via label', () => {
    expect(resolveStarredTarget({ kind: 'group', ref: 'grp-1' }, partners, groups)).toEqual({
      codes: ['cmk1.aaa', 'cmk1.bbb'],
      label: 'Squad',
      via: 'Squad',
    });
  });

  it('drops group members that are not current recipients', () => {
    const r = resolveStarredTarget(
      { kind: 'group', ref: 'grp-1' },
      partners,
      [{ id: 'grp-1', label: 'Squad', memberCodes: ['cmk1.aaa', 'cmk1.ghost'] }],
    );
    expect(r?.codes).toEqual(['cmk1.aaa']);
  });

  it('returns null for a starred group that is gone', () => {
    expect(resolveStarredTarget({ kind: 'group', ref: 'grp-gone' }, partners, groups)).toBeNull();
  });
});

describe('room-invite items', async () => {
  const { buildRoomInviteItem, parseRoomInvite, ROOM_INVITE_ITEM_TYPE, ROOM_INVITE_MIN_VERSION } =
    await import('../../src/editor/pairing/room-invite.js');

  it('round-trips through the inbox item shape', () => {
    const item = buildRoomInviteItem({
      shareCode: 'cmshare1.abc123.key456',
      title: 'Aff Updates',
    });
    expect(item.type).toBe(ROOM_INVITE_ITEM_TYPE);
    expect(item.label).toBe('Aff Updates');
    // exactly what the main process copies into the inbox verbatim
    const parsed = parseRoomInvite({ type: item.type, sliceJson: item.sliceJson });
    expect(parsed).toEqual({ shareCode: 'cmshare1.abc123.key456', title: 'Aff Updates' });
  });

  it('untitled docs get a generic label and empty title', () => {
    const item = buildRoomInviteItem({ shareCode: 'cmshare1.a.b', title: '' });
    expect(item.label).toBe('Collaboration session');
    expect(parseRoomInvite({ type: item.type, sliceJson: item.sliceJson })?.title).toBe('');
  });

  it('rejects non-invite and malformed items', () => {
    expect(parseRoomInvite({ type: 'card', sliceJson: { shareCode: 'cmshare1.a.b' } })).toBeNull();
    expect(parseRoomInvite({ type: ROOM_INVITE_ITEM_TYPE, sliceJson: null })).toBeNull();
    expect(parseRoomInvite({ type: ROOM_INVITE_ITEM_TYPE, sliceJson: {} })).toBeNull();
    // share codes from a different scheme are not joinable — reject early
    expect(
      parseRoomInvite({ type: ROOM_INVITE_ITEM_TYPE, sliceJson: { shareCode: 'cmk1.pubkey' } }),
    ).toBeNull();
  });

  it('declares a real version floor (old clients must drop invites)', () => {
    expect(ROOM_INVITE_MIN_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
