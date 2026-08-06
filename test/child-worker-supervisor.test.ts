/**
 * Tests for the shared spawn-and-respawn core used by MinionSupervisor
 * and src/commands/autopilot.ts. Pins the D1 lastExitCode-track behavior
 * and the D2 clean-restart-budget gate so future refactors can't silently
 * regress the supervisor crash-count incident this wave fixes.
 *
 * Strategy: each test runs a tiny "worker" process that exits with a chosen
 * code after an optional sleep, and asserts on the event stream the class
 * emits as it respawns that worker.
 *
 * Workers come in two flavours, both portable:
 *   - `makeConstantExitHarness(code)` — a platform shell one-liner
 *     (`cmd /c exit N` / `sh -c 'exit N'`). Used wherever the worker only has
 *     to exit with a code, which is most tests. No temp file, no exec bit.
 *   - `makeHarness(name, body)` — a `.mjs` script executed by
 *     `process.execPath`. Used only where the worker needs real logic (an
 *     invocation counter, a signal handler).
 *
 * Neither is a `#!/bin/sh` script, which is what these tests used to write.
 * That was not portable: on Windows `chmodSync` is a no-op and the OS refuses
 * to execute a `.sh`, so every spawn failed instantly — and that used to HANG
 * the entire `bun test` process rather than fail it. See the "spawn failure"
 * describe block at the bottom for the supervisor bug it exposed.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ChildWorkerSupervisor,
  type ChildSupervisorEvent,
} from '../src/core/minions/child-worker-supervisor.ts';

/**
 * Per-test bun timeout for the spawn-driving tests. Generous because each test
 * drives several real process spawns and Windows process creation is slow; it
 * must stay ABOVE the harness's own wall-clock net (RUN_DEADLINE_MS +
 * RUN_ABANDON_GRACE_MS) so a wedge surfaces as that net's descriptive error
 * rather than bun's bare "timed out" — which is what made the original hang so
 * hard to read.
 */
const TEST_TIMEOUT_MS = 60_000;
/**
 * Soft stop: ask the supervisor to wind down after this long. Deliberately
 * generous — this is a net for an UNBOUNDED loop, not a performance budget.
 * A crash-loop test drives several real process spawns, and spawn latency on a
 * contended machine is easily seconds; too tight a deadline turns contention
 * into a spurious "gave up too early" failure.
 */
const RUN_DEADLINE_MS = 30_000;
/** Hard abandon: if run() STILL hasn't settled this long after the soft stop. */
const RUN_ABANDON_GRACE_MS = 5_000;

interface Harness {
  /** What the supervisor spawns (the bun binary for script workers). */
  cliPath: string;
  /** argv after cliPath (the worker script path for script workers). */
  args: string[];
  cleanup: () => void;
}

/**
 * Harness for a worker whose only job is to exit with a fixed code — which is
 * most of them. Uses the platform's own shell one-liner rather than a script
 * file, so no temp dir, no exec bit, and no JS-runtime startup per spawn.
 *
 * This matters: these tests drive real respawn loops, so a heavyweight worker
 * multiplies across every crash cycle and, on a loaded machine, is what pushes
 * a test into its own safety-net deadline. Only workers that need actual logic
 * (an invocation counter, a signal handler) pay for `makeHarness`.
 */
function makeConstantExitHarness(code: number): Harness {
  return process.platform === 'win32'
    ? {
        cliPath: process.env.COMSPEC ?? 'cmd.exe',
        args: ['/c', `exit ${code}`],
        cleanup: () => {},
      }
    : { cliPath: '/bin/sh', args: ['-c', `exit ${code}`], cleanup: () => {} };
}

function makeHarness(name: string, body: string): Harness {
  const root = join(tmpdir(), `gbrain-cws-test-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  // `.mjs` so both bun and node parse it as ESM regardless of any ambient
  // package.json `type` field (the temp dir has none).
  const workerScript = join(root, 'worker.mjs');
  writeFileSync(workerScript, `${body}\n`, 'utf8');
  return {
    cliPath: process.execPath,
    args: [workerScript],
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    },
  };
}

/**
 * Worker whose exit code is driven by an on-disk invocation counter, so a
 * respawn loop can walk a fixed exit-code sequence. `pick` is JS source for
 * an expression over `next` (the 1-based invocation number) yielding the exit
 * code. Replaces the old `$(dirname "$0")/counter` shell idiom.
 *
 * `fileURLToPath(new URL(...))` — never `new URL(...).pathname`, which yields
 * `/C:/...` on Windows (see the filesystem-paths invariant in CLAUDE.md).
 */
function counterWorkerBody(pick: string): string {
  return `
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const COUNTER = fileURLToPath(new URL('./counter', import.meta.url));
let count = 0;
try { count = parseInt(readFileSync(COUNTER, 'utf8'), 10) || 0; } catch {}
const next = count + 1;
writeFileSync(COUNTER, String(next), 'utf8');
process.exit(${pick});
`;
}

interface RunResult {
  events: ChildSupervisorEvent[];
  maxCrashesFired: { count: number; max: number } | null;
}

async function runUntilTerminal(
  h: Harness,
  overrides: Partial<{
    maxCrashes: number;
    hardStopMaxCrashes: number;
    _backoffFloorMs: number;
    cleanRestartBudget: number;
    cleanRestartWindowMs: number;
    cleanRestartBudgetBackoffMs: number;
    stableRunResetMs: number;
    watchdogLoopBudget: number;
    watchdogLoopWindowMs: number;
    watchdogBackoffMs: number;
    _now: () => number;
    stopAfterEvents: number; // safety net so a buggy test can't hang
    deadlineMs: number; // wall-clock safety net (see below)
  }>,
): Promise<RunResult> {
  const events: ChildSupervisorEvent[] = [];
  let stopping = false;
  let maxCrashesFired: { count: number; max: number } | null = null;
  const stopAfter = overrides.stopAfterEvents ?? 200;
  const deadlineMs = overrides.deadlineMs ?? RUN_DEADLINE_MS;

  const sup = new ChildWorkerSupervisor({
    cliPath: h.cliPath,
    args: h.args,
    maxCrashes: overrides.maxCrashes ?? 3,
    hardStopMaxCrashes: overrides.hardStopMaxCrashes,
    _backoffFloorMs: overrides._backoffFloorMs ?? 5,
    cleanRestartBudget: overrides.cleanRestartBudget,
    cleanRestartWindowMs: overrides.cleanRestartWindowMs,
    cleanRestartBudgetBackoffMs: overrides.cleanRestartBudgetBackoffMs,
    stableRunResetMs: overrides.stableRunResetMs,
    watchdogLoopBudget: overrides.watchdogLoopBudget,
    watchdogLoopWindowMs: overrides.watchdogLoopWindowMs,
    watchdogBackoffMs: overrides.watchdogBackoffMs,
    _now: overrides._now,
    isStopping: () => stopping,
    onMaxCrashesExceeded: (count, max) => {
      maxCrashesFired = { count, max };
      stopping = true;
    },
    onEvent: (event) => {
      events.push(event);
      if (events.length >= stopAfter) {
        stopping = true;
      }
    },
  });

  // WALL-CLOCK SAFETY NET.
  //
  // `stopAfterEvents` alone is not a safety net: it only advances when the
  // supervisor EMITS, and `stopping` is only observed between loop iterations.
  // Any failure mode that stops producing events — a spawn that never settles,
  // a wedged child, a future refactor that awaits something unresolvable —
  // leaves the counter frozen and the loop pinned forever. That is not
  // hypothetical: a `.sh` worker on Windows wedged `spawnOnce()` on its FIRST
  // spawn, and because the process kept running after bun's per-test timeout
  // fired, the whole `bun test` invocation never terminated and never printed
  // a totals line.
  //
  // Two-stage, so a hang is a fast FAILING test rather than a hung process:
  //   1. soft — flip `stopping` and SIGKILL any live child, which is enough to
  //      unwind a loop that is still making progress.
  //   2. hard — if run() STILL hasn't settled, abandon it and throw. The test
  //      fails with a diagnostic instead of taking the runner down with it.
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const softTimer = setTimeout(() => {
    stopping = true;
    sup.killChild('SIGKILL');
  }, deadlineMs);

  const ABANDONED = Symbol('run-abandoned');
  const abandon = new Promise<typeof ABANDONED>((resolve) => {
    hardTimer = setTimeout(() => resolve(ABANDONED), deadlineMs + RUN_ABANDON_GRACE_MS);
  });

  let outcome: 'ok' | typeof ABANDONED;
  try {
    outcome = await Promise.race([sup.run().then(() => 'ok' as const), abandon]);
  } finally {
    clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
  }

  if (outcome === ABANDONED) {
    throw new Error(
      `ChildWorkerSupervisor.run() did not settle within ` +
        `${deadlineMs + RUN_ABANDON_GRACE_MS}ms (events emitted: ${events.length}; ` +
        `last: ${JSON.stringify(events[events.length - 1] ?? null)}). ` +
        `The loop is wedged — it is NOT merely slow.`,
    );
  }

  return { events, maxCrashesFired };
}

afterEach(() => {
  /* per-test harness.cleanup() runs in finally blocks below */
});

describe('ChildWorkerSupervisor', () => {
  describe('D1 — code=0 exit classifier', () => {
    it('code=0 worker exit does not count as crash; restarts immediately', async () => {
      const h = makeConstantExitHarness(0);
      try {
        const res = await runUntilTerminal(h, {
          maxCrashes: 3,
          stopAfterEvents: 30, // ~10 spawn/exit/backoff trios
        });
        expect(res.maxCrashesFired).toBeNull();

        const exits = res.events.filter((e) => e.kind === 'worker_exited');
        expect(exits.length).toBeGreaterThanOrEqual(3);
        for (const e of exits) {
          if (e.kind === 'worker_exited') {
            expect(e.code).toBe(0);
            expect(e.likelyCause).toBe('clean_exit');
            // crashCount stays at 0 across every clean exit
            expect(e.crashCount).toBe(0);
          }
        }

        const backoffs = res.events.filter((e) => e.kind === 'backoff');
        expect(backoffs.length).toBeGreaterThanOrEqual(1);
        // Within the default 10-restart budget, all backoffs are ms:0 / clean_exit
        for (const e of backoffs) {
          if (e.kind === 'backoff') {
            // Once we cross the 10-restart budget the reason flips to
            // budget_exceeded, but until then they're all clean_exit ms:0.
            if (e.reason === 'clean_exit') {
              expect(e.ms).toBe(0);
              expect(e.crashCount).toBe(0);
            }
          }
        }
      } finally {
        h.cleanup();
      }
    }, TEST_TIMEOUT_MS);

    it('interleaved code=0 and code!=0 exits still trip max_crashes', async () => {
      // Worker alternates: each invocation increments a counter file and
      // exits 1 on odd hits, 0 on even hits (so exit-sequence is 1,0,1,0,1).
      const h = makeHarness(
        'interleaved',
        counterWorkerBody('next % 2 === 1 ? 1 : 0'),
      );
      try {
        const res = await runUntilTerminal(h, {
          maxCrashes: 3,
          // issue #1994: the soft budget no longer gives up; pin the hard
          // ceiling to 3 so this counting test still fires give-up at 3.
          hardStopMaxCrashes: 3,
          _backoffFloorMs: 5,
          stopAfterEvents: 200,
        });

        expect(res.maxCrashesFired).not.toBeNull();
        // 3 code!=0 exits → hard ceiling=3
        expect(res.maxCrashesFired!.count).toBe(3);

        const exits = res.events.filter((e) => e.kind === 'worker_exited');
        // Should be exactly 5 exits: 1, 0, 1, 0, 1 — then max fires.
        const codes = exits
          .filter((e): e is Extract<ChildSupervisorEvent, { kind: 'worker_exited' }> => e.kind === 'worker_exited')
          .map((e) => e.code);
        expect(codes).toEqual([1, 0, 1, 0, 1]);

        const backoffs = res.events
          .filter((e): e is Extract<ChildSupervisorEvent, { kind: 'backoff' }> => e.kind === 'backoff');
        // Backoffs only fire between iterations 1-4 (not after the 5th, since
        // the loop bails out via onMaxCrashesExceeded before applyBackoff).
        // Even-index exits (code=0, indices 1+3) → reason='clean_exit'.
        // Odd-index exits (code=1, indices 0+2) → reason='crash'.
        const reasons = backoffs.map((e) => e.reason);
        expect(reasons).toEqual(['crash', 'clean_exit', 'crash', 'clean_exit']);
      } finally {
        h.cleanup();
      }
    }, TEST_TIMEOUT_MS);

    it('code=0 after stable 5min+ run does not reset crashCount', async () => {
      // Sequence (4 runs total): exit 1 → exit 0 (6 min, "stable") → exit 1 →
      // exit 1. crashCount progression: 1, 1 (unchanged across the long
      // clean exit), 2, 3 — last one trips max_crashes=3.
      const h = makeHarness(
        'stable-clean-no-reset',
        counterWorkerBody('[1, 0, 1, 1][next - 1] ?? 0'),
      );
      try {
        // Fake clock — each spawnOnce reads now() twice (start + exit) and
        // applyBackoff may read once more. Run 2 sees a 6-minute duration
        // (stable-run reset would fire IF the exit were code!=0 — we assert
        // it does NOT fire when the exit is clean).
        const SIX_MIN = 6 * 60_000;
        const timestamps = [
          0,            // run 1 start
          1_000,        // run 1 exit  (+1s)  → crashCount 1
          1_000,        // run 2 start
          1_000 + SIX_MIN, // run 2 exit (+6min) → code=0, stays at 1
          1_000 + SIX_MIN, // run 3 start
          1_000 + SIX_MIN + 1_000, // run 3 exit (+1s) → crashCount 2
          1_000 + SIX_MIN + 1_000, // run 4 start
          1_000 + SIX_MIN + 2_000, // run 4 exit (+1s) → crashCount 3, trips max
        ];
        let idx = 0;
        const last = timestamps[timestamps.length - 1];
        const fakeNow = () => {
          if (idx < timestamps.length) {
            return timestamps[idx++];
          }
          return last + (idx++ - timestamps.length + 1) * 100;
        };

        const res = await runUntilTerminal(h, {
          maxCrashes: 3,
          hardStopMaxCrashes: 3, // issue #1994: pin give-up to 3 for this counting test
          _backoffFloorMs: 5,
          _now: fakeNow,
          stopAfterEvents: 200,
        });

        expect(res.maxCrashesFired).not.toBeNull();
        expect(res.maxCrashesFired!.count).toBe(3);

        const exits = res.events
          .filter((e): e is Extract<ChildSupervisorEvent, { kind: 'worker_exited' }> => e.kind === 'worker_exited')
          .map((e) => ({ code: e.code, crashCount: e.crashCount, runDurationMs: e.runDurationMs }));

        expect(exits.length).toBeGreaterThanOrEqual(4);
        expect(exits[0]).toMatchObject({ code: 1, crashCount: 1 });
        expect(exits[1]).toMatchObject({ code: 0, crashCount: 1 }); // D1: unchanged
        expect(exits[2]).toMatchObject({ code: 1, crashCount: 2 });
        expect(exits[3]).toMatchObject({ code: 1, crashCount: 3 });
        // Run 2 ran 6min, but because exit code was 0 the stable-run reset
        // branch did NOT fire — crashCount stayed at 1. This is the core
        // D1 invariant: clean exits never reset crashCount, even stable ones.
        expect(exits[1].runDurationMs).toBe(SIX_MIN);
      } finally {
        h.cleanup();
      }
    }, TEST_TIMEOUT_MS);
  });

  describe('D2 — clean-restart budget', () => {
    it('budget exceeded triggers health_warn + budget_exceeded backoff', async () => {
      // Tight budget of 2 so we trip it on the 3rd clean exit.
      const h = makeConstantExitHarness(0);
      try {
        const res = await runUntilTerminal(h, {
          maxCrashes: 3, // never trips because code=0 doesn't increment
          _backoffFloorMs: 5,
          cleanRestartBudget: 2,
          cleanRestartWindowMs: 60_000,
          cleanRestartBudgetBackoffMs: 10,
          stopAfterEvents: 25,
        });

        const healthWarns = res.events.filter(
          (e): e is Extract<ChildSupervisorEvent, { kind: 'health_warn' }> => e.kind === 'health_warn',
        );
        // Once tripped, every subsequent clean exit re-fires health_warn
        // (the sliding window stays full at our test rate).
        expect(healthWarns.length).toBeGreaterThan(0);
        for (const w of healthWarns) {
          expect(w.reason).toBe('clean_restart_budget_exceeded');
          expect(w.windowMs).toBe(60_000);
          expect(w.count).toBeGreaterThan(2);
        }

        const backoffReasons = res.events
          .filter((e): e is Extract<ChildSupervisorEvent, { kind: 'backoff' }> => e.kind === 'backoff')
          .map((e) => e.reason);
        // First 2 exits are within budget → reason='clean_exit'.
        // From the 3rd exit onward → reason='budget_exceeded'.
        expect(backoffReasons.slice(0, 2)).toEqual(['clean_exit', 'clean_exit']);
        expect(backoffReasons.slice(2).every((r) => r === 'budget_exceeded')).toBe(true);
      } finally {
        h.cleanup();
      }
    }, TEST_TIMEOUT_MS);

    it('budget config is per-instance (no module-level state leakage)', async () => {
      // Run instance A with budget=2 and instance B with budget=5. Each
      // tracks its own sliding window; A trips faster than B.
      const hA = makeConstantExitHarness(0);
      const hB = makeConstantExitHarness(0);
      try {
        const resA = await runUntilTerminal(hA, {
          maxCrashes: 99,
          _backoffFloorMs: 5,
          cleanRestartBudget: 2,
          cleanRestartBudgetBackoffMs: 5,
          stopAfterEvents: 12,
        });
        const resB = await runUntilTerminal(hB, {
          maxCrashes: 99,
          _backoffFloorMs: 5,
          cleanRestartBudget: 5,
          cleanRestartBudgetBackoffMs: 5,
          stopAfterEvents: 18,
        });

        const firstTripA = resA.events.findIndex(
          (e) => e.kind === 'health_warn',
        );
        const firstTripB = resB.events.findIndex(
          (e) => e.kind === 'health_warn',
        );

        expect(firstTripA).toBeGreaterThan(-1);
        expect(firstTripB).toBeGreaterThan(-1);
        // B's budget is more generous → its first health_warn appears later
        // in the event stream (after more spawn/exit pairs).
        expect(firstTripB).toBeGreaterThan(firstTripA);
      } finally {
        hA.cleanup();
        hB.cleanup();
      }
    }, TEST_TIMEOUT_MS);
  });

  describe('awaitChildExit short-circuit (P2 review fix)', () => {
    // Regression: pre-fix the method registered child.once('exit', ...) AFTER
    // child.exitCode was already populated, so a child that drained quickly
    // between killChild('SIGTERM') and awaitChildExit() would never resolve
    // and the caller waited out the full timeout. Fix probes exitCode +
    // signalCode first and short-circuits.
    it('resolves immediately when the child has already exited', async () => {
      const h = makeConstantExitHarness(0);
      try {
        // Spin up a supervisor; drive it for ONE spawn cycle and then stop.
        const events: ChildSupervisorEvent[] = [];
        let stopping = false;
        const sup = new ChildWorkerSupervisor({
          cliPath: h.cliPath,
          args: h.args,
          maxCrashes: 1,
          _backoffFloorMs: 1,
          isStopping: () => stopping,
          onMaxCrashesExceeded: () => { stopping = true; },
          onEvent: (e) => {
            events.push(e);
            if (e.kind === 'worker_exited') stopping = true;
          },
        });
        await sup.run();
        // After run() returns, the child has exited; awaitChildExit on an
        // already-finished cycle MUST resolve in well under the timeout.
        const start = Date.now();
        await sup.awaitChildExit(5_000);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(200);
      } finally {
        h.cleanup();
      }
    }, TEST_TIMEOUT_MS);
  });

  describe('event shape', () => {
    it('worker_spawned + worker_exited fire on every cycle with consistent shape', async () => {
      const h = makeConstantExitHarness(0);
      try {
        const res = await runUntilTerminal(h, {
          maxCrashes: 3,
          _backoffFloorMs: 5,
          stopAfterEvents: 9, // 3 spawn-exit-backoff triples
        });

        const spawned = res.events.filter(
          (e): e is Extract<ChildSupervisorEvent, { kind: 'worker_spawned' }> => e.kind === 'worker_spawned',
        );
        const exited = res.events.filter(
          (e): e is Extract<ChildSupervisorEvent, { kind: 'worker_exited' }> => e.kind === 'worker_exited',
        );

        expect(spawned.length).toBeGreaterThanOrEqual(2);
        expect(exited.length).toBe(spawned.length);

        for (const s of spawned) {
          expect(typeof s.pid).toBe('number');
          expect(s.pid).toBeGreaterThan(0);
          expect(typeof s.tini).toBe('boolean');
        }
        for (const e of exited) {
          expect(e.code).toBe(0);
          expect(e.signal).toBeNull();
          expect(typeof e.runDurationMs).toBe('number');
          expect(e.likelyCause).toBe('clean_exit');
        }
      } finally {
        h.cleanup();
      }
    }, TEST_TIMEOUT_MS);
  });

  // issue #1678: RSS-watchdog exits (code 12) are cause-keyed and must NOT
  // route through the generic crash path — the >5-min stable-run reset would
  // defeat max_crashes and the 400×/24h loop would never stop being silent.
  describe('rss_watchdog breaker (issue #1678)', () => {
    it('code=12 is labeled rss_watchdog and never increments crashCount', async () => {
      const h = makeConstantExitHarness(12);
      try {
        const { events, maxCrashesFired } = await runUntilTerminal(h, {
          maxCrashes: 3,
          _backoffFloorMs: 1,
          stopAfterEvents: 18, // ~6 spawn/exit/backoff triples
        });
        const exited = events.filter(
          (e): e is Extract<ChildSupervisorEvent, { kind: 'worker_exited' }> =>
            e.kind === 'worker_exited',
        );
        // Looped well past maxCrashes WITHOUT tripping it — the whole point.
        expect(maxCrashesFired).toBeNull();
        expect(exited.length).toBeGreaterThan(3);
        for (const e of exited) {
          expect(e.code).toBe(12);
          expect(e.likelyCause).toBe('rss_watchdog');
          expect(e.crashCount).toBe(0); // never counted as a crash
        }
      } finally {
        h.cleanup();
      }
    }, TEST_TIMEOUT_MS);

    it('emits rss_watchdog_loop health_warn once the window budget is exceeded', async () => {
      const h = makeConstantExitHarness(12);
      try {
        const { events } = await runUntilTerminal(h, {
          maxCrashes: 99,
          _backoffFloorMs: 1,
          watchdogLoopBudget: 2,
          watchdogLoopWindowMs: 600_000,
          stopAfterEvents: 24,
        });
        const warns = events.filter(
          (e): e is Extract<ChildSupervisorEvent, { kind: 'health_warn' }> =>
            e.kind === 'health_warn' && e.reason === 'rss_watchdog_loop',
        );
        // Budget=2 → the 3rd+ watchdog exit in-window fires the loud alert.
        expect(warns.length).toBeGreaterThan(0);
        expect(warns[0].count).toBeGreaterThan(2);
        // And every backoff after a watchdog exit is reason=rss_watchdog.
        const wdBackoffs = events.filter(
          (e) => e.kind === 'backoff' && e.reason === 'rss_watchdog',
        );
        expect(wdBackoffs.length).toBeGreaterThan(0);
      } finally {
        h.cleanup();
      }
    }, TEST_TIMEOUT_MS);
  });

  // issue #1994 (#2227 tail): crossing the SOFT crash budget no longer
  // permanently gives up. The supervisor enters degraded mode (capped backoff
  // + loud warn) so a transient outage self-heals; permanent give-up fires only
  // at the much-higher hard ceiling.
  describe('degraded-mode crash backoff (issue #1994)', () => {
    it('crossing the soft budget does NOT give up; it warns and keeps retrying to the hard ceiling', async () => {
      const h = makeConstantExitHarness(1);
      try {
        const { events, maxCrashesFired } = await runUntilTerminal(h, {
          maxCrashes: 3,        // soft budget
          hardStopMaxCrashes: 6, // hard ceiling
          _backoffFloorMs: 1,
          stopAfterEvents: 200,
        });
        // Permanent give-up fired at the HARD ceiling (6), not the soft budget (3).
        expect(maxCrashesFired).not.toBeNull();
        expect(maxCrashesFired!.count).toBe(6);
        expect(maxCrashesFired!.max).toBe(6);

        // The soft-budget crossing announced degraded mode (at least once).
        const degraded = events.filter(
          (e): e is Extract<ChildSupervisorEvent, { kind: 'health_warn' }> =>
            e.kind === 'health_warn' && e.reason === 'crash_budget_degraded',
        );
        expect(degraded.length).toBeGreaterThanOrEqual(1);
        expect(degraded[0].max).toBe(3);
        expect(degraded[0].count).toBeGreaterThanOrEqual(3);

        // It kept respawning past the soft budget (more than 3 crash exits).
        const crashes = events.filter(
          (e): e is Extract<ChildSupervisorEvent, { kind: 'worker_exited' }> =>
            e.kind === 'worker_exited' && e.code === 1,
        );
        expect(crashes.length).toBe(6);
      } finally {
        h.cleanup();
      }
    }, TEST_TIMEOUT_MS);

    it('hardStopMaxCrashes=0 disables permanent give-up (retry-forever-with-backoff)', async () => {
      const h = makeConstantExitHarness(1);
      try {
        const { events, maxCrashesFired } = await runUntilTerminal(h, {
          maxCrashes: 3,
          hardStopMaxCrashes: 0, // never permanently stop
          _backoffFloorMs: 1,
          stopAfterEvents: 40,   // the safety net stops the test, not a give-up
        });
        // Never gave up despite many crashes past the soft budget.
        expect(maxCrashesFired).toBeNull();
        const crashes = events.filter(
          (e) => e.kind === 'worker_exited' && (e as any).code === 1,
        );
        expect(crashes.length).toBeGreaterThan(3);
      } finally {
        h.cleanup();
      }
    }, TEST_TIMEOUT_MS);
  });

  describe('issue #1801 — restartCurrentChild + killChild liveness fix', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // ESRCH = no such process (dead). EPERM = process exists but we can't
    // signal it (alive) — under `bun test` a spawned child can land in a state
    // where kill(pid,0) reports EPERM, so treat anything-but-ESRCH as alive.
    const isAlive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; }
      catch (e) { return (e as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
    };

    // Worker that IGNORES SIGTERM and sleeps, so only SIGKILL can stop it.
    // (On Windows there is no signal delivery — `child.kill('SIGTERM')` maps to
    // TerminateProcess — so the handler is inert there and the child simply
    // dies. These tests assert the captured child ends up dead and a fresh one
    // is spawned, which holds under both semantics.)
    function makeSigtermIgnorer(name: string): Harness {
      return makeHarness(
        name,
        "process.on('SIGTERM', () => {});\nsetTimeout(() => {}, 30_000);",
      );
    }

    async function startInBackground(h: Harness): Promise<{
      sup: ChildWorkerSupervisor;
      events: ChildSupervisorEvent[];
      firstPid: number;
      stop: () => Promise<void>;
    }> {
      const events: ChildSupervisorEvent[] = [];
      let stopping = false;
      let resolveSpawn: (pid: number) => void;
      const firstSpawn = new Promise<number>((r) => { resolveSpawn = r; });
      const sup = new ChildWorkerSupervisor({
        cliPath: h.cliPath,
        args: h.args,
        maxCrashes: 100,
        _backoffFloorMs: 5,
        isStopping: () => stopping,
        onMaxCrashesExceeded: () => { stopping = true; },
        onEvent: (e) => {
          events.push(e);
          if (e.kind === 'worker_spawned') resolveSpawn(e.pid);
        },
      });
      const runPromise = sup.run();
      const firstPid = await firstSpawn;
      const stop = async () => {
        stopping = true;
        // SIGKILL-retry until run() returns (children ignore SIGTERM).
        for (let i = 0; i < 60; i++) {
          sup.killChild('SIGKILL');
          const done = await Promise.race([
            runPromise.then(() => true),
            sleep(50).then(() => false),
          ]);
          if (done) return;
        }
        await runPromise;
      };
      return { sup, events, firstPid, stop };
    }

    // Structural regression for Codex #1: killChild MUST gate on liveness
    // (exitCode/signalCode === null), NOT on `.killed`. `.killed` flips true the
    // moment a signal is *sent*, so a `!this._child.killed` guard makes a
    // follow-up SIGKILL (after an ignored SIGTERM) a silent no-op — the bug that
    // left the existing shutdown() drain unable to force-kill a stuck worker.
    // (The SIGTERM→SIGKILL behavior is exercised end-to-end by the
    // restartCurrentChild test below + standalone repros; a live-process
    // assertion that a SIGTERM-ignoring child survives is unreliable under the
    // `bun test` runtime, so the no-regression contract is pinned structurally.)
    it('killChild gates on liveness, not .killed (Codex #1 regression)', () => {
      const src = readFileSync(
        join(import.meta.dir, '..', 'src', 'core', 'minions', 'child-worker-supervisor.ts'),
        'utf8',
      );
      const killChildBody = src.slice(
        src.indexOf('killChild(signal: NodeJS.Signals)'),
        src.indexOf('awaitChildExit('),
      );
      // Strip comment lines so the doc note explaining the OLD bug (which names
      // `.killed`) doesn't trip the negative assertion — we check the CODE.
      const code = killChildBody
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      expect(code).toContain('exitCode === null');
      expect(code).toContain('signalCode === null');
      // The buggy `.killed` guard must be gone from the code.
      expect(code).not.toContain('.killed');
    });

    it('restartCurrentChild SIGKILLs the captured child, respawns, labels wedge_restart, leaves crashCount=0', async () => {
      const h = makeSigtermIgnorer('restart-current');
      const ctx = await startInBackground(h);
      try {
        const oldPid = ctx.firstPid;
        await ctx.sup.restartCurrentChild(150); // SIGTERM ignored → SIGKILL after 150ms
        await sleep(400); // let the old child exit + run() respawn (ms:0 wedge backoff)

        expect(isAlive(oldPid)).toBe(false); // captured child killed

        const spawns = ctx.events.filter((e) => e.kind === 'worker_spawned');
        expect(spawns.length).toBeGreaterThanOrEqual(2); // respawned

        const wedgeExit = ctx.events.find(
          (e) => e.kind === 'worker_exited' && e.likelyCause === 'wedge_restart',
        );
        expect(wedgeExit).toBeDefined();
        if (wedgeExit && wedgeExit.kind === 'worker_exited') {
          expect(wedgeExit.crashCount).toBe(0); // Codex #3 — not counted as a crash
        }

        const wedgeBackoff = ctx.events.find(
          (e) => e.kind === 'backoff' && e.reason === 'wedge_restart',
        );
        expect(wedgeBackoff).toBeDefined();
        if (wedgeBackoff && wedgeBackoff.kind === 'backoff') {
          expect(wedgeBackoff.ms).toBe(0); // immediate respawn
        }

        // Codex #2 — the respawned child is alive and was NOT killed by a stale
        // timer aimed at the old child.
        expect(ctx.sup.childAlive).toBe(true);
      } finally {
        await ctx.stop();
        h.cleanup();
      }
    }, TEST_TIMEOUT_MS);

    it('repeated wedge restarts never trip max_crashes (crashCount stays 0)', async () => {
      const h = makeSigtermIgnorer('restart-no-crash');
      const ctx = await startInBackground(h);
      try {
        for (let i = 0; i < 3; i++) {
          await ctx.sup.restartCurrentChild(120);
          await sleep(300);
        }
        expect(ctx.sup.crashCount).toBe(0); // three self-heals, zero crashes
      } finally {
        await ctx.stop();
        h.cleanup();
      }
    }, TEST_TIMEOUT_MS);
  });

  // A worker that can NEVER launch (bad cliPath, missing binary, a target the
  // OS refuses to execute) is the one failure mode with no exit code to
  // classify. Node and Bun signal it with 'error' + 'close' and NEVER 'exit',
  // so a supervisor that only settles on 'exit' hangs on its FIRST spawn:
  // no respawn, no crash count, no give-up, and — because the loop keeps the
  // process alive past bun's per-test timeout — a `bun test` run that never
  // terminates and never prints a totals line.
  //
  // Platform-independent: `spawn()` of a nonexistent path is ENOENT everywhere,
  // so this guards the fix on Linux CI too, not just on the Windows box where
  // it surfaced (a `.sh` worker, since chmod is a no-op and there is no
  // shebang handling).
  describe('spawn failure that never launches a process', () => {
    /** Harness for a cliPath guaranteed not to exist. Nothing to clean up. */
    function makeUnlaunchableHarness(name: string): Harness {
      return {
        cliPath: join(
          tmpdir(),
          `gbrain-cws-missing-${name}-${process.pid}-${Date.now()}`,
          'definitely-not-a-binary',
        ),
        args: [],
        cleanup: () => {},
      };
    }

    it('settles the run loop instead of hanging, and counts each failure as a crash', async () => {
      const h = makeUnlaunchableHarness('enoent');
      const { events, maxCrashesFired } = await runUntilTerminal(h, {
        maxCrashes: 2,
        hardStopMaxCrashes: 3,
        _backoffFloorMs: 1,
        stopAfterEvents: 200,
      });

      // The load-bearing assertion is simply that we got here: pre-fix,
      // runUntilTerminal's wall-clock net threw because run() never settled.
      expect(maxCrashesFired).not.toBeNull();
      expect(maxCrashesFired!.count).toBe(3);
      expect(maxCrashesFired!.max).toBe(3);

      // Each failed spawn is reported…
      const failures = events.filter((e) => e.kind === 'worker_spawn_failed');
      expect(failures.length).toBeGreaterThanOrEqual(3);

      // …and accounted as a crash, so the hard ceiling can bound a permanent
      // misconfig. `spawn_failed` is not in supervisor-audit's
      // CLEAN_EXIT_CAUSES, so the audit summary counts it as a crash too.
      const exits = events.filter(
        (e): e is Extract<ChildSupervisorEvent, { kind: 'worker_exited' }> =>
          e.kind === 'worker_exited',
      );
      expect(exits.length).toBe(3);
      expect(exits.map((e) => e.crashCount)).toEqual([1, 2, 3]);
      for (const e of exits) {
        expect(e.code).toBeNull();
        expect(e.likelyCause).toBe('spawn_failed');
      }

      // It paid the crash backoff between attempts rather than hot-looping.
      const backoffs = events.filter(
        (e): e is Extract<ChildSupervisorEvent, { kind: 'backoff' }> => e.kind === 'backoff',
      );
      expect(backoffs.length).toBeGreaterThanOrEqual(1);
      expect(backoffs.every((b) => b.reason === 'crash')).toBe(true);
    }, TEST_TIMEOUT_MS);

    it('honours isStopping so a shutdown mid-failure does not keep respawning', async () => {
      const h = makeUnlaunchableHarness('stop-early');
      const { events } = await runUntilTerminal(h, {
        maxCrashes: 99,
        hardStopMaxCrashes: 0, // never give up on its own
        _backoffFloorMs: 1,
        stopAfterEvents: 6, // the composer's stop flag is the only exit
      });
      // Terminated via isStopping rather than the wall-clock net (which would
      // have thrown), and did not run away past the event budget.
      expect(events.length).toBeGreaterThanOrEqual(6);
      expect(events.length).toBeLessThan(60);
    }, TEST_TIMEOUT_MS);
  });
});
