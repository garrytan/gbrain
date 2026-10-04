/**
 * Consent for `gbrain doctor --remediate` (agent operator contract v1, C1).
 *
 * Remediation submits job steps that may spend (`paid`) and, with
 * `--include-repairs`, applies repair steps that rewrite stored records
 * (`destructive`). The consent request is built from the plan computed on
 * the observational (probe-only) engine, before any migration or work runs:
 *
 * - `paid`: `--yes`, `--max-usd`, `spend.posture=tokenmax` or a per-run
 *   preapproval authorizes it. `--yes` without `--max-usd` runs under a
 *   derived cap (estimate × 1.5, floor $0.25; the default cap when there is
 *   no estimate), never uncapped.
 * - `destructive` (repairs): `--yes --expect <plan_hash>`, where plan_hash
 *   binds the brain, the repair kinds and their pending counts, the job
 *   steps and the parameters. A changed plan re-asks (`preview_changed`).
 *
 * A resume reuses the checkpoint's manifest (brain, cap, steps), so it binds
 * no new plan hash; it still needs `--yes` for the effects it continues.
 */
import type { Authorization, PlanSelection } from '../../core/consent.ts';
import { computePlanHash } from '../../core/consent.ts';
import { consentGate, engineConsentEnv } from '../../core/consent-cli.ts';
import type { Effect } from '../../core/agent-output.ts';
import { brainRoutingArgs } from '../../core/brain-resolver.ts';
import type { BrainEngine } from '../../core/engine.ts';
import type { RemediationPlan } from '../../core/remediation/types.ts';

export interface RemediateFlags {
  targetScore: number;
  includeRepairs: boolean;
  noEmbed: boolean;
  resumeMode: boolean;
  json: boolean;
}

export function remediateFlags(args: readonly string[]): RemediateFlags {
  const i = args.indexOf('--target-score');
  const target = i >= 0 ? parseInt(args[i + 1] ?? '', 10) : NaN;
  return {
    targetScore: Number.isNaN(target) ? 90 : target,
    includeRepairs: args.includes('--include-repairs'),
    noEmbed: args.includes('--no-embed'),
    resumeMode: args.includes('--resume'),
    json: args.includes('--json'),
  };
}

/** The plan the consent request describes, or null when it cannot be computed before startup completes. */
export async function previewRemediationPlan(engine: BrainEngine, flags: RemediateFlags): Promise<RemediationPlan | null> {
  try {
    const { computeRemediationPlan } = await import('../../core/remediation/index.ts');
    return await computeRemediationPlan(engine, { targetScore: flags.targetScore, repairs: { noEmbed: flags.noEmbed } });
  } catch {
    return null;
  }
}

/** Estimated spend for what this invocation would run; null when a paid step has no price. */
export function remediationEstimateUsd(plan: RemediationPlan | null, includeRepairs: boolean): number | null {
  if (!plan) return null;
  const repairs = includeRepairs ? plan.repair_steps ?? [] : [];
  if (repairs.some(step => step.paid && step.est_usd_cost === null)) return null;
  const total = plan.est_total_usd_cost + repairs.reduce((sum, step) => sum + (step.est_usd_cost ?? 0), 0);
  return Math.ceil(total * 100) / 100;
}

/** The persisted selection a `--include-repairs` approval binds. */
export function remediationSelection(brainId: string, plan: RemediationPlan | null, flags: RemediateFlags): PlanSelection {
  return {
    brain: brainId,
    source: null,
    operation: 'doctor --remediate',
    records: [
      ...(plan?.plan ?? []).map(step => ({ id: `job:${step.id}` })),
      ...(plan?.repair_steps ?? []).map(step => ({ id: step.id, revision: step.affected })),
    ],
    parameters: { target_score: flags.targetScore, include_repairs: true, no_embed: flags.noEmbed, plan_computed: plan !== null },
    effects: ['paid', 'destructive'],
  };
}

/** The approved command: the caller's own flags minus consent flags (consentFix adds `--yes [--expect]`). */
export function remediateArgv(args: readonly string[]): string[] {
  const out = ['gbrain', 'doctor'];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--yes') continue;
    if (a === '--expect' || a === '--brain') { i++; continue; }
    if (a.startsWith('--expect=') || a.startsWith('--brain=')) continue;
    out.push(a);
  }
  return [...out, ...brainRoutingArgs()];
}

function planSummary(plan: RemediationPlan | null, flags: RemediateFlags, estUsd: number | null): string {
  if (!plan) return 'the remediation plan (it could not be previewed before startup; preview it after approval with gbrain doctor --remediation-plan)';
  const repairs = plan.repair_steps ?? [];
  const cost = estUsd === null ? 'an unpriced amount' : `about $${estUsd.toFixed(2)}`;
  const repairText = flags.includeRepairs && repairs.length
    ? ` and ${repairs.length} repair step(s) (${repairs.map(r => `${r.kind}: ${r.affected}`).join(', ')})`
    : '';
  return `${plan.plan.length} job step(s)${repairText}, ${cost}, brain score ${plan.brain_score_current}/100 toward ${flags.targetScore}`;
}

async function boundSelection(engine: BrainEngine, plan: RemediationPlan | null, flags: RemediateFlags): Promise<PlanSelection> {
  const { resolveRepairScope } = await import('../../core/repair/core.ts');
  const brainId = await resolveRepairScope(engine).then(s => s.brain_id).catch(() => 'host');
  return remediationSelection(brainId, plan, flags);
}

/** The plan_hash an `--include-repairs` run binds right now (what `--expect` must name). */
export async function remediationPlanHash(engine: BrainEngine, args: readonly string[], plan?: RemediationPlan | null): Promise<string> {
  const flags = remediateFlags(args);
  return computePlanHash(await boundSelection(engine, plan === undefined ? await previewRemediationPlan(engine, flags) : plan, flags));
}

/**
 * Ask for consent. Resolves the Authorization, or null after the refusal
 * was printed (exit verdict 3). Read-only shortcuts (nothing to do, target
 * unreachable) are the caller's, before this.
 */
export async function remediateConsent(engine: BrainEngine, args: readonly string[], flags: RemediateFlags, plan: RemediationPlan | null): Promise<Authorization | null> {
  const effects: Effect[] = flags.includeRepairs ? ['paid', 'destructive'] : ['paid'];
  const estUsd = remediationEstimateUsd(plan, flags.includeRepairs);
  const selection = flags.includeRepairs && !flags.resumeMode ? await boundSelection(engine, plan, flags) : undefined;
  const planHash = selection ? computePlanHash(selection) : undefined;
  const summary = planSummary(plan, flags, estUsd);
  const preview = ['gbrain', 'doctor', '--remediation-plan', '--target-score', String(flags.targetScore), ...(flags.noEmbed ? ['--no-embed'] : []), '--json', ...brainRoutingArgs()];
  return consentGate({
    command: 'doctor --remediate',
    effects,
    actor: 'agent',
    what: flags.resumeMode ? 'Resume brain remediation' : 'Run brain remediation',
    why: `doctor --remediate runs ${summary} to raise the brain's health score.`
      + (flags.includeRepairs ? ' Repair steps rewrite stored records (re-seal chunks, restamp metadata) on this brain.' : ''),
    risk: (estUsd === null ? 'Paid steps have no price estimate, so the default cost cap applies. ' : `Spends up to the cost cap (estimate $${estUsd.toFixed(2)}). `)
      + (flags.includeRepairs ? 'Repairs change stored records in place; there is no automatic undo, so take a backup first if one matters (gbrain backup). ' : '')
      + 'Job steps run model calls and may queue embeddings.',
    user_message: `Run the brain remediation now (${summary})?`
      + (flags.includeRepairs ? ' It includes repairs that rewrite stored records.' : ''),
    argv: remediateArgv(args),
    preview_argv: preview,
    est_usd: estUsd,
    ...(planHash ? { plan_hash: planHash, selection } : {}),
    args,
  }, { json: flags.json, env: engineConsentEnv(engine) });
}
