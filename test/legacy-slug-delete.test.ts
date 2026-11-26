/** #6212 on PGLite; the Postgres arm is test/e2e/legacy-slug-delete-postgres.test.ts. */
import { describe, expect, test } from 'bun:test';
import { isLegacyStoredPageSlug, isOpPageSlug } from '../src/core/ops/context.ts';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { legacySlugLifecycle, legacySlugRefusals } from './helpers/legacy-slug-scenarios.ts';
import { managedBrain } from './helpers/managed-brain.ts';

describe('#6212 legacy stored slugs', () => {
  test('only a slug the storage guard still accepts counts as legacy', () => {
    expect(isOpPageSlug('people/jane-doe')).toBe(true);
    expect(isLegacyStoredPageSlug('people/jane-doe')).toBe(false);
    expect(isLegacyStoredPageSlug('people/jane doe')).toBe(true);
    for (const unsafe of ['people/../x', '/people/x', 'people\\x', 'people/%2e%2e', 'people/a\u202eb', 'people/a\u0000b', '']) {
      expect(isLegacyStoredPageSlug(unsafe)).toBe(false);
    }
  });

  test('a legacy row soft-deletes, restores and purges database-only; the vault file and the real page survive', () => legacySlugLifecycle(), 120_000);
  test('a legacy row with a recorded source_path is also database-only', () => legacySlugLifecycle(undefined, { sourcePath: true }), 120_000);
  test('nothing else accepts the legacy grammar, and remote purge stays denied', () => legacySlugRefusals(), 120_000);
});

describe('#10080 stored slugs over 255 characters', () => {
  const LONG = `drive/` + 'folder-example/'.repeat(17) + 'file-example';
  const mutate = (ctx: OperationContext, operation: string, params: Record<string, unknown>) =>
    submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params } }) as Promise<Record<string, any>>;
  const revisionOf = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))?.revision;
  const refusal = (run: Promise<unknown>) => run.then(() => 'ok', (error: { code?: string }) => error.code ?? 'error');

  test('a stored slug over 255 characters is legacy only while the storage guard accepts it', () => {
    expect(LONG.length).toBeGreaterThan(255);
    expect(isOpPageSlug(LONG)).toBe(false);
    expect(isLegacyStoredPageSlug(LONG)).toBe(true);
    expect(isLegacyStoredPageSlug(`${LONG}/../x`)).toBe(false);
  });

  test('an existing row under such a slug soft-deletes, restores and purges database-only; nothing new can be written under it', () => managedBrain(async ({ engine, ctx }) => {
    expect(await refusal(mutate(ctx, 'put_page', { slug: LONG, content: '---\ntype: note\ntitle: Long\n---\nAgain.\n', expected_revision: await revisionOf(engine, LONG) }))).toBe('invalid_params');
    expect(await refusal(mutate(ctx, 'delete_page', { slug: `${LONG}-absent`, expected_revision: await revisionOf(engine, LONG) }))).toBe('invalid_params');
    const deleted = (await mutate(ctx, 'delete_page', { slug: LONG, expected_revision: await revisionOf(engine, LONG) })).outcome;
    expect(deleted).toMatchObject({ status: 'soft_deleted', write_through: { written: false } });
    await mutate(ctx, 'restore_page', { slug: LONG, expected_revision: await revisionOf(engine, LONG) });
    expect((await engine.readPageSnapshot(LONG, { sourceId: 'default' }))?.page.deleted_at ?? null).toBeNull();
    expect((await mutate(ctx, 'delete_page', { slug: LONG, purge: true, expected_revision: await revisionOf(engine, LONG) })).outcome).toMatchObject({ status: 'purged' });
    expect(await engine.readPageSnapshot(LONG, { sourceId: 'default', includeDeleted: true })).toBeNull();
  }, { setup: async ({ engine }) => { await engine.putPage(LONG, { type: 'note', title: 'Long', compiled_truth: 'Stored by an older sync.', timeline: '' }); } }), 120_000);
});

