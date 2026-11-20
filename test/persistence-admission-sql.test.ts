/**
 * The managed-worktree admission statements (engine-sql/persistence-admission.ts) are static text with the refresh
 * schema constants spelled in place. These cases pin that text to the constants, so a change to the active refresh
 * states or to the released-deferral rule reaches admission too.
 */
import { describe, expect, test } from 'bun:test';
import {
  HELD_BEHIND_IMPORT_BY_PRINCIPAL_SQL, HELD_BEHIND_IMPORT_SQL, WORKTREE_FENCE_LOCKED_SQL, WORKTREE_FENCE_SQL,
} from '../src/core/engine-sql/persistence-admission.ts';
import { ACTIVE_REFRESH_STATES_SQL, RELEASED_DEFERRED } from '../src/core/persistence/worktree-refresh-schema.ts';

describe('persistence admission statements', () => {
  test('the fence reads the active refresh states, and only the barrier variant locks the refresh', () => {
    for (const sql of [WORKTREE_FENCE_SQL, WORKTREE_FENCE_LOCKED_SQL]) expect(sql).toContain(`state IN ${ACTIVE_REFRESH_STATES_SQL} LIMIT 1`);
    expect([WORKTREE_FENCE_SQL.includes('FOR NO KEY UPDATE'), WORKTREE_FENCE_LOCKED_SQL.includes('FOR NO KEY UPDATE')]).toEqual([false, true]);
    expect(WORKTREE_FENCE_LOCKED_SQL.replace(' FOR NO KEY UPDATE', '')).toBe(WORKTREE_FENCE_SQL);
  });

  test('the held count excludes released deferrals, and the principal variant only adds the principal filter', () => {
    for (const sql of [HELD_BEHIND_IMPORT_SQL, HELD_BEHIND_IMPORT_BY_PRINCIPAL_SQL]) expect(sql).toContain(`AND NOT ${RELEASED_DEFERRED('r')} AND`);
    expect(HELD_BEHIND_IMPORT_BY_PRINCIPAL_SQL).toBe(`${HELD_BEHIND_IMPORT_SQL} AND r.principal_kind=$2 AND r.principal_id=$3`);
  });
});
