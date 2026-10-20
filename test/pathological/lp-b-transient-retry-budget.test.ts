/**
 * Large-pages hardening (b): a managed write's transient interruptions have their own retry budget.
 *
 * 1. Protects: a statement the database ended with SQLSTATE 57014 (a statement timeout or cancel under load) is load,
 *    not a property of the write. It is counted in `transient_interruptions` against `persistence.max_transient_retries`
 *    (default 5), never in `preparation_attempts`, and each one schedules the next claim at `next_attempt_at` with a
 *    bounded exponential backoff (1 s, 2 s, 4 s, 8 s, then 15 s); a claim never takes the row before it. The interruption
 *    after the last retry ends the request `failed`/`write_interrupted` (the receipt names the interruptions, the retry
 *    limit, the key, the cause and the SQLSTATE), so the loop is bounded. Preparations cut off at their deadline keep the
 *    content-class `persistence.max_preparation_attempts` budget, and contention (55P03, 40001, 40P01) or a lost
 *    connection (CONNECTION_CLOSED, 57P01) is never counted. `persistence.preparation_deadlines false` turns the counting
 *    and the backoff off with the deadlines.
 * 2. Fails when: a 57014 charges `preparation_attempts` (v0.60.299.0: two statement cancels, at preparation or at
 *    publication, end a request `write_interrupted` for good), when the backoff is a sleep holding the claim instead of
 *    the request's own schedule, when the transient budget is unbounded, or when contention starts being counted.
 * 3. Existing coverage: test/persistence-write-interrupted.test.ts pins the charge's atomicity with the claim release,
 *    the shared group read charged once, the sync hold and the recovery route; it bounded 57014 by
 *    `max_preparation_attempts` until this change.
 * 4. Semantic injection: installFaultHook throws an error carrying the SQLSTATE at `consumer:preparing` (preparation) or
 *    `publication:before_commit` (inside the publication transaction) for the claims a test names. At
 *    `persistence:interruption_charged` (after the charge commits) the hook reads the scheduled delay
 *    (`next_attempt_at - updated_at`, both the charging transaction's now()) and then brings the row's next attempt
 *    forward, so the test counts claims, never wall time. A guard far above every bound stops injecting, so an unbounded
 *    loop ends committed (and fails the claim-count assertion) instead of hanging. PGLite always; Postgres with DATABASE_URL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { hasClaimableWrite, reclaimReleasedWrite, releaseUnpublishedClaim } from '../../src/core/persistence/journal.ts';
import { readHeadBlockers } from '../../src/core/persistence/head-blocker.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import * as budget from '../../src/core/persistence/preparation-budget.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const interruption = (code: string) => Object.assign(new Error(code === '57014' ? 'canceling statement due to statement timeout' : `database interruption ${code}`), { code });
const deadlineCut = () => Object.assign(new Error('preparation budget reached (probe)'), { code: 'preparation_deadline' });
const page = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\nBody of ${title}.\n`;
/** Far above every bound: an unbounded loop stops being interrupted here and commits, failing the claim count. */
const GUARD = 30;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const TRANSIENT_KEY = 'persistence.max_transient_retries';

test('persistence.max_transient_retries is a validated preparation-budget key (0 to 20, default 5)', () => {
  expect((budget.PREPARATION_BUDGET_CONFIG_KEYS as readonly string[]).includes(TRANSIENT_KEY)).toBe(true);
  expect(budget.validatePreparationConfigValue(TRANSIENT_KEY, '0')).toBeNull();
  expect(budget.validatePreparationConfigValue(TRANSIENT_KEY, '20')).toBeNull();
  expect(budget.validatePreparationConfigValue(TRANSIENT_KEY, '21')).toMatchObject({ message: expect.stringContaining('from 0 to 20'), example: '5' });
  expect(budget.validatePreparationConfigValue(TRANSIENT_KEY, '-1')?.message).toContain('whole number');
  expect((budget.resolvePreparationPolicy(new Map([[TRANSIENT_KEY, '99']])) as unknown as Record<string, number>).transientRetries).toBe(5);
});

type Row = { state: string; error_code: string | null; error_message: string | null; error_detail: Record<string, unknown> | null;
  preparation_attempts: number; transient_interruptions?: number; next_attempt_at?: string | null };

for (const { backend, databaseUrl } of pathologicalArms()) describe(`[${backend}] lp-b: transient interruptions have their own bounded retry budget`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-lp-b-${backend}-`));
  let n = 0;
  const context = (): OperationContext => ({ engine, config: { engine: backend, embedding_disabled: true } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' });
  const call = (params: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home },
    () => op('put_page').handler(context(), { wait_ms: 30_000, ...params })) as Promise<Record<string, any>>;
  // Read whole (to_jsonb), so a column this build added reads as absent on a build without it instead of failing the read.
  const row = async (requestId: string): Promise<Row> => (await engine.executeRaw<{ j: Row | string }>(
    'SELECT to_jsonb(r) AS j FROM persistence_requests r WHERE request_id=$1::uuid', [requestId])).map(r => typeof r.j === 'string' ? JSON.parse(r.j) as Row : r.j)[0]!;

  /**
   * `at` names where claim k (1-based, counted at consumer:preparing) is interrupted, or null to let it run. Records each
   * claim's counters as it began, and each charged interruption's scheduled delay, then brings that attempt forward.
   */
  function inject(requestId: string, at: (claim: number) => { point: 'consumer:preparing' | 'publication:before_commit'; error: () => Error } | null) {
    const seen = { claims: 0, transient: [] as number[], preparation: [] as number[], delays: [] as number[] };
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'consumer:preparing') {
        seen.claims++;
        const current = await row(requestId);
        seen.transient.push(current.transient_interruptions ?? 0);
        seen.preparation.push(current.preparation_attempts);
      }
      if (point === 'persistence:interruption_charged') {
        const [charged] = await engine.executeRaw<{ state: string; delay_ms: number | string | null }>(`SELECT state,
          round(extract(epoch FROM (next_attempt_at-updated_at))*1000) AS delay_ms FROM persistence_requests WHERE request_id=$1::uuid`, [requestId]).catch(() => []);
        if (charged?.state === 'queued' && charged.delay_ms !== null) seen.delays.push(Number(charged.delay_ms));
        await engine.executeRaw("UPDATE persistence_requests SET next_attempt_at=now() WHERE request_id=$1::uuid AND state='queued'", [requestId]).catch(() => undefined);
        return;
      }
      const fault = seen.claims <= GUARD ? at(seen.claims) : null;
      if (fault && fault.point === point) throw fault.error();
    });
    return seen;
  }

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(databaseUrl!); engine = pg.engine; closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine); await engine.disconnect(); await closePostgres?.();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
  afterEach(async () => {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("DELETE FROM config WHERE key IN ('persistence.max_transient_retries','persistence.max_preparation_attempts','persistence.preparation_deadlines')");
    resetWriteSwitches();
  });

  test('a write whose preparation hits 57014 three times, more than max_preparation_attempts (2), is retried with backoff and commits', async () => {
    const slug = `db/prep-cancel-${++n}`, requestId = randomUUID();
    const seen = inject(requestId, claim => claim <= 3 ? { point: 'consumer:preparing', error: () => interruption('57014') } : null);
    expect(await call({ slug, content: page(`Prep cancel ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    expect(seen.claims).toBe(4);
    expect(seen.transient).toEqual([0, 1, 2, 3]);
    expect(seen.preparation).toEqual([0, 0, 0, 0]);
    expect(seen.delays).toEqual(BACKOFF_MS.slice(0, 3));
    expect(await row(requestId)).toMatchObject({ state: 'committed', preparation_attempts: 0 });
  }, 180_000);

  test('a write cancelled at every publication ends write_interrupted after exactly max_transient_retries (5) retries, with the backoff scheduled on the request', async () => {
    const slug = `db/always-${++n}`, requestId = randomUUID();
    const seen = inject(requestId, () => ({ point: 'publication:before_commit', error: () => interruption('57014') }));
    const outcome = await call({ slug, content: page(`Always ${n}`), request_id: requestId }).catch(error => error as { code?: string });
    installFaultHook(undefined);
    expect(seen.claims).toBe(6);
    expect((outcome as { code?: string }).code).toBe('write_interrupted');
    expect(seen.transient).toEqual([0, 1, 2, 3, 4, 5]);
    expect(seen.preparation).toEqual([0, 0, 0, 0, 0, 0]);
    // Bounded exponential: each delay doubles up to the 15 s ceiling and is the request's next_attempt_at, not a held claim.
    expect(seen.delays).toEqual(BACKOFF_MS);
    const failed = await row(requestId);
    expect(failed).toMatchObject({ state: 'failed', error_code: 'write_interrupted', preparation_attempts: 0, transient_interruptions: 6 });
    expect(failed.error_detail).toMatchObject({ origin: 'database_interruption', cause: 'statement_cancel', sqlstate: '57014', attempts: 6, limit: 5,
      limit_key: TRANSIENT_KEY });
    expect(failed.error_message).toContain('6 time(s)');
    expect(failed.error_message).toContain(`${TRANSIENT_KEY} (5)`);
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toBeNull();
    const receipt = await withEnv({ GBRAIN_HOME: home }, () => op('get_write_request').handler(context(), { request_id: requestId })) as Record<string, unknown>;
    expect(receipt).toMatchObject({ state: 'failed', write_error: 'write_interrupted' });
    // The source keeps moving.
    expect(await call({ slug: `db/after-${n}`, content: page(`After ${n}`), request_id: randomUUID() })).toMatchObject({ state: 'committed' });
  }, 180_000);

  test('an owner pass never reclaims a released row before its backoff (reclaimReleasedWrite); once it elapses it does', async () => {
    const slug = `db/reclaim-${++n}`, requestId = randomUUID();
    const observed: { early?: unknown; due?: string | null } = {};
    let claims = 0;
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'consumer:preparing' && ++claims === 1) throw interruption('57014');
      if (point === 'persistence:interruption_charged') {
        const [queued] = await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
        observed.early = await reclaimReleasedWrite(engine, queued!.id);
        await engine.executeRaw('UPDATE persistence_requests SET next_attempt_at=now() WHERE id=$1::uuid', [queued!.id]);
        const due = await reclaimReleasedWrite(engine, queued!.id);
        observed.due = due?.state ?? null;
        if (due) await releaseUnpublishedClaim(engine, due, 'database_contention');
      }
    });
    expect(await call({ slug, content: page(`Reclaim ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    expect(observed.early).toBeNull();
    expect(observed.due).toBe('running');
    expect(claims).toBe(2);
  }, 180_000);

  test('the backoff holds no claim: until next_attempt_at the row is not claimable and its head blocker says transient_backoff; then it is claimed and commits', async () => {
    const slug = `db/held-off-${++n}`, requestId = randomUUID();
    const observed: { blocker?: unknown; claimable?: boolean; reclaimedAfterBackoff?: boolean } = {};
    let claims = 0;
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'consumer:preparing' && ++claims === 2) {
        // The second claim's own statement time is at or after the scheduled attempt.
        const [due] = await engine.executeRaw<{ due: boolean }>('SELECT updated_at>=next_attempt_at AS due FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
        observed.reclaimedAfterBackoff = due?.due === true;
      }
      if (point === 'publication:before_commit' && claims === 1) throw interruption('57014');
      if (point === 'persistence:interruption_charged') {
        const [queued] = await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
        const hostId = localHostId();
        observed.claimable = await hasClaimableWrite(engine, hostId);
        const read = (await readHeadBlockers(engine, [queued!.id], hostId)).get(queued!.id);
        observed.blocker = read?.status === 'blocked' ? read.blocker : read;
      }
    });
    expect(await call({ slug, content: page(`Held off ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    expect(claims).toBe(2);
    expect(observed.claimable).toBe(false);
    expect(observed.blocker).toMatchObject({ predicate: 'transient_backoff', ids: [requestId], intervention: false });
    expect(observed.reclaimedAfterBackoff).toBe(true);
  }, 180_000);

  test('the cap follows persistence.max_transient_retries: 1 retry ends the write at its second interruption', async () => {
    await engine.setConfig(TRANSIENT_KEY, '1');
    resetWriteSwitches();
    const slug = `db/cap-${++n}`, requestId = randomUUID();
    const seen = inject(requestId, () => ({ point: 'publication:before_commit', error: () => interruption('57014') }));
    const outcome = await call({ slug, content: page(`Cap ${n}`), request_id: requestId }).catch(error => error as { code?: string });
    installFaultHook(undefined);
    expect(seen.claims).toBe(2);
    expect((outcome as { code?: string }).code).toBe('write_interrupted');
    expect(await row(requestId)).toMatchObject({ state: 'failed', error_code: 'write_interrupted', transient_interruptions: 2,
      error_detail: expect.objectContaining({ attempts: 2, limit: 1 }) });
  }, 180_000);

  test('statement cancels never spend the content budget: a deadline cut-off plus three 57014s still commits', async () => {
    const slug = `db/mixed-${++n}`, requestId = randomUUID();
    const seen = inject(requestId, claim => claim === 1 ? { point: 'consumer:preparing', error: deadlineCut }
      : claim <= 4 ? { point: 'publication:before_commit', error: () => interruption('57014') } : null);
    expect(await call({ slug, content: page(`Mixed ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    expect(seen.claims).toBe(5);
    expect(seen.preparation).toEqual([0, 1, 1, 1, 1]);
    expect(seen.transient).toEqual([0, 0, 1, 2, 3]);
  }, 180_000);

  test('content-class counting is unchanged: deadline cut-offs end the write preparation_stalled at max_preparation_attempts, with no transient charge', async () => {
    const slug = `db/deadline-${++n}`, requestId = randomUUID();
    const seen = inject(requestId, () => ({ point: 'consumer:preparing', error: deadlineCut }));
    const outcome = await call({ slug, content: page(`Deadline ${n}`), request_id: requestId }).catch(error => error as { code?: string });
    installFaultHook(undefined);
    expect(seen.claims).toBe(2);
    expect((outcome as { code?: string }).code).toBe('preparation_stalled');
    expect(seen.transient).toEqual([0, 0]);
    expect(seen.delays).toEqual([]);
    expect(await row(requestId)).toMatchObject({ state: 'failed', error_code: 'preparation_stalled', preparation_attempts: 2, transient_interruptions: 0 });
  }, 180_000);

  for (const code of ['55P03', '40001', '40P01', 'CONNECTION_CLOSED', '57P01']) test(`contention or a lost connection (${code}) is never counted: past both limits the write commits with no backoff`, async () => {
    const slug = `db/contention-${++n}`, requestId = randomUUID();
    const seen = inject(requestId, claim => claim <= 6 ? { point: 'publication:before_commit', error: () => interruption(code) } : null);
    expect(await call({ slug, content: page(`Contention ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    expect(seen.claims).toBe(7);
    expect(seen.transient).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(seen.preparation).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(seen.delays).toEqual([]);
    expect(await row(requestId)).toMatchObject({ state: 'committed', next_attempt_at: null });
  }, 180_000);

  test('persistence.preparation_deadlines false turns the counting and the backoff off with the deadlines (the pre-#6278 uncounted release)', async () => {
    await engine.setConfig('persistence.preparation_deadlines', 'false');
    resetWriteSwitches();
    const slug = `db/switch-off-${++n}`, requestId = randomUUID();
    const seen = inject(requestId, claim => claim <= 7 ? { point: 'publication:before_commit', error: () => interruption('57014') } : null);
    expect(await call({ slug, content: page(`Switch off ${n}`), request_id: requestId })).toMatchObject({ state: 'committed' });
    expect(seen.claims).toBe(8);
    expect(seen.transient).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(seen.delays).toEqual([]);
  }, 180_000);
});
