/**
 * hermes-skill-pins.ts — the operator's pinned skills for Hermes (catalog
 * hermes-user, `gbrain skills pin --catalog hermes-user`) as a marked block
 * in $HERMES_HOME/SOUL.md, Hermes's system prompt. The resolver's per-turn
 * hook adds only suggestions for that turn, so the pins go where every turn
 * sees them. gbrain ships no pins: with none the block is absent.
 *
 * SOUL.md is Hermes's file and is never created here; text outside the
 * markers is never touched, and damaged markers leave the file as it is.
 * Written by `gbrain setup hermes --skill-loading resolve` and by
 * `gbrain skills pin` while the lane is on for Hermes; removed with the lane.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../managed-block.ts';
import { writeUnlessChanged } from './brain-first.ts';
import { pinnedBlockFor } from './skill-pins.ts';

const MARKERS: BlockMarkers = { begin: '<!-- gbrain:skill-pins:begin -->', end: '<!-- gbrain:skill-pins:end -->', label: 'skill-pins', rerun: 'gbrain setup hermes --skill-loading resolve' };
export const HERMES_PINS_CATALOG = 'hermes-user';

export interface HermesPinsOutcome { action: 'write' | 'keep' | 'remove' | 'skip'; path: string; detail: string; ids: string[] }

/** Make SOUL.md's pinned block match the pins (or, with off, strip it). Null when there is nothing either way. Never throws. */
export function syncHermesPins(opts: { home: string; hermesHome: string; off?: boolean; dryRun: boolean }): HermesPinsOutcome | null {
  const path = join(opts.hermesHome, 'SOUL.md');
  const pins = opts.off ? { block: '', ids: [] as string[] } : pinnedBlockFor(opts.home, HERMES_PINS_CATALOG, 'hermes');
  try {
    if (!existsSync(path)) return pins.block ? { action: 'skip', path, detail: `${path} does not exist, so the ${pins.ids.length} pinned skill(s) were not placed; start Hermes once (it writes SOUL.md) and run setup again`, ids: [] } : null;
    const text = readFileSync(path, 'utf8');
    const probe = probeBlock(MARKERS, text);
    if (probe.state === 'damaged') return { action: 'skip', path, detail: `the gbrain skill-pins markers in ${path} are damaged; fix or delete them and run setup again`, ids: [] };
    if (!pins.block) {
      if (probe.state !== 'present') return null;
      if (!opts.dryRun) writeUnlessChanged(path, text, false, removeBlock(MARKERS, text).text);
      return { action: 'remove', path, detail: `pinned skills block from ${path}`, ids: [] };
    }
    const next = spliceBlock(MARKERS, text, pins.block);
    const detail = `${pins.ids.length} pinned skill(s) (${pins.ids.join(', ')}) in ${path}`;
    if (next === text) return { action: 'keep', path, detail, ids: pins.ids };
    if (!opts.dryRun) writeUnlessChanged(path, text, false, next);
    return { action: 'write', path, detail, ids: pins.ids };
  } catch (e) {
    return { action: 'skip', path, detail: `pinned skills in ${path} left as they are (${(e as Error).message})`, ids: [] };
  }
}
