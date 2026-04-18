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
import { loadCompletedMigrations, type CompletedMigrationEntry } from '../core/preferences.ts';
import { migrations, compareVersions, type Migration, type OrchestratorOpts } from './migrations/index.ts';

interface ApplyMigrationsArgs {
  list: boolean;
  dryRun: boolean;
  yes: boolean;
  nonInteractive: boolean;
  mode?: 'always' | 'pain_triggered' | 'off';
  specificMigration?: string;
  hostDir?: string;
  noAutopilotInstall: boolean;
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

/** Returns the resolved status for a migration based on its entries. */
function statusForVersion(
  version: string,
  idx: CompletedIndex,
): 'complete' | 'partial' | 'pending' {
  const entries = idx.byVersion.get(version) ?? [];
  if (entries.length === 0) return 'pending';
  if (entries.some(e => e.status === 'complete')) return 'complete';
  if (entries.some(e => e.status === 'partial')) return 'partial';
  return 'pending';
}

interface Plan {
  applied: Migration[];
  partial: Migration[];
  pending: Migration[];
  skippedFuture: Migration[];
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
  const plan: Plan = { applied: [], partial: [], pending: [], skippedFuture: [] };
  for (const m of migrations) {
    if (filterVersion && m.version !== filterVersion) continue;
    if (compareVersions(m.version, installed) > 0) {
      plan.skippedFuture.push(m);
      continue;
    }
    const status = statusForVersion(m.version, idx);
    if (status === 'complete') plan.applied.push(m);
    else if (status === 'partial') plan.partial.push(m);
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

  const completed = loadCompletedMigrations();
  const idx = indexCompleted(completed);
  const plan = buildPlan(idx, installed, cli.specificMigration);

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
  let failed = false;
  for (const m of toRun) {
    console.log(`\n=== Applying migration v${m.version}: ${m.featurePitch.headline} ===`);
    try {
      const result = await m.orchestrator(orchestratorOptsFrom(cli));
      if (result.status === 'failed') {
        console.error(`Migration v${m.version} reported status=failed.`);
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
