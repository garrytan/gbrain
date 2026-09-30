import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

interface Fixture { engine: BrainEngine; root: string; context: OperationContext; }
function canonicalMarkdown(content: string, slug: string) {
  const { type, title, compiled_truth, timeline, frontmatter, tags } = parseMarkdown(content, slug);
  return { type, title, compiled_truth, timeline: timeline ?? '', frontmatter, tags };
}
const fixtures: Fixture[] = [];
const sourceId = 'tombstone-noop-example';
let home: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-tombstone-noop-'));
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema();
    const engines: BrainEngine[] = [lite];
    if (process.env.DATABASE_URL) {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
      engines.push(pg.engine); closePostgres = pg.close;
    }
    for (const engine of engines) {
      const root = join(home, engine.kind); mkdirSync(root);
      const context: OperationContext = { engine, sourceId, remote: false, dryRun: false,
        config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } };
      fixtures.push({ engine, root, context });
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await claimWorktree(engine, sourceId, root);
      expect((await activatePersistence(engine, { confirmQuiesced: true })).enabled).toBe(true);
    }
  });
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const fixture of fixtures) await disposePersistenceConsumer(fixture.engine);
    await fixtures[0]?.engine.disconnect(); await closePostgres?.();
  });
  if (home) rmSync(home, { recursive: true, force: true });
});

for (const operation of ['put_page', 'capture', 'revert_version'] as const) {
  test(`${operation}: identical tombstoned content requires a real revision-bound restoration`, async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      try {
        for (const { engine, root, context } of fixtures) {
          const slug = `notes/${operation.replaceAll('_', '-')}`;
          const file = join(root, `${slug}.md`);
          const submit = (name: string, params: Record<string, unknown>) => submitPageMutation(context,
            { operation: name, params: { request_id: randomUUID(), ...params }, waitMs: 30_000 });
          const content = '---\ntitle: Restorable example\ntype: note\ncaptured_at: "2026-09-15T00:00:00.000Z"\n---\n\nCanonical body that must return after deletion.\n';
          const initialOperation = operation === 'capture' ? 'capture' : 'put_page';
          expect((await submit(initialOperation, { slug, content })).state).toBe('committed');
          const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
          const bytes = readFileSync(file, 'utf8');
          expect((await submit('delete_page', { slug, expected_revision: before.revision })).state).toBe('committed');
          const tombstone = (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!;
          expect(tombstone.page.deleted_at).not.toBeNull();
          expect(tombstone.revision).not.toBe(before.revision);
          expect(await engine.readPageSnapshot(slug, { sourceId })).toBeNull();
          expect(existsSync(file)).toBe(false);

          const [version] = await engine.executeRaw<{ id: number }>(
            'SELECT id FROM page_versions WHERE page_id=$1 AND knowledge_revision=$2::uuid', [before.page.id, before.revision]);
          expect(version).toBeDefined();
          const intent = operation === 'revert_version' ? { slug, version_id: version.id }
            : { slug, content: serializePageToMarkdown(before.page, before.tags) };
          await expect(submit(operation, { ...intent, expected_revision: before.revision })).rejects.toMatchObject({ code: 'revision_conflict' });
          expect(await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true })).toEqual(tombstone);
          expect(existsSync(file)).toBe(false);

          const localEdit = 'Uncoordinated local bytes at the deleted page path.\n';
          writeFileSync(file, localEdit);
          await expect(submit(operation, { ...intent, expected_revision: tombstone.revision })).rejects.toMatchObject({ code: 'source_changed' });
          expect(readFileSync(file, 'utf8')).toBe(localEdit);
          expect(await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true })).toEqual(tombstone);
          unlinkSync(file); // Remove only this fixture's unindexed edit before testing valid revival.

          const params = { ...intent, expected_revision: tombstone.revision, request_id: randomUUID() };
          const committed = await submit(operation, params);
          expect(committed.state).toBe('committed');
          expect(committed.noop).not.toBe(true);
          const restored = await engine.readPageSnapshot(slug, { sourceId });
          expect(restored).not.toBeNull();
          expect(restored!.page.id).toBe(before.page.id);
          expect(restored!.revision).not.toBe(tombstone.revision);
          expect(committed.revision).toBe(restored!.revision);
          expect(restored!.page.text_projection_revision).toBe(restored!.revision);
          expect(restored!.page.deleted_at).toBeNull();
          expect(restored!.page.frontmatter).toEqual(before.page.frontmatter);
          expect(restored!.page.source_kind).toBe(before.page.source_kind);
          expect(restored!.page.ingested_via).toBe(before.page.ingested_via);
          expect(restored!.page.ingested_at).toEqual(before.page.ingested_at);
          const restoredBytes = readFileSync(file, 'utf8');
          // JSONB changes key order. A real restoration preserves every
          // canonical value; only no-ops/replays promise unchanged file bytes.
          expect(canonicalMarkdown(restoredBytes, slug)).toEqual(canonicalMarkdown(bytes, slug));
          expect(canonicalMarkdown(restoredBytes, slug)).toEqual({ type: restored!.page.type, title: restored!.page.title,
            compiled_truth: restored!.page.compiled_truth, timeline: restored!.page.timeline ?? '',
            frontmatter: restored!.page.frontmatter, tags: restored!.tags });
          expect(await submit(operation, params)).toEqual(committed);
          expect(readFileSync(file, 'utf8')).toBe(restoredBytes);
          expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(restored!.revision);
          const versions = await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1 ORDER BY id', [before.page.id]);
          const noop = await submit(operation, { ...intent, expected_revision: restored!.revision });
          expect(noop).toMatchObject({ state: 'committed', noop: true, revision: restored!.revision });
          expect(await engine.readPageSnapshot(slug, { sourceId })).toEqual(restored);
          expect(readFileSync(file, 'utf8')).toBe(restoredBytes);
          expect(await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1 ORDER BY id', [before.page.id])).toEqual(versions);
        }
      } finally { for (const fixture of fixtures) await disposePersistenceConsumer(fixture.engine); }
    });
  }, 120_000);
}

test('restore and repeated delete preserve unexpected tombstone-path bytes, including force requests', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    try {
      for (const { engine, root, context } of fixtures) for (const operation of ['restore_page', 'delete_page'] as const) {
        const slug = `notes/guard-${operation.replaceAll('_', '-')}`, file = join(root, `${slug}.md`);
        const submit = (name: string, params: Record<string, unknown>) => submitPageMutation(context,
          { operation: name, params: { request_id: randomUUID(), ...params }, waitMs: 30_000 });
        await submit('put_page', { slug, content: '---\ntitle: Local edit guard\ntype: note\n---\nKnown canonical body.' });
        const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
        await submit('delete_page', { slug, expected_revision: before.revision });
        const tombstone = (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!;
        const localEdit = 'Unexpected replacement file must survive restore and repeated delete.\n';
        writeFileSync(file, localEdit);
        for (const precondition of [{ expected_revision: tombstone.revision }, { force: true }]) {
          await expect(submit(operation, { slug, ...precondition })).rejects.toMatchObject({ code: 'source_changed' });
          expect(readFileSync(file, 'utf8')).toBe(localEdit);
          expect(await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true })).toEqual(tombstone);
        }
        unlinkSync(file); // Discard this known test edit before exercising the missing-file path.
        const result = await submit(operation, { slug, expected_revision: tombstone.revision });
        expect(result.state).toBe('committed');
        const after = await engine.readPageSnapshot(slug, { sourceId });
        if (operation === 'restore_page') {
          expect(after).not.toBeNull();
          expect(after!.page.id).toBe(before.page.id);
          expect(after!.revision).not.toBe(tombstone.revision);
          expect(readFileSync(file, 'utf8')).toBe(serializePageToMarkdown(after!.page, after!.tags));
        } else {
          expect(after).toBeNull();
          expect(result.revision).toBe(tombstone.revision);
          expect(existsSync(file)).toBe(false);
        }
      }
    } finally { for (const fixture of fixtures) await disposePersistenceConsumer(fixture.engine); }
  });
}, 120_000);
