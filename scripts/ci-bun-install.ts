#!/usr/bin/env bun
/**
 * CI's `bun install`, bounded and retried once.
 *
 * Bun normally installs this repository in 4-14 s. On .195's master Test run
 * one macos-26-intel runner's install sat for 805 s, a registry or network stall,
 * and the job's 15-minute budget cancelled it a minute short of finishing, with
 * nothing naming the cause. This wrapper ends a stalled attempt after
 * GBRAIN_CI_INSTALL_ATTEMPT_S, retries once after a short pause, and on a
 * second failure stops with a named `::error::`. Anything else it leaves as Bun
 * printed it: the output is inherited, and a failure that is not a stall (a
 * frozen-lockfile mismatch, an unreachable registry) is retried once and then
 * reported with Bun's exit code. It uses no dependency, because it runs before
 * they are installed. The bound, retry and process-group handling live in
 * `scripts/ci-bounded-run.ts`, which other setup steps share.
 *
 * Usage: bun scripts/ci-bun-install.ts [bun install flags...]
 * Environment (defaults are the CI values; the test overrides them):
 *   GBRAIN_CI_INSTALL_ATTEMPT_S      per-attempt bound in seconds, default 180
 *   GBRAIN_CI_INSTALL_RETRY_SLEEP_S  pause before the retry in seconds, default 10
 *   GBRAIN_CI_INSTALL_BUN            the Bun executable to run, default this one
 */
import { runBounded } from './ci-bounded-run.ts';

const flags = process.argv.slice(2);
process.exit(await runBounded({
  argv: [process.env.GBRAIN_CI_INSTALL_BUN || process.execPath, 'install', ...flags],
  label: ['bun', 'install', ...flags].join(' '),
  attemptSeconds: Number(process.env.GBRAIN_CI_INSTALL_ATTEMPT_S ?? 180),
  retrySeconds: Number(process.env.GBRAIN_CI_INSTALL_RETRY_SLEEP_S ?? 10),
  hint: 'a registry or network stall; the install normally takes seconds',
}));
