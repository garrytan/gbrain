/** #8651: the preparation deadline covers pool wait, read envelope and trailing COMMIT. */
import { expect, test } from 'bun:test';
import postgres from '#postgres';
import { runDeadlineRead } from '../src/core/postgres-engine/bounded-statement.ts';
import { CheckoutGauge } from '../src/core/pool-gauge.ts';
import { boundedReads, PreparationDeadlineError } from '../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import type { BrainEngine } from '../src/core/engine.ts';

type Sql = ReturnType<typeof postgres>;
function fixture(options: { reserve?: Promise<unknown>; open?: Promise<unknown>; commit?: Promise<unknown> } = {}) {
  const commands: string[] = [];
  let releases = 0, discards = 0;
  const reserved = {
    release: () => { releases++; }, discard: () => { discards++; },
    unsafe: (sql: string) => {
      commands.push(sql);
      const query = { simple: () => query, execute: () => sql === 'COMMIT' ? options.commit ?? Promise.resolve([]) : options.open ?? Promise.resolve([]) };
      return query;
    },
  };
  const conn = { reserve: () => options.reserve ?? Promise.resolve(reserved) } as unknown as Sql;
  return { conn, reserved, commands, counts: () => ({ releases, discards }), gauge: new CheckoutGauge() };
}
const never = () => new Promise<never>(() => {});
async function within<T>(promise: Promise<T>, ms = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline did not settle')), ms); })]); }
  finally { clearTimeout(timer!); }
}

test('a saturated pool settles at the deadline; a late reservation is released without BEGIN or callback', async () => {
  const gate = Promise.withResolvers<unknown>();
  const f = fixture({ reserve: gate.promise });
  let calls = 0;
  const outcome = await within(runDeadlineRead(f.conn, Date.now() + 30, async () => { calls++; }, f.gauge).catch(error => error));
  gate.resolve(f.reserved);
  await Bun.sleep(0);
  expect(outcome).toMatchObject({ code: 'read_deadline' });
  expect(calls).toBe(0);
  expect(f.commands).toEqual([]);
  expect(f.counts()).toEqual({ releases: 1, discards: 0 });
  expect(f.gauge.snapshot().reserved).toBe(0);
});

test('an already expired read never checks out or runs', async () => {
  const f = fixture();
  let calls = 0;
  await expect(runDeadlineRead(f.conn, Date.now() - 1, async () => { calls++; }, f.gauge)).rejects.toMatchObject({ code: 'read_deadline' });
  expect(calls).toBe(0);
  expect(f.commands).toEqual([]);
  expect(f.counts()).toEqual({ releases: 0, discards: 0 });
  expect(f.gauge.snapshot().reserved).toBe(0);
});

test('an expired engine-internal read becomes preparation_deadline, not an unrelated storage error', async () => {
  const f = fixture({ reserve: never() });
  const clock = startClaimPhase(Date.now(), undefined, 30);
  const engine = { kind: 'postgres', getConfig: () => runDeadlineRead(f.conn, clock.deadlineAt!, async () => 'unused', f.gauge) } as unknown as BrainEngine;
  const result = await within(boundedReads(engine, clock, { engineReads: true }).getConfig('unused').catch(error => error));
  expect(result).toBeInstanceOf(PreparationDeadlineError);
  expect(result.code).toBe('preparation_deadline');
  expect(f.gauge.snapshot().reserved).toBe(0);
});

test('stuck BEGIN and stuck callbacks are discarded at the absolute deadline without leaking the gauge', async () => {
  for (const stage of ['open', 'read']) {
    const f = fixture(stage === 'open' ? { open: never() } : {});
    const result = await within(runDeadlineRead(f.conn, Date.now() + 30, async () => stage === 'read' ? never() : 'answer', f.gauge).catch(error => error));
    expect(result).toMatchObject({ code: 'read_deadline' });
    expect(f.counts()).toEqual({ releases: 0, discards: 1 });
    expect(f.gauge.snapshot().reserved).toBe(0);
  }
});

test('a healthy read answers before COMMIT, but a stuck trailing COMMIT loses its socket and gauge slot at the deadline', async () => {
  const commit = Promise.withResolvers<unknown>();
  const f = fixture({ commit: commit.promise });
  expect(await runDeadlineRead(f.conn, Date.now() + 40, async () => 'answer', f.gauge)).toBe('answer');
  expect(f.gauge.snapshot().reserved).toBe(1);
  await Bun.sleep(80);
  expect(f.counts()).toEqual({ releases: 0, discards: 1 });
  expect(f.gauge.snapshot().reserved).toBe(0);
  commit.resolve([]);
  await Bun.sleep(0);
  expect(f.counts()).toEqual({ releases: 0, discards: 1 });
});

test('ordinary results and failures retain their identity and release exactly once after cleanup', async () => {
  for (const failed of [false, true]) {
    const f = fixture();
    const error = new Error('read failure');
    const result = await runDeadlineRead(f.conn, Date.now() + 1000, async () => { if (failed) throw error; return 'answer'; }, f.gauge).catch(e => e);
    await Bun.sleep(0);
    expect(result).toBe(failed ? error : 'answer');
    expect(f.commands.at(-1)).toBe('COMMIT');
    expect(f.counts()).toEqual({ releases: 1, discards: 0 });
    expect(f.gauge.snapshot().reserved).toBe(0);
  }
});
