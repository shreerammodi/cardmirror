/**
 * Ribbon-command availability.
 *
 * Some commands only make sense in certain contexts and should be hidden
 * from the command-discovery surfaces (the search-palette command bar, the
 * keybindings editor, and the printed shortcuts reference) when they don't
 * apply:
 *
 *   - Verbatim Flow commands work only on the Windows desktop (the COM
 *     bridge is Windows-only); off Windows they'd toast "Windows-only".
 *   - Voice control is desktop-only.
 *   - The opt-in card-cutter command stays invisible until the experiment
 *     is enabled.
 *
 * This gates *visibility* only. The keymap still binds every command — the
 * commands themselves self-guard (Flow toasts, the cutter command falls
 * through when off), so a stale user override never does harm. Conflict
 * detection in the keybindings editor likewise scans the full id set, not
 * this filtered one, so a hidden command's binding still blocks reuse.
 */

import { RIBBON_COMMAND_IDS, type RibbonCommandId } from './ribbon-commands.js';
import { settings } from './settings.js';
import { getElectronHost, isWindowsHost } from './host/index.js';

const FLOW_COMMANDS = new Set<RibbonCommandId>([
  'sendToFlowColumn',
  'sendToFlowCell',
  'sendHeadingsToFlowColumn',
  'sendHeadingsToFlowCell',
  'pullFromFlow',
  'createFlow',
  'startFlowHost',
]);

/** Whether a command should be offered in the discovery surfaces now. */
export function isRibbonCommandAvailable(id: RibbonCommandId): boolean {
  if (FLOW_COMMANDS.has(id)) return isWindowsHost();
  if (id === 'toggleVoice') return getElectronHost() !== null;
  if (id === 'openCardCutter') return settings.get('cardCutterEnabled') === true;
  return true;
}

/** The currently-available command ids, in registry order. */
export function availableRibbonCommandIds(): RibbonCommandId[] {
  return RIBBON_COMMAND_IDS.filter(isRibbonCommandAvailable);
}
