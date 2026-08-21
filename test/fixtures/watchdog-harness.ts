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
 * Loop-stall watchdog modes (#4281) — <deadlineMs> is the stall threshold:
 *   stall-with     — register an inert SIGTERM listener (so the OS default
 *                    disposition can't kill us — mirrors serve-http, whose
 *                    process-cleanup SIGTERM handler can't run when the loop
 *                    is starved), install the stall watchdog, starve forever.
 *                    The watchdog must SIGTERM at ~stall, then SIGKILL at
 *                    ~stall+grace.
 *   stall-healthy  — install the stall watchdog and stay HEALTHY (idle loop,
 *                    pets flowing) well past stall+grace. Neither signal may
 *                    fire; a false SIGTERM prints TERMED and exits 1.
 *   stall-dispose  — install, dispose immediately, then genuinely starve past
 *                    stall+grace. A disposed watchdog must never kill.
 *
 * Safety net: the busy loop self-exits after 8s so a failed test kill can't hang CI.
 */
import { installProcessWatchdog, installLoopStallWatchdog } from '../../src/core/process-watchdog.ts';

const mode = process.argv[2] ?? 'starve-with';
const deadlineMs = Number(process.argv[3] ?? 300);
const graceMs = Number(process.argv[4] ?? 150);

if (mode.startsWith('stall-')) {
  const installStall = () => installLoopStallWatchdog({
    stallMs: deadlineMs,
    graceMs,
    label: 'test-stall',
    petIntervalMs: 50,
    checkIntervalMs: 25,
  });

  if (mode === 'stall-dispose') {
    const handle = installStall();
    handle.dispose();
    // Genuinely starve past stall+grace: the disposed watchdog must not fire.
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs + graceMs + 400) { /* spin */ }
    process.stdout.write('DISPOSED\n');
    process.exit(0);
  }

  if (mode === 'stall-healthy') {
    const handle = installStall();
    // A false SIGTERM (watchdog misfiring on a healthy loop) is the bug this
    // mode exists to catch — make it loud and non-zero.
    process.on('SIGTERM', () => { process.stdout.write('TERMED\n'); process.exit(1); });
    // Healthy loop: idle awaits keep the pet interval firing. Wait several
    // full stall+grace windows to prove pets genuinely reset the lag.
    await new Promise((r) => setTimeout(r, deadlineMs + graceMs + 700));
    handle.dispose();
    process.stdout.write('HEALTHY\n');
    process.exit(0);
  }

  // stall-with: the listener's mere presence stops the OS default SIGTERM
  // disposition from killing us; the JS callback itself can never run while
  // the loop is starved (the #1633 premise), so death must come from SIGKILL.
  process.on('SIGTERM', () => { /* starved loop never runs this */ });
  installStall();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) { /* spin — no await, no yield */ }
  process.stdout.write('SURVIVED\n'); // must NOT print under stall-with
  process.exit(0);
}

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
