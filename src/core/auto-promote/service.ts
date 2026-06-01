import { createHash } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type { RestrictedRunnerExecutor } from '../services/restricted-runner-service.ts';
import type { RestrictedRunnerCandidate } from '../runners/runner-registry.ts';
import { evaluateRunnerToolCall } from '../runners/runner-policy.ts';
import type { RunnerSourceScope } from '../runners/runner-jobs.ts';
import type { AutoPromoteConfig } from './config.ts';
import { selectAutoPromoteCandidates } from './candidate-selector.ts';
import { buildPromotionReviewPrompt, PROMPT_VERSION } from './prompt.ts';
import { parsePromotionVerdict, type PromotionVerdict } from './verdict.ts';
import { runPromoteGate } from './promote-gate.ts';

export interface RunAutoPromoteInput {
  engine: BrainEngine;
  config: AutoPromoteConfig;
  now: string;
  runner: RestrictedRunnerCandidate;
  runnerExecutor: RestrictedRunnerExecutor;
  contextLoader: (targetRef: string) => Promise<string>;
  scope_id?: string;
  limit?: number;
}
export interface RunAutoPromoteResult {
  counts: { selected_low_risk: number; selected_risky: number; auto_promoted: number; escalated: number; deferred: number; excluded: number };
  promoted: string[];
  excluded: { id: string; reason: string }[];
}

export async function runAutoPromote(input: RunAutoPromoteInput): Promise<RunAutoPromoteResult> {
  const scopeId = input.scope_id ?? 'workspace:default';
  if (!input.config.enabled) {
    return { counts: zeroCounts(), promoted: [], excluded: [] };
  }
  const candidates = await input.engine.listMemoryCandidateEntries({ scope_id: scopeId, limit: input.limit ?? 200, offset: 0 });
  const buckets = selectAutoPromoteCandidates(candidates, input.config);

  const verdicts: PromotionVerdict[] = [];
  for (const c of buckets.low_risk) {
    const v = await judge(input, c, input.config.first_pass_model);
    if (v) verdicts.push(v);
  }
  let escalated = 0;
  if (input.config.escalation.enabled) {
    for (const c of buckets.risky.slice(0, input.config.escalation.max_per_cycle)) {
      const v = await judge(input, c, input.config.escalation_model ?? input.config.first_pass_model);
      if (v) { verdicts.push(v); escalated++; }
    }
  }

  const gate = await runPromoteGate({
    engine: input.engine, verdicts, candidates: [...buckets.low_risk, ...buckets.risky],
    config: input.config, now: input.now, actor: 'mbrain:auto_promote',
  });
  const deferred = verdicts.filter((v) => v.decision === 'defer').length;

  return {
    counts: {
      selected_low_risk: buckets.low_risk.length,
      selected_risky: buckets.risky.length,
      auto_promoted: gate.promoted.length,
      escalated,
      deferred,
      excluded: buckets.excluded.length,
    },
    promoted: gate.promoted,
    excluded: buckets.excluded.map((e) => ({ id: e.candidate.id, reason: e.reason })),
  };
}

async function judge(
  input: RunAutoPromoteInput,
  c: { id: string; proposed_content: string; target_object_id: string | null; source_refs: string[] },
  _model: string | null,
): Promise<PromotionVerdict | null> {
  const contentHash = sha256(c.proposed_content);
  const key = { candidate_id: c.id, content_hash: contentHash, runner_kind: input.runner.kind, prompt_version: PROMPT_VERSION };
  const cached = await input.engine.getAutoPromoteVerdict(key);
  if (cached) {
    // source_refs is empty: verdict cache doesn't persist them and the gate doesn't read them
    return { candidate_id: c.id, decision: cached.decision as PromotionVerdict['decision'], confidence: cached.confidence, reasoning: cached.reasoning, source_refs: [] };
  }
  const prompt = buildPromotionReviewPrompt({
    candidate_content: c.proposed_content,
    target_ref: c.target_object_id ?? '(unknown)',
    target_context: await input.contextLoader(c.target_object_id ?? ''),
    source_refs: c.source_refs,
  });
  const toolPolicy = evaluateRunnerToolCall({ task_type: 'candidate_promotion_review', tool_name: 'emit_promotion_verdict' });
  const exec = await input.runnerExecutor({
    runner: input.runner,
    task_type: 'candidate_promotion_review',
    source_scope: {} as RunnerSourceScope,
    prompt,
    input: '',
    tool_policy: toolPolicy,
    allowed_tools: ['emit_promotion_verdict'],
  });
  if (exec.status !== 'succeeded') return null;
  const parsed = parsePromotionVerdict(exec.output, c.id);
  if (!parsed.ok) return null;
  await input.engine.putAutoPromoteVerdict({ ...key, decision: parsed.verdict.decision, confidence: parsed.verdict.confidence, reasoning: parsed.verdict.reasoning, judged_at: input.now });
  return parsed.verdict;
}

function zeroCounts(): RunAutoPromoteResult['counts'] {
  return { selected_low_risk: 0, selected_risky: 0, auto_promoted: 0, escalated: 0, deferred: 0, excluded: 0 };
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
