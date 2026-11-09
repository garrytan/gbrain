/**
 * Wave C 1I-a (eng-r3-outside-4, spec §3.8): queued index work is invisible to a released binary. An
 * \`index-split-page\` effect keeps \`next_attempt_at = 'infinity'\` and its due time in \`data.due_at\`
 * (git-first-schema.ts), so the claim master ships, vendored below, never selects it: not when it is queued, not after
 * an old process releases an abandoned claim or requeues it, and not from an old worker started after activation. The
 * current claim still runs it and the index step flips the page.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { _resetGitFirstGateForTests, _resetIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { durableGitRepo } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { testWaitMs } from '../helpers/wait-for.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { MiB, pageBody, write } from './helpers.ts';

/** master's claimPersistenceEffect candidate query (effect-journal.ts), verbatim apart from the dead-owner list. */
const MASTER_CLAIM_SQL = `SELECT e.* FROM persistence_effects e
      LEFT JOIN persistence_worktrees w ON w.id=e.worktree_id
      WHERE (e.state='queued' OR e.state='running' AND e.claim_expires_at<now() OR e.state='running' AND e.recovery IS NULL
  AND e.claim_owner->>'token'=e.execution_token::text AND concat_ws(':',e.claim_owner->'owner'->>'pid',e.claim_owner->'owner'->>'nonce',e.claim_owner->'owner'->>'start')=ANY($2::text[])) AND e.next_attempt_at<=now()
      AND (e.worktree_id IS NULL OR w.owner_host_id=$1::uuid) AND (e.worktree_id IS NULL OR NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes fence WHERE fence.worktree_id=e.worktree_id
        AND fence.state IN ('fenced','merged','recovery_required')))
      AND e.recovery IS NULL AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND (e.kind='withdrawal-mirror' OR NOT EXISTS (SELECT 1 FROM persistence_effects mirror
        WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running')))
      ORDER BY e.next_attempt_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`;
/** master's releaseAbandonedClaims effect reset (PGLite, every process start) and a retry-effects style requeue. */
const MASTER_RELEASE_SQL = "UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,next_attempt_at=LEAST(next_attempt_at,now()) WHERE kind='index-split-page'";
const MASTER_REQUEUE_SQL = "UPDATE persistence_effects SET state='queued',next_attempt_at=now(),updated_at=now() WHERE kind='index-split-page'";

const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const paused = { run: async () => { throw new Error('paused'); } };
const masterClaim = (engine: BrainEngine) => engine.transaction(async tx => {
  await declarePersistenceProtocol(tx);
  return (await tx.executeRaw<{ id: string; kind: string }>(MASTER_CLAIM_SQL, [localHostId(), []]))[0] ?? null;
});
const asMaster = (engine: BrainEngine, sql: string) => engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(sql); });
const indexEffects = (engine: BrainEngine) => engine.executeRaw<{ next_attempt_at: string | Date | number; due_at: string | null; state: string }>(
  "SELECT next_attempt_at, data->>'due_at' AS due_at, state FROM persistence_effects WHERE kind = 'index-split-page'");
const isInfinity = (value: unknown) => value === Infinity || String(value) === 'infinity' || (value instanceof Date && !Number.isFinite(value.getTime()));

for (const backend of testBackends()) describe(`[${backend}] index effects are invisible to a released binary`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });
  afterEach(() => { _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test("master's claim never selects queued, released or requeued index work; the current claim indexes it", () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    registerIndexSplitPageConsumer(paused);
    const slug = 'notes/barrier';
    expect((await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERBARRIER'), 'put')).state).toBe('indexing');
    const [queued] = await indexEffects(engine);
    expect(queued).toBeDefined();
    // The released claim, as queued; after an old process releases the claim on start; after an old requeue.
    expect(await masterClaim(engine)).toBeNull();
    await asMaster(engine, MASTER_RELEASE_SQL);
    expect(await masterClaim(engine)).toBeNull();
    await asMaster(engine, MASTER_REQUEUE_SQL);
    expect(await masterClaim(engine)).toBeNull();
    for (const row of await indexEffects(engine)) {
      expect(isInfinity(row.next_attempt_at)).toBe(true);
      expect(row.due_at).not.toBeNull();
    }
    // The current claim, with the built-in consumer, runs it and the flip lands.
    _resetIndexSplitPageConsumerForTests();
    const deadline = performance.now() + testWaitMs(60_000);
    while ((await engine.executeRaw("SELECT 1 FROM page_pending_heads WHERE slug = $1", [slug])).length && performance.now() < deadline) {
      await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: localHostId(), limit: 10 });
      await Bun.sleep(50);
    }
    expect(await engine.executeRaw("SELECT 1 FROM page_pending_heads WHERE slug = $1", [slug])).toEqual([]);
    expect((await indexEffects(engine)).map(row => row.state)).toEqual(['committed']);
  }, { databaseUrl, setup }), 240_000);
});
