/**
 * Spawned harness for test/cli-exit-drain.test.ts: the one-shot CLI's stdio
 * setup (installStdoutPipeDelivery), HARNESS_STDOUT_BYTES of 'o' on stdout and
 * HARNESS_STDERR_BYTES of 'e' on stderr, then the exit seam (flushThenExit).
 * The parent pipes both streams, attaches its readers late on demand and
 * checks byte-complete delivery plus how long the exit waited.
 */

import { flushThenExit, installStdoutPipeDelivery } from '../../src/core/cli-force-exit.ts';

installStdoutPipeDelivery();
const outBytes = Number(process.env.HARNESS_STDOUT_BYTES ?? 0);
const errBytes = Number(process.env.HARNESS_STDERR_BYTES ?? 0);
if (outBytes > 0) process.stdout.write('o'.repeat(outBytes));
if (errBytes > 0) process.stderr.write('e'.repeat(errBytes));
flushThenExit(Number(process.env.HARNESS_EXIT_CODE ?? 0));
