/**
 * Wave C 1I-a (spec §3.6, unsplit): the index-split-page consumer derives a strict git-first page from its committed
 * file. A 2 MiB create is indexed from the committed blob (its rows hold the committed bytes, the pending head is gone,
 * pages.indexed_commit names the door commit and the request ends committed with index.state indexed). A delete during
 * a paused index removes the token, so the flip aborts and the request ends superseded; a committed file that no longer
 * matches its head is held (index_held), never indexed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { _resetGitFirstGateForTests, _resetIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { _indexLeaseTiming, indexSplitPage } from '../../src/core/persistence/index-split-page.ts';
import type { PersistenceEffect } from '../../src/core/persistence/effect-model.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { testWaitMs } from '../helpers/wait-for.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { MiB, pageBody, write } from './helpers.ts';
import { payloadTables } from './payload-probe.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const request = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ state: string; outcome: Record<string, any> }>(
  'SELECT state, outcome FROM persistence_requests WHERE id = $1::uuid', [id]))[0]!;
const indexEffect = async (engine: BrainEngine, id: string) => (await engine.executeRaw<PersistenceEffect>(
  "SELECT * FROM persistence_effects WHERE request_id = $1::uuid AND kind = 'index-split-page'", [id]))[0]!;
const runIndex = async (engine: BrainEngine, id: string) => indexSplitPage.run(engine, { engine: engine.kind } as never, await indexEffect(engine, id), localHostId());
const settleIndex = async (engine: BrainEngine, id: string) => {
  const deadline = performance.now() + testWaitMs(60_000);
  while ((await indexEffect(engine, id)).state !== 'committed' && performance.now() < deadline) {
    await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: localHostId(), limit: 10 });
    await Bun.sleep(50);
  }
};
const pendingHeads = (engine: BrainEngine, slug: string) => engine.executeRaw("SELECT 1 FROM page_pending_heads WHERE source_id = 'default' AND slug = $1", [slug]);

for (const backend of testBackends()) describe(`[${backend}] index from the committed blob (1I-a)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });
  afterEach(() => { _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('a 2 MiB strict create is indexed from its committed blob and ends committed', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const slug = 'notes/indexed';
    const text = pageBody(2 * MiB, 'MARKERINDEXED');
    const row = await write(engine, ctx, slug, text, 'put');
    expect(await indexEffect(engine, row.id)).toBeDefined();
    await settleIndex(engine, row.id);
    const done = await request(engine, row.id);
    const commit = done.outcome.persistence.git_commit;
    expect(await indexEffect(engine, row.id)).toMatchObject({ state: 'committed', outcome: { index: { state: 'indexed', commit } } });
    expect(done.state).toBe('committed');
    expect(done.outcome.index).toEqual({ state: 'indexed', commit });
    expect(git(root, 'show', `${commit}:${slug}.md`)).toContain('MARKERINDEXED');
    expect(await pendingHeads(engine, slug)).toEqual([]);
    const [page] = await engine.executeRaw<{ indexed_commit: string; body_bytes: unknown; body_storage: string }>(
      "SELECT indexed_commit, body_bytes, body_storage FROM pages WHERE source_id = 'default' AND slug = $1", [slug]);
    expect(page).toMatchObject({ indexed_commit: commit, body_storage: 'segmented' });
    const tables = await payloadTables(engine, 'MARKERINDEXED', row.id);
    expect(tables.some(table => table.startsWith('page_body_segments') || table.startsWith('content_chunks'))).toBe(true);
    expect(tables.some(table => table.startsWith('page_pending_heads'))).toBe(false);
  }, { databaseUrl, setup }), 300_000);

  test('a delete during a paused index aborts the flip; the request ends superseded', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    registerIndexSplitPageConsumer({ run: async () => { throw new Error('paused'); } });
    const slug = 'notes/deleted-during-index';
    expect((await write(engine, ctx, slug, pageBody(4 * 1024, 'MARKERBEFORE'), 'put')).state).toBe('committed');
    const revision = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    const row = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERDELETED'), 'put', { expectedRevision: revision });
    expect(row.state).toBe('indexing');
    _resetIndexSplitPageConsumerForTests();
    await op('delete_page').handler(ctx, { slug, expected_revision: revision, request_id: crypto.randomUUID(), wait_ms: 3_000 });
    expect(await pendingHeads(engine, slug)).toEqual([]);
    await runIndex(engine, row.id);
    const done = await request(engine, row.id);
    expect(done.state).toBe('committed');
    expect(done.outcome.index).toMatchObject({ state: 'superseded' });
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id = 'default' AND slug = $1 AND deleted_at IS NULL", [slug])).toEqual([]);
  }, { databaseUrl, setup }), 300_000);

  test('a later commit of the path that replaced the committed bytes supersedes the request and removes its head, never holds it', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    registerIndexSplitPageConsumer({ run: async () => { throw new Error('paused'); } });
    const slug = 'notes/replaced-in-git';
    const row = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERREPLACED'), 'put');
    expect(row.state).toBe('indexing');
    appendFileSync(join(root, `${slug}.md`), '\na later commit of the same path\n');
    git(root, 'add', '--', `${slug}.md`);
    git(root, 'commit', '-q', '-m', 'later commit');
    const later = git(root, 'rev-parse', 'HEAD').trim();
    await runIndex(engine, row.id);
    const done = await request(engine, row.id);
    expect(done.state).toBe('committed');
    expect(done.outcome.index).toMatchObject({ state: 'superseded', superseded_by_commit: later });
    expect(await pendingHeads(engine, slug)).toEqual([]);
  }, { databaseUrl, setup }), 300_000);

  test('a file that changes between the checks and the import is not imported under the index step (M1)', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    registerIndexSplitPageConsumer({ run: async () => { throw new Error('paused'); } });
    const slug = 'notes/changed-mid-index';
    const row = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERMIDINDEX'), 'put');
    expect(row.state).toBe('indexing');
    const head = git(root, 'rev-parse', 'HEAD').trim();
    _indexLeaseTiming.afterChecks = file => appendFileSync(file, '\nan edit that lands mid-index\n');
    try { await expect(runIndex(engine, row.id)).rejects.toMatchObject({ code: 'source_changed' }); }
    finally { _indexLeaseTiming.afterChecks = undefined; }
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect((await request(engine, row.id)).state).toBe('indexing');
    expect(await pendingHeads(engine, slug)).toHaveLength(1);
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id = 'default' AND slug = $1", [slug])).toEqual([]);
  }, { databaseUrl, setup }), 300_000);

  test('a committed file that no longer matches its head is held, not indexed', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    registerIndexSplitPageConsumer({ run: async () => { throw new Error('paused'); } });
    const slug = 'notes/held';
    const row = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERHELD'), 'put');
    expect(row.state).toBe('indexing');
    appendFileSync(join(root, `${slug}.md`), '\nan uncommitted edit\n');
    await runIndex(engine, row.id);
    const done = await request(engine, row.id);
    expect(done.state).toBe('committed');
    expect(done.outcome.index).toMatchObject({ state: 'held', hold_code: 'hash_mismatch' });
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id = 'default' AND slug = $1", [slug])).toEqual([]);
    const refused = await op('edit_page').handler(ctx, { slug, edits: [{ old_text: 'MARKERHELD', new_text: 'MARKEREDITED' }], request_id: crypto.randomUUID(), wait_ms: 3_000 })
      .then(() => null, (error: { code?: string; retryable?: boolean; fix?: { argv?: string[] } }) => error);
    expect(refused?.code).toBe('index_held');
    expect(refused?.fix?.argv?.slice(0, 5)).toEqual(['gbrain', 'pages', 'reindex', slug, '--source']);
  }, { databaseUrl, setup }), 300_000);
});
