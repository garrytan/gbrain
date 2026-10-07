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
  // An owner that predates phase recording never stamps its claim: the request's own age stands in for the claim's.
  const legacy = await admitWrite(engine, admission(config, sources[1]!, 'stall/legacy', 'legacy body'));
  await engine.executeRaw(`UPDATE persistence_requests SET state='running',execution_token=$2::uuid,claim_expires_at=now()+interval '30 seconds',
    created_at=now()-interval '31 minutes' WHERE id=$1::uuid`, [legacy.id, randomUUID()]);
  const old = await writeStallCheck(engine);
  expect(old.status).toBe('warn');
  expect(old.details).toMatchObject({ stalls: [{ request_id: legacy.request_id, phase: 'unrecorded' }] });
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
