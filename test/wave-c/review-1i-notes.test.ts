/**
 * Wave C 1I-a: four of the five open notes of the 1I review, each red first on both engines.
 *   1. pages verify / pages reindex refusals follow the exit-status contract (exitCodeForCode), never a hard-coded 1.
 *   2. a put_pages batch honours --wait-indexed, and a page that reads indexing counts as pending, never failed.
 *   3. a claim whose per-page index lease recheck fails moves on to the next claimable effect instead of ending the pass.
 *   4. a strict publication group judges each member's file target on the incoming head before it publishes or commits.
 * Synthetic content only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPagesReindex, runPagesVerify } from '../../src/commands/pages-from-git.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { exitCodeForCode } from '../../src/core/error-catalogue.ts';
import { operations } from '../../src/core/operations.ts';
import { claimPersistenceEffect, indexLeaseClaimSeam } from '../../src/core/persistence/effect-journal.ts';
import type { PersistenceEffect } from '../../src/core/persistence/effect-model.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { _resetGitFirstGateForTests, _resetIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { importManagedFiles } from '../../src/core/persistence/import-mutations.ts';
import { indexSplitPage } from '../../src/core/persistence/index-split-page.ts';
import { pageBatchChildRequestId } from '../../src/core/persistence/page-batch-id.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { strictSource } from '../helpers/strict-door-audit.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { MiB, pageBody, write } from './helpers.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const paused = { run: async () => { throw new Error('paused'); } };
const requestState = async (engine: BrainEngine, requestId: string) => (await engine.executeRaw<{ state: string }>(
  'SELECT state FROM persistence_requests WHERE request_id = $1', [requestId]))[0]?.state ?? null;
const indexEffects = (engine: BrainEngine, slug: string) => engine.executeRaw<PersistenceEffect>(
  "SELECT * FROM persistence_effects WHERE kind = 'index-split-page' AND data->>'slug' = $1 ORDER BY id", [slug]);
/** Effect rows change only under the persistence protocol declaration. */
const setEffect = (engine: BrainEngine, sql: string, params: unknown[]) => engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(sql, params); });
const dueIn = (engine: BrainEngine, id: unknown, interval: string) => setEffect(engine,
  "UPDATE persistence_effects SET state = 'queued', execution_token = NULL, claim_expires_at = NULL, data = jsonb_set(data, '{due_at}', to_jsonb((now() + $2::interval)::text)) WHERE id = $1",
  [id, interval]);

for (const backend of testBackends()) describe('[' + backend + '] the 1I review notes', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); _resetCliExitVerdictForTests(); });
  afterEach(() => {
    _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); _resetCliExitVerdictForTests();
    delete indexLeaseClaimSeam.beforeRecheck; installFaultHook(undefined);
  });

  test('1: a pages verify or pages reindex refusal exits with its code\'s status, not a hard-coded 1', () => managedBrain(async ({ engine }) => {
    await strictSource(engine);
    await runPagesReindex(engine, ['notes/exit-status', '--from-git', '--apply']);
    expect(exitCodeForCode('invalid_params')).toBe(2);
    expect(currentExitCode()).toBe(2);
    _resetCliExitVerdictForTests();
    await runPagesVerify(engine, ['notes/exit-status', '--bogus-flag', '--json']);
    expect(currentExitCode()).toBe(2);
  }, { databaseUrl, setup }), 120_000);

  test('2: a put_pages batch keeps waiting under --wait-indexed, and an indexing page counts as pending, not failed', () => managedBrain(async ({ engine, ctx }) => {
    await strictSource(engine);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // The plain batch's index job stays paused; the waited batch's job runs once the gate opens.
    registerIndexSplitPageConsumer({ run: async (e, config, effect, hostId) => {
      if (effect.data.slug === 'notes/batched-plain') throw new Error('paused');
      await gate;
      return indexSplitPage.run(e, config, effect, hostId);
    } });

    // A failure before the gate opens must not leave the index job waiting on it (the brain's teardown drains effects).
    try {
      const plain = await op('put_pages').handler(ctx, { request_id: randomUUID(), wait_ms: 3_000,
        pages: [{ slug: 'notes/batched-plain', content: pageBody(2 * MiB, 'MARKERBATCHPLAIN') }] }) as Record<string, any>;
      expect(plain.pages[0].state).toBe('indexing');
      expect(plain.state).toBe('pending');
      expect(plain.counts).toMatchObject({ committed: 0, pending: 1, failed: 0 });
      expect(plain.next.action).toBe('poll');

      const batch = randomUUID();
      const child = pageBatchChildRequestId(batch, 0);
      let done = false;
      const run = op('put_pages').handler({ ...ctx, waitIndexedMs: 120_000 }, { request_id: batch, wait_ms: 3_000,
        pages: [{ slug: 'notes/batched-waited', content: pageBody(2 * MiB, 'MARKERBATCHWAITED') }] }).finally(() => { done = true; });
      const started = performance.now();
      while (await requestState(engine, child) !== 'indexing' && performance.now() - started < 60_000) await Bun.sleep(50);
      while (performance.now() - started < 4_000) await Bun.sleep(100);
      expect(done).toBe(false);
      release();
      while (!done && performance.now() - started < 90_000) {
        await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: localHostId(), limit: 10 }).catch(() => undefined);
        await Bun.sleep(100);
      }
      const receipt = await run as Record<string, any>;
      expect(receipt.pages[0].state).toBe('committed');
      expect(receipt.state).toBe('committed');
      expect(await requestState(engine, child)).toBe('committed');
    } finally { release(); }
  }, { databaseUrl, setup }), 240_000);

  test('3: a claim whose index lease recheck fails claims the next effect instead of ending the pass', () => managedBrain(async ({ engine, ctx }) => {
    await strictSource(engine);
    registerIndexSplitPageConsumer(paused);
    const first = await write(engine, ctx, 'notes/lease-a', pageBody(2 * MiB, 'MARKERLEASEA'), 'put');
    expect(first.state).toBe('indexing');
    await op('append_page').handler(ctx, { slug: 'notes/lease-a', text: '\nMARKERLEASEAPPEND line.\n', request_id: randomUUID(), wait_ms: 3_000 }).catch(() => undefined);
    const other = await write(engine, ctx, 'notes/lease-b', pageBody(2 * MiB, 'MARKERLEASEB'), 'put');
    expect(other.state).toBe('indexing');
    const [a1, a2] = await indexEffects(engine, 'notes/lease-a');
    const [b1] = await indexEffects(engine, 'notes/lease-b');
    expect(a2).toBeDefined();
    await dueIn(engine, a1!.id, '1 day');
    await dueIn(engine, a2!.id, '-1 hour');
    await dueIn(engine, b1!.id, '-1 minute');
    // Another worker claims a1 between this claim's candidate read and its lease recheck.
    let raced = false;
    indexLeaseClaimSeam.beforeRecheck = async (tx, candidate) => {
      if (raced || String(candidate.id) !== String(a2!.id)) return;
      raced = true;
      await tx.executeRaw("UPDATE persistence_effects SET state = 'running', execution_token = $2::uuid, claim_expires_at = now() + interval '2 minutes' WHERE id = $1", [a1!.id, randomUUID()]);
    };
    const claimed: string[] = [];
    for (let i = 0; i < 50; i++) {
      const next = await claimPersistenceEffect(engine, localHostId());
      if (!next) break;
      claimed.push(String(next.id));
    }
    expect(raced).toBe(true);
    expect(claimed).not.toContain(String(a2!.id));
    expect(claimed).toContain(String(b1!.id));
  }, { databaseUrl, setup }), 240_000);

  test('4: a strict group refuses a member whose target became declared before it publishes or commits anything', () => managedBrain(async ({ engine, root }) => {
    await strictSource(engine);
    mkdirSync(join(root, 'notes'), { recursive: true });
    mkdirSync(join(root, 'vault'), { recursive: true });
    writeFileSync(join(root, 'notes/group-a.md'), '---\ntype: note\ntitle: Group A\n---\n\nGroup member A.\n');
    writeFileSync(join(root, 'vault/group-b.md'), '---\ntype: note\ntitle: Group B\n---\n\nGroup member B.\n');
    const head = git(root, 'rev-parse', 'HEAD').trim();
    // The source declares vault/ database-only after the members were prepared.
    let declared = false;
    installFaultHook(async point => {
      if (declared || point !== 'publication:prepared') return;
      declared = true;
      writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - vault\n');
    });
    const settled = await importManagedFiles(engine, [
      { filePath: join(root, 'notes/group-a.md'), sourcePath: 'notes/group-a.md' },
      { filePath: join(root, 'vault/group-b.md'), sourcePath: 'vault/group-b.md' },
    ], { sourceId: 'default', noEmbed: true });
    installFaultHook(undefined);
    expect(declared).toBe(true);
    expect(settled[1]!.status).toBe('rejected');
    expect((settled[1] as PromiseRejectedResult).reason?.code).toBe('git_home_required');
    expect(git(root, 'log', '--all', '--format=%H', head + '..', '--', 'vault/group-b.md').trim()).toBe('');
    expect(git(root, 'ls-tree', '--name-only', 'HEAD', '--', 'vault/group-b.md').trim()).toBe('');
  }, { databaseUrl, setup }), 240_000);
});
