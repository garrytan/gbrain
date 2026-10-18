/**
 * SEGMENTED_WRITER_FLOOR: writers older than this do not understand segmented page bodies (Wave B). A pre-Wave-B
 * binary reads a segmented page's NULL body columns; the release that added segmented storage behind the switch
 * purges, forgets and exports without its segment texts; and v0.60.290.0, which reads segments with the switch off,
 * still keeps a withdrawn row in a segmented page's file (its withdrawal mirror skips such pages) and renews a
 * projection claim it may have lost. So the floor is the release that turns the switch on: the `since` of the
 * switch-on BEHAVIOR_CHANGES row, and this build's VERSION while that row says 'TBD'. The merge-slot stamp then edits
 * only the row's `since`, a line the stamp-only "same tree" rule allows, and never a floor of its own.
 * The CHANGELOG entry that turns the switch on says "`pages.segmented_storage` is on by default" and names the same
 * release (test/large-pages/segmented-switch.test.ts). A recent writer below the floor, or one whose writes lack the
 * segment-reader mark (migration v254), keeps `pages.segmented_storage` effectively off (`page-body/limits.ts`,
 * `persistence/writer-versions.ts` `segmentedGateWriters`).
 *
 * Kept apart from writer-versions.ts, which the engines load, because the BEHAVIOR_CHANGES table pulls in its own
 * modules: the gate loads this file when it reads, and doctor loads it with its check.
 */
import { BEHAVIOR_CHANGES } from '../behavior-change-notice.ts';
import { VERSION } from '../../version.ts';

/** The `id` of the BEHAVIOR_CHANGES row that turns `pages.segmented_storage` on by default. */
export const SEGMENTED_SWITCH_ON_CHANGE = 'segmented_switch_on';

/** The floor for a switch-on row stamped `since`: that release, or `version` (this build) while it is 'TBD'. */
export function segmentedWriterFloorFor(since: string, version: string): string {
  return since === 'TBD' ? version : since;
}

const switchOn = BEHAVIOR_CHANGES.find(change => change.id === SEGMENTED_SWITCH_ON_CHANGE);
if (!switchOn) throw new Error(`BEHAVIOR_CHANGES has no row with id ${SEGMENTED_SWITCH_ON_CHANGE}`);

export const SEGMENTED_WRITER_FLOOR: string = segmentedWriterFloorFor(switchOn.since, VERSION);
