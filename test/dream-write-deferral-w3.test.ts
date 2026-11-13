/**
 * W3 (GBRA-224, #7587): a dream phase write accepted but still pending after
 * its publish wait is a deferral, not a failure. The next pass reconciles the
 * receipt before it submits anything (committed: done; failed: its real
 * failure), a source with a pending receipt submits nothing, and after
 * DREAM_WRITE_DEFERRAL_MAX_REPLAYS passes doctor's dream_write_deferred check
 * names the receipt. Real PGLite and, with DATABASE_URL, Postgres; repo and
 * repo-less brains.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { purgeDeletedPagesCoordinated, purgePhaseStatus } from '../src/core/persistence/purge-deleted.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { requestPrincipalForContext, submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { deferDreamWrite, readDreamWriteDeferrals, reconcileDreamWriteDeferrals, DREAM_WRITE_DEFERRAL_ENABLED_KEY,
  DREAM_WRITE_DEFERRAL_MAX_REPLAYS, DREAM_WRITE_DEFERRALS_KEY } from '../src/core/cycle/dream-write-deferral.ts';
import { readHealAudit, HEAL_AUDIT_KEY } from '../src/core/heal-audit.ts';
import { dreamWriteDeferredCheck } from '../src/commands/doctor/checks/dream-write-deferred.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-w3-deferral-db-'));
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

const logger = { info() {}, warn() {}, error() {} };
function ctxFor(engine: BrainEngine, sourceId: string): OperationContext {
  return { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger };
}

/** A source with an active local canonical owner (repo brain) or none (repo-less); managed persistence on after `seed`. */
async function fixture(opts: { repo: boolean; managed: boolean }, seed: (engine: BrainEngine, sourceId: string) => Promise<void>,
  run: (engine: BrainEngine, sourceId: string, root: string) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-w3-deferral-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `w3d-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('DELETE FROM config WHERE key = ANY($1::text[])', [[DREAM_WRITE_DEFERRALS_KEY, HEAL_AUDIT_KEY, DREAM_WRITE_DEFERRAL_ENABLED_KEY]]);
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, opts.repo ? root : null]);
        await engine.setConfig('sync.write_through', opts.repo ? 'true' : 'false');
        if (opts.repo) await claimWorktree(engine, sourceId, root);
        await seed(engine, sourceId);
        if (opts.managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run(engine, sourceId, root);
      });
    } finally {
      __setMaintenanceWriteWaitForTests(null);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      // Purges are brain-wide: leave no tombstone or deferral behind for the next case on this engine.
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [sourceId]);
      await engine.executeRaw('DELETE FROM config WHERE key = ANY($1::text[])', [[DREAM_WRITE_DEFERRALS_KEY, HEAL_AUDIT_KEY, DREAM_WRITE_DEFERRAL_ENABLED_KEY]]);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function tombstone(engine: BrainEngine, sourceId: string, slug: string) {
  const ctx = ctxFor(engine, sourceId);
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: `---\ntitle: T\ntype: note\n---\nBody of ${slug}.`, request_id: randomUUID() } });
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision: snapshot!.revision, request_id: randomUUID() } });
  await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id=$1 AND slug=$2", [sourceId, slug]);
}

const purgeRequests = (engine: BrainEngine, sourceId: string) => engine.executeRaw<{ request_id: string; state: string }>(
  "SELECT request_id::text, state FROM persistence_requests WHERE source_id=$1 AND operation='delete_page' AND jsonb_path_exists(intent::jsonb, '$.** ? (@.purge == true)') ORDER BY sequence", [sourceId]);

async function waitCommitted(engine: BrainEngine, requestId: string) {
  for (let i = 0; i < 200; i++) {
    const [row] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    if (row?.state === 'committed') return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`request ${requestId} did not commit`);
}

async function holdWriter(engine: BrainEngine, sourceId: string) {
  return (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1000))!;
}

test('purge: a pending write defers (warn, never failed, no park), holds its source, escalates after the bound, then reconciles committed', async () => {
  await fixture({ repo: true, managed: true }, async (engine, sourceId) => {
    await tombstone(engine, sourceId, 'notes/old-a');
    await tombstone(engine, sourceId, 'notes/old-b');
  }, async (engine, sourceId) => {
    __setMaintenanceWriteWaitForTests(300);
    const lock = await holdWriter(engine, sourceId);
    let requestId: string;
    try {
      const first = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
      expect(first.failed).toBe(0);
      expect(first.error).toBeUndefined();
      expect(first.write_deferred).toBe(2);
      expect(purgePhaseStatus(first)).toBe('warn');
      expect(first.blocked.map(b => b.code)).toEqual(['dream_write_deferred', 'dream_write_deferred']);
      const submitted = await purgeRequests(engine, sourceId);
      expect(submitted).toHaveLength(1);
      requestId = submitted[0]!.request_id;
      expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='purge-deleted-park'")).toHaveLength(0);
      const [deferral] = await readDreamWriteDeferrals(engine);
      expect(deferral).toMatchObject({ phase: 'purge', source_id: sourceId, subject: `${sourceId}/notes/old-a`, request_id: requestId, replays: 0 });
      expect(deferral!.receipt_id).toBeTruthy();
      expect((await dreamWriteDeferredCheck(engine)).status).toBe('ok');

      for (let pass = 1; pass <= DREAM_WRITE_DEFERRAL_MAX_REPLAYS; pass++) {
        const held = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
        expect(held).toMatchObject({ failed: 0, write_deferred: 2, count: 0 });
        expect((await readDreamWriteDeferrals(engine))[0]!.replays).toBe(pass);
      }
      // Held passes never resubmit.
      expect(await purgeRequests(engine, sourceId)).toHaveLength(1);
      const check = await dreamWriteDeferredCheck(engine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain(requestId);
      expect(check.message).toContain(`gbrain write-request -- ${requestId}`);
      expect(check.fix).toMatchObject({ argv: ['gbrain', 'write-request', '--', requestId] });
      // Stops counting at the bound.
      await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
      expect((await readDreamWriteDeferrals(engine))[0]!.replays).toBe(DREAM_WRITE_DEFERRAL_MAX_REPLAYS);
      const audit = await readHealAudit(engine, 'dream_write_deferred');
      expect(audit.map(row => [row.outcome, row.attempt, row.bound])).toEqual([
        ['deferred', 0, 3], ['replayed', 1, 3], ['replayed', 2, 3], ['escalated', 3, 3]]);
    } finally { await lock.release(); }

    await waitCommitted(engine, requestId!);
    const after = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
    expect(after).toMatchObject({ failed: 0, write_deferred: 0, count: 1, slugs: ['notes/old-b'] });
    expect(after.deferral?.reconcile?.committed.map(entry => entry.request_id)).toEqual([requestId!]);
    expect(await readDreamWriteDeferrals(engine)).toEqual([]);
    expect((await dreamWriteDeferredCheck(engine)).status).toBe('ok');
    // The committed purge was not resubmitted: one request for old-a, one new for old-b.
    expect(await purgeRequests(engine, sourceId)).toHaveLength(2);
    expect(await engine.readPageSnapshot('notes/old-a', { sourceId, includeDeleted: true })).toBeNull();
    expect((await readHealAudit(engine, 'dream_write_deferred')).at(-1)?.outcome).toBe('committed');
  });
}, 120_000);

test('purge through runCycle: a deferred write is a warn phase, the cycle is partial and never failed', async () => {
  await fixture({ repo: true, managed: true }, async (engine, sourceId) => {
    await tombstone(engine, sourceId, 'notes/old-c');
  }, async (engine, sourceId, root) => {
    __setMaintenanceWriteWaitForTests(300);
    const lock = await holdWriter(engine, sourceId);
    try {
      const report = await runCycle(engine, { brainDir: root, phases: ['purge'] });
      const phase = report.phases.find(p => p.phase === 'purge')!;
      expect(phase.status).toBe('warn');
      expect(phase.error).toBeUndefined();
      expect(phase.details.purged_pages_write_deferred).toBe(1);
      expect((phase.details.write_deferral as { pending: Array<{ status_command: string }> }).pending[0]!.status_command).toMatch(/^gbrain write-request -- /);
      expect(report.status).not.toBe('failed');
    } finally { await lock.release(); }
  });
}, 120_000);

test('purge: a deferred receipt that ended failed is reported as its real failure; the candidate is re-validated, not resubmitted that pass', async () => {
  await fixture({ repo: true, managed: true }, async (engine, sourceId) => {
    await tombstone(engine, sourceId, 'notes/old-d');
  }, async (engine, sourceId) => {
    const ctx = ctxFor(engine, sourceId);
    // A real terminal receipt: a purge bound to a revision the tombstone no longer has.
    const requestId = randomUUID();
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'notes/old-d', source_id: sourceId, purge: true,
      expected_revision: randomUUID(), request_id: requestId } }).catch(() => undefined);
    const [receipt] = await engine.executeRaw<{ state: string; error_code: string | null }>('SELECT state, error_code FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(['failed', 'conflict', 'cancelled']).toContain(receipt!.state);
    await deferDreamWrite(engine, { phase: 'purge', sourceId, subject: `${sourceId}/notes/old-d`, requestId, principal: await requestPrincipalForContext(ctx) });
    const before = (await purgeRequests(engine, sourceId)).length;
    const result = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
    expect(result.deferral?.reconcile?.failed.map(entry => entry.request_id)).toEqual([requestId]);
    const reported = result.blocked.find(b => b.slug === 'notes/old-d')!;
    expect(reported.reason).toContain(requestId);
    expect(reported.code).toBe(result.deferral!.reconcile!.failed[0]!.code);
    expect(await purgeRequests(engine, sourceId)).toHaveLength(before);
    expect(await readDreamWriteDeferrals(engine)).toEqual([]);
    expect((await engine.readPageSnapshot('notes/old-d', { sourceId, includeDeleted: true }))?.page.deleted_at).toBeTruthy();
  });
}, 120_000);

test('consolidate: a pending publication defers its source; the next pass reconciles it before submitting and writes the take once', async () => {
  const vector = `[${[1, ...Array(1535).fill(0)].join(',')}]`;
  await fixture({ repo: true, managed: true }, async (engine, sourceId) => {
    await submitPageMutation(ctxFor(engine, sourceId), { operation: 'put_page', params: {
      slug: 'people/example', content: '---\ntitle: Example\ntype: note\n---\nExample evidence.', request_id: randomUUID() } });
    for (const [i, word] of ['alpha', 'beta', 'gamma'].entries()) {
      await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,confidence,valid_from,embedding,embedding_model,embedded_text_hash)
        VALUES($1,'people/example',$2,'fact','test','world',0.9,$3::timestamptz,$4::vector,'openai:text-embedding-3-large',md5($2))`,
      [sourceId, `Example claim ${word}`, `2026-01-0${i + 1}T00:00:00Z`, vector]);
    }
  }, async (engine, sourceId) => {
    __setMaintenanceWriteWaitForTests(300);
    const lock = await holdWriter(engine, sourceId);
    let requestId: string;
    try {
      const first = await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 });
      expect(first.status).toBe('warn');
      expect(first.error).toBeUndefined();
      expect(first.details.buckets_deferred).toBe(1);
      expect(first.details.buckets_failed).toBe(0);
      const [deferral] = await readDreamWriteDeferrals(engine);
      expect(deferral).toMatchObject({ phase: 'consolidate', source_id: sourceId, subject: `${sourceId}/people/example` });
      requestId = deferral!.request_id;
      const held = await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 });
      expect(held.details).toMatchObject({ buckets_deferred: 1, facts_consolidated: 0 });
    } finally { await lock.release(); }
    await waitCommitted(engine, requestId!);
    const requestsBefore = await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [sourceId]);
    const after = await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 });
    expect(after.status).toBe('ok');
    expect((after.details.write_deferral as { reconciled_committed: string[] }).reconciled_committed).toEqual([requestId!]);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [sourceId])).toHaveLength(requestsBefore.length);
    const page = (await engine.readPageSnapshot('people/example', { sourceId }))!;
    expect(await engine.executeRaw('SELECT id FROM takes WHERE page_id=$1', [page.page.id])).toHaveLength(1);
    expect(await readDreamWriteDeferrals(engine)).toEqual([]);
  });
}, 120_000);

test('dream.write_deferral.enabled=false keeps the old behavior: a pending purge fails the run', async () => {
  await fixture({ repo: true, managed: true }, async (engine, sourceId) => {
    await tombstone(engine, sourceId, 'notes/old-e');
  }, async (engine, sourceId) => {
    await engine.setConfig(DREAM_WRITE_DEFERRAL_ENABLED_KEY, 'false');
    __setMaintenanceWriteWaitForTests(300);
    const lock = await holdWriter(engine, sourceId);
    try {
      const result = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
      expect(result.failed).toBe(1);
      expect(result.error?.code).toBe('managed_purge_failed');
      expect(result.write_deferred).toBeUndefined();
      expect(await readDreamWriteDeferrals(engine)).toEqual([]);
    } finally { await lock.release(); }
  });
}, 120_000);

test('repo-less managed source: a deferred write is reconciled from database state alone', async () => {
  await fixture({ repo: false, managed: true }, async (engine, sourceId) => {
    await tombstone(engine, sourceId, 'notes/old-f');
  }, async (engine, sourceId) => {
    __setMaintenanceWriteWaitForTests(0);
    const first = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
    expect(first.failed).toBe(0);
    expect(first.error).toBeUndefined();
    const submitted = await purgeRequests(engine, sourceId);
    expect(submitted).toHaveLength(1);
    // A zero publish wait returns before the consumer can publish, so the write is accepted and pending.
    expect(first.write_deferred).toBe(1);
    expect((await readDreamWriteDeferrals(engine))[0]).toMatchObject({ phase: 'purge', source_id: sourceId });
    await waitCommitted(engine, submitted[0]!.request_id);
    const next = await reconcileDreamWriteDeferrals(engine, 'purge');
    expect(next.committed.map(entry => entry.request_id)).toEqual([submitted[0]!.request_id]);
    expect(await readDreamWriteDeferrals(engine)).toEqual([]);
    expect(await engine.readPageSnapshot('notes/old-f', { sourceId, includeDeleted: true })).toBeNull();
  });
}, 120_000);

test('repo-less unmanaged brain: purge and consolidate run as before and record no deferral', async () => {
  await fixture({ repo: false, managed: false }, async (engine, sourceId) => {
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,deleted_at) VALUES($1,'notes/gone','note','Gone','Body',now() - interval '100 hours')`, [sourceId]);
  }, async (engine, sourceId) => {
    const purged = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
    expect(purged.failed).toBe(0);
    expect(purged.slugs).toContain('notes/gone');
    expect(purged.write_deferred).toBeUndefined();
    const consolidated = await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 });
    expect(consolidated.status).not.toBe('fail');
    expect(consolidated.details.write_deferral).toBeUndefined();
    expect(await readDreamWriteDeferrals(engine)).toEqual([]);
    expect((await dreamWriteDeferredCheck(engine)).status).toBe('ok');
  });
}, 120_000);
