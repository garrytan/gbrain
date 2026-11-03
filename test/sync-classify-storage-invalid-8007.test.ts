/** #8007: the classifier never turns an absent file into a deletion while gbrain.yml's db_only declaration is unreadable. */
import { describe, expect, test } from 'bun:test';
import { classifySyncPath, type SyncPathState } from '../src/core/persistence/sync-classify.ts';

const gone: SyncPathState = { mode: 'committed', tree: null, level: null, dirty: null, diskOid: null, present: false,
  page: { live: true, revision: 'R1', originMatches: true }, record: { blobOids: ['B'], revision: 'R1', parserSame: true },
  attested: null, levelSha256: null, published: false, hold: null, marker: null, baseline: null, spelling: false, episodeUnsatisfied: false, keepDb: false, openWork: false };
const HOLD = { cls: 'delete_drift', settled: false, action: 'hold', side: 'deleted', state: 'file_gone', uncommitted: 'storage_invalid' };

describe('#8007: dbOnly unknown holds a missing-file page', () => {
  test('a proven delete without the declaration question; held with it, on every origin evidence, strict or not', () => {
    expect(classifySyncPath(gone)).toMatchObject({ cls: 'delete', action: 'delete' });
    expect(classifySyncPath({ ...gone, dbOnly: true })).toMatchObject({ cls: 'kept', settled: true, action: 'none' });
    for (const originEvidence of [undefined, 'committed', 'never_committed', 'ignored', 'unknown'] as const) {
      const state = { ...gone, dbOnly: 'unknown' as const, ...(originEvidence ? { originEvidence } : {}) };
      expect(classifySyncPath(state)).toMatchObject(HOLD);
      expect(classifySyncPath(state, { strict: true })).toMatchObject(HOLD);
      expect(classifySyncPath(state, { strict: true }).action).not.toBe('delete');
    }
  });
});
