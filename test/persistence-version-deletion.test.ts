import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageVersion } from '../src/core/types.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { detectMissingColumns } from '../src/core/schema-verify.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const fixtures: Array<{ engine: BrainEngine; root: string; ctx: OperationContext; close: () => Promise<void> }> = [];
const sourceId = 'version-deletion';
beforeAll(async () => {
  const engine = new PGLiteEngine();
  // This suite verifies schema replay itself, including already-current ledgers.
  await withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, async () => { await engine.connect({}); await engine.initSchema(); });
  const databases: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [{ engine, close: () => engine.disconnect() }];
  if (process.env.DATABASE_URL) databases.push(await isolatedPersistencePostgres(process.env.DATABASE_URL));
  for (const database of databases) {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-version-deletion-'));
    await database.engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await claimWorktree(database.engine, sourceId, root);
    fixtures.push({ ...database, root, ctx: { engine: database.engine, config: { engine: database.engine.kind, embedding_disabled: true },
      sourceId, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } });
  }
}, 120_000);
afterAll(async () => {
  for (const { engine, root, close } of fixtures) { await disposePersistenceConsumer(engine); await close(); rmSync(root, { recursive: true, force: true }); }
});
const content = (body: string, tag = 'original') => `---\ntitle: Example\ntype: note\ntags: [${tag}]\n---\n${body}\n`;
const submit = (ctx: OperationContext, operation: string, params: Record<string, unknown>) =>
  submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params } });
async function versionAt(engine: BrainEngine, pageId: number, revision: string): Promise<PageVersion> {
  const versions = await engine.executeRaw<PageVersion>('SELECT * FROM page_versions WHERE page_id=$1 AND knowledge_revision=$2::uuid', [pageId, revision]);
  expect(versions).toHaveLength(1); return versions[0];
}
async function versionCount(engine: BrainEngine, pageId: number): Promise<number> {
  return (await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1', [pageId])).length;
}

test('migration158 leaves old snapshots unknown and new versions record live or deleted state', async () => {
  for (const { engine } of fixtures) {
    const page = await engine.putPage('upgrade', { type: 'note', title: 'Legacy', compiled_truth: 'Legacy body' }, { sourceId });
    await engine.executeRaw('ALTER TABLE page_versions DROP COLUMN is_deleted');
    const [legacy] = await engine.executeRaw<{ id: number }>('INSERT INTO page_versions(page_id,compiled_truth,frontmatter) VALUES($1,$2,$3::text::jsonb) RETURNING id',
      [page.id, page.compiled_truth, JSON.stringify(page.frontmatter)]);
    expect((await detectMissingColumns(engine)).missing).toContainEqual({ table: 'page_versions', column: 'is_deleted' });
    // The ledger already says v158; the standalone schema replay must repair
    // the missing column without relying on the pending migration runner.
    await engine.initSchema();
    const migration = MIGRATIONS.find(value => value.version === 158)!;
    await engine.executeRaw(migration.sql); await engine.executeRaw(migration.sql);
    expect((await engine.executeRaw<PageVersion>('SELECT * FROM page_versions WHERE id=$1', [legacy.id]))[0].is_deleted).toBeNull();
    const liveVersion = await engine.createVersion('upgrade', { sourceId });
    expect(liveVersion.is_deleted).toBe(false);
    await engine.softDeletePage('upgrade', { sourceId });
    const deletedVersion = await engine.createVersion('upgrade', { sourceId });
    expect(deletedVersion.is_deleted).toBe(true);
    const before = await engine.readPageSnapshot('upgrade', { sourceId, includeDeleted: true });
    await engine.initSchema();
    expect(await engine.readPageSnapshot('upgrade', { sourceId, includeDeleted: true })).toEqual(before);
    const versions = await engine.getVersions('upgrade', { sourceId });
    expect(versions.find(version => version.id === legacy.id)!.is_deleted).toBeNull();
    expect(versions.find(version => version.id === liveVersion.id)!.is_deleted).toBe(false);
    expect(versions.find(version => version.id === deletedVersion.id)!.is_deleted).toBe(true);
    expect((await activatePersistence(engine, { confirmQuiesced: true })).enabled).toBe(true);
  }
});

test('reverting a naturally recorded tombstone removes the file; identical tombstone reverts and retained IDs are exact no-ops', async () => {
  for (const { engine, root, ctx } of fixtures) {
    const slug = 'same-body'; const file = join(root, `${slug}.md`);
    const first = await submit(ctx, 'put_page', { slug, content: content('Stable body') });
    const live = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const deleted = await submit(ctx, 'delete_page', { slug, expected_revision: first.revision });
    const restored = await submit(ctx, 'restore_page', { slug, expected_revision: deleted.revision });
    const version = await versionAt(engine, live.page.id, String(deleted.revision));
    expect(version.is_deleted).toBe(true);
    expect((await versionAt(engine, live.page.id, String(first.revision))).is_deleted).toBe(false);
    expect(existsSync(file)).toBe(true);
    const count = await versionCount(engine, live.page.id);
    const request = { slug, version_id: version.id, expected_revision: restored.revision, request_id: randomUUID() };
    const reverted = await submit(ctx, 'revert_version', request);
    expect(reverted.state).toBe('committed'); expect(reverted.status).toBe('reverted');
    const tombstone = (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!;
    expect(tombstone.page.deleted_at).not.toBeNull(); expect(tombstone.revision).not.toBe(restored.revision);
    expect(serializePageToMarkdown(tombstone.page, tombstone.tags)).toBe(serializePageToMarkdown(live.page, live.tags));
    expect(await engine.getPage(slug, { sourceId })).toBeNull(); expect(await engine.getChunks(slug, { sourceId })).toEqual([]);
    expect(existsSync(file)).toBe(false); expect(await versionCount(engine, live.page.id)).toBe(count + 1);
    expect((await submit(ctx, 'revert_version', request)).revision).toBe(tombstone.revision);
    const noChange = await submit(ctx, 'revert_version', { slug, version_id: version.id, expected_revision: tombstone.revision });
    expect(noChange.state).toBe('committed'); expect(noChange.status).toBe('skipped'); expect(noChange.revision).toBe(tombstone.revision);
    expect(await versionCount(engine, live.page.id)).toBe(count + 1); expect(existsSync(file)).toBe(false);
  }
});

test('changed content and tags revert atomically to a tombstone, and a live snapshot restores both file and search visibility', async () => {
  for (const { engine, root, ctx } of fixtures) {
    const slug = 'changed-body'; const file = join(root, `${slug}.md`);
    const first = await submit(ctx, 'put_page', { slug, content: content('Original version body') });
    const original = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const deleted = await submit(ctx, 'delete_page', { slug, expected_revision: first.revision });
    const restored = await submit(ctx, 'restore_page', { slug, expected_revision: deleted.revision });
    const tombstoneVersion = await versionAt(engine, original.page.id, String(deleted.revision));
    const liveVersion = await versionAt(engine, original.page.id, String(first.revision));
    const changed = await submit(ctx, 'put_page', { slug, content: content('Changed body', 'changed'), expected_revision: restored.revision });
    const reverted = await submit(ctx, 'revert_version', { slug, version_id: tombstoneVersion.id, expected_revision: changed.revision });
    const tombstone = (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!;
    expect(reverted.state).toBe('committed'); expect(tombstone.page.deleted_at).not.toBeNull();
    expect(serializePageToMarkdown(tombstone.page, tombstone.tags)).toBe(serializePageToMarkdown(original.page, original.tags));
    expect(existsSync(file)).toBe(false); expect(await engine.getPage(slug, { sourceId })).toBeNull();
    const revival = await submit(ctx, 'revert_version', { slug, version_id: liveVersion.id, expected_revision: reverted.revision });
    const live = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(revival.state).toBe('committed'); expect(revival.revision).not.toBe(reverted.revision);
    expect(live.page.deleted_at).toBeNull(); expect(live.page.text_projection_revision).toBe(live.revision);
    expect(readFileSync(file, 'utf8')).toBe(serializePageToMarkdown(original.page, original.tags));
    expect((await engine.getChunks(slug, { sourceId })).map(chunk => chunk.chunk_text).join(' ')).toContain('Original version body');
  }
});

test('legacy unknown deletion state preserves the current live or deleted state while restoring content', async () => {
  for (const { engine, root, ctx } of fixtures) {
    const slug = 'legacy-state'; const file = join(root, `${slug}.md`);
    const first = await submit(ctx, 'put_page', { slug, content: content('Legacy original body') });
    const original = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const changed = await submit(ctx, 'put_page', { slug, content: content('Later body', 'later'), expected_revision: first.revision });
    const version = await versionAt(engine, original.page.id, String(first.revision));
    await engine.executeRaw('UPDATE page_versions SET is_deleted=NULL WHERE id=$1', [version.id]);
    const liveRevert = await submit(ctx, 'revert_version', { slug, version_id: version.id, expected_revision: changed.revision });
    expect(liveRevert.state).toBe('committed'); expect((await engine.getPage(slug, { sourceId }))!.deleted_at).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(serializePageToMarkdown(original.page, original.tags));
    const changedAgain = await submit(ctx, 'put_page', { slug, content: content('Different deleted body'), expected_revision: liveRevert.revision });
    const deleted = await submit(ctx, 'delete_page', { slug, expected_revision: changedAgain.revision });
    const deletedRevert = await submit(ctx, 'revert_version', { slug, version_id: version.id, expected_revision: deleted.revision });
    const current = (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!;
    expect(deletedRevert.state).toBe('committed'); expect(current.page.deleted_at).not.toBeNull();
    expect(current.page.compiled_truth).toBe(original.page.compiled_truth); expect(current.tags).toEqual(original.tags);
    expect(existsSync(file)).toBe(false); expect(await engine.getPage(slug, { sourceId })).toBeNull();
    const count = await versionCount(engine, original.page.id);
    const noop = await submit(ctx, 'revert_version', { slug, version_id: version.id, expected_revision: current.revision });
    expect(noop.status).toBe('skipped'); expect(noop.revision).toBe(current.revision);
    expect(await versionCount(engine, original.page.id)).toBe(count);
  }
});

test('failed tombstone revert rolls back canonical fields, versions, deletion and file with a stable failed receipt', async () => {
  for (const { engine, root, ctx } of fixtures) {
    const slug = 'failed-deletion'; const file = join(root, `${slug}.md`);
    const created = await submit(ctx, 'put_page', { slug, content: content('Version body') });
    const first = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const deleted = await submit(ctx, 'delete_page', { slug, expected_revision: created.revision });
    const restored = await submit(ctx, 'restore_page', { slug, expected_revision: deleted.revision });
    const version = await versionAt(engine, first.page.id, String(deleted.revision));
    await submit(ctx, 'put_page', { slug, content: content('Keep current body', 'current'), expected_revision: restored.revision });
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const bytes = readFileSync(file, 'utf8'); const count = await versionCount(engine, first.page.id);
    const request = { slug, version_id: version.id, expected_revision: before.revision, request_id: randomUUID() };
    const original = engine.softDeletePage;
    engine.softDeletePage = async function (this: BrainEngine, ...args: Parameters<BrainEngine['softDeletePage']>) {
      const result = await original.apply(this, args);
      if (args[0] === slug) throw new OperationError('invalid_params', 'Injected failure after tombstone mutation.');
      return result;
    };
    try { await expect(submit(ctx, 'revert_version', request)).rejects.toMatchObject({ code: 'invalid_params' }); }
    finally { engine.softDeletePage = original; }
    const after = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(after.revision).toBe(before.revision); expect(after.page.deleted_at).toBeNull();
    expect(serializePageToMarkdown(after.page, after.tags)).toBe(serializePageToMarkdown(before.page, before.tags));
    expect(readFileSync(file, 'utf8')).toBe(bytes); expect(await versionCount(engine, first.page.id)).toBe(count);
    await expect(submit(ctx, 'revert_version', request)).rejects.toMatchObject({ code: 'invalid_params' });
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(before.revision);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  }
});
