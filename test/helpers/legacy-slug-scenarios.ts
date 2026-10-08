/**
 * #6212: pages an older gbrain stored under a slug today's grammar refuses
 * (`people/jane doe`) can be deleted, restored and purged, database-only, and
 * nothing else. PGLite runs these from test/legacy-slug-delete.test.ts; the
 * Postgres arm is test/e2e/legacy-slug-delete-postgres.test.ts.
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { managedBrain } from './managed-brain.ts';

export const LEGACY = 'people/jane doe';
const VAULT_BYTES = '---\ntype: person\ntitle: Jane Doe\n---\n\nJane Doe, captured from the vault.\n';

/** A capture-era row: no file of its own, but source_uri (and optionally source_path) naming a vault file another page owns. */
async function plantLegacyRow({ engine, root }: { engine: BrainEngine; root: string }, opts: { sourcePath?: boolean } = {}) {
  mkdirSync(join(root, 'people'), { recursive: true });
  writeFileSync(join(root, 'people', 'Jane Doe.md'), VAULT_BYTES);
  await engine.putPage(LEGACY, { type: 'person', title: 'Jane Doe', compiled_truth: 'Jane Doe, captured from the vault.', timeline: '' });
  await engine.executeRaw('UPDATE pages SET source_uri = $1, source_path = $2 WHERE slug = $3',
    [`file://${join(root, 'people', 'Jane Doe.md')}`, opts.sourcePath ? 'people/Jane Doe.md' : null, LEGACY]);
}

const revisionOf = async (engine: BrainEngine, slug: string) =>
  (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))?.revision;
const mutate = (ctx: OperationContext, operation: string, params: Record<string, unknown>) =>
  submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params } }) as Promise<Record<string, any>>;
const refusal = (run: Promise<unknown>) => run.then(() => 'ok', (error: { code?: string }) => error.code ?? 'error');

/** Soft-delete, restore and purge a legacy row; every step is database-only and the vault file and the real page survive. */
export async function legacySlugLifecycle(databaseUrl?: string, opts: { sourcePath?: boolean } = {}) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const real = await mutate(ctx, 'put_page', { slug: 'people/jane-doe', content: VAULT_BYTES });
    const realFile = readFileSync(join(root, 'people', 'jane-doe.md'), 'utf8');
    const deleted = (await mutate(ctx, 'delete_page', { slug: LEGACY, expected_revision: await revisionOf(engine, LEGACY) })).outcome;
    expect(deleted).toMatchObject({ status: 'soft_deleted', write_through: { written: false } });
    const restored = (await mutate(ctx, 'restore_page', { slug: LEGACY, expected_revision: await revisionOf(engine, LEGACY) })).outcome;
    expect(restored.write_through).toMatchObject({ written: false });
    expect((await engine.readPageSnapshot(LEGACY, { sourceId: 'default' }))?.page.deleted_at ?? null).toBeNull();
    expect(existsSync(join(root, 'people', 'jane doe.md'))).toBe(false);
    const purged = (await mutate(ctx, 'delete_page', { slug: LEGACY, purge: true, expected_revision: await revisionOf(engine, LEGACY) })).outcome;
    expect(purged).toMatchObject({ status: 'purged' });
    expect(await engine.readPageSnapshot(LEGACY, { sourceId: 'default', includeDeleted: true })).toBeNull();
    expect(readFileSync(join(root, 'people', 'Jane Doe.md'), 'utf8')).toBe(VAULT_BYTES);
    expect(readFileSync(join(root, 'people', 'jane-doe.md'), 'utf8')).toBe(realFile);
    expect((await engine.readPageSnapshot('people/jane-doe', { sourceId: 'default' }))?.revision).toBe((real.outcome ?? real).revision);
  }, { databaseUrl, setup: brain => plantLegacyRow(brain, opts) });
}

/** The legacy grammar opens nothing else: other operations, absent rows, other sources, stale revisions and remote purge stay refused. */
export async function legacySlugRefusals(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    const revision = await revisionOf(engine, LEGACY);
    expect(await refusal(mutate(ctx, 'put_page', { slug: LEGACY, content: VAULT_BYTES, expected_revision: revision }))).toBe('invalid_params');
    expect(await refusal(mutate(ctx, 'edit_page', { slug: LEGACY, edits: [{ old: 'Jane', new: 'J' }], expected_revision: revision }))).toBe('invalid_params');
    expect(await refusal(mutate(ctx, 'delete_page', { slug: 'people/john doe', expected_revision: revision }))).toBe('invalid_params');
    expect(await refusal(mutate(ctx, 'delete_page', { slug: LEGACY, source_id: 'archive', expected_revision: revision }))).toBe('invalid_params');
    expect(await refusal(mutate(ctx, 'delete_page', { slug: LEGACY, expected_revision: randomUUID() }))).toBe('revision_conflict');
    const remote = { ...ctx, remote: true as const };
    expect(await refusal(mutate(remote, 'delete_page', { slug: LEGACY, purge: true, expected_revision: revision }))).toBe('permission_denied');
    expect(await refusal(mutate({ ...remote, auth: { sourceId: 'archive' } } as OperationContext, 'delete_page', { slug: LEGACY, source_id: 'default', expected_revision: revision })))
      .toBe('permission_denied');
    expect(await refusal(mutate({ ...remote, auth: { sourceId: 'default', clientId: 'notes-only', boundSlugPrefixes: ['notes/'] } } as OperationContext,
      'delete_page', { slug: LEGACY, expected_revision: revision }))).toBe('permission_denied');
    expect((await mutate(remote, 'delete_page', { slug: LEGACY, expected_revision: revision })).outcome).toMatchObject({ status: 'soft_deleted' });
  }, { databaseUrl, setup: async brain => {
    await brain.engine.executeRaw("INSERT INTO sources (id, name) VALUES ('archive', 'archive')");
    await plantLegacyRow(brain);
  } });
}
