/**
 * Fixture for test/process-watchdog-harness.test.ts. Spawned via `bun`.
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
 * Progress-aware deadline modes (large-brain sync, F4d) — argv[5] is the
 * progress window in ms:
 *   progress-with   — install a progress-aware watchdog, then keep reporting
 *                     forward progress (noteForwardProgress every 25ms) for
 *                     4x the deadline. Must NOT be stopped; prints COMPLETED.
 *   progress-stalls — report progress for half the deadline, then idle (loop
 *                     responsive, no progress). Must be SIGTERMed one window
 *                     after the last progress note, after printing the
 *                     STOP-NOTICE stop notice on stdout.
 *
 * Committed-progress modes (GBRA-133 PR 3a) — argv[5] is the progress window in ms;
 * the watchdog counts only noteCommittedProgress:
 *   screen-only — report forward progress only (screening) for 4x the deadline.
 *                 Must be SIGTERMed at the deadline after printing STALL-NOTICE.
 *   commit-with — report committed progress for 4x the deadline. Must NOT be
 *                 stopped; prints COMPLETED.
 *
 * Safety net: the busy loop self-exits after 8s so a failed test kill can't hang CI.
 */
import { installProcessWatchdog, installLoopStallWatchdog } from '../../src/core/process-watchdog.ts';
import { noteCommittedProgress, noteForwardProgress } from '../../src/core/forward-progress.ts';

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

if (mode.startsWith('progress-')) {
  const progressWindowMs = Number(process.argv[5] ?? 400);
  installProcessWatchdog({ deadlineMs, graceMs, label: 'test-wd', progressWindowMs, stopNotice: 'STOP-NOTICE' });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const progressFor = mode === 'progress-with' ? deadlineMs * 4 : deadlineMs / 2;
  while (Date.now() - t0 < progressFor) { noteForwardProgress(); await sleep(25); }
  if (mode === 'progress-with') { process.stdout.write('COMPLETED\n'); process.exit(0); }
  while (Date.now() - t0 < 8000) await sleep(25);
  process.stdout.write('SURVIVED\n');
  process.exit(0);
}

if (mode === 'screen-only' || mode === 'commit-with') {
  const progressWindowMs = Number(process.argv[5] ?? 400);
  installProcessWatchdog({ deadlineMs, graceMs, label: 'test-wd', progressWindowMs, stopNotice: 'STOP-NOTICE', progressSignal: 'committed', stallNotice: 'STALL-NOTICE' });
  const note = mode === 'commit-with' ? noteCommittedProgress : noteForwardProgress;
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs * 4) { note(); await new Promise((r) => setTimeout(r, 25)); }
  process.stdout.write('COMPLETED\n');
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
