/**
 * engine-sql/read-shared-sources.ts: the typed member readSharedSourceRows sends the statement and parameter that
 * grants/read-shared.ts sharedRows sends through a SqlQuery tag (the path a Postgres server connection still takes),
 * byte for byte, and its config key is search/private-visibility.ts OWNER_MEMBER_KEY.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: one statement text and one parameter list on both paths.
 *  - Regression: a reworded copy would let the engine member and the SqlQuery path read different shared sets.
 *  - Seam: a recording executeRaw in place of an engine; sqlQueryForEngine turns the tag into the same executeRaw call.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { READ_SHARED_OWNER_MEMBER_KEY, READ_SHARED_SOURCE_ROWS_SQL, readSharedSourceRows } from '../src/core/engine-sql/read-shared-sources.ts';
import { sharedReadSources } from '../src/core/grants/read-shared.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { OWNER_MEMBER_KEY } from '../src/core/search/private-visibility.ts';

function recorder() {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const engine = { executeRaw: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return []; } } as unknown as BrainEngine;
  return { calls, engine };
}

describe('read-shared source rows: one statement on both paths', () => {
  test('the member and the SqlQuery tag send the same text and parameter', async () => {
    const member = recorder();
    await readSharedSourceRows(member.engine);
    const tag = recorder();
    await sharedReadSources(sqlQueryForEngine(tag.engine), null);
    expect(member.calls).toEqual([{ sql: READ_SHARED_SOURCE_ROWS_SQL, params: [OWNER_MEMBER_KEY] }]);
    expect(tag.calls).toEqual(member.calls);
  });

  test('the member reads the owner member from the same config key the access code writes', () => {
    expect(READ_SHARED_OWNER_MEMBER_KEY).toBe(OWNER_MEMBER_KEY);
  });
});
