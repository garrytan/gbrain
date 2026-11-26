/**
 * A request that was cancelled before its open-loop call must not send the call.
 *
 * Protects: upsertOpenLoop, closeOpenLoop and listOpenLoops in src/core/loops/loops-store.ts. On master they ran through
 * `executeRaw`, which refuses a request whose signal has already fired (`throwIfRequestAborted`); they now call typed
 * engine members, which do not, so loops-store.ts makes the check before the member is called.
 * Fails when: any of the three loops-store functions reaches the engine member under an aborted `withRequestSignal`
 * (the cancelled request would still write or read a loop), or answers instead of rejecting with an AbortError.
 * Existing coverage: none; no test ran a loop call under an aborted request signal.
 * Seam: real engines. The engine's loop member is wrapped to count calls, so "zero calls" means no statement was sent, and
 * the loop rows are read back afterwards. A control call under a live signal shows the wrapper does count.
 *
 * Engines: PGLite always; Postgres too when DATABASE_URL is set (listed in test/postgres-unit-arms.txt); the Rust engine
 * with GBRAIN_TEST_RUST_ARM=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { closeOpenLoop, listOpenLoops, upsertOpenLoop, type OpenLoopUpsert } from '../src/core/loops/loops-store.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { createSource } from './engine-parity/harness.ts';
import { openRustBrain, removeBrainDir, rustArmRequested } from './engine-parity/rust-arm.ts';

const T1 = '2026-01-01T00:00:00.000Z';

function loop(sourceId: string): OpenLoopUpsert {
  return {
    sourceId, dedupKey: 'thread:abort', loopType: 'unanswered_inbound', counterpartySlug: 'people/alice-example',
    counterpartyEmail: 'alice@example.com', summary: 'asked', evidence: [{ message_id: 'm1', quote: 'hi' }], threadId: 't-abort',
    detector: 'deterministic_thread', lastActivityAt: T1, openedAt: T1,
  };
}

type Member = 'upsertOpenLoop' | 'closeOpenLoop' | 'listOpenLoops';

/** Counts the calls that reach the engine's loop members while `fn` runs. */
async function countMemberCalls<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<{ calls: Record<Member, number>; result: PromiseSettledResult<T> }> {
  const calls: Record<Member, number> = { upsertOpenLoop: 0, closeOpenLoop: 0, listOpenLoops: 0 };
  const target = engine as unknown as Record<Member, (...args: unknown[]) => unknown>;
  const originals = {} as Record<Member, (...args: unknown[]) => unknown>;
  for (const m of Object.keys(calls) as Member[]) {
    originals[m] = target[m];
    target[m] = function (this: unknown, ...args: unknown[]) { calls[m]++; return originals[m].apply(engine, args); };
  }
  try {
    const [result] = await Promise.allSettled([fn()]);
    return { calls, result };
  } finally {
    for (const m of Object.keys(calls) as Member[]) target[m] = originals[m];
  }
}

const aborted = (): AbortSignal => { const c = new AbortController(); c.abort(new Error('client went away')); return c.signal; };

function defineCases(label: string, engineOf: () => BrainEngine, sourceIdOf: () => string): void {
  describe(`loop members stop a cancelled request before sending anything (${label})`, () => {
    test('upsertOpenLoop under an aborted request signal rejects with AbortError and sends nothing', async () => {
      const engine = engineOf();
      const { calls, result } = await countMemberCalls(engine, () => withRequestSignal(aborted(), () => upsertOpenLoop(engine, loop(sourceIdOf()))));
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason?.name).toBe('AbortError');
      expect(calls).toEqual({ upsertOpenLoop: 0, closeOpenLoop: 0, listOpenLoops: 0 });
      expect(await listOpenLoops(engine, { sourceIds: [sourceIdOf()] })).toEqual([]);
    });

    test('closeOpenLoop and listOpenLoops under an aborted request signal reject with AbortError and send nothing', async () => {
      const engine = engineOf();
      const made = await upsertOpenLoop(engine, { ...loop(sourceIdOf()), dedupKey: 'thread:abort-close' });
      const runs: Array<() => Promise<unknown>> = [
        () => closeOpenLoop(engine, sourceIdOf(), made.id, 'done', 'test'),
        () => listOpenLoops(engine, { sourceIds: [sourceIdOf()] }),
      ];
      for (const run of runs) {
        const { calls, result } = await countMemberCalls(engine, () => withRequestSignal(aborted(), run));
        expect(result.status).toBe('rejected');
        expect((result as PromiseRejectedResult).reason?.name).toBe('AbortError');
        expect(calls).toEqual({ upsertOpenLoop: 0, closeOpenLoop: 0, listOpenLoops: 0 });
      }
      const rows = await listOpenLoops(engine, { sourceIds: [sourceIdOf()] });
      expect(rows.map(r => r.status)).toEqual(['open']);
    });

    test('control: under a live request signal the same calls reach the members', async () => {
      const engine = engineOf();
      const live = new AbortController();
      const { calls, result } = await countMemberCalls(engine, () => withRequestSignal(live.signal, async () => {
        const made = await upsertOpenLoop(engine, { ...loop(sourceIdOf()), dedupKey: 'thread:abort-control' });
        await listOpenLoops(engine, { sourceIds: [sourceIdOf()] });
        return closeOpenLoop(engine, sourceIdOf(), made.id, 'done', 'test');
      }));
      expect(result.status).toBe('fulfilled');
      expect(calls).toEqual({ upsertOpenLoop: 1, closeOpenLoop: 1, listOpenLoops: 1 });
    });
  });
}

for (const kind of testBackends()) {
  describe(`arm ${kind}`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 2);
        engine = pg.engine;
        close = pg.close;
      } else {
        const e = new PGLiteEngine();
        await e.connect({ engine: 'pglite' } as never);
        await e.initSchema();
        engine = e;
        close = () => e.disconnect();
      }
      await createSource(engine, kind, 'abortsrc');
    }, 120_000);
    afterAll(async () => { await close(); });
    defineCases(kind, () => engine, () => 'abortsrc');
  });
}

describe.skipIf(!rustArmRequested())('rust', () => {
  let rust: BrainEngine;
  let dir: string;
  beforeAll(async () => {
    const opened = await openRustBrain();
    rust = opened.engine as unknown as BrainEngine;
    dir = opened.dir;
    await createSource(rust, 'rust', 'abortsrc');
  }, 120_000);
  afterAll(async () => {
    await rust.disconnect();
    removeBrainDir(dir);
  });
  defineCases('rust', () => rust, () => 'abortsrc');
});
