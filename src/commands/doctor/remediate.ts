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
 * Explicit-only repair kinds are never steps: the plan lists each with its
 * read-only preview command (`explicit_kind_required`). An automatic kind
 * whose preview threw is not a step either: plan and run list it under
 * `repair_preview_failures` and carry on with every other kind.
 *
 * After a run, every wave check is classified (cleared, pending,
 * consent_required, operator_required, explicit_kind_required, unsupported).
 * Exit status: 0 when no automatically repairable finding remains and no step
 * failed, even if operator-required, explicit-kind or unsupported findings
 * remain (they are listed); 1
 * otherwise, on budget exhaustion, and when any repair preview failed (that
 * kind did not run); 2 when the target is unreachable and there is no repair
 * step to run, or a resume is refused.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { setCliExitVerdict, writeJsonDocument } from '../../core/cli-force-exit.ts';
import { clearHealthMemo } from '../../core/health-memo.ts';
import type { RemediationPlan, RemediationResult } from '../../core/remediation/types.ts';
import type { RepairPlanStep, RepairPreviewFailure } from '../../core/remediation/repairs.ts';
import { repairPreviewCommand, repairSpec, type ExplicitRepairNotice } from '../../core/repair/registry.ts';
import { findingSource, runWaveChecks, waveRepairKind, type WaveFinding } from './wave-checks.ts';
import { derivedCapExhaustedError, type CapSource } from '../../core/consent.ts';
import { previewRemediationPlan, remediateConsent, remediateFlags, remediationPlanHash, type RemediateFlags } from './remediate-consent.ts';
import { cliRenderContext, renderAction, renderNotice, type Action, type Notice } from '../../core/agent-output.ts';

export const REMEDIATE_HELP = `Usage: gbrain doctor --remediation-plan [--target-score <n>] [--no-embed] [--json]
       gbrain doctor --remediate [--yes [--expect <plan_hash>]] [--include-repairs] [--max-usd <n>] [--target-score <n>]
                     [--max-jobs <n>] [--no-embed] [--dry-run] [--resume [<plan_hash>]] [--json]

--remediation-plan previews job steps (driven by the brain score target) and,
independent of the target, PROTECTED repair steps for every \`gbrain repair\`
kind with pending items. Each step prints the exact command that applies it,
plus one combined command. Read-only.

--remediate runs job steps; with --include-repairs it also runs the repair
steps (the user's agreement; local brain host only). Without it, repair steps
are listed as skipped. It asks before any work (and before schema migrations):
  --yes              Authorizes the paid job steps. Without --max-usd the run is
                     capped at the estimate x1.5 (floor $0.25; $5 with no estimate).
  --expect <hash>    With --include-repairs, --yes must name the plan the user
                     approved (plan_hash from --remediation-plan or the refusal);
                     a changed plan re-asks.
                     Without authorization a non-interactive run changes nothing
                     and exits 3 (--json prints the consent payload).
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
and no repair step runs, or a resume is refused; 3 when consent is required.
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

/**
 * Every plan step carries an Action (agent operator contract v1): the step's
 * own command, its effects and a verify. A job step is `paid` when it has a
 * cost estimate or its handler calls a model provider (then the argv carries
 * `--yes`, so it runs verbatim once the user agrees, and `next` renders
 * `ask_user`); a repair step rewrites data (`destructive`, plus `paid` when it
 * embeds), so it is always the user's call.
 */
export async function jobStepFix(step: { job: string; params?: Record<string, unknown>; est_usd_cost?: number; rationale?: string }): Promise<Action> {
  const { paidJobNames } = await import('../jobs/shared.ts');
  const paid = (step.est_usd_cost ?? 0) > 0 || (await paidJobNames([step.job])).length > 0;
  const cost = typeof step.est_usd_cost === 'number' && step.est_usd_cost > 0 ? ` (estimated $${step.est_usd_cost.toFixed(4)})` : '';
  return {
    argv: ['gbrain', 'jobs', 'submit', step.job, ...(step.params && Object.keys(step.params).length ? ['--params', JSON.stringify(step.params)] : []), '--follow', ...(paid ? ['--yes'] : [])],
    consent: paid ? ['paid'] : [],
    actor: 'agent',
    why: paid ? `Runs the ${step.job} job, which calls the configured model provider and costs money${cost}.` : `Runs the ${step.job} job (no provider calls).`,
    ...(paid ? { user_message: `Raising the brain score needs the ${step.job} job, which calls your model provider and costs money${cost}. OK to run it?` } : {}),
    verify: { argv: ['gbrain', 'doctor', '--only', 'brain_score', '--json'] },
    requires_exclusive: false,
  };
}

export function repairStepFix(step: Pick<RepairPlanStep, 'kind' | 'command' | 'paid' | 'est_usd_cost' | 'llm_usd' | 'affected' | 'checks'>): Action {
  const llm = step.llm_usd;
  const embedUsd = step.est_usd_cost !== null && typeof llm === 'number' ? step.est_usd_cost - llm : 0;
  const cost = !step.paid ? ''
    : llm === undefined ? (step.est_usd_cost === null ? ' and calls the embedding provider (price unknown)' : ` and costs about $${step.est_usd_cost.toFixed(4)} in embeddings`)
    : `${llm === null ? ' and may call a paid chat model (price unknown)' : ` and may spend about $${llm.toFixed(4)} on a paid chat model`}`
      + `${embedUsd > 0 ? ` plus about $${embedUsd.toFixed(4)} in embeddings` : ''}`;
  return {
    argv: step.command.split(' '),
    preview_argv: repairPreviewCommand(step.kind).split(' '),
    consent: ['destructive', ...(step.paid ? ['paid' as const] : [])],
    actor: 'agent',
    why: `Rewrites ${step.affected} stored item(s) for gbrain repair ${step.kind}${cost}.`,
    user_message: `gbrain wants to repair ${step.affected} item(s) (${step.kind}); this rewrites stored data${cost}. OK to apply it?`,
    verify: { argv: ['gbrain', 'doctor', '--only', step.checks.length ? step.checks.join(',') : 'brain_score', '--json'] },
    requires_exclusive: true,
  };
}

/**
 * `gbrain doctor --remediate --yes --include-repairs --max-usd <n>`, filled from the plan's estimates.
 * With repair steps, `--expect <plan_hash>` binds the approval to this plan (C1).
 */
export function combinedRemediateCommand(plan: Pick<RemediationPlanShape, 'est_total_usd_cost' | 'repair_steps'>, targetScore = 90,
  opts: { noEmbed?: boolean; planHash?: string } = {}): string {
  const repairs = plan.repair_steps ?? [];
  const unknown = repairs.some(step => step.paid && step.est_usd_cost === null);
  const total = plan.est_total_usd_cost + repairs.reduce((sum, step) => sum + (step.est_usd_cost ?? 0), 0);
  const cap = unknown ? '<n>' : String(Math.ceil(total * 100) / 100);
  return `gbrain doctor --remediate --yes${repairs.length ? ' --include-repairs' : ''} --max-usd ${cap}${targetScore !== 90 ? ` --target-score ${targetScore}` : ''}`
    + `${opts.noEmbed ? ' --no-embed' : ''}${repairs.length && opts.planHash ? ` --expect ${opts.planHash}` : ''}`;
}

/**
 * ENG-6: the plan is observational. The doctor CLI connects probe-only (no
 * migrations, no maintenance), so a brain whose schema is behind is reported,
 * not upgraded: a `migrations_pending` safety notice naming the command that
 * applies them (`doctor --remediate` also applies them, after consent).
 * Mounts never auto-migrate from the CLI, so only the host brain reports it.
 */
export async function pendingMigrationsNotice(engine: BrainEngine): Promise<Notice | null> {
  const { hasPendingMigrations, LATEST_VERSION } = await import('../../core/migrate.ts');
  const { resolveBrainId } = await import('../../core/brain-resolver.ts');
  const { getCliOptions } = await import('../../core/cli-options.ts');
  try { if (resolveBrainId(getCliOptions().brain) !== 'host') return null; } catch { return null; }
  if (!(await hasPendingMigrations(engine))) return null;
  const current = await engine.getConfig('version').catch(() => null);
  return {
    code: 'migrations_pending', kind: 'safety',
    why: `Schema migrations are pending (brain at v${current ?? 'unknown'}, this gbrain expects v${LATEST_VERSION}). `
      + 'The plan was computed without applying them; `doctor --remediate` applies them after consent, before any step runs.',
    fix: { argv: ['gbrain', 'apply-migrations', '--yes'], consent: [], actor: 'agent', requires_exclusive: true,
      why: 'Applies the pending schema migrations (the same ones every command applies on connect).',
      verify: { argv: ['gbrain', 'doctor', '--only', 'schema_version', '--json'] } },
  };
}

/**
 * CLI wrapper around computeRemediationPlan. Read-only — never enqueues,
 * never mutates, never migrates (the engine is probe-only). JSON adds a
 * `command` per job step, the repair steps, the combined command, the wave
 * check `findings` classified as a run would leave them (an explicit-only
 * kind's finding is `explicit_kind_required` with its preview command) and a
 * `notices` array (pending migrations) to the library's stable envelope.
 */
export async function runRemediationPlan(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(REMEDIATE_HELP); return; }
  const { computeRemediationPlan } = await import('../../core/remediation/index.ts');
  const targetScore = parseIntFlag(args, '--target-score') ?? 90;
  const noEmbed = args.includes('--no-embed');
  const migrations = await pendingMigrationsNotice(engine);
  const plan = await computeRemediationPlan(engine, { targetScore, repairs: { noEmbed } });
  const planHash = plan.repair_steps?.length ? await remediationPlanHash(engine, args, plan) : undefined;
  const waves = await runWaveChecks(engine);
  const findings = classifyWaveFindings(waves, waves, { repairs: [], repairs_skipped: plan.repair_steps ?? [] });
  if (args.includes('--json')) {
    const ctx = cliRenderContext();
    const steps = await Promise.all(plan.plan.map(async step => ({ ...step, command: jobStepCommand(step), fix: renderAction(await jobStepFix(step), ctx) })));
    const repairSteps = plan.repair_steps?.map(step => ({ ...step, fix: renderAction(repairStepFix(step), ctx) }));
    await writeJsonDocument(JSON.stringify({ ...plan, plan: steps, ...(repairSteps ? { repair_steps: repairSteps } : {}),
      combined_command: combinedRemediateCommand(plan, plan.target_unreachable ? plan.max_reachable_score : targetScore, { noEmbed, planHash }), ...(planHash ? { plan_hash: planHash } : {}), findings,
      ...(migrations ? { notices: [renderNotice(migrations, cliRenderContext())] } : {}) }, null, 2));
    return;
  }
  if (migrations) {
    const fix = renderNotice(migrations, cliRenderContext()).fix;
    console.log(`Schema migrations pending: ${migrations.why}`);
    if (fix?.command) console.log(`  apply: ${fix.command}`);
  }
  const paidJobs = new Set((await Promise.all(plan.plan.map(async step => (await jobStepFix(step)).consent.length ? step.step : null))).filter((n): n is number => n !== null));
  for (const line of renderRemediationPlanLines(plan, targetScore, { noEmbed, planHash, paidSteps: paidJobs })) console.log(line);
  const named = findings.filter(f => f.class === 'explicit_kind_required');
  if (named.length) {
    console.log('\nFindings an explicit-only repair clears (preview each on this host, then ask the user before applying):');
    for (const finding of named) console.log(`  ${finding.check_id}: ${finding.command}`);
  }
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
  explicit_repairs?: ExplicitRepairNotice[];
  repair_preview_failures?: RepairPreviewFailure[];
}

/** Human lines for failed repair previews: kind, error code, the redacted error, and the read-only command that repeats it. */
function failedPreviewLines(failures: readonly RepairPreviewFailure[], indent: string): string[] {
  return failures.map(f => `${indent}${f.kind} [${f.code}]: ${f.message}; to see it again run: ${f.fix.command}`);
}

/**
 * Human-render the remediation plan. "Brain is at target" prints only when
 * the score is at target, no repair step is pending and every repair kind
 * previewed cleanly, so neither an unreachable target nor an unpreviewed
 * kind ever reads as "nothing to do".
 */
export function renderRemediationPlanLines(plan: RemediationPlanShape, targetScore: number, opts: { noEmbed?: boolean; planHash?: string; paidSteps?: ReadonlySet<number> } = {}): string[] {
  const lines: string[] = [];
  const repairs = plan.repair_steps ?? [];
  lines.push(`Brain score: ${plan.brain_score_current}/100 → target ${targetScore}`);
  if (plan.target_unreachable) {
    lines.push(`Target unreachable: max with autonomous remediation is ${plan.max_reachable_score}/100.`);
  }
  if (plan.plan.length === 0) {
    const unpreviewed = plan.repair_preview_failures?.length ?? 0;
    if (plan.brain_score_current >= targetScore && repairs.length === 0 && unpreviewed === 0) {
      lines.push('No remediations needed. Brain is at target.');
    }
  } else {
    lines.push(`Plan: ${plan.plan.length} step(s), est ${plan.est_total_seconds}s, est $${plan.est_total_usd_cost.toFixed(2)}`);
    for (const step of plan.plan) {
      const protectedMark = step.protected ? ' [PROTECTED]' : '';
      const costMark = step.est_usd_cost ? ` ($${step.est_usd_cost.toFixed(2)})` : '';
      lines.push(`  ${step.step}. [${step.severity}] ${step.job}${protectedMark} — ${step.rationale}${costMark}`);
      lines.push(opts.paidSteps?.has(step.step) || (step.est_usd_cost ?? 0) > 0
        ? `     paid: ask the user first; once they agree run: ${jobStepCommand(step)}`
        : `     run: ${jobStepCommand(step)}`);
    }
  }
  if (repairs.length > 0) {
    lines.push(`\nRepair steps: ${repairs.length} (requires user agreement; PROTECTED, run on this host only; independent of the score target)`);
    for (const step of repairs) {
      const llm = step.llm_usd;
      const embedUsd = step.est_usd_cost !== null && typeof llm === 'number' ? step.est_usd_cost - llm : 0;
      const cost = !step.paid ? ' (free)'
        : llm === undefined ? (step.est_usd_cost === null ? ' (paid embeddings, price unknown)' : ` (~$${step.est_usd_cost.toFixed(4)} embeddings)`)
        : ` (${llm === null ? 'paid model, price unknown' : `~$${llm.toFixed(4)} paid model`}${embedUsd > 0 ? `, ~$${embedUsd.toFixed(4)} embeddings` : ''})`;
      lines.push(`  R${step.step}. ${step.kind} — ${step.affected} item(s)${cost} [requires user agreement]`);
      lines.push(`     apply: ${step.command}`);
    }
  }
  if (plan.repair_preview_failures?.length) {
    lines.push('\nRepair kinds whose preview failed (left out of this plan; nothing was changed):');
    lines.push(...failedPreviewLines(plan.repair_preview_failures, '  '));
  }
  if (plan.explicit_repairs?.length) {
    lines.push('\nExplicit-only repairs (never run by --remediate or gbrain repair --all; preview each by name on this host):');
    for (const notice of plan.explicit_repairs) lines.push(`  ${notice.kind}: ${notice.preview_command}`);
  }
  if (plan.plan.length > 0 || repairs.length > 0) {
    lines.push(`\nApply everything${repairs.length ? ' after the user agrees' : ''}: ${combinedRemediateCommand(plan, plan.target_unreachable ? plan.max_reachable_score : targetScore, opts)}`);
    if (repairs.length) lines.push('Ask the user before applying any repair step.');
  }
  if (plan.blocked.length > 0) {
    lines.push(`\nBlocked checks (prereq missing):`);
    for (const b of plan.blocked) lines.push(`  - ${b.check}: ${b.reason}`);
  }
  return lines;
}

export type FindingClass = 'cleared' | 'pending' | 'consent_required' | 'operator_required' | 'explicit_kind_required' | 'unsupported';

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
 * was skipped for lack of --include-repairs). A check that could not run, or
 * whose scan stopped at its deadline (`details.partial`), is `pending`: its
 * state is unknown or incomplete, never assumed clean. An explicit-only kind's
 * preview names `--source <id>` when the finding names one source.
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
    if (now.check.details?.partial === true) {
      findings.push({ ...base, class: 'pending', ...(kind ? { repair_kind: kind } : {}),
        instruction: `The scan stopped at its deadline, so the finding is incomplete; raise ${now.spec.id === 'fence_integrity' ? 'GBRAIN_DOCTOR_FENCE_TIMEOUT_MS' : 'GBRAIN_DOCTOR_FM_TIMEOUT_MS'} and rerun gbrain doctor --only ${now.spec.id} on the brain host.` });
      continue;
    }
    if (now.spec.resolution === 'operator') { findings.push({ ...base, class: 'operator_required', instruction: now.spec.instruction }); continue; }
    if (now.spec.resolution === 'unsupported') { findings.push({ ...base, class: 'unsupported', instruction: now.spec.instruction }); continue; }
    // A repairable finding the repair can only report blocked needs the operator first.
    const blocked = now.check.details?.operator_instruction;
    if (typeof blocked === 'string') { findings.push({ ...base, class: 'operator_required', instruction: blocked, ...(kind ? { repair_kind: kind } : {}) }); continue; }
    if (kind && repairSpec(kind).explicit_only) {
      findings.push({ ...base, class: 'explicit_kind_required', repair_kind: kind, command: repairPreviewCommand(kind, { source: findingSource(now) }) });
      continue;
    }
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
  if (jobFailed || repairFailed || result.repair_preview_failures?.length) return 1;
  if (findings.some(f => f.class === 'pending' || f.class === 'consent_required')) return 1;
  if (result.target_unreachable) return 2;
  return 0;
}

/**
 * CLI wrapper around runRemediation. Default: submit-and-wait per job step,
 * in-process repair steps with --include-repairs. --dry-run skips submission.
 */
export async function runRemediate(engine: BrainEngine, args: string[], completeStartup?: (engine: BrainEngine) => Promise<void>): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(REMEDIATE_HELP); return; }
  const targetScore = parseIntFlag(args, '--target-score') ?? 90;
  const maxJobs = parseIntFlag(args, '--max-jobs') ?? Infinity;
  // --max-cost is an alias for --max-usd; both feed the pre-flight refusal
  // and, via withBudgetTracker, the mid-run BudgetExhausted hard stop.
  const maxUsdRaw = parseFloatFlag(args, '--max-usd') ?? parseFloatFlag(args, '--max-cost');
  let maxUsd = maxUsdRaw === null ? undefined : maxUsdRaw;
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

  const { runRemediation } = await import('../../core/remediation/index.ts');

  // C1: consent before any work. The engine is observational (probe-only:
  // no migrations) until consent is granted.
  let capSource: CapSource | undefined = maxUsd === undefined ? undefined : 'user';
  if (!dryRun) {
    const flags: RemediateFlags = { ...remediateFlags(args), targetScore };
    const plan = await previewRemediationPlan(engine, flags);
    const repairs = includeRepairs ? plan?.repair_steps ?? [] : [];
    // Nothing would run (no job step, or the target is out of reach, and no included repair):
    // the run below only reports, so it needs no consent and no startup completion.
    const nothingRuns = plan !== null && !resumeMode && repairs.length === 0 && (plan.target_unreachable || plan.plan.length === 0);
    if (plan && !nothingRuns && !skipConfirm) {
      log(`About to submit ${plan.plan.length} job(s), est ${plan.est_total_seconds}s, est $${plan.est_total_usd_cost.toFixed(2)}`
        + ((plan.repair_steps ?? []).length ? `, and ${includeRepairs ? 'run' : 'skip (no --include-repairs)'} ${(plan.repair_steps ?? []).length} repair step(s)` : ''));
    }
    if (!nothingRuns) {
      const auth = await remediateConsent(engine, args, flags, plan);
      if (!auth) return;
      if (maxUsd === undefined && auth.cap_usd !== null && !resumeMode) {
        maxUsd = auth.cap_usd;
        capSource = auth.cap_source ?? undefined;
      }
      await completeStartup?.(engine);
    }
  }

  if (engine.kind === 'pglite') console.error('[remediate] PGLite engine: running inline (no durable queue).');
  const before = dryRun ? [] : await runWaveChecks(engine);

  const result = await runRemediation(engine,
    { targetScore, maxJobs, maxUsd, capSource, dryRun, resume: resumeMode, resumePlanHash, inlineJobs: true, repairs: { include: includeRepairs, remote: false, noEmbed } },
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

  if (!dryRun) clearHealthMemo(engine);

  if (result.budget_exhausted && capSource !== 'user') {
    const cap = result.budget?.max_usd ?? result.budget_exhausted.cap;
    const e = derivedCapExhaustedError({ command: 'doctor --remediate', capUsd: cap, spentUsd: result.budget_exhausted.spent,
      checkpoint: `plan_hash ${result.budget_exhausted.plan_hash}`,
      argv: ['gbrain', 'doctor', '--remediate', '--yes', ...(result.budget?.include_repairs ? ['--include-repairs'] : []), '--resume', result.budget_exhausted.plan_hash] });
    console.error(`${e.message}\n${e.suggestion}`);
  } else if (result.budget_exhausted) {
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
    await writeJsonDocument(JSON.stringify({ ...result, findings, repairs_completed: repairsCompleted, healthy, exit_status: exitStatus }, null, 2));
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
    if (result.repair_preview_failures?.length) {
      console.log(`Not run, because the repair preview failed: ${result.repair_preview_failures.map(f => f.kind).join(', ')}`);
      for (const line of failedPreviewLines(result.repair_preview_failures, '  - ')) console.log(line);
    }
    for (const f of findings.filter(f => f.class !== 'cleared')) {
      console.log(`[${f.class}] ${f.check_id}: ${f.instruction ?? f.command ?? f.message}`);
    }
    const cleared = findings.filter(f => f.class === 'cleared').map(f => f.check_id);
    if (cleared.length) console.log(`Cleared: ${cleared.join(', ')}`);
  }
  setCliExitVerdict(exitStatus);
}
