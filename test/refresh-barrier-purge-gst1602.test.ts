/**
 * GST-1602: with persistence.refresh_barrier on, a write deferred behind a refresh that publishes a staged body holding a
 * claim must not block purge_fact. Before the fix the purge refused purge_blocked_pending_recovery ("is publishing")
 * until the refresh released or the barrier expired (15 minutes by default), holding back removal of the content.
 * A deferred row has not been claimed, so the purge cancels it with purged_content, as it does a queued one.
 * Real refresh paused at its drained boundary; PGLite, and Postgres when DATABASE_URL is set.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { requestPrincipalForContext } from '../src/core/persistence/page-mutations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { _setRefreshFenceWaitForTests } from '../src/core/persistence/admission-retry.ts';
import { _resetRefreshBarrierCacheForTests } from '../src/core/persistence/refresh-barrier.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';
import { page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const CLAIM = 'Door code is 4417';
const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});
beforeEach(() => { _setRefreshFenceWaitForTests(0); _resetRefreshBarrierCacheForTests(); });
afterEach(() => { resetWriteSwitches(); _setRefreshFenceWaitForTests(null); });

const purge = operations.find(o => o.name === 'purge_fact')!;
const codeOf = (e: unknown) => e instanceof OperationError ? e.canonical ?? e.code : String((e as Error).message);

/** A staged upload in `f.alpha` whose part holds the claim, and a fact row carrying it. */
async function seed(f: RefreshFixture): Promise<{ stagingId: string; factId: number; incarnation: string }> {
  const [source] = await f.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [f.alpha]);
  const stagingId = randomUUID();
  const part = Buffer.from(`Uploaded notes.\n${CLAIM}\n`, 'utf8');
  const [fact] = await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.alpha], async () => {
    await tx.openBodyStaging({ id: stagingId, kind: 'upload', principalKind: 'application', principalId: 'test:fixture', clientRequestId: randomUUID(),
      sourceId: f.alpha, sourceIncarnation: source!.incarnation, slug: 'upload-example', pageId: null, mode: 'create', baseRevision: null,
      baseGeneration: null, declaredBytes: part.length, declaredSha256: null, reservedBytes: 0,
      idleExpiresAt: new Date(Date.now() + 3_600_000), hardExpiresAt: new Date(Date.now() + 7_200_000) });
    await tx.executeRaw('INSERT INTO page_body_staging_parts(staging_id,part_no,byte_start,byte_len,sha256,body) VALUES ($1::uuid,0,0,$2,$3,$4)',
      [stagingId, part.length, createHash('sha256').update(part).digest(), part]);
    return tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source) VALUES ($1,$2,'people/door-example','world','test') RETURNING id`,
      [f.alpha, CLAIM]);
  }, TEST_WRITE_ATTRIBUTION));
  return { stagingId, factId: Number(fact!.id), incarnation: source!.incarnation };
}

test('purge_fact cancels a deferred write holding the claim in its staged body instead of refusing until the refresh ends', () =>
  withEnv({ GBRAIN_REFRESH_BARRIER: '1' }, async () => {
    resetWriteSwitches();
    for (const engine of engines) await withRefreshFixture(engine, async f => {
      const { stagingId, factId, incarnation } = await seed(f);
      const ctx = f.ctx(f.alpha);
      const principal = await requestPrincipalForContext(ctx);
      f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      let reached!: () => void; const drained = new Promise<void>(resolve => { reached = resolve; });
      const refresh = refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => { if (point === 'drained') { reached(); await gate; } } } });
      await drained;
      try {
        const outstanding = async () => Number((await f.engine.executeRaw<{ n: number }>("SELECT outstanding_count::int AS n FROM persistence_counters WHERE key='brain'"))[0]?.n ?? 0);
        const before = await outstanding();
        const [binding] = await f.engine.executeRaw<{ topology_generation: number }>('SELECT topology_generation FROM persistence_source_bindings WHERE source_id=$1', [f.alpha]);
        const held = await admitWrite(f.engine, { principal, operation: 'put_page', sourceId: f.alpha, sourceIncarnation: incarnation, slug: 'upload-example',
          worktreeId: f.worktreeId, topologyGeneration: Number(binding!.topology_generation), deferrable: true, requestId: randomUUID(),
          callerIntent: { body_ref: { staging_id: stagingId } }, intent: { body_ref: { staging_id: stagingId } },
          authority: await submissionAuthority(ctx, 'put_page', f.alpha, incarnation, 'upload-example') });
        expect(held.state).toBe('deferred');

        const dry = await purge.handler(ctx, { id: factId, dry_run: true }) as Record<string, any>;
        const done = await (purge.handler(ctx, { id: factId, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }) as Promise<Record<string, any>>)
          .catch(e => ({ state: codeOf(e) }));
        expect(done.state).toBe('committed');
        expect((await f.engine.executeRaw<{ state: string; error_code: string }>('SELECT state,error_code FROM persistence_requests WHERE id=$1::uuid', [held.id]))[0])
          .toEqual({ state: 'cancelled', error_code: 'purged_content' });
        expect((await f.engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id=$1::uuid', [stagingId]))[0]?.state).toBe('aborted');
        expect(await f.engine.executeRaw('SELECT 1 FROM page_body_staging_parts WHERE staging_id=$1::uuid', [stagingId])).toHaveLength(0);
        release();
        await refresh;
        expect((await f.engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE id=$1::uuid', [held.id]))[0]?.state).toBe('cancelled');
        expect(await outstanding()).toBe(before);
      } finally {
        release();
        await refresh.catch(() => undefined);
      }
    });
  }), 180_000);
