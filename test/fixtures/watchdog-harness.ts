/**
 * Fixture for test/process-watchdog.serial.test.ts. Spawned via `bun`.
 *
 * Usage: bun watchdog-harness.ts <mode> <deadlineMs> <graceMs>
 *   starve-with    — install the watchdog, then starve the event loop forever.
 *                    The watchdog must SIGKILL this process by deadline+grace.
 *   starve-without — no watchdog, just starve. Proves the busy loop truly hangs
 *                    (the test kills it). Isolates the watchdog as cause of death.
 *   clean-dispose  — install with a long deadline, dispose immediately, exit 0.
 *                    The watchdog must NOT kill a cleanly-disposed process.
 *
 * Safety net: the busy loop self-exits after 8s so a failed test kill can't hang CI.
 */
import { installProcessWatchdog } from '../../src/core/process-watchdog.ts';

const mode = process.argv[2] ?? 'starve-with';
const deadlineMs = Number(process.argv[3] ?? 300);
const graceMs = Number(process.argv[4] ?? 150);

if (mode === 'starve-with' || mode === 'clean-dispose') {
  const handle = installProcessWatchdog({ deadlineMs, graceMs, label: 'test-wd' });
  if (mode === 'clean-dispose') {
    handle.dispose();
    process.stdout.write('DISPOSED\n');
    process.exit(0);
  }
}

// Starve the main event loop with a synchronous busy loop (simulates ReDoS).
const start = Date.now();
while (Date.now() - start < 8000) { /* spin — no await, no yield */ }
process.stdout.write('SURVIVED\n'); // must NOT print under starve-with
process.exit(0);
