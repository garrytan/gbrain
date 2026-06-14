import type { BrainEngine } from '../engine.ts';
import { PostgresEngine } from '../postgres-engine.ts';
import {
  type AssertionEvidenceRecord,
  type AssertionRecord,
  type ExtractedClaim,
  type JsonValue,
} from './assertion-types.ts';
import {
  inferAssertionTargetType,
  resolveExtractedClaim,
  type AssertionResolutionResult,
  type ResolveExtractedClaimInput,
} from './assertion-resolution.ts';
import { recordAssertionResolutionAudit } from './assertion-resolution-audit-store.ts';

export interface ResolveExtractedClaimForEngineInput
  extends Omit<ResolveExtractedClaimInput, 'existing_assertions' | 'existing_evidence'> {
  claim: ExtractedClaim;
}

interface SQLiteDatabaseLike {
  query<T = Record<string, unknown>>(sql: string): {
    all(...params: unknown[]): T[];
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

export async function resolveExtractedClaimForEngine(
  engine: BrainEngine,
  input: ResolveExtractedClaimForEngineInput,
): Promise<AssertionResolutionResult> {
  return engine.transaction(async (tx) => {
    const target = resolutionTarget(input);
    const scopeId = input.scope_id ?? 'workspace:default';
    await acquireResolutionKeyLock(tx, {
      scope_id: scopeId,
      target_type: target.target_type,
      target_id: target.target_id,
      property: input.claim.property_hint,
    });
    const existingAssertions = await listExistingAssertions(tx, {
      scope_id: scopeId,
      target_type: target.target_type,
      target_id: target.target_id,
      property: input.claim.property_hint,
    });
    const existingEvidence = await listExistingEvidence(tx, existingAssertions.map((assertion) => assertion.id));
    const existingEvidenceIds = new Set(existingEvidence.map((evidence) => evidence.id));
    const resolutionEvidence = existingEvidence
      .filter((evidence) => evidence.extracted_claim_id !== input.claim.id);
    const result = resolveExtractedClaim({
      ...input,
      scope_id: scopeId,
      target_type: target.target_type,
      target_id: target.target_id,
      target_slug: target.target_slug,
      existing_assertions: existingAssertions,
      existing_evidence: resolutionEvidence,
    });
    const durableResult = durableResolutionResult(result, existingEvidenceIds);

    await upsertExtractedClaim(tx, durableResult.extracted_claim);
    await upsertAssertions(tx, [durableResult.assertion, ...durableResult.updated_assertions]);
    for (const evidence of durableResult.evidence) {
      await insertAssertionEvidence(tx, evidence);
    }
    await recordAssertionResolutionAudit(tx, durableResult);
    return durableResult;
  });
}

async function acquireResolutionKeyLock(
  engine: BrainEngine,
  input: {
    scope_id: string;
    target_type: string;
    target_id: string;
    property: string;
  },
): Promise<void> {
  if (!(engine instanceof PostgresEngine)) return;
  const key = [
    input.scope_id,
    input.target_type,
    input.target_id,
    input.property,
  ].join('\u001f');
  await (engine as PostgresEngine).sql.unsafe(
    `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
    [key],
  );
}

function durableResolutionResult(
  result: AssertionResolutionResult,
  existingEvidenceIds: Set<string>,
): AssertionResolutionResult {
  const replayOnlyEvidence = result.resolution === 'duplicate'
    && result.evidence.length > 0
    && result.evidence.every((evidence) => existingEvidenceIds.has(evidence.id));
  if (!replayOnlyEvidence) return result;
  return {
    ...result,
    events: result.events.filter((event) => event.event_type !== 'evidence_added'),
  };
}

async function listExistingAssertions(
  engine: BrainEngine,
  input: {
    scope_id: string;
    target_type: string;
    target_id: string;
    property: string;
  },
): Promise<AssertionRecord[]> {
  const rows = await queryRows(engine, {
    sqlite: `
      SELECT *
      FROM assertions
      WHERE scope_id = ?
        AND target_type = ?
        AND target_id = ?
        AND property = ?
      ORDER BY created_at ASC, id ASC
    `,
    pg: `
      SELECT *
      FROM assertions
      WHERE scope_id = $1
        AND target_type = $2
        AND target_id = $3
        AND property = $4
      ORDER BY created_at ASC, id ASC
    `,
    params: [
      input.scope_id,
      input.target_type,
      input.target_id,
      input.property,
    ],
  });
  return rows.map(rowToAssertion);
}

async function listExistingEvidence(
  engine: BrainEngine,
  assertionIds: string[],
): Promise<AssertionEvidenceRecord[]> {
  if (assertionIds.length === 0) return [];
  const rows = await queryRows(engine, {
    sqlite: `
      SELECT *
      FROM assertion_evidence
      WHERE assertion_id IN (${assertionIds.map(() => '?').join(', ')})
      ORDER BY created_at ASC, id ASC
    `,
    pg: `
      SELECT *
      FROM assertion_evidence
      WHERE assertion_id = ANY($1::text[])
      ORDER BY created_at ASC, id ASC
    `,
    params: isPostgresDialect(engine) ? [assertionIds] : assertionIds,
  });
  return rows.map(rowToAssertionEvidence);
}

async function upsertExtractedClaim(
  engine: BrainEngine,
  claim: ExtractedClaim,
): Promise<void> {
  await execute(engine, {
    sqlite: `
      INSERT INTO extracted_claims (
        id, source_id, source_item_id, source_chunk_id, extractor_kind,
        extractor_version, runner_job_id, claim_text, claim_type, target_hint,
        property_hint, value_json, confidence, sensitivity_level,
        prompt_injection_flag, secret_flag, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status
    `,
    pg: `
      INSERT INTO extracted_claims (
        id, source_id, source_item_id, source_chunk_id, extractor_kind,
        extractor_version, runner_job_id, claim_text, claim_type, target_hint,
        property_hint, value_json, confidence, sensitivity_level,
        prompt_injection_flag, secret_flag, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status
    `,
    params: [
      claim.id,
      claim.source_id,
      claim.source_item_id,
      claim.source_chunk_id,
      claim.extractor_kind,
      claim.extractor_version,
      claim.runner_job_id,
      claim.claim_text,
      claim.claim_type,
      claim.target_hint,
      claim.property_hint,
      jsonParam(claim.value_json),
      claim.confidence,
      claim.sensitivity_level,
      claim.prompt_injection_flag,
      claim.secret_flag,
      claim.status,
      claim.created_at,
    ],
  });
}

async function upsertAssertions(
  engine: BrainEngine,
  assertions: AssertionRecord[],
): Promise<void> {
  for (const assertion of assertions) {
    await execute(engine, {
      sqlite: `
        INSERT INTO assertions (
          id, scope_id, policy_version, authority_scope, claim_type, target_type,
          target_id, target_slug, property, value_json, normalized_claim,
          authority_summary, confidence, evidence_count, authority_state,
          lifecycle_state, valid_from, valid_until, supersedes_assertion_id,
          superseded_by_assertion_id, conflict_set_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          scope_id = excluded.scope_id,
          policy_version = excluded.policy_version,
          authority_scope = excluded.authority_scope,
          claim_type = excluded.claim_type,
          target_type = excluded.target_type,
          target_id = excluded.target_id,
          target_slug = excluded.target_slug,
          property = excluded.property,
          value_json = excluded.value_json,
          normalized_claim = excluded.normalized_claim,
          authority_summary = excluded.authority_summary,
          confidence = excluded.confidence,
          evidence_count = excluded.evidence_count,
          authority_state = excluded.authority_state,
          lifecycle_state = excluded.lifecycle_state,
          valid_from = excluded.valid_from,
          valid_until = excluded.valid_until,
          supersedes_assertion_id = excluded.supersedes_assertion_id,
          superseded_by_assertion_id = excluded.superseded_by_assertion_id,
          conflict_set_id = excluded.conflict_set_id,
          updated_at = excluded.updated_at
      `,
      pg: `
        INSERT INTO assertions (
          id, scope_id, policy_version, authority_scope, claim_type, target_type,
          target_id, target_slug, property, value_json, normalized_claim,
          authority_summary, confidence, evidence_count, authority_state,
          lifecycle_state, valid_from, valid_until, supersedes_assertion_id,
          superseded_by_assertion_id, conflict_set_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
        ON CONFLICT(id) DO UPDATE SET
          scope_id = excluded.scope_id,
          policy_version = excluded.policy_version,
          authority_scope = excluded.authority_scope,
          claim_type = excluded.claim_type,
          target_type = excluded.target_type,
          target_id = excluded.target_id,
          target_slug = excluded.target_slug,
          property = excluded.property,
          value_json = excluded.value_json,
          normalized_claim = excluded.normalized_claim,
          authority_summary = excluded.authority_summary,
          confidence = excluded.confidence,
          evidence_count = excluded.evidence_count,
          authority_state = excluded.authority_state,
          lifecycle_state = excluded.lifecycle_state,
          valid_from = excluded.valid_from,
          valid_until = excluded.valid_until,
          supersedes_assertion_id = excluded.supersedes_assertion_id,
          superseded_by_assertion_id = excluded.superseded_by_assertion_id,
          conflict_set_id = excluded.conflict_set_id,
          updated_at = excluded.updated_at
      `,
      params: assertionParams(assertion),
    });
  }
}

async function insertAssertionEvidence(
  engine: BrainEngine,
  evidence: AssertionEvidenceRecord,
): Promise<void> {
  await execute(engine, {
    sqlite: `
      INSERT INTO assertion_evidence (
        id, assertion_id, scope_id, policy_version, authority_scope,
        extracted_claim_id, source_id, source_item_id, source_chunk_id,
        session_id, task_event_id, contribution_type, evidence_authority,
        evidence_confidence, valid_from, valid_until, revocation_state,
        forgetting_state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `,
    pg: `
      INSERT INTO assertion_evidence (
        id, assertion_id, scope_id, policy_version, authority_scope,
        extracted_claim_id, source_id, source_item_id, source_chunk_id,
        session_id, task_event_id, contribution_type, evidence_authority,
        evidence_confidence, valid_from, valid_until, revocation_state,
        forgetting_state, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT(id) DO NOTHING
    `,
    params: [
      evidence.id,
      evidence.assertion_id,
      evidence.scope_id,
      evidence.policy_version,
      evidence.authority_scope,
      evidence.extracted_claim_id,
      evidence.source_id,
      evidence.source_item_id,
      evidence.source_chunk_id,
      evidence.session_id,
      evidence.task_event_id,
      evidence.contribution_type,
      evidence.evidence_authority,
      evidence.evidence_confidence,
      evidence.valid_from,
      evidence.valid_until,
      evidence.revocation_state,
      evidence.forgetting_state,
      evidence.created_at,
    ],
  });
}

async function queryRows(
  engine: BrainEngine,
  input: { sqlite: string; pg: string; params: unknown[] },
): Promise<Record<string, unknown>[]> {
  if (engine instanceof PostgresEngine) {
    const rows = await (engine as PostgresEngine).sql.unsafe(input.pg, input.params as any);
    return rows as Record<string, unknown>[];
  }
  const candidate = engine as SqlCapableEngine;
  if (candidate.database) {
    return candidate.database.query(input.sqlite).all(...input.params) as Record<string, unknown>[];
  }
  if (candidate.db) {
    return (await candidate.db.query(input.pg, input.params)).rows;
  }
  const engineName = (engine as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
  throw new Error(`assertion resolution requires a SQL-capable engine; got ${engineName}`);
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
  throw new Error(`assertion resolution requires a SQL-capable engine; got ${engineName}`);
}

function resolutionTarget(input: ResolveExtractedClaimForEngineInput): {
  target_type: string;
  target_id: string;
  target_slug: string | null;
} {
  const inferredType = inferAssertionTargetType(input.claim.target_hint);
  const targetType = input.target_type ?? inferredType;
  const targetId = input.target_id ?? input.claim.target_hint;
  const inferredSlug = targetType === 'system' || targetType === 'page' ? targetId : null;
  return {
    target_type: targetType,
    target_id: targetId,
    target_slug: input.target_slug ?? inferredSlug,
  };
}

function assertionParams(assertion: AssertionRecord): unknown[] {
  return [
    assertion.id,
    assertion.scope_id,
    assertion.policy_version,
    assertion.authority_scope,
    assertion.claim_type,
    assertion.target_type,
    assertion.target_id,
    assertion.target_slug,
    assertion.property,
    jsonParam(assertion.value_json),
    assertion.normalized_claim,
    jsonParam(assertion.authority_summary),
    assertion.confidence,
    assertion.evidence_count,
    assertion.authority_state,
    assertion.lifecycle_state,
    assertion.valid_from,
    assertion.valid_until,
    assertion.supersedes_assertion_id,
    assertion.superseded_by_assertion_id,
    assertion.conflict_set_id,
    assertion.created_at,
    assertion.updated_at,
  ];
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
    authority_summary: jsonValue(row.authority_summary) as AssertionRecord['authority_summary'],
    confidence: numberValue(row.confidence),
    evidence_count: numberValue(row.evidence_count),
    authority_state: stringValue(row.authority_state) as AssertionRecord['authority_state'],
    lifecycle_state: stringValue(row.lifecycle_state) as AssertionRecord['lifecycle_state'],
    valid_from: nullableString(row.valid_from),
    valid_until: nullableString(row.valid_until),
    supersedes_assertion_id: nullableString(row.supersedes_assertion_id),
    superseded_by_assertion_id: nullableString(row.superseded_by_assertion_id),
    conflict_set_id: nullableString(row.conflict_set_id),
    created_at: stringValue(row.created_at),
    updated_at: stringValue(row.updated_at),
  };
}

function rowToAssertionEvidence(row: Record<string, unknown>): AssertionEvidenceRecord {
  return {
    id: stringValue(row.id),
    assertion_id: stringValue(row.assertion_id),
    scope_id: stringValue(row.scope_id) || 'workspace:default',
    policy_version: stringValue(row.policy_version) || 'policy:v1',
    authority_scope: stringValue(row.authority_scope) || 'work',
    extracted_claim_id: stringValue(row.extracted_claim_id),
    source_id: stringValue(row.source_id),
    source_item_id: stringValue(row.source_item_id),
    source_chunk_id: stringValue(row.source_chunk_id),
    session_id: nullableString(row.session_id),
    task_event_id: nullableString(row.task_event_id),
    contribution_type: stringValue(row.contribution_type) as AssertionEvidenceRecord['contribution_type'],
    evidence_authority: stringValue(row.evidence_authority),
    evidence_confidence: numberValue(row.evidence_confidence),
    valid_from: nullableString(row.valid_from),
    valid_until: nullableString(row.valid_until),
    revocation_state: stringValue(row.revocation_state) as AssertionEvidenceRecord['revocation_state'],
    forgetting_state: stringValue(row.forgetting_state) as AssertionEvidenceRecord['forgetting_state'],
    created_at: stringValue(row.created_at),
  };
}

function isPostgresDialect(engine: BrainEngine): boolean {
  return engine instanceof PostgresEngine || Boolean((engine as SqlCapableEngine).db);
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null);
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
