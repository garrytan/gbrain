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
  runners?: RestrictedRunnerCandidate[];
  runnerExecutor: RestrictedRunnerExecutor;
  contextLoader: (targetRef: string) => Promise<string | TargetContextSnapshot>;
  scope_id?: string;
  limit?: number;
  allow_canonical_page_writes?: boolean;
  max_runner_calls?: number;
  time_budget_ms?: number;
  exclude_candidate_ids?: string[];
}
export interface TargetContextSnapshot {
  text: string;
  content_hash: string | null;
}
export interface RunAutoPromoteResult {
  counts: {
    selected_low_risk: number;
    selected_risky: number;
    auto_promoted: number;
    canonical_handoffs: number;
    canonical_writes: number;
    escalated: number;
    deferred: number;
    excluded: number;
  };
  promoted: string[];
  excluded: { id: string; reason: string }[];
}

export async function runAutoPromote(input: RunAutoPromoteInput): Promise<RunAutoPromoteResult> {
  const scopeId = input.scope_id ?? 'workspace:default';
  if (!input.config.enabled) {
    return { counts: zeroCounts(), promoted: [], excluded: [] };
  }
  const excludeIds = new Set(input.exclude_candidate_ids ?? []);
  const allCandidates = (await input.engine.listMemoryCandidateEntries({ scope_id: scopeId, limit: input.limit ?? 200, offset: 0 }))
    .filter(isAutoPromoteOpenStatus);
  const selfConsumptionExcluded = allCandidates
    .filter((candidate) => excludeIds.has(candidate.id))
    .map((candidate) => ({ id: candidate.id, reason: 'dream_self_consumption_guard' }));
  const candidates = allCandidates.filter((candidate) => !excludeIds.has(candidate.id));
  const contradictionExcluded = await excludedByOpenContradiction(input, candidates);
  const contradictionExcludedIds = new Set(contradictionExcluded.map((entry) => entry.id));
  const buckets = selectAutoPromoteCandidates(
    candidates.filter((candidate) => !contradictionExcludedIds.has(candidate.id)),
    input.config,
  );

  const verdicts: PromotionVerdict[] = [];
  const targetSnapshotHashes = new Map<string, string | null>();
  const runnerBudget = {
    calls: 0,
    max: input.max_runner_calls ?? Number.POSITIVE_INFINITY,
  };
  const timeBudget = createTimeBudget(input.time_budget_ms);
  const timeBudgetExcluded: { id: string; reason: string }[] = [];
  for (const c of buckets.low_risk) {
    if (timeBudget.exceeded()) {
      timeBudgetExcluded.push({ id: c.id, reason: 'time_budget_exceeded' });
      continue;
    }
    const v = await judge(input, c, input.config.first_pass_model, targetSnapshotHashes, runnerBudget);
    if (v) verdicts.push(v);
  }
  let escalated = 0;
  if (input.config.escalation.enabled) {
    for (const c of buckets.risky.slice(0, input.config.escalation.max_per_cycle)) {
      if (timeBudget.exceeded()) {
        timeBudgetExcluded.push({ id: c.id, reason: 'time_budget_exceeded' });
        continue;
      }
      const v = await judge(input, c, input.config.escalation_model ?? input.config.first_pass_model, targetSnapshotHashes, runnerBudget);
      if (v) { verdicts.push(v); escalated++; }
    }
  }

  const gate = await runPromoteGate({
    engine: input.engine, verdicts, candidates: [...buckets.low_risk, ...buckets.risky],
    config: input.config, now: input.now, actor: 'mbrain:auto_promote',
    target_snapshot_hashes: targetSnapshotHashes,
    allow_canonical_page_writes: input.allow_canonical_page_writes === true,
    canonical_write_candidate_ids: new Set(buckets.low_risk.map((candidate) => candidate.id)),
  });
  const deferred = verdicts.filter((v) => v.decision === 'defer').length;
  const reportableGateSkips = gate.skipped.filter((entry) => isReportableGateSkip(entry.reason));
  const excluded = [
    ...selfConsumptionExcluded,
    ...contradictionExcluded.map((entry) => ({ id: entry.id, reason: 'open_contradiction' })),
    ...buckets.excluded.map((e) => ({ id: e.candidate.id, reason: e.reason })),
    ...timeBudgetExcluded,
    ...reportableGateSkips,
  ];

  return {
    counts: {
      selected_low_risk: buckets.low_risk.length,
      selected_risky: buckets.risky.length,
      auto_promoted: gate.promoted.length,
      canonical_handoffs: gate.canonical_handoffs.length,
      canonical_writes: gate.canonical_writes.length,
      escalated,
      deferred,
      excluded: excluded.length,
    },
    promoted: gate.promoted,
    excluded,
  };
}

function isReportableGateSkip(reason: string): boolean {
  return reason !== 'decision_defer' && reason !== 'below_threshold';
}

function createTimeBudget(timeBudgetMs: number | undefined): { exceeded: () => boolean } {
  if (timeBudgetMs === undefined) {
    return { exceeded: () => false };
  }
  const deadline = Date.now() + Math.max(0, timeBudgetMs);
  return { exceeded: () => Date.now() >= deadline };
}

function isAutoPromoteOpenStatus(candidate: { status: string }): boolean {
  return candidate.status === 'captured' || candidate.status === 'candidate';
}

async function excludedByOpenContradiction(
  input: RunAutoPromoteInput,
  candidates: Array<{ id: string }>,
): Promise<Array<{ id: string }>> {
  if (input.config.eligibility.allow_contradictions || candidates.length === 0) return [];
  const ids = candidates.map((candidate) => candidate.id);
  const contradictions = await input.engine.listMemoryCandidateContradictionEntriesForCandidateIds(ids);
  const conflicted = new Set<string>();
  for (const contradiction of contradictions) {
    if (contradiction.outcome !== 'unresolved') continue;
    if (ids.includes(contradiction.candidate_id)) conflicted.add(contradiction.candidate_id);
    if (ids.includes(contradiction.challenged_candidate_id)) conflicted.add(contradiction.challenged_candidate_id);
  }
  return [...conflicted].map((id) => ({ id }));
}

async function judge(
  input: RunAutoPromoteInput,
  c: {
    id: string;
    proposed_content: string;
    target_object_id: string | null;
    source_refs: string[];
    verification_status?: string;
    verification_method?: string | null;
    verification_evidence?: string | null;
  },
  _model: string | null,
  targetSnapshotHashes: Map<string, string | null>,
  runnerBudget: { calls: number; max: number },
): Promise<PromotionVerdict | null> {
  const targetContext = normalizeTargetContext(await input.contextLoader(c.target_object_id ?? ''));
  targetSnapshotHashes.set(c.id, targetContext.content_hash);
  const runners = input.runners?.length ? input.runners : [input.runner];
  const verification = promptVerificationFor(c);
  const prompt = buildPromotionReviewPrompt({
    candidate_content: c.proposed_content,
    target_ref: c.target_object_id ?? '(unknown)',
    target_context: targetContext.text,
    source_refs: c.source_refs,
    verification,
  });
  const toolPolicy = evaluateRunnerToolCall({ task_type: 'candidate_promotion_review', tool_name: 'emit_promotion_verdict' });

  for (const runner of runners) {
    const contentHash = promptInputHash({
      candidate_content: c.proposed_content,
      source_refs: c.source_refs,
      target_ref: c.target_object_id ?? '(unknown)',
      target_context: targetContext.text,
      verification,
      runner_kind: runner.kind,
      model: _model,
      prompt_version: PROMPT_VERSION,
    });
    const key = { candidate_id: c.id, content_hash: contentHash, runner_kind: runner.kind, prompt_version: PROMPT_VERSION };
    const cached = await input.engine.getAutoPromoteVerdict(key);
    if (cached) {
      // source_refs is empty: verdict cache doesn't persist them and the gate doesn't read them
      return { candidate_id: c.id, decision: cached.decision as PromotionVerdict['decision'], confidence: cached.confidence, reasoning: cached.reasoning, source_refs: [] };
    }
    if (runnerBudget.calls >= runnerBudget.max) return null;
    runnerBudget.calls += 1;
    const exec = await input.runnerExecutor({
      runner,
      task_type: 'candidate_promotion_review',
      source_scope: {} as RunnerSourceScope,
      prompt,
      input: '',
      tool_policy: toolPolicy,
      allowed_tools: ['emit_promotion_verdict'],
      model: _model,
    });
    if (exec.status !== 'succeeded') continue;
    const parsed = parsePromotionVerdict(exec.output, c.id);
    if (!parsed.ok) continue;
    if (!input.config.dry_run) {
      await input.engine.putAutoPromoteVerdict({ ...key, decision: parsed.verdict.decision, confidence: parsed.verdict.confidence, reasoning: parsed.verdict.reasoning, judged_at: input.now });
    }
    return parsed.verdict;
  }
  return null;
}

function zeroCounts(): RunAutoPromoteResult['counts'] {
  return {
    selected_low_risk: 0,
    selected_risky: 0,
    auto_promoted: 0,
    canonical_handoffs: 0,
    canonical_writes: 0,
    escalated: 0,
    deferred: 0,
    excluded: 0,
  };
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function promptInputHash(input: Record<string, unknown>): string {
  const sourceRefs = Array.isArray(input.source_refs)
    ? input.source_refs.filter((ref): ref is string => typeof ref === 'string').sort()
    : [];
  return sha256(JSON.stringify({
    ...input,
    source_refs: sourceRefs,
  }));
}

function promptVerificationFor(c: {
  verification_status?: string;
  verification_method?: string | null;
  verification_evidence?: string | null;
}): { status: 'verified' | 'refuted'; method: string; evidence: string } | null {
  if (c.verification_status !== 'verified' && c.verification_status !== 'refuted') return null;
  return {
    status: c.verification_status,
    method: c.verification_method ?? 'unknown',
    evidence: c.verification_evidence ?? '',
  };
}

function normalizeTargetContext(value: string | TargetContextSnapshot): TargetContextSnapshot {
  if (typeof value === 'string') return { text: value, content_hash: null };
  return {
    text: typeof value.text === 'string' ? value.text : '',
    content_hash: typeof value.content_hash === 'string' ? value.content_hash : null,
  };
}
