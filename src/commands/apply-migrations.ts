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
import { loadConfig } from '../core/config.ts';
import { loadCompletedMigrations, appendCompletedMigration, type CompletedMigrationEntry } from '../core/preferences.ts';
import { migrations, compareVersions, type Migration, type OrchestratorOpts } from './migrations/index.ts';

/** Bug 3 — max consecutive partials before we wedge a migration. */
const MAX_CONSECUTIVE_PARTIALS = 3;

interface ApplyMigrationsArgs {
  list: boolean;
  dryRun: boolean;
  yes: boolean;
  nonInteractive: boolean;
  mode?: 'always' | 'pain_triggered' | 'off';
  specificMigration?: string;
  hostDir?: string;
  noAutopilotInstall: boolean;
  /** Bug 3 — explicit reset for a wedged migration. Writes a 'retry' marker. */
  forceRetry?: string;
  help: boolean;
}

function parseArgs(args: string[]): ApplyMigrationsArgs {
  const has = (flag: string) => args.includes(flag);
  const val = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const mode = val('--mode') as ApplyMigrationsArgs['mode'];
  if (mode && !['always', 'pain_triggered', 'off'].includes(mode)) {
    console.error(`Invalid --mode "${mode}". Allowed: always, pain_triggered, off.`);
    process.exit(2);
  }
  return {
    list: has('--list'),
    dryRun: has('--dry-run'),
    yes: has('--yes'),
    nonInteractive: has('--non-interactive'),
    mode,
    specificMigration: val('--migration'),
    hostDir: val('--host-dir'),
    noAutopilotInstall: has('--no-autopilot-install'),
    forceRetry: val('--force-retry'),
    help: has('--help') || has('-h'),
  };
}

function printHelp(): void {
  console.log(`gbrain apply-migrations — run pending migration orchestrators.

Usage:
  gbrain apply-migrations                Run all pending migrations interactively.
  gbrain apply-migrations --yes          Non-interactive; uses default mode (pain_triggered).
  gbrain apply-migrations --dry-run      Print the plan; take no action.
  gbrain apply-migrations --list         Show applied + pending migrations.
  gbrain apply-migrations --migration vX.Y.Z
                                         Force-run a specific migration by version.
  gbrain apply-migrations --force-retry vX.Y.Z
                                         Clear a wedged migration (3+ consecutive
                                         partials). Writes a 'retry' marker so the
                                         next run treats it as fresh.

Flags:
  --mode <always|pain_triggered|off>     Set minion_mode without prompting.
  --host-dir <path>                      Include this directory in host-file walk
                                         (default scope: \$HOME/.claude + \$HOME/.openclaw).
  --no-autopilot-install                 Skip the Phase F autopilot install step.
  --non-interactive                      Equivalent to --yes; never prompt.

Exit codes:
  0  Success (including "nothing to do").
  1  An orchestrator failed.
  2  Invalid arguments.
`);
}

interface CompletedIndex {
  byVersion: Map<string, CompletedMigrationEntry[]>;
}

function indexCompleted(entries: CompletedMigrationEntry[]): CompletedIndex {
  const byVersion = new Map<string, CompletedMigrationEntry[]>();
  for (const e of entries) {
    const list = byVersion.get(e.version) ?? [];
    list.push(e);
    byVersion.set(e.version, list);
  }
  return byVersion.size > 0
    ? { byVersion }
    : { byVersion: new Map() };
}

/**
 * Returns the resolved status for a migration based on its entries.
 *
 * Semantics (Bug 3 — keep "complete wins" safety):
 *   - If any entry is `complete`, the version is complete. Terminal state.
 *   - Otherwise, if the latest entry is `retry`, the version is pending
 *     (user requested a fresh attempt).
 *   - Otherwise, if any entry is `partial`, the version is partial.
 *   - Otherwise, pending.
 *
 * `complete` never regresses. A later accidental `partial` append cannot
 * undo a completed migration.
 */
function statusForVersion(
  version: string,
  idx: CompletedIndex,
): 'complete' | 'partial' | 'pending' | 'wedged' {
  const entries = idx.byVersion.get(version) ?? [];
  if (entries.length === 0) return 'pending';
  if (entries.some(e => e.status === 'complete')) return 'complete';
  const latest = entries[entries.length - 1];
  if (latest.status === 'retry') return 'pending';
  // Bug 3 attempt cap — count consecutive partials from the end (stopping
  // at any 'retry' or 'complete'). If we hit MAX_CONSECUTIVE_PARTIALS,
  // the migration is wedged and needs explicit --force-retry to try again.
  let consecutive = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.status === 'partial') consecutive++;
    else break;
  }
  if (consecutive >= MAX_CONSECUTIVE_PARTIALS) return 'wedged';
  if (entries.some(e => e.status === 'partial')) return 'partial';
  return 'pending';
}

interface Plan {
  applied: Migration[];
  partial: Migration[];
  pending: Migration[];
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
 * - skippedFuture: migration.version > installed VERSION (binary is older
 *                  than the migration; wait for a newer install).
 *
 * Codex H9: we never compare against `current VERSION >` — that rule would
 * skip v0.11.0 when running v0.11.1. Compare against completed.jsonl.
 */
function buildPlan(idx: CompletedIndex, installed: string, filterVersion?: string): Plan {
  const plan: Plan = { applied: [], partial: [], pending: [], skippedFuture: [], wedged: [] };
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
    else plan.pending.push(m);
  }
  return plan;
}

function printList(plan: Plan, installed: string): void {
  console.log(`Installed gbrain version: ${installed}\n`);
  console.log('  Status   Version   Headline');
  console.log('  -------  --------  -----------------------------------------');
  const rows: Array<{ status: string; m: Migration }> = [
    ...plan.applied.map(m => ({ status: 'applied', m })),
    ...plan.partial.map(m => ({ status: 'partial', m })),
    ...plan.wedged.map(m => ({ status: 'wedged', m })),
    ...plan.pending.map(m => ({ status: 'pending', m })),
    ...plan.skippedFuture.map(m => ({ status: 'future', m })),
  ];
  for (const r of rows) {
    const ver = r.m.version.padEnd(8);
    const status = r.status.padEnd(7);
    console.log(`  ${status}  ${ver}  ${r.m.featurePitch.headline}`);
  }
  if (rows.length === 0) console.log('  (no migrations registered)');
  console.log('');
  const needsWork = plan.pending.length + plan.partial.length;
  if (needsWork === 0) {
    console.log('All migrations up to date.');
  } else {
    console.log(`${needsWork} migration(s) need action. Run \`gbrain apply-migrations --yes\` to apply.`);
  }
}

function printDryRun(plan: Plan, installed: string): void {
  console.log(`Dry run — installed gbrain version: ${installed}`);
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
  if (plan.skippedFuture.length) {
    console.log('Skipped (newer than installed binary):');
    for (const m of plan.skippedFuture) console.log(`  ⧗ v${m.version}`);
    console.log('');
  }
  if (plan.pending.length + plan.partial.length === 0) {
    console.log('Nothing to do.');
  } else {
    console.log('Re-run without --dry-run to apply. Use --yes to skip prompts.');
  }
}

function orchestratorOptsFrom(cli: ApplyMigrationsArgs): OrchestratorOpts {
  return {
    yes: cli.yes || cli.nonInteractive,
    mode: cli.mode,
    dryRun: cli.dryRun,
    hostDir: cli.hostDir,
    noAutopilotInstall: cli.noAutopilotInstall,
  };
}

/**
 * Entry point. Does not call connectEngine — each phase inside an
 * orchestrator manages its own engine / subprocess lifecycle.
 */
export async function runApplyMigrations(args: string[]): Promise<void> {
  const cli = parseArgs(args);
  if (cli.help) { printHelp(); return; }

  const installed = VERSION.replace(/^v/, '').trim() || '0.0.0';

  // First-install guard (postinstall hook calls us even on `bun add gbrain`
  // before the user has run `gbrain init`). No config = no brain = nothing
  // to migrate. Exit silently for --yes / --non-interactive so postinstall
  // stays quiet; mention the init step when invoked interactively.
  if (!loadConfig()) {
    if (cli.list) console.log('No brain configured. Run `gbrain init` to set one up.');
    else if (cli.dryRun) console.log('No brain configured (run `gbrain init` first). Nothing to migrate.');
    return;
  }

  // Bug 3 — --force-retry: write an explicit reset marker for a wedged
  // migration, then return. User re-runs `gbrain apply-migrations --yes`
  // to actually re-attempt.
  if (cli.forceRetry) {
    const target = migrations.find(m => m.version === cli.forceRetry);
    if (!target) {
      console.error(`No migration registered with version "${cli.forceRetry}". Run \`gbrain apply-migrations --list\`.`);
      process.exit(2);
    }
    appendCompletedMigration({ version: cli.forceRetry, status: 'retry' });
    console.log(`Wrote 'retry' marker for v${cli.forceRetry}. Run \`gbrain apply-migrations --yes\` to re-attempt.`);
    return;
  }

  const completed = loadCompletedMigrations();
  const idx = indexCompleted(completed);
  const plan = buildPlan(idx, installed, cli.specificMigration);

  // Bug 3 — surface wedged migrations as a loud, actionable error.
  if (plan.wedged.length > 0) {
    for (const m of plan.wedged) {
      console.error(
        `\nMigration v${m.version} is WEDGED (${MAX_CONSECUTIVE_PARTIALS}+ consecutive partials with no completion). ` +
        `Check ~/.gbrain/upgrade-errors.jsonl for the last failure reasons, fix the underlying issue, then run:\n` +
        `  gbrain apply-migrations --force-retry ${m.version}\n` +
        `Then re-run \`gbrain apply-migrations --yes\`.`,
      );
    }
    // Don't exit — applied/partial/pending are still worth reporting and running.
  }

  if (cli.specificMigration && plan.applied.length + plan.partial.length + plan.pending.length + plan.skippedFuture.length === 0) {
    console.error(`No migration registered with version "${cli.specificMigration}". Run \`gbrain apply-migrations --list\` to see registered versions.`);
    process.exit(2);
  }

  if (cli.list) { printList(plan, installed); return; }
  if (cli.dryRun) { printDryRun(plan, installed); return; }

  const toRun: Migration[] = [...plan.partial, ...plan.pending];
  if (toRun.length === 0) {
    console.log('All migrations up to date.');
    return;
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
  for (const m of toRun) {
    console.log(`\n=== Applying migration v${m.version}: ${m.featurePitch.headline} ===`);
    try {
      const result = await m.orchestrator(orchestratorOptsFrom(cli));
      if (result.status === 'failed') {
        console.error(`Migration v${m.version} reported status=failed.`);
        // Record the attempt as 'partial' (not 'complete') so the cap counts
        // it. Don't let a failed orchestrator look like it never ran.
        try {
          appendCompletedMigration({
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
        appendCompletedMigration({
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
        failed = true;
        break;
      }

      if (result.status === 'partial') {
        console.log(`Migration v${m.version} finished as PARTIAL. Re-run \`gbrain apply-migrations --yes\` after resolving any pending host-work items.`);
      } else {
        console.log(`Migration v${m.version} complete.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Migration v${m.version} threw: ${msg}`);
      // Same partial-on-throw treatment so the cap counts runaway failures.
      try {
        appendCompletedMigration({ version: m.version, status: 'partial' });
      } catch { /* swallow ledger-write failure on throw path */ }
      failed = true;
      break;
    }
  }

  if (failed) process.exit(1);
}

/** Exported for unit tests only. Do not use from production code. */
export const __testing = {
  parseArgs,
  buildPlan,
  indexCompleted,
  statusForVersion,
};
