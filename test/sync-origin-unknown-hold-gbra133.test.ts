/**
 * GBRA-133 (600k soak): a missing file whose Git history read did not answer (`unknown` origin evidence) was held as
 * `never_committed`, and its hold said "Git never committed it", so thousands of files the history did hold read as files
 * Git never saw. The hold now carries `origin_unknown` and says Git could not show whether a commit held the file; the page
 * is still kept.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { classifySyncPath, type SyncPathState } from '../src/core/persistence/sync-classify.ts';
import { gitHoldFix } from '../src/core/persistence/sync-holds.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const gone: SyncPathState = { mode: 'committed', tree: null, level: null, present: false, dirty: null, diskOid: null,
  page: { live: true, revision: 'R1', originMatches: true }, record: { blobOids: ['A'], revision: 'R1', parserSame: true },
  attested: null, levelSha256: sha('A'), published: false, hold: null, marker: null, baseline: 'A', spelling: false, episodeUnsatisfied: false, keepDb: false, openWork: false };

describe('GBRA-133: an unread origin is not reported as never committed', () => {
  test('the classifier holds the page with the evidence it read', () => {
    expect(classifySyncPath({ ...gone, originEvidence: 'unknown' })).toMatchObject({ cls: 'delete_drift', action: 'hold', state: 'file_gone', uncommitted: 'origin_unknown' });
    expect(classifySyncPath({ ...gone, originEvidence: 'never_committed' })).toMatchObject({ cls: 'delete_drift', uncommitted: 'never_committed' });
    expect(classifySyncPath({ ...gone, originEvidence: 'ignored' })).toMatchObject({ cls: 'delete_drift', uncommitted: 'ignored' });
    expect(classifySyncPath({ ...gone, originEvidence: 'committed' })).toMatchObject({ cls: 'delete', action: 'delete' });
  });

  test("the hold's next step says the history read did not answer", () => {
    const fix = (reason: 'origin_unknown' | 'never_committed') => gitHoldFix({ source_id: 'source-a', path: 'notes/a.md', slug: 'notes/a', code: 'file_drift',
      meta: { side: 'deleted', state: 'file_gone', reason } } as Parameters<typeof gitHoldFix>[0]).why;
    expect(fix('origin_unknown')).toContain('Git could not show whether a commit held it');
    expect(fix('origin_unknown')).not.toContain('never committed');
    expect(fix('never_committed')).toContain('Git never committed it');
  });
});
