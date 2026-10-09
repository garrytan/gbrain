/**
 * #6355: the consumer's warm lane is one reserved backend. When the session under a lent transaction drops (a pooler or
 * failover killed it), every later use of the reservation fails the same way ("Connection is no longer owned"), so the lane
 * is given up as soon as a lent transaction reports a connection loss, whatever the lender makes of the error. Before the
 * fix, the lane was kept whenever `run` ended in an OperationError (admission turning the loss into a typed outcome) or
 * succeeded by other means, and the next write hit the dead reservation again.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { LANE_BUSY, PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const dropped = () => Object.assign(new Error('CONNECTION_CLOSED: Connection is no longer owned'), { code: 'CONNECTION_CLOSED' });

/** A postgres-shaped engine whose idle pool lends one reserved connection; `released` counts the reservations handed back. */
function laneEngine() {
  const state = { reserved: 0, released: 0, transactions: 0 };
  const engine = {
    kind: 'postgres',
    async executeRaw(sql: string) { return sql.startsWith('SELECT key,value FROM config') ? [] : []; },
    getPoolDiagnostics: () => ({ poolMax: 8, tracked: {}, poisonedDiscards: 0, pool: null, prepare: null }),
    async withReservedConnection(fn: (conn: unknown) => Promise<unknown>) {
      state.reserved++;
      try {
        return await fn({ executeRaw: async () => [], transaction: async <T>(run: (tx: BrainEngine) => Promise<T>) => { state.transactions++; return run(engine as unknown as BrainEngine); } });
      } finally { state.released++; }
    },
  };
  return { engine: engine as unknown as BrainEngine, state };
}
const consumerOf = (engine: BrainEngine) => new PersistenceConsumer(engine, {} as GBrainConfig, (async () => { throw new Error('unused'); }) as never, { hostId: 'lane-test' });

test('onLane lends its lane transaction and keeps the lane when the run succeeds on it', async () => {
  resetWriteSwitches();
  const { engine, state } = laneEngine();
  const consumer = consumerOf(engine);
  expect(await consumer.onLane(async transaction => transaction(async () => 'ran'))).toBe('ran');
  expect(state).toEqual({ reserved: 1, released: 0, transactions: 1 });
  expect(await consumer.onLane(async transaction => transaction(async () => 'again'))).toBe('again');
  expect(state).toEqual({ reserved: 1, released: 0, transactions: 2 });
});

test('forced probe: a lent transaction that lost its session gives the lane up even when the run turns the loss into a typed outcome or succeeds elsewhere', async () => {
  for (const ending of ['typed', 'succeeded'] as const) {
    resetWriteSwitches();
    const { engine, state } = laneEngine();
    const consumer = consumerOf(engine);
    const outcome = await consumer.onLane(async transaction => {
      await transaction(async () => { throw dropped(); }).catch(() => undefined);
      if (ending === 'typed') throw new OperationError('write_outcome_unknown', 'unknown', 'read the id');
      return 'admitted on the pool';
    }).then(value => ({ value }), error => ({ error: (error as OperationError).code }));
    expect(outcome).toEqual(ending === 'typed' ? { error: 'write_outcome_unknown' } : { value: 'admitted on the pool' });
    // The dead reservation went back to the pool, and the lane is not retaken for a minute.
    expect(state).toEqual({ reserved: 1, released: 1, transactions: 1 });
    expect(await consumer.onLane(async transaction => transaction(async () => 'late'))).toBe(LANE_BUSY);
    expect(state.reserved).toBe(1);
  }
});
