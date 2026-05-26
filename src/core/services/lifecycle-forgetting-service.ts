import {
  reResolveAssertionForSourceState,
} from '../assertions/assertion-evidence.ts';
import type {
  AssertionEvidenceRecord,
  AssertionRecord,
} from '../assertions/assertion-types.ts';
import {
  lifecycleSnapshotHash,
  type ForgettingPolicyRecord,
  type ForgettingEventRecord,
  type LifecycleForgettingStore,
  type MemoryLifecycleState,
  type MemoryLifecycleStateRecord,
  type MemoryTombstoneRecord,
  type PurgePlanItemRecord,
  type PurgePlanReviewDecision,
  type PurgePlanReviewResult,
  type PurgePlanRecord,
  type RestoreEventRecord,
} from '../maintenance/lifecycle-forgetting.ts';

export interface LifecycleForgettingService {
  transitionEntity(input: LifecycleTransitionInput): Promise<LifecycleTransitionResult>;
  restoreEntity(input: LifecycleRestoreInput): Promise<LifecycleRestoreResult>;
  runDueLifecycleTransitions(input: LifecycleTransitionSweepInput): Promise<LifecycleTransitionSweepResult>;
  planPurgeCandidates(input: LifecyclePurgePlanInput): Promise<LifecyclePurgePlanResult>;
  reviewPurgePlan(input: LifecyclePurgePlanReviewInput): Promise<PurgePlanReviewResult>;
  purgeEntity(input: LifecyclePurgeInput): Promise<LifecyclePurgeResult>;
  reResolveSourceChunkPurge(input: SourceChunkPurgeResolutionInput): Promise<SourceChunkPurgeResolutionResult>;
  buildDailyReport(input: LifecycleDailyReportInput): Promise<LifecycleDailyReport>;
}

export interface LifecycleForgettingServiceOptions {
  store: LifecycleForgettingStore;
  now: () => string;
  transaction: <T>(fn: (store: LifecycleForgettingStore) => Promise<T>) => Promise<T>;
}

export interface LifecycleTransitionInput {
  scope_id?: string;
  entity_type: string;
  entity_id: string;
  to_lifecycle_state: MemoryLifecycleState;
  from_lifecycle_state?: MemoryLifecycleState | null;
  policy_id?: string | null;
  reason: string;
  source_id?: string | null;
  sensitivity_level?: string | null;
  importance?: string | null;
  restore_until?: string | null;
  purge_after?: string | null;
  source_refs_json?: string[];
  actor?: string;
  job_id?: string | null;
  now?: string;
}

export interface LifecycleTransitionResult {
  state: MemoryLifecycleStateRecord;
  event: ForgettingEventRecord;
}

export interface LifecycleRestoreInput {
  entity_type: string;
  entity_id: string;
  scope_id?: string;
  to_lifecycle_state?: Extract<MemoryLifecycleState, 'active' | 'stale'>;
  reason: string;
  source_refs_json?: string[];
  actor?: string;
  now?: string;
}

export interface LifecycleRestoreResult {
  state: MemoryLifecycleStateRecord;
  restore_event: RestoreEventRecord;
  transition_event: ForgettingEventRecord;
}

export interface LifecyclePurgePlanInput {
  scope_id: string;
  reason: string;
  requested_by?: string | null;
  limit?: number;
  now?: string;
}

export interface LifecycleTransitionSweepInput {
  scope_id: string;
  limit?: number;
  now?: string;
  actor?: string;
  job_id?: string | null;
}

export interface LifecycleTransitionSweepResult {
  transitioned: LifecycleTransitionResult[];
  skipped: MemoryLifecycleStateRecord[];
}

export interface LifecyclePurgePlanResult {
  plan: PurgePlanRecord | null;
  items: PurgePlanItemRecord[];
}

export interface LifecyclePurgePlanReviewInput {
  purge_plan_id: string;
  decision: PurgePlanReviewDecision;
  review_reason: string;
  now?: string;
}

export interface LifecyclePurgeInput {
  scope_id?: string;
  entity_type: string;
  entity_id: string;
  reason: string;
  content_hash?: string | null;
  purge_plan_id?: string | null;
  metadata_json?: Record<string, unknown>;
  source_refs_json?: string[];
  actor?: string;
  now?: string;
}

export interface LifecyclePurgeResult {
  state: MemoryLifecycleStateRecord;
  event: ForgettingEventRecord;
  tombstone: MemoryTombstoneRecord;
}

export interface SourceChunkPurgeResolutionInput {
  scope_id?: string;
  source_chunk_id: string;
  assertion: AssertionRecord;
  evidence: AssertionEvidenceRecord[];
  reason: string;
  content_hash?: string | null;
  purge_plan_id?: string | null;
  now?: string;
}

export interface SourceChunkPurgeResolutionResult {
  purge: LifecyclePurgeResult;
  assertion: AssertionRecord;
  evidence: AssertionEvidenceRecord[];
}

export interface LifecycleDailyReportInput {
  scope_id?: string;
  now?: string;
  limit?: number;
}

export interface LifecycleDailyReport {
  generated_at: string;
  purge_candidate_count: number;
  restore_window_count: number;
  summary_lines: string[];
  purge_candidates: MemoryLifecycleStateRecord[];
  restore_windows: MemoryLifecycleStateRecord[];
}

const DEFAULT_ACTOR = 'mbrain:lifecycle-forgetting';

export function createLifecycleForgettingService(options: LifecycleForgettingServiceOptions): LifecycleForgettingService {
  const defaultStore = options.store;
  const atomic = <T>(fn: (store: LifecycleForgettingStore) => Promise<T>) => options.transaction(fn);
  const transitionEntityWithStore = async (
    store: LifecycleForgettingStore,
    input: LifecycleTransitionInput,
  ): Promise<LifecycleTransitionResult> => {
    const now = input.now ?? options.now();
    const scopeId = input.scope_id
      ?? (input.policy_id ? (await store.getForgettingPolicy(input.policy_id))?.scope_id : null)
      ?? 'workspace:default';
    const previous = input.from_lifecycle_state === undefined
      ? (await store.getLifecycleState(input.entity_type, input.entity_id, scopeId))?.lifecycle_state ?? null
      : input.from_lifecycle_state;
    const event = await store.createForgettingEvent({
      scope_id: scopeId,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      event_type: transitionEventType(previous, input.to_lifecycle_state),
      from_lifecycle_state: previous,
      to_lifecycle_state: input.to_lifecycle_state,
      policy_id: input.policy_id ?? null,
      reason: input.reason,
      source_refs_json: input.source_refs_json ?? [],
      actor: input.actor ?? DEFAULT_ACTOR,
      job_id: input.job_id ?? null,
      created_at: now,
    });
    const state = await store.upsertLifecycleState({
      scope_id: scopeId,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      lifecycle_state: input.to_lifecycle_state,
      policy_id: input.policy_id ?? null,
      reason: input.reason,
      source_id: input.source_id ?? null,
      sensitivity_level: input.sensitivity_level ?? null,
      importance: input.importance ?? null,
      restore_until: input.restore_until ?? null,
      purge_after: input.purge_after ?? null,
      last_transition_event_id: event.id,
      now,
    });
    await store.applyLifecycleTransitionSideEffects({
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      lifecycle_state: input.to_lifecycle_state,
      reason: input.reason,
      now,
    });
    return { state, event };
  };
  const purgeEntityWithStore = async (
    store: LifecycleForgettingStore,
    input: LifecyclePurgeInput,
  ): Promise<LifecyclePurgeResult> => {
    const now = input.now ?? options.now();
    const scopeId = input.scope_id ?? 'workspace:default';
    const current = await store.getLifecycleState(input.entity_type, input.entity_id, scopeId);
    if (!current) throw new Error(`memory lifecycle state not found for purge: ${input.entity_type}:${input.entity_id}`);
    if (current.lifecycle_state === 'purged') {
      throw new Error(`memory is already purged: ${input.entity_type}:${input.entity_id}`);
    }
    if (!['expired', 'archived'].includes(current.lifecycle_state)) {
      throw new Error(`memory purge requires expired or archived state: ${input.entity_type}:${input.entity_id}`);
    }
    if (current.purge_after && Date.parse(current.purge_after) > Date.parse(now)) {
      throw new Error(`memory purge is not due: ${input.entity_type}:${input.entity_id}`);
    }
    const policy = await resolveStatePolicy(store, current, current.policy_id, scopeId);
    if (!policy?.purge_eligible) {
      throw new Error(`memory purge is not allowed by forgetting policy: ${input.entity_type}:${input.entity_id}`);
    }
    if (!input.purge_plan_id) {
      throw new Error(`memory purge requires purge_plan_id for approved purge plan: ${input.entity_type}:${input.entity_id}`);
    }
    await assertApprovedPurgePlan(store, input.purge_plan_id, scopeId, input.entity_type, input.entity_id);
    const transition = await transitionEntityWithStore(store, {
      scope_id: scopeId,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      from_lifecycle_state: current.lifecycle_state,
      to_lifecycle_state: 'purged',
      policy_id: policy.id,
      reason: input.reason,
      source_id: current.source_id,
      sensitivity_level: current.sensitivity_level,
      importance: current.importance,
      purge_after: current.purge_after,
      source_refs_json: input.source_refs_json,
      actor: input.actor,
      now,
    });
    const tombstone = await store.createMemoryTombstone({
      scope_id: scopeId,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      purge_event_id: transition.event.id,
      purge_plan_id: input.purge_plan_id ?? null,
      reason: input.reason,
      content_hash: input.content_hash ?? null,
      metadata_json: input.metadata_json ?? {},
      created_at: now,
    });
    await store.applyPurgeSideEffects({
      scope_id: scopeId,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      policy_id: policy.id,
      reason: input.reason,
      purge_plan_id: input.purge_plan_id ?? null,
      tombstone_id: tombstone.id,
      now,
    });
    return {
      ...transition,
      tombstone,
    };
  };
  const service: LifecycleForgettingService = {
    async transitionEntity(input) {
      return atomic((store) => transitionEntityWithStore(store, input));
    },
    async restoreEntity(input) {
      return atomic(async (store) => {
        const now = input.now ?? options.now();
        const scopeId = input.scope_id ?? 'workspace:default';
        const current = await store.getLifecycleState(input.entity_type, input.entity_id, scopeId);
        if (!current) throw new Error(`memory lifecycle state not found: ${input.entity_type}:${input.entity_id}`);
        if (current.lifecycle_state === 'purged') {
          throw new Error(`purged memory cannot be restored: ${input.entity_type}:${input.entity_id}`);
        }
        if (!['stale', 'expired', 'archived'].includes(current.lifecycle_state)) {
          throw new Error(`memory lifecycle state is not restorable: ${current.lifecycle_state}`);
        }
        if (current.restore_until && Date.parse(current.restore_until) < Date.parse(now)) {
          throw new Error(`memory restore window expired: ${input.entity_type}:${input.entity_id}`);
        }
        const policy = await resolveStatePolicy(store, current, current.policy_id ? current.policy_id : null, scopeId);
        if (policy && !restoreAllowedByPolicy(policy, current)) {
          throw new Error(`memory restore is not allowed by forgetting policy: ${input.entity_type}:${input.entity_id}`);
        }
        const toLifecycleState = input.to_lifecycle_state ?? 'active';
        const restoreEvent = await store.createRestoreEvent({
          scope_id: scopeId,
          entity_type: input.entity_type,
          entity_id: input.entity_id,
          from_lifecycle_state: current.lifecycle_state as 'stale' | 'expired' | 'archived',
          to_lifecycle_state: toLifecycleState,
          policy_id: current.policy_id,
          reason: input.reason,
          source_refs_json: input.source_refs_json ?? [],
          actor: input.actor ?? DEFAULT_ACTOR,
          restored_at: now,
        });
        const transition = await transitionEntityWithStore(store, {
          entity_type: input.entity_type,
          entity_id: input.entity_id,
          scope_id: scopeId,
          from_lifecycle_state: current.lifecycle_state,
          to_lifecycle_state: toLifecycleState,
          policy_id: current.policy_id,
          reason: input.reason,
          source_id: current.source_id,
          sensitivity_level: current.sensitivity_level,
          importance: current.importance,
          restore_until: null,
          purge_after: current.purge_after,
          source_refs_json: input.source_refs_json,
          actor: input.actor,
          now,
        });
        return {
          state: transition.state,
          restore_event: restoreEvent,
          transition_event: transition.event,
        };
      });
    },
    async runDueLifecycleTransitions(input) {
      return atomic(async (store) => {
        const now = input.now ?? options.now();
        const states = await store.listLifecycleStates({
          scope_id: input.scope_id,
          lifecycle_states: ['active', 'stale', 'expired'],
          limit: input.limit,
        });
        const transitioned: LifecycleTransitionResult[] = [];
        const skipped: MemoryLifecycleStateRecord[] = [];
        for (const state of states) {
          const policy = await resolveStatePolicy(store, state, state.policy_id, input.scope_id);
          if (!policy) {
            skipped.push(state);
            continue;
          }
          const target = dueLifecycleTarget(state, policy, now);
          if (!target) continue;
          transitioned.push(await transitionEntityWithStore(store, {
            entity_type: state.entity_type,
            entity_id: state.entity_id,
            scope_id: state.scope_id,
            from_lifecycle_state: state.lifecycle_state,
            to_lifecycle_state: target,
            policy_id: policy.id,
            reason: `forgetting policy moved ${state.lifecycle_state} to ${target}`,
            source_id: state.source_id,
            sensitivity_level: state.sensitivity_level,
            importance: state.importance,
            restore_until: restoreUntilForTransition(policy, now, state.restore_until),
            purge_after: purgeAfterForTransition(policy, target, now, state.purge_after),
            actor: input.actor ?? DEFAULT_ACTOR,
            job_id: input.job_id ?? null,
            now,
          }));
        }
        return { transitioned, skipped };
      });
    },
    async planPurgeCandidates(input) {
      return atomic(async (store) => {
        const now = input.now ?? options.now();
        const rawCandidates = await store.listLifecycleStates({
          scope_id: input.scope_id,
          lifecycle_states: ['expired', 'archived'],
          purge_due_at: now,
          limit: input.limit,
        });
        const candidates: MemoryLifecycleStateRecord[] = [];
        for (const candidate of rawCandidates) {
          if (await isPurgeCandidateAllowed(store, candidate, input.scope_id)) {
            candidates.push(candidate);
          }
        }
        if (candidates.length === 0) {
          return { plan: null, items: [] };
        }
        const plan = await store.createPurgePlan({
          scope_id: input.scope_id,
          reason: input.reason,
          requested_by: input.requested_by ?? DEFAULT_ACTOR,
          created_at: now,
        });
        const items: PurgePlanItemRecord[] = [];
        for (const candidate of candidates) {
          items.push(await store.createPurgePlanItem({
            plan_id: plan.id,
            entity_type: candidate.entity_type,
            entity_id: candidate.entity_id,
            lifecycle_state: candidate.lifecycle_state as 'expired' | 'archived',
            purge_after: candidate.purge_after,
            before_hash: lifecycleSnapshotHash(candidate),
            reason: candidate.reason || input.reason,
            created_at: now,
          }));
        }
        return { plan, items };
      });
    },
    async reviewPurgePlan(input) {
      return atomic(async (store) => {
        const now = input.now ?? options.now();
        const plan = await store.getPurgePlan(input.purge_plan_id);
        if (!plan) {
          throw new Error(`purge plan not found: ${input.purge_plan_id}`);
        }
        if (plan.status !== 'draft') {
          throw new Error(`purge plan cannot be reviewed from status ${plan.status}: ${input.purge_plan_id}`);
        }
        return store.reviewPurgePlan({
          plan_id: input.purge_plan_id,
          decision: input.decision,
          review_reason: input.review_reason,
          reviewed_at: now,
        });
      });
    },
    async purgeEntity(input) {
      return atomic((store) => purgeEntityWithStore(store, input));
    },
    async reResolveSourceChunkPurge(input) {
      return atomic(async (store) => {
        const now = input.now ?? options.now();
        const purge = await purgeEntityWithStore(store, {
          entity_type: 'source_chunk',
          entity_id: input.source_chunk_id,
          scope_id: input.scope_id,
          reason: input.reason,
          content_hash: input.content_hash ?? null,
          purge_plan_id: input.purge_plan_id ?? null,
          metadata_json: {
            affected_assertion_id: input.assertion.id,
            affected_evidence_ids: input.evidence
              .filter((entry) => entry.source_chunk_id === input.source_chunk_id)
              .map((entry) => entry.id),
          },
          source_refs_json: [`source-chunk:${input.source_chunk_id}`],
          now,
        });
        const resolution = reResolveAssertionForSourceState(input.assertion, input.evidence, {
          purged_source_chunk_ids: [input.source_chunk_id],
        });
        await store.persistSourceChunkPurgeResolution({
          source_chunk_id: input.source_chunk_id,
          assertion: resolution.assertion,
          evidence: resolution.evidence,
          now,
        });
        return {
          purge,
          ...resolution,
        };
      });
    },
    async buildDailyReport(input) {
      const now = input.now ?? options.now();
      const rawPurgeCandidates = await defaultStore.listLifecycleStates({
        scope_id: input.scope_id ?? 'workspace:default',
        lifecycle_states: ['expired', 'archived'],
        purge_due_at: now,
        limit: input.limit,
      });
      const purgeCandidates: MemoryLifecycleStateRecord[] = [];
      for (const candidate of rawPurgeCandidates) {
        if (await isPurgeCandidateAllowed(defaultStore, candidate, input.scope_id ?? 'workspace:default')) {
          purgeCandidates.push(candidate);
        }
      }
      const restoreWindows = await defaultStore.listLifecycleStates({
        scope_id: input.scope_id ?? 'workspace:default',
        lifecycle_states: ['stale', 'expired', 'archived'],
        restore_available_at: now,
        limit: input.limit,
      });
      return {
        generated_at: now,
        purge_candidate_count: purgeCandidates.length,
        restore_window_count: restoreWindows.length,
        purge_candidates: purgeCandidates,
        restore_windows: restoreWindows,
        summary_lines: [
          `Lifecycle forgetting report for ${input.scope_id ?? 'workspace:default'}.`,
          `Purge candidates: ${purgeCandidates.length}.`,
          `Open restore windows: ${restoreWindows.length}.`,
        ],
      };
    },
  };
  return service;
}

function transitionEventType(
  from: MemoryLifecycleState | null,
  to: MemoryLifecycleState,
): string {
  if (to === 'purged') return 'purged';
  if (from === null) return 'lifecycle_initialized';
  if (from === to) return 'lifecycle_refreshed';
  return `lifecycle_${from}_to_${to}`;
}

async function isPurgeCandidateAllowed(
  store: LifecycleForgettingStore,
  candidate: MemoryLifecycleStateRecord,
  scopeId: string,
): Promise<boolean> {
  const policy = await resolveStatePolicy(store, candidate, candidate.policy_id, scopeId);
  if (!policy) return false;
  return policy.purge_eligible;
}

async function resolveStatePolicy(
  store: LifecycleForgettingStore,
  state: MemoryLifecycleStateRecord,
  policyId: string | null,
  scopeId: string,
): Promise<ForgettingPolicyRecord | null> {
  return store.resolveForgettingPolicyForLifecycleState({
    scope_id: scopeId,
    entity_type: state.entity_type,
    entity_id: state.entity_id,
    policy_id: policyId,
    source_id: state.source_id,
    sensitivity_level: state.sensitivity_level,
    importance: state.importance,
  });
}

async function assertApprovedPurgePlan(
  store: LifecycleForgettingStore,
  purgePlanId: string,
  scopeId: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  const plan = await store.getPurgePlan(purgePlanId);
  if (!plan || plan.scope_id !== scopeId || plan.status !== 'approved') {
    throw new Error(`memory purge requires an approved purge plan: ${entityType}:${entityId}`);
  }
  const matchingItem = (await store.listPurgePlanItems(plan.id))
    .find((item) => item.entity_type === entityType && item.entity_id === entityId);
  if (!matchingItem || matchingItem.status !== 'approved') {
    throw new Error(`memory purge requires an approved purge plan item: ${entityType}:${entityId}`);
  }
}

function restoreAllowedByPolicy(
  policy: ForgettingPolicyRecord,
  state: MemoryLifecycleStateRecord,
): boolean {
  if (policy.sensitivity_level && policy.sensitivity_level !== state.sensitivity_level) return false;
  const restoreWindow = (policy.restore_window ?? '').trim().toLowerCase();
  if (!restoreWindow) return true;
  return !['never', 'none', 'no_restore', 'disabled', 'purged_only'].includes(restoreWindow);
}

function dueLifecycleTarget(
  state: MemoryLifecycleStateRecord,
  policy: ForgettingPolicyRecord,
  now: string,
): Extract<MemoryLifecycleState, 'stale' | 'expired' | 'archived'> | null {
  if (state.lifecycle_state === 'active') {
    if (isDurationDue(state.updated_at, policy.stale_after, now)) return 'stale';
    if (isDurationDue(state.updated_at, policy.expire_after, now)) return 'expired';
    if (isDurationDue(state.updated_at, policy.archive_after, now)) return 'archived';
  }
  if (state.lifecycle_state === 'stale') {
    if (isDurationDue(state.updated_at, policy.expire_after, now)) return 'expired';
    if (isDurationDue(state.updated_at, policy.archive_after, now)) return 'archived';
  }
  if (state.lifecycle_state === 'expired') {
    if (isDurationDue(state.updated_at, policy.archive_after, now)) return 'archived';
  }
  return null;
}

function restoreUntilForTransition(
  policy: ForgettingPolicyRecord,
  now: string,
  currentRestoreUntil: string | null,
): string | null {
  return addDuration(now, policy.restore_window) ?? currentRestoreUntil;
}

function purgeAfterForTransition(
  policy: ForgettingPolicyRecord,
  target: MemoryLifecycleState,
  now: string,
  currentPurgeAfter: string | null,
): string | null {
  if (target === 'archived') {
    return addDuration(now, policy.archive_retention) ?? addDuration(now, policy.purge_after) ?? currentPurgeAfter;
  }
  return addDuration(now, policy.purge_after) ?? currentPurgeAfter;
}

function isDurationDue(base: string, duration: string | null, now: string): boolean {
  const dueAt = addDuration(base, duration);
  return dueAt !== null && Date.parse(dueAt) <= Date.parse(now);
}

function addDuration(base: string, duration: string | null): string | null {
  const milliseconds = parseDurationMillis(duration);
  if (milliseconds === null) return null;
  const baseTime = Date.parse(base);
  if (Number.isNaN(baseTime)) return null;
  return new Date(baseTime + milliseconds).toISOString();
}

function parseDurationMillis(duration: string | null): number | null {
  if (!duration) return null;
  const value = duration.trim();
  if (!value) return null;
  const compact = value.match(/^(\d+)(ms|s|m|h|d)$/i);
  if (compact) {
    const amount = Number(compact[1]);
    const unit = compact[2].toLowerCase();
    const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return amount * multiplier;
  }
  const iso = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (iso) {
    const days = Number(iso[1] ?? 0);
    const hours = Number(iso[2] ?? 0);
    const minutes = Number(iso[3] ?? 0);
    const seconds = Number(iso[4] ?? 0);
    return days * 86_400_000 + hours * 3_600_000 + minutes * 60_000 + seconds * 1000;
  }
  return null;
}
