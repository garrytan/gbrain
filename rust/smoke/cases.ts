/**
 * The addon proofs. Each case takes the loaded addon and throws if the behavior is wrong.
 * `run.ts` runs all of them under Bun; `selfcheck.ts` runs the ones in `compiledCases` inside a
 * `bun build --compile` executable.
 */
import assert from 'node:assert/strict';
import type { Addon, Pool } from './addon.ts';

export interface Case {
  name: string;
  run(addon: Addon): Promise<void> | void;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Wait until `check` holds, for at most `ms`. */
async function until(what: string, check: () => boolean, ms = 5000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new assert.AssertionError({ message: `timed out waiting for ${what}` });
    await sleep(5);
  }
}

/** The error a synchronous call throws. */
function thrown(call: () => unknown): Error & Record<string, unknown> {
  try {
    call();
  } catch (error) {
    assert.ok(error instanceof Error, 'throws must be real Error objects');
    return error as Error & Record<string, unknown>;
  }
  throw new assert.AssertionError({ message: 'expected the call to throw' });
}

/** Await a promise that must reject, and return the rejection. */
async function rejection(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error, 'rejections must be real Error objects');
    return error as Error & Record<string, unknown>;
  }
  throw new assert.AssertionError({ message: 'expected the promise to reject' });
}

export const cases: Case[] = [
  {
    name: 'metadata: target, abi, build hash, catalog version, format versions',
    run(addon) {
      assert.match(addon.target, /^(linux|darwin|win32)-(x64|arm64)(-(glibc|musl))?$/);
      assert.equal(addon.engineAbi, 1);
      assert.match(addon.engineBuild, /^[0-9a-f]{64}$/);
      assert.equal(addon.catalogVersion, 0);
      assert.deepEqual(addon.formatVersions, []);
    },
  },
  {
    name: 'event loop stays free: a timer fires while a native task runs',
    async run(addon) {
      const pool = new addon.Pool(2);
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      const startedAt = performance.now();
      try {
        assert.equal(await pool.blockFor(300), 300);
      } finally {
        clearInterval(timer);
      }
      assert.ok(performance.now() - startedAt >= 290, 'the task waited for its full time');
      // A blocked loop would give 0 or 1 ticks. 300 ms at 10 ms is about 30; allow a lot of slack.
      assert.ok(ticks >= 10, `timer fired only ${ticks} times during a 300 ms native task`);
      await pool.shutdown(1000);
    },
  },
  {
    name: 'typed arrays: sync sum, scale, in-place scale, offset views, empty array',
    run(addon) {
      assert.equal(addon.sumF32(new Float32Array([1, 2, 3.5])), 6.5);
      const input = new Float32Array([1, 2, 3]);
      const scaled = addon.scaleF32(input, 2);
      assert.deepEqual([...scaled], [2, 4, 6]);
      assert.deepEqual([...input], [1, 2, 3], 'scaleF32 leaves its input alone');
      assert.notEqual(scaled.buffer, input.buffer, 'scaleF32 returns a new array');
      const mutable = new Float32Array([1, 2, 3]);
      assert.equal(addon.scaleInPlaceF32(mutable, 3), 3);
      assert.deepEqual([...mutable], [3, 6, 9], 'scaleInPlaceF32 writes into the caller array');
      const window = new Float32Array([5, 1, 2, 5]);
      addon.scaleInPlaceF32(window.subarray(1, 3), 10);
      assert.deepEqual([...window], [5, 10, 20, 5], 'an offset view only touches its own window');
      // A view into the middle of a larger buffer must read only its own window.
      const backing = new Float32Array([100, 100, 1, 2, 3, 100]);
      assert.equal(addon.sumF32(backing.subarray(2, 5)), 6);
      assert.equal(addon.sumF32(new Float32Array(0)), 0);
      assert.equal(addon.scaleF32(new Float32Array(0), 3).length, 0);
    },
  },
  {
    name: 'typed arrays: async calls copy the input before returning',
    async run(addon) {
      const pool = new addon.Pool(1);
      // Occupy the only worker so the sum is still queued when the array changes below.
      const busy = pool.blockFor(100);
      const values = new Float32Array([1, 2, 3]);
      const sum = pool.sumF32(values);
      const scaled = pool.scaleF32(values, 10);
      values.fill(1000);
      assert.equal(await sum, 6, 'the sum used the values at call time');
      assert.deepEqual([...(await scaled)], [10, 20, 30]);
      await busy;
      assert.equal(await pool.sumF32(new Float32Array(0)), 0);
      await pool.shutdown(1000);
    },
  },
  {
    name: 'panics: a sync panic is a typed Error and the process keeps working',
    run(addon) {
      let caught: (Error & Record<string, unknown>) | undefined;
      try {
        addon.probePanicSync();
      } catch (error) {
        caught = error as Error & Record<string, unknown>;
      }
      assert.ok(caught instanceof Error);
      assert.equal(caught.code, 'internal_error');
      assert.match(String(caught.diagnosticId), /^gbrain-\d+-\d+$/);
      assert.ok(!caught.message.includes('on purpose'), 'the panic text must not reach callers');
      assert.equal(addon.sumF32(new Float32Array([4])), 4, 'the next call still works');
    },
  },
  {
    name: 'panics: an async panic rejects, and the same pool runs the next task',
    async run(addon) {
      const pool = new addon.Pool(1);
      const error = await rejection(pool.probePanic());
      assert.equal(error.code, 'internal_error');
      assert.match(String(error.diagnosticId), /^gbrain-\d+-\d+$/);
      assert.equal(await pool.sumF32(new Float32Array([1, 2])), 3, 'the only worker survived');
      assert.equal(pool.state, 'running');
      await pool.shutdown(1000);
    },
  },
  {
    name: 'cancellation: a token cancelled after start rejects with completedSteps',
    async run(addon) {
      const pool = new addon.Pool(1);
      const token = new addon.CancelToken();
      const controller = new AbortController();
      // The mapping the TypeScript wrapper will use for AbortSignal.
      controller.signal.addEventListener('abort', () => token.cancel());
      const task = pool.runSteps(200, 10, token);
      await sleep(80);
      controller.abort();
      const error = await rejection(task);
      assert.equal(error.code, 'cancelled');
      assert.equal(error.started, true);
      const done = error.completedSteps as number;
      assert.ok(done > 0 && done < 200, `completedSteps was ${done}`);
      assert.equal(token.cancelled, true);
      // Not cancelled: runs to the end.
      assert.equal(await pool.runSteps(3, 5, new addon.CancelToken()), 3);
      // Cancelled before it starts: rejects with started=false and zero steps.
      const early = new addon.CancelToken();
      early.cancel();
      const earlyError = await rejection(pool.runSteps(5, 5, early));
      assert.equal(earlyError.code, 'cancelled');
      assert.equal(earlyError.completedSteps, 0);
      await pool.shutdown(1000);
    },
  },
  {
    name: 'shutdown: queued tasks cancel, running tasks are awaited, later calls reject',
    async run(addon) {
      const pool = new addon.Pool(1);
      const running = pool.blockFor(300);
      const queuedA = rejection(pool.blockFor(10));
      const queuedB = rejection(pool.blockFor(10));
      await until('the first task to start', () => pool.running === 1);
      assert.equal(pool.running, 1);
      assert.equal(pool.queued, 2);
      const startedAt = performance.now();
      const report = await pool.shutdown(5000);
      const waited = performance.now() - startedAt;
      assert.deepEqual(report, { cancelledQueued: 2, finishedRunning: 1, abandonedRunning: 0 });
      assert.ok(waited < 2000, `shutdown took ${waited.toFixed(0)} ms`);
      assert.equal(await running, 300, 'the running task finished normally');
      for (const error of await Promise.all([queuedA, queuedB])) {
        assert.equal(error.code, 'cancelled');
        assert.equal(error.started, false);
        assert.equal(error.completedSteps, 0);
      }
      assert.equal(pool.state, 'closed');
      assert.equal((await rejection(pool.blockFor(1))).code, 'engine_shutdown');
      assert.equal((await rejection(pool.sumF32(new Float32Array(1)))).code, 'engine_shutdown');
      // Shutting down again is allowed and reports nothing left to do.
      assert.deepEqual(await pool.shutdown(100), {
        cancelledQueued: 0,
        finishedRunning: 0,
        abandonedRunning: 0,
      });
    },
  },
  {
    name: 'shutdown: the wait is bounded when a task will not finish in time',
    async run(addon) {
      const pool: Pool = new addon.Pool(1);
      const slow = pool.blockFor(1500);
      await until('the slow task to start', () => pool.running === 1);
      const startedAt = performance.now();
      const report = await pool.shutdown(150);
      const waited = performance.now() - startedAt;
      assert.equal(report.abandonedRunning, 1);
      assert.equal(report.finishedRunning, 0);
      assert.ok(waited >= 140 && waited < 1000, `waited ${waited.toFixed(0)} ms for a 150 ms bound`);
      assert.equal(pool.state, 'closed');
      assert.equal(await slow, 1500, 'the abandoned task still settles its promise');
    },
  },
  {
    name: 'shutdown: admission closes before shutdown() returns, not when it settles',
    async run(addon) {
      const pool = new addon.Pool(1);
      const running = pool.blockFor(200);
      const queued = rejection(pool.blockFor(10));
      await until('the first task to start', () => pool.running === 1);
      const pending = pool.shutdown(5000);
      // The shutdown promise is still pending; nothing new may get in.
      assert.equal(pool.state, 'shutting_down');
      assert.equal((await rejection(pool.blockFor(1))).code, 'engine_shutdown');
      assert.equal((await rejection(pool.runSteps(1, 1))).code, 'engine_shutdown');
      assert.equal((await rejection(pool.sumF32(new Float32Array([1])))).code, 'engine_shutdown');
      assert.deepEqual(await pending, { cancelledQueued: 1, finishedRunning: 1, abandonedRunning: 0 });
      assert.equal((await queued).code, 'cancelled');
      assert.equal(await running, 200);
      assert.equal(pool.state, 'closed');
      await until('the worker to exit', () => pool.workers === 0);
    },
  },
  {
    name: 'pool: the worker count is bounded and a pool with no workers still gets one',
    async run(addon) {
      const one = new addon.Pool(0);
      assert.equal(one.workers, 1);
      assert.equal(await one.blockFor(1), 1);
      await one.shutdown(1000);
      const capped = new addon.Pool(100_000);
      assert.equal(capped.workers, 256);
      await capped.shutdown(1000);
      await until('the capped workers to exit', () => capped.workers === 0);
    },
  },
  {
    name: 'pool: a pool collected without shutdown stops its workers',
    async run(addon) {
      const collect = (globalThis as { Bun?: { gc(full: boolean): void } }).Bun?.gc;
      assert.ok(collect, 'this case runs under Bun, which can force a collection');
      const before = addon.liveWorkers();
      (() => {
        for (let i = 0; i < 8; i++) new addon.Pool(2);
      })();
      assert.equal(addon.liveWorkers(), before + 16);
      await until(
        'the collected pools to stop their workers',
        () => {
          collect(true);
          return addon.liveWorkers() <= before;
        },
        10_000,
      );
    },
  },
  {
    name: 'typed arrays: a view of a SharedArrayBuffer is refused by every entry point',
    async run(addon) {
      const shared = new Float32Array(new SharedArrayBuffer(12));
      shared.set([1, 2, 3]);
      const pool = new addon.Pool(1);
      const calls: Array<[string, () => unknown]> = [
        ['sumF32', () => addon.sumF32(shared)],
        ['scaleF32', () => addon.scaleF32(shared, 2)],
        ['scaleInPlaceF32', () => addon.scaleInPlaceF32(shared, 2)],
        ['pool.sumF32', () => pool.sumF32(shared)],
        ['pool.scaleF32', () => pool.scaleF32(shared, 2)],
      ];
      for (const [name, call] of calls) {
        const error = thrown(call);
        assert.equal(error.code, 'InvalidArg', `${name} code`);
        assert.match(error.message, /SharedArrayBuffer/, `${name} message`);
      }
      assert.deepEqual([...shared], [1, 2, 3], 'nothing wrote into the shared memory');
      assert.equal(addon.sumF32(new Float32Array([1, 2, 3])), 6, 'a plain array still works');
      assert.equal(await pool.sumF32(new Float32Array([2])), 2);
      await pool.shutdown(1000);
    },
  },
  {
    // The refusal above asks the runtime whether the buffer is a plain ArrayBuffer
    // (napi_is_arraybuffer), which reads the engine's own record of the buffer, not JavaScript
    // state. Hiding the global constructor or swapping the prototype must not change the answer.
    name: 'typed arrays: shared memory is refused even with SharedArrayBuffer hidden or a swapped prototype',
    async run(addon) {
      const realShared = globalThis.SharedArrayBuffer;
      const shared = new Float32Array(new realShared(12));
      shared.set([1, 2, 3]);
      const swapped = new Float32Array(new realShared(12));
      swapped.set([1, 2, 3]);
      Object.setPrototypeOf(swapped.buffer, ArrayBuffer.prototype);
      const pool = new addon.Pool(1);
      try {
        // @ts-expect-error hiding the global on purpose
        globalThis.SharedArrayBuffer = undefined;
        for (const [label, values] of [['hidden constructor', shared], ['swapped prototype', swapped]] as const) {
          const calls: Array<[string, () => unknown]> = [
            ['sumF32', () => addon.sumF32(values)],
            ['scaleF32', () => addon.scaleF32(values, 2)],
            ['scaleInPlaceF32', () => addon.scaleInPlaceF32(values, 2)],
            ['pool.sumF32', () => pool.sumF32(values)],
            ['pool.scaleF32', () => pool.scaleF32(values, 2)],
          ];
          for (const [name, call] of calls) {
            assert.equal(thrown(call).code, 'InvalidArg', `${label}: ${name} refuses`);
          }
          assert.deepEqual([...values], [1, 2, 3], `${label}: memory untouched`);
        }
      } finally {
        globalThis.SharedArrayBuffer = realShared;
        await pool.shutdown(1000);
      }
    },
  },
  {
    name: 'sink: a full queue says queue_full, closing says closing, nothing is lost',
    async run(addon) {
      assert.equal(addon.sinkMaxQueueSize, 4);
      const received: number[] = [];
      const sink = new addon.Sink(value => received.push(value));
      // Synchronous emits cannot drain between calls, so the fifth must be refused.
      const statuses = [0, 1, 2, 3, 4, 5, 6, 7].map(n => sink.emit(n));
      assert.deepEqual(statuses.slice(0, 4), ['ok', 'ok', 'ok', 'ok']);
      assert.ok(statuses.slice(4).every(status => status === 'queue_full'), statuses.join(','));
      await sleep(50);
      assert.deepEqual(received, [0, 1, 2, 3], 'every ok value was delivered, in order');

      // From a Rust thread the same rule holds.
      const before = received.length;
      const fromThread = await sink.emitFromThread(50);
      assert.ok(fromThread.every(status => status === 'ok' || status === 'queue_full'));
      await sleep(50);
      assert.equal(received.length - before, fromThread.filter(status => status === 'ok').length);

      sink.close();
      assert.equal(sink.emit(9), 'closing');
      assert.deepEqual(await sink.emitFromThread(2), ['closing', 'closing']);
      await sleep(20);
    },
  },
];

/** The cases that make sense inside a compiled executable (everything in-process and quick). */
export const compiledCases: Case[] = cases.filter(c =>
  /^(metadata|typed arrays|panics|cancellation|shutdown: queued|sink)/.test(c.name),
);
