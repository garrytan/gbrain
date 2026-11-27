/**
 * The Rust engine's `relationExists` answers for the relations the store really keeps, so a rebuildable cache the store has no
 * storage for is skipped (clearRebuildableCache answers null) instead of reaching a raw DELETE the Rust engine refuses.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: relationExists answers false for page_view_digests (a rebuildable cache the store keeps no rows of), true for
 *    code_traversal_cache (kept) and for the query cache by the documented present-but-empty convention (the receipt names no
 *    missing cache); clearRebuildableCache on page_view_digests returns null and never runs a statement.
 *  - Regression: answering true for every inventory relation sent clearRebuildableCache('page_view_digests') down its raw DELETE
 *    branch, which fails with raw_sql on the Rust engine.
 *  - Why existing coverage misses it: the parity cases only ask relationExists about relations every engine has.
 *  - Seam: the Rust member called directly (it reads no store) and clearRebuildableCache with a recording transaction.
 */
import { describe, expect, test } from 'bun:test';
import { relationExists } from '../src/core/rust-engine/store-members/purge-receipt.ts';
import { clearRebuildableCache } from '../src/core/persistence/rebuildable-cache.ts';

const brain = null as never;

function recordingTx() {
  const statements: string[] = [];
  return {
    statements,
    tx: {
      relationExists: (table: string) => relationExists(brain, table),
      clearQueryCache: async () => 0,
      executeRaw: async (sql: string) => { statements.push(sql); throw new Error('raw_sql: the Rust engine runs no SQL'); },
    },
  };
}

describe('Rust relationExists and the rebuildable caches', () => {
  test('a rebuildable cache the store keeps no rows of is absent, one it keeps and the query cache are present', async () => {
    expect(await relationExists(brain, 'page_view_digests')).toBe(false);
    expect(await relationExists(brain, 'public.page_view_digests')).toBe(false);
    expect(await relationExists(brain, 'PAGE_VIEW_DIGESTS')).toBe(false);
    expect(await relationExists(brain, 'code_traversal_cache')).toBe(true);
    expect(await relationExists(brain, 'query_cache')).toBe(true);
    expect(await relationExists(brain, 'pages')).toBe(true);
    expect(await relationExists(brain, 'no_such_table')).toBe(false);
  });

  test('clearRebuildableCache returns null for an absent rebuildable cache without running a statement', async () => {
    const { tx, statements } = recordingTx();
    expect(await clearRebuildableCache(tx, 'page_view_digests')).toBeNull();
    expect(statements).toEqual([]);
  });
});
