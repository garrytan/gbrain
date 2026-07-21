/**
 * #1872 — autopilot SIGTERM/SIGINT must close the engine before exit.
 *
 * On PGLite the cycle steps run INLINE in the autopilot process, so a hard
 * `process.exit` mid-write (systemctl stop → SIGTERM) kills WASM Postgres
 * with the WAL dirty and can corrupt the brain. Two exit paths must both
 * close the engine:
 *
 *   - autopilot's own shutdown() (owns SIGINT + internal stops like
 *     max_crashes / cycle-failure-cap), and
 *   - process-cleanup's SIGTERM handler (installed at cli.ts module load,
 *     which exits within its 3s cleanup deadline) — reached via the
 *     registered 'autopilot-engine-close' cleanup callback.
 *
 * Because the shutdown path is deep inside `runAutopilot()` (a long-running
 * daemon loop that ends in process.exit), a behavioral test would have to
 * spawn + signal a real daemon. Following the established precedent
 * (test/autopilot-supervisor-wiring.test.ts, test/autopilot-fanout-wiring.test.ts),
 * these static-shape regressions pin the load-bearing wiring instead.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const AUTOPILOT_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'),
  'utf8',
);

describe('autopilot.ts graceful engine shutdown (#1872)', () => {
  it('registers an engine-close callback in the process-cleanup registry (SIGTERM path)', () => {
    // process-cleanup owns SIGTERM (installed at cli.ts:10) and hard-exits
    // after its cleanup pass; without this registration the engine is never
    // closed on `systemctl stop`.
    expect(AUTOPILOT_SRC).toContain(
      "import { registerCleanup } from '../core/process-cleanup.ts';",
    );
    expect(AUTOPILOT_SRC).toContain(
      "registerCleanup('autopilot-engine-close', closeEngine)",
    );
  });

  it('closeEngine aborts the in-flight inline cycle then disconnects the engine', () => {
    // Abort first (runCycle checks the signal between phases and threads it
    // into phase sub-work), bounded drain, then disconnect.
    expect(AUTOPILOT_SRC).toMatch(
      /const closeEngine = async \(\) => \{[\s\S]{0,900}shutdownAbort\.abort\([\s\S]{0,900}engine\.disconnect\(\)/,
    );
  });

  it('the inline runCycle call carries the shutdown abort signal and is tracked as in-flight', () => {
    // PGLite / --inline path: the cycle runs in-process, so shutdown must be
    // able to (a) signal it to wind down and (b) await it before closing.
    expect(AUTOPILOT_SRC).toMatch(/signal:\s*shutdownAbort\.signal/);
    expect(AUTOPILOT_SRC).toMatch(/inflightInlineCycle\s*=\s*cyclePromise/);
  });

  it('shutdown() awaits closeEngine() before process.exit(0) (SIGINT + internal-stop path)', () => {
    expect(AUTOPILOT_SRC).toMatch(
      /await closeEngine\(\);[\s\S]{0,400}process\.exit\(0\)/,
    );
  });
});
