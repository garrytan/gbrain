import type { BrainEngine } from '../engine.ts';
import { PostgresEngine } from '../postgres-engine.ts';
import type { AssertionResolutionResult } from './assertion-resolution.ts';

export interface AssertionResolutionAuditResult {
  /** Attempted input row counts. Idempotent replays may insert zero new rows. */
  assertion_events: number;
  assertion_lineage: number;
  assertion_links: number;
  conflict_sets: number;
  conflict_set_assertions: number;
}

interface SQLiteDatabaseLike {
  query(sql: string): {
    run(...params: unknown[]): unknown;
  };
}

interface AsyncQueryLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface SqlCapableEngine extends BrainEngine {
  database?: SQLiteDatabaseLike;
  db?: AsyncQueryLike;
}

export async function recordAssertionResolutionAudit(
  engine: BrainEngine,
  result: AssertionResolutionResult,
): Promise<AssertionResolutionAuditResult> {
  // Caller must persist FK parents first: assertions for all audit rows, plus
  // any extracted-claim/source records needed by later lineage reads.
  return engine.transaction(async (tx) => {
    for (const event of result.events) {
      await insertAssertionEvent(tx, event);
    }
    for (const lineage of result.lineage) {
      await insertAssertionLineage(tx, lineage);
    }
    for (const link of result.links) {
      await insertAssertionLink(tx, link);
    }
    for (const conflictSet of result.conflict_sets) {
      await upsertConflictSet(tx, conflictSet);
    }
    for (const member of result.conflict_set_assertions) {
      await insertConflictSetAssertion(tx, member);
    }

    return {
      assertion_events: result.events.length,
      assertion_lineage: result.lineage.length,
      assertion_links: result.links.length,
      conflict_sets: result.conflict_sets.length,
      conflict_set_assertions: result.conflict_set_assertions.length,
    };
  });
}

async function insertAssertionEvent(
  engine: BrainEngine,
  event: AssertionResolutionResult['events'][number],
): Promise<void> {
  await execute(engine, {
    sqlite: `
      INSERT INTO assertion_events (
        id, assertion_id, event_type, from_authority_state, to_authority_state,
        from_lifecycle_state, to_lifecycle_state, reason, source_refs_json,
        actor, job_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `,
    pg: `
      INSERT INTO assertion_events (
        id, assertion_id, event_type, from_authority_state, to_authority_state,
        from_lifecycle_state, to_lifecycle_state, reason, source_refs_json,
        actor, job_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
      ON CONFLICT(id) DO NOTHING
    `,
    params: [
      event.id,
      event.assertion_id,
      event.event_type,
      event.from_authority_state,
      event.to_authority_state,
      event.from_lifecycle_state,
      event.to_lifecycle_state,
      event.reason,
      jsonParam(event.source_refs_json),
      event.actor,
      event.job_id,
      event.created_at,
    ],
  });
}

async function insertAssertionLineage(
  engine: BrainEngine,
  lineage: AssertionResolutionResult['lineage'][number],
): Promise<void> {
  await execute(engine, {
    sqlite: `
      INSERT INTO assertion_lineage (
        id, assertion_id, extracted_claim_id, source_id, source_item_id,
        source_chunk_id, session_id, task_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `,
    pg: `
      INSERT INTO assertion_lineage (
        id, assertion_id, extracted_claim_id, source_id, source_item_id,
        source_chunk_id, session_id, task_event_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT(id) DO NOTHING
    `,
    params: [
      lineage.id,
      lineage.assertion_id,
      lineage.extracted_claim_id,
      lineage.source_id,
      lineage.source_item_id,
      lineage.source_chunk_id,
      lineage.session_id,
      lineage.task_event_id,
      lineage.created_at,
    ],
  });
}

async function insertAssertionLink(
  engine: BrainEngine,
  link: AssertionResolutionResult['links'][number],
): Promise<void> {
  await execute(engine, {
    sqlite: `
      INSERT INTO assertion_links (
        id, scope_id, policy_version, from_assertion_id, to_assertion_id,
        link_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `,
    pg: `
      INSERT INTO assertion_links (
        id, scope_id, policy_version, from_assertion_id, to_assertion_id,
        link_type, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT DO NOTHING
    `,
    params: [
      link.id,
      link.scope_id,
      link.policy_version,
      link.from_assertion_id,
      link.to_assertion_id,
      link.link_type,
      link.created_at,
    ],
  });
}

async function upsertConflictSet(
  engine: BrainEngine,
  conflictSet: AssertionResolutionResult['conflict_sets'][number],
): Promise<void> {
  await execute(engine, {
    sqlite: `
      INSERT INTO conflict_sets (
        id, target_type, target_id, property, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at
        WHERE conflict_sets.updated_at <= excluded.updated_at
    `,
    pg: `
      INSERT INTO conflict_sets (
        id, target_type, target_id, property, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at
        WHERE conflict_sets.updated_at <= excluded.updated_at
    `,
    params: [
      conflictSet.id,
      conflictSet.target_type,
      conflictSet.target_id,
      conflictSet.property,
      conflictSet.status,
      conflictSet.created_at,
      conflictSet.updated_at,
    ],
  });
}

async function insertConflictSetAssertion(
  engine: BrainEngine,
  member: AssertionResolutionResult['conflict_set_assertions'][number],
): Promise<void> {
  await execute(engine, {
    sqlite: `
      INSERT INTO conflict_set_assertions (
        conflict_set_id, assertion_id, role, created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(conflict_set_id, assertion_id) DO NOTHING
    `,
    pg: `
      INSERT INTO conflict_set_assertions (
        conflict_set_id, assertion_id, role, created_at
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT(conflict_set_id, assertion_id) DO NOTHING
    `,
    params: [
      member.conflict_set_id,
      member.assertion_id,
      member.role,
      member.created_at,
    ],
  });
}

async function execute(
  engine: BrainEngine,
  input: { sqlite: string; pg: string; params: unknown[] },
): Promise<void> {
  if (engine instanceof PostgresEngine) {
    await (engine as PostgresEngine).sql.unsafe(input.pg, input.params as any);
    return;
  }
  const candidate = engine as SqlCapableEngine;
  if (candidate.database) {
    candidate.database.query(input.sqlite).run(...input.params);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(input.pg, input.params);
    return;
  }
  const engineName = (engine as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
  throw new Error(`assertion resolution audit recording requires a SQL-capable engine; got ${engineName}`);
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null);
}
