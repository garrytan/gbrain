/**
 * Wave 18b (1.1): write paths that skip a statement on an old schema skip it
 * only when the error names the table that schema lacks. Before,
 * `isUndefinedTableError` also matched `column "x" of relation "y" does not
 * exist` (and any other missing relation), so a rename silently dropped its
 * alias or slug-binding moves on an unrelated schema error.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { moveSlugBindings, recordRenameAlias } from '../src/core/page-state/rename-alias.ts';
import { resolveSlugWithAliasDetailed } from '../src/core/engine-sql/pages.ts';

const unrelatedColumn = (relation: string) =>
  Object.assign(new Error(`column "zz_unrelated" of relation "${relation}" does not exist`), { code: '42703' });
const missingTable = (table: string) => Object.assign(new Error(`relation "${table}" does not exist`), { code: '42P01' });

/** A transaction handle whose statements throw `error` (the withdrawal-subject move, which runs outside a savepoint, succeeds). */
function tx(error: Error): Pick<BrainEngine, 'transaction' | 'executeRaw'> {
  const savepoint = { executeRaw: async () => { throw error; } } as unknown as BrainEngine;
  return {
    transaction: (async <T>(fn: (t: BrainEngine) => Promise<T>) => fn(savepoint)) as BrainEngine['transaction'],
    executeRaw: (async () => []) as BrainEngine['executeRaw'],
  };
}

describe('rename write paths rethrow an unrelated schema error (1.1)', () => {
  test('recordRenameAlias: a missing column on slug_aliases throws; a missing slug_aliases table is skipped', async () => {
    await expect(recordRenameAlias(tx(unrelatedColumn('slug_aliases')), 'default', 'old', 'new')).rejects.toThrow('zz_unrelated');
    await expect(recordRenameAlias(tx(missingTable('zz_other')), 'default', 'old', 'new')).rejects.toThrow('zz_other');
    await expect(recordRenameAlias(tx(missingTable('slug_aliases')), 'default', 'old', 'new')).resolves.toBeUndefined();
  });

  test('moveSlugBindings: a missing column on facts throws; missing facts / page_aliases tables are skipped', async () => {
    await expect(moveSlugBindings(tx(unrelatedColumn('facts')), 'default', 'old', 'new')).rejects.toThrow('zz_unrelated');
    await expect(moveSlugBindings(tx(missingTable('facts')), 'default', 'old', 'new')).resolves.toBeUndefined();
    await expect(moveSlugBindings(tx(missingTable('page_aliases')), 'default', 'old', 'new')).resolves.toBeUndefined();
  });
});

describe('alias resolution rethrows an unrelated schema error (1.1)', () => {
  const exec = (error: Error) => ({ run: async () => { throw error; } }) as unknown as Parameters<typeof resolveSlugWithAliasDetailed>[0];

  test('a missing column under slug_aliases throws; a missing slug_aliases table reads as no alias', async () => {
    await expect(resolveSlugWithAliasDetailed(exec(unrelatedColumn('pages')), 'old', 'default')).rejects.toThrow('zz_unrelated');
    await expect(resolveSlugWithAliasDetailed(exec(missingTable('slug_aliases')), 'old', 'default')).resolves.toBeNull();
  });
});
