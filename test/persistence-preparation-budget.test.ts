/**
 * #6278: the preparation budget family (preparation-budget.ts) and its kill
 * switch (switches.ts). Protects: the per-kind budget table, the config key
 * ranges and the ceiling rule (ceiling >= larger budget + 30 s) as `config set`
 * and the snapshot resolve them, the default-on `preparation_deadlines`
 * switch, and `racePreparation`, which yields the deadline whether or not the
 * preparer honours its signal and never lets a late result through. Fails
 * when a key silently falls back without validation, when the switch reads
 * off by default, or when a signal-ignoring preparer outlives its budget.
 * Why not covered elsewhere: the consumer suites drive whole writes; these
 * pin the table and the race in milliseconds with no datastore.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_PREPARATION_POLICY, PREPARATION_BUDGET_KEYS, PREPARATION_DEADLINE, preparationBudgetMs, preparationKind, racePreparation,
  resolvePreparationPolicy, startPreparation, validatePreparationConfigValue } from '../src/core/persistence/preparation-budget.ts';
import { readPreparationPolicy, readWriteSwitches, resetWriteSwitches, WRITE_SWITCHES } from '../src/core/persistence/switches.ts';
import { withEnv } from './helpers/with-env.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('budget table', () => {
  const policy = { ...DEFAULT_PREPARATION_POLICY, syncMs: 1111, maintenanceMs: 2222 };
  test('remember and intent-less put_page/edit_page keep the foreground budget', () => {
    for (const row of [{ operation: 'remember', intent: null }, { operation: 'put_page', intent: {} }, { operation: 'edit_page', intent: null }]) {
      expect(preparationKind(row)).toBe('foreground');
      expect(preparationBudgetMs(row, policy, 30_000)).toBe(30_000);
    }
  });
  test('managed sync members take the sync budget; maintenance and every other kind the maintenance budget', () => {
    expect(preparationBudgetMs({ operation: 'submit_job', intent: { kind: 'managed_sync_import' } }, policy, 30_000)).toBe(1111);
    expect(preparationBudgetMs({ operation: 'submit_job', intent: { kind: 'managed_sync_checkpoint' } }, policy, 30_000)).toBe(1111);
    expect(preparationBudgetMs({ operation: 'submit_job', intent: { kind: 'managed_maintenance_adopt_fact_fence' } }, policy, 30_000)).toBe(2222);
    expect(preparationBudgetMs({ operation: 'put_page', intent: { kind: 'canonical_reconcile' } }, policy, 30_000)).toBe(2222);
    expect(preparationBudgetMs({ operation: 'takes_add', intent: null }, policy, 30_000)).toBe(2222);
  });
});

describe('config key family', () => {
  test('defaults: 120 s budgets, 600 s ceiling, 2 attempts', () => {
    expect(resolvePreparationPolicy(new Map())).toEqual({ syncMs: 120_000, maintenanceMs: 120_000, ceilingMs: 600_000, maxAttempts: 2 });
  });
  test('configured values are read; invalid ones keep their default; the ceiling floors at the larger budget plus 30 s', () => {
    const policy = resolvePreparationPolicy(new Map([
      [PREPARATION_BUDGET_KEYS.syncMs, '300000'], [PREPARATION_BUDGET_KEYS.maintenanceMs, 'abc'],
      [PREPARATION_BUDGET_KEYS.ceilingMs, '60000'], [PREPARATION_BUDGET_KEYS.maxAttempts, '3']]));
    expect(policy).toEqual({ syncMs: 300_000, maintenanceMs: 120_000, ceilingMs: 330_000, maxAttempts: 3 });
    expect(resolvePreparationPolicy(new Map([[PREPARATION_BUDGET_KEYS.maxAttempts, '11']])).maxAttempts).toBe(2);
  });
  test('config set refuses out-of-range values with the range and example, and ignores other keys', () => {
    expect(validatePreparationConfigValue('persistence.max_claim_ms', 'anything')).toBeNull();
    expect(validatePreparationConfigValue(PREPARATION_BUDGET_KEYS.syncMs, '120000')).toBeNull();
    expect(validatePreparationConfigValue(PREPARATION_BUDGET_KEYS.maxAttempts, '0')).toMatchObject({ message: expect.stringContaining('from 1 to 10'), example: '2' });
    expect(validatePreparationConfigValue(PREPARATION_BUDGET_KEYS.maxAttempts, '2.5')?.message).toContain('whole number');
    expect(validatePreparationConfigValue(PREPARATION_BUDGET_KEYS.ceilingMs, '59999')?.message).toContain('from 60000 to 3600000');
    expect(validatePreparationConfigValue(PREPARATION_BUDGET_KEYS.ceilingMs, '3600001')?.message).toContain('Nothing was written');
  });
  test('the ceiling must stay at least the larger budget plus 30 s, checked across the sibling keys', () => {
    expect(validatePreparationConfigValue(PREPARATION_BUDGET_KEYS.ceilingMs, '149999')).toMatchObject({ example: '150000' });
    expect(validatePreparationConfigValue(PREPARATION_BUDGET_KEYS.ceilingMs, '150000')).toBeNull();
    const others = new Map([[PREPARATION_BUDGET_KEYS.ceilingMs, '200000']]);
    expect(validatePreparationConfigValue(PREPARATION_BUDGET_KEYS.syncMs, '170000', others)).toBeNull();
    expect(validatePreparationConfigValue(PREPARATION_BUDGET_KEYS.syncMs, '170001', others)?.suggestion).toContain(`gbrain config set ${PREPARATION_BUDGET_KEYS.ceilingMs} 200001`);
    expect(validatePreparationConfigValue(PREPARATION_BUDGET_KEYS.maintenanceMs, '600000')?.message).toContain('600000');
  });
});

describe('preparation_deadlines switch', () => {
  afterEach(() => resetWriteSwitches());
  const engineWith = (rows: Array<{ key: string; value: string }>) => ({ executeRaw: async () => rows as never[] });
  test('is on by default, off through config or environment, and shares the budget snapshot', async () => {
    expect(WRITE_SWITCHES.preparation_deadlines).toEqual({ key: 'persistence.preparation_deadlines', env: 'GBRAIN_PREPARATION_DEADLINES' });
    const engine = engineWith([{ key: PREPARATION_BUDGET_KEYS.syncMs, value: '5000' }]);
    expect((await readWriteSwitches(engine)).preparation_deadlines).toBe(true);
    expect(await readPreparationPolicy(engine)).toMatchObject({ syncMs: 5000, maintenanceMs: 120_000 });
    resetWriteSwitches();
    expect((await readWriteSwitches(engineWith([{ key: 'persistence.preparation_deadlines', value: 'false' }]))).preparation_deadlines).toBe(false);
    resetWriteSwitches();
    await withEnv({ GBRAIN_PREPARATION_DEADLINES: '0' }, async () => {
      expect((await readWriteSwitches(engineWith([]))).preparation_deadlines).toBe(false);
    });
  });
  test('a failed snapshot read leaves the defaults in effect', async () => {
    const failing = { executeRaw: async () => { throw new Error('connection reset'); } };
    expect(await readPreparationPolicy(failing)).toEqual(DEFAULT_PREPARATION_POLICY);
  });
});

describe('startPreparation / racePreparation', () => {
  test('a preparation inside its budget yields its result and never aborts', async () => {
    let signal: AbortSignal | undefined;
    const raced = await racePreparation(async s => { signal = s; await sleep(10); return 'prepared'; }, 500);
    expect(raced).toEqual({ result: 'prepared' });
    expect(signal?.aborted).toBe(false);
  });
  test('a preparer that honours its signal is cut off at the budget: the deadline wins, not its abort rejection', async () => {
    const run = startPreparation(async signal => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), 20);
    expect(await run.outcome).toEqual({ deadline: PREPARATION_DEADLINE });
    expect(run.expired).toBe(true);
    await expect(run.work).rejects.toMatchObject({ code: 'preparation_deadline' });
  });
  test('a preparer that ignores its signal is cut off at the budget too, and its late result is left to the caller', async () => {
    const release = Promise.withResolvers<string>();
    let seen = 0;
    const started = performance.now();
    const run = startPreparation(async () => release.promise, 20, { onDeadline: () => { seen++; } });
    expect(await run.outcome).toEqual({ deadline: PREPARATION_DEADLINE });
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
    expect(run.signal.aborted).toBe(true);
    expect(seen).toBe(1);
    release.resolve('late');
    expect(await run.work).toBe('late');
  });
  test('a synchronous preparation that outruns the timer still reads as a deadline (resolve and reject)', async () => {
    for (const reject of [false, true]) {
      const raced = await racePreparation(async () => {
        const until = performance.now() + 40;
        while (performance.now() < until) { /* busy */ }
        if (reject) throw new DOMException('late', 'AbortError');
        return 'late';
      }, 10);
      expect(raced).toEqual({ deadline: PREPARATION_DEADLINE });
    }
  });
  test('a real failure inside the budget propagates; without a budget the outcome follows the work', async () => {
    await expect(racePreparation(async () => { throw new Error('boom'); }, 500)).rejects.toThrow('boom');
    const unbounded = startPreparation(async () => { await sleep(30); return 'done'; }, undefined);
    expect(unbounded.late()).toBe(false);
    expect(await unbounded.outcome).toEqual({ result: 'done' });
    expect(unbounded.expired).toBe(false);
  });
  test('abort(reason) cancels the preparer with that reason and the outcome follows the work, not the deadline', async () => {
    const run = startPreparation(async signal => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), 5_000);
    run.abort({ code: 'consumer_stopping' });
    await expect(run.outcome).rejects.toMatchObject({ code: 'consumer_stopping' });
    expect(run.expired).toBe(false);
  });
});
