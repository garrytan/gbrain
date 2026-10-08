/**
 * #6278: writer status and doctor on a preparation past its budget. Protects:
 * a running blocker carries operation, intent_kind, preparation_attempts, the
 * claim's step, step age, waiting_on and owner process (kind, pid, build) from
 * the live stamp, the budget that applies to its kind, and, once the step is
 * older than that budget, `claim.stall { reason: 'preparation_overdue', ... }`;
 * writer status also reports the budgets, ceiling, limit and switch in effect;
 * `WRITER_NEXT_ACTIONS` has non-circular advice for `preparation_deadline` and
 * `preparation_stalled`; doctor `persistence_write_stall` prints the same
 * claim fields. Nothing here extends the wire enum (`WRITE_HEALTH_REASONS`).
 * Fails when the blocker reads `cause_unknown` without a step, when the stall
 * verdict fires for a publishing claim, or when the owner is inferred rather
 * than read from the stamp. PGLite only: the fields come from the stamp, not
 * the engine.
 */
import { afterAll, beforeAll, expect, setSystemTime, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { readWriterDiagnostics, WRITER_NEXT_ACTIONS } from '../src/core/persistence/diagnostics.ts';
import { enterClaimStep, setClaimOwnerForTest } from '../src/core/persistence/claim-phase.ts';
import { WRITE_HEALTH_REASONS } from '../src/core/persistence/types.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { writeStallCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import { admission, fixtures, initializeFixtures, prepared, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-writer-status-stall-'));
const config: HarnessConfig = { kind: 'pglite', root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
  seed: 6278, schedules: 0, operations: 0, sourceIds: ['status-stall'], principalIds: [randomUUID()] };
const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
let engine: PGLiteEngine;

beforeAll(async () => withEnv(env, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  selectFixtureHost(config.hostId);
  await initializeFixtures(engine, config);
}), 120_000);
afterAll(async () => { setSystemTime(); setClaimOwnerForTest(undefined); resetWriteSwitches(); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('the wire enum is unchanged: the overdue verdict lives on claim.stall, not on diagnostic.reason', () => {
  expect(WRITE_HEALTH_REASONS).not.toContain('preparation_overdue');
  expect(WRITE_HEALTH_REASONS).not.toContain('preparation_stalled');
  expect(WRITER_NEXT_ACTIONS.preparation_deadline).toContain('claim.stall');
  expect(WRITER_NEXT_ACTIONS.preparation_stalled).toContain('retry-held');
  expect(WRITER_NEXT_ACTIONS.preparation_stalled).not.toContain('writer status --json');
});

test('a preparing blocker names its step, wait cause, owner and budget, and turns preparation_overdue once the step outlives the budget', async () => withEnv(env, async () => {
  setClaimOwnerForTest({ kind: 'sync', pid: 4242, version: '0.60.200.0' });
  await engine.setConfig('persistence.maintenance_preparation_ms', '90000');
  resetWriteSwitches();
  const sources = await fixtures(engine, config);
  // A maintenance-kind request (intent kind set) takes the maintenance budget.
  const row = await admitWrite(engine, admission(config, sources[0]!, 'status/stuck', 'stuck body', 0, { intent: { content: 'stuck body', kind: 'managed_maintenance_page' } }));
  const hang = Promise.withResolvers<void>();
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, current, _config, _signal, clock) => {
    enterClaimStep(clock, 'adoption_read_facts', undefined, 'db');
    await hang.promise;
    return prepared(current, sources);
  }, { hostId: config.hostId, concurrency: 1, pollMs: 20, renewalIntervalMs: 20, phaseMs: 2_000, claimLeaseMs: 86_400_000,
    preparationBudgets: { maintenanceMs: 90_000, ceilingMs: 3_600_000, maxAttempts: 5 }, onError: () => {} });
  try {
    consumer.start();
    await waitFor(async () => (await engine.executeRaw<{ step: string | null }>("SELECT claim_phase->>'step' AS step FROM persistence_requests WHERE id=$1::uuid", [row.id]))[0]?.step === 'adoption_read_facts',
      { timeoutMs: 15_000, label: 'the renewal records the step' });
    const status = await readWriterDiagnostics(engine);
    expect(status.preparation_policy).toEqual({ deadlines: true, sync_preparation_ms: 120_000, maintenance_preparation_ms: 90_000, preparation_ceiling_ms: 600_000, max_preparation_attempts: 2 });
    const blocker = status.blockers.find(b => b.request_id === row.request_id)!;
    expect(blocker).toMatchObject({ operation: 'put_page', intent_kind: 'managed_maintenance_page', preparation_attempts: 0, state: 'running' });
    expect(blocker.claim).toMatchObject({ phase: 'preparing', step: 'adoption_read_facts', waiting_on: 'db', owner: { kind: 'sync', pid: 4242, version: '0.60.200.0' }, budget_ms: 90_000, stall: null });
    expect(blocker.claim?.step_age_ms).toBeGreaterThanOrEqual(0);
    expect(blocker).not.toHaveProperty('execution_token');
    // The step outlives the budget: the verdict appears on the claim; the wire diagnostic is untouched.
    const live = async () => (await engine.executeRaw<{ live: boolean }>('SELECT claim_expires_at>now() AS live FROM persistence_requests WHERE id=$1::uuid', [row.id]))[0]?.live === true;
    setSystemTime(new Date(Date.now() + 2 * 60_000));
    try {
      await waitFor(live, { timeoutMs: 10_000, label: 'a renewal under the shifted clock' });
      const overdue = (await readWriterDiagnostics(engine)).blockers.find(b => b.request_id === row.request_id)!;
      expect(overdue.claim?.stall).toEqual({ reason: 'preparation_overdue', step: 'adoption_read_facts', step_age_ms: expect.any(Number), waiting_on: 'db', budget_ms: 90_000 });
      expect(overdue.claim!.stall!.step_age_ms).toBeGreaterThanOrEqual(90_000);
      expect((WRITE_HEALTH_REASONS as readonly string[]).includes(overdue.diagnostic!.reason)).toBe(true);
      // Doctor: below max_claim_ms nothing warns; the stall fields ride along once it does.
      expect((await writeStallCheck(engine)).status).toBe('ok');
    } finally { setSystemTime(); }
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    try {
      await waitFor(live, { timeoutMs: 10_000, label: 'a renewal under the shifted clock' });
      const check = await writeStallCheck(engine);
      expect(check.status).toBe('warn');
      expect(check.details).toMatchObject({ preparation_policy: { maintenance_preparation_ms: 90_000, max_preparation_attempts: 2 },
        stalls: [{ request_id: row.request_id, phase: 'preparing', step: 'adoption_read_facts', waiting_on: 'db', owner: { kind: 'sync', pid: 4242 }, budget_ms: 90_000,
          stall: { reason: 'preparation_overdue', step: 'adoption_read_facts', waiting_on: 'db', budget_ms: 90_000 } }] });
      expect(check.message).toContain('step adoption_read_facts, waiting on db');
    } finally { setSystemTime(); }
  } finally {
    hang.resolve();
    await consumer.stop();
    await engine.executeRaw("DELETE FROM config WHERE key='persistence.maintenance_preparation_ms'");
    resetWriteSwitches();
  }
}), 60_000);
