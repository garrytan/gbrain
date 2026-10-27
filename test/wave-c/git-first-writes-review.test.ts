/**
 * Wave C 1I-a, review fixes for the 1H path once 1I turns it on (gstack /review of 1H, H1-H3), on a strict source:
 * - an upload session consumed by a git-first write ends committed (its reservation released), not left sealed;
 * - a page turning private while its committed head waits for the index step commits the removal and clears the head;
 * - edit_page on an unsplit segmented page composes the whole page and takes the deferred path: no table holds the new
 *   bytes before the door, and the index step flips it;
 * - (1I review M3) a deferred write that lowers a page's trust tier files its lower_page proposal when the index step flips it;
 * - an append that would take an unsplit page over PAGE_MAX_BYTES refuses file_too_large (switch_off) instead of staging
 *   segments before the door.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { _resetGitFirstGateForTests, _resetIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { testWaitMs } from '../helpers/wait-for.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { MiB, pageBody, write } from './helpers.ts';
import { withCoordinatedWrite, withTrustBackfill } from '../../src/core/persistence/context.ts';
import { listTrustProposals } from '../../src/core/trust/proposals.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { probeHooks } from './payload-probe.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; reason?: string }) => error);
const paused = { run: async () => { throw new Error('paused'); } };
const pendingHeads = (engine: BrainEngine, slug: string) => engine.executeRaw("SELECT 1 FROM page_pending_heads WHERE source_id = 'default' AND slug = $1", [slug]);
const requestState = async (engine: BrainEngine, requestId: string) => (await engine.executeRaw<{ id: string; state: string }>(
  'SELECT id::text AS id, state FROM persistence_requests WHERE request_id = $1', [requestId]))[0] ?? null;
const pageRow = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ title: string; visibility: string | null }>(
  "SELECT title, frontmatter->>'visibility' AS visibility FROM pages WHERE source_id = 'default' AND slug = $1 AND deleted_at IS NULL", [slug]))[0] ?? null;
/** Runs the owner's effect passes until the page has no pending head (the index step flipped it). */
const settle = async (engine: BrainEngine, slug: string) => {
  const deadline = performance.now() + testWaitMs(60_000);
  while ((await pendingHeads(engine, slug)).length && performance.now() < deadline) {
    await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: localHostId(), limit: 10 });
    await Bun.sleep(50);
  }
  expect(await pendingHeads(engine, slug)).toEqual([]);
};

for (const backend of testBackends()) describe(`[${backend}] git-first writes after the 1H review`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });
  afterEach(() => { _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('an upload consumed by a git-first write ends committed, not sealed', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    registerIndexSplitPageConsumer(paused);
    const text = pageBody(2 * MiB, 'MARKERUPLOADSTAGING');
    const begun = await op('begin_page_upload').handler(ctx, { slug: 'notes/uploaded', mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() }) as { upload_id: string };
    for (let part = 0, at = 0; at < text.length; part++, at += 1_000_000) {
      const slice = text.slice(at, at + 1_000_000);
      await op('upload_page_part').handler(ctx, { upload_id: begun.upload_id, part, text: slice, part_sha256: hex(slice) });
    }
    await refusal(op('commit_page_upload').handler(ctx, { upload_id: begun.upload_id, wait_ms: 5_000 }));
    expect(await pendingHeads(engine, 'notes/uploaded')).toHaveLength(1);
    const [staging] = await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id = $1::uuid', [begun.upload_id]);
    expect(staging?.state).toBe('committed');
  }, { databaseUrl, setup }), 240_000);

  test('a page turning private while its committed update is held (hash_mismatch) removes its file and clears the head', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const slug = 'notes/held-then-private';
    expect(['indexing', 'committed']).toContain((await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERFIRSTVERSION'), 'put')).state);
    await settle(engine, slug);
    registerIndexSplitPageConsumer(paused);
    const revision = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    const update = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERSECONDVERSION'), 'put', { expectedRevision: revision });
    expect(update.state).toBe('indexing');
    writeFileSync(join(root, `${slug}.md`), pageBody(2 * MiB, 'MARKERUNCOMMITTEDEDIT'));
    _resetIndexSplitPageConsumerForTests();
    const deadline = performance.now() + testWaitMs(60_000);
    let held: string | null = null;
    while (!held && performance.now() < deadline) {
      await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: localHostId(), limit: 10 });
      held = (await engine.executeRaw<{ hold_code: string | null }>("SELECT hold_code FROM page_pending_heads WHERE source_id = 'default' AND slug = $1", [slug]))[0]?.hold_code ?? null;
      if (!held) await Bun.sleep(50);
    }
    expect(held).toBe('hash_mismatch');
    const requestId = randomUUID();
    const result = await refusal(op('put_page').handler(ctx, { slug, content: '---\ntype: note\ntitle: Private now\nvisibility: private\n---\n\nPrivate now.\n',
      expected_revision: update.outcome?.index?.revision, request_id: requestId, wait_ms: 5_000 }));
    expect(result).toBeNull();
    expect((await requestState(engine, requestId))?.state).toBe('committed');
    expect(await pendingHeads(engine, slug)).toEqual([]);
    await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: localHostId(), limit: 10 });
    expect(git(root, 'ls-tree', 'HEAD', '--', `${slug}.md`).trim()).toBe('');
    expect(await pageRow(engine, slug)).toMatchObject({ title: 'Private now', visibility: 'private' });
  }, { databaseUrl, setup }), 300_000);

  test('a page turning private while its committed head waits for the index step commits the removal and clears the head', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    registerIndexSplitPageConsumer(paused);
    const slug = 'notes/turning-private';
    const large = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERBEFOREPRIVATE'), 'put');
    expect(large.state).toBe('indexing');
    const requestId = randomUUID();
    const result = await refusal(op('put_page').handler(ctx, { slug, content: '---\ntype: note\ntitle: Private now\nvisibility: private\n---\n\nPrivate now.\n',
      expected_revision: large.outcome?.index?.revision, request_id: requestId, wait_ms: 5_000 }));
    expect(result).toBeNull();
    expect((await requestState(engine, requestId))?.state).toBe('committed');
    _resetIndexSplitPageConsumerForTests();
    await settle(engine, slug);
    expect(git(root, 'ls-tree', 'HEAD', '--', `${slug}.md`).trim()).toBe('');
    expect(await pageRow(engine, slug)).toMatchObject({ title: 'Private now', visibility: 'private' });
  }, { databaseUrl, setup }), 240_000);

  test('edit_page on an unsplit segmented page writes no row holding its bytes before the door, and the index step flips it', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const slug = 'notes/edited';
    const first = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERBEFOREEDIT'), 'put');
    expect(['indexing', 'committed']).toContain(first.state);
    await settle(engine, slug);
    const [page] = await engine.executeRaw<{ body_storage: string }>("SELECT body_storage FROM pages WHERE source_id = 'default' AND slug = $1", [slug]);
    expect(page?.body_storage).toBe('segmented');
    const revision = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    const requestId = randomUUID();
    const probe = probeHooks('MARKEREDITEDNOW', requestId);
    try {
      await refusal(op('edit_page').handler(ctx, { slug, expected_revision: revision, edits: [{ old_text: '# MARKERBEFOREEDIT', new_text: '# MARKEREDITEDNOW' }], request_id: requestId, wait_ms: 5_000 }));
    } finally { probe.clear(); }
    expect(probe.seen()).toEqual({ probed: true, tables: [] });
    expect(['indexing', 'committed']).toContain((await requestState(engine, requestId))?.state);
    expect(git(root, 'show', `HEAD:${slug}.md`)).toContain('MARKEREDITEDNOW');
    await settle(engine, slug);
    expect((await requestState(engine, requestId))?.state).toBe('committed');
  }, { databaseUrl, setup }), 300_000);

  test('a deferred write that lowers an operator_curated page files its lower_page proposal at the flip', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const slug = 'notes/curated';
    expect(['indexing', 'committed']).toContain((await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERCURATED'), 'put')).state);
    await settle(engine, slug);
    // Lowering to unknown is always allowed; the backfill may then raise unknown to operator_curated (CEO-10).
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      await tx.executeRaw("UPDATE pages SET trust_tier = 'unknown' WHERE source_id = 'default' AND slug = $1", [slug]);
      await withTrustBackfill(tx, () => tx.executeRaw("UPDATE pages SET trust_tier = 'operator_curated' WHERE source_id = 'default' AND slug = $1", [slug]));
    }, TEST_WRITE_ATTRIBUTION));
    const revision = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    expect((await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERAGENTREWRITE'), 'put', { expectedRevision: revision })).state).toBe('indexing');
    await settle(engine, slug);
    const [page] = await engine.executeRaw<{ trust_tier: string }>("SELECT trust_tier FROM pages WHERE source_id = 'default' AND slug = $1", [slug]);
    expect(page?.trust_tier).toBe('agent_written');
    const proposals = await listTrustProposals(engine, { sourceId: 'default', action: 'lower_page' });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ status: 'pending' });
  }, { databaseUrl, setup }), 300_000);

  test('an append that would take an unsplit page over PAGE_MAX_BYTES refuses at the git-canonical page limit (file_too_large, wire request_too_large), nothing committed', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const slug = 'notes/near-ceiling';
    expect(['indexing', 'committed']).toContain((await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERNEARCEILING'), 'put')).state);
    await settle(engine, slug);
    await engine.executeRaw("UPDATE pages SET body_bytes = $2 WHERE source_id = 'default' AND slug = $1", [slug, PAGE_MAX_BYTES - 8]);
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const refused = await refusal(op('append_page').handler(ctx, { slug, text: '\nMARKERPASTCEILING crosses the ceiling.\n', request_id: randomUUID(), wait_ms: 5_000 }));
    expect(refused).toMatchObject({ code: 'request_too_large' });
    expect(String((refused as Error).message)).toContain('page limit of a git-canonical source');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
  }, { databaseUrl, setup }), 300_000);
});
