/**
 * v0.28: auto-think dream phase.
 *
 * Reads `dream.auto_think.questions[]` from config, runs `gbrain think` on
 * each one, persists the result as a synthesis page if `auto_commit=true`
 * (default false — write to a draft staging area instead). Capped by
 * `max_per_cycle` and the BudgetMeter's USD cap.
 *
 * Cooldown: `dream.auto_think.last_completion_ts` written ONLY on success
 * so retries after partial failures pick back up.
 *
 * Default-disabled. Operator opts in:
 *   gbrain config set dream.auto_think.enabled true
 *   gbrain config set dream.auto_think.questions '["What patterns ...","Who ..."]'
 */

import type { BrainEngine } from '../engine.ts';
import { runThink, persistSynthesis, type ThinkLLMClient } from '../think/index.ts';
import { resolveModel } from '../model-config.ts';
import { BudgetMeter } from './budget-meter.ts';

/**
 * Local phase-result type for auto-think/drift. These phases are not yet
 * wired into cycle.ts's main dispatcher (deferred to v0.28.x); they ship
 * standalone for now and are invoked via `gbrain dream --phase auto_think`
 * once the dispatcher integration lands. Adopting cycle.ts's PhaseResult
 * shape forces premature CyclePhase enum extension.
 */
export interface DreamPhaseResult {
  name: 'auto_think' | 'drift';
  status: 'complete' | 'partial' | 'failed' | 'skipped';
  detail: string;
  totals?: Record<string, number>;
  duration_ms: number;
}

export interface AutoThinkPhaseOpts {
  brainDir?: string;
  dryRun: boolean;
  /** Inject LLM client (tests). Defaults to the real Anthropic SDK. */
  client?: ThinkLLMClient;
  /** Override the audit-ledger path (tests). */
  auditPath?: string;
}

export interface AutoThinkConfig {
  enabled: boolean;
  questions: string[];
  maxPerCycle: number;
  budgetUsd: number;
  cooldownDays: number;
  autoCommit: boolean;
}

async function loadConfig(engine: BrainEngine): Promise<AutoThinkConfig> {
  const enabledStr = await engine.getConfig('dream.auto_think.enabled');
  const questionsStr = await engine.getConfig('dream.auto_think.questions');
  const maxPerStr = await engine.getConfig('dream.auto_think.max_per_cycle');
  const budgetStr = await engine.getConfig('dream.auto_think.budget');
  const cooldownStr = await engine.getConfig('dream.auto_think.cooldown_days');
  const autoCommitStr = await engine.getConfig('dream.auto_think.auto_commit');

  let questions: string[] = [];
  if (questionsStr) {
    try {
      const parsed = JSON.parse(questionsStr);
      if (Array.isArray(parsed)) questions = parsed.filter(q => typeof q === 'string');
    } catch { /* ignore */ }
  }

  return {
    enabled: enabledStr === 'true',
    questions,
    maxPerCycle: maxPerStr ? Math.max(1, parseInt(maxPerStr, 10) || 5) : 5,
    budgetUsd: budgetStr ? Math.max(0, parseFloat(budgetStr) || 2.0) : 2.0,
    cooldownDays: cooldownStr ? Math.max(0, parseInt(cooldownStr, 10) || 30) : 30,
    autoCommit: autoCommitStr === 'true',
  };
}

async function isCoolingDown(engine: BrainEngine, days: number): Promise<boolean> {
  if (days <= 0) return false;
  const last = await engine.getConfig('dream.auto_think.last_completion_ts');
  if (!last) return false;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return false;
  return (Date.now() - lastMs) < days * 86_400_000;
}

function skipped(_reason: string, detail: string): DreamPhaseResult {
  return { name: 'auto_think', status: 'skipped', detail, duration_ms: 0 };
}

export async function runPhaseAutoThink(
  engine: BrainEngine,
  opts: AutoThinkPhaseOpts,
): Promise<DreamPhaseResult> {
  const start = Date.now();
  const config = await loadConfig(engine);

  if (!config.enabled) {
    return skipped('not_configured', 'dream.auto_think.enabled is false');
  }
  if (config.questions.length === 0) {
    return skipped('no_questions', 'dream.auto_think.questions is empty');
  }
  if (await isCoolingDown(engine, config.cooldownDays)) {
    return skipped('cooldown_active', `auto_think cooled down (${config.cooldownDays}d cooldown)`);
  }

  const meter = new BudgetMeter({
    budgetUsd: config.budgetUsd,
    phase: 'auto_think',
    auditPath: opts.auditPath,
  });

  const modelId = await resolveModel(engine, {
    configKey: 'models.auto_think',
    deprecatedConfigKey: 'dream.auto_think.model',
    fallback: 'opus',
  });

  const limit = Math.min(config.questions.length, config.maxPerCycle);
  const results: Array<{ question: string; status: string; slug?: string; warnings?: string[] }> = [];

  for (let i = 0; i < limit; i++) {
    const q = config.questions[i];

    // Pre-check budget for the planned synthesize call. Estimate ~5K input tokens
    // (system + ~30 takes + 20 page chunks) and 4K output cap.
    const check = meter.check({
      modelId,
      estimatedInputTokens: 5_000,
      maxOutputTokens: 4_000,
      label: `auto_think:${q.slice(0, 40)}`,
    });
    if (!check.allowed) {
      results.push({ question: q, status: 'budget_exhausted' });
      break;
    }

    if (opts.dryRun) {
      results.push({ question: q, status: 'dry_run' });
      continue;
    }

    try {
      const result = await runThink(engine, {
        question: q,
        save: config.autoCommit,
        client: opts.client,
        model: modelId,
      });
      let slug: string | undefined;
      if (config.autoCommit) {
        const persisted = await persistSynthesis(engine, result);
        slug = persisted.slug;
      }
      results.push({
        question: q,
        status: 'complete',
        slug,
        warnings: result.warnings.length ? result.warnings : undefined,
      });
    } catch (e) {
      results.push({
        question: q,
        status: 'failed',
        warnings: [(e as Error).message],
      });
    }
  }

  // Update cooldown timestamp ONLY when at least one synthesis completed.
  const anyComplete = results.some(r => r.status === 'complete');
  if (anyComplete && !opts.dryRun) {
    await engine.setConfig('dream.auto_think.last_completion_ts', new Date().toISOString());
  }

  const detail = `${results.filter(r => r.status === 'complete').length} synthesized, ` +
    `${results.filter(r => r.status === 'budget_exhausted').length} skipped (budget), ` +
    `${results.filter(r => r.status === 'failed').length} failed. ` +
    `Cumulative cost: $${meter.totalSpent.toFixed(4)} / $${config.budgetUsd.toFixed(2)}`;

  return {
    name: 'auto_think',
    status: anyComplete ? 'complete' : (results.length === 0 ? 'skipped' : 'partial'),
    detail,
    totals: { questions_run: results.length, synthesized: results.filter(r => r.status === 'complete').length },
    duration_ms: Date.now() - start,
  };
}
