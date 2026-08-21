/**
 * #4281 — loop-stall watchdog wiring in the `gbrain serve --http` branch.
 *
 * Pins the arm/dispose ordering around runServeHttp WITHOUT booting the real
 * OAuth server or a real watchdog worker: everything routes through the
 * injectable ServeOptions seams (runServeHttp / installStallWatchdog /
 * stallWatchdogMs), the same pattern as the stdio lifecycle tests.
 *
 * The real worker mechanics are covered by test/process-watchdog.test.ts
 * (pure + env) and test/process-watchdog.serial.test.ts (spawned processes).
 */
import { describe, test, expect } from 'bun:test';
import { runServe, type ServeOptions } from '../src/commands/serve.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { STALL_DEFAULT_GRACE_MS, type LoopStallWatchdogOpts } from '../src/core/process-watchdog.ts';

interface Harness {
  engine: { disconnectCalls: number; disconnect: () => Promise<void> };
  order: string[];
  installs: LoopStallWatchdogOpts[];
  logs: string[];
  exits: number[];
  opts: ServeOptions;
}

function makeHarness(overrides: Partial<ServeOptions> = {}): Harness {
  const order: string[] = [];
  const installs: LoopStallWatchdogOpts[] = [];
  const logs: string[] = [];
  const exits: number[] = [];

  const engine = {
    disconnectCalls: 0,
    disconnect: async () => {
      engine.disconnectCalls += 1;
      order.push('disconnect');
    },
  };

  const opts: ServeOptions = {
    exit: (code?: number) => {
      order.push('exit');
      exits.push(code ?? 0);
    },
    log: (m: string) => { logs.push(m); },
    runServeHttp: async () => {
      order.push('run-start');
      // A real serve resolves only when its lifecycle ends; a tick is enough
      // to prove the watchdog stays armed across the await.
      await new Promise((r) => setTimeout(r, 5));
      order.push('run-end');
    },
    installStallWatchdog: (o: LoopStallWatchdogOpts) => {
      installs.push(o);
      order.push('install');
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          order.push('dispose');
        },
        get active() { return !disposed; },
      };
    },
    stallWatchdogMs: 20_000,
    ...overrides,
  };

  return { engine, order, installs, logs, exits, opts };
}

describe('serve --http loop-stall watchdog seam (#4281)', () => {
  test('arms before runServeHttp and disposes after it resolves, before teardown', async () => {
    const h = makeHarness();
    await runServe(h.engine as unknown as BrainEngine, ['--http'], h.opts);

    // dispose must land BETWEEN the server lifecycle resolving and the
    // engine teardown — the watchdog covers runServeHttp only (plan #4281);
    // finishHttpServe has its own cleanup deadline.
    expect(h.order).toEqual(['install', 'run-start', 'run-end', 'dispose', 'disconnect', 'exit']);
    expect(h.exits).toEqual([0]);
    expect(h.installs.length).toBe(1);
    expect(h.installs[0].stallMs).toBe(20_000);
    expect(h.installs[0].graceMs).toBe(STALL_DEFAULT_GRACE_MS);
    expect(h.installs[0].label).toContain('serve');
  });

  test('stallWatchdogMs 0 (opt-in off) never installs; the serve path is untouched', async () => {
    const h = makeHarness({ stallWatchdogMs: 0 });
    await runServe(h.engine as unknown as BrainEngine, ['--http'], h.opts);

    expect(h.installs.length).toBe(0);
    expect(h.order).toEqual(['run-start', 'run-end', 'disconnect', 'exit']);
  });

  test('disposes the watchdog even when runServeHttp rejects', async () => {
    const h = makeHarness();
    h.opts.runServeHttp = async () => {
      h.order.push('run-throw');
      throw new Error('listen EADDRINUSE');
    };

    await expect(
      runServe(h.engine as unknown as BrainEngine, ['--http'], h.opts),
    ).rejects.toThrow('EADDRINUSE');

    // finally-dispose fired; finishHttpServe is intentionally NOT reached on a
    // failed boot (pre-#4281 behavior preserved — the error propagates to the CLI).
    expect(h.order).toEqual(['install', 'run-throw', 'dispose']);
    expect(h.exits).toEqual([]);
  });

  test('an armed watchdog logs an operator-visible line naming the env knob', async () => {
    const h = makeHarness();
    await runServe(h.engine as unknown as BrainEngine, ['--http'], h.opts);

    const joined = h.logs.join('\n');
    expect(joined).toContain('loop-stall watchdog armed');
    expect(joined).toContain('GBRAIN_SERVE_STALL_WATCHDOG_MS');
  });

  test('stays silent (no armed line) when off', async () => {
    const h = makeHarness({ stallWatchdogMs: 0 });
    await runServe(h.engine as unknown as BrainEngine, ['--http'], h.opts);
    expect(h.logs.join('\n')).not.toContain('loop-stall watchdog armed');
  });
});
