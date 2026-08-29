/**
 * Fixture for test/pglite-disconnect-watchdog.serial.test.ts. Spawned via `bun`.
 *
 * Usage: bun pglite-disconnect-watchdog-harness.ts <mode>
 *   wedge-watchdog — monkeypatch close() into the measured #4284 wedge (a
 *                    queueMicrotask re-pump that starves the timers phase,
 *                    the #1762 shape), with the out-of-band watchdog armed by
 *                    the parent's env. The watchdog's SIGKILL must end this
 *                    process at deadline+grace.
 *   wedge-control  — same wedge, NO watchdog env: pins #4284's measured claim
 *                    that the in-loop close bound can never fire while the
 *                    loop is starved (no warn, no post-disconnect marker;
 *                    only the parent's cap ends it).
 *   clean-watchdog — real close with a deliberately-tiny watchdog env: proves
 *                    the lethal-knob floor clamps up and a disposed watchdog
 *                    never kills a healthy disconnect.
 *
 * Env knobs (GBRAIN_PGLITE_CLOSE_TIMEOUT_MS / _WATCHDOG_MS / _WATCHDOG_GRACE_MS)
 * are set by the PARENT test per mode.
 *
 * Safety nets, stacked: the microtask spin self-bounds at 20s (after it stops
 * the loop idles, the in-loop bound finally fires, and the process exits on
 * its own), under the parent's marker-relative kill cap, under the parent's
 * absolute failsafe. A failed kill can never hang CI.
 */
import { writeSync } from 'node:fs';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { backgroundWorkSinkCount } from '../../src/core/background-work.ts';

const mode = process.argv[2] ?? 'wedge-control';

// Mirror production: cli.ts installs SIGTERM cleanup handlers. With ANY JS
// handler present, a starved event loop SURVIVES SIGTERM (the handler can
// never run — signal dispatch to JS needs the loop), so the watchdog's
// SIGKILL at deadline+grace is the real backstop. Without a handler the
// KERNEL default would kill at the SIGTERM deadline and the SIGKILL path
// would ship untested (#4284 eng outside-voice, empirically probed).
process.on('SIGTERM', () => { /* no-op — a starved loop never runs this */ });

const engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite' }); // in-memory; no initSchema — close is monkeypatched

if (mode === 'wedge-watchdog' || mode === 'wedge-control') {
  const eng = engine as unknown as { _db: { close: () => Promise<void> } | null };
  eng._db!.close = () => {
    const t0 = Date.now();
    const spin = () => { if (Date.now() - t0 < 20_000) queueMicrotask(spin); };
    spin();
    return new Promise<void>(() => { /* never settles */ });
  };
}

// fs.writeSync, NOT process.stdout.write: a stream write is a yield point and
// would perturb the starvation under test (the #4143 instrumentation lesson).
// SINKS lets the parent compute the expected lethal-knob floor dynamically
// (floor = max(5000, sinks*2000 + closeTimeout + 2000)) instead of pinning a
// number that silently drifts when a future sink joins this import graph.
writeSync(1, `SINKS=${backgroundWorkSinkCount()}\n`);
writeSync(1, 'ARMED\n');
await engine.disconnect();
writeSync(1, 'DISCONNECTED\n');
process.exit(0);
