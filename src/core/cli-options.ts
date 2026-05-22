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

// ---------------------------------------------------------------------------
// Module-level singleton (set once by cli.ts after parsing global flags; read
// by any bulk command that wants to construct a reporter). Same pattern as
// Commander's `program.opts()`. Also threaded into OperationContext for
// shared ops that run under the MCP server (which sets its own defaults).
// ---------------------------------------------------------------------------

let activeCliOptions: CliOptions = { ...DEFAULT_CLI_OPTIONS };

export function setCliOptions(opts: CliOptions): void {
  activeCliOptions = { ...opts };
}

export function getCliOptions(): CliOptions {
  return activeCliOptions;
}

/**
 * Reset singleton to defaults. Only used by tests.
 */
export function _resetCliOptionsForTest(): void {
  activeCliOptions = { ...DEFAULT_CLI_OPTIONS };
}

/**
 * Build the global-flag suffix to append to child `gbrain …` subprocess
 * commands so children inherit the parent's progress-mode.
 *
 * Returns a string ready to concat onto an execSync command string, with
 * a leading space when non-empty. E.g. " --progress-json --quiet".
 *
 * Empty string when nothing to propagate (so the child's behavior is
 * unchanged for the common no-flag case).
 */
export function childGlobalFlags(cliOpts?: CliOptions): string {
  const opts = cliOpts ?? activeCliOptions;
  const parts: string[] = [];
  if (opts.quiet) parts.push('--quiet');
  if (opts.progressJson) parts.push('--progress-json');
  if (opts.progressInterval !== DEFAULT_CLI_OPTIONS.progressInterval) {
    parts.push(`--progress-interval=${opts.progressInterval}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}
