/**
 * #6176: a write whose publication hangs keeps its claim alive (the owner keeps renewing it), so every later
 * write on its root waits behind it and nothing reported it. The claim renewal now records the claim's phase
 * (claim-phase.ts), `gbrain sources writer status` names it, and doctor's `persistence_write_stall` warns once
 * a claim is older than `persistence.max_claim_ms`. PGLite always; Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { admitWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { readWriterDiagnostics } from '../src/core/persistence/diagnostics.ts';
import { claimStateOf, validateMaxClaimConfigValue } from '../src/core/persistence/claim-phase.ts';
import { writeStallCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import { admission, fixtures, initializeFixtures, prepared, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

const homes: string[] = [];
afterAll(() => { installFaultHook(undefined); setSystemTime(); for (const home of homes) rmSync(home, { recursive: true, force: true }); });

test('claim state names the phase from the stamp of the current claim only', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const stamp = { phase: 'publishing', claimed_at: '2026-10-06T11:45:00Z', since: '2026-10-06T11:50:00Z', token: 't1' };
  expect(claimStateOf({ state: 'running', claim_phase: stamp, execution_token: 't1' }, now))
    .toMatchObject({ phase: 'publishing', claim_age_ms: 15 * 60_000, phase_age_ms: 10 * 60_000, resumes_on_its_own: false });
  expect(claimStateOf({ state: 'running', claim_phase: JSON.stringify(stamp), execution_token: 't2' }, now)).toMatchObject({ phase: 'unrecorded', claim_age_ms: null });
  expect(claimStateOf({ state: 'running', claim_phase: stamp, execution_token: 't1', claim_lapsed: true }, now)).toMatchObject({ phase: 'publication_transaction', resumes_on_its_own: true });
  expect(claimStateOf({ state: 'running', claim_phase: stamp, execution_token: 't1', publication_started: true }, now)).toMatchObject({ phase: 'file_publication' });
  expect(claimStateOf({ state: 'queued', claim_phase: stamp, execution_token: 't1' }, now)).toBeNull();
});

test('persistence.max_claim_ms is validated with a coded refusal', () => {
  expect(validateMaxClaimConfigValue('persistence.max_claim_ms', '900000')).toBeNull();
  for (const bad of ['5000', 'ten', '1.5', '999999999999']) expect(validateMaxClaimConfigValue('persistence.max_claim_ms', bad)).toStartWith('invalid_params:');
  expect(validateMaxClaimConfigValue('persistence.write_wait_ms', 'anything')).toBeNull();
});

async function scenario(engine: BrainEngine, config: HarnessConfig) {
  const sources = await fixtures(engine, config);
  const stuck = await admitWrite(engine, admission(config, sources[0]!, 'stall/stuck', 'stuck body'));
  const behind = await admitWrite(engine, admission(config, sources[0]!, 'stall/behind', 'behind body'));
  const hang = Promise.withResolvers<void>();
  installFaultHook(async (point, detail) => { if (point === 'consumer:prepared' && detail.requestId === stuck.request_id) await hang.promise; });
  const errors: unknown[] = [];
  const consumer = new PersistenceConsumer(engine, { engine: engine.kind }, async (_engine, row) => prepared(row, sources),
    { hostId: config.hostId, concurrency: 1, pollMs: 20, renewalIntervalMs: 20, phaseMs: 2_000, onError: error => errors.push(error),
      // The test moves the clock 11 minutes ahead. A 30 s lease would let the consumer's own expired-claims sweep requeue the
      // stuck claim before the next renewal (a race that hangs the frozen-clock waitFor); a day-long lease keeps it live, as
      // an owner renewing for 11 real minutes would.
      claimLeaseMs: 86_400_000 });
  try {
    consumer.start();
    await waitFor(async () => (await engine.executeRaw<{ p: string | null }>("SELECT claim_phase->>'phase' AS p FROM persistence_requests WHERE id=$1::uuid", [stuck.id]))[0]?.p === 'publishing',
      { timeoutMs: 15_000, label: 'the renewal records the publishing phase' });
    const status = await readWriterDiagnostics(engine);
    const blocker = status.blockers.find(row => row.request_id === stuck.request_id) as Record<string, unknown> | undefined;
    expect(blocker?.claim).toMatchObject({ phase: 'publishing', resumes_on_its_own: false });
    expect(blocker).not.toHaveProperty('execution_token');
    expect(blocker).not.toHaveProperty('claim_phase');
    expect((await writeStallCheck(engine)).status).toBe('ok');
    // PGLite's now() follows the shifted clock too, so the check runs after a renewal under it (the claim stays live).
    const live = async () => (await engine.executeRaw<{ live: boolean }>('SELECT claim_expires_at>now() AS live FROM persistence_requests WHERE id=$1::uuid', [stuck.id]))[0]?.live === true;
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    let check;
    try { await waitFor(live, { timeoutMs: 10_000, label: 'a renewal under the shifted clock' }); check = await writeStallCheck(engine); } finally { setSystemTime(); }
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ count: 1, max_claim_ms: 600_000,
      stalls: [{ request_id: stuck.request_id, source_id: sources[0]!.id, root: stuck.worktree_id, phase: 'publishing', waiting_behind: 1, resumes_on_its_own: false }] });
    expect((check.fix as { argv: string[] }).argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', sources[0]!.id, '--json']);
    expect(check.message).toContain('phase publishing');
    await engine.setConfig('persistence.max_claim_ms', '86400000');
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    try { await waitFor(live, { timeoutMs: 10_000, label: 'a renewal under the shifted clock' }); expect((await writeStallCheck(engine)).status).toBe('ok'); } finally { setSystemTime(); await engine.executeRaw("DELETE FROM config WHERE key='persistence.max_claim_ms'"); }
    hang.resolve();
    await waitFor(async () => (await getWriteRequestById(engine, behind.id))?.state === 'committed', { timeoutMs: 15_000, label: 'the write behind it commits' });
    expect((await getWriteRequestById(engine, stuck.id))?.state).toBe('committed');
    expect((await writeStallCheck(engine)).status).toBe('ok');
  } finally {
    hang.resolve();
    installFaultHook(undefined);
    await consumer.stop();
  }
  const churn = await admitWrite(engine, admission(config, sources[1]!, 'stall/churn', 'churning body'));
  const churnToken = randomUUID();
  await engine.executeRaw(`UPDATE persistence_requests SET state='running',execution_token=$2::uuid,claim_expires_at=now()+interval '30 seconds',
    claim_phase=jsonb_build_object('phase','preparing','claimed_at',now()::text,'since',now()::text,'token',$2::text),created_at=now()-interval '39 hours'
    WHERE id=$1::uuid`, [churn.id, churnToken]);
  const churnCheck = await writeStallCheck(engine);
  expect(churnCheck.status).toBe('warn');
  expect(churnCheck.details).toMatchObject({ stalls: [{ request_id: churn.request_id, source_id: sources[1]!.id, root: churn.worktree_id }] });
  expect((churnCheck.details as { stalls: Array<{ why: string }> }).stalls[0]!.why).toContain('No request on this root reached a terminal state');
  expect(churnCheck.message).toContain('after 2340 min');

  const progress = await admitWrite(engine, admission(config, sources[1]!, 'stall/progress', 'progress body'));
  await engine.executeRaw(`UPDATE persistence_requests SET state='committed',completed_at=now()-interval '1 minute' WHERE id=$1::uuid`, [progress.id]);
  const progressCheck = await writeStallCheck(engine);
  expect(progressCheck.status).toBe('ok');
  expect(progressCheck.details).toMatchObject({ count: 0, stalls: [] });

  await engine.executeRaw('DELETE FROM persistence_requests WHERE id=$1::uuid OR id=$2::uuid', [churn.id, progress.id]);
  const young = await admitWrite(engine, admission(config, sources[1]!, 'stall/young', 'young body'));
  const youngToken = randomUUID();
  await engine.executeRaw(`UPDATE persistence_requests SET state='running',execution_token=$2::uuid,claim_expires_at=now()+interval '30 seconds',
    claim_phase=jsonb_build_object('phase','preparing','claimed_at',now()::text,'since',now()::text,'token',$2::text),created_at=now()-interval '2 minutes'
    WHERE id=$1::uuid`, [young.id, youngToken]);
  const youngCheck = await writeStallCheck(engine);
  expect(youngCheck.status).toBe('ok');
  expect(youngCheck.details).toMatchObject({ count: 0, stalls: [] });

  // A database-only root (no worktree): progress is judged per source among database-only requests.
  await engine.executeRaw('DELETE FROM persistence_requests WHERE id=$1::uuid', [young.id]);
  const dbOnly = await admitWrite(engine, admission(config, sources[1]!, 'stall/db-only', 'db-only body'));
  const dbOnlyToken = randomUUID();
  await engine.executeRaw(`UPDATE persistence_requests SET state='running',worktree_id=NULL,execution_token=$2::uuid,claim_expires_at=now()+interval '30 seconds',
    claim_phase=jsonb_build_object('phase','preparing','claimed_at',now()::text,'since',now()::text,'token',$2::text),created_at=now()-interval '39 hours'
    WHERE id=$1::uuid`, [dbOnly.id, dbOnlyToken]);
  const dbOnlyCheck = await writeStallCheck(engine);
  expect(dbOnlyCheck.status).toBe('warn');
  expect(dbOnlyCheck.details).toMatchObject({ stalls: [{ request_id: dbOnly.request_id, source_id: sources[1]!.id, root: null }] });
  expect(dbOnlyCheck.message).toContain('root database-only');
  // A worktree request's completion on the same source is not progress of the database-only root.
  const worktreeDone = await admitWrite(engine, admission(config, sources[1]!, 'stall/worktree-done', 'worktree body'));
  await engine.executeRaw(`UPDATE persistence_requests SET state='committed',completed_at=now()-interval '1 minute' WHERE id=$1::uuid`, [worktreeDone.id]);
  expect((await writeStallCheck(engine)).status).toBe('warn');
  const dbOnlyDone = await admitWrite(engine, admission(config, sources[1]!, 'stall/db-only-done', 'db-only done body'));
  await engine.executeRaw(`UPDATE persistence_requests SET state='committed',worktree_id=NULL,completed_at=now()-interval '1 minute' WHERE id=$1::uuid`, [dbOnlyDone.id]);
  expect((await writeStallCheck(engine)).status).toBe('ok');
  await engine.executeRaw('DELETE FROM persistence_requests WHERE id=ANY($1::uuid[])', [[dbOnly.id, worktreeDone.id, dbOnlyDone.id]]);

  // An owner that predates phase recording never stamps its claim: the request's own age stands in for the claim's.
  const legacy = await admitWrite(engine, admission(config, sources[1]!, 'stall/legacy', 'legacy body'));
  await engine.executeRaw(`UPDATE persistence_requests SET state='running',execution_token=$2::uuid,claim_expires_at=now()+interval '30 seconds',
    created_at=now()-interval '31 minutes' WHERE id=$1::uuid`, [legacy.id, randomUUID()]);
  // #6650: an undispatched group follower's stamp (token, owner and claim time, no phase) is aged from its claim time.
  const follower = await admitWrite(engine, admission(config, sources[0]!, 'stall/follower', 'follower body'));
  const followerToken = randomUUID();
  await engine.executeRaw(`UPDATE persistence_requests SET state='running',execution_token=$2::uuid,claim_expires_at=now()+interval '30 seconds',
    claim_phase=jsonb_build_object('token',$2::text,'owner',jsonb_build_object('kind','sync','pid',4242,'version','v'),'claimed_at',to_jsonb(now()-interval '31 minutes'))
    WHERE id=$1::uuid`, [follower.id, followerToken]);
  const old = await writeStallCheck(engine);
  expect(old.status).toBe('warn');
  expect((old.details as { stalls: Array<{ request_id: string }> }).stalls.map(s => s.request_id).sort()).toEqual([legacy.request_id, follower.request_id].sort());
  expect(old.details).toMatchObject({ stalls: expect.arrayContaining([expect.objectContaining({ request_id: legacy.request_id, phase: 'unrecorded' }),
    expect.objectContaining({ request_id: follower.request_id, phase: 'unrecorded', stall: null, owner: { kind: 'sync', pid: 4242, version: 'v' } })]) });
  expect(errors).toEqual([]);
}

function harness(kind: 'pglite' | 'postgres'): HarnessConfig {
  const root = mkdtempSync(join(tmpdir(), `gbrain-write-stall-${kind}-`)); homes.push(root);
  return { kind, root, dataDir: join(root, 'data'), hostId: randomUUID(), seed: 6176, schedules: 0, operations: 0,
    sourceIds: ['write-stall', 'write-stall-other'], principalIds: [randomUUID()] };
}

describe('PGLite', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
  afterAll(async () => { await engine.disconnect(); });
  test('a hung publication is named by writer status and doctor persistence_write_stall', async () => {
    const config = harness('pglite');
    await withEnv({ GBRAIN_HOME: config.root, GBRAIN_PERSISTENCE_FIXTURE_HOME: config.root }, async () => {
      selectFixtureHost(config.hostId);
      await initializeFixtures(engine, config);
      await scenario(engine, config);
    });
  }, 120_000);
});

describe.skipIf(!process.env.DATABASE_URL)('Postgres', () => {
  test('a hung publication is named by writer status and doctor persistence_write_stall', async () => {
    const config = harness('postgres');
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 6);
    try {
      await withEnv({ GBRAIN_HOME: config.root, GBRAIN_PERSISTENCE_FIXTURE_HOME: config.root }, async () => {
        selectFixtureHost(config.hostId);
        await initializeFixtures(pg.engine, config);
        await scenario(pg.engine, config);
      });
    } finally { await pg.close(); }
  }, 120_000);
});
