import type { BrainEngine } from '../engine.ts';
import { PostgresEngine } from '../postgres-engine.ts';
import {
  type AssertionAuthorityState,
  type AssertionAuthoritySummary,
  type AssertionLifecycleState,
  type AssertionRecord,
  type JsonValue,
} from './assertion-types.ts';
import {
  type AssertionRetrievalMode,
  type AssertionRetrievalPlan,
  planRetrievableAssertions,
} from './assertion-resolution.ts';
import { createLifecycleForgettingStoreForEngine } from '../maintenance/lifecycle-forgetting.ts';

export interface AssertionRetrievalFilters {
  target_slug?: string;
  mode?: AssertionRetrievalMode;
  scope_id?: string;
  frontier?: boolean;
  include_candidates?: boolean;
  include_rejected?: boolean;
  limit?: number;
}

interface SQLiteDatabaseLike {
  query<T = Record<string, unknown>>(sql: string): {
    all(...params: unknown[]): T[];
  };
}

interface AsyncQueryLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export async function listRetrievableAssertionsForEngine(
  engine: BrainEngine,
  filters: AssertionRetrievalFilters = {},
): Promise<AssertionRetrievalPlan[]> {
  const assertions = await listAssertionRows(engine, filters);
  const planned = planRetrievableAssertions(assertions, {
    mode: filters.mode ?? 'default',
    include_candidates: filters.include_candidates,
    include_rejected: filters.include_rejected,
  });
  const sorted = sortRetrievalPlans(planned);
  const limited = filters.limit !== undefined && filters.limit >= 0 ? sorted.slice(0, filters.limit) : sorted;
  if (filters.mode !== 'audit') return limited;

  const scopeId = filters.scope_id ?? 'workspace:default';
  let store;
  try {
    store = createLifecycleForgettingStoreForEngine(engine);
  } catch {
    return limited;
  }

  const decorated: AssertionRetrievalPlan[] = [];
  for (const entry of limited) {
    const [events, tombstone] = await Promise.all([
      store.listForgettingEvents({
        scope_id: scopeId,
        entity_type: 'assertion',
        entity_id: entry.assertion.id,
      }),
      store.getMemoryTombstone('assertion', entry.assertion.id, scopeId),
    ]);
    decorated.push({
      ...entry,
      lifecycle_events: events.map((event) => ({
        id: event.id,
        event_type: event.event_type,
        from_lifecycle_state: event.from_lifecycle_state,
        to_lifecycle_state: event.to_lifecycle_state,
        reason: event.reason,
        created_at: event.created_at,
      })),
      tombstone: tombstone ? {
        id: tombstone.id,
        reason: tombstone.reason,
        content_hash: tombstone.content_hash,
        created_at: tombstone.created_at,
      } : null,
    });
  }
  return decorated;
}

async function listAssertionRows(
  engine: BrainEngine,
  filters: AssertionRetrievalFilters,
): Promise<AssertionRecord[]> {
  requireScopeForFrontier(filters);

  if (engine instanceof PostgresEngine) {
    const { where, params } = assertionWhereClause(filters, (index) => `$${index}`);
    const rows = await (engine as PostgresEngine).sql.unsafe(`
      SELECT *
      FROM assertions
      ${where}
      ORDER BY created_at ASC, id ASC
    `, params);
    return rows.map(rowToAssertion);
  }

  const candidate = engine as BrainEngine & {
    database?: SQLiteDatabaseLike;
    db?: AsyncQueryLike;
  };
  if (candidate.database) {
    const { where, params } = assertionWhereClause(filters, () => '?');
    const rows = candidate.database.query<Record<string, unknown>>(`
      SELECT *
      FROM assertions
      ${where}
      ORDER BY created_at ASC, id ASC
    `).all(...params);
    return rows.map(rowToAssertion);
  }
  if (candidate.db) {
    const { where, params } = assertionWhereClause(filters, (index) => `$${index}`);
    const rows = await candidate.db.query(`
      SELECT *
      FROM assertions
      ${where}
      ORDER BY created_at ASC, id ASC
    `, params);
    return rows.rows.map(rowToAssertion);
  }

  const engineName = (engine as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
  throw new Error(`assertion retrieval requires a SQL-capable engine; got ${engineName}`);
}

function requireScopeForFrontier(filters: AssertionRetrievalFilters): void {
  if (filters.frontier === true && !filters.scope_id) {
    throw new Error('scope_id is required for assertion frontier retrieval');
  }
}

function assertionWhereClause(
  filters: AssertionRetrievalFilters,
  placeholder: (index: number) => string,
): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters.scope_id) {
    params.push(filters.scope_id);
    clauses.push(`scope_id = ${placeholder(params.length)}`);
  }
  if (filters.target_slug) {
    params.push(filters.target_slug);
    clauses.push(`target_slug = ${placeholder(params.length)}`);
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function sortRetrievalPlans(plans: AssertionRetrievalPlan[]): AssertionRetrievalPlan[] {
  return [...plans].sort((left, right) => {
    const activationDelta = activationRank(left.activation) - activationRank(right.activation);
    if (activationDelta !== 0) return activationDelta;
    const lifecycleDelta = lifecycleRank(left.assertion.lifecycle_state) - lifecycleRank(right.assertion.lifecycle_state);
    if (lifecycleDelta !== 0) return lifecycleDelta;
    return left.assertion.id.localeCompare(right.assertion.id);
  });
}

function activationRank(activation: AssertionRetrievalPlan['activation']): number {
  if (activation === 'answer_ground') return 0;
  if (activation === 'verify_first') return 1;
  return 2;
}

function lifecycleRank(state: AssertionLifecycleState): number {
  return ['active', 'stale', 'expired', 'archived', 'purged'].indexOf(state);
}

function rowToAssertion(row: Record<string, unknown>): AssertionRecord {
  return {
    id: stringValue(row.id),
    scope_id: stringValue(row.scope_id) || 'workspace:default',
    policy_version: stringValue(row.policy_version) || 'policy:v1',
    authority_scope: stringValue(row.authority_scope) || 'work',
    claim_type: stringValue(row.claim_type) as AssertionRecord['claim_type'],
    target_type: stringValue(row.target_type),
    target_id: nullableString(row.target_id),
    target_slug: nullableString(row.target_slug),
    property: stringValue(row.property),
    value_json: jsonValue(row.value_json),
    normalized_claim: stringValue(row.normalized_claim),
    authority_summary: jsonObject(row.authority_summary) as AssertionAuthoritySummary,
    confidence: numberValue(row.confidence),
    evidence_count: numberValue(row.evidence_count),
    authority_state: stringValue(row.authority_state) as AssertionAuthorityState,
    lifecycle_state: stringValue(row.lifecycle_state) as AssertionLifecycleState,
    valid_from: nullableString(row.valid_from),
    valid_until: nullableString(row.valid_until),
    supersedes_assertion_id: nullableString(row.supersedes_assertion_id),
    superseded_by_assertion_id: nullableString(row.superseded_by_assertion_id),
    conflict_set_id: nullableString(row.conflict_set_id),
    created_at: stringValue(row.created_at),
    updated_at: stringValue(row.updated_at),
  };
}

function stringValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value == null ? '' : String(value);
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function numberValue(value: unknown): number {
  if (typeof value === 'number') return value;
  return Number(value ?? 0);
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function jsonValue(value: unknown): JsonValue {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return value;
    }
  }
  if (value == null) return null;
  return value as JsonValue;
}
