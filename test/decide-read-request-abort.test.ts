/**
 * GBRA-156 for the typed decide reads (postgres-engine.ts `decideRead`). On master these reads went through
 * `engine.executeRaw`, which refuses every statement of a request whose signal has fired (`throwIfRequestAborted`),
 * so a request nobody waits for sends no more decide queries and holds no more connections. The typed members run
 * through `preparationRead`, whose no-deadline path goes straight to the autocommit executor.
 *
 * Protects: each typed decide read, called inside a request whose signal already aborted, rejects with the request's
 * AbortError and sends no statement, exactly as `executeRaw` does.
 * Fails when `decideRead` skips the request-abort check.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

/** Every member that postgres-engine.ts routes through `decideRead`. */
const CALLS: Record<string, (engine: BrainEngine) => Promise<unknown>> = {
  readDecideState: (e) => e.readDecideState('request_abort_probe'),
  dailyDecideSpend: (e) => e.dailyDecideSpend(new Date(Date.now() - 86_400_000)),
  listDecideReceiptStats: (e) => e.listDecideReceiptStats({ sinceHours: 24 }),
  decideSlotUsage: (e) => e.decideSlotUsage(24),
  listDecideResolvedModels: (e) => e.listDecideResolvedModels(24),
  listDecideMixedModelDecisions: (e) => e.listDecideMixedModelDecisions(24),
  listDecideCalibrations: (e) => e.listDecideCalibrations({ includeRetired: true }),
};

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error('client went away'));
  return controller.signal;
}

function fakeEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return { fake, engine: engine as unknown as BrainEngine };
}

test('every decideRead member has a case', () => {
  // The engine's own runtime surface: every prototype method whose body routes through decideRead.
  const proto = PostgresEngine.prototype;
  const members = Object.getOwnPropertyNames(proto).filter(name => {
    const fn = Object.getOwnPropertyDescriptor(proto, name)?.value;
    return name !== 'constructor' && name !== 'decideRead' && typeof fn === 'function' && String(fn).includes('this.decideRead(');
  });
  expect(members.sort()).toEqual(Object.keys(CALLS).sort());
});

test('control: executeRaw refuses a statement of an aborted request and sends nothing', async () => {
  const { fake, engine } = fakeEngine();
  const error = await withRequestSignal(aborted(), () => engine.executeRaw('SELECT 1')).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements().length).toBe(0);
});

for (const [member, call] of Object.entries(CALLS)) {
  test(`${member} refuses inside an aborted request, as executeRaw did, and sends no statement`, async () => {
    const { fake, engine } = fakeEngine();
    const error = await withRequestSignal(aborted(), () => call(engine)).then(() => null, (e: unknown) => e);
    expect((error as Error | null)?.name, `${member} ran inside an aborted request`).toBe('AbortError');
    expect((error as Error).message).toBe('client went away');
    expect(fake.statements().length).toBe(0);
  });
}
