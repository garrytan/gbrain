/**
 * #2084 — unit tests for the one-shot CLI teardown + exit contract in
 * src/core/cli-force-exit.ts: finishCliTeardown (teardown-only, computed
 * backstop deadline), flushThenExit (write-fence + guard + EPIPE + once-latch),
 * and computeTeardownDeadlineMs (formula / floor / env override).
 *
 * Real short timers, no fake clocks. Every test that touches process.exitCode
 * or GBRAIN_TEARDOWN_DEADLINE_MS restores it in a finally so the suite stays
 * order-independent.
 */

import { describe, test, expect } from 'bun:test';
import {
  finishCliTeardown,
  flushThenExit,
  computeTeardownDeadlineMs,
  TEARDOWN_DEADLINE_FLOOR_MS,
  setCliExitVerdict,
  currentExitCode,
  _resetCliExitVerdictForTests,
  type MinimalWritable,
} from '../src/core/cli-force-exit.ts';
import { POOL_END_TIMEOUT_SECONDS } from '../src/core/db.ts';
import {
  backgroundWorkSinkCount,
  __registerDrainerForTest,
} from '../src/core/background-work.ts';
import { withEnv } from './helpers/with-env.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeStream(): MinimalWritable & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    write(chunk: string, cb?: (err?: Error | null) => void) {
      writes.push(chunk);
      if (cb) queueMicrotask(() => cb());
      return true;
    },
    once() {
      return this;
    },
  };
}

describe('computeTeardownDeadlineMs', () => {
  test('formula: sinks × drain + facts grace + 2 × pool bound + slack', () => {
    const poolEndBoundMs = POOL_END_TIMEOUT_SECONDS * 1000 + 500;
    // 4 sinks × 2000 + 2000 + 2×poolEnd + 2000 — the Site B worst case that
    // falsified the old static 10s (eng-review D9).
    const got = computeTeardownDeadlineMs({ sinkCount: 4, drainTimeoutMs: 2000 });
    expect(got).toBe(4 * 2000 + 2000 + 2 * poolEndBoundMs + 2000);
    expect(got).toBeGreaterThan(10_000); // the codex-found arithmetic bug, pinned
  });

  test('floors at TEARDOWN_DEADLINE_FLOOR_MS for small budgets', () => {
    const got = computeTeardownDeadlineMs({ sinkCount: 1, drainTimeoutMs: 100 });
    expect(got).toBe(TEARDOWN_DEADLINE_FLOOR_MS);
  });

  test('GBRAIN_TEARDOWN_DEADLINE_MS env override wins over the formula', async () => {
    await withEnv({ GBRAIN_TEARDOWN_DEADLINE_MS: '1234' }, async () => {
      expect(computeTeardownDeadlineMs({ sinkCount: 4, drainTimeoutMs: 2000 })).toBe(1234);
    });
  });

  test('garbage env values fall back to the formula', async () => {
    await withEnv({ GBRAIN_TEARDOWN_DEADLINE_MS: 'banana' }, async () => {
      expect(
        computeTeardownDeadlineMs({ sinkCount: 1, drainTimeoutMs: 100 }),
      ).toBe(TEARDOWN_DEADLINE_FLOOR_MS);
    });
  });

  test('zero and negative env values fall back to the formula (not "fire immediately")', async () => {
    await withEnv({ GBRAIN_TEARDOWN_DEADLINE_MS: '0' }, async () => {
      expect(computeTeardownDeadlineMs({ sinkCount: 1, drainTimeoutMs: 100 })).toBe(
        TEARDOWN_DEADLINE_FLOOR_MS,
      );
    });
    await withEnv({ GBRAIN_TEARDOWN_DEADLINE_MS: '-5' }, async () => {
      expect(computeTeardownDeadlineMs({ sinkCount: 1, drainTimeoutMs: 100 })).toBe(
        TEARDOWN_DEADLINE_FLOOR_MS,
      );
    });
  });

  test('a newly registered sink widens the computed deadline (D9: formula reads the live registry)', () => {
    // Register two sinks and compare between them: in a bare unit-test process
    // no production sinks are loaded, so the zero-sink baseline sits below the
    // 10s floor and would mask the first sink's delta.
    const mkSink = (name: string) =>
      __registerDrainerForTest({ name, order: 99, drain: async () => ({ unfinished: 0 }) });
    const un1 = mkSink('test-2084-sink-a');
    try {
      const withOne = computeTeardownDeadlineMs({
        sinkCount: backgroundWorkSinkCount(),
        drainTimeoutMs: 5000,
      });
      const un2 = mkSink('test-2084-sink-b');
      try {
        const withTwo = computeTeardownDeadlineMs({
          sinkCount: backgroundWorkSinkCount(),
          drainTimeoutMs: 5000,
        });
        expect(withOne).toBeGreaterThan(TEARDOWN_DEADLINE_FLOOR_MS); // above the floor — delta is visible
        expect(withTwo).toBe(withOne + 5000);
      } finally {
        un2();
      }
    } finally {
      un1();
    }
  });
});

describe('finishCliTeardown — clean path', () => {
  test('drains with the injected budget, disconnects, returns; no exit, no warn', async () => {
    const calls: string[] = [];
    let drainBudget = -1;
    const exits: number[] = [];
    const warns: string[] = [];
    await finishCliTeardown({
      engine: { disconnect: async () => void calls.push('disconnect') },
      drainTimeoutMs: 777,
      deadlineMs: 250,
      drain: async ({ timeoutMs }) => {
        drainBudget = timeoutMs;
        calls.push('drain');
      },
      exit: (c) => void exits.push(c),
      warn: (m) => void warns.push(m),
      stdout: fakeStream(),
      stderr: fakeStream(),
    });
    // Past the 250ms deadline: a leaked backstop would fire here.
    await sleep(400);
    expect(calls).toEqual(['drain', 'disconnect']);
    expect(drainBudget).toBe(777);
    expect(exits).toEqual([]);
    expect(warns).toEqual([]);
  });

  test('drain runs BEFORE disconnect (live-engine window for sinks)', async () => {
    const order: string[] = [];
    await finishCliTeardown({
      engine: { disconnect: async () => void order.push('disconnect') },
      deadlineMs: 1000,
      drain: async () => {
        await sleep(20);
        order.push('drain');
      },
      exit: () => {},
      warn: () => {},
    });
    expect(order).toEqual(['drain', 'disconnect']);
  });
});

describe('finishCliTeardown — backstop on hung teardown', () => {
  test('hung disconnect fires the banner and exits with current exitCode', async () => {
    const prevCode = process.exitCode;
    try {
      _resetCliExitVerdictForTests(); // no verdict set ⇒ currentExitCode() === 0
      const exits: number[] = [];
      const warns: string[] = [];
      let resolveHang!: () => void;
      const teardown = finishCliTeardown({
        engine: { disconnect: () => new Promise<void>((r) => (resolveHang = r)) },
        deadlineMs: 100,
        drain: async () => {},
        exit: (c) => void exits.push(c),
        warn: (m) => void warns.push(m),
        stdout: fakeStream(),
        stderr: fakeStream(),
        graceMs: 0,
      });
      await sleep(300);
      expect(warns.length).toBe(1);
      expect(warns[0]).toContain('did not return within');
      expect(warns[0]).toContain('100ms');
      expect(exits).toEqual([0]);
      resolveHang(); // unhang so the promise settles
      await teardown;
    } finally {
      _resetCliExitVerdictForTests();
      process.exitCode = prevCode;
    }
  });

  test('backstop honors an exit code the errored op already set', async () => {
    const prevCode = process.exitCode;
    try {
      setCliExitVerdict(1); // what the op-dispatch catch does
      const exits: number[] = [];
      let resolveHang!: () => void;
      const teardown = finishCliTeardown({
        engine: { disconnect: () => new Promise<void>((r) => (resolveHang = r)) },
        deadlineMs: 100,
        drain: async () => {},
        exit: (c) => void exits.push(c),
        warn: () => {},
        stdout: fakeStream(),
        stderr: fakeStream(),
        graceMs: 0,
      });
      await sleep(300);
      expect(exits).toEqual([1]);
      resolveHang();
      await teardown;
    } finally {
      _resetCliExitVerdictForTests();
      process.exitCode = prevCode;
    }
  });

  test('hung DRAIN (not just disconnect) also trips the backstop', async () => {
    const prevCode = process.exitCode;
    try {
      _resetCliExitVerdictForTests();
      const exits: number[] = [];
      const warns: string[] = [];
      let resolveHang!: () => void;
      const teardown = finishCliTeardown({
        engine: { disconnect: async () => {} },
        deadlineMs: 100,
        drain: () => new Promise<void>((r) => (resolveHang = r)),
        exit: (c) => void exits.push(c),
        warn: (m) => void warns.push(m),
        stdout: fakeStream(),
        stderr: fakeStream(),
        graceMs: 0,
      });
      await sleep(300);
      expect(warns.length).toBe(1);
      expect(exits).toEqual([0]);
      resolveHang();
      await teardown;
    } finally {
      process.exitCode = prevCode;
    }
  });
});

describe('verdict channel — immune to PGLite WASM process.exitCode writes', () => {
  test('engine teardown that rewrites process.exitCode does not change the verdict', async () => {
    // PGLite's Emscripten runtime writes its own status into process.exitCode
    // at arbitrary points (99 at create, initdb status on a later tick for
    // in-memory brains, 0 at close) — pre-#2084 this clobbered an errored
    // op's exit 1 back to 0 on every PGLite error path. The verdict lives in
    // the gbrain-owned channel and never reads the global back.
    const prevCode = process.exitCode;
    try {
      setCliExitVerdict(1); // the op errored
      await finishCliTeardown({
        engine: {
          disconnect: async () => {
            process.exitCode = 0; // what PGLite's WASM shutdown does
          },
        },
        deadlineMs: 1000,
        drain: async () => {},
        exit: () => {},
        warn: () => {},
      });
      expect(currentExitCode()).toBe(1);
    } finally {
      _resetCliExitVerdictForTests();
      process.exitCode = prevCode;
    }
  });

  test('mid-run WASM write (in-memory initdb status) cannot fake a verdict', () => {
    _resetCliExitVerdictForTests();
    try {
      process.exitCode = 100; // what in-memory PGLite's initdb does mid-run
      expect(currentExitCode()).toBe(0); // no gbrain verdict was ever set
      setCliExitVerdict(2);
      expect(currentExitCode()).toBe(2);
      // The mirror write exists for EXTERNAL readers of the global.
      expect(process.exitCode).toBe(2);
    } finally {
      _resetCliExitVerdictForTests();
      process.exitCode = 0;
    }
  });
});

describe('finishCliTeardown — disconnect failure (D3: exit code reports the op)', () => {
  test('a throwing drain is warned, disconnect still runs, helper resolves', async () => {
    // The registry is contractually non-throwing; this pins the defense-in-depth
    // guard — a drain rejection must not skip disconnect or escape the caller's
    // finally (it would replace a successful op's completion).
    const calls: string[] = [];
    const warns: string[] = [];
    await finishCliTeardown({
      engine: { disconnect: async () => void calls.push('disconnect') },
      deadlineMs: 1000,
      drain: async () => {
        throw new Error('sink registry blew up');
      },
      exit: () => {},
      warn: (m) => void warns.push(m),
    });
    expect(calls).toEqual(['disconnect']);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('sink registry blew up');
  });

  test('disconnect throw is warned and swallowed; helper resolves', async () => {
    const warns: string[] = [];
    const exits: number[] = [];
    await finishCliTeardown({
      engine: {
        disconnect: async () => {
          throw new Error('pool already dead');
        },
      },
      deadlineMs: 1000,
      drain: async () => {},
      exit: (c) => void exits.push(c),
      warn: (m) => void warns.push(m),
    });
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('pool already dead');
    expect(exits).toEqual([]); // helper never exits on the non-backstop path
  });
});

describe('flushThenExit', () => {
  test('exits after BOTH stream callbacks fire, exactly once, with the code', async () => {
    const prevCode = process.exitCode;
    try {
      const events: string[] = [];
      const exits: number[] = [];
      const slowStream = (name: string): MinimalWritable => ({
        write(_c: string, cb?: (err?: Error | null) => void) {
          setTimeout(() => {
            events.push(`${name}-flushed`);
            cb?.();
          }, 50);
          return true;
        },
        once() {
          return this;
        },
      });
      flushThenExit(3, {
        exit: (c) => {
          events.push('exit');
          exits.push(c);
        },
        stdout: slowStream('stdout'),
        stderr: slowStream('stderr'),
        guardMs: 2000,
        graceMs: 0,
      });
      await sleep(200);
      expect(events).toEqual(['stdout-flushed', 'stderr-flushed', 'exit']);
      expect(exits).toEqual([3]);
      expect(process.exitCode).toBe(3); // belt-and-braces for natural exit
    } finally {
      process.exitCode = prevCode;
    }
  });

  test('non-TTY default: exit waits the aliveness grace AFTER the fence', async () => {
    const prevCode = process.exitCode;
    try {
      const exits: number[] = [];
      const t0 = Date.now();
      let fencedAt = -1;
      const stream: MinimalWritable = {
        write(_c: string, cb?: (err?: Error | null) => void) {
          fencedAt = Date.now() - t0;
          if (cb) queueMicrotask(() => cb());
          return true;
        },
        once() {
          return this;
        },
      };
      flushThenExit(0, {
        exit: (c) => void exits.push(c),
        stdout: stream,
        stderr: stream,
        guardMs: 2000,
        graceMs: 120, // fakes are non-TTY; explicit grace keeps the test tight
      });
      await sleep(60);
      expect(exits).toEqual([]); // fence done, still inside the grace window
      await sleep(150);
      expect(exits).toEqual([0]);
      expect(fencedAt).toBeGreaterThanOrEqual(0);
    } finally {
      process.exitCode = prevCode;
    }
  });

  test('guard fires when a callback never arrives (blocked pipe)', async () => {
    const prevCode = process.exitCode;
    try {
      const exits: number[] = [];
      const blockedStream: MinimalWritable = {
        write() {
          return false; // never calls cb — reader stopped consuming
        },
        once() {
          return this;
        },
      };
      const t0 = Date.now();
      flushThenExit(0, {
        exit: (c) => void exits.push(c),
        stdout: blockedStream,
        stderr: blockedStream,
        guardMs: 100,
        graceMs: 0,
      });
      await sleep(300);
      expect(exits).toEqual([0]);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    } finally {
      process.exitCode = prevCode;
    }
  });

  test('sync write throw (EPIPE) still exits', async () => {
    const prevCode = process.exitCode;
    try {
      const exits: number[] = [];
      const epipeStream: MinimalWritable = {
        write() {
          throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        },
        once() {
          return this;
        },
      };
      flushThenExit(0, {
        exit: (c) => void exits.push(c),
        stdout: epipeStream,
        stderr: epipeStream,
        guardMs: 2000,
        graceMs: 0,
      });
      await sleep(50);
      expect(exits).toEqual([0]);
    } finally {
      process.exitCode = prevCode;
    }
  });

  test('GBRAIN_FLUSH_GRACE_MS env override is honored (batch/incident knob)', async () => {
    const prevCode = process.exitCode;
    try {
      await withEnv({ GBRAIN_FLUSH_GRACE_MS: '0' }, async () => {
        const exits: number[] = [];
        flushThenExit(0, {
          exit: (c) => void exits.push(c),
          stdout: fakeStream(),
          stderr: fakeStream(),
          guardMs: 2000,
          // no graceMs → resolves through the env override (fakes are non-TTY)
        });
        await sleep(60);
        expect(exits).toEqual([0]); // grace 0: exit right after the fence
      });
    } finally {
      process.exitCode = prevCode;
    }
  });

  test('once-latch: guard + late callbacks cannot double-exit', async () => {
    const prevCode = process.exitCode;
    try {
      const exits: number[] = [];
      // stdout flushes late (after the guard), stderr never — both race finish().
      const lateStream: MinimalWritable = {
        write(_c: string, cb?: (err?: Error | null) => void) {
          setTimeout(() => cb?.(), 150);
          return true;
        },
        once() {
          return this;
        },
      };
      const neverStream: MinimalWritable = {
        write() {
          return false;
        },
        once() {
          return this;
        },
      };
      flushThenExit(0, {
        exit: (c) => void exits.push(c),
        stdout: lateStream,
        stderr: neverStream,
        guardMs: 80,
        graceMs: 0,
      });
      await sleep(400);
      expect(exits).toEqual([0]); // exactly one exit despite guard + late cb
    } finally {
      process.exitCode = prevCode;
    }
  });
});
