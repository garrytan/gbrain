/**
 * Tests for the shared spawn-and-respawn core used by MinionSupervisor
 * and src/commands/autopilot.ts. Pins the D1 lastExitCode-track behavior
 * and the D2 clean-restart-budget gate so future refactors can't silently
 * regress the supervisor crash-count incident this wave fixes.
 *
 * Strategy: each test writes a small shell script to disk that exits with
 * a chosen code after an optional sleep. The class spawns the script as
 * the "worker" and we assert on the event stream the class emits.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ChildWorkerSupervisor,
  type ChildSupervisorEvent,
} from '../src/core/minions/child-worker-supervisor.ts';

interface Harness {
  workerScript: string;
  cleanup: () => void;
}

function makeHarness(name: string, body: string): Harness {
  const root = join(tmpdir(), `gbrain-cws-test-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const workerScript = join(root, 'worker.sh');
  writeFileSync(workerScript, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(workerScript, 0o755);
  return {
    workerScript,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    },
  };
}

interface RunResult {
  events: ChildSupervisorEvent[];
  maxCrashesFired: { count: number; max: number } | null;
}

async function runUntilTerminal(
  h: Harness,
  overrides: Partial<{
    maxCrashes: number;
    _backoffFloorMs: number;
    cleanRestartBudget: number;
    cleanRestartWindowMs: number;
    cleanRestartBudgetBackoffMs: number;
    stableRunResetMs: number;
    _now: () => number;
    stopAfterEvents: number; // safety net so a buggy test can't hang
  }>,
): Promise<RunResult> {
  const events: ChildSupervisorEvent[] = [];
  let stopping = false;
  let maxCrashesFired: { count: number; max: number } | null = null;
  const stopAfter = overrides.stopAfterEvents ?? 200;

  const sup = new ChildWorkerSupervisor({
    cliPath: h.workerScript,
    args: [],
    maxCrashes: overrides.maxCrashes ?? 3,
    _backoffFloorMs: overrides._backoffFloorMs ?? 5,
    cleanRestartBudget: overrides.cleanRestartBudget,
    cleanRestartWindowMs: overrides.cleanRestartWindowMs,
    cleanRestartBudgetBackoffMs: overrides.cleanRestartBudgetBackoffMs,
    stableRunResetMs: overrides.stableRunResetMs,
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

  await sup.run();
  return { events, maxCrashesFired };
}

afterEach(() => {
  /* per-test harness.cleanup() runs in finally blocks below */
});

describe('ChildWorkerSupervisor', () => {
  describe('D1 — code=0 exit classifier', () => {
    it('code=0 worker exit does not count as crash; restarts immediately', async () => {
      const h = makeHarness('clean-exits', 'exit 0');
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
    });

    it('interleaved code=0 and code!=0 exits still trip max_crashes', async () => {
      // Worker alternates: each invocation increments a counter file and
      // exits 1 on odd hits, 0 on even hits (so exit-sequence is 1,0,1,0,1).
      const h = makeHarness(
        'interleaved',
        `
COUNTER_FILE="$(dirname "$0")/counter"
[ -f "$COUNTER_FILE" ] || echo 0 > "$COUNTER_FILE"
COUNT=$(cat "$COUNTER_FILE")
NEXT=$((COUNT + 1))
echo "$NEXT" > "$COUNTER_FILE"
# Odd-indexed runs (#1, #3, #5...) exit 1; even-indexed exit 0.
if [ $((NEXT % 2)) -eq 1 ]; then exit 1; else exit 0; fi
`,
      );
      try {
        const res = await runUntilTerminal(h, {
          maxCrashes: 3,
          _backoffFloorMs: 5,
          stopAfterEvents: 200,
        });

        expect(res.maxCrashesFired).not.toBeNull();
        // 3 code!=0 exits → max_crashes=3
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
    });

    it('code=0 after stable 5min+ run does not reset crashCount', async () => {
      // Sequence (4 runs total): exit 1 → exit 0 (6 min, "stable") → exit 1 →
      // exit 1. crashCount progression: 1, 1 (unchanged across the long
      // clean exit), 2, 3 — last one trips max_crashes=3.
      const h = makeHarness(
        'stable-clean-no-reset',
        `
COUNTER_FILE="$(dirname "$0")/counter"
[ -f "$COUNTER_FILE" ] || echo 0 > "$COUNTER_FILE"
COUNT=$(cat "$COUNTER_FILE")
NEXT=$((COUNT + 1))
echo "$NEXT" > "$COUNTER_FILE"
case $NEXT in
  1) exit 1 ;;
  2) exit 0 ;;
  3) exit 1 ;;
  4) exit 1 ;;
  *) exit 0 ;;
esac
`,
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
    });
  });

  describe('D2 — clean-restart budget', () => {
    it('budget exceeded triggers health_warn + budget_exceeded backoff', async () => {
      // Tight budget of 2 so we trip it on the 3rd clean exit.
      const h = makeHarness('budget-trip', 'exit 0');
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
    });

    it('budget config is per-instance (no module-level state leakage)', async () => {
      // Run instance A with budget=2 and instance B with budget=5. Each
      // tracks its own sliding window; A trips faster than B.
      const hA = makeHarness('budget-a', 'exit 0');
      const hB = makeHarness('budget-b', 'exit 0');
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
    });
  });

  describe('awaitChildExit short-circuit (P2 review fix)', () => {
    // Regression: pre-fix the method registered child.once('exit', ...) AFTER
    // child.exitCode was already populated, so a child that drained quickly
    // between killChild('SIGTERM') and awaitChildExit() would never resolve
    // and the caller waited out the full timeout. Fix probes exitCode +
    // signalCode first and short-circuits.
    it('resolves immediately when the child has already exited', async () => {
      const h = makeHarness('await-already-exited', 'exit 0');
      try {
        // Spin up a supervisor; drive it for ONE spawn cycle and then stop.
        const events: ChildSupervisorEvent[] = [];
        let stopping = false;
        const sup = new ChildWorkerSupervisor({
          cliPath: h.workerScript,
          args: [],
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
    });
  });

  describe('event shape', () => {
    it('worker_spawned + worker_exited fire on every cycle with consistent shape', async () => {
      const h = makeHarness('shape', 'exit 0');
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
    });
  });
});
