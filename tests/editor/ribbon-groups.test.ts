/**
 * The ribbon-group layout must cover the command registry exactly — every
 * RibbonCommandId in one group, no duplicates, no strays. The app asserts this
 * at boot (`assertGroupsCoverRegistry`), which used to be the *only* guard: a
 * new command with no group crashed the renderer but passed the test suite.
 * (Importing this module also runs that boot assertion.)
 */

import { describe, it, expect } from 'vitest';
import { RIBBON_GROUPS } from '../../src/editor/ribbon-groups.js';
import { RIBBON_COMMAND_IDS } from '../../src/editor/ribbon-commands.js';

describe('ribbon groups vs. command registry', () => {
  const placed = RIBBON_GROUPS.flatMap((g) => g.commands);
  const placedSet = new Set(placed);
  const registry = new Set<string>(RIBBON_COMMAND_IDS);

  it('every command id is placed in a group', () => {
    expect(RIBBON_COMMAND_IDS.filter((id) => !placedSet.has(id))).toEqual([]);
  });

  it('no command is placed in more than one group', () => {
    expect(placed.length).toBe(placedSet.size);
  });

  it('no group references an id missing from the registry', () => {
    expect(placed.filter((id) => !registry.has(id))).toEqual([]);
  });
});
