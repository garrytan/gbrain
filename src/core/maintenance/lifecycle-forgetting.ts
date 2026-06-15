import type { BrainEngine } from '../engine.ts';
import { PostgresEngine } from '../postgres-engine.ts';
import {
  canonicalJson,
  stableId,
  type AssertionLifecycleState,
  type AssertionEvidenceRecord,
  type AssertionRecord,
} from '../assertions/assertion-types.ts';

export const MEMORY_LIFECYCLE_ENTITY_TYPES = [
  'assertion',
  'assertion_evidence',
  'source_item',
  'source_chunk',
  'projection_target',
  'task_thread',
  'task_event',
  'task_attempt',
  'working_set',
  'retrieval_trace',
  'handoff',
  'memory_session',
  'report',
] as const;

export type MemoryLifecycleEntityType = typeof MEMORY_LIFECYCLE_ENTITY_TYPES[number] | string;
export type MemoryLifecycleState = AssertionLifecycleState;
export type LifecycleActivation = 'answer_ground' | 'verify_first' | 'audit_only';
export type PurgePlanStatus = 'draft' | 'approved' | 'applied' | 'rejected' | 'cancelled';
export type PurgePlanItemStatus = 'planned' | 'approved' | 'purged' | 'skipped' | 'blocked';
export type PurgePlanReviewDecision = 'approve' | 'reject' | 'cancel';

export interface ForgettingPolicyRecord {
  id: string;
  scope_id: string;
  entity_type: string;
  source_kind: string | null;
  claim_type: string | null;
  sensitivity_level: string | null;
  importance: string | null;
  stale_after: string | null;
  expire_after: string | null;
  archive_after: string | null;
  restore_window: string | null;
  archive_retention: string | null;
  purge_after: string | null;
  purge_eligible: boolean;
  report_visibility: 'hidden' | 'summary' | 'audit';
  policy_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface MemoryLifecycleStateRecord {
  id: string;
  scope_id: string;
  entity_type: string;
  entity_id: string;
  lifecycle_state: MemoryLifecycleState;
  policy_id: string | null;
  reason: string;
  source_id: string | null;
  sensitivity_level: string | null;
  importance: string | null;
  restore_until: string | null;
  purge_after: string | null;
  last_transition_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ForgettingEventRecord {
  id: string;
  scope_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  from_lifecycle_state: MemoryLifecycleState | null;
  to_lifecycle_state: MemoryLifecycleState | null;
  policy_id: string | null;
  reason: string;
  source_refs_json: string[];
  actor: string;
  job_id: string | null;
  created_at: string;
}

export interface PurgePlanRecord {
  id: string;
  scope_id: string;
  status: PurgePlanStatus;
  reason: string;
  requested_by: string | null;
  review_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
  applied_at: string | null;
}

export interface PurgePlanItemRecord {
  id: string;
  plan_id: string;
  entity_type: string;
  entity_id: string;
  lifecycle_state: Extract<MemoryLifecycleState, 'expired' | 'archived' | 'purged'>;
  status: PurgePlanItemStatus;
  purge_after: string | null;
  tombstone_id: string | null;
  before_hash: string | null;
  evidence_ids_json: string[];
  reason: string;
  created_at: string;
  updated_at: string;
}

export interface RestoreEventRecord {
  id: string;
  scope_id: string;
  entity_type: string;
  entity_id: string;
  from_lifecycle_state: Extract<MemoryLifecycleState, 'stale' | 'expired' | 'archived'>;
  to_lifecycle_state: Extract<MemoryLifecycleState, 'active' | 'stale'>;
  policy_id: string | null;
  reason: string;
  source_refs_json: string[];
  actor: string;
  restored_at: string;
}

export interface MemoryTombstoneRecord {
  id: string;
  scope_id: string;
  entity_type: string;
  entity_id: string;
  purge_event_id: string | null;
  purge_plan_id: string | null;
  reason: string;
  content_hash: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface ForgettingPolicyInput {
  id?: string;
  scope_id: string;
  entity_type?: string;
  source_kind?: string | null;
  claim_type?: string | null;
  sensitivity_level?: string | null;
  importance?: string | null;
  stale_after?: string | null;
  expire_after?: string | null;
  archive_after?: string | null;
  restore_window?: string | null;
  archive_retention?: string | null;
  purge_after?: string | null;
  purge_eligible?: boolean;
  report_visibility?: 'hidden' | 'summary' | 'audit';
  policy_json?: Record<string, unknown>;
  now: string;
}

export interface MemoryLifecycleStateInput {
  id?: string;
  scope_id?: string;
  entity_type: string;
  entity_id: string;
  lifecycle_state: MemoryLifecycleState;
  policy_id?: string | null;
  reason?: string;
  source_id?: string | null;
  sensitivity_level?: string | null;
  importance?: string | null;
  restore_until?: string | null;
  purge_after?: string | null;
  last_transition_event_id?: string | null;
  now: string;
}

export interface ForgettingEventInput {
  id?: string;
  scope_id?: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  from_lifecycle_state?: MemoryLifecycleState | null;
  to_lifecycle_state?: MemoryLifecycleState | null;
  policy_id?: string | null;
  reason?: string;
  source_refs_json?: string[];
  actor?: string;
  job_id?: string | null;
  created_at: string;
}

export interface PurgePlanInput {
  id?: string;
  scope_id: string;
  status?: PurgePlanStatus;
  reason?: string;
  requested_by?: string | null;
  review_reason?: string | null;
  created_at: string;
}

export interface PurgePlanItemInput {
  id?: string;
  plan_id: string;
  entity_type: string;
  entity_id: string;
  lifecycle_state: Extract<MemoryLifecycleState, 'expired' | 'archived' | 'purged'>;
  status?: PurgePlanItemStatus;
  purge_after?: string | null;
  tombstone_id?: string | null;
  before_hash?: string | null;
  evidence_ids_json?: string[];
  reason?: string;
  created_at: string;
}

export interface PurgePlanReviewInput {
  plan_id: string;
  decision: PurgePlanReviewDecision;
  review_reason: string;
  reviewed_at: string;
}

export interface PurgePlanReviewResult {
  plan: PurgePlanRecord;
  items: PurgePlanItemRecord[];
}

export interface RestoreEventInput {
  id?: string;
  scope_id?: string;
  entity_type: string;
  entity_id: string;
  from_lifecycle_state: Extract<MemoryLifecycleState, 'stale' | 'expired' | 'archived'>;
  to_lifecycle_state: Extract<MemoryLifecycleState, 'active' | 'stale'>;
  policy_id?: string | null;
  reason?: string;
  source_refs_json?: string[];
  actor?: string;
  restored_at: string;
}

export interface MemoryTombstoneInput {
  id?: string;
  scope_id?: string;
  entity_type: string;
  entity_id: string;
  purge_event_id?: string | null;
  purge_plan_id?: string | null;
  reason?: string;
  content_hash?: string | null;
  metadata_json?: Record<string, unknown>;
  created_at: string;
}

export interface MemoryLifecycleStateFilters {
  scope_id?: string;
  entity_type?: string;
  lifecycle_states?: readonly MemoryLifecycleState[];
  purge_due_at?: string;
  restore_available_at?: string;
  limit?: number;
}

export interface ForgettingEventFilters {
  scope_id?: string;
  entity_type?: string;
  entity_id?: string;
  limit?: number;
}

export interface ForgettingPolicyResolutionInput {
  scope_id: string;
  entity_type: string;
  entity_id: string;
  policy_id?: string | null;
  source_id?: string | null;
  sensitivity_level?: string | null;
  claim_type?: string | null;
  importance?: string | null;
}

export interface LifecycleForgettingStore {
  upsertForgettingPolicy(input: ForgettingPolicyInput): Promise<ForgettingPolicyRecord>;
  getForgettingPolicy(id: string): Promise<ForgettingPolicyRecord | null>;
  resolveForgettingPolicyForLifecycleState(input: ForgettingPolicyResolutionInput): Promise<ForgettingPolicyRecord | null>;
  upsertLifecycleState(input: MemoryLifecycleStateInput): Promise<MemoryLifecycleStateRecord>;
  getLifecycleState(entityType: string, entityId: string, scopeId?: string): Promise<MemoryLifecycleStateRecord | null>;
  listLifecycleStates(filters?: MemoryLifecycleStateFilters): Promise<MemoryLifecycleStateRecord[]>;
  createForgettingEvent(input: ForgettingEventInput): Promise<ForgettingEventRecord>;
  listForgettingEvents(filters?: ForgettingEventFilters): Promise<ForgettingEventRecord[]>;
  createPurgePlan(input: PurgePlanInput): Promise<PurgePlanRecord>;
  getPurgePlan(id: string): Promise<PurgePlanRecord | null>;
  createPurgePlanItem(input: PurgePlanItemInput): Promise<PurgePlanItemRecord>;
  listPurgePlanItems(planId: string): Promise<PurgePlanItemRecord[]>;
  reviewPurgePlan(input: PurgePlanReviewInput): Promise<PurgePlanReviewResult>;
  createRestoreEvent(input: RestoreEventInput): Promise<RestoreEventRecord>;
  createMemoryTombstone(input: MemoryTombstoneInput): Promise<MemoryTombstoneRecord>;
  getMemoryTombstone(entityType: string, entityId: string, scopeId?: string): Promise<MemoryTombstoneRecord | null>;
  applyLifecycleTransitionSideEffects(input: LifecycleTransitionSideEffectInput): Promise<void>;
  applyPurgeSideEffects(input: LifecyclePurgeSideEffectInput): Promise<void>;
  persistSourceChunkPurgeResolution(input: SourceChunkPurgePersistenceInput): Promise<void>;
}

export interface LifecycleTransitionSideEffectInput {
  entity_type: string;
  entity_id: string;
  lifecycle_state: MemoryLifecycleState;
  reason: string;
  now: string;
}

export interface LifecyclePurgeSideEffectInput {
  scope_id: string;
  entity_type: string;
  entity_id: string;
  policy_id?: string | null;
  reason: string;
  purge_plan_id?: string | null;
  tombstone_id: string;
  now: string;
}

export interface SourceChunkPurgePersistenceInput {
  source_chunk_id: string;
  assertion: AssertionRecord;
  evidence: AssertionEvidenceRecord[];
  now: string;
}

interface SQLiteStatement<T> {
  get(...params: unknown[]): T | null;
  all(...params: unknown[]): T[];
  run(...params: unknown[]): unknown;
}

interface SQLiteDatabaseLike {
  query<T = Record<string, unknown>>(sql: string): SQLiteStatement<T>;
}

interface PostgresUnsafeLike {
  unsafe(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

interface AsyncSqlExecutor {
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
}

export function lifecycleStateId(scopeId: string, entityType: string, entityId: string): string {
  return stableId('memory-lifecycle', scopeId, entityType, entityId);
}

export function forgettingEventId(input: Omit<ForgettingEventInput, 'id'>): string {
  return stableId(
    'forgetting-event',
    input.scope_id ?? 'workspace:default',
    input.entity_type,
    input.entity_id,
    input.event_type,
    input.from_lifecycle_state ?? '',
    input.to_lifecycle_state ?? '',
    input.policy_id ?? '',
    input.created_at,
  );
}

export function purgePlanId(scopeId: string, reason: string, createdAt: string): string {
  return stableId('purge-plan', scopeId, reason, createdAt);
}

export function purgePlanItemId(planId: string, entityType: string, entityId: string): string {
  return stableId('purge-plan-item', planId, entityType, entityId);
}

export function restoreEventId(input: Omit<RestoreEventInput, 'id'>): string {
  return stableId(
    'restore-event',
    input.scope_id ?? 'workspace:default',
    input.entity_type,
    input.entity_id,
    input.from_lifecycle_state,
    input.to_lifecycle_state,
    input.restored_at,
  );
}

export function memoryTombstoneId(scopeId: string, entityType: string, entityId: string): string {
  return stableId('memory-tombstone', scopeId, entityType, entityId);
}

export function forgettingPolicyId(input: Omit<ForgettingPolicyInput, 'id' | 'now'>): string {
  return stableId(
    'forgetting-policy',
    input.scope_id,
    input.entity_type ?? '*',
    input.source_kind ?? '*',
    input.claim_type ?? '*',
    input.sensitivity_level ?? '*',
    input.importance ?? '*',
  );
}

export function createSQLiteLifecycleForgettingStore(database: SQLiteDatabaseLike): LifecycleForgettingStore {
  return {
    async upsertForgettingPolicy(input) {
      const id = input.id ?? forgettingPolicyId(input);
      database.query(`
        INSERT INTO forgetting_policies (
          id,
          scope_id,
          entity_type,
          source_kind,
          claim_type,
          sensitivity_level,
          importance,
          stale_after,
          expire_after,
          archive_after,
          restore_window,
          archive_retention,
          purge_after,
          purge_eligible,
          report_visibility,
          policy_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          scope_id = excluded.scope_id,
          entity_type = excluded.entity_type,
          source_kind = excluded.source_kind,
          claim_type = excluded.claim_type,
          sensitivity_level = excluded.sensitivity_level,
          importance = excluded.importance,
          stale_after = excluded.stale_after,
          expire_after = excluded.expire_after,
          archive_after = excluded.archive_after,
          restore_window = excluded.restore_window,
          archive_retention = excluded.archive_retention,
          purge_after = excluded.purge_after,
          purge_eligible = excluded.purge_eligible,
          report_visibility = excluded.report_visibility,
          policy_json = excluded.policy_json,
          updated_at = excluded.updated_at
      `).run(
        id,
        input.scope_id,
        input.entity_type ?? 'any',
        input.source_kind ?? null,
        input.claim_type ?? null,
        input.sensitivity_level ?? null,
        input.importance ?? null,
        input.stale_after ?? null,
        input.expire_after ?? null,
        input.archive_after ?? null,
        input.restore_window ?? null,
        input.archive_retention ?? null,
        input.purge_after ?? null,
        input.purge_eligible === true ? 1 : 0,
        input.report_visibility ?? 'summary',
        JSON.stringify(input.policy_json ?? {}),
        input.now,
        input.now,
      );
      const stored = await this.getForgettingPolicy(id);
      if (!stored) throw new Error(`forgetting policy was not stored: ${id}`);
      return stored;
    },
    async getForgettingPolicy(id) {
      const row = database.query(`
        SELECT *
        FROM forgetting_policies
        WHERE id = ?
      `).get(id);
      return row ? rowToForgettingPolicy(row) : null;
    },
    async resolveForgettingPolicyForLifecycleState(input) {
      const explicitPolicy = input.policy_id ? await this.getForgettingPolicy(input.policy_id) : null;
      const sourceKind = resolveSQLiteSourceKind(database, input);
      const claimType = resolveSQLiteClaimType(database, input);
      if (explicitPolicy) {
        return forgettingPolicyMatchesState(explicitPolicy, input, sourceKind, claimType) ? explicitPolicy : null;
      }
      const row = database.query(`
        SELECT *
        FROM forgetting_policies
        WHERE scope_id = ?
          AND (entity_type = ? OR entity_type = 'any')
          AND (source_kind IS NULL OR (? IS NOT NULL AND source_kind = ?))
          AND (claim_type IS NULL OR (? IS NOT NULL AND claim_type = ?))
          AND (sensitivity_level IS NULL OR (? IS NOT NULL AND sensitivity_level = ?))
          AND (importance IS NULL OR (? IS NOT NULL AND importance = ?))
        ORDER BY
          CASE WHEN entity_type = ? THEN 0 ELSE 1 END,
          CASE WHEN source_kind = ? THEN 0 WHEN source_kind IS NULL THEN 1 ELSE 2 END,
          CASE WHEN claim_type = ? THEN 0 WHEN claim_type IS NULL THEN 1 ELSE 2 END,
          CASE WHEN sensitivity_level = ? THEN 0 WHEN sensitivity_level IS NULL THEN 1 ELSE 2 END,
          CASE WHEN importance = ? THEN 0 WHEN importance IS NULL THEN 1 ELSE 2 END,
          updated_at DESC,
          id ASC
        LIMIT 1
      `).get(
        input.scope_id,
        input.entity_type,
        sourceKind,
        sourceKind,
        claimType,
        claimType,
        input.sensitivity_level ?? null,
        input.sensitivity_level ?? null,
        input.importance ?? null,
        input.importance ?? null,
        input.entity_type,
        sourceKind,
        claimType,
        input.sensitivity_level ?? null,
        input.importance ?? null,
      );
      return row ? rowToForgettingPolicy(row) : null;
    },
    async upsertLifecycleState(input) {
      const scopeId = input.scope_id ?? 'workspace:default';
      const id = input.id ?? lifecycleStateId(scopeId, input.entity_type, input.entity_id);
      database.query(`
        INSERT INTO memory_lifecycle_states (
          id,
          scope_id,
          entity_type,
          entity_id,
          lifecycle_state,
          policy_id,
          reason,
          source_id,
          sensitivity_level,
          importance,
          restore_until,
          purge_after,
          last_transition_event_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, entity_type, entity_id) DO UPDATE SET
          lifecycle_state = excluded.lifecycle_state,
          policy_id = excluded.policy_id,
          reason = excluded.reason,
          source_id = excluded.source_id,
          sensitivity_level = excluded.sensitivity_level,
          importance = excluded.importance,
          restore_until = excluded.restore_until,
          purge_after = excluded.purge_after,
          last_transition_event_id = excluded.last_transition_event_id,
          updated_at = excluded.updated_at
      `).run(
        id,
        scopeId,
        input.entity_type,
        input.entity_id,
        input.lifecycle_state,
        input.policy_id ?? null,
        input.reason ?? '',
        input.source_id ?? null,
        input.sensitivity_level ?? null,
        input.importance ?? null,
        input.restore_until ?? null,
        input.purge_after ?? null,
        input.last_transition_event_id ?? null,
        input.now,
        input.now,
      );
      const stored = await this.getLifecycleState(input.entity_type, input.entity_id, scopeId);
      if (!stored) throw new Error(`memory lifecycle state was not stored: ${input.entity_type}:${input.entity_id}`);
      return stored;
    },
    async getLifecycleState(entityType, entityId, scopeId = 'workspace:default') {
      const row = database.query(`
        SELECT *
        FROM memory_lifecycle_states
        WHERE scope_id = ?
          AND entity_type = ?
          AND entity_id = ?
      `).get(scopeId, entityType, entityId);
      return row ? rowToLifecycleState(row) : null;
    },
    async listLifecycleStates(filters = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filters.scope_id) {
        clauses.push('scope_id = ?');
        params.push(filters.scope_id);
      }
      if (filters.entity_type) {
        clauses.push('entity_type = ?');
        params.push(filters.entity_type);
      }
      if (filters.lifecycle_states && filters.lifecycle_states.length > 0) {
        clauses.push(`lifecycle_state IN (${filters.lifecycle_states.map(() => '?').join(', ')})`);
        params.push(...filters.lifecycle_states);
      }
      if (filters.purge_due_at) {
        clauses.push('purge_after IS NOT NULL AND purge_after <= ?');
        params.push(filters.purge_due_at);
      }
      if (filters.restore_available_at) {
        clauses.push('restore_until IS NOT NULL AND restore_until >= ?');
        params.push(filters.restore_available_at);
      }
      const limit = Math.max(1, Math.min(filters.limit ?? 500, 1000));
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = database.query(`
        SELECT *
        FROM memory_lifecycle_states
        ${where}
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `).all(...params, limit);
      return rows.map(rowToLifecycleState);
    },
    async createForgettingEvent(input) {
      const id = input.id ?? forgettingEventId(input);
      const scopeId = input.scope_id ?? 'workspace:default';
      database.query(`
        INSERT INTO forgetting_events (
          id,
          scope_id,
          entity_type,
          entity_id,
          event_type,
          from_lifecycle_state,
          to_lifecycle_state,
          policy_id,
          reason,
          source_refs_json,
          actor,
          job_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        scopeId,
        input.entity_type,
        input.entity_id,
        input.event_type,
        input.from_lifecycle_state ?? null,
        input.to_lifecycle_state ?? null,
        input.policy_id ?? null,
        input.reason ?? '',
        JSON.stringify(input.source_refs_json ?? []),
        input.actor ?? 'mbrain:lifecycle',
        input.job_id ?? null,
        input.created_at,
      );
      const row = database.query(`
        SELECT *
        FROM forgetting_events
        WHERE id = ?
      `).get(id);
      if (!row) throw new Error(`forgetting event was not stored: ${id}`);
      return rowToForgettingEvent(row);
    },
    async listForgettingEvents(filters = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filters.scope_id) {
        clauses.push('scope_id = ?');
        params.push(filters.scope_id);
      }
      if (filters.entity_type) {
        clauses.push('entity_type = ?');
        params.push(filters.entity_type);
      }
      if (filters.entity_id) {
        clauses.push('entity_id = ?');
        params.push(filters.entity_id);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = database.query(`
        SELECT *
        FROM forgetting_events
        ${where}
        ORDER BY created_at DESC, id ASC
        LIMIT ?
      `).all(...params, Math.max(1, Math.min(filters.limit ?? 500, 1000)));
      return rows.map(rowToForgettingEvent);
    },
    async createPurgePlan(input) {
      const id = input.id ?? purgePlanId(input.scope_id, input.reason ?? '', input.created_at);
      database.query(`
        INSERT INTO purge_plans (
          id, scope_id, status, reason, requested_by, review_reason, created_at, reviewed_at, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        id,
        input.scope_id,
        input.status ?? 'draft',
        input.reason ?? '',
        input.requested_by ?? null,
        input.review_reason ?? null,
        input.created_at,
      );
      const row = database.query(`SELECT * FROM purge_plans WHERE id = ?`).get(id);
      if (!row) throw new Error(`purge plan was not stored: ${id}`);
      return rowToPurgePlan(row);
    },
    async getPurgePlan(id) {
      const row = database.query(`
        SELECT *
        FROM purge_plans
        WHERE id = ?
      `).get(id);
      return row ? rowToPurgePlan(row) : null;
    },
    async createPurgePlanItem(input) {
      const id = input.id ?? purgePlanItemId(input.plan_id, input.entity_type, input.entity_id);
      database.query(`
        INSERT INTO purge_plan_items (
          id,
          plan_id,
          entity_type,
          entity_id,
          lifecycle_state,
          status,
          purge_after,
          tombstone_id,
          before_hash,
          evidence_ids_json,
          reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.plan_id,
        input.entity_type,
        input.entity_id,
        input.lifecycle_state,
        input.status ?? 'planned',
        input.purge_after ?? null,
        input.tombstone_id ?? null,
        input.before_hash ?? null,
        JSON.stringify(input.evidence_ids_json ?? []),
        input.reason ?? '',
        input.created_at,
        input.created_at,
      );
      const row = database.query(`SELECT * FROM purge_plan_items WHERE id = ?`).get(id);
      if (!row) throw new Error(`purge plan item was not stored: ${id}`);
      return rowToPurgePlanItem(row);
    },
    async listPurgePlanItems(planId) {
      const rows = database.query(`
        SELECT *
        FROM purge_plan_items
        WHERE plan_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(planId);
      return rows.map(rowToPurgePlanItem);
    },
    async reviewPurgePlan(input) {
      const planStatus = purgePlanStatusForReview(input.decision);
      const itemStatus = purgePlanItemStatusForReview(input.decision);
      database.query(`
        UPDATE purge_plans
        SET status = ?,
            review_reason = ?,
            reviewed_at = ?
        WHERE id = ?
      `).run(planStatus, input.review_reason, input.reviewed_at, input.plan_id);
      database.query(`
        UPDATE purge_plan_items
        SET status = ?,
            updated_at = ?
        WHERE plan_id = ?
          AND status = 'planned'
      `).run(itemStatus, input.reviewed_at, input.plan_id);
      const plan = await this.getPurgePlan(input.plan_id);
      if (!plan) throw new Error(`purge plan was not found: ${input.plan_id}`);
      return { plan, items: await this.listPurgePlanItems(input.plan_id) };
    },
    async createRestoreEvent(input) {
      const id = input.id ?? restoreEventId(input);
      const scopeId = input.scope_id ?? 'workspace:default';
      database.query(`
        INSERT INTO restore_events (
          id,
          scope_id,
          entity_type,
          entity_id,
          from_lifecycle_state,
          to_lifecycle_state,
          policy_id,
          reason,
          source_refs_json,
          actor,
          restored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        scopeId,
        input.entity_type,
        input.entity_id,
        input.from_lifecycle_state,
        input.to_lifecycle_state,
        input.policy_id ?? null,
        input.reason ?? '',
        JSON.stringify(input.source_refs_json ?? []),
        input.actor ?? 'mbrain:lifecycle',
        input.restored_at,
      );
      const row = database.query(`SELECT * FROM restore_events WHERE id = ?`).get(id);
      if (!row) throw new Error(`restore event was not stored: ${id}`);
      return rowToRestoreEvent(row);
    },
    async createMemoryTombstone(input) {
      const scopeId = input.scope_id ?? 'workspace:default';
      const id = input.id ?? memoryTombstoneId(scopeId, input.entity_type, input.entity_id);
      database.query(`
        INSERT INTO memory_tombstones (
          id,
          scope_id,
          entity_type,
          entity_id,
          purge_event_id,
          purge_plan_id,
          reason,
          content_hash,
          metadata_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        scopeId,
        input.entity_type,
        input.entity_id,
        input.purge_event_id ?? null,
        input.purge_plan_id ?? null,
        input.reason ?? '',
        input.content_hash ?? null,
        JSON.stringify(input.metadata_json ?? {}),
        input.created_at,
      );
      const stored = await this.getMemoryTombstone(input.entity_type, input.entity_id, scopeId);
      if (!stored) throw new Error(`memory tombstone was not stored: ${input.entity_type}:${input.entity_id}`);
      return stored;
    },
    async getMemoryTombstone(entityType, entityId, scopeId = 'workspace:default') {
      const row = database.query(`
        SELECT *
        FROM memory_tombstones
        WHERE scope_id = ?
          AND entity_type = ?
          AND entity_id = ?
      `).get(scopeId, entityType, entityId);
      return row ? rowToMemoryTombstone(row) : null;
    },
    async applyLifecycleTransitionSideEffects(input) {
      applySQLiteLifecycleTransitionSideEffects(database, input);
    },
    async applyPurgeSideEffects(input) {
      applySQLitePurgeSideEffects(database, input);
    },
    async persistSourceChunkPurgeResolution(input) {
      persistSQLiteSourceChunkPurgeResolution(database, input);
    },
  };
}

export function createPostgresLifecycleForgettingStore(sql: PostgresUnsafeLike): LifecycleForgettingStore {
  return createAsyncLifecycleForgettingStore({
    all: async (query, params = []) => await sql.unsafe(query, params),
    run: async (query, params = []) => {
      await sql.unsafe(query, params);
    },
  });
}

function createAsyncLifecycleForgettingStore(executor: AsyncSqlExecutor): LifecycleForgettingStore {
  return {
    async upsertForgettingPolicy(input) {
      const id = input.id ?? forgettingPolicyId(input);
      await executor.run(`
        INSERT INTO forgetting_policies (
          id,
          scope_id,
          entity_type,
          source_kind,
          claim_type,
          sensitivity_level,
          importance,
          stale_after,
          expire_after,
          archive_after,
          restore_window,
          archive_retention,
          purge_after,
          purge_eligible,
          report_visibility,
          policy_json,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18)
        ON CONFLICT(id) DO UPDATE SET
          scope_id = excluded.scope_id,
          entity_type = excluded.entity_type,
          source_kind = excluded.source_kind,
          claim_type = excluded.claim_type,
          sensitivity_level = excluded.sensitivity_level,
          importance = excluded.importance,
          stale_after = excluded.stale_after,
          expire_after = excluded.expire_after,
          archive_after = excluded.archive_after,
          restore_window = excluded.restore_window,
          archive_retention = excluded.archive_retention,
          purge_after = excluded.purge_after,
          purge_eligible = excluded.purge_eligible,
          report_visibility = excluded.report_visibility,
          policy_json = excluded.policy_json,
          updated_at = excluded.updated_at
      `, [
        id,
        input.scope_id,
        input.entity_type ?? 'any',
        input.source_kind ?? null,
        input.claim_type ?? null,
        input.sensitivity_level ?? null,
        input.importance ?? null,
        input.stale_after ?? null,
        input.expire_after ?? null,
        input.archive_after ?? null,
        input.restore_window ?? null,
        input.archive_retention ?? null,
        input.purge_after ?? null,
        input.purge_eligible === true,
        input.report_visibility ?? 'summary',
        JSON.stringify(input.policy_json ?? {}),
        input.now,
        input.now,
      ]);
      const stored = await this.getForgettingPolicy(id);
      if (!stored) throw new Error(`forgetting policy was not stored: ${id}`);
      return stored;
    },
    async getForgettingPolicy(id) {
      const rows = await executor.all(`
        SELECT *
        FROM forgetting_policies
        WHERE id = $1
      `, [id]);
      return rows[0] ? rowToForgettingPolicy(rows[0]) : null;
    },
    async resolveForgettingPolicyForLifecycleState(input) {
      const explicitPolicy = input.policy_id ? await this.getForgettingPolicy(input.policy_id) : null;
      const sourceKind = await resolveAsyncSourceKind(executor, input);
      const claimType = await resolveAsyncClaimType(executor, input);
      if (explicitPolicy) {
        return forgettingPolicyMatchesState(explicitPolicy, input, sourceKind, claimType) ? explicitPolicy : null;
      }
      const rows = await executor.all(`
        SELECT *
        FROM forgetting_policies
        WHERE scope_id = $1
          AND (entity_type = $2 OR entity_type = 'any')
          AND (source_kind IS NULL OR ($3::text IS NOT NULL AND source_kind = $3::text))
          AND (claim_type IS NULL OR ($4::text IS NOT NULL AND claim_type = $4::text))
          AND (sensitivity_level IS NULL OR ($5::text IS NOT NULL AND sensitivity_level = $5::text))
          AND (importance IS NULL OR ($6::text IS NOT NULL AND importance = $6::text))
        ORDER BY
          CASE WHEN entity_type = $2 THEN 0 ELSE 1 END,
          CASE WHEN source_kind = $3::text THEN 0 WHEN source_kind IS NULL THEN 1 ELSE 2 END,
          CASE WHEN claim_type = $4::text THEN 0 WHEN claim_type IS NULL THEN 1 ELSE 2 END,
          CASE WHEN sensitivity_level = $5::text THEN 0 WHEN sensitivity_level IS NULL THEN 1 ELSE 2 END,
          CASE WHEN importance = $6::text THEN 0 WHEN importance IS NULL THEN 1 ELSE 2 END,
          updated_at DESC,
          id ASC
        LIMIT 1
      `, [
        input.scope_id,
        input.entity_type,
        sourceKind,
        claimType,
        input.sensitivity_level ?? null,
        input.importance ?? null,
      ]);
      return rows[0] ? rowToForgettingPolicy(rows[0]) : null;
    },
    async upsertLifecycleState(input) {
      const scopeId = input.scope_id ?? 'workspace:default';
      const id = input.id ?? lifecycleStateId(scopeId, input.entity_type, input.entity_id);
      await executor.run(`
        INSERT INTO memory_lifecycle_states (
          id,
          scope_id,
          entity_type,
          entity_id,
          lifecycle_state,
          policy_id,
          reason,
          source_id,
          sensitivity_level,
          importance,
          restore_until,
          purge_after,
          last_transition_event_id,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT(scope_id, entity_type, entity_id) DO UPDATE SET
          lifecycle_state = excluded.lifecycle_state,
          policy_id = excluded.policy_id,
          reason = excluded.reason,
          source_id = excluded.source_id,
          sensitivity_level = excluded.sensitivity_level,
          importance = excluded.importance,
          restore_until = excluded.restore_until,
          purge_after = excluded.purge_after,
          last_transition_event_id = excluded.last_transition_event_id,
          updated_at = excluded.updated_at
      `, [
        id,
        scopeId,
        input.entity_type,
        input.entity_id,
        input.lifecycle_state,
        input.policy_id ?? null,
        input.reason ?? '',
        input.source_id ?? null,
        input.sensitivity_level ?? null,
        input.importance ?? null,
        input.restore_until ?? null,
        input.purge_after ?? null,
        input.last_transition_event_id ?? null,
        input.now,
        input.now,
      ]);
      const stored = await this.getLifecycleState(input.entity_type, input.entity_id, scopeId);
      if (!stored) throw new Error(`memory lifecycle state was not stored: ${input.entity_type}:${input.entity_id}`);
      return stored;
    },
    async getLifecycleState(entityType, entityId, scopeId = 'workspace:default') {
      const rows = await executor.all(`
        SELECT *
        FROM memory_lifecycle_states
        WHERE scope_id = $1
          AND entity_type = $2
          AND entity_id = $3
      `, [scopeId, entityType, entityId]);
      return rows[0] ? rowToLifecycleState(rows[0]) : null;
    },
    async listLifecycleStates(filters = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filters.scope_id) {
        params.push(filters.scope_id);
        clauses.push(`scope_id = $${params.length}`);
      }
      if (filters.entity_type) {
        params.push(filters.entity_type);
        clauses.push(`entity_type = $${params.length}`);
      }
      if (filters.lifecycle_states && filters.lifecycle_states.length > 0) {
        const placeholders = filters.lifecycle_states.map((state) => {
          params.push(state);
          return `$${params.length}`;
        });
        clauses.push(`lifecycle_state IN (${placeholders.join(', ')})`);
      }
      if (filters.purge_due_at) {
        params.push(filters.purge_due_at);
        clauses.push(`purge_after IS NOT NULL AND purge_after <= $${params.length}`);
      }
      if (filters.restore_available_at) {
        params.push(filters.restore_available_at);
        clauses.push(`restore_until IS NOT NULL AND restore_until >= $${params.length}`);
      }
      const limit = Math.max(1, Math.min(filters.limit ?? 500, 1000));
      params.push(limit);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await executor.all(`
        SELECT *
        FROM memory_lifecycle_states
        ${where}
        ORDER BY updated_at DESC, id ASC
        LIMIT $${params.length}
      `, params);
      return rows.map(rowToLifecycleState);
    },
    async createForgettingEvent(input) {
      const id = input.id ?? forgettingEventId(input);
      const scopeId = input.scope_id ?? 'workspace:default';
      await executor.run(`
        INSERT INTO forgetting_events (
          id,
          scope_id,
          entity_type,
          entity_id,
          event_type,
          from_lifecycle_state,
          to_lifecycle_state,
          policy_id,
          reason,
          source_refs_json,
          actor,
          job_id,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
      `, [
        id,
        scopeId,
        input.entity_type,
        input.entity_id,
        input.event_type,
        input.from_lifecycle_state ?? null,
        input.to_lifecycle_state ?? null,
        input.policy_id ?? null,
        input.reason ?? '',
        JSON.stringify(input.source_refs_json ?? []),
        input.actor ?? 'mbrain:lifecycle',
        input.job_id ?? null,
        input.created_at,
      ]);
      const rows = await executor.all(`SELECT * FROM forgetting_events WHERE id = $1`, [id]);
      if (!rows[0]) throw new Error(`forgetting event was not stored: ${id}`);
      return rowToForgettingEvent(rows[0]);
    },
    async listForgettingEvents(filters = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filters.scope_id) {
        params.push(filters.scope_id);
        clauses.push(`scope_id = $${params.length}`);
      }
      if (filters.entity_type) {
        params.push(filters.entity_type);
        clauses.push(`entity_type = $${params.length}`);
      }
      if (filters.entity_id) {
        params.push(filters.entity_id);
        clauses.push(`entity_id = $${params.length}`);
      }
      const limit = Math.max(1, Math.min(filters.limit ?? 500, 1000));
      params.push(limit);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await executor.all(`
        SELECT *
        FROM forgetting_events
        ${where}
        ORDER BY created_at DESC, id ASC
        LIMIT $${params.length}
      `, params);
      return rows.map(rowToForgettingEvent);
    },
    async createPurgePlan(input) {
      const id = input.id ?? purgePlanId(input.scope_id, input.reason ?? '', input.created_at);
      await executor.run(`
        INSERT INTO purge_plans (
          id, scope_id, status, reason, requested_by, review_reason, created_at, reviewed_at, applied_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL)
      `, [
        id,
        input.scope_id,
        input.status ?? 'draft',
        input.reason ?? '',
        input.requested_by ?? null,
        input.review_reason ?? null,
        input.created_at,
      ]);
      const rows = await executor.all(`SELECT * FROM purge_plans WHERE id = $1`, [id]);
      if (!rows[0]) throw new Error(`purge plan was not stored: ${id}`);
      return rowToPurgePlan(rows[0]);
    },
    async getPurgePlan(id) {
      const rows = await executor.all(`
        SELECT *
        FROM purge_plans
        WHERE id = $1
      `, [id]);
      return rows[0] ? rowToPurgePlan(rows[0]) : null;
    },
    async createPurgePlanItem(input) {
      const id = input.id ?? purgePlanItemId(input.plan_id, input.entity_type, input.entity_id);
      await executor.run(`
        INSERT INTO purge_plan_items (
          id,
          plan_id,
          entity_type,
          entity_id,
          lifecycle_state,
          status,
          purge_after,
          tombstone_id,
          before_hash,
          evidence_ids_json,
          reason,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
      `, [
        id,
        input.plan_id,
        input.entity_type,
        input.entity_id,
        input.lifecycle_state,
        input.status ?? 'planned',
        input.purge_after ?? null,
        input.tombstone_id ?? null,
        input.before_hash ?? null,
        JSON.stringify(input.evidence_ids_json ?? []),
        input.reason ?? '',
        input.created_at,
        input.created_at,
      ]);
      const rows = await executor.all(`SELECT * FROM purge_plan_items WHERE id = $1`, [id]);
      if (!rows[0]) throw new Error(`purge plan item was not stored: ${id}`);
      return rowToPurgePlanItem(rows[0]);
    },
    async listPurgePlanItems(planId) {
      const rows = await executor.all(`
        SELECT *
        FROM purge_plan_items
        WHERE plan_id = $1
        ORDER BY created_at ASC, id ASC
      `, [planId]);
      return rows.map(rowToPurgePlanItem);
    },
    async reviewPurgePlan(input) {
      const planStatus = purgePlanStatusForReview(input.decision);
      const itemStatus = purgePlanItemStatusForReview(input.decision);
      await executor.run(`
        UPDATE purge_plans
        SET status = $1,
            review_reason = $2,
            reviewed_at = $3
        WHERE id = $4
      `, [planStatus, input.review_reason, input.reviewed_at, input.plan_id]);
      await executor.run(`
        UPDATE purge_plan_items
        SET status = $1,
            updated_at = $2
        WHERE plan_id = $3
          AND status = 'planned'
      `, [itemStatus, input.reviewed_at, input.plan_id]);
      const plan = await this.getPurgePlan(input.plan_id);
      if (!plan) throw new Error(`purge plan was not found: ${input.plan_id}`);
      return { plan, items: await this.listPurgePlanItems(input.plan_id) };
    },
    async createRestoreEvent(input) {
      const id = input.id ?? restoreEventId(input);
      const scopeId = input.scope_id ?? 'workspace:default';
      await executor.run(`
        INSERT INTO restore_events (
          id,
          scope_id,
          entity_type,
          entity_id,
          from_lifecycle_state,
          to_lifecycle_state,
          policy_id,
          reason,
          source_refs_json,
          actor,
          restored_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
      `, [
        id,
        scopeId,
        input.entity_type,
        input.entity_id,
        input.from_lifecycle_state,
        input.to_lifecycle_state,
        input.policy_id ?? null,
        input.reason ?? '',
        JSON.stringify(input.source_refs_json ?? []),
        input.actor ?? 'mbrain:lifecycle',
        input.restored_at,
      ]);
      const rows = await executor.all(`SELECT * FROM restore_events WHERE id = $1`, [id]);
      if (!rows[0]) throw new Error(`restore event was not stored: ${id}`);
      return rowToRestoreEvent(rows[0]);
    },
    async createMemoryTombstone(input) {
      const scopeId = input.scope_id ?? 'workspace:default';
      const id = input.id ?? memoryTombstoneId(scopeId, input.entity_type, input.entity_id);
      await executor.run(`
        INSERT INTO memory_tombstones (
          id,
          scope_id,
          entity_type,
          entity_id,
          purge_event_id,
          purge_plan_id,
          reason,
          content_hash,
          metadata_json,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
      `, [
        id,
        scopeId,
        input.entity_type,
        input.entity_id,
        input.purge_event_id ?? null,
        input.purge_plan_id ?? null,
        input.reason ?? '',
        input.content_hash ?? null,
        JSON.stringify(input.metadata_json ?? {}),
        input.created_at,
      ]);
      const stored = await this.getMemoryTombstone(input.entity_type, input.entity_id, scopeId);
      if (!stored) throw new Error(`memory tombstone was not stored: ${input.entity_type}:${input.entity_id}`);
      return stored;
    },
    async getMemoryTombstone(entityType, entityId, scopeId = 'workspace:default') {
      const rows = await executor.all(`
        SELECT *
        FROM memory_tombstones
        WHERE scope_id = $1
          AND entity_type = $2
          AND entity_id = $3
      `, [scopeId, entityType, entityId]);
      return rows[0] ? rowToMemoryTombstone(rows[0]) : null;
    },
    async applyLifecycleTransitionSideEffects(input) {
      await applyAsyncLifecycleTransitionSideEffects(executor, input);
    },
    async applyPurgeSideEffects(input) {
      await applyAsyncPurgeSideEffects(executor, input);
    },
    async persistSourceChunkPurgeResolution(input) {
      await persistAsyncSourceChunkPurgeResolution(executor, input);
    },
  };
}

function rowToForgettingPolicy(row: Record<string, unknown>): ForgettingPolicyRecord {
  return {
    id: requiredString(row.id),
    scope_id: requiredString(row.scope_id),
    entity_type: requiredString(row.entity_type),
    source_kind: nullableString(row.source_kind),
    claim_type: nullableString(row.claim_type),
    sensitivity_level: nullableString(row.sensitivity_level),
    importance: nullableString(row.importance),
    stale_after: nullableString(row.stale_after),
    expire_after: nullableString(row.expire_after),
    archive_after: nullableString(row.archive_after),
    restore_window: nullableString(row.restore_window),
    archive_retention: nullableString(row.archive_retention),
    purge_after: nullableString(row.purge_after),
    purge_eligible: booleanValue(row.purge_eligible),
    report_visibility: requiredString(row.report_visibility) as ForgettingPolicyRecord['report_visibility'],
    policy_json: objectJson(row.policy_json),
    created_at: requiredString(row.created_at),
    updated_at: requiredString(row.updated_at),
  };
}

function rowToLifecycleState(row: Record<string, unknown>): MemoryLifecycleStateRecord {
  return {
    id: requiredString(row.id),
    scope_id: nullableString(row.scope_id) ?? 'workspace:default',
    entity_type: requiredString(row.entity_type),
    entity_id: requiredString(row.entity_id),
    lifecycle_state: requiredString(row.lifecycle_state) as MemoryLifecycleState,
    policy_id: nullableString(row.policy_id),
    reason: requiredString(row.reason),
    source_id: nullableString(row.source_id),
    sensitivity_level: nullableString(row.sensitivity_level),
    importance: nullableString(row.importance),
    restore_until: nullableString(row.restore_until),
    purge_after: nullableString(row.purge_after),
    last_transition_event_id: nullableString(row.last_transition_event_id),
    created_at: requiredString(row.created_at),
    updated_at: requiredString(row.updated_at),
  };
}

function rowToForgettingEvent(row: Record<string, unknown>): ForgettingEventRecord {
  return {
    id: requiredString(row.id),
    scope_id: nullableString(row.scope_id) ?? 'workspace:default',
    entity_type: requiredString(row.entity_type),
    entity_id: requiredString(row.entity_id),
    event_type: requiredString(row.event_type),
    from_lifecycle_state: nullableString(row.from_lifecycle_state) as MemoryLifecycleState | null,
    to_lifecycle_state: nullableString(row.to_lifecycle_state) as MemoryLifecycleState | null,
    policy_id: nullableString(row.policy_id),
    reason: requiredString(row.reason),
    source_refs_json: stringArray(row.source_refs_json),
    actor: requiredString(row.actor),
    job_id: nullableString(row.job_id),
    created_at: requiredString(row.created_at),
  };
}

function rowToPurgePlan(row: Record<string, unknown>): PurgePlanRecord {
  return {
    id: requiredString(row.id),
    scope_id: requiredString(row.scope_id),
    status: requiredString(row.status) as PurgePlanStatus,
    reason: requiredString(row.reason),
    requested_by: nullableString(row.requested_by),
    review_reason: nullableString(row.review_reason),
    created_at: requiredString(row.created_at),
    reviewed_at: nullableString(row.reviewed_at),
    applied_at: nullableString(row.applied_at),
  };
}

function rowToPurgePlanItem(row: Record<string, unknown>): PurgePlanItemRecord {
  return {
    id: requiredString(row.id),
    plan_id: requiredString(row.plan_id),
    entity_type: requiredString(row.entity_type),
    entity_id: requiredString(row.entity_id),
    lifecycle_state: requiredString(row.lifecycle_state) as PurgePlanItemRecord['lifecycle_state'],
    status: requiredString(row.status) as PurgePlanItemStatus,
    purge_after: nullableString(row.purge_after),
    tombstone_id: nullableString(row.tombstone_id),
    before_hash: nullableString(row.before_hash),
    evidence_ids_json: stringArray(row.evidence_ids_json),
    reason: requiredString(row.reason),
    created_at: requiredString(row.created_at),
    updated_at: requiredString(row.updated_at),
  };
}

function purgePlanStatusForReview(decision: PurgePlanReviewDecision): PurgePlanStatus {
  if (decision === 'approve') return 'approved';
  if (decision === 'reject') return 'rejected';
  return 'cancelled';
}

function purgePlanItemStatusForReview(decision: PurgePlanReviewDecision): PurgePlanItemStatus {
  if (decision === 'approve') return 'approved';
  if (decision === 'reject') return 'blocked';
  return 'skipped';
}

function rowToRestoreEvent(row: Record<string, unknown>): RestoreEventRecord {
  return {
    id: requiredString(row.id),
    scope_id: nullableString(row.scope_id) ?? 'workspace:default',
    entity_type: requiredString(row.entity_type),
    entity_id: requiredString(row.entity_id),
    from_lifecycle_state: requiredString(row.from_lifecycle_state) as RestoreEventRecord['from_lifecycle_state'],
    to_lifecycle_state: requiredString(row.to_lifecycle_state) as RestoreEventRecord['to_lifecycle_state'],
    policy_id: nullableString(row.policy_id),
    reason: requiredString(row.reason),
    source_refs_json: stringArray(row.source_refs_json),
    actor: requiredString(row.actor),
    restored_at: requiredString(row.restored_at),
  };
}

function rowToMemoryTombstone(row: Record<string, unknown>): MemoryTombstoneRecord {
  return {
    id: requiredString(row.id),
    scope_id: nullableString(row.scope_id) ?? 'workspace:default',
    entity_type: requiredString(row.entity_type),
    entity_id: requiredString(row.entity_id),
    purge_event_id: nullableString(row.purge_event_id),
    purge_plan_id: nullableString(row.purge_plan_id),
    reason: requiredString(row.reason),
    content_hash: nullableString(row.content_hash),
    metadata_json: objectJson(row.metadata_json),
    created_at: requiredString(row.created_at),
  };
}

function requiredString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value);
}

function stringArray(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
}

function objectJson(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function lifecycleSnapshotHash(value: unknown): string {
  return stableId('lifecycle-snapshot', canonicalJson(value));
}

function booleanValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return false;
}

function evidenceForgettingState(state: MemoryLifecycleState): string {
  return state === 'active' ? 'retained' : state;
}

function forgettingPolicyMatchesState(
  policy: ForgettingPolicyRecord,
  input: ForgettingPolicyResolutionInput,
  sourceKind: string | null,
  claimType: string | null,
): boolean {
  if (policy.scope_id !== input.scope_id) return false;
  if (policy.entity_type !== 'any' && policy.entity_type !== input.entity_type) return false;
  if (policy.sensitivity_level && policy.sensitivity_level !== input.sensitivity_level) return false;
  if (policy.source_kind && policy.source_kind !== sourceKind) return false;
  if (policy.claim_type && policy.claim_type !== claimType) return false;
  if (policy.importance && policy.importance !== input.importance) return false;
  return true;
}

function sourceChunkExpiresAt(state: MemoryLifecycleState, now: string): string | null {
  return ['expired', 'archived', 'purged'].includes(state) ? now : null;
}

function sourceChunkShouldTouchExpiresAt(state: MemoryLifecycleState): boolean {
  return ['active', 'stale', 'expired', 'archived', 'purged'].includes(state);
}

function lifecycleAuditEventType(
  from: MemoryLifecycleState | null,
  to: MemoryLifecycleState,
): string {
  if (to === 'purged' && from !== null) return 'purged';
  if (from === null) return 'lifecycle_initialized';
  if (from === to) return 'lifecycle_refreshed';
  return `lifecycle_${from}_to_${to}`;
}

function resolveSQLiteSourceKind(
  database: SQLiteDatabaseLike,
  input: ForgettingPolicyResolutionInput,
): string | null {
  if (input.source_id && sqliteTableExists(database, 'sources')) {
    const row = database.query<{ kind?: unknown }>(`
      SELECT kind FROM sources WHERE id = ?
    `).get(input.source_id);
    const kind = nullableString(row?.kind);
    if (kind) return kind;
  }
  if (input.entity_type === 'source_item' && sqliteTableExists(database, 'source_items') && sqliteTableExists(database, 'sources')) {
    const row = database.query<{ kind?: unknown }>(`
      SELECT sources.kind
      FROM source_items
      JOIN sources ON sources.id = source_items.source_id
      WHERE source_items.id = ?
    `).get(input.entity_id);
    const kind = nullableString(row?.kind);
    if (kind) return kind;
  }
  if (
    input.entity_type === 'source_chunk'
    && sqliteTableExists(database, 'source_chunks')
    && sqliteTableExists(database, 'source_items')
    && sqliteTableExists(database, 'sources')
  ) {
    const row = database.query<{ kind?: unknown }>(`
      SELECT sources.kind
      FROM source_chunks
      JOIN source_items ON source_items.id = source_chunks.source_item_id
      JOIN sources ON sources.id = source_items.source_id
      WHERE source_chunks.id = ?
    `).get(input.entity_id);
    const kind = nullableString(row?.kind);
    if (kind) return kind;
  }
  return null;
}

function resolveSQLiteClaimType(
  database: SQLiteDatabaseLike,
  input: ForgettingPolicyResolutionInput,
): string | null {
  if (input.claim_type) return input.claim_type;
  if (input.entity_type === 'assertion' && sqliteTableExists(database, 'assertions')) {
    const row = database.query<{ claim_type?: unknown }>(`
      SELECT claim_type FROM assertions WHERE id = ?
    `).get(input.entity_id);
    return nullableString(row?.claim_type);
  }
  if (input.entity_type === 'assertion_evidence' && sqliteTableExists(database, 'assertion_evidence') && sqliteTableExists(database, 'assertions')) {
    const row = database.query<{ claim_type?: unknown }>(`
      SELECT assertions.claim_type
      FROM assertion_evidence
      JOIN assertions ON assertions.id = assertion_evidence.assertion_id
      WHERE assertion_evidence.id = ?
    `).get(input.entity_id);
    return nullableString(row?.claim_type);
  }
  return null;
}

async function resolveAsyncSourceKind(
  executor: AsyncSqlExecutor,
  input: ForgettingPolicyResolutionInput,
): Promise<string | null> {
  if (input.source_id && await asyncTableExists(executor, 'sources')) {
    const rows = await executor.all(`SELECT kind FROM sources WHERE id = $1`, [input.source_id]);
    const kind = nullableString(rows[0]?.kind);
    if (kind) return kind;
  }
  if (input.entity_type === 'source_item' && await asyncTableExists(executor, 'source_items') && await asyncTableExists(executor, 'sources')) {
    const rows = await executor.all(`
      SELECT sources.kind
      FROM source_items
      JOIN sources ON sources.id = source_items.source_id
      WHERE source_items.id = $1
    `, [input.entity_id]);
    const kind = nullableString(rows[0]?.kind);
    if (kind) return kind;
  }
  if (
    input.entity_type === 'source_chunk'
    && await asyncTableExists(executor, 'source_chunks')
    && await asyncTableExists(executor, 'source_items')
    && await asyncTableExists(executor, 'sources')
  ) {
    const rows = await executor.all(`
      SELECT sources.kind
      FROM source_chunks
      JOIN source_items ON source_items.id = source_chunks.source_item_id
      JOIN sources ON sources.id = source_items.source_id
      WHERE source_chunks.id = $1
    `, [input.entity_id]);
    const kind = nullableString(rows[0]?.kind);
    if (kind) return kind;
  }
  return null;
}

async function resolveAsyncClaimType(
  executor: AsyncSqlExecutor,
  input: ForgettingPolicyResolutionInput,
): Promise<string | null> {
  if (input.claim_type) return input.claim_type;
  if (input.entity_type === 'assertion' && await asyncTableExists(executor, 'assertions')) {
    const rows = await executor.all(`SELECT claim_type FROM assertions WHERE id = $1`, [input.entity_id]);
    return nullableString(rows[0]?.claim_type);
  }
  if (
    input.entity_type === 'assertion_evidence'
    && await asyncTableExists(executor, 'assertion_evidence')
    && await asyncTableExists(executor, 'assertions')
  ) {
    const rows = await executor.all(`
      SELECT assertions.claim_type
      FROM assertion_evidence
      JOIN assertions ON assertions.id = assertion_evidence.assertion_id
      WHERE assertion_evidence.id = $1
    `, [input.entity_id]);
    return nullableString(rows[0]?.claim_type);
  }
  return null;
}

function applySQLiteLifecycleTransitionSideEffects(
  database: SQLiteDatabaseLike,
  input: LifecycleTransitionSideEffectInput,
): void {
  if (input.entity_type === 'assertion' && sqliteTableExists(database, 'assertions')) {
    database.query(`
      UPDATE assertions
      SET lifecycle_state = ?,
          updated_at = ?
      WHERE id = ?
    `).run(input.lifecycle_state, input.now, input.entity_id);
  }
  if (input.entity_type === 'assertion_evidence' && sqliteTableExists(database, 'assertion_evidence')) {
    database.query(`
      UPDATE assertion_evidence
      SET forgetting_state = ?
      WHERE id = ?
    `).run(evidenceForgettingState(input.lifecycle_state), input.entity_id);
  }
  if (
    input.entity_type === 'source_chunk'
    && sourceChunkShouldTouchExpiresAt(input.lifecycle_state)
    && sqliteTableExists(database, 'source_chunks')
  ) {
    database.query(`
      UPDATE source_chunks
      SET expires_at = ?
      WHERE id = ?
    `).run(sourceChunkExpiresAt(input.lifecycle_state, input.now), input.entity_id);
  }
  if (input.entity_type === 'projection_target' && sqliteTableExists(database, 'canonical_projection_reconcile_marks')) {
    markSQLiteProjectionReconcile(database, input);
  }
}

function markSQLiteProjectionReconcile(
  database: SQLiteDatabaseLike,
  input: LifecycleTransitionSideEffectInput,
): void {
  const target = projectionReconcileTarget(input.entity_id);
  database.query(`
    INSERT INTO canonical_projection_reconcile_marks (
      id,
      canonical_write_attempt_id,
      projection_kind,
      projection_slug,
      assertion_ids,
      projection_ids,
      status,
      reason,
      error_message,
      created_at,
      updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, 'pending_reconcile', 'projection_drift', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = 'pending_reconcile',
      error_message = excluded.error_message,
      updated_at = excluded.updated_at
  `).run(
    projectionReconcileMarkId(input.entity_id, input.lifecycle_state, input.now),
    target.kind,
    target.slug,
    JSON.stringify([]),
    JSON.stringify([input.entity_id]),
    projectionLifecycleReconcileMessage(input),
    input.now,
    input.now,
  );
}

function applySQLitePurgeSideEffects(
  database: SQLiteDatabaseLike,
  input: LifecyclePurgeSideEffectInput,
): void {
  applySQLiteLifecycleTransitionSideEffects(database, {
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    lifecycle_state: 'purged',
    reason: input.reason,
    now: input.now,
  });
  if (input.entity_type === 'source_chunk' && sqliteTableExists(database, 'source_chunks')) {
    const affectedAssertionIds = sqliteTableExists(database, 'assertion_evidence')
      ? database.query<{ assertion_id?: unknown }>(`
        SELECT DISTINCT assertion_id
        FROM assertion_evidence
        WHERE source_chunk_id = ?
      `).all(input.entity_id).map((row) => requiredString(row.assertion_id))
      : [];
    database.query(`
      UPDATE source_chunks
      SET chunk_text = '',
          redacted_text = '',
          token_count = 0,
          expires_at = ?
      WHERE id = ?
    `).run(input.now, input.entity_id);
    if (sqliteTableExists(database, 'assertion_evidence')) {
      database.query(`
        UPDATE assertion_evidence
        SET revocation_state = 'source_purged',
            forgetting_state = 'purged',
            valid_until = COALESCE(valid_until, ?)
        WHERE source_chunk_id = ?
      `).run(input.now, input.entity_id);
      markSQLiteEvidencePurgedForSourceChunk(database, input);
      for (const assertionId of affectedAssertionIds) {
        recomputeSQLiteAssertionSummary(database, assertionId, input.now);
      }
    }
  }
  if (input.entity_type === 'assertion' && sqliteTableExists(database, 'assertions')) {
    database.query(`
      UPDATE assertions
      SET value_json = '{}',
          normalized_claim = '[purged assertion content removed]',
          authority_summary = '{"purged":true}',
          confidence = 0,
          evidence_count = 0,
          updated_at = ?
      WHERE id = ?
    `).run(input.now, input.entity_id);
  }
  if (input.entity_type === 'source_item' && sqliteTableExists(database, 'source_items')) {
    const hasAssertionEvidence = sqliteTableExists(database, 'assertion_evidence');
    const hasSourceChunks = sqliteTableExists(database, 'source_chunks');
    const affectedAssertionIds = hasAssertionEvidence && hasSourceChunks
      ? database.query<{ assertion_id?: unknown }>(`
        SELECT DISTINCT assertion_id
        FROM assertion_evidence
        WHERE source_item_id = ?
           OR source_chunk_id IN (
             SELECT id FROM source_chunks WHERE source_item_id = ?
           )
      `).all(input.entity_id, input.entity_id).map((row) => requiredString(row.assertion_id))
      : [];
    database.query(`
      UPDATE source_items
      SET ingest_status = 'purged'
      WHERE id = ?
    `).run(input.entity_id);
    if (hasSourceChunks) {
      markSQLiteSourceChunksPurgedForSourceItem(database, input);
      database.query(`
        UPDATE source_chunks
        SET chunk_text = '',
            redacted_text = '',
            token_count = 0,
            expires_at = ?
        WHERE source_item_id = ?
      `).run(input.now, input.entity_id);
    }
    if (hasAssertionEvidence && hasSourceChunks) {
      database.query(`
        UPDATE assertion_evidence
        SET revocation_state = 'source_purged',
            forgetting_state = 'purged',
            valid_until = COALESCE(valid_until, ?)
        WHERE source_item_id = ?
           OR source_chunk_id IN (
             SELECT id FROM source_chunks WHERE source_item_id = ?
           )
      `).run(input.now, input.entity_id, input.entity_id);
      markSQLiteEvidencePurgedForSourceItem(database, input);
      for (const assertionId of affectedAssertionIds) {
        recomputeSQLiteAssertionSummary(database, assertionId, input.now);
      }
    }
  }
  if (input.entity_type === 'task_thread' && sqliteTableExists(database, 'task_threads')) {
    database.query(`
      UPDATE task_threads
      SET goal = '',
          current_summary = '[purged task thread]',
          updated_at = ?
      WHERE id = ?
    `).run(input.now, input.entity_id);
  }
  if (input.entity_type === 'task_event' && sqliteTableExists(database, 'task_events')) {
    database.query(`
      UPDATE task_events
      SET summary = '[purged task event]',
          payload_hash = NULL,
          source_refs = '[]',
          generated_assertion_ids = '[]'
      WHERE id = ?
    `).run(input.entity_id);
  }
  if (input.entity_type === 'task_attempt' && sqliteTableExists(database, 'task_attempts')) {
    database.query(`
      UPDATE task_attempts
      SET summary = '[purged task attempt]',
          applicability_context = '{}',
          evidence = '[]'
      WHERE id = ?
    `).run(input.entity_id);
  }
  if (input.entity_type === 'working_set' && sqliteTableExists(database, 'task_working_sets')) {
    database.query(`
      UPDATE task_working_sets
      SET active_paths = '[]',
          active_symbols = '[]',
          blockers = '[]',
          open_questions = '[]',
          next_steps = '[]',
          verification_notes = '[]',
          last_verified_at = NULL,
          updated_at = ?
      WHERE task_id = ?
    `).run(input.now, input.entity_id);
  }
  if (input.entity_type === 'retrieval_trace' && sqliteTableExists(database, 'retrieval_traces')) {
    database.query(`
      UPDATE retrieval_traces
      SET route = '[]',
          source_refs = '[]',
          derived_consulted = '[]',
          verification = '[]',
          selected_intent = NULL,
          scope_gate_policy = NULL,
          scope_gate_reason = NULL,
          outcome = '[purged retrieval trace]'
      WHERE id = ?
    `).run(input.entity_id);
  }
  if (input.entity_type === 'handoff' && sqliteTableExists(database, 'handoffs')) {
    database.query(`
      UPDATE handoffs
      SET resume_summary = '[purged handoff]',
          pending_decisions = '[]',
          next_actions = '[]',
          linked_assertion_ids = '[]',
          linked_projection_ids = '[]'
      WHERE id = ?
    `).run(input.entity_id);
  }
  if (input.entity_type === 'memory_session' && sqliteTableExists(database, 'memory_sessions')) {
    database.query(`
      UPDATE memory_sessions
      SET status = 'expired',
          actor_ref = NULL,
          closed_at = ?,
          expires_at = ?
      WHERE id = ?
    `).run(input.now, input.now, input.entity_id);
  }
  if (input.purge_plan_id && sqliteTableExists(database, 'purge_plan_items')) {
    database.query(`
      UPDATE purge_plan_items
      SET status = 'purged',
          tombstone_id = ?,
          updated_at = ?
      WHERE plan_id = ?
        AND entity_type = ?
        AND entity_id = ?
    `).run(input.tombstone_id, input.now, input.purge_plan_id, input.entity_type, input.entity_id);
  }
}

function recomputeSQLiteAssertionSummary(
  database: SQLiteDatabaseLike,
  assertionId: string,
  now: string,
): void {
  if (!sqliteTableExists(database, 'assertions') || !sqliteTableExists(database, 'assertion_evidence')) return;
  const evidence = database.query<{
    evidence_authority?: unknown;
    evidence_confidence?: unknown;
  }>(`
    SELECT evidence_authority, evidence_confidence
    FROM assertion_evidence
    WHERE assertion_id = ?
      AND contribution_type = 'supports'
      AND revocation_state = 'active'
      AND forgetting_state = 'retained'
  `).all(assertionId);
  const authoritySummary: Record<string, number> = {};
  let confidenceTotal = 0;
  for (const entry of evidence) {
    const authority = requiredString(entry.evidence_authority);
    authoritySummary[authority] = (authoritySummary[authority] ?? 0) + 1;
    confidenceTotal += Number(entry.evidence_confidence ?? 0);
  }
  const confidence = evidence.length === 0 ? 0 : Math.round((confidenceTotal / evidence.length) * 1000) / 1000;
  database.query(`
    UPDATE assertions
    SET evidence_count = ?,
        confidence = ?,
        authority_summary = ?,
        authority_state = CASE WHEN ? = 0 THEN 'candidate' ELSE authority_state END,
        updated_at = ?
    WHERE id = ?
  `).run(evidence.length, confidence, JSON.stringify(authoritySummary), evidence.length, now, assertionId);
}

function markSQLiteEvidencePurgedForSourceChunk(
  database: SQLiteDatabaseLike,
  input: LifecyclePurgeSideEffectInput,
): void {
  const rows = database.query<{ id?: unknown; lifecycle_state?: unknown }>(`
    SELECT assertion_evidence.id, memory_lifecycle_states.lifecycle_state
    FROM assertion_evidence
    LEFT JOIN memory_lifecycle_states
      ON memory_lifecycle_states.scope_id = ?
      AND memory_lifecycle_states.entity_type = 'assertion_evidence'
      AND memory_lifecycle_states.entity_id = assertion_evidence.id
    WHERE assertion_evidence.source_chunk_id = ?
  `).all(input.scope_id, input.entity_id);
  markSQLiteEvidencePurgedRows(database, input, rows, [`source-chunk:${input.entity_id}`], input.entity_id);
}

function markSQLiteEvidencePurgedForSourceItem(
  database: SQLiteDatabaseLike,
  input: LifecyclePurgeSideEffectInput,
): void {
  const rows = database.query<{ id?: unknown; lifecycle_state?: unknown }>(`
    SELECT assertion_evidence.id, memory_lifecycle_states.lifecycle_state
    FROM assertion_evidence
    LEFT JOIN memory_lifecycle_states
      ON memory_lifecycle_states.scope_id = ?
      AND memory_lifecycle_states.entity_type = 'assertion_evidence'
      AND memory_lifecycle_states.entity_id = assertion_evidence.id
    WHERE assertion_evidence.source_item_id = ?
       OR assertion_evidence.source_chunk_id IN (
         SELECT id FROM source_chunks WHERE source_item_id = ?
       )
  `).all(input.scope_id, input.entity_id, input.entity_id);
  markSQLiteEvidencePurgedRows(database, input, rows, [`source-item:${input.entity_id}`], input.entity_id);
}

function markSQLiteSourceChunksPurgedForSourceItem(
  database: SQLiteDatabaseLike,
  input: LifecyclePurgeSideEffectInput,
): void {
  const rows = database.query<{ id?: unknown; chunk_hash?: unknown; lifecycle_state?: unknown }>(`
    SELECT source_chunks.id, source_chunks.chunk_hash, memory_lifecycle_states.lifecycle_state
    FROM source_chunks
    LEFT JOIN memory_lifecycle_states
      ON memory_lifecycle_states.scope_id = ?
      AND memory_lifecycle_states.entity_type = 'source_chunk'
      AND memory_lifecycle_states.entity_id = source_chunks.id
    WHERE source_chunks.source_item_id = ?
    ORDER BY source_chunks.chunk_index ASC, source_chunks.id ASC
  `).all(input.scope_id, input.entity_id);
  for (const row of rows) {
    const sourceChunkId = requiredString(row.id);
    const previous = nullableString(row.lifecycle_state) as MemoryLifecycleState | null;
    const chunkHash = nullableString(row.chunk_hash);
    const eventInput: ForgettingEventInput = {
      scope_id: input.scope_id,
      entity_type: 'source_chunk',
      entity_id: sourceChunkId,
      event_type: lifecycleAuditEventType(previous, 'purged'),
      from_lifecycle_state: previous,
      to_lifecycle_state: 'purged',
      policy_id: input.policy_id ?? null,
      reason: input.reason,
      source_refs_json: [`source-item:${input.entity_id}`, `source-chunk:${sourceChunkId}`],
      actor: 'mbrain:lifecycle',
      created_at: input.now,
    };
    const eventId = forgettingEventId(eventInput);
    database.query(`
      INSERT OR IGNORE INTO forgetting_events (
        id,
        scope_id,
        entity_type,
        entity_id,
        event_type,
        from_lifecycle_state,
        to_lifecycle_state,
        policy_id,
        reason,
        source_refs_json,
        actor,
        job_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      input.scope_id,
      'source_chunk',
      sourceChunkId,
      eventInput.event_type,
      previous,
      'purged',
      input.policy_id ?? null,
      input.reason,
      JSON.stringify(eventInput.source_refs_json),
      eventInput.actor,
      null,
      input.now,
    );
    database.query(`
      INSERT INTO memory_lifecycle_states (
        id,
        scope_id,
        entity_type,
        entity_id,
        lifecycle_state,
        policy_id,
        reason,
        source_id,
        sensitivity_level,
        importance,
        restore_until,
        purge_after,
        last_transition_event_id,
        created_at,
        updated_at
      ) VALUES (?, ?, 'source_chunk', ?, 'purged', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(scope_id, entity_type, entity_id) DO UPDATE SET
        lifecycle_state = excluded.lifecycle_state,
        policy_id = excluded.policy_id,
        reason = excluded.reason,
        source_id = excluded.source_id,
        purge_after = excluded.purge_after,
        last_transition_event_id = excluded.last_transition_event_id,
        updated_at = excluded.updated_at
    `).run(
      lifecycleStateId(input.scope_id, 'source_chunk', sourceChunkId),
      input.scope_id,
      sourceChunkId,
      input.policy_id ?? null,
      input.reason,
      input.entity_id,
      input.now,
      eventId,
      input.now,
      input.now,
    );
    database.query(`
      INSERT OR IGNORE INTO memory_tombstones (
        id,
        scope_id,
        entity_type,
        entity_id,
        purge_event_id,
        purge_plan_id,
        reason,
        content_hash,
        metadata_json,
        created_at
      ) VALUES (?, ?, 'source_chunk', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memoryTombstoneId(input.scope_id, 'source_chunk', sourceChunkId),
      input.scope_id,
      sourceChunkId,
      eventId,
      input.purge_plan_id ?? null,
      input.reason,
      chunkHash,
      JSON.stringify({
        parent_source_item_id: input.entity_id,
        source_item_tombstone_id: input.tombstone_id,
      }),
      input.now,
    );
  }
}

function markSQLiteEvidencePurgedRows(
  database: SQLiteDatabaseLike,
  input: LifecyclePurgeSideEffectInput,
  rows: Array<{ id?: unknown; lifecycle_state?: unknown }>,
  sourceRefs: string[],
  sourceId: string,
): void {
  for (const row of rows) {
    const evidenceId = requiredString(row.id);
    const previous = nullableString(row.lifecycle_state) as MemoryLifecycleState | null;
    const eventInput: ForgettingEventInput = {
      scope_id: input.scope_id,
      entity_type: 'assertion_evidence',
      entity_id: evidenceId,
      event_type: lifecycleAuditEventType(previous, 'purged'),
      from_lifecycle_state: previous,
      to_lifecycle_state: 'purged',
      policy_id: input.policy_id ?? null,
      reason: input.reason,
      source_refs_json: sourceRefs,
      actor: 'mbrain:lifecycle',
      created_at: input.now,
    };
    const eventId = forgettingEventId(eventInput);
    database.query(`
      INSERT INTO forgetting_events (
        id,
        scope_id,
        entity_type,
        entity_id,
        event_type,
        from_lifecycle_state,
        to_lifecycle_state,
        policy_id,
        reason,
        source_refs_json,
        actor,
        job_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      input.scope_id,
      'assertion_evidence',
      evidenceId,
      eventInput.event_type,
      previous,
      'purged',
      input.policy_id ?? null,
      input.reason,
      JSON.stringify(eventInput.source_refs_json),
      eventInput.actor,
      null,
      input.now,
    );
    database.query(`
      INSERT INTO memory_lifecycle_states (
        id,
        scope_id,
        entity_type,
        entity_id,
        lifecycle_state,
        policy_id,
        reason,
        source_id,
        sensitivity_level,
        importance,
        restore_until,
        purge_after,
        last_transition_event_id,
        created_at,
        updated_at
      ) VALUES (?, ?, 'assertion_evidence', ?, 'purged', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(scope_id, entity_type, entity_id) DO UPDATE SET
        lifecycle_state = excluded.lifecycle_state,
        policy_id = excluded.policy_id,
        reason = excluded.reason,
        source_id = excluded.source_id,
        purge_after = excluded.purge_after,
        last_transition_event_id = excluded.last_transition_event_id,
        updated_at = excluded.updated_at
    `).run(
      lifecycleStateId(input.scope_id, 'assertion_evidence', evidenceId),
      input.scope_id,
      evidenceId,
      input.policy_id ?? null,
      input.reason,
      sourceId,
      input.now,
      eventId,
      input.now,
      input.now,
    );
  }
}

function persistSQLiteSourceChunkPurgeResolution(
  database: SQLiteDatabaseLike,
  input: SourceChunkPurgePersistenceInput,
): void {
  if (sqliteTableExists(database, 'assertions')) {
    database.query(`
      UPDATE assertions
      SET confidence = ?,
          evidence_count = ?,
          authority_state = ?,
          lifecycle_state = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.assertion.confidence,
      input.assertion.evidence_count,
      input.assertion.authority_state,
      input.assertion.lifecycle_state,
      input.now,
      input.assertion.id,
    );
  }
  if (sqliteTableExists(database, 'assertion_evidence')) {
    const updateEvidence = database.query(`
      UPDATE assertion_evidence
      SET revocation_state = ?,
          forgetting_state = ?,
          valid_until = COALESCE(valid_until, ?)
      WHERE id = ?
    `);
    for (const evidence of input.evidence) {
      updateEvidence.run(
        evidence.revocation_state,
        evidence.forgetting_state,
        evidence.valid_until ?? input.now,
        evidence.id,
      );
    }
  }
}

async function applyAsyncLifecycleTransitionSideEffects(
  executor: AsyncSqlExecutor,
  input: LifecycleTransitionSideEffectInput,
): Promise<void> {
  if (input.entity_type === 'assertion' && await asyncTableExists(executor, 'assertions')) {
    await executor.run(`
      UPDATE assertions
      SET lifecycle_state = $1,
          updated_at = $2
      WHERE id = $3
    `, [input.lifecycle_state, input.now, input.entity_id]);
  }
  if (input.entity_type === 'assertion_evidence' && await asyncTableExists(executor, 'assertion_evidence')) {
    await executor.run(`
      UPDATE assertion_evidence
      SET forgetting_state = $1
      WHERE id = $2
    `, [evidenceForgettingState(input.lifecycle_state), input.entity_id]);
  }
  if (
    input.entity_type === 'source_chunk'
    && sourceChunkShouldTouchExpiresAt(input.lifecycle_state)
    && await asyncTableExists(executor, 'source_chunks')
  ) {
    await executor.run(`
      UPDATE source_chunks
      SET expires_at = $1
      WHERE id = $2
    `, [sourceChunkExpiresAt(input.lifecycle_state, input.now), input.entity_id]);
  }
  if (input.entity_type === 'projection_target') {
    await markAsyncProjectionReconcile(executor, input);
  }
}

async function markAsyncProjectionReconcile(
  executor: AsyncSqlExecutor,
  input: LifecycleTransitionSideEffectInput,
): Promise<void> {
  if (!await asyncTableExists(executor, 'canonical_projection_reconcile_marks')) return;
  const target = projectionReconcileTarget(input.entity_id);
  await executor.run(`
    INSERT INTO canonical_projection_reconcile_marks (
      id,
      canonical_write_attempt_id,
      projection_kind,
      projection_slug,
      assertion_ids,
      projection_ids,
      status,
      reason,
      error_message,
      created_at,
      updated_at
    ) VALUES ($1, NULL, $2, $3, $4::jsonb, $5::jsonb, 'pending_reconcile', 'projection_drift', $6, $7, $8)
    ON CONFLICT(id) DO UPDATE SET
      status = 'pending_reconcile',
      error_message = EXCLUDED.error_message,
      updated_at = EXCLUDED.updated_at
  `, [
    projectionReconcileMarkId(input.entity_id, input.lifecycle_state, input.now),
    target.kind,
    target.slug,
    JSON.stringify([]),
    JSON.stringify([input.entity_id]),
    projectionLifecycleReconcileMessage(input),
    input.now,
    input.now,
  ]);
}

async function applyAsyncPurgeSideEffects(
  executor: AsyncSqlExecutor,
  input: LifecyclePurgeSideEffectInput,
): Promise<void> {
  await applyAsyncLifecycleTransitionSideEffects(executor, {
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    lifecycle_state: 'purged',
    reason: input.reason,
    now: input.now,
  });
  if (input.entity_type === 'source_chunk' && await asyncTableExists(executor, 'source_chunks')) {
    const affectedAssertionRows = await asyncTableExists(executor, 'assertion_evidence')
      ? await executor.all(`
        SELECT DISTINCT assertion_id
        FROM assertion_evidence
        WHERE source_chunk_id = $1
      `, [input.entity_id])
      : [];
    const affectedAssertionIds = affectedAssertionRows.map((row) => requiredString(row.assertion_id));
    await executor.run(`
      UPDATE source_chunks
      SET chunk_text = '',
          redacted_text = '',
          token_count = 0,
          expires_at = $1
      WHERE id = $2
    `, [input.now, input.entity_id]);
    if (await asyncTableExists(executor, 'assertion_evidence')) {
      await executor.run(`
        UPDATE assertion_evidence
        SET revocation_state = 'source_purged',
            forgetting_state = 'purged',
            valid_until = COALESCE(valid_until, $1)
        WHERE source_chunk_id = $2
      `, [input.now, input.entity_id]);
      await markAsyncEvidencePurgedForSourceChunk(executor, input);
      for (const assertionId of affectedAssertionIds) {
        await recomputeAsyncAssertionSummary(executor, assertionId, input.now);
      }
    }
  }
  if (input.entity_type === 'assertion' && await asyncTableExists(executor, 'assertions')) {
    await executor.run(`
      UPDATE assertions
      SET value_json = '{}'::jsonb,
          normalized_claim = '[purged assertion content removed]',
          authority_summary = '{"purged": true}'::jsonb,
          confidence = 0,
          evidence_count = 0,
          updated_at = $1
      WHERE id = $2
    `, [input.now, input.entity_id]);
  }
  if (input.entity_type === 'source_item' && await asyncTableExists(executor, 'source_items')) {
    const hasAssertionEvidence = await asyncTableExists(executor, 'assertion_evidence');
    const hasSourceChunks = await asyncTableExists(executor, 'source_chunks');
    const affectedAssertionRows = hasAssertionEvidence && hasSourceChunks
      ? await executor.all(`
        SELECT DISTINCT assertion_id
        FROM assertion_evidence
        WHERE source_item_id = $1
           OR source_chunk_id IN (
             SELECT id FROM source_chunks WHERE source_item_id = $2
           )
      `, [input.entity_id, input.entity_id])
      : [];
    const affectedAssertionIds = affectedAssertionRows.map((row) => requiredString(row.assertion_id));
    await executor.run(`
      UPDATE source_items
      SET ingest_status = 'purged'
      WHERE id = $1
    `, [input.entity_id]);
    if (hasSourceChunks) {
      await markAsyncSourceChunksPurgedForSourceItem(executor, input);
      await executor.run(`
        UPDATE source_chunks
        SET chunk_text = '',
            redacted_text = '',
            token_count = 0,
            expires_at = $1
        WHERE source_item_id = $2
      `, [input.now, input.entity_id]);
    }
    if (hasAssertionEvidence && hasSourceChunks) {
      await executor.run(`
        UPDATE assertion_evidence
        SET revocation_state = 'source_purged',
            forgetting_state = 'purged',
            valid_until = COALESCE(valid_until, $1)
        WHERE source_item_id = $2
           OR source_chunk_id IN (
             SELECT id FROM source_chunks WHERE source_item_id = $3
           )
      `, [input.now, input.entity_id, input.entity_id]);
      await markAsyncEvidencePurgedForSourceItem(executor, input);
      for (const assertionId of affectedAssertionIds) {
        await recomputeAsyncAssertionSummary(executor, assertionId, input.now);
      }
    }
  }
  if (input.entity_type === 'task_thread' && await asyncTableExists(executor, 'task_threads')) {
    await executor.run(`
      UPDATE task_threads
      SET goal = '',
          current_summary = '[purged task thread]',
          updated_at = $1
      WHERE id = $2
    `, [input.now, input.entity_id]);
  }
  if (input.entity_type === 'task_event' && await asyncTableExists(executor, 'task_events')) {
    await executor.run(`
      UPDATE task_events
      SET summary = '[purged task event]',
          payload_hash = NULL,
          source_refs = '[]'::jsonb,
          generated_assertion_ids = '[]'::jsonb
      WHERE id = $1
    `, [input.entity_id]);
  }
  if (input.entity_type === 'task_attempt' && await asyncTableExists(executor, 'task_attempts')) {
    await executor.run(`
      UPDATE task_attempts
      SET summary = '[purged task attempt]',
          applicability_context = '{}'::jsonb,
          evidence = '[]'::jsonb
      WHERE id = $1
    `, [input.entity_id]);
  }
  if (input.entity_type === 'working_set' && await asyncTableExists(executor, 'task_working_sets')) {
    await executor.run(`
      UPDATE task_working_sets
      SET active_paths = '[]'::jsonb,
          active_symbols = '[]'::jsonb,
          blockers = '[]'::jsonb,
          open_questions = '[]'::jsonb,
          next_steps = '[]'::jsonb,
          verification_notes = '[]'::jsonb,
          last_verified_at = NULL,
          updated_at = $1
      WHERE task_id = $2
    `, [input.now, input.entity_id]);
  }
  if (input.entity_type === 'retrieval_trace' && await asyncTableExists(executor, 'retrieval_traces')) {
    await executor.run(`
      UPDATE retrieval_traces
      SET route = '[]'::jsonb,
          source_refs = '[]'::jsonb,
          derived_consulted = '[]'::jsonb,
          verification = '[]'::jsonb,
          selected_intent = NULL,
          scope_gate_policy = NULL,
          scope_gate_reason = NULL,
          outcome = '[purged retrieval trace]'
      WHERE id = $1
    `, [input.entity_id]);
  }
  if (input.entity_type === 'handoff' && await asyncTableExists(executor, 'handoffs')) {
    await executor.run(`
      UPDATE handoffs
      SET resume_summary = '[purged handoff]',
          pending_decisions = '[]'::jsonb,
          next_actions = '[]'::jsonb,
          linked_assertion_ids = '[]'::jsonb,
          linked_projection_ids = '[]'::jsonb
      WHERE id = $1
    `, [input.entity_id]);
  }
  if (input.entity_type === 'memory_session' && await asyncTableExists(executor, 'memory_sessions')) {
    await executor.run(`
      UPDATE memory_sessions
      SET status = 'expired',
          actor_ref = NULL,
          closed_at = $1,
          expires_at = $1
      WHERE id = $2
    `, [input.now, input.entity_id]);
  }
  if (input.purge_plan_id && await asyncTableExists(executor, 'purge_plan_items')) {
    await executor.run(`
      UPDATE purge_plan_items
      SET status = 'purged',
          tombstone_id = $1,
          updated_at = $2
      WHERE plan_id = $3
        AND entity_type = $4
        AND entity_id = $5
    `, [input.tombstone_id, input.now, input.purge_plan_id, input.entity_type, input.entity_id]);
  }
}

async function recomputeAsyncAssertionSummary(
  executor: AsyncSqlExecutor,
  assertionId: string,
  now: string,
): Promise<void> {
  if (!await asyncTableExists(executor, 'assertions') || !await asyncTableExists(executor, 'assertion_evidence')) return;
  const evidence = await executor.all(`
    SELECT evidence_authority, evidence_confidence
    FROM assertion_evidence
    WHERE assertion_id = $1
      AND contribution_type = 'supports'
      AND revocation_state = 'active'
      AND forgetting_state = 'retained'
  `, [assertionId]);
  const authoritySummary: Record<string, number> = {};
  let confidenceTotal = 0;
  for (const entry of evidence) {
    const authority = requiredString(entry.evidence_authority);
    authoritySummary[authority] = (authoritySummary[authority] ?? 0) + 1;
    confidenceTotal += Number(entry.evidence_confidence ?? 0);
  }
  const confidence = evidence.length === 0 ? 0 : Math.round((confidenceTotal / evidence.length) * 1000) / 1000;
  await executor.run(`
    UPDATE assertions
    SET evidence_count = $1,
        confidence = $2,
        authority_summary = $3::jsonb,
        authority_state = CASE WHEN $4 = 0 THEN 'candidate' ELSE authority_state END,
        updated_at = $5
    WHERE id = $6
  `, [evidence.length, confidence, JSON.stringify(authoritySummary), evidence.length, now, assertionId]);
}

async function markAsyncEvidencePurgedForSourceChunk(
  executor: AsyncSqlExecutor,
  input: LifecyclePurgeSideEffectInput,
): Promise<void> {
  const rows = await executor.all(`
    SELECT assertion_evidence.id, memory_lifecycle_states.lifecycle_state
    FROM assertion_evidence
    LEFT JOIN memory_lifecycle_states
      ON memory_lifecycle_states.scope_id = $1
      AND memory_lifecycle_states.entity_type = 'assertion_evidence'
      AND memory_lifecycle_states.entity_id = assertion_evidence.id
    WHERE assertion_evidence.source_chunk_id = $2
  `, [input.scope_id, input.entity_id]);
  await markAsyncEvidencePurgedRows(executor, input, rows, [`source-chunk:${input.entity_id}`], input.entity_id);
}

async function markAsyncEvidencePurgedForSourceItem(
  executor: AsyncSqlExecutor,
  input: LifecyclePurgeSideEffectInput,
): Promise<void> {
  const rows = await executor.all(`
    SELECT assertion_evidence.id, memory_lifecycle_states.lifecycle_state
    FROM assertion_evidence
    LEFT JOIN memory_lifecycle_states
      ON memory_lifecycle_states.scope_id = $1
      AND memory_lifecycle_states.entity_type = 'assertion_evidence'
      AND memory_lifecycle_states.entity_id = assertion_evidence.id
    WHERE assertion_evidence.source_item_id = $2
       OR assertion_evidence.source_chunk_id IN (
         SELECT id FROM source_chunks WHERE source_item_id = $3
       )
  `, [input.scope_id, input.entity_id, input.entity_id]);
  await markAsyncEvidencePurgedRows(executor, input, rows, [`source-item:${input.entity_id}`], input.entity_id);
}

async function markAsyncSourceChunksPurgedForSourceItem(
  executor: AsyncSqlExecutor,
  input: LifecyclePurgeSideEffectInput,
): Promise<void> {
  const rows = await executor.all(`
    SELECT source_chunks.id, source_chunks.chunk_hash, memory_lifecycle_states.lifecycle_state
    FROM source_chunks
    LEFT JOIN memory_lifecycle_states
      ON memory_lifecycle_states.scope_id = $1
      AND memory_lifecycle_states.entity_type = 'source_chunk'
      AND memory_lifecycle_states.entity_id = source_chunks.id
    WHERE source_chunks.source_item_id = $2
    ORDER BY source_chunks.chunk_index ASC, source_chunks.id ASC
  `, [input.scope_id, input.entity_id]);
  for (const row of rows) {
    const sourceChunkId = requiredString(row.id);
    const previous = nullableString(row.lifecycle_state) as MemoryLifecycleState | null;
    const chunkHash = nullableString(row.chunk_hash);
    const eventInput: ForgettingEventInput = {
      scope_id: input.scope_id,
      entity_type: 'source_chunk',
      entity_id: sourceChunkId,
      event_type: lifecycleAuditEventType(previous, 'purged'),
      from_lifecycle_state: previous,
      to_lifecycle_state: 'purged',
      policy_id: input.policy_id ?? null,
      reason: input.reason,
      source_refs_json: [`source-item:${input.entity_id}`, `source-chunk:${sourceChunkId}`],
      actor: 'mbrain:lifecycle',
      created_at: input.now,
    };
    const eventId = forgettingEventId(eventInput);
    await executor.run(`
      INSERT INTO forgetting_events (
        id,
        scope_id,
        entity_type,
        entity_id,
        event_type,
        from_lifecycle_state,
        to_lifecycle_state,
        policy_id,
        reason,
        source_refs_json,
        actor,
        job_id,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
      ON CONFLICT(id) DO NOTHING
    `, [
      eventId,
      input.scope_id,
      'source_chunk',
      sourceChunkId,
      eventInput.event_type,
      previous,
      'purged',
      input.policy_id ?? null,
      input.reason,
      JSON.stringify(eventInput.source_refs_json),
      eventInput.actor,
      null,
      input.now,
    ]);
    await executor.run(`
      INSERT INTO memory_lifecycle_states (
        id,
        scope_id,
        entity_type,
        entity_id,
        lifecycle_state,
        policy_id,
        reason,
        source_id,
        sensitivity_level,
        importance,
        restore_until,
        purge_after,
        last_transition_event_id,
        created_at,
        updated_at
      ) VALUES ($1, $2, 'source_chunk', $3, 'purged', $4, $5, $6, NULL, NULL, NULL, $7, $8, $9, $10)
      ON CONFLICT(scope_id, entity_type, entity_id) DO UPDATE SET
        lifecycle_state = excluded.lifecycle_state,
        policy_id = excluded.policy_id,
        reason = excluded.reason,
        source_id = excluded.source_id,
        purge_after = excluded.purge_after,
        last_transition_event_id = excluded.last_transition_event_id,
        updated_at = excluded.updated_at
    `, [
      lifecycleStateId(input.scope_id, 'source_chunk', sourceChunkId),
      input.scope_id,
      sourceChunkId,
      input.policy_id ?? null,
      input.reason,
      input.entity_id,
      input.now,
      eventId,
      input.now,
      input.now,
    ]);
    await executor.run(`
      INSERT INTO memory_tombstones (
        id,
        scope_id,
        entity_type,
        entity_id,
        purge_event_id,
        purge_plan_id,
        reason,
        content_hash,
        metadata_json,
        created_at
      ) VALUES ($1, $2, 'source_chunk', $3, $4, $5, $6, $7, $8::jsonb, $9)
      ON CONFLICT(scope_id, entity_type, entity_id) DO NOTHING
    `, [
      memoryTombstoneId(input.scope_id, 'source_chunk', sourceChunkId),
      input.scope_id,
      sourceChunkId,
      eventId,
      input.purge_plan_id ?? null,
      input.reason,
      chunkHash,
      JSON.stringify({
        parent_source_item_id: input.entity_id,
        source_item_tombstone_id: input.tombstone_id,
      }),
      input.now,
    ]);
  }
}

async function markAsyncEvidencePurgedRows(
  executor: AsyncSqlExecutor,
  input: LifecyclePurgeSideEffectInput,
  rows: Array<Record<string, unknown>>,
  sourceRefs: string[],
  sourceId: string,
): Promise<void> {
  for (const row of rows) {
    const evidenceId = requiredString(row.id);
    const previous = nullableString(row.lifecycle_state) as MemoryLifecycleState | null;
    const eventInput: ForgettingEventInput = {
      scope_id: input.scope_id,
      entity_type: 'assertion_evidence',
      entity_id: evidenceId,
      event_type: lifecycleAuditEventType(previous, 'purged'),
      from_lifecycle_state: previous,
      to_lifecycle_state: 'purged',
      policy_id: input.policy_id ?? null,
      reason: input.reason,
      source_refs_json: sourceRefs,
      actor: 'mbrain:lifecycle',
      created_at: input.now,
    };
    const eventId = forgettingEventId(eventInput);
    await executor.run(`
      INSERT INTO forgetting_events (
        id,
        scope_id,
        entity_type,
        entity_id,
        event_type,
        from_lifecycle_state,
        to_lifecycle_state,
        policy_id,
        reason,
        source_refs_json,
        actor,
        job_id,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
    `, [
      eventId,
      input.scope_id,
      'assertion_evidence',
      evidenceId,
      eventInput.event_type,
      previous,
      'purged',
      input.policy_id ?? null,
      input.reason,
      JSON.stringify(eventInput.source_refs_json),
      eventInput.actor,
      null,
      input.now,
    ]);
    await executor.run(`
      INSERT INTO memory_lifecycle_states (
        id,
        scope_id,
        entity_type,
        entity_id,
        lifecycle_state,
        policy_id,
        reason,
        source_id,
        sensitivity_level,
        importance,
        restore_until,
        purge_after,
        last_transition_event_id,
        created_at,
        updated_at
      ) VALUES ($1, $2, 'assertion_evidence', $3, 'purged', $4, $5, $6, NULL, NULL, NULL, $7, $8, $9, $10)
      ON CONFLICT(scope_id, entity_type, entity_id) DO UPDATE SET
        lifecycle_state = excluded.lifecycle_state,
        policy_id = excluded.policy_id,
        reason = excluded.reason,
        source_id = excluded.source_id,
        purge_after = excluded.purge_after,
        last_transition_event_id = excluded.last_transition_event_id,
        updated_at = excluded.updated_at
    `, [
      lifecycleStateId(input.scope_id, 'assertion_evidence', evidenceId),
      input.scope_id,
      evidenceId,
      input.policy_id ?? null,
      input.reason,
      sourceId,
      input.now,
      eventId,
      input.now,
      input.now,
    ]);
  }
}

async function persistAsyncSourceChunkPurgeResolution(
  executor: AsyncSqlExecutor,
  input: SourceChunkPurgePersistenceInput,
): Promise<void> {
  if (await asyncTableExists(executor, 'assertions')) {
    await executor.run(`
      UPDATE assertions
      SET confidence = $1,
          evidence_count = $2,
          authority_state = $3,
          lifecycle_state = $4,
          updated_at = $5
      WHERE id = $6
    `, [
      input.assertion.confidence,
      input.assertion.evidence_count,
      input.assertion.authority_state,
      input.assertion.lifecycle_state,
      input.now,
      input.assertion.id,
    ]);
  }
  if (await asyncTableExists(executor, 'assertion_evidence')) {
    for (const evidence of input.evidence) {
      await executor.run(`
        UPDATE assertion_evidence
        SET revocation_state = $1,
            forgetting_state = $2,
            valid_until = COALESCE(valid_until, $3)
        WHERE id = $4
      `, [
        evidence.revocation_state,
        evidence.forgetting_state,
        evidence.valid_until ?? input.now,
        evidence.id,
      ]);
    }
  }
}

function projectionReconcileMarkId(
  entityId: string,
  state: MemoryLifecycleState,
  now: string,
): string {
  return stableId('projection-lifecycle-reconcile', entityId, state, now);
}

function projectionReconcileTarget(entityId: string): { kind: string; slug: string } {
  const projectionPrefix = 'projection:';
  return {
    kind: 'lifecycle_projection',
    slug: entityId.startsWith(projectionPrefix) ? entityId.slice(projectionPrefix.length) : entityId,
  };
}

function projectionLifecycleReconcileMessage(input: LifecycleTransitionSideEffectInput): string {
  return `Lifecycle ${input.lifecycle_state} for ${input.entity_id}: ${input.reason}`;
}

function sqliteTableExists(database: SQLiteDatabaseLike, tableName: string): boolean {
  const row = database.query(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
  `).get(tableName);
  return row !== null;
}

async function asyncTableExists(executor: AsyncSqlExecutor, tableName: string): Promise<boolean> {
  const rows = await executor.all(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_name = $1
        AND table_schema = ANY(current_schemas(false))
    ) AS table_exists
  `, [tableName]);
  return booleanValue(rows[0]?.table_exists);
}

export function createLifecycleForgettingStoreForEngine(engine: BrainEngine): LifecycleForgettingStore {
  if (engine instanceof PostgresEngine) {
    return createPostgresLifecycleForgettingStore((engine as PostgresEngine).sql as unknown as PostgresUnsafeLike);
  }
  const candidate = engine as BrainEngine & {
    database?: SQLiteDatabaseLike;
    db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  };
  if (candidate.database) {
    return createSQLiteLifecycleForgettingStore(candidate.database);
  }
  if (candidate.db) {
    return createAsyncLifecycleForgettingStore({
      all: async (query, params = []) => (await candidate.db!.query(query, params)).rows ?? [],
      run: async (query, params = []) => {
        await candidate.db!.query(query, params);
      },
    });
  }
  const engineName = (engine as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
  throw new Error(`lifecycle forgetting store requires a SQL-capable engine; got ${engineName}`);
}

export function createLifecycleForgettingTransactionForEngine(
  engine: BrainEngine,
): <T>(fn: (store: LifecycleForgettingStore) => Promise<T>) => Promise<T> {
  return (fn) => engine.transaction(async (txEngine) => fn(createLifecycleForgettingStoreForEngine(txEngine)));
}
