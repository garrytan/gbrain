/**
 * G3 of git-canonical memory: the level classifier's strict verdict (sync-classify.ts `classifySyncPath(s, { strict: true })`).
 * A strict source reads its commit alone and Git wins: drift, a database version sync never saw, keep_db and an edited
 * tombstone import the committed blob; the working tree is invisible; a live page whose file a commit removed is deleted and
 * one Git never held is left as the database has it; holds keep their rows. A source that is not strict is unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { classifySyncPath, type SyncDirtiness, type SyncPathState } from '../src/core/persistence/sync-classify.ts';

const base: SyncPathState = { mode: 'committed', tree: 'B', level: 'B', present: true, dirty: 'clean', diskOid: null,
  page: { live: true, revision: 'R1', originMatches: true }, record: { blobOids: ['B'], revision: 'R1', parserSame: true },
  attested: null, levelSha256: null, published: false, hold: null, marker: null, baseline: null, spelling: false, episodeUnsatisfied: false, keepDb: false, openWork: false };
const strict = (s: SyncPathState) => classifySyncPath(s, { strict: true });
const dbOnly = { ...base, page: { live: true, revision: 'R2', originMatches: true } };
const gitMoved = { ...base, tree: 'C', level: 'C' };

describe('G3: Git wins on a strict source', () => {
  test('a database version sync never saw imports the committed blob; a pending door write stays settled', () => {
    expect(classifySyncPath(dbOnly)).toMatchObject({ cls: 'db_ahead', sub: 'db_only', settled: true, action: 'none' });
    expect(strict(dbOnly)).toMatchObject({ cls: 'import', action: 'import', settled: false, gitWins: 'db_ahead' });
    expect(strict({ ...dbOnly, record: { ...dbOnly.record!, revision: null } })).toMatchObject({ cls: 'import', gitWins: 'db_ahead' });
    const pending = { ...dbOnly, attested: { hash: null, arm1: true } };
    expect(strict(pending)).toEqual(classifySyncPath(pending));
  });

  test('drift on either side imports the commit', () => {
    const both = { ...gitMoved, page: dbOnly.page };
    expect(classifySyncPath(both)).toMatchObject({ cls: 'drift', action: 'hold', side: 'both' });
    expect(strict(both)).toMatchObject({ cls: 'import', action: 'import', gitWins: 'drift' });
    const unknown = { ...both, record: { ...both.record!, revision: null } };
    expect(classifySyncPath(unknown)).toMatchObject({ cls: 'drift', side: 'unknown' });
    expect(strict(unknown)).toMatchObject({ cls: 'import', gitWins: 'drift' });
  });

  test('keep_db no longer applies: the commit imports', () => {
    const keep = { ...gitMoved, page: dbOnly.page, keepDb: true };
    expect(classifySyncPath(keep)).toMatchObject({ cls: 'keep_db' });
    expect(strict(keep)).toMatchObject({ cls: 'import', gitWins: 'keep_db' });
    const settledKeep = { ...dbOnly, keepDb: true };
    expect(classifySyncPath(settledKeep)).toMatchObject({ cls: 'db_ahead', keepDbWrite: true, action: 'keep_db' });
    expect(strict(settledKeep)).toMatchObject({ cls: 'import', action: 'import', gitWins: 'db_ahead' });
  });

  test('a page no import record proves imports the commit (G8a: the unknown side of a held drift after conversion clears it)', () => {
    const legacy = { ...base, baseline: 'B', record: null, page: { live: true, revision: 'R2', originMatches: true } };
    expect(classifySyncPath(legacy)).toMatchObject({ cls: 'legacy_unverified', settled: true });
    expect(strict(legacy)).toMatchObject({ cls: 'import', action: 'import', settled: false, gitWins: 'legacy_unverified' });
  });

  test('an edited tombstone imports the committed file', () => {
    const tombstone = { ...gitMoved, page: { live: false, revision: 'R1', originMatches: true } };
    expect(classifySyncPath(tombstone)).toMatchObject({ cls: 'deleted_edited', action: 'hold' });
    expect(strict(tombstone)).toMatchObject({ cls: 'import', action: 'import', gitWins: 'deleted_edited' });
  });

  test('the working tree is invisible: any dirtiness reads as the committed blob', () => {
    for (const dirty of ['modified', 'staged', 'deleted', 'untracked', 'unknown'] as SyncDirtiness[]) {
      const s = { ...base, dirty, diskOid: 'D', levelSha256: 'sha-D' };
      expect(strict(s)).toMatchObject({ cls: 'matched', settled: true, action: 'none' });
      expect(strict({ ...s, tree: 'C', level: 'C' })).toMatchObject({ cls: 'import', action: 'import' });
    }
    expect(classifySyncPath({ ...gitMoved, dirty: 'modified', diskOid: 'D' })).toMatchObject({ cls: 'dirty', action: 'hold' });
  });

  test('a live page whose file is absent from the commit waits for its origin evidence, then deletes only on a commit', () => {
    const untrackedCopy = { ...base, tree: null, level: null, present: true };
    expect(classifySyncPath(untrackedCopy)).toMatchObject({ cls: 'kept', settled: true });
    expect(strict(untrackedCopy)).toMatchObject({ cls: 'delete', action: 'delete' });
    expect(strict({ ...untrackedCopy, originEvidence: 'committed' })).toMatchObject({ cls: 'delete', action: 'delete' });
    const unproven = { ...untrackedCopy, page: dbOnly.page, present: false };
    expect(strict(unproven)).toMatchObject({ cls: 'delete_drift' });
    expect(strict({ ...unproven, originEvidence: 'committed' })).toMatchObject({ cls: 'delete', action: 'delete', gitWins: 'delete_drift' });
    for (const originEvidence of ['never_committed', 'ignored', 'unknown'] as const) {
      expect(classifySyncPath({ ...unproven, originEvidence })).toMatchObject({ cls: 'delete_drift', action: 'hold' });
      expect(strict({ ...unproven, originEvidence })).toMatchObject({ cls: 'kept', settled: true, action: 'none', gitWins: 'delete_drift' });
    }
  });

  test('holds keep their rows: one at its level settles, a re-screened one re-runs Git\'s verdict', () => {
    const hold = { atLevel: true, rescreenDue: false, retried: false };
    expect(strict({ ...gitMoved, page: dbOnly.page, hold })).toMatchObject({ cls: 'held', settled: true });
    expect(strict({ ...gitMoved, page: dbOnly.page, hold: { ...hold, rescreenDue: true } })).toMatchObject({ cls: 'held', settled: false, action: 'import' });
  });

  test('with origin evidence read, a strict committed-mode path is never held by the classifier', () => {
    const pages = [null, base.page, dbOnly.page, { live: false, revision: 'R1', originMatches: true }];
    const records = [null, base.record, { ...base.record!, revision: null }, { ...base.record!, blobOids: ['A'] }];
    const levels: Array<[string | null, string | null]> = [['B', 'B'], ['C', 'C'], [null, null]];
    const dirties: Array<SyncDirtiness | null> = ['clean', 'modified', 'untracked', null];
    for (const page of pages) for (const record of records) for (const [tree, level] of levels) for (const dirty of dirties)
      for (const keepDb of [false, true]) for (const originEvidence of ['committed', 'never_committed', 'unknown'] as const) {
        const s: SyncPathState = { ...base, page, record, tree, level, dirty, keepDb, originEvidence, present: dirty !== null };
        expect(strict(s).action).not.toBe('hold');
      }
  });

  test('a working level and a source that is not strict classify exactly as before', () => {
    const working = { ...gitMoved, mode: 'working' as const, page: dbOnly.page };
    expect(strict(working)).toEqual(classifySyncPath(working));
    for (const s of [base, dbOnly, gitMoved, { ...gitMoved, page: dbOnly.page }]) expect(classifySyncPath(s, { strict: false })).toEqual(classifySyncPath(s));
  });
});
