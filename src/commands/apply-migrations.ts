/**
 * `gbrain apply-migrations` — migration runner CLI.
 *
 * Reads ~/.gbrain/migrations/completed.jsonl, diffs against the TS migration
 * registry, runs any pending orchestrators. Resumes `status: "partial"`
 * entries (stopgap bash script writes these). Idempotent: rerunning is
 * cheap when nothing is pending.
 *
 * Invoked from:
 *   - `gbrain upgrade` → runPostUpgrade() tail (Lane A-5)
 *   - package.json `postinstall` (Lane A-5)
 *   - explicit user / host-agent after registering new handlers (Lane C-1)
 */

import { VERSION } from '../version.ts';
import type { BrainEngine } from '../core/engine.ts';
import { gbrainPath, loadConfig } from '../core/config.ts';
import { LiveServeLockError, PgliteBusyError, peekLock } from '../core/pglite-lock.ts';
import {
  acquireMigrationOrchestrationLock,
  MIGRATIONS_RUNNING_EXIT_CODE,
  MigrationsRunningError,
  type MigrationOrchestrationLock,
} from '../core/migration-orchestration-lock.ts';
import { loadCompletedMigrations, appendCompletedMigration, type CompletedMigrationEntry } from '../core/preferences.ts';
import { migrations, compareVersions, type Migration, type OrchestratorOpts } from './migrations/index.ts';
import {
  indexCompletedEntries,
  statusForVersion as ledgerStatusForVersion,
  freshInstallVersion,
  isFreshInstallStamp,
  isPendingFreshInstall,
  MAX_CONSECUTIVE_PARTIALS,
} from '../core/migration-ledger.ts';
import { shellQuote, type Effect } from '../core/agent-output.ts';
import { writeJsonDocument } from '../core/cli-force-exit.ts';
import { consentGate } from '../core/consent-cli.ts';
import { opError, type OperationError } from '../core/ops/contract.ts';
import { exitCliError, usageError, writeCliError } from '../cli/cli-error.ts';

interface ApplyMigrationsArgs {
  list: boolean;
  dryRun: boolean;
  json: boolean;
  dbOnlyExport?: OrchestratorOpts['dbOnlyExport'];
  acceptReviewedInventory?: OrchestratorOpts['acceptReviewedInventory'];
  yes: boolean;
  nonInteractive: boolean;
  mode?: 'always' | 'pain_triggered' | 'off';
  specificMigration?: string;
  hostDir?: string;
  noAutopilotInstall: boolean;
  /** Bug 3 — explicit reset for a wedged migration. Writes a 'retry' marker. */
  forceRetry?: string;
  /**
   * v0.30.1 namespaced --force flags (codex T5):
   *   --force-orchestrator: write 'retry' markers for ALL wedged orchestrator migrations
   *   --force-schema:       reset schema-version drift (re-run runMigrations)
   *   --force-all:          both
   */
  forceOrchestrator?: boolean;
  forceSchema?: boolean;
  forceAll?: boolean;
  /** v0.30.1 (D6 / X3): bypass verify-hook drift detection on a single run. */
  skipVerify?: boolean;
  /** #4364: exit 1 when the DB pre-flight probe fails instead of proceeding filesystem-only. */
  requireDb: boolean;
  help: boolean;
}

function parseArgs(args: string[]): ApplyMigrationsArgs {
  const has = (flag: string) => args.includes(flag);
  const val = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const mode = val('--mode') as ApplyMigrationsArgs['mode'];
  const exporting = has('--export-db-only');
  if (exporting && !val('--content-root') || has('--backup-confirmed') && has('--acknowledge-no-backup')) {
    exitCliError(usageError('DB-only export requires --content-root and exactly one explicit backup choice for a non-dry run.',
      'Example: gbrain apply-migrations --migration <version> --export-db-only --content-root <path> --backup-confirmed --dry-run --json'), COMMAND);
  }
  const accepted: Record<string, string> = {};
  args.forEach((arg, i) => {
    if (arg !== '--accept-reviewed-inventory') return;
    const match = /^([^=\s]+)=([a-f0-9]{64})$/.exec(args[i + 1] ?? '');
    if (!match) exitCliError(usageError('--accept-reviewed-inventory takes <source-id>=<64-hex inventory digest>, copied from the migration\'s conflict message.',
      'Example: gbrain apply-migrations --migration 0.53.0 --accept-reviewed-inventory default=<digest> --yes'), COMMAND);
    accepted[match![1]] = match![2];
  });
  if (mode && !['always', 'pain_triggered', 'off'].includes(mode)) {
    exitCliError(usageError(`Invalid --mode "${mode}". Allowed: always, pain_triggered, off.`,
      'Example: gbrain apply-migrations --yes --mode pain_triggered'), COMMAND);
  }
  return {
    list: has('--list'),
    dryRun: has('--dry-run'),
    json: has('--json'),
    dbOnlyExport: exporting ? { root: val('--content-root')!, sourceId: val('--export-source') ?? 'default',
      confirmQuiesced: has('--confirm-quiesced'),
      backup: has('--backup-confirmed') ? 'operator_verified' : has('--acknowledge-no-backup') ? 'acknowledged_unprotected' : undefined } : undefined,
    ...(Object.keys(accepted).length ? { acceptReviewedInventory: accepted } : {}),
    yes: has('--yes'),
    nonInteractive: has('--non-interactive'),
    mode,
    specificMigration: val('--migration'),
    hostDir: val('--host-dir'),
    noAutopilotInstall: has('--no-autopilot-install') || process.env.GBRAIN_NO_AUTOPILOT_INSTALL === '1',
    forceRetry: val('--force-retry'),
    forceOrchestrator: has('--force-orchestrator'),
    forceSchema: has('--force-schema'),
    forceAll: has('--force-all') || has('--force'),
    skipVerify: has('--skip-verify'),
    requireDb: has('--require-db'),
    help: has('--help') || has('-h'),
  };
}

function printHelp(): void {
  console.log(`gbrain apply-migrations — run pending migration orchestrators.

Usage:
  gbrain apply-migrations                Run all pending migrations interactively.
  gbrain apply-migrations --yes          Non-interactive; uses default mode (pain_triggered).
  gbrain apply-migrations --dry-run      Print the plan; take no action.
  gbrain apply-migrations --dry-run --json
                                        Include read-only content inventories and conflicts.
  gbrain apply-migrations --migration 0.53.0 --export-db-only --content-root <path>
    [--export-source <id>] --dry-run --json
                                        Preview a lossless host-side DB-only content export.
    --confirm-quiesced                   Attest old writers and skill servers are stopped.
    --backup-confirmed                   Attest an operational backup was verified by you.
    --acknowledge-no-backup               Explicitly proceed without a verified backup.
  gbrain apply-migrations --migration 0.53.0 --accept-reviewed-inventory <source>=<digest> --yes
                                        Accept a skill-pack change the user reviewed; the
                                        digest comes from the conflict message and stops
                                        matching if the files change again. Repeatable.
  gbrain apply-migrations --list [--json]
                                         Show applied + pending migrations.
                                         pending_fresh_install = setup work a
                                         brain created by gbrain init has not
                                         run yet (expected; apply with --yes).
  gbrain apply-migrations --migration vX.Y.Z
                                         Force-run a specific migration by version.
  gbrain apply-migrations --force-retry vX.Y.Z
                                         Clear a wedged migration (3+ consecutive
                                         partials). Writes a 'retry' marker so the
                                         next run treats it as fresh.
  gbrain apply-migrations --force-orchestrator
                                         Reset every wedged orchestrator migration
                                         in one shot (writes 'retry' for each).
  gbrain apply-migrations --force-schema
                                         Reset schema-version drift; re-runs
                                         runMigrations from current config.version.
  gbrain apply-migrations --force        (alias --force-all) Apply both
                                         --force-orchestrator and --force-schema.
  gbrain apply-migrations --skip-verify  Bypass post-condition verify hooks on
                                         non-idempotent migrations (D6 escape hatch).

Flags:
  --require-db                           Exit 1 when the database is unreachable
                                         instead of continuing with the
                                         filesystem-only migration plan.
  --mode <always|pain_triggered|off>     Set minion_mode without prompting.
  --host-dir <path>                      Include this directory in host-file walk
                                         (default scope: \$HOME/.claude + \$HOME/.openclaw).
  --no-autopilot-install                 Skip the Phase F autopilot install step.
                                         Also: GBRAIN_NO_AUTOPILOT_INSTALL=1.
  --non-interactive                      Never prompt; authorizes only the autopilot
                                         install (persistent_install), like --yes.
  --json                                 One JSON document on stdout (failures: the
                                         error envelope with code + suggestion).

Exit codes:
  0  Success (including "nothing to do").
  1  An orchestrator failed, or schema migrations are pending (apply them with --yes).
  2  Invalid arguments.
  3  confirmation_required: a migration installs the autopilot service and the
     user has not approved it (--yes, --non-interactive or a preapproval).
  75 Another apply-migrations run holds the orchestration lock.
`);
}

interface CompletedIndex {
  byVersion: Map<string, CompletedMigrationEntry[]>;
  /** The version whose `gbrain init` created this brain (fresh-install stamps), or null. */
  freshVersion: string | null;
}

// Ledger status logic moved to src/core/migration-ledger.ts (shared with the
// get_health op's migrations block, TODOS:4063) — same semantics, same Bug 3
// "complete wins / trailing retry overrides / consecutive-partial cap" rules.
function indexCompleted(entries: CompletedMigrationEntry[]): CompletedIndex {
  return { byVersion: indexCompletedEntries(entries), freshVersion: freshInstallVersion(entries) };
}

function statusForVersion(
  version: string,
  idx: CompletedIndex,
): 'complete' | 'partial' | 'pending' | 'wedged' {
  return ledgerStatusForVersion(version, idx.byVersion);
}

interface Plan {
  applied: Migration[];
  partial: Migration[];
  pending: Migration[];
  /** Never run on a brain gbrain init created at or after its version: expected setup work, not an interrupted upgrade. */
  pending_fresh_install: Migration[];
  skippedFuture: Migration[];
  wedged: Migration[];
}

/**
 * Build the run plan.
 *
 * - applied:  has a `status: "complete"` entry for its version.
 * - partial:  has only `status: "partial"` entries (stopgap wrote one) →
 *             orchestrator runs to finish missing phases.
 * - pending:  has no entries at all and migration.version ≤ installed VERSION.
 * - pending_fresh_install: pending, on a brain `gbrain init` created at or
 *             after this version (fresh-install stamps). Runs like pending.
 * - skippedFuture: migration.version > installed VERSION (binary is older
 *                  than the migration; wait for a newer install).
 *
 * Codex H9: we never compare against `current VERSION >` — that rule would
 * skip v0.11.0 when running v0.11.1. Compare against completed.jsonl.
 */
function buildPlan(idx: CompletedIndex, installed: string, filterVersion?: string): Plan {
  const plan: Plan = { applied: [], partial: [], pending: [], pending_fresh_install: [], skippedFuture: [], wedged: [] };
  for (const m of migrations) {
    if (filterVersion && m.version !== filterVersion) continue;
    if (compareVersions(m.version, installed) > 0) {
      plan.skippedFuture.push(m);
      continue;
    }
    const status = statusForVersion(m.version, idx);
    if (status === 'complete') plan.applied.push(m);
    else if (status === 'partial') plan.partial.push(m);
    else if (status === 'wedged') plan.wedged.push(m);
    else if (isPendingFreshInstall(m.version, idx.freshVersion)) plan.pending_fresh_install.push(m);
    else plan.pending.push(m);
  }
  return plan;
}

/**
 * #4364: pre-flight DB probe outcome. Surfaced on --list/--dry-run so an
 * unreachable database is distinguishable from a clean one — both used to
 * print the identical all-pending plan at exit 0.
 */
type DbProbeOutcome =
  | { status: 'connected'; schemaVer: number; latest: number }
  | { status: 'unreachable'; reason: string }
  | { status: 'skipped'; reason: string };

function formatDbProbeLine(probe: DbProbeOutcome): string {
  if (probe.status === 'connected') {
    return `Database: connected, schema v${probe.schemaVer} (latest ${probe.latest})`;
  }
  if (probe.status === 'unreachable') {
    return `Database: UNREACHABLE (${probe.reason})`;
  }
  return `Database: not probed (${probe.reason})`;
}

const FINISH_SETUP_ARGV = ['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'];

function listRows(plan: Plan): Array<{ status: string; m: Migration }> {
  return [
    ...plan.applied.map(m => ({ status: 'applied', m })),
    ...plan.partial.map(m => ({ status: 'partial', m })),
    ...plan.wedged.map(m => ({ status: 'wedged', m })),
    ...plan.pending.map(m => ({ status: 'pending', m })),
    ...plan.pending_fresh_install.map(m => ({ status: 'pending_fresh_install', m })),
    ...plan.skippedFuture.map(m => ({ status: 'future', m })),
  ];
}

function printList(plan: Plan, installed: string, dbProbe: DbProbeOutcome): void {
  console.log(`Installed gbrain version: ${installed}`);
  console.log(`${formatDbProbeLine(dbProbe)}\n`);
  console.log('  Status                 Version   Headline');
  console.log('  ---------------------  --------  -----------------------------------------');
  const rows = listRows(plan);
  for (const r of rows) {
    const ver = r.m.version.padEnd(8);
    const status = r.status.padEnd(21);
    console.log(`  ${status}  ${ver}  ${r.m.featurePitch.headline}`);
  }
  if (rows.length === 0) console.log('  (no migrations registered)');
  console.log('');
  const needsWork = plan.pending.length + plan.partial.length;
  const setup = plan.pending_fresh_install.length;
  if (needsWork === 0 && setup === 0) {
    console.log('All migrations up to date.');
    return;
  }
  if (needsWork > 0) console.log(`${needsWork} migration(s) need action. Run \`gbrain apply-migrations --yes\` to apply.`);
  if (setup > 0) {
    console.log(`${setup} setup migration(s) are pending_fresh_install: this brain was created by gbrain init and has not run them yet. `
      + `This is expected setup work, not a failed upgrade. Finish setup: ${shellQuote(FINISH_SETUP_ARGV)}`);
  }
}

/** `--list --json` fields: one row per registered migration plus the command that completes outstanding work. */
function listJson(plan: Plan, idx: CompletedIndex, installed: string, dbProbe: DbProbeOutcome): Record<string, unknown> {
  const outstanding = plan.pending.length + plan.partial.length + plan.pending_fresh_install.length;
  return {
    installed,
    database: dbProbe,
    fresh_install_version: idx.freshVersion,
    migrations: listRows(plan).map(r => ({
      version: r.m.version,
      status: r.status,
      headline: r.m.featurePitch.headline,
      ...(r.status === 'applied' && (idx.byVersion.get(r.m.version) ?? []).some(isFreshInstallStamp) ? { fresh_install: true } : {}),
    })),
    needs_action: plan.pending.length + plan.partial.length,
    pending_fresh_install: plan.pending_fresh_install.length,
    ...(outstanding > 0 ? { next: { argv: FINISH_SETUP_ARGV, command: shellQuote(FINISH_SETUP_ARGV) } } : {}),
  };
}

function printDryRun(plan: Plan, installed: string, dbProbe: DbProbeOutcome): void {
  console.log(`Dry run — installed gbrain version: ${installed}`);
  console.log(formatDbProbeLine(dbProbe));
  console.log('');
  if (plan.applied.length) {
    console.log('Already applied:');
    for (const m of plan.applied) console.log(`  ✓ v${m.version} — ${m.featurePitch.headline}`);
    console.log('');
  }
  if (plan.partial.length) {
    console.log('Would RESUME (previously partial):');
    for (const m of plan.partial) console.log(`  ⟳ v${m.version} — ${m.featurePitch.headline}`);
    console.log('');
  }
  if (plan.pending.length) {
    console.log('Would APPLY:');
    for (const m of plan.pending) console.log(`  → v${m.version} — ${m.featurePitch.headline}`);
    console.log('');
  }
  if (plan.pending_fresh_install.length) {
    console.log('Would APPLY (pending_fresh_install — setup a brain created by gbrain init has not run yet; expected, not a failed upgrade):');
    for (const m of plan.pending_fresh_install) console.log(`  → v${m.version} — ${m.featurePitch.headline}`);
    console.log('');
  }
  if (plan.skippedFuture.length) {
    console.log('Skipped (newer than installed binary):');
    for (const m of plan.skippedFuture) console.log(`  ⧗ v${m.version}`);
    console.log('');
  }
  if (plan.pending.length + plan.partial.length + plan.pending_fresh_install.length === 0) {
    console.log('Nothing to do.');
  } else {
    console.log('Re-run without --dry-run to apply. Use --yes to skip prompts.');
  }
}

/**
 * #1530: schema-drift pre-flight resolution. When the schema version is
 * behind, `--yes`/`--non-interactive` runs the schema migrations right there
 * (the engine is already connected); interactive runs warn and return true so
 * the caller exits non-zero instead of claiming "All migrations up to date".
 * All output goes to stderr (migrations never print to stdout).
 *
 * Returns true when the schema is STILL behind after this call.
 */
async function resolveSchemaBehind(opts: {
  schemaVer: number;
  latest: number;
  autoApply: boolean;
  run: () => Promise<{ applied: number; current: number }>;
}): Promise<boolean> {
  const { schemaVer, latest, autoApply, run } = opts;
  if (schemaVer >= latest) return false;
  if (autoApply) {
    console.error(`Schema version ${schemaVer} is behind latest ${latest}; running schema migrations...`);
    try {
      const result = await run();
      console.error(`Applied ${result.applied} schema migration(s); now at v${result.current}.`);
      return false;
    } catch (err) {
      console.error(`Schema migration failed: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  }
  console.warn(
    `\n⚠️  Schema version ${schemaVer} is behind latest ${latest}.\n` +
    `   Run \`gbrain apply-migrations --yes\` to apply now, or \`gbrain init --migrate-only\`.\n`,
  );
  return true;
}

function orchestratorOptsFrom(cli: ApplyMigrationsArgs, ownLeaseToken?: string): OrchestratorOpts {
  return {
    yes: cli.yes || cli.nonInteractive,
    mode: cli.mode,
    dryRun: cli.dryRun,
    hostDir: cli.hostDir,
    noAutopilotInstall: cli.noAutopilotInstall,
    dbOnlyExport: cli.dbOnlyExport && { ...cli.dbOnlyExport, ownLeaseToken },
    ...(cli.acceptReviewedInventory ? { acceptReviewedInventory: cli.acceptReviewedInventory } : {}),
  };
}

const COMMAND = 'apply-migrations';

/**
 * D2: what a run reports. `doc` is the `--json` success document (and the
 * legacy keys a failure envelope leads with); `failure` is the typed error a
 * non-zero exit renders (`Error [code]` / `Fix:` on stderr, the envelope
 * under `--json`).
 */
interface RunReport {
  doc: Record<string, unknown>;
  failure?: OperationError;
}

function unknownMigrationError(version: string): OperationError {
  return usageError(`No migration registered with version "${version}".`,
    'Run `gbrain apply-migrations --list` to see registered versions.',
    { fix: { argv: ['gbrain', COMMAND, '--list'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists every registered migration and its status.' } });
}

/** The same invocation again once the underlying failure is fixed; any approval it needs is asked by the run itself. */
function rerunFix(args: readonly string[], why: string, yes = false) {
  // Approval flags are dropped: the rerun asks for any consent effect itself.
  const argv = ['gbrain', COMMAND, ...args.filter(a => a !== '--yes' && a !== '--non-interactive'), ...(yes ? ['--yes'] : [])];
  return { argv, consent: [] as Effect[], actor: 'agent' as const, requires_exclusive: true, why };
}

/**
 * Write the run's result and return the exit status. A non-zero status with
 * a typed failure renders it; the consent refusal (3) already wrote its
 * payload. Success under `--json` is the one document.
 */
function finishReport(cli: ApplyMigrationsArgs, report: RunReport, exitCode: number | undefined): number | undefined {
  if (exitCode === 3) return exitCode;
  if (exitCode !== undefined && exitCode !== 0) {
    const failure = report.failure ?? opError('migration_failed', `apply-migrations exited with status ${exitCode}.`,
      'Read the stderr lines above for the failing migration, fix it, then run `gbrain apply-migrations` again.');
    return writeCliError(failure, COMMAND, { json: cli.json, ...(cli.json ? { legacy: report.doc } : {}) });
  }
  if (cli.json) void writeJsonDocument(JSON.stringify(report.doc));
  return exitCode;
}

/**
 * Entry point. Does not call connectEngine — each phase inside an
 * orchestrator manages its own engine / subprocess lifecycle.
 */
export async function runApplyMigrations(args: string[]): Promise<void> {
  const { exitCode } = await applyMigrations(args);
  if (exitCode !== undefined) process.exit(exitCode);
}

/**
 * The run without the process exit, for in-process callers that report the
 * outcome themselves (`post-upgrade --json`). The result (or the failure
 * under --json) is already written; `failure` is the typed error behind a
 * non-zero status.
 */
export async function applyMigrations(args: string[]): Promise<{ exitCode: number | undefined; failure?: OperationError }> {
  const cli = parseArgs(args);
  if (cli.help) { printHelp(); return { exitCode: undefined }; }

  const installed = VERSION.replace(/^v/, '').trim() || '0.0.0';
  const report: RunReport = { doc: { status: 'ok', installed } };

  // First-install guard (postinstall hook calls us even on `bun add gbrain`
  // before the user has run `gbrain init`). No config = no brain = nothing
  // to migrate. Exit silently for --yes / --non-interactive so postinstall
  // stays quiet; mention the init step when invoked interactively.
  const config = loadConfig();
  if (!config) {
    if (cli.json) await writeJsonDocument(JSON.stringify({ status: 'unconfigured', previews: [], message: 'No brain configured; nothing to migrate.' }));
    else if (cli.list) console.log('No brain configured. Run `gbrain init` to set one up.');
    else if (cli.dryRun) console.log('No brain configured (run `gbrain init` first). Nothing to migrate.');
    return { exitCode: undefined };
  }

  if (cli.dryRun && (cli.forceRetry || cli.forceOrchestrator || cli.forceSchema || cli.forceAll)) {
    const would: string[] = [];
    if (cli.forceRetry) {
      if (!migrations.some(m => m.version === cli.forceRetry)) exitCliError(unknownMigrationError(cli.forceRetry), COMMAND, { json: cli.json });
      would.push(`write a 'retry' marker for v${cli.forceRetry}`);
      console.log(`[dry-run] Would write a 'retry' marker for v${cli.forceRetry}. No ledger or database changes made.`);
    } else {
      if (cli.forceOrchestrator || cli.forceAll) {
        would.push("write 'retry' markers for wedged orchestrator migrations");
        console.log("[dry-run] Would write 'retry' markers for wedged orchestrator migrations. No ledger changes made.");
      }
      if (cli.forceSchema || cli.forceAll) {
        would.push('run schema migrations from current config.version');
        console.log('[dry-run] Would run schema migrations from current config.version. Database not opened; no schema changes made.');
      }
    }
    if (cli.json) await writeJsonDocument(JSON.stringify({ status: 'dry_run', installed, would, changed: false }));
    return { exitCode: undefined };
  }

  // #5693: one runner orchestrates at a time. --list and --dry-run are
  // read-only and never take the lock.
  const held: { lock: MigrationOrchestrationLock | null } = { lock: null };
  const holdLock = async (): Promise<void> => {
    if (cli.list || cli.dryRun) return;
    if (held.lock) { await held.lock.assertHeld(); return; }
    held.lock = await acquireMigrationOrchestrationLock(config);
  };
  let exitCode: number | undefined;
  try {
    await holdLock();
    exitCode = await runLockedMigrations(cli, installed, holdLock, () => held.lock, report, args);
  } catch (error) {
    if (!(error instanceof MigrationsRunningError)) throw error;
    console.error(`apply-migrations refused: ${error.message}`);
    report.doc.status = 'refused';
    report.failure = opError('migrations_running', error.message,
      'Wait for the other apply-migrations run to finish, then run `gbrain apply-migrations` again (it resumes where that run stopped).');
    exitCode = MIGRATIONS_RUNNING_EXIT_CODE;
  } finally {
    await held.lock?.release();
  }
  return { exitCode: finishReport(cli, report, exitCode), ...(report.failure ? { failure: report.failure } : {}) };
}

/**
 * Everything that mutates the ledger or the database runs here, under the
 * orchestration lock. Returns the process exit status instead of exiting so
 * the caller releases the lock first.
 */
async function runLockedMigrations(
  cli: ReturnType<typeof parseArgs>,
  installed: string,
  holdLock: () => Promise<void>,
  heldLock: () => MigrationOrchestrationLock | null,
  report: RunReport,
  args: readonly string[],
): Promise<number | undefined> {
  const { doc } = report;
  const fail = (status: string, failure: OperationError): void => { doc.status = status; report.failure = failure; };
  // Without the orchestration lease (a schema too old for it), schema work goes
  // through initSchema(), which serializes on the schema lock.
  const migrateSchema = async (eng: BrainEngine, from: number): Promise<{ applied: number; current: number }> => {
    if (heldLock()) { const { runMigrations } = await import('../core/migrate.ts'); return runMigrations(eng); }
    await eng.initSchema();
    const current = parseInt(await eng.getConfig('version') || String(from), 10);
    return { applied: Math.max(0, current - from), current };
  };
  // Bug 3 — --force-retry: write an explicit reset marker for a wedged
  // migration, then return. User re-runs `gbrain apply-migrations --yes`
  // to actually re-attempt.
  if (cli.forceRetry) {
    const target = migrations.find(m => m.version === cli.forceRetry);
    if (!target) {
      fail('invalid', unknownMigrationError(cli.forceRetry));
      return 2;
    }
    appendCompletedMigration({ version: cli.forceRetry, status: 'retry' });
    doc.retry_markers = [cli.forceRetry];
    console.log(`Wrote 'retry' marker for v${cli.forceRetry}. Run \`gbrain apply-migrations --yes\` to re-attempt.`);
    return;
  }

  // v0.30.1 (codex T5): --force-orchestrator OR --force-all writes a 'retry'
  // marker for EVERY wedged orchestrator migration in one shot. User re-runs
  // `gbrain apply-migrations --yes` to actually re-attempt.
  if (cli.forceOrchestrator || cli.forceAll) {
    const completed = loadCompletedMigrations();
    const idx = indexCompleted(completed);
    let resetCount = 0;
    const markers: string[] = [];
    doc.retry_markers = markers;
    for (const m of migrations) {
      const status = statusForVersion(m.version, idx);
      if (status === 'wedged') {
        appendCompletedMigration({ version: m.version, status: 'retry' });
        markers.push(m.version);
        console.log(`Wrote 'retry' marker for v${m.version} (${m.featurePitch.headline.slice(0, 60)})`);
        resetCount++;
      }
    }
    if (resetCount === 0) {
      console.log('No wedged orchestrator migrations found.');
    } else {
      console.log(`\nReset ${resetCount} wedged orchestrator migration(s). Run \`gbrain apply-migrations --yes\` to re-attempt.`);
    }
    if (!cli.forceAll) return; // --force-schema continues below if --force-all is set
  }

  // v0.30.1 (codex T5): --force-schema OR --force-all resets schema-version
  // drift by re-running runMigrations(). When the actual DDL state diverges
  // from config.version (the brain_config incident), this is the manual
  // recovery path.
  if (cli.forceSchema || cli.forceAll) {
    try {
      const { loadConfig: lc, toEngineConfig } = await import('../core/config.ts');
      const { createEngine } = await import('../core/engine-factory.ts');
      const cfg = lc();
      if (!cfg) {
        console.error('No brain configured for --force-schema.');
        fail('failed', opError('no_brain', 'No brain configured for --force-schema.', 'Create a brain first: `gbrain init` (`gbrain init --help` lists the options).'));
        return 2;
      }
      const eng = await createEngine(toEngineConfig(cfg));
      await eng.connect(toEngineConfig(cfg));
      console.log('Running schema migrations from current config.version...');
      const result = await migrateSchema(eng, parseInt(await eng.getConfig('version') || '1', 10));
      console.log(`Applied ${result.applied} schema migration(s); now at v${result.current}.`);
      doc.schema = result;
      await eng.disconnect();
    } catch (err) {
      console.error(`--force-schema failed: ${(err as Error).message}`);
      fail('failed', opError('migration_failed', `--force-schema failed: ${(err as Error).message}`,
        'Fix the database error above, then run `gbrain apply-migrations --force-schema` again.', { reason: 'schema_failed' }));
      return 1;
    }
    if (cli.forceSchema && !cli.forceAll) return;
    if (cli.forceAll) return; // both surfaces flushed
  }

  // Pre-flight: schema drift (#1530) and the DB probe (#4364); see preflightSchema.
  const { schemaBehind, dbProbe } = await preflightSchema(cli, migrateSchema);

  const completed = loadCompletedMigrations();
  const idx = indexCompleted(completed);
  const plan = buildPlan(idx, installed, cli.specificMigration);

  doc.database = dbProbe;
  doc.plan = Object.fromEntries(Object.entries(plan).map(([state, entries]) => [state, entries.map((migration: Migration) => migration.version)]));
  // Bug 3 — surface wedged migrations as a loud, actionable error.
  if (plan.wedged.length > 0) {
    for (const m of plan.wedged) {
      console.error(
        `\nMigration v${m.version} is WEDGED (${MAX_CONSECUTIVE_PARTIALS}+ consecutive partials with no completion). ` +
        `Check ~/.gbrain/upgrade-errors.jsonl for the last failure reasons, fix the underlying issue, then run:\n` +
        `  gbrain apply-migrations --force-retry ${m.version}\n` +
        `Then run \`gbrain apply-migrations\` again (it asks for any approval the migration needs).`,
      );
    }
    // Don't exit — applied/partial/pending are still worth reporting and running.
  }

  if (cli.specificMigration && plan.applied.length + plan.partial.length + plan.pending.length + plan.pending_fresh_install.length + plan.skippedFuture.length === 0) {
    console.error(`No migration registered with version "${cli.specificMigration}". Run \`gbrain apply-migrations --list\` to see registered versions.`);
    fail('invalid', unknownMigrationError(cli.specificMigration));
    return 2;
  }

  // #4364: --require-db turns an unreachable DB into a hard failure instead
  // of a filesystem-only plan that renders identically to a clean database.
  const listExit = cli.requireDb && dbProbe.status === 'unreachable' ? 1 : 0;
  if (listExit) fail('database_unreachable', requireDbError(dbProbe));
  if (cli.list && cli.json) { Object.assign(doc, listJson(plan, idx, installed, dbProbe)); doc.status = listExit ? doc.status : 'listed'; return listExit; }
  if (cli.list) { printList(plan, installed, dbProbe); return listExit; }
  if (cli.dryRun) {
    const previews: Array<{ version: string; preview?: unknown; error?: string }> = [];
    for (const migration of [...plan.applied, ...plan.partial, ...plan.pending, ...plan.pending_fresh_install, ...plan.wedged]) {
      if (!migration.preview) continue;
      try { previews.push({ version: migration.version, preview: await migration.preview(orchestratorOptsFrom(cli)) }); }
      catch (error) { previews.push({ version: migration.version, error: error instanceof Error ? error.message : 'Inventory unavailable.' }); }
    }
    doc.previews = previews;
    if (!listExit) doc.status = 'dry_run';
    if (!cli.json) {
      printDryRun(plan, installed, dbProbe);
      for (const preview of previews) console.log(JSON.stringify(preview));
    }
    const failedPreview = previews.find(preview => preview.error);
    if (!listExit && failedPreview) fail('preview_failed', opError('migration_failed', `The v${failedPreview.version} preview could not be computed: ${failedPreview.error}`,
      'Read the previews array for the failing inventory, fix it, then preview again with `gbrain apply-migrations --dry-run --json`.', { reason: 'preview_failed' }));
    return listExit || (previews.some(preview => preview.error) ? 1 : 0);
  }
  if (cli.requireDb && dbProbe.status === 'unreachable') {
    console.error(formatDbProbeLine(dbProbe));
    console.error('--require-db: database is unreachable; aborting before orchestrators run.');
    return 1;
  }

  // A Postgres schema without gbrain_cycle_locks had no lease yet; the
  // preflight above created the table, so take the lease before orchestrating.
  await holdLock();

  const toRun: Migration[] = [...plan.partial, ...plan.pending, ...plan.pending_fresh_install, ...plan.applied.filter(migration => migration.reconcile)]
    .sort((left, right) => compareVersions(left.version, right.version));
  if (toRun.length === 0) {
    if (schemaBehind) {
      console.error(
        'Orchestrator migrations are up to date, but schema migrations are behind. ' +
        'Run `gbrain apply-migrations --yes` (or `--force-schema`) to apply them.',
      );
      fail('schema_behind', schemaBehindError(args));
      return 1;
    }
    console.log('All migrations up to date.');
    doc.status = 'up_to_date';
    return 0;
  }
  if (!schemaBehind && plan.pending.length === 0 && plan.pending_fresh_install.length === 0 && plan.partial.length === 0) {
    console.log('All migrations up to date. This covers orchestrator checkpoints only; host publication and client activation are being rechecked.');
  }

  // A4: a migration whose orchestrator performs a consent effect (v0.11.0's
  // autopilot service install) runs only once it is authorized: --yes, the
  // --non-interactive mapping (persistent_install only), a preapproval, or a
  // TTY prompt. Refused: nothing runs, exit 3 with the consent payload.
  const consent = migrationConsentRequest(cli, toRun, args);
  if (consent && !(await consentGate(consent, { json: cli.json }))) {
    doc.status = 'confirmation_required';
    return 3;
  }

  // A7: the orchestrators need a PGLite brain to themselves. With a live serve owning it
  // every phase fails and a partial attempt is recorded against the retry cap, so refuse
  // up front: the fatal seam prints the two-step plan (stop the owner, re-run this command).
  const owned = loadConfig();
  if (owned?.engine === 'pglite' && !owned.database_url) {
    const peek = peekLock(owned.database_path ?? gbrainPath('brain.pglite'));
    if (peek.held && peek.isServe && peek.pid !== undefined && peek.pid !== process.pid) {
      throw new LiveServeLockError(`GBrain's local database is already open through \`gbrain serve\` (MCP, PID ${peek.pid}); apply-migrations needs it to itself. Nothing was applied.`,
        { pid: peek.pid, transport: peek.http ? 'http' : 'stdio' });
    }
  }

  // Run each orchestrator in registry order. An orchestrator failure aborts
  // the rest of the chain; fixing the failure and re-running picks up where
  // we left off (per-phase idempotency markers + resume from "partial").
  //
  // Bug 3 — the RUNNER owns the ledger write now. Orchestrators return their
  // result; we persist it here with a canonical shape. If the write fails,
  // surface the error and DO NOT proceed to the next migration (a silent
  // ledger drop was the root cause of the original infinite-retry symptom).
  let failed = false;
  const results: Array<{ version: string; status: string }> = [];
  doc.results = results;
  for (const m of toRun) {
    // A lease lost while an earlier orchestrator ran stops the chain here.
    await holdLock();
    const recordCheckpoint = !m.reconcile || !plan.applied.includes(m);
    console.log(`\n=== Applying migration v${m.version}: ${m.featurePitch.headline} ===`);
    try {
      const result = await m.orchestrator(orchestratorOptsFrom(cli, heldLock()?.leaseToken));
      for (const p of result.phases) if (p.argv) console.log(`  ${p.name} — next step: ${shellQuote(p.argv)}`);
      if (result.status === 'failed' || result.phases.some(p => p.status === 'failed')) {
        console.error(result.status === 'failed'
          ? `Migration v${m.version} reported status=failed.`
          : `Migration v${m.version} has failed phases (reported status=${result.status}); recording as partial.`);
        // Surface each failed phase's detail — the ledger records it, but
        // the operator needs it on stderr to act (#921).
        for (const p of result.phases) {
          if (p.status === 'failed') {
            console.error(`  phase ${p.name}: ${p.detail ?? '(no detail)'}`);
          }
        }
        results.push({ version: m.version, status: 'failed' });
        const failedPhases = result.phases.filter(p => p.status === 'failed').map(p => `${p.name}: ${p.detail ?? '(no detail)'}`);
        fail('failed', opError('migration_failed',
          `Migration v${m.version} failed${failedPhases.length ? ` (${failedPhases.join('; ')})` : ''}; the chain stopped there.`,
          'Fix the failing phase named above, then run `gbrain apply-migrations` again; it resumes from this migration.',
          { reason: 'orchestrator_failed', fix: rerunFix(args, `Resumes the chain from v${m.version} once the failing phase is fixed.`) }));
        // Record the attempt as 'partial' (not 'complete') so the cap counts
        // it. Don't let a failed orchestrator look like it never ran.
        try {
          if (recordCheckpoint) appendCompletedMigration({
            version: m.version,
            status: 'partial',
            phases: result.phases,
            files_rewritten: result.files_rewritten,
            autopilot_installed: result.autopilot_installed,
            install_target: result.install_target,
            apply_migrations_pending: result.pending_host_work ? result.pending_host_work > 0 : undefined,
          });
        } catch (e) {
          console.error(`Also: could not persist failure record: ${e instanceof Error ? e.message : String(e)}`);
        }
        failed = true;
        break;
      }

      // Persist the terminal outcome. appendCompletedMigration no-ops when
      // the last entry for this version is already 'complete' (idempotency
      // guard), so repeated clean runs don't spam the ledger.
      try {
        if (recordCheckpoint) appendCompletedMigration({
          version: m.version,
          status: result.status, // 'complete' | 'partial'
          phases: result.phases,
          files_rewritten: result.files_rewritten,
          autopilot_installed: result.autopilot_installed,
          install_target: result.install_target,
          apply_migrations_pending: result.pending_host_work ? result.pending_host_work > 0 : undefined,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Failed to persist ledger entry for v${m.version}: ${msg}. Stopping to prevent silent drift.`);
        fail('failed', opError('migration_failed', `Failed to persist the ledger entry for v${m.version}: ${msg}.`,
          'Check that ~/.gbrain/migrations is writable, then run `gbrain apply-migrations` again.', { reason: 'ledger_write_failed' }));
        failed = true;
        break;
      }

      results.push({ version: m.version, status: result.status });
      if (result.status === 'partial') {
        doc.status = 'partial';
        console.log(`Migration v${m.version} finished as PARTIAL. Run \`gbrain apply-migrations\` again after resolving any pending host-work items.`);
      } else if (m.reconcile && result.pending_host_work) {
        console.log(`Migration v${m.version} mechanical checks complete; host publication or client actions remain pending.`);
      } else {
        console.log(`Migration v${m.version} complete.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Migration v${m.version} threw: ${msg}`);
      if (e instanceof PgliteBusyError) throw e;
      results.push({ version: m.version, status: 'failed' });
      fail('failed', opError('migration_failed', `Migration v${m.version} threw: ${msg}`,
        'Fix the error above, then run `gbrain apply-migrations` again; it resumes from this migration.',
        { reason: 'orchestrator_threw', fix: rerunFix(args, `Resumes the chain from v${m.version} once the error is fixed.`) }));
      // Same partial-on-throw treatment so the cap counts runaway failures.
      try {
        if (recordCheckpoint) appendCompletedMigration({ version: m.version, status: 'partial' });
      } catch { /* swallow ledger-write failure on throw path */ }
      failed = true;
      break;
    }
  }

  if (!failed && schemaBehind) doc.schema_behind = true;
  return failed ? 1 : undefined;
}

/**
 * Pre-flight for runLockedMigrations: detect schema migrations (migrate.ts)
 * being behind and probe the database (moved out of runLockedMigrations to
 * keep it under the function-size limit; behaviour unchanged).
 */
async function preflightSchema(
  cli: ApplyMigrationsArgs,
  migrateSchema: (eng: BrainEngine, from: number) => Promise<{ applied: number; current: number }>,
): Promise<{ schemaBehind: boolean; dbProbe: DbProbeOutcome }> {
  let schemaBehind = false;
  let dbProbe: DbProbeOutcome = { status: 'skipped', reason: 'no probe attempted' };
  // Detect schema migrations (migrate.ts) being behind.
  // apply-migrations historically ran orchestrator migrations only; schema
  // migrations run via connectEngine() / initSchema(). Users expect this CLI
  // to handle everything (Issue 1 from v0.18.0 field report; #1530). With
  // --yes/--non-interactive we apply them here; otherwise we warn and make
  // sure the run does NOT report "All migrations up to date" with exit 0.
  try {
    const { LATEST_VERSION } = await import('../core/migrate.ts');
    const { loadConfig: lc, toEngineConfig } = await import('../core/config.ts');
    const { createEngine } = await import('../core/engine-factory.ts');
    const cfg = lc();
    if (cfg) {
      // v0.36.x #1100: skip the pre-flight warning on PGLite. The probe
      // briefly holds the single-writer lock; if a downstream orchestrator
      // phase spawns `gbrain init --migrate-only` as a subprocess (the
      // legacy v0.11.0 phase A path), the child can race the parent's
      // lock release and hit a 30s timeout. The orchestrators handle
      // schema lifecycle internally on PGLite (phase A routes in-process),
      // so the warning here adds no information for PGLite users.
      const skipPreflight = cfg.engine === 'pglite';
      if (skipPreflight) {
        dbProbe = { status: 'skipped', reason: 'pglite manages schema in-process' };
      } else {
        const eng = await createEngine(toEngineConfig(cfg));
        await eng.connect(toEngineConfig(cfg));
        const verStr = await eng.getConfig('version');
        const schemaVer = parseInt(verStr || '1', 10);
        dbProbe = { status: 'connected', schemaVer, latest: LATEST_VERSION };
        schemaBehind = await resolveSchemaBehind({
          schemaVer,
          latest: LATEST_VERSION,
          // --list and --dry-run are read-only surfaces: never mutate schema
          // even when combined with --yes/--non-interactive.
          autoApply: (cli.yes || cli.nonInteractive) && !cli.dryRun && !cli.list,
          run: () => migrateSchema(eng, schemaVer),
        });
        await eng.disconnect();
      }
    }
  } catch (err) {
    // Non-fatal by default: if DB is unreachable, orchestrator migrations can
    // still run their filesystem-only phases. #4364: keep the (redacted)
    // reason so --list/--dry-run say UNREACHABLE and --require-db fails hard —
    // connect errors are exactly what users paste into issues and CI logs.
    const { redactUrlsInText } = await import('../core/url-redact.ts');
    const { redactConnectionInfo } = await import('../core/audit/redact-connection-info.ts');
    dbProbe = {
      status: 'unreachable',
      reason: redactConnectionInfo(redactUrlsInText(err instanceof Error ? err.message : String(err))),
    };
  }
  return { schemaBehind, dbProbe };
}

function requireDbError(dbProbe: DbProbeOutcome): OperationError {
  return opError('database_error', `${formatDbProbeLine(dbProbe)}; --require-db stops the run before any orchestrator runs.`,
    'Fix the database connection (run `gbrain db-repair` to diagnose it), then run apply-migrations again.',
    { fix: { argv: ['gbrain', 'db-repair', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Diagnoses the database access failure and names the repair.' } });
}

function schemaBehindError(args: readonly string[]): OperationError {
  return opError('migrations_pending', 'Orchestrator migrations are up to date, but schema migrations are behind; this run did not apply them.',
    'Apply them with `gbrain apply-migrations --yes` (or `--force-schema`).',
    { fix: rerunFix(args, 'Applies the pending schema migrations (no consent effect; it migrates the brain\'s own schema).', true) });
}

/**
 * The consent request for the effects `toRun`'s orchestrators perform, or
 * null when none apply (dry runs never reach here). `persistent_install` is
 * dropped when the install is skipped anyway (--no-autopilot-install, PGLite).
 */
function migrationConsentRequest(cli: ApplyMigrationsArgs, toRun: readonly Migration[], args: readonly string[]) {
  const installSkipped = cli.noAutopilotInstall || loadConfig()?.engine === 'pglite';
  const asking = toRun.filter(m => (m.effects ?? []).some(e => e !== 'persistent_install' || !installSkipped));
  const effects = [...new Set(asking.flatMap(m => (m.effects ?? []).filter(e => e !== 'persistent_install' || !installSkipped)))];
  if (effects.length === 0) return null;
  const versions = asking.map(m => `v${m.version}`).join(', ');
  return {
    command: COMMAND, effects, actor: 'agent' as const, args,
    what: `Apply migration ${versions}`,
    why: `Migration ${versions} installs the gbrain autopilot background service (launchd, systemd or cron) so brain maintenance keeps running on a schedule.`,
    risk: 'Adds a persistent background service on this machine. Remove it with `gbrain autopilot --uninstall`, or skip it now with --no-autopilot-install.',
    user_message: 'The gbrain upgrade wants to install the autopilot background service so brain maintenance runs on a schedule. Install it? (If not, migrations can still run without it.)',
    argv: ['gbrain', COMMAND, ...args.filter(a => a !== '--json')],
    preview_argv: ['gbrain', COMMAND, '--dry-run'],
  };
}

/** Exported for unit tests only. Do not use from production code. */
export const __testing = {
  parseArgs,
  buildPlan,
  indexCompleted,
  statusForVersion,
  resolveSchemaBehind,
  formatDbProbeLine,
};
