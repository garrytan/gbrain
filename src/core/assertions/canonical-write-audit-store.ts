import type { BrainEngine } from '../engine.ts';
import { PostgresEngine } from '../postgres-engine.ts';
import type { ProjectionTarget } from '../canonical-write/projection-writer.ts';
import type { CanonicalWritePolicyResult } from '../canonical-write/write-policy.ts';
import { stableId, sha256 } from './assertion-types.ts';

export type CanonicalWriteAuditStatus = 'applied' | 'pending_reconcile' | 'failed_db' | 'failed_markdown' | 'conflict';
export type CanonicalProjectionAuditStatus = 'not_attempted' | 'applied' | 'failed_markdown';

export interface CanonicalWriteAuditInput {
  now: string;
  policy_decision: CanonicalWritePolicyResult['decision'];
  policy_explanation: string;
  status: CanonicalWriteAuditStatus;
  projection_status: CanonicalProjectionAuditStatus;
  assertion_ids: string[];
  assertion_evidence_ids: string[];
  extracted_claim_ids: string[];
  source_refs: unknown[];
  target_projection?: {
    id?: string;
    kind: ProjectionTarget['kind'];
    slug: string;
    mutation_kind: string;
    before_markdown_hash: string | null;
    after_markdown_hash: string | null;
  };
  before_db_hash: string | null;
  after_db_hash: string | null;
  actor: {
    actor: string;
    session_id: string;
    job_id: string;
    runner_id: string;
  };
  error?: {
    code: string;
    message: string;
  };
  metadata_json?: Record<string, unknown>;
}

export interface CanonicalWriteAuditResult {
  write_attempt_id: string;
  projection_target_ids: string[];
  projection_mutation_ids: string[];
}

interface SQLiteDatabaseLike {
  query<T = Record<string, unknown>>(sql: string): {
    all(...params: unknown[]): T[];
    get(...params: unknown[]): T | null;
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

type ProjectionTargetType =
  | 'markdown_page'
  | 'page_timeline'
  | 'profile_memory'
  | 'personal_episode'
  | 'task_resume'
  | 'project_doc'
  | 'system_doc'
  | 'source_summary'
  | 'daily_report';

export async function recordCanonicalWriteAudit(
  engine: BrainEngine,
  input: CanonicalWriteAuditInput,
): Promise<CanonicalWriteAuditResult> {
  return engine.transaction(async (tx) => {
    const projectionTargetIds: string[] = [];
    if (input.target_projection) {
      projectionTargetIds.push(await upsertProjectionTarget(tx, input));
    }

    const writeAttemptId = writeAttemptIdFor(input, projectionTargetIds);
    await upsertWriteAttempt(tx, input, writeAttemptId, projectionTargetIds);

    const projectionMutationIds: string[] = [];
    if (input.target_projection) {
      const projectionMutationId = projectionMutationIdFor(input, writeAttemptId);
      await upsertProjectionMutation(tx, input, writeAttemptId, projectionMutationId);
      projectionMutationIds.push(projectionMutationId);
    }

    return {
      write_attempt_id: writeAttemptId,
      projection_target_ids: projectionTargetIds,
      projection_mutation_ids: projectionMutationIds,
    };
  });
}

async function upsertProjectionTarget(engine: BrainEngine, input: CanonicalWriteAuditInput): Promise<string> {
  const target = input.target_projection;
  if (!target) return '';
  const targetType = projectionTargetTypeFor(target.kind);
  const targetId = target.slug;
  const existing = await selectProjectionTarget(engine, targetType, targetId);
  const projectionTargetId = stringValue(existing?.id) || target.id || stableId('canonical-projection-target', targetType, targetId);
  const existingAssertionIds = stringArray(existing?.source_assertion_ids);
  const sourceAssertionIds = uniqueStrings([...existingAssertionIds, ...input.assertion_ids]);
  const status = projectionTargetStatusFor(input);
  const canonicalChangedSinceProjection = canonicalChangedSinceProjectionFor(input);
  const projectionHash = projectionHashFor(input, existing);
  const metadata = {
    ...(jsonObject(existing?.metadata_json)),
    projection_kind: target.kind,
    mutation_kind: target.mutation_kind,
    source_refs: input.source_refs,
  };

  if (existing) {
    await execute(engine, {
      sqlite: `
        UPDATE canonical_projection_targets
        SET locator = ?,
            source_assertion_ids = ?,
            projection_hash = ?,
            last_rendered_at = ?,
            last_reconciled_at = ?,
            status = ?,
            canonical_changed_since_projection = ?,
            metadata_json = ?,
            updated_at = ?
        WHERE target_type = ? AND target_id = ?
      `,
      pg: `
        UPDATE canonical_projection_targets
        SET locator = $1,
            source_assertion_ids = $2::jsonb,
            projection_hash = $3,
            last_rendered_at = $4,
            last_reconciled_at = $5,
            status = $6,
            canonical_changed_since_projection = $7,
            metadata_json = $8::jsonb,
            updated_at = $9
        WHERE target_type = $10 AND target_id = $11
      `,
      params: [
        locatorFor(target.slug),
        jsonParam(sourceAssertionIds),
        projectionHash,
        target.after_markdown_hash ? input.now : existing.last_rendered_at ?? null,
        status === 'applied' ? input.now : existing.last_reconciled_at ?? null,
        status,
        canonicalChangedSinceProjection,
        jsonParam(metadata),
        input.now,
        targetType,
        targetId,
      ],
    });
    return projectionTargetId;
  }

  await execute(engine, {
    sqlite: `
      INSERT INTO canonical_projection_targets (
        id, target_type, target_id, locator, source_assertion_ids, projection_hash,
        rendered_markdown, last_rendered_at, last_reconciled_at, status,
        runtime_only, canonical_changed_since_projection, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    pg: `
      INSERT INTO canonical_projection_targets (
        id, target_type, target_id, locator, source_assertion_ids, projection_hash,
        rendered_markdown, last_rendered_at, last_reconciled_at, status,
        runtime_only, canonical_changed_since_projection, metadata_json,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
    `,
    params: [
      projectionTargetId,
      targetType,
      targetId,
      locatorFor(target.slug),
      jsonParam(sourceAssertionIds),
      projectionHash,
      '',
      target.after_markdown_hash ? input.now : null,
      status === 'applied' ? input.now : null,
      status,
      false,
      canonicalChangedSinceProjection,
      jsonParam(metadata),
      input.now,
      input.now,
    ],
  });
  return projectionTargetId;
}

async function upsertWriteAttempt(
  engine: BrainEngine,
  input: CanonicalWriteAuditInput,
  writeAttemptId: string,
  projectionTargetIds: string[],
): Promise<void> {
  const target = input.target_projection;
  const metadata = {
    ...(input.metadata_json ?? {}),
    projection_status: input.projection_status,
    ...(target ? {
      projection_kind: target.kind,
      projection_slug: target.slug,
      mutation_kind: target.mutation_kind,
    } : {}),
  };
  await execute(engine, {
    sqlite: `
      INSERT INTO canonical_write_attempts (
        id, policy_decision, policy_explanation, policy_explanation_hash,
        assertion_ids, assertion_evidence_ids, extracted_claim_ids, source_refs,
        target_projection_ids, before_db_hash, after_db_hash, before_markdown_hash,
        after_markdown_hash, actor, session_id, job_id, runner_id, status,
        error_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        policy_decision = excluded.policy_decision,
        policy_explanation = excluded.policy_explanation,
        policy_explanation_hash = excluded.policy_explanation_hash,
        assertion_ids = excluded.assertion_ids,
        assertion_evidence_ids = excluded.assertion_evidence_ids,
        extracted_claim_ids = excluded.extracted_claim_ids,
        source_refs = excluded.source_refs,
        target_projection_ids = excluded.target_projection_ids,
        before_db_hash = excluded.before_db_hash,
        after_db_hash = excluded.after_db_hash,
        before_markdown_hash = excluded.before_markdown_hash,
        after_markdown_hash = excluded.after_markdown_hash,
        actor = excluded.actor,
        session_id = excluded.session_id,
        job_id = excluded.job_id,
        runner_id = excluded.runner_id,
        status = excluded.status,
        error_json = excluded.error_json,
        metadata_json = excluded.metadata_json
    `,
    pg: `
      INSERT INTO canonical_write_attempts (
        id, policy_decision, policy_explanation, policy_explanation_hash,
        assertion_ids, assertion_evidence_ids, extracted_claim_ids, source_refs,
        target_projection_ids, before_db_hash, after_db_hash, before_markdown_hash,
        after_markdown_hash, actor, session_id, job_id, runner_id, status,
        error_json, metadata_json, created_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb, $21)
      ON CONFLICT(id) DO UPDATE SET
        policy_decision = excluded.policy_decision,
        policy_explanation = excluded.policy_explanation,
        policy_explanation_hash = excluded.policy_explanation_hash,
        assertion_ids = excluded.assertion_ids,
        assertion_evidence_ids = excluded.assertion_evidence_ids,
        extracted_claim_ids = excluded.extracted_claim_ids,
        source_refs = excluded.source_refs,
        target_projection_ids = excluded.target_projection_ids,
        before_db_hash = excluded.before_db_hash,
        after_db_hash = excluded.after_db_hash,
        before_markdown_hash = excluded.before_markdown_hash,
        after_markdown_hash = excluded.after_markdown_hash,
        actor = excluded.actor,
        session_id = excluded.session_id,
        job_id = excluded.job_id,
        runner_id = excluded.runner_id,
        status = excluded.status,
        error_json = excluded.error_json,
        metadata_json = excluded.metadata_json
    `,
    params: [
      writeAttemptId,
      input.policy_decision,
      input.policy_explanation,
      `sha256:${sha256(input.policy_explanation)}`,
      jsonParam(input.assertion_ids),
      jsonParam(input.assertion_evidence_ids),
      jsonParam(input.extracted_claim_ids),
      jsonParam(input.source_refs),
      jsonParam(projectionTargetIds),
      input.before_db_hash,
      input.after_db_hash,
      target?.before_markdown_hash ?? null,
      target?.after_markdown_hash ?? null,
      input.actor.actor,
      input.actor.session_id,
      input.actor.job_id,
      input.actor.runner_id,
      input.status,
      jsonParam(input.error ?? {}),
      jsonParam(metadata),
      input.now,
    ],
  });
}

async function upsertProjectionMutation(
  engine: BrainEngine,
  input: CanonicalWriteAuditInput,
  writeAttemptId: string,
  projectionMutationId: string,
): Promise<void> {
  const target = input.target_projection;
  if (!target) return;
  await execute(engine, {
    sqlite: `
      INSERT INTO canonical_projection_mutations (
        id, canonical_write_attempt_id, projection_kind, projection_slug,
        mutation_kind, assertion_ids, assertion_evidence_ids, extracted_claim_ids,
        source_refs, before_markdown_hash, after_markdown_hash, status,
        error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        canonical_write_attempt_id = excluded.canonical_write_attempt_id,
        projection_kind = excluded.projection_kind,
        projection_slug = excluded.projection_slug,
        mutation_kind = excluded.mutation_kind,
        assertion_ids = excluded.assertion_ids,
        assertion_evidence_ids = excluded.assertion_evidence_ids,
        extracted_claim_ids = excluded.extracted_claim_ids,
        source_refs = excluded.source_refs,
        before_markdown_hash = excluded.before_markdown_hash,
        after_markdown_hash = excluded.after_markdown_hash,
        status = excluded.status,
        error_message = excluded.error_message
    `,
    pg: `
      INSERT INTO canonical_projection_mutations (
        id, canonical_write_attempt_id, projection_kind, projection_slug,
        mutation_kind, assertion_ids, assertion_evidence_ids, extracted_claim_ids,
        source_refs, before_markdown_hash, after_markdown_hash, status,
        error_message, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)
      ON CONFLICT(id) DO UPDATE SET
        canonical_write_attempt_id = excluded.canonical_write_attempt_id,
        projection_kind = excluded.projection_kind,
        projection_slug = excluded.projection_slug,
        mutation_kind = excluded.mutation_kind,
        assertion_ids = excluded.assertion_ids,
        assertion_evidence_ids = excluded.assertion_evidence_ids,
        extracted_claim_ids = excluded.extracted_claim_ids,
        source_refs = excluded.source_refs,
        before_markdown_hash = excluded.before_markdown_hash,
        after_markdown_hash = excluded.after_markdown_hash,
        status = excluded.status,
        error_message = excluded.error_message
    `,
    params: [
      projectionMutationId,
      writeAttemptId,
      target.kind,
      target.slug,
      target.mutation_kind,
      jsonParam(input.assertion_ids),
      jsonParam(input.assertion_evidence_ids),
      jsonParam(input.extracted_claim_ids),
      jsonParam(input.source_refs),
      target.before_markdown_hash,
      target.after_markdown_hash,
      projectionMutationStatusFor(input),
      input.error?.message ?? null,
      input.now,
    ],
  });
}

async function selectProjectionTarget(
  engine: BrainEngine,
  targetType: string,
  targetId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await queryRows(engine, {
    sqlite: `
      SELECT *
      FROM canonical_projection_targets
      WHERE target_type = ? AND target_id = ?
      LIMIT 1
    `,
    pg: `
      SELECT *
      FROM canonical_projection_targets
      WHERE target_type = $1 AND target_id = $2
      LIMIT 1
    `,
    params: [targetType, targetId],
  });
  return rows[0] ?? null;
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
  throwUnsupportedEngine(engine);
}

async function queryRows(
  engine: BrainEngine,
  input: { sqlite: string; pg: string; params: unknown[] },
): Promise<Record<string, unknown>[]> {
  if (engine instanceof PostgresEngine) {
    return await (engine as PostgresEngine).sql.unsafe(input.pg, input.params as any);
  }
  const candidate = engine as SqlCapableEngine;
  if (candidate.database) {
    return candidate.database.query<Record<string, unknown>>(input.sqlite).all(...input.params);
  }
  if (candidate.db) {
    const result = await candidate.db.query(input.pg, input.params);
    return result.rows;
  }
  throwUnsupportedEngine(engine);
}

function writeAttemptIdFor(input: CanonicalWriteAuditInput, projectionTargetIds: string[]): string {
  return stableId(
    'canonical-write-attempt',
    input.actor.session_id,
    input.actor.job_id,
    input.actor.runner_id,
    input.status,
    input.projection_status,
    input.before_db_hash ?? '',
    input.after_db_hash ?? '',
    input.target_projection?.before_markdown_hash ?? '',
    input.target_projection?.after_markdown_hash ?? '',
    input.error?.code ?? '',
    input.error?.message ?? '',
    ...input.assertion_ids,
    ...input.assertion_evidence_ids,
    ...input.extracted_claim_ids,
    ...projectionTargetIds,
  );
}

function projectionMutationIdFor(input: CanonicalWriteAuditInput, writeAttemptId: string): string {
  const target = input.target_projection;
  return stableId(
    'canonical-projection-mutation',
    writeAttemptId,
    target?.kind ?? '',
    target?.slug ?? '',
    target?.mutation_kind ?? '',
    projectionMutationStatusFor(input),
    target?.before_markdown_hash ?? '',
    target?.after_markdown_hash ?? '',
  );
}

function projectionTargetTypeFor(kind: ProjectionTarget['kind']): ProjectionTargetType {
  switch (kind) {
    case 'project_decision_timeline':
      return 'project_doc';
    case 'system_compiled_truth':
      return 'system_doc';
    case 'user_profile_projection':
      return 'profile_memory';
    case 'personal_episode_summary':
      return 'personal_episode';
    case 'task_handoff_projection':
      return 'task_resume';
    case 'contradiction_resolution':
      return 'system_doc';
  }
}

function projectionTargetStatusFor(input: CanonicalWriteAuditInput): 'applied' | 'pending_reconcile' | 'failed' | 'conflict' {
  if (input.status === 'conflict') return 'conflict';
  if (input.status === 'failed_markdown') return 'failed';
  if (input.status === 'applied' && input.projection_status === 'applied') return 'applied';
  return 'pending_reconcile';
}

function projectionMutationStatusFor(input: CanonicalWriteAuditInput): 'applied' | 'failed_markdown' | 'pending_reconcile' {
  if (input.projection_status === 'failed_markdown') return 'failed_markdown';
  if (input.status === 'applied' && input.projection_status === 'applied') return 'applied';
  return 'pending_reconcile';
}

function canonicalChangedSinceProjectionFor(input: CanonicalWriteAuditInput): boolean {
  return input.projection_status === 'failed_markdown' || input.status === 'failed_markdown';
}

function projectionHashFor(input: CanonicalWriteAuditInput, existing: Record<string, unknown> | null): string {
  const target = input.target_projection;
  if (!target) return '';
  if (target.after_markdown_hash) return target.after_markdown_hash;
  const existingHash = stringValue(existing?.projection_hash);
  if (canonicalChangedSinceProjectionFor(input) && existingHash.length > 0) return existingHash;
  return target.before_markdown_hash ?? existingHash;
}

function locatorFor(slug: string): string {
  return `brain/${slug.replace(/^brain\//, '')}.md`;
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function stringValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value == null ? '' : String(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function jsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value ?? null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function throwUnsupportedEngine(engine: BrainEngine): never {
  const engineName = (engine as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
  throw new Error(`canonical write audit recording requires a SQL-capable engine; got ${engineName}`);
}
