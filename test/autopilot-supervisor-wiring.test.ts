/**
 * Regression guards for the autopilot↔ChildWorkerSupervisor wiring.
 *
 * autopilot.ts:148+ used to have its own inline spawn-and-respawn loop
 * (separate from MinionSupervisor's). It had the same bug class fixed
 * in #1003 but on a parallel implementation. The fix wave refactored
 * autopilot to use the shared ChildWorkerSupervisor core, eliminating
 * the parallel-supervisor footgun.
 *
 * Because the autopilot spawn path is deep inside `runAutopilot()` and
 * gated by `spawnManagedWorker` (which needs a Postgres engine), a full
 * integration test would require a DATABASE_URL fixture. Instead, these
 * static-shape regressions read the source file and pin the load-bearing
 * constants:
 *
 *   - the worker is spawned with an auto-sized `--max-rss` (issue #1678)
 *   - `maxCrashes: 5` matches the prior `crashCount >= 5` give-up rule
 *   - The autopilot composes ChildWorkerSupervisor (not the legacy
 *     inline `child.on('exit')` loop)
 *   - The shutdown path drains via the supervisor's killChild/awaitChildExit
 *
 * If any of these regress in a future refactor, the test fails with a
 * pointer at autopilot.ts.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const AUTOPILOT_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'),
  'utf8',
);

describe('autopilot.ts ↔ ChildWorkerSupervisor wiring', () => {
  it('imports ChildWorkerSupervisor from the shared core', () => {
    expect(AUTOPILOT_SRC).toContain(
      "import { ChildWorkerSupervisor } from '../core/minions/child-worker-supervisor.ts';",
    );
  });

  it('does not retain the legacy inline spawn loop (`startWorker` + child.on)', () => {
    // The old code at autopilot.ts:165-197 defined `startWorker` and called
    // `child.on('exit', ...)` directly. The refactor must drop those names.
    expect(AUTOPILOT_SRC).not.toContain('const startWorker');
    expect(AUTOPILOT_SRC).not.toContain("child.on('exit'");
    // Also drop the parallel crash-tracking state that lived in autopilot.
    expect(AUTOPILOT_SRC).not.toContain('let crashCount');
    expect(AUTOPILOT_SRC).not.toContain('let lastWorkerStartTime');
    expect(AUTOPILOT_SRC).not.toContain('STABLE_RUN_RESET_MS');
  });

  it("spawns the worker with an auto-sized --max-rss (issue #1678)", () => {
    // Post-v0.41.39.0 the flat 2048 default is gone: autopilot resolves
    // resolveDefaultMaxRssMb() (cgroup-aware) and passes it as the cap. The
    // argv must still carry the --max-rss flag token + the resolved value.
    expect(AUTOPILOT_SRC).toContain("resolveDefaultMaxRssMb");
    expect(AUTOPILOT_SRC).toContain("'--max-rss', String(autopilotMaxRssMb)");
    expect(AUTOPILOT_SRC).toContain("'jobs', 'work'");
    // The footgun literal must NOT come back.
    expect(AUTOPILOT_SRC).not.toContain("'--max-rss', '2048'");
  });

  it("constructs ChildWorkerSupervisor with maxCrashes: 5", () => {
    // Matches the legacy `crashCount >= 5` give-up rule from the inline
    // loop. The shared core uses this to decide when to fire
    // onMaxCrashesExceeded → autopilot's shutdown('max_crashes').
    expect(AUTOPILOT_SRC).toMatch(/maxCrashes:\s*5\b/);
  });

  it('routes onMaxCrashesExceeded to autopilot.shutdown (not process.exit directly)', () => {
    // Pre-refactor: autopilot.ts called process.exit(1) directly when the
    // crash counter tripped, bypassing its own dispatch-loop cleanup and
    // lockfile removal. Post-refactor: the callback routes through
    // shutdown('max_crashes') so cleanup runs.
    expect(AUTOPILOT_SRC).toMatch(/onMaxCrashesExceeded:[\s\S]{0,300}shutdown\('max_crashes'\)/);
  });

  it('shutdown drains via supervisor.killChild + awaitChildExit (not workerProc.kill)', () => {
    // The legacy shutdown reached into `workerProc` directly. Post-refactor
    // those calls go through the supervisor's typed surface, which lets the
    // class encapsulate the kill/drain sequence.
    expect(AUTOPILOT_SRC).toContain("childSupervisor.killChild('SIGTERM')");
    expect(AUTOPILOT_SRC).toContain('childSupervisor.awaitChildExit(35_000)');
    expect(AUTOPILOT_SRC).not.toContain('workerProc');
  });
});
