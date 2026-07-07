import type { BrainEngine } from '../engine.ts';
import type {
  CandidateSignal,
  MemoryActivationArtifact,
  MemoryActivationPolicyResult,
  MemoryScenario,
  ScopeGatePolicy,
  ScopeGateScope,
} from '../types.ts';
import { buildCandidateSignals } from './candidate-signal-service.ts';
import { buildCoreMemoryBlocks, type CoreMemoryBlocksResult } from './core-memory-blocks-service.ts';
import { selectActivationPolicy } from './memory-activation-policy-service.ts';

export type AgentSessionActivationRequestedScope = Exclude<ScopeGateScope, 'unknown'>;

export interface AgentSessionActivationPlanInput {
  query: string;
  requested_scope?: AgentSessionActivationRequestedScope;
  scenario?: MemoryScenario;
  task_id?: string;
  limit?: number;
  now?: Date;
}

export interface AgentSessionActivationPlan {
  scenario: MemoryScenario;
  artifacts: MemoryActivationArtifact[];
  policy: MemoryActivationPolicyResult;
  warnings: string[];
  /** N-3 always-injectable working set: budgeted derived pointers, never answer evidence. */
  core_memory_blocks: CoreMemoryBlocksResult;
}

export async function planAgentSessionActivation(
  engine: BrainEngine,
  input: AgentSessionActivationPlanInput,
): Promise<AgentSessionActivationPlan> {
  const limit = Math.max(1, Math.min(input.limit ?? 8, 20));
  const scenario = input.scenario ?? (
    input.requested_scope === 'personal' ? 'personal_recall' : 'coding_continuation'
  );
  const scanLimit = Math.max(limit, Math.min(limit * 4, 50));
  const [artifactGroups, coreMemoryBlocks] = await Promise.all([
    Promise.all([
      taskArtifacts(engine, input.task_id),
      profileArtifacts(engine, input.query, input.requested_scope, scanLimit),
      episodeArtifacts(engine, input.query, input.requested_scope, scanLimit),
      candidateArtifacts(engine, input, scenario, limit),
    ]),
    buildCoreMemoryBlocks(engine, { now: input.now }),
  ]);
  const artifacts = artifactGroups.flat().slice(0, limit);
  const policy = selectActivationPolicy({ scenario, artifacts });

  return {
    scenario,
    artifacts,
    policy,
    warnings: policy.stale_warnings,
    core_memory_blocks: coreMemoryBlocks,
  };
}

async function profileArtifacts(
  engine: BrainEngine,
  query: string,
  requestedScope: AgentSessionActivationRequestedScope | undefined,
  limit: number,
): Promise<MemoryActivationArtifact[]> {
  const entries = await engine.listProfileMemoryEntries({
    scope_id: 'personal:default',
    limit,
    offset: 0,
  });
  return entries
    .filter((entry) => entry.superseded_by == null)
    .filter((entry) => matchesQuery(query, [entry.subject, entry.content]))
    .map((entry) => ({
      id: normalizeId('profile-memory', entry.id),
      artifact_kind: 'profile_memory',
      source_ref: entry.source_refs[0],
      scope_policy: personalScopePolicy(requestedScope),
    }));
}

async function episodeArtifacts(
  engine: BrainEngine,
  query: string,
  requestedScope: AgentSessionActivationRequestedScope | undefined,
  limit: number,
): Promise<MemoryActivationArtifact[]> {
  const entries = await engine.listPersonalEpisodeEntries({
    scope_id: 'personal:default',
    limit,
    offset: 0,
  });
  return entries
    .filter((entry) => matchesQuery(query, [entry.title, entry.summary]))
    .map((entry) => ({
      id: normalizeId('personal-episode', entry.id),
      artifact_kind: 'personal_episode',
      source_ref: entry.source_refs[0],
      scope_policy: personalScopePolicy(requestedScope),
    }));
}

async function candidateArtifacts(
  engine: BrainEngine,
  input: AgentSessionActivationPlanInput,
  scenario: MemoryScenario,
  limit: number,
): Promise<MemoryActivationArtifact[]> {
  const result = await buildCandidateSignals(engine, {
    query: input.query,
    scenario,
    requested_scope: input.requested_scope,
    required_reads: [],
    canonical_candidates: [],
    limit,
  });
  return result.candidate_signals.map(signalToArtifact);
}

async function taskArtifacts(
  engine: BrainEngine,
  taskId: string | undefined,
): Promise<MemoryActivationArtifact[]> {
  if (!taskId) return [];
  const decisions = await engine.listTaskDecisions(taskId, { limit: 5 });
  return decisions.map((decision) => ({
    id: normalizeId('task-decision', decision.id),
    artifact_kind: 'task_decision',
  }));
}

function signalToArtifact(signal: CandidateSignal): MemoryActivationArtifact {
  return {
    id: normalizeId('memory-candidate', signal.candidate_id),
    artifact_kind: 'memory_candidate',
    scope_policy: signal.authority === 'unreviewed_candidate' ? 'allow' : undefined,
  };
}

function personalScopePolicy(
  requestedScope: AgentSessionActivationRequestedScope | undefined,
): ScopeGatePolicy {
  if (requestedScope === 'personal' || requestedScope === 'mixed') return 'allow';
  if (requestedScope === 'work') return 'deny';
  return 'defer';
}

function matchesQuery(query: string, values: readonly (string | null | undefined)[]): boolean {
  const tokens = tokenize(query);
  if (tokens.length === 0) return true;
  const haystack = values
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9가-힣_/-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function normalizeId(prefix: string, id: string): string {
  return id.startsWith(`${prefix}:`) ? id : `${prefix}:${id}`;
}
