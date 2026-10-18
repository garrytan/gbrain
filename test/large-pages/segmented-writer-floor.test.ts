/**
 * SEGMENTED_WRITER_FLOOR follows the switch-on BEHAVIOR_CHANGES row (page-body/writer-floor.ts).
 *
 * 1. Protects: the floor is the `since` of the row with id `segmented_switch_on` (this build's VERSION while it is
 *    'TBD'), never a version literal of its own, so the merge-slot stamp edits only allowlisted lines; and the CHANGELOG
 *    entry that turns the switch on ("`pages.segmented_storage` is on by default") names that same release.
 * 2. Fails when: the floor holds its own version again, the row loses its id, or a stamp writes the switch-on CHANGELOG
 *    entry and VERSION but leaves the row's since at 'TBD'.
 * 3. Structural (reads writer-floor.ts and CHANGELOG.md); no database.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BEHAVIOR_CHANGES } from '../../src/core/behavior-change-notice.ts';
import { SEGMENTED_SWITCH_ON_CHANGE, SEGMENTED_WRITER_FLOOR, segmentedWriterFloorFor } from '../../src/core/page-body/writer-floor.ts';
import { compareWriterVersions } from '../../src/core/persistence/writer-versions.ts';
import { VERSION } from '../../src/version.ts';

test('SEGMENTED_WRITER_FLOOR follows the switch-on BEHAVIOR_CHANGES row\'s since (this build while it is TBD), and the CHANGELOG entry that turns the switch on names that release', () => {
  const rows = BEHAVIOR_CHANGES.filter(c => (c as { id?: string }).id === SEGMENTED_SWITCH_ON_CHANGE);
  expect(rows).toHaveLength(1);
  const since = rows[0]!.since;
  expect(SEGMENTED_WRITER_FLOOR).toBe(since === 'TBD' ? VERSION : since);
  expect([segmentedWriterFloorFor('TBD', '1.2.3.4'), segmentedWriterFloorFor('0.60.294.0', '0.60.295.0')]).toEqual(['1.2.3.4', '0.60.294.0']);
  expect(compareWriterVersions(SEGMENTED_WRITER_FLOOR, VERSION)).toBeLessThanOrEqual(0);
  // The merge-slot stamp edits only allowlisted lines (the row's since, VERSION, the CHANGELOG header): the floor
  // holds no version of its own. A stamp that writes the CHANGELOG entry turning the switch on but forgets the since
  // fails here.
  // test-reads-source-ok[structural]: the stamp contract is that writer-floor.ts carries no version literal of its own.
  expect(readFileSync(join(import.meta.dir, '../../src/core/page-body/writer-floor.ts'), 'utf8')).not.toMatch(/'\d+\.\d+\.\d+\.\d+'/);
  const announcing = readFileSync(join(import.meta.dir, '../../CHANGELOG.md'), 'utf8').split(/^## /m).slice(1)
    .filter(entry => /`pages\.segmented_storage`\)? (?:is )?(?:now )?on by default/i.test(entry)).map(entry => /^\[([^\]]+)\]/.exec(entry)?.[1]);
  expect(announcing.length).toBeLessThanOrEqual(1);
  if (announcing.length) expect(since).toBe(announcing[0]!);
});
