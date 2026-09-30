/**
 * `gbrain doctor --remediation-plan` and `gbrain doctor --remediate`: the CLI
 * shell around the remediation library (src/core/remediation/). doctor.ts
 * re-exports these so import sites are unchanged.
 *
 * The plan lists job steps (driven by the brain score target) and, separately
 * and independent of the target, PROTECTED repair steps for every registered
 * `gbrain repair` kind with pending items. Each step prints the exact command
 * that applies it, plus one combined command. `--remediate --yes` runs repair
 * steps only with `--include-repairs` (the user's agreement). The `--max-usd`
 * cap is cumulative across the original run and every `--resume`; the cap,
 * consent and step manifest live in the local remediation checkpoint.
 *
 * After a run, every wave check is classified (cleared, pending,
 * consent_required, operator_required, unsupported). Exit status: 0 when no
 * automatically repairable finding remains and no step failed, even if
 * operator-required or unsupported findings remain (they are listed); 1
 * otherwise and on budget exhaustion; 2 when the target is unreachable and
 * there is no repair step to run, or a resume is refused.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { RemediationPlan, RemediationResult } from '../../core/remediation/types.ts';
import type { RepairPlanStep } from '../../core/remediation/repairs.ts';
import { runWaveChecks, waveRepairKind, type WaveFinding } from './wave-checks.ts';

export const REMEDIATE_HELP = `Usage: gbrain doctor --remediation-plan [--target-score <n>] [--no-embed] [--json]
       gbrain doctor --remediate [--yes] [--include-repairs] [--max-usd <n>] [--target-score <n>]
                     [--max-jobs <n>] [--no-embed] [--dry-run] [--resume [<plan_hash>]] [--json]

--remediation-plan previews job steps (driven by the brain score target) and,
independent of the target, PROTECTED repair steps for every \`gbrain repair\`
kind with pending items. Each step prints the exact command that applies it,
plus one combined command. Read-only.

--remediate runs job steps; with --include-repairs it also runs the repair
steps (the user's agreement; local brain host only). Without it, repair steps
are listed as skipped.
  --max-usd <n>      Cumulative USD cap across the run and every --resume. A paid
                     step that would exceed it is not started; free steps still
                     run, then the run stops as budget-exhausted with a resume
                     command. --resume without --max-usd reuses the recorded cap.
  --target-score <n> Governs job steps only; included repair steps always run to
                     completion.
  --no-embed         Repair steps re-seal or stamp text only (no paid embeddings).
  --json             Findings classified cleared, pending, consent_required,
                     operator_required and unsupported.

Exit status: 0 when no automatically repairable finding remains and no step
failed (operator-required and unsupported findings are listed but do not fail
the run); 1 otherwise and on budget exhaustion; 2 when the target is unreachable
and no repair step runs, or a resume is refused.
Recipe: docs/guides/repair.md#recover-after-upgrading-to-this-release`;

function parseIntFlag(args: string[], flag: string): number | null {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return null;
  const v = parseInt(args[i + 1] ?? '', 10);
  return isNaN(v) ? null : v;
}

function parseFloatFlag(args: string[], flag: string): number | null {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return null;
  const v = parseFloat(args[i + 1] ?? '');
  return isNaN(v) ? null : v;
}

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** The exact command that runs one job step on its own. */
export function jobStepCommand(step: { job: string; params?: Record<string, unknown> }): string {
  return `gbrain jobs submit ${step.job}${step.params && Object.keys(step.params).length ? ` --params ${shellQuote(JSON.stringify(step.params))}` : ''} --follow`;
}

/** `gbrain doctor --remediate --yes --include-repairs --max-usd <n>`, filled from the plan's estimates. */
export function combinedRemediateCommand(plan: Pick<RemediationPlanShape, 'est_total_usd_cost' | 'repair_steps'>, targetScore = 90): string {
  const repairs = plan.repair_steps ?? [];
  const unknown = repairs.some(step => step.paid && step.est_usd_cost === null);
  const total = plan.est_total_usd_cost + repairs.reduce((sum, step) => sum + (step.est_usd_cost ?? 0), 0);
  const cap = unknown ? '<n>' : String(Math.ceil(total * 100) / 100);
  return `gbrain doctor --remediate --yes${repairs.length ? ' --include-repairs' : ''} --max-usd ${cap}${targetScore !== 90 ? ` --target-score ${targetScore}` : ''}`;
}

/**
 * CLI wrapper around computeRemediationPlan. Read-only — never enqueues,
 * never mutates. JSON adds a `command` per job step, the repair steps and
 * the combined command to the library's stable envelope.
 */
export async function runRemediationPlan(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(REMEDIATE_HELP); return; }
  const { computeRemediationPlan } = await import('../../core/remediation/index.ts');
  const targetScore = parseIntFlag(args, '--target-score') ?? 90;
  const plan = await computeRemediationPlan(engine, { targetScore, repairs: { noEmbed: args.includes('--no-embed') } });
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ...plan, plan: plan.plan.map(step => ({ ...step, command: jobStepCommand(step) })),
      combined_command: combinedRemediateCommand(plan, targetScore) }, null, 2));
    return;
  }
  for (const line of renderRemediationPlanLines(plan, targetScore)) console.log(line);
}

interface RemediationPlanShape {
  brain_score_current: number;
  target_unreachable: boolean;
  max_reachable_score: number;
  plan: Array<{
    step: number;
    severity: string;
    job: string;
    params?: Record<string, unknown>;
    protected?: boolean;
    est_usd_cost?: number;
    rationale: string;
  }>;
  est_total_seconds: number;
  est_total_usd_cost: number;
  blocked: Array<{ check: string; reason: string }>;
  repair_steps?: RepairPlanStep[];
}

/**
 * Human-render the remediation plan. "Brain is at target" prints only when
 * the score is at target AND no repair step is pending, so an unreachable
 * target never reads as "nothing to do".
 */
export function renderRemediationPlanLines(plan: RemediationPlanShape, targetScore: number): string[] {
  const lines: string[] = [];
  const repairs = plan.repair_steps ?? [];
  lines.push(`Brain score: ${plan.brain_score_current}/100 → target ${targetScore}`);
  if (plan.target_unreachable) {
    lines.push(`Target unreachable: max with autonomous remediation is ${plan.max_reachable_score}/100.`);
  }
  if (plan.plan.length === 0) {
    if (plan.brain_score_current >= targetScore && repairs.length === 0) {
      lines.push('No remediations needed. Brain is at target.');
    }
  } else {
    lines.push(`Plan: ${plan.plan.length} step(s), est ${plan.est_total_seconds}s, est $${plan.est_total_usd_cost.toFixed(2)}`);
    for (const step of plan.plan) {
      const protectedMark = step.protected ? ' [PROTECTED]' : '';
      const costMark = step.est_usd_cost ? ` ($${step.est_usd_cost.toFixed(2)})` : '';
      lines.push(`  ${step.step}. [${step.severity}] ${step.job}${protectedMark} — ${step.rationale}${costMark}`);
      lines.push(`     run: ${jobStepCommand(step)}`);
    }
  }
  if (repairs.length > 0) {
    lines.push(`\nRepair steps: ${repairs.length} (requires user agreement; PROTECTED, run on this host only; independent of the score target)`);
    for (const step of repairs) {
      const cost = step.paid ? (step.est_usd_cost === null ? ' (paid embeddings, price unknown)' : ` (~$${step.est_usd_cost.toFixed(4)} embeddings)`) : ' (free)';
      lines.push(`  R${step.step}. ${step.kind} — ${step.affected} item(s)${cost} [requires user agreement]`);
      lines.push(`     apply: ${step.command}`);
    }
  }
  if (plan.plan.length > 0 || repairs.length > 0) {
    lines.push(`\nApply everything${repairs.length ? ' after the user agrees' : ''}: ${combinedRemediateCommand(plan, targetScore)}`);
    if (repairs.length) lines.push('Ask the user before applying any repair step.');
  }
  if (plan.blocked.length > 0) {
    lines.push(`\nBlocked checks (prereq missing):`);
    for (const b of plan.blocked) lines.push(`  - ${b.check}: ${b.reason}`);
  }
  return lines;
}

export type FindingClass = 'cleared' | 'pending' | 'consent_required' | 'operator_required' | 'unsupported';

export interface RemediationFinding {
  check_id: string;
  class: FindingClass;
  message: string;
  repair_kind?: string;
  command?: string;
  instruction?: string;
}

/**
 * Classify every wave check that reported a finding before or after the run.
 * A repairable finding the run did not clear is `pending` (the step stopped,
 * was refused by the budget, or items remain) or `consent_required` (the step
 * was skipped for lack of --include-repairs). A check that could not run is
 * `pending`: its state is unknown, never assumed clean.
 */
export function classifyWaveFindings(before: WaveFinding[], after: WaveFinding[], result: Pick<RemediationResult, 'repairs' | 'repairs_skipped'>): RemediationFinding[] {
  const findings: RemediationFinding[] = [];
  for (const now of after) {
    const was = before.find(b => b.spec.id === now.spec.id);
    const kind = waveRepairKind(now.spec);
    if (now.state === 'ok') {
      if (was && was.state !== 'ok') findings.push({ check_id: now.spec.id, class: 'cleared', message: now.check.message, ...(kind ? { repair_kind: kind } : {}) });
      continue;
    }
    const base = { check_id: now.spec.id, message: now.check.message };
    if (now.state === 'unknown') { findings.push({ ...base, class: 'pending', instruction: 'The check could not run; rerun gbrain doctor on the brain host.' }); continue; }
    if (now.spec.resolution === 'operator') { findings.push({ ...base, class: 'operator_required', instruction: now.spec.instruction }); continue; }
    if (now.spec.resolution === 'unsupported') { findings.push({ ...base, class: 'unsupported', instruction: now.spec.instruction }); continue; }
    // A repairable finding the repair can only report blocked needs the operator first.
    const blocked = now.check.details?.operator_instruction;
    if (typeof blocked === 'string') { findings.push({ ...base, class: 'operator_required', instruction: blocked, ...(kind ? { repair_kind: kind } : {}) }); continue; }
    const skipped = result.repairs_skipped?.find(step => step.kind === kind);
    findings.push({ ...base, class: skipped ? 'consent_required' : 'pending', ...(kind ? { repair_kind: kind } : {}),
      ...(skipped ? { command: skipped.command } : kind ? { command: `gbrain repair ${kind} --apply` } : {}) });
  }
  return findings;
}

export function remediationExitStatus(result: RemediationResult, findings: RemediationFinding[]): number {
  if (result.resume_refused) return 2;
  if (result.budget_exhausted) return 1;
  const jobFailed = result.submitted.some(s => s.status !== 'completed' && s.status !== 'submitted' && s.status !== 'dry_run');
  // A stopped step (capacity, pending write, unfinished embeddings) left work behind.
  const repairFailed = (result.repairs ?? []).some(r => r.status === 'failed' || r.status === 'stopped');
  if (jobFailed || repairFailed) return 1;
  if (findings.some(f => f.class === 'pending' || f.class === 'consent_required')) return 1;
  if (result.target_unreachable) return 2;
  return 0;
}

/**
 * CLI wrapper around runRemediation. Default: submit-and-wait per job step,
 * in-process repair steps with --include-repairs. --dry-run skips submission.
 */
export async function runRemediate(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(REMEDIATE_HELP); return; }
  const targetScore = parseIntFlag(args, '--target-score') ?? 90;
  const maxJobs = parseIntFlag(args, '--max-jobs') ?? Infinity;
  // --max-cost is an alias for --max-usd; both feed the pre-flight refusal
  // and, via withBudgetTracker, the mid-run BudgetExhausted hard stop.
  const maxUsdRaw = parseFloatFlag(args, '--max-usd') ?? parseFloatFlag(args, '--max-cost');
  const maxUsd = maxUsdRaw === null ? undefined : maxUsdRaw;
  const dryRun = args.includes('--dry-run');
  const skipConfirm = args.includes('--yes');
  const jsonOutput = args.includes('--json');
  const includeRepairs = args.includes('--include-repairs');
  const noEmbed = args.includes('--no-embed');
  const resumeFlagIdx = args.indexOf('--resume');
  const resumeMode = resumeFlagIdx !== -1;
  const resumeArg = resumeMode ? args[resumeFlagIdx + 1] : undefined;
  const resumePlanHash = resumeArg && !resumeArg.startsWith('--') ? resumeArg : undefined;
  const log = (line: string) => (jsonOutput ? console.error : console.log)(line);

  const { runRemediation, computeRemediationPlan } = await import('../../core/remediation/index.ts');

  // TTY confirmation gate (stays in CLI; library doesn't render).
  if (!skipConfirm && !dryRun && process.stdout.isTTY && !resumeMode) {
    const plan = await computeRemediationPlan(engine, { targetScore, repairs: { noEmbed } });
    const repairs = plan.repair_steps ?? [];
    if (plan.target_unreachable && !(includeRepairs && repairs.length)) {
      console.error(`[remediate] target ${targetScore} unreachable; max autonomous = ${plan.max_reachable_score}/100. `
        + `Configure missing prereqs (see --remediation-plan blocked output) or lower --target-score.`);
      process.exit(2);
    }
    if (plan.plan.length === 0 && repairs.length === 0) {
      console.log(`Brain at score ${plan.brain_score_current}/100, target ${targetScore}. Nothing to do.`);
      return;
    }
    console.log(`About to submit ${plan.plan.length} job(s), est ${plan.est_total_seconds}s, est $${plan.est_total_usd_cost.toFixed(2)}`
      + (repairs.length ? `, and ${includeRepairs ? 'run' : 'skip (no --include-repairs)'} ${repairs.length} repair step(s)` : ''));
    console.log('Pass --yes to proceed (cron-friendly).');
    process.exit(1);
  }

  if (engine.kind === 'pglite') console.error('[remediate] PGLite engine: running inline (no durable queue).');
  const before = dryRun ? [] : await runWaveChecks(engine);

  const result = await runRemediation(engine,
    { targetScore, maxJobs, maxUsd, dryRun, resume: resumeMode, resumePlanHash, repairs: { include: includeRepairs, remote: false, noEmbed } },
    {
      onTargetUnreachable: (target, ceiling) => {
        console.error(`[remediate] target ${target} unreachable; max autonomous = ${ceiling}/100. `
          + (includeRepairs ? 'Job steps are skipped; repair steps still run.' : 'Configure missing prereqs (see --remediation-plan blocked output) or lower --target-score.'));
      },
      onNothingToDo: (score, target) => log(`Brain at score ${score}/100, target ${target}. Nothing to do.`),
      onBudgetRefused: (estCost, cap) => console.error(`[remediate] est job cost $${estCost.toFixed(2)} exceeds the remaining --max-usd $${cap.toFixed(2)}. Job steps not started.`),
      onResumeMissed: (planHash, requested) => console.error(`[remediate --resume] no matching checkpoint found `
        + `(plan_hash=${planHash}${requested ? `; requested=${requested}` : ''}). Run without --resume to start fresh.`),
      onResumeBrainMismatch: (planHash, cpBrain, brain) => console.error(`[remediate --resume] checkpoint ${planHash} belongs to brain ${cpBrain}, `
        + `but the selected brain is ${brain}. Refusing to resume; select that brain with --brain, or run without --resume.`),
      onResumeCap: (cap, spent) => console.error(`[remediate --resume] cumulative cap ${cap === null ? 'none' : `$${cap.toFixed(2)}`} `
        + `(recorded in the checkpoint unless --max-usd was given); $${spent.toFixed(4)} already spent.`),
      onResumeLoaded: (planHash, completed, remaining) => console.error(`[remediate --resume] resuming plan_hash=${planHash}: ${completed} step(s) completed, ${remaining} remaining.`),
      onRepairStepEnd: (step, r) => log(`  repair ${step.kind}: ${r.status}${r.applied ? `, applied ${r.applied}` : ''}${r.message ? ` — ${r.message}` : ''}`),
      onBudgetExhausted: (_planHash, snapshot) => console.error(`\n[remediate] Budget exhausted (${snapshot.reason}): spent $${snapshot.spent.toFixed(4)} `
        + `of the cumulative cap $${snapshot.cap.toFixed(2)}. Checkpoint saved (cap, consent and remaining steps).`),
    });

  if (result.budget_exhausted) {
    const cap = result.budget?.max_usd ?? result.budget_exhausted.cap;
    console.error(`Resume with:\n  gbrain doctor --remediate --yes${result.budget?.include_repairs ? ' --include-repairs' : ''}`
      + `${cap !== null && cap !== undefined ? ` --max-usd ${cap}` : ''} --resume ${result.budget_exhausted.plan_hash}\n`
      + '(the cap is cumulative: spend from this run counts against it)');
  }

  const after = dryRun ? [] : await runWaveChecks(engine);
  const findings = classifyWaveFindings(before, after, result);
  const exitStatus = dryRun ? (result.target_unreachable ? 2 : 0) : remediationExitStatus(result, findings);
  const repairsCompleted = (result.repairs ?? []).filter(r => r.status === 'completed').length;
  const healthy = !dryRun && after.every(f => f.state === 'ok');

  if (jsonOutput) {
    console.log(JSON.stringify({ ...result, findings, repairs_completed: repairsCompleted, healthy, exit_status: exitStatus }, null, 2));
  } else {
    if (dryRun && result.submitted.length > 0) {
      console.log(`[remediate --dry-run] Would run ${result.submitted.length} step(s):`);
      for (const s of result.submitted) console.log(`  - ${s.id}`);
    } else if (result.submitted.length > 0) {
      console.log(`\nBrain score: ${result.brain_score_initial} → ${result.brain_score_final} (target ${targetScore})`);
      // #3626: a step that deduped onto an in-flight job did not submit new work; a rotated re-run did.
      const coalesced = result.submitted.filter((s) => s.coalesced).length;
      const rotated = result.submitted.filter((s) => s.deduped_job_id !== undefined).length;
      const notes = [
        ...(rotated > 0 ? [`${rotated} re-ran under a rotated key (prior terminal row held it)`] : []),
        ...(coalesced > 0 ? [`${coalesced} coalesced onto in-flight job(s)`] : []),
      ];
      console.log(`Submitted: ${result.submitted.length - coalesced} job(s)${notes.length > 0 ? ` (${notes.join('; ')})` : ''}, ${result.aborted_count} aborted/failed`);
    }
    if (result.repairs?.length) console.log(`Repair steps completed: ${repairsCompleted} of ${result.repairs.length}`);
    const skipped = result.repairs_skipped ?? [];
    if (skipped.length) {
      console.log(`${skipped.length} repair step${skipped.length === 1 ? '' : 's'} skipped (user agreement required): re-run with --include-repairs`);
      for (const step of skipped) console.log(`  - ${step.kind}: ${step.affected} item(s); ${step.command}`);
    }
    for (const f of findings.filter(f => f.class !== 'cleared')) {
      console.log(`[${f.class}] ${f.check_id}: ${f.instruction ?? f.command ?? f.message}`);
    }
    const cleared = findings.filter(f => f.class === 'cleared').map(f => f.check_id);
    if (cleared.length) console.log(`Cleared: ${cleared.join(', ')}`);
  }
  setCliExitVerdict(exitStatus);
}
