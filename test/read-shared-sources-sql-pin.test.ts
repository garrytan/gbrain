/**
 * engine-sql/read-shared-sources.ts: the typed member readSharedSourceRows sends one statement with one parameter, its
 * config key is search/private-visibility.ts OWNER_MEMBER_KEY, and grants/read-shared.ts reads the shared set through
 * that member alone (it has no SqlQuery path of its own any more).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the member's statement text and parameter list; the shared-set reader sends exactly that, nothing else.
 *  - Regression: a second copy of the statement in the reader could read a different shared set than the member.
 *  - Seam: a recording executeRaw in place of an engine; the reader's engine serves the member over that recorder.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { READ_SHARED_OWNER_MEMBER_KEY, READ_SHARED_SOURCE_ROWS_SQL, readSharedSourceRows } from '../src/core/engine-sql/read-shared-sources.ts';
import { sharedReadSources } from '../src/core/grants/read-shared.ts';
import { OWNER_MEMBER_KEY } from '../src/core/search/private-visibility.ts';

function recorder() {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const engine = { executeRaw: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return []; } } as unknown as BrainEngine;
  return { calls, engine };
}

describe('read-shared source rows: one statement on both paths', () => {
  test('the member sends its text and parameter, and the shared-set reader sends exactly that through the member', async () => {
    const member = recorder();
    await readSharedSourceRows(member.engine);
    const reader = recorder();
    await sharedReadSources({ readSharedSourceRows: () => readSharedSourceRows(reader.engine) }, null);
    expect(member.calls).toEqual([{ sql: READ_SHARED_SOURCE_ROWS_SQL, params: [OWNER_MEMBER_KEY] }]);
    expect(reader.calls).toEqual(member.calls);
  });

  test('the member reads the owner member from the same config key the access code writes', () => {
    expect(READ_SHARED_OWNER_MEMBER_KEY).toBe(OWNER_MEMBER_KEY);
  });
});
