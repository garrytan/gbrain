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
  /**
   * v0.31.1 (Issue #734, ENG-4): user-supplied per-call timeout for thin-client
   * routed MCP calls. `null` means "use the per-command default" (30s for most
   * ops, 180s for `think`). When set, applies to every routed call in the
   * current invocation.
   */
  timeoutMs: number | null;
  /**
   * v0.40.4 — `--explain` flag for `gbrain search/query`. Switches the
   * default formatter to a per-stage attribution view that shows
   * base_score + each boost stage's multiplier + rank delta from
   * the reranker. Has no effect on other commands.
   */
  explain: boolean;
  /**
   * `--brain <id>` — which BRAIN (database) this invocation targets: 'host'
   * or a mount id from ~/.gbrain/mounts.json. Parsed here (stripped before
   * per-command parsing, like --source) so it can never collide with
   * per-op flag parsing. `null` = no explicit flag; connectEngine resolves
   * the ambient tiers (GBRAIN_BRAIN_ID / .gbrain-mount / mount-path / 'host')
   * via src/core/brain-resolver.ts.
   */
  brain: string | null;
}

export const DEFAULT_CLI_OPTIONS: CliOptions = {
  quiet: false,
  progressJson: false,
  progressInterval: 1000,
  timeoutMs: null,
  explain: false,
  brain: null,
};

/**
 * Brain-id shape. Same regex as brain-registry's BRAIN_ID_RE (kept in sync;
 * brain-resolver.ts follows the same convention). 'host' matches. Validated
 * at parse time so an invalid id fails LOUDLY here — and so childGlobalFlags
 * can safely splice the value into execSync('gbrain ...') command strings.
 */
const BRAIN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function parseBrainValue(val: string | undefined): string {
  if (val === undefined || val.length === 0 || val.startsWith('-')) {
    throw new Error('--brain requires a value (a mount id from `gbrain mounts list`, or "host").');
  }
  if (!BRAIN_ID_RE.test(val)) {
    throw new Error(
      `Invalid --brain value "${val}". Must match [a-z0-9-]{1,32}, start+end alphanumeric.`,
    );
  }
  return val;
}

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
/**
 * #3013: commands that parse their own `--timeout` flag out of argv.
 * `sync` reads a seconds-based graceful-abort budget (src/commands/sync.ts +
 * resolveSyncHardDeadline); `remote` reads a ms-based request budget
 * (src/commands/remote.ts). For these commands the global parser must hand
 * the flag back: claiming it stripped the flag before the per-command parser
 * could read it, and — for `sync` — a non-null global timeoutMs flipped the
 * read-only dispatch gate in cli.ts, rerouting a write command into
 * dispatchReadOnlyCommand (exit 1 before any work ran).
 */
export const TIMEOUT_OWNING_COMMANDS = new Set(['sync', 'remote']);

/**
 * #4541: commands whose result formatter consumes the GLOBAL --explain (the
 * v0.40.4 per-stage search attribution view in cli.ts's query/search
 * formatter; `ask` is the query alias rewritten before dispatch). For every
 * OTHER command the global parser hands the flag back IN PLACE — `extract
 * --explain <kind>`, `whoknows --explain`, and `onboard --check --explain`
 * parse it themselves, and the blanket claim starved them: `extract
 * --explain timeline` fell through to the WRITE-pass extraction instead of
 * the explain view.
 *
 * wave-g: `call` claims it too — `gbrain call <op>` maps leftover argv into
 * op params, so a handed-back --explain would surface as an
 * unknown-parameter error instead of being ignored (the pre-#4541 global
 * behavior for `call query --explain`).
 */
export const EXPLAIN_CLAIMING_COMMANDS = new Set(['query', 'search', 'ask', 'call']);

export function parseGlobalFlags(argv: string[]): { cliOpts: CliOptions; rest: string[] } {
  const cliOpts: CliOptions = { ...DEFAULT_CLI_OPTIONS };
  // #3013: --timeout can't be resolved inline — whether the GLOBAL parser
  // claims it depends on which command is running, and the command token is
  // only known once the whole argv has been scanned (global flags may precede
  // it). The scan collects positional slots; --timeout slots are resolved in
  // a second pass below.
  type Slot =
    | { plain: string }
    | { timeoutValue: string; equalsForm: boolean }
    | { explainFlag: true };
  const slots: Slot[] = [];

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
      slots.push({ plain: a });
      continue;
    }
    if (a.startsWith('--progress-interval=')) {
      const val = a.slice('--progress-interval='.length);
      const parsed = parseInterval(val);
      if (parsed !== null) {
        cliOpts.progressInterval = parsed;
        continue;
      }
      slots.push({ plain: a });
      continue;
    }
    // v0.31.1: --timeout=Ns or --timeout Ns. Accepts plain ms, "30s", "2m".
    // A following token that is itself a flag is NOT a value — leave it for
    // its own iteration (pre-#3013 behavior: an unparseable next token was
    // never consumed).
    if (a === '--timeout' && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
      slots.push({ timeoutValue: argv[i + 1], equalsForm: false });
      i++;
      continue;
    }
    if (a.startsWith('--timeout=')) {
      slots.push({ timeoutValue: a.slice('--timeout='.length), equalsForm: true });
      continue;
    }
    // v0.40.4 — --explain for `gbrain search/query` per-stage attribution.
    // #4541: like --timeout, whether the global parser claims it depends on
    // the command, which is only known after the full scan — slot it.
    if (a === '--explain') {
      slots.push({ explainFlag: true });
      continue;
    }
    // --brain <id> / --brain=<id> — brain (database) axis. Exact-match only:
    // `--brain-wide-max-cost-usd` (skillopt) and other `--brain-*` flags pass
    // through to per-command parsers untouched. A missing or malformed value
    // THROWS rather than falling through — a dropped --brain silently routes
    // to the wrong database (the exact bug class this flag's wiring fixes).
    if (a === '--brain') {
      cliOpts.brain = parseBrainValue(argv[i + 1]);
      i++;
      continue;
    }
    if (a.startsWith('--brain=')) {
      cliOpts.brain = parseBrainValue(a.slice('--brain='.length));
      continue;
    }
    slots.push({ plain: a });
  }

  // The command is the first plain token (matches `command = rest[0]` in
  // cli.ts). If it owns --timeout, every --timeout is handed back in the
  // space-separated spelling (the only form the owning parsers read; this
  // also normalizes `--timeout=60s`), value verbatim so the owning command
  // applies its own unit + validity rules (`sync`: bare integers are
  // SECONDS, `ms`/fractional rejected loudly; `remote` accepts `h`).
  // Handed-back flags are APPENDED after every other token: both owning
  // commands treat leading args as positional subcommands (`sync trigger`,
  // `remote ping`) and locate --timeout by scanning args, so appending can't
  // shadow a subcommand while duplicate flags keep their argv order (the
  // owning parsers' first-occurrence-wins precedence matches what the user
  // typed). Non-owning commands keep the pre-#3013 global behavior:
  // parseable values are claimed into cliOpts.timeoutMs (last one wins),
  // unparseable ones pass through in their original spelling for the
  // per-command parser.
  const commandSlot = slots.find((s): s is { plain: string } => 'plain' in s);
  const commandOwnsTimeout =
    commandSlot !== undefined && TIMEOUT_OWNING_COMMANDS.has(commandSlot.plain);
  // #4541: only the search/query formatter commands claim --explain globally;
  // everyone else gets it back in place (extract/whoknows/onboard own it).
  const commandClaimsExplain =
    commandSlot !== undefined && EXPLAIN_CLAIMING_COMMANDS.has(commandSlot.plain);

  const rest: string[] = [];
  const handback: string[] = [];
  for (const s of slots) {
    if ('plain' in s) {
      rest.push(s.plain);
      continue;
    }
    if ('explainFlag' in s) {
      if (commandClaimsExplain) cliOpts.explain = true;
      else rest.push('--explain');
      continue;
    }
    if (commandOwnsTimeout) {
      handback.push('--timeout', s.timeoutValue);
      continue;
    }
    const parsed = parseTimeout(s.timeoutValue);
    if (parsed !== null) {
      cliOpts.timeoutMs = parsed;
    } else if (s.equalsForm) {
      rest.push(`--timeout=${s.timeoutValue}`);
    } else {
      rest.push('--timeout', s.timeoutValue);
    }
  }
  rest.push(...handback);

  return { cliOpts, rest };
}

/**
 * v0.31.1: parse a timeout value. Accepts:
 *   "30000" / "30000ms" → 30000
 *   "30s"               → 30000
 *   "2m"                → 120000
 *   "1.5s"              → 1500
 * Returns null on parse failure (caller decides whether to error or fall through).
 */
export function parseTimeout(s: string): number | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m)?$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? 'ms';
  const ms = unit === 'ms' ? n : unit === 's' ? n * 1000 : n * 60_000;
  return Math.floor(ms);
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
  // Brain routing must survive into child `gbrain ...` subprocesses: the env
  // and dotfile tiers self-propagate (children inherit env + cwd), but an
  // explicit --brain does not — without this, a parent routed to a mount
  // spawns children that silently operate on the host brain. The value is
  // BRAIN_ID_RE-validated at parse time, so splicing it into an exec string
  // is safe.
  if (opts.brain) parts.push(`--brain=${opts.brain}`);
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

// ============================================================
// v0.36+ brain-health-100 wave: --background flag (D9 + T7)
//
// Per the locked decision: --background means submit-and-exit ALWAYS.
// Same semantics in TTY and cron. Composable in shell pipelines:
//
//   JOB=$(gbrain embed --stale --background | grep -oE 'job_id=[0-9]+' | cut -d= -f2)
//   gbrain jobs get $JOB
//
// `--background --follow` submits then execs `gbrain jobs follow <id>`
// so the user sees live stream while still getting durable queue
// semantics (worker survives if user disconnects).
//
// PGLite degrades to inline with a clear stderr note. NOT a no-op,
// NOT silent. Doc-stated semantic difference because PGLite has no
// worker daemon.
// ============================================================

import type { BrainEngine } from './engine.ts';
import { createHash } from 'crypto';

export interface MaybeBackgroundOpts {
  engine: BrainEngine;
  args: string[];
  jobName: string;
  paramBuilder: (args: string[]) => Record<string, unknown>;
  /** Source id for the idempotency key namespace. Default 'cli'. */
  source?: string;
}

/**
 * If `--background` is in args, submit a Minion job and return true
 * (caller should exit). Otherwise return false (caller does inline work).
 *
 * Strips `--background` and `--follow` from args before paramBuilder
 * runs so the param shape stays clean. On submit failure, prints stderr
 * + exits 1 (no orphan job; no silent fallthrough to inline).
 *
 * @returns true if backgrounded (caller MUST exit), false otherwise.
 */
export async function maybeBackground(opts: MaybeBackgroundOpts): Promise<boolean> {
  if (!opts.args.includes('--background')) return false;

  const filtered = opts.args.filter((a) => a !== '--background' && a !== '--follow');
  const params = opts.paramBuilder(filtered);
  const follow = opts.args.includes('--follow');
  const source = opts.source ?? 'cli';

  // PGLite has no worker daemon. Per the doc-stated semantics, degrade
  // to inline with a clear stderr note rather than silently failing.
  if (opts.engine.kind === 'pglite') {
    process.stderr.write(
      `[--background] PGLite has no worker daemon; running inline.\n`,
    );
    return false;  // caller runs inline
  }

  // D9: content-hash idempotency key. No time-slot — same intent = same
  // key. Failed-row replay is the doctor --remediate loop's job, not
  // the CLI --background path's job.
  const idempotency_key = `${source}:${opts.jobName}:${sha8(canonicalJson(params))}`;

  try {
    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(opts.engine);
    const job = await queue.add(opts.jobName, params, {
      queue: 'default',
      idempotency_key,
      max_attempts: 2,
    });
    process.stdout.write(`job_id=${job.id}\n`);

    if (follow) {
      // exec `gbrain jobs follow <id>` so the user sees live stream
      // without losing the durable-queue submission.
      const { spawn } = await import('child_process');
      const cmd = process.argv[0] ?? 'bun';
      const script = process.argv[1] ?? '';
      const child = spawn(cmd, [script, 'jobs', 'follow', String(job.id)], {
        stdio: 'inherit',
      });
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    }
    return true;  // caller exits
  } catch (e) {
    process.stderr.write(`[--background] submit failed: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
