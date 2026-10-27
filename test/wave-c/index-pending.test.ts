/**
 * Wave C 1H-a (ceo-r3-outside-1, write side): while a strict git-first write's committed head waits for its index step, the
 * page's rows describe the generation before it. A put bound to a revision read from those rows would build on stale
 * content and drop the committed write from Git, so it refuses with the retryable index_pending before anything is written.
 * An append (1I, ceo-r3-outside-3) composes over the committed head instead. A put over a never-indexed create sees the page through its pending head (it used to read as an unindexed file
 * in the way); pending-head-admission.test.ts covers writes bound to the head itself.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { CODES } from '../../src/core/error-registry.ts';
import { operations } from '../../src/core/operations.ts';
import { _resetGitFirstGateForTests, _resetIndexSplitPageConsumerForTests, _unregisterIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { MiB, pageBody, write } from './helpers.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; canonical?: string; retryable?: boolean }) => error);
const pendingHead = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ request_id: string }>(
  "SELECT request_id::text AS request_id FROM page_pending_heads WHERE source_id = 'default' AND slug = $1", [slug]))[0] ?? null;

for (const backend of testBackends()) describe(`[${backend}] writes during a pending index (ceo-r3-outside-1)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined }); });
  afterEach(() => { _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('a revision-bound put refuses with index_pending and Git keeps the committed write; an append builds on the committed head (ceo-r3-outside-3)', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const slug = 'notes/pending-target';
    expect((await write(engine, ctx, slug, pageBody(4 * 1024, 'MARKERSMALLFIRST'), 'put')).state).toBe('committed');
    const revision = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    const large = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERLARGEPENDING'), 'put', { expectedRevision: revision });
    expect(large.state).toBe('indexing');
    const head = git(root, 'rev-parse', 'HEAD').trim();

    const bound = await refusal(op('put_page').handler(ctx, { slug, content: pageBody(4 * 1024, 'MARKERBOUND'), expected_revision: revision, request_id: randomUUID(), wait_ms: 3_000 }));
    expect(bound?.code).toBe('index_pending');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(git(root, 'show', `HEAD:${slug}.md`)).toContain('MARKERLARGEPENDING');
    expect((await pendingHead(engine, slug))?.request_id).toBe(large.id);

    const appendId = randomUUID();
    const append = await refusal(op('append_page').handler(ctx, { slug, text: '\nMARKERAPPENDED line.\n', request_id: appendId, wait_ms: 3_000 }));
    expect([null, 'write_pending']).toContain(append?.code ?? null);
    const [appended] = await engine.executeRaw<{ id: string; state: string }>("SELECT id::text AS id, state FROM persistence_requests WHERE request_id = $1", [appendId]);
    expect(appended?.state).toBe('indexing');
    expect(git(root, 'rev-parse', 'HEAD').trim()).not.toBe(head);
    const file = git(root, 'show', `HEAD:${slug}.md`);
    expect(file).toContain('MARKERLARGEPENDING');
    expect(file).not.toContain('MARKERSMALLFIRST');
    expect(file.endsWith('MARKERAPPENDED line.\n')).toBe(true);
    expect((await pendingHead(engine, slug))?.request_id).toBe(appended!.id);
  }, { databaseUrl, setup }), 180_000);

  test('a put over a never-indexed create sees the page through its pending head (revision_required), not as an unindexed file', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const slug = 'notes/pending-create';
    const large = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERLARGECREATE'), 'put');
    expect(large.state).toBe('indexing');
    const again = await write(engine, ctx, slug, pageBody(4 * 1024, 'MARKERSECOND'), 'put');
    expect((again.error as { code?: string })?.code).toBe('revision_required');
    expect(CODES.index_pending.class).toBe('retryable');
    expect((await pendingHead(engine, slug))?.request_id).toBe(large.id);
    expect(git(root, 'show', `HEAD:${slug}.md`)).toContain('MARKERLARGECREATE');
  }, { databaseUrl, setup }), 180_000);
});
