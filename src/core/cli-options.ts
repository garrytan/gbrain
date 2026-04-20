/**
 * Global CLI flags parsed before command dispatch.
 *
 * Keeping this separate from per-command flag parsing so that
 * `gbrain --progress-json doctor` works: the global flag is stripped
 * before cli.ts looks at argv[0] for the subcommand.
 *
 * Threading: every command handler receives a resolved CliOptions object.
 * Shared-operation handlers see the same values via OperationContext.cliOpts.
 */

import type { ProgressOptions } from './progress.ts';

export interface CliOptions {
  quiet: boolean;
  progressJson: boolean;
  progressInterval: number; // ms
}

export const DEFAULT_CLI_OPTIONS: CliOptions = {
  quiet: false,
  progressJson: false,
  progressInterval: 1000,
};

/**
 * Parse recognized global flags from the front / anywhere in argv and return
 * the resolved options plus the remaining argv (with global flags stripped).
 *
 * Recognized:
 *   --quiet
 *   --progress-json
 *   --progress-interval=<ms>
 *   --progress-interval <ms>   (space-separated form)
 *
 * Unknown flags are passed through unchanged — per-command parsers see them.
 */
export function parseGlobalFlags(argv: string[]): { cliOpts: CliOptions; rest: string[] } {
  const cliOpts: CliOptions = { ...DEFAULT_CLI_OPTIONS };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quiet') {
      cliOpts.quiet = true;
      continue;
    }
    if (a === '--progress-json') {
      cliOpts.progressJson = true;
      continue;
    }
    if (a === '--progress-interval' && i + 1 < argv.length) {
      const next = argv[i + 1];
      const parsed = parseInterval(next);
      if (parsed !== null) {
        cliOpts.progressInterval = parsed;
        i++;
        continue;
      }
      // not a number — let per-command parser handle; pass through
      rest.push(a);
      continue;
    }
    if (a.startsWith('--progress-interval=')) {
      const val = a.slice('--progress-interval='.length);
      const parsed = parseInterval(val);
      if (parsed !== null) {
        cliOpts.progressInterval = parsed;
        continue;
      }
      rest.push(a);
      continue;
    }
    rest.push(a);
  }

  return { cliOpts, rest };
}

function parseInterval(s: string): number | null {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Map resolved CliOptions to ProgressOptions for createProgress().
 *
 * Mode resolution:
 *   --quiet          → 'quiet'
 *   --progress-json  → 'json'
 *   otherwise        → 'auto' (TTY: human-\r, non-TTY: human-plain)
 *
 * Agents that want structured events on a non-TTY stream must pass
 * --progress-json explicitly. Non-TTY default is plain human lines so
 * shell pipelines don't suddenly see JSON noise.
 */
export function cliOptsToProgressOptions(cliOpts: CliOptions): ProgressOptions {
  if (cliOpts.quiet) return { mode: 'quiet' };
  if (cliOpts.progressJson) return { mode: 'json', minIntervalMs: cliOpts.progressInterval };
  return { mode: 'auto', minIntervalMs: cliOpts.progressInterval };
}
