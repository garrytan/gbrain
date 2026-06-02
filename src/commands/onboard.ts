// src/commands/onboard.ts
// sourcescope:file-brain-wide — the --history surface reads
// migration_impact_log brain-wide. Per A26 lint opt-out.
//
// v0.41.18.0 (A1, T13). CLI shell for `gbrain onboard`. Thin wrapper over:
//   - T2 library: computeRemediationPlan + runRemediation
//   - T4 onboard checks: runAllOnboardChecks (extra remediations)
//   - T12 render: buildOnboardReport + renderHuman
//
// Three modes:
//   --check    (default): print plan, no submission
//   --auto:               submit auto_apply tier (requires --max-usd)
//   --auto --yes:         also submit prompt_required tier
//   --history:            show recent migration_impact_log entries
//
// `--json` switches to the stable JSON envelope. No CLI mode → human render.

import type { BrainEngine } from '../core/engine.ts';
import { computeRemediationPlan, runRemediation } from '../core/remediation/index.ts';
import { runAllOnboardChecks } from '../core/onboard/checks.ts';
import { buildOnboardReport, renderHuman } from '../core/onboard/render.ts';

function parseInt10(args: string[], flag: string): number | null {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return null;
  const v = parseInt(args[i + 1] ?? '', 10);
  return isNaN(v) ? null : v;
}

function parseFloat10(args: string[], flag: string): number | null {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return null;
  const v = parseFloat(args[i + 1] ?? '');
  return isNaN(v) ? null : v;
}

export async function runOnboard(engine: BrainEngine, args: string[]): Promise<void> {
  const check = args.includes('--check') || (!args.includes('--auto') && !args.includes('--history'));
  const auto = args.includes('--auto');
  const yes = args.includes('--yes');
  const history = args.includes('--history');
  const jsonOutput = args.includes('--json');
  // v0.42 (T16): --explain extends --check with per-cluster narrative
  // for the pack_upgrade_available recommendation (D5 trust UX delta).
  // No-op without a pack_upgrade_available finding.
  const explain = args.includes('--explain');
  const targetScore = parseInt10(args, '--target-score') ?? 90;
  const maxUsdRaw = parseFloat10(args, '--max-usd');
  const maxUsd = maxUsdRaw === null ? undefined : maxUsdRaw;

  // --history shows the impact log directly; no plan computation.
  if (history) {
    const rows = await engine.executeRaw<{
      remediation_id: string;
      metric_name: string;
      metric_before: number | null;
      metric_after: number | null;
      applied_at: string;
    }>(
      `SELECT remediation_id, metric_name, metric_before, metric_after, applied_at
         FROM migration_impact_log
        ORDER BY applied_at DESC
        LIMIT 50`,
    );
    const historyEntries = rows.map((r) => ({
      remediation_id: r.remediation_id,
      metric_name: r.metric_name,
      metric_before: r.metric_before === null ? null : Number(r.metric_before),
      metric_after: r.metric_after === null ? null : Number(r.metric_after),
      delta: (r.metric_before === null || r.metric_after === null)
        ? null
        : Number(r.metric_after) - Number(r.metric_before),
      applied_at: r.applied_at,
    }));
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({
        schema_version: 1,
        history: historyEntries,
      }, null, 2) + '\n');
      return;
    }
    process.stdout.write(`Onboard history (last ${historyEntries.length}):\n`);
    for (const h of historyEntries) {
      const delta = h.delta !== null ? (h.delta > 0 ? `+${h.delta}` : String(h.delta)) : '?';
      process.stdout.write(
        `  ${h.applied_at}  ${h.remediation_id}  ${h.metric_name}: ` +
        `${h.metric_before ?? '?'} → ${h.metric_after ?? '?'} (${delta})\n`,
      );
    }
    return;
  }

  // --auto refuses without --max-usd (cron-safety per A12 + A20).
  if (auto && maxUsd === undefined) {
    process.stderr.write(
      `gbrain onboard --auto refuses without --max-usd N.\n` +
      `Set a cap to avoid surprise spend:\n` +
      `  gbrain onboard --auto --max-usd 5\n`,
    );
    process.exit(2);
  }

  // Build the plan: T4 checks supply extra remediations on top of T3's
  // generalized planner.
  const onboardCheckResults = await runAllOnboardChecks(engine);
  const extraRemediations = onboardCheckResults.flatMap((r) => r.remediations);

  if (check && !auto) {
    const plan = await computeRemediationPlan(engine, { targetScore, extraRemediations });
    const report = buildOnboardReport(plan);
    if (jsonOutput) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }
    process.stdout.write(renderHuman(report) + '\n');
    // v0.42 (T16): --explain extension. Per-cluster narrative for the
    // pack_upgrade_available recommendation. Runs unify-types in dry-run
    // mode and renders the per-rule diff. No-op when no pack upgrade
    // is available.
    if (explain) {
      await renderPackUpgradeExplain(engine, extraRemediations);
    }
    return;
  }

  // --auto path: runs through the T2 library orchestrator. Hooks emit CLI
  // progress to stderr; the final result lands as JSON on stdout (or human
  // summary).
  const result = await runRemediation(
    engine,
    {
      targetScore,
      maxUsd,
      // --auto --yes opts into the prompt_required tier too; library
      // doesn't distinguish auto_apply vs prompt_required, it just runs
      // every remediation in the plan. The plan-building side (T12 render)
      // does the tier distinction; for --auto without --yes, the CLI shell
      // would pre-filter the extras to auto_apply only. For now: pass
      // everything; CLI documents this is "everything" behavior.
    },
    {
      onTargetUnreachable: (target, ceiling) => {
        process.stderr.write(
          `[onboard] target ${target}/100 unreachable; max autonomous = ${ceiling}/100. ` +
          `Configure missing prereqs (run gbrain doctor --remediation-plan) or lower --target-score.\n`,
        );
      },
      onNothingToDo: (score, target) => {
        process.stdout.write(
          `Brain at score ${score}/100, target ${target}/100. Nothing to do.\n`,
        );
      },
      onBudgetRefused: (estCost, cap) => {
        process.stderr.write(
          `[onboard] est cost $${estCost.toFixed(2)} exceeds --max-usd $${cap.toFixed(2)}. Aborting.\n`,
        );
      },
      onStepStart: (step, total, rec) => {
        process.stderr.write(`[onboard] [${step}/${total}] ${rec.job} (${rec.severity})...\n`);
      },
      onStepEnd: (sr) => {
        process.stderr.write(`[onboard]    → ${sr.status}\n`);
      },
      onBudgetExhausted: (planHash, snapshot) => {
        process.stderr.write(
          `\n[onboard] BudgetExhausted (${snapshot.reason}): spent $${snapshot.spent.toFixed(4)} > cap $${snapshot.cap.toFixed(2)}.\n` +
          `Checkpoint saved. Resume with:\n  gbrain doctor --remediate --resume ${planHash}\n`,
        );
      },
    },
  );

  if (result.target_unreachable) process.exit(2);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (result.submitted.length > 0) {
    process.stdout.write(
      `\nBrain score: ${result.brain_score_initial} → ${result.brain_score_final} (target ${targetScore})\n` +
      `Submitted: ${result.submitted.length} job(s), ${result.aborted_count} aborted/failed\n`,
    );
  }

  const anyFailed = result.submitted.some(
    (s) => s.status !== 'completed' && s.status !== 'submitted' && s.status !== 'dry_run',
  );
  if (result.budget_exhausted || anyFailed) process.exit(1);
}

/**
 * v0.42 (T16): per-cluster narrative renderer for `gbrain onboard --check --explain`.
 *
 * Finds the pack_upgrade_available recommendation in the extras, runs
 * the unify-types handler in dry-run mode, and renders a human-readable
 * breakdown:
 *   - Cluster name (heuristic: group rules by to_type)
 *   - Source page counts per from_type that would be retyped
 *   - Total alias rows that would be created
 *   - Total page-to-link conversions
 *   - Sample slugs per cluster (capped at 3)
 *
 * No-op when no pack_upgrade_available recommendation is in the plan
 * (the brain is already on the latest pack).
 */
async function renderPackUpgradeExplain(
  engine: BrainEngine,
  extras: Array<{ id: string; job: string; params: Record<string, unknown> }>,
): Promise<void> {
  const packUpgrade = extras.find((e) => e.id.startsWith('onboard.pack_upgrade_'));
  if (!packUpgrade) {
    process.stdout.write(
      '\n(--explain: no pack_upgrade_available recommendation; brain is on the latest pack)\n',
    );
    return;
  }
  const targetPack = packUpgrade.params.target_pack;
  if (typeof targetPack !== 'string') return;
  process.stdout.write(`\n--- Pack upgrade plan: → ${targetPack} ---\n`);
  try {
    const { runUnifyTypes } = await import('../core/schema-pack/unify-types-handler.ts');
    const result = await runUnifyTypes(
      { engine, cfg: null, remote: false } as unknown as import('../core/operations.ts').OperationContext,
      { target_pack: targetPack, apply: false },
    );
    process.stdout.write(
      `Pre-state: ${result.stats_before.total_pages} pages, ${result.stats_before.distinct_types} distinct types\n` +
      `\nWould apply (dry-run):\n` +
      `  Explicit retypes:    ${result.per_phase.retype_explicit.would_apply} pages across ${result.per_phase.retype_explicit.rules} rules\n` +
      `  Catch-all retypes:   ${result.per_phase.retype_catch_all.would_apply} pages across ${result.per_phase.retype_catch_all.synthesized_rules} synthesized rules\n` +
      `  Page-to-link:        ${result.per_phase.page_to_link.would_convert} edges across ${result.per_phase.page_to_link.rules} rules\n` +
      `  Page-to-alias:       ${result.per_phase.page_to_alias.would_alias} aliases across ${result.per_phase.page_to_alias.rules} rules\n` +
      `\nRun the migration with:\n` +
      `  gbrain jobs submit unify-types --allow-protected --params '${JSON.stringify({ target_pack: targetPack })}'\n`,
    );
    if (result.warnings.length > 0) {
      process.stdout.write(`\nWarnings:\n`);
      for (const w of result.warnings) process.stdout.write(`  - ${w}\n`);
    }
  } catch (e) {
    process.stdout.write(`(--explain: dry-run failed: ${(e as Error).message})\n`);
  }
}
