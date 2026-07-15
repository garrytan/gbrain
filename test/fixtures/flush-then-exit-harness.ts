/**
 * #2084 (D10) — spawned harness proving flushThenExit against REAL Bun pipe
 * semantics: writes HARNESS_BYTES of 'x' to stdout, then flushThenExit with
 * HARNESS_EXIT_CODE. The parent test pipes stdout to a slow-attaching reader
 * and asserts byte-complete output + the exit code — the exact scenario the
 * pre-#2084 force-exit truncated (#1959).
 */

import { flushThenExit } from '../../src/core/cli-force-exit.ts';

const size = Number(process.env.HARNESS_BYTES ?? 4_000_000);
const code = Number(process.env.HARNESS_EXIT_CODE ?? 7);
const guardMs = Number(process.env.HARNESS_GUARD_MS ?? 2_000);
const graceEnv = process.env.HARNESS_GRACE_MS;

const chunk = 'x'.repeat(65_536);
let written = 0;
while (written < size) {
  const n = Math.min(chunk.length, size - written);
  process.stdout.write(n === chunk.length ? chunk : chunk.slice(0, n));
  written += n;
}

flushThenExit(code, {
  guardMs,
  ...(graceEnv !== undefined ? { graceMs: Number(graceEnv) } : {}),
});
