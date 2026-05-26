import type { BrainEngine } from '../engine.ts';
import { PostgresEngine } from '../postgres-engine.ts';

export interface AssertionExplainInput {
  assertion_id?: string;
  target_slug?: string;
  limit?: number;
  include_raw?: boolean;
}

export interface ProjectionExplainInput {
  projection_target_id?: string;
  target_type?: string;
  target_id?: string;
  limit?: number;
  include_raw?: boolean;
}

interface SQLiteDatabaseLike {
  query<T = Record<string, unknown>>(sql: string): {
    all(...params: unknown[]): T[];
  };
}

interface AsyncQueryLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface SqlCapableEngine extends BrainEngine {
  database?: SQLiteDatabaseLike;
  db?: AsyncQueryLike;
}

interface LineageBuildInput {
  query: Record<string, string>;
  assertions: Record<string, unknown>[];
  projectionTargets?: Record<string, unknown>[];
  writeAttempts?: Record<string, unknown>[];
  include_raw?: boolean;
  limit?: number;
}

const REDACTED_SECRET = '[REDACTED_SECRET]';
const REDACTED_JSON = { redacted: true };

export async function explainAssertionForEngine(
  engine: BrainEngine,
  input: AssertionExplainInput,
): Promise<Record<string, unknown>> {
  const limit = normalizeLimit(input.limit);
  const assertions = input.assertion_id
    ? await selectRowsByIds(engine, 'assertions', 'id', [input.assertion_id])
    : await selectAssertionsByTargetSlug(engine, input.target_slug ?? '', limit);

  return buildLineageExplanation(engine, {
    query: input.assertion_id ? { assertion_id: input.assertion_id } : { target_slug: input.target_slug ?? '' },
    assertions,
    include_raw: input.include_raw,
    limit,
  });
}

export async function explainProjectionForEngine(
  engine: BrainEngine,
  input: ProjectionExplainInput,
): Promise<Record<string, unknown>> {
  const limit = normalizeLimit(input.limit);
  const projectionTargets = input.projection_target_id
    ? await selectRowsByIds(engine, 'canonical_projection_targets', 'id', [input.projection_target_id])
    : await selectProjectionTargetsByTarget(engine, input.target_type ?? '', input.target_id ?? '', limit);
  const projectionTargetRows = projectionTargets.map(normalizeProjectionTargetRow);
  const projectionIds = projectionTargetRows.map((target) => target.id);
  const writeAttempts = await selectWriteAttemptsLinked(engine, { projectionIds }, limit);
  const assertionIds = uniqueStrings([
    ...projectionTargetRows.flatMap((target) => target.source_assertion_ids),
    ...writeAttempts.flatMap((attempt) => stringArray(attempt.assertion_ids)),
  ]);
  const assertions = assertionIds.length > 0
    ? await selectRowsByIds(engine, 'assertions', 'id', assertionIds)
    : [];

  return buildLineageExplanation(engine, {
    query: input.projection_target_id
      ? { projection_target_id: input.projection_target_id }
      : { target_type: input.target_type ?? '', target_id: input.target_id ?? '' },
    assertions,
    projectionTargets,
    writeAttempts,
    include_raw: input.include_raw,
    limit,
  });
}

async function buildLineageExplanation(
  engine: BrainEngine,
  input: LineageBuildInput,
): Promise<Record<string, unknown>> {
  const limit = normalizeLimit(input.limit);
  const rawAssertionRows = input.assertions.map(normalizeAssertionRow);
  const assertionIds = rawAssertionRows.map((assertion) => assertion.id);
  const evidenceRows = assertionIds.length > 0
    ? (await selectRowsByIds(engine, 'assertion_evidence', 'assertion_id', assertionIds))
      .map(normalizeAssertionEvidenceRow)
    : [];
  const evidenceIds = evidenceRows.map((evidence) => evidence.id);
  const claimIds = uniqueStrings(evidenceRows.map((evidence) => evidence.extracted_claim_id));
  const rawExtractedClaimRows = claimIds.length > 0
    ? (await selectRowsByIds(engine, 'extracted_claims', 'id', claimIds)).map(normalizeExtractedClaimRow)
    : [];
  const sourceIds = uniqueStrings(evidenceRows.map((evidence) => evidence.source_id));
  const sourceItemIds = uniqueStrings(evidenceRows.map((evidence) => evidence.source_item_id));
  const sourceChunkIds = uniqueStrings(evidenceRows.map((evidence) => evidence.source_chunk_id));
  const [sources, sourceItems, sourceChunks] = await Promise.all([
    sourceIds.length > 0 ? selectRowsByIds(engine, 'sources', 'id', sourceIds) : Promise.resolve([]),
    sourceItemIds.length > 0 ? selectRowsByIds(engine, 'source_items', 'id', sourceItemIds) : Promise.resolve([]),
    sourceChunkIds.length > 0 ? selectRowsByIds(engine, 'source_chunks', 'id', sourceChunkIds) : Promise.resolve([]),
  ]);
  const sourceRowsById = new Map(sources.map((row) => [stringValue(row.id), normalizeSourceRow(row)]));
  const itemRowsById = new Map(sourceItems.map((row) => [stringValue(row.id), normalizeSourceItemRow(row)]));
  const chunkRowsById = new Map(sourceChunks.map((row) => [stringValue(row.id), normalizeSourceChunkRow(row, Boolean(input.include_raw))]));
  const secretChunkIds = new Set([...chunkRowsById.values()]
    .filter((chunk) => chunk.secret_risk !== 'none')
    .map((chunk) => chunk.id));
  const secretClaimIds = new Set(rawExtractedClaimRows
    .filter((claim) => claim.secret_flag || secretChunkIds.has(claim.source_chunk_id))
    .map((claim) => claim.id));
  const secretEvidenceIds = new Set(evidenceRows
    .filter((evidence) => secretClaimIds.has(evidence.extracted_claim_id) || secretChunkIds.has(evidence.source_chunk_id))
    .map((evidence) => evidence.id));
  const secretAssertionIds = new Set(evidenceRows
    .filter((evidence) => secretEvidenceIds.has(evidence.id))
    .map((evidence) => evidence.assertion_id));
  const assertionRows = rawAssertionRows.map((assertion) => secretAssertionIds.has(assertion.id)
    ? redactAssertionRow(assertion)
    : assertion);
  const extractedClaimRows = rawExtractedClaimRows.map((claim) => secretClaimIds.has(claim.id)
    ? redactExtractedClaimRow(claim)
    : claim);

  const seedProjectionTargets = (input.projectionTargets ?? []).map(normalizeProjectionTargetRow);
  const projectionTargetsByAssertion = assertionIds.length > 0
    ? await selectProjectionTargetsLinkedToAssertions(engine, assertionIds, limit)
    : [];
  const rawWriteAttempts = dedupeById([
    ...(input.writeAttempts ?? []).map(normalizeCanonicalWriteAttemptRow),
    ...await selectWriteAttemptsLinked(engine, {
      assertionIds,
      evidenceIds,
      claimIds,
      projectionIds: seedProjectionTargets.map((target) => target.id),
    }, limit),
  ]);
  const writeAttempts = rawWriteAttempts.map((attempt) => isSecretLinkedWriteAttempt(attempt, {
    assertionIds: secretAssertionIds,
    evidenceIds: secretEvidenceIds,
    claimIds: secretClaimIds,
  }) ? redactCanonicalWriteAttemptRow(attempt) : attempt);
  const projectionTargetIdsFromWrites = uniqueStrings(rawWriteAttempts.flatMap((attempt) => stringArray(attempt.target_projection_ids)));
  const projectionTargetsByWriteIds = projectionTargetIdsFromWrites.length > 0
    ? (await selectRowsByIds(engine, 'canonical_projection_targets', 'id', projectionTargetIdsFromWrites)).map(normalizeProjectionTargetRow)
    : [];
  const rawProjectionTargets = dedupeById([
    ...seedProjectionTargets,
    ...projectionTargetsByAssertion,
    ...projectionTargetsByWriteIds,
  ]);
  const projectionTargets = rawProjectionTargets.map((target) => intersects(target.source_assertion_ids, [...secretAssertionIds])
    ? redactProjectionTargetRow(target)
    : target);
  const projectionMutations = await selectProjectionMutationsLinked(engine, {
    assertionIds,
    evidenceIds,
    claimIds,
    writeAttemptIds: rawWriteAttempts.map((attempt) => attempt.id),
    projectionTargets: rawProjectionTargets,
  }, limit);
  const safeProjectionMutations = projectionMutations.map((mutation) => isSecretLinkedProjectionMutation(mutation, {
    assertionIds: secretAssertionIds,
    evidenceIds: secretEvidenceIds,
    claimIds: secretClaimIds,
    writeAttemptIds: new Set(rawWriteAttempts
      .filter((attempt) => isSecretLinkedWriteAttempt(attempt, {
        assertionIds: secretAssertionIds,
        evidenceIds: secretEvidenceIds,
        claimIds: secretClaimIds,
      }))
      .map((attempt) => attempt.id)),
  }) ? redactProjectionMutationRow(mutation) : mutation);

  return {
    query: input.query,
    assertions: assertionRows,
    extracted_claims: extractedClaimRows,
    assertion_evidence: evidenceRows,
    source_refs: buildSourceRefs(evidenceRows, sourceRowsById, itemRowsById, chunkRowsById),
    canonical_write_attempts: writeAttempts,
    projection_targets: projectionTargets,
    projection_mutations: safeProjectionMutations,
    missing_links: findMissingLinks({
      assertions: assertionRows,
      evidence: evidenceRows,
      claims: extractedClaimRows,
      sourceRowsById,
      itemRowsById,
      chunkRowsById,
      projectionTargets,
    }),
  };
}

async function selectAssertionsByTargetSlug(
  engine: BrainEngine,
  targetSlug: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  return queryRows(engine, {
    sqlite: `
      SELECT *
      FROM assertions
      WHERE target_slug = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `,
    pg: `
      SELECT *
      FROM assertions
      WHERE target_slug = $1
      ORDER BY created_at ASC, id ASC
      LIMIT $2
    `,
    params: [targetSlug, limit],
  });
}

async function selectProjectionTargetsByTarget(
  engine: BrainEngine,
  targetType: string,
  targetId: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  return queryRows(engine, {
    sqlite: `
      SELECT *
      FROM canonical_projection_targets
      WHERE target_type = ? AND target_id = ?
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `,
    pg: `
      SELECT *
      FROM canonical_projection_targets
      WHERE target_type = $1 AND target_id = $2
      ORDER BY updated_at DESC, id ASC
      LIMIT $3
    `,
    params: [targetType, targetId, limit],
  });
}

async function selectRowsByIds(
  engine: BrainEngine,
  table: string,
  column: string,
  ids: string[],
): Promise<Record<string, unknown>[]> {
  const uniqueIds = uniqueStrings(ids);
  if (uniqueIds.length === 0) return [];
  const sqlitePlaceholders = uniqueIds.map(() => '?').join(', ');
  const pgPlaceholders = uniqueIds.map((_, index) => `$${index + 1}`).join(', ');
  return queryRows(engine, {
    sqlite: `
      SELECT *
      FROM ${table}
      WHERE ${column} IN (${sqlitePlaceholders})
      ORDER BY id ASC
    `,
    pg: `
      SELECT *
      FROM ${table}
      WHERE ${column} IN (${pgPlaceholders})
      ORDER BY id ASC
    `,
    params: uniqueIds,
  });
}

async function selectProjectionTargetsLinkedToAssertions(
  engine: BrainEngine,
  assertionIds: string[],
  limit: number,
): Promise<Array<ReturnType<typeof normalizeProjectionTargetRow>>> {
  const where = buildLinkedWhere([
    { kind: 'json_array', column: 'source_assertion_ids', values: assertionIds },
  ]);
  if (!where) return [];
  const params = [...where.params, scanLimit(limit)];
  const rows = await queryRows(engine, {
    sqlite: `
      SELECT *
      FROM canonical_projection_targets
      WHERE ${where.sqlite}
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `,
    pg: `
      SELECT *
      FROM canonical_projection_targets
      WHERE ${where.pg}
      ORDER BY updated_at DESC, id ASC
      LIMIT $${params.length}
    `,
    params,
  });
  return rows
    .map(normalizeProjectionTargetRow);
}

async function selectWriteAttemptsLinked(
  engine: BrainEngine,
  links: {
    assertionIds?: string[];
    evidenceIds?: string[];
    claimIds?: string[];
    projectionIds?: string[];
  },
  limit: number,
): Promise<Array<ReturnType<typeof normalizeCanonicalWriteAttemptRow>>> {
  const where = buildLinkedWhere([
    { kind: 'json_array', column: 'assertion_ids', values: links.assertionIds ?? [] },
    { kind: 'json_array', column: 'assertion_evidence_ids', values: links.evidenceIds ?? [] },
    { kind: 'json_array', column: 'extracted_claim_ids', values: links.claimIds ?? [] },
    { kind: 'json_array', column: 'target_projection_ids', values: links.projectionIds ?? [] },
  ]);
  if (!where) return [];
  const params = [...where.params, scanLimit(limit)];
  const rows = await queryRows(engine, {
    sqlite: `
      SELECT *
      FROM canonical_write_attempts
      WHERE ${where.sqlite}
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `,
    pg: `
      SELECT *
      FROM canonical_write_attempts
      WHERE ${where.pg}
      ORDER BY created_at DESC, id ASC
      LIMIT $${params.length}
    `,
    params,
  });
  return rows
    .map(normalizeCanonicalWriteAttemptRow);
}

async function selectProjectionMutationsLinked(
  engine: BrainEngine,
  links: {
    assertionIds: string[];
    evidenceIds: string[];
    claimIds: string[];
    writeAttemptIds: string[];
    projectionTargets: Array<{ target_type: string; target_id: string }>;
  },
  limit: number,
): Promise<Array<ReturnType<typeof normalizeProjectionMutationRow>>> {
  const projectionPairs = links.projectionTargets.map((target) => ({
    left: target.target_type,
    right: target.target_id,
  }));
  const where = buildLinkedWhere([
    { kind: 'in', column: 'canonical_write_attempt_id', values: links.writeAttemptIds },
    { kind: 'json_array', column: 'assertion_ids', values: links.assertionIds },
    { kind: 'json_array', column: 'assertion_evidence_ids', values: links.evidenceIds },
    { kind: 'json_array', column: 'extracted_claim_ids', values: links.claimIds },
    { kind: 'pair', leftColumn: 'projection_kind', rightColumn: 'projection_slug', values: projectionPairs },
  ]);
  if (!where) return [];
  const params = [...where.params, scanLimit(limit)];
  const rows = await queryRows(engine, {
    sqlite: `
      SELECT *
      FROM canonical_projection_mutations
      WHERE ${where.sqlite}
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `,
    pg: `
      SELECT *
      FROM canonical_projection_mutations
      WHERE ${where.pg}
      ORDER BY created_at DESC, id ASC
      LIMIT $${params.length}
    `,
    params,
  });
  return rows
    .map(normalizeProjectionMutationRow);
}

type LinkedWherePart =
  | { kind: 'json_array'; column: string; values: string[] }
  | { kind: 'in'; column: string; values: string[] }
  | { kind: 'pair'; leftColumn: string; rightColumn: string; values: Array<{ left: string; right: string }> };

function buildLinkedWhere(parts: LinkedWherePart[]): { sqlite: string; pg: string; params: string[] } | null {
  const sqliteClauses: string[] = [];
  const pgClauses: string[] = [];
  const params: string[] = [];

  for (const part of parts) {
    if (part.kind === 'json_array') {
      const values = uniqueStrings(part.values);
      if (values.length === 0) continue;
      const sqlitePlaceholders = values.map(() => '?').join(', ');
      const pgPlaceholders = values.map((_, index) => `$${params.length + index + 1}`).join(', ');
      const alias = `json_link_${sqliteClauses.length}`;
      sqliteClauses.push(`EXISTS (SELECT 1 FROM json_each(${part.column}) WHERE json_each.value IN (${sqlitePlaceholders}))`);
      pgClauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${part.column}) AS ${alias}(value) WHERE ${alias}.value IN (${pgPlaceholders}))`);
      params.push(...values);
      continue;
    }

    if (part.kind === 'in') {
      const values = uniqueStrings(part.values);
      if (values.length === 0) continue;
      const sqlitePlaceholders = values.map(() => '?').join(', ');
      const pgPlaceholders = values.map((_, index) => `$${params.length + index + 1}`).join(', ');
      sqliteClauses.push(`${part.column} IN (${sqlitePlaceholders})`);
      pgClauses.push(`${part.column} IN (${pgPlaceholders})`);
      params.push(...values);
      continue;
    }

    const pairs = part.values.filter((pair) => pair.left.length > 0 && pair.right.length > 0);
    if (pairs.length === 0) continue;
    const sqlitePairClauses: string[] = [];
    const pgPairClauses: string[] = [];
    for (const pair of pairs) {
      sqlitePairClauses.push(`(${part.leftColumn} = ? AND ${part.rightColumn} = ?)`);
      pgPairClauses.push(`(${part.leftColumn} = $${params.length + 1} AND ${part.rightColumn} = $${params.length + 2})`);
      params.push(pair.left, pair.right);
    }
    sqliteClauses.push(`(${sqlitePairClauses.join(' OR ')})`);
    pgClauses.push(`(${pgPairClauses.join(' OR ')})`);
  }

  if (sqliteClauses.length === 0) return null;
  return {
    sqlite: sqliteClauses.join(' OR '),
    pg: pgClauses.join(' OR '),
    params,
  };
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
  const engineName = (engine as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
  throw new Error(`assertion audit explain requires a SQL-capable engine; got ${engineName}`);
}

function buildSourceRefs(
  evidenceRows: ReturnType<typeof normalizeAssertionEvidenceRow>[],
  sourceRowsById: Map<string, ReturnType<typeof normalizeSourceRow>>,
  itemRowsById: Map<string, ReturnType<typeof normalizeSourceItemRow>>,
  chunkRowsById: Map<string, ReturnType<typeof normalizeSourceChunkRow>>,
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const refs: Record<string, unknown>[] = [];
  for (const evidence of evidenceRows) {
    if (seen.has(evidence.source_chunk_id)) continue;
    seen.add(evidence.source_chunk_id);
    refs.push({
      source: sourceRowsById.get(evidence.source_id) ?? null,
      source_item: itemRowsById.get(evidence.source_item_id) ?? null,
      source_chunk: chunkRowsById.get(evidence.source_chunk_id) ?? null,
    });
  }
  return refs;
}

function redactAssertionRow(row: ReturnType<typeof normalizeAssertionRow>): ReturnType<typeof normalizeAssertionRow> {
  return {
    ...row,
    value_json: REDACTED_JSON,
    normalized_claim: REDACTED_SECRET,
    authority_summary: REDACTED_JSON,
  };
}

function redactExtractedClaimRow(row: ReturnType<typeof normalizeExtractedClaimRow>): ReturnType<typeof normalizeExtractedClaimRow> {
  return {
    ...row,
    claim_text: REDACTED_SECRET,
    value_json: REDACTED_JSON,
  };
}

function redactCanonicalWriteAttemptRow(row: ReturnType<typeof normalizeCanonicalWriteAttemptRow>): ReturnType<typeof normalizeCanonicalWriteAttemptRow> {
  return {
    ...row,
    policy_explanation: REDACTED_SECRET,
    source_refs: [],
    error_json: REDACTED_JSON,
    metadata_json: REDACTED_JSON,
  };
}

function redactProjectionTargetRow(row: ReturnType<typeof normalizeProjectionTargetRow>): ReturnType<typeof normalizeProjectionTargetRow> {
  return {
    ...row,
    metadata_json: REDACTED_JSON,
  };
}

function redactProjectionMutationRow(row: ReturnType<typeof normalizeProjectionMutationRow>): ReturnType<typeof normalizeProjectionMutationRow> {
  return {
    ...row,
    source_refs: [],
    error_message: row.error_message ? REDACTED_SECRET : null,
  };
}

function isSecretLinkedWriteAttempt(
  row: ReturnType<typeof normalizeCanonicalWriteAttemptRow>,
  secrets: { assertionIds: Set<string>; evidenceIds: Set<string>; claimIds: Set<string> },
): boolean {
  return intersects(stringArray(row.assertion_ids), [...secrets.assertionIds])
    || intersects(stringArray(row.assertion_evidence_ids), [...secrets.evidenceIds])
    || intersects(stringArray(row.extracted_claim_ids), [...secrets.claimIds]);
}

function isSecretLinkedProjectionMutation(
  row: ReturnType<typeof normalizeProjectionMutationRow>,
  secrets: {
    assertionIds: Set<string>;
    evidenceIds: Set<string>;
    claimIds: Set<string>;
    writeAttemptIds: Set<string>;
  },
): boolean {
  return secrets.writeAttemptIds.has(row.canonical_write_attempt_id ?? '')
    || intersects(stringArray(row.assertion_ids), [...secrets.assertionIds])
    || intersects(stringArray(row.assertion_evidence_ids), [...secrets.evidenceIds])
    || intersects(stringArray(row.extracted_claim_ids), [...secrets.claimIds]);
}

function findMissingLinks(input: {
  assertions: ReturnType<typeof normalizeAssertionRow>[];
  evidence: ReturnType<typeof normalizeAssertionEvidenceRow>[];
  claims: ReturnType<typeof normalizeExtractedClaimRow>[];
  sourceRowsById: Map<string, unknown>;
  itemRowsById: Map<string, unknown>;
  chunkRowsById: Map<string, unknown>;
  projectionTargets: Array<{ id: string }>;
}): string[] {
  const gaps: string[] = [];
  const assertionIdsWithEvidence = new Set(input.evidence.map((evidence) => evidence.assertion_id));
  const claimIds = new Set(input.claims.map((claim) => claim.id));
  for (const assertion of input.assertions) {
    if (!assertionIdsWithEvidence.has(assertion.id)) gaps.push(`assertion_evidence_missing:${assertion.id}`);
  }
  for (const evidence of input.evidence) {
    if (!claimIds.has(evidence.extracted_claim_id)) gaps.push(`extracted_claim_missing:${evidence.extracted_claim_id}`);
    if (!input.sourceRowsById.has(evidence.source_id)) gaps.push(`source_missing:${evidence.source_id}`);
    if (!input.itemRowsById.has(evidence.source_item_id)) gaps.push(`source_item_missing:${evidence.source_item_id}`);
    if (!input.chunkRowsById.has(evidence.source_chunk_id)) gaps.push(`source_chunk_missing:${evidence.source_chunk_id}`);
  }
  if (input.assertions.length > 0 && input.projectionTargets.length === 0) {
    gaps.push('projection_target_missing');
  }
  return gaps;
}

function normalizeAssertionRow(row: Record<string, unknown>) {
  return {
    id: stringValue(row.id),
    claim_type: stringValue(row.claim_type),
    target_type: stringValue(row.target_type),
    target_id: nullableString(row.target_id),
    target_slug: nullableString(row.target_slug),
    property: stringValue(row.property),
    value_json: jsonValue(row.value_json),
    normalized_claim: stringValue(row.normalized_claim),
    authority_summary: jsonObject(row.authority_summary),
    confidence: numberValue(row.confidence),
    evidence_count: numberValue(row.evidence_count),
    authority_state: stringValue(row.authority_state),
    lifecycle_state: stringValue(row.lifecycle_state),
    valid_from: nullableString(row.valid_from),
    valid_until: nullableString(row.valid_until),
    supersedes_assertion_id: nullableString(row.supersedes_assertion_id),
    superseded_by_assertion_id: nullableString(row.superseded_by_assertion_id),
    conflict_set_id: nullableString(row.conflict_set_id),
    created_at: stringValue(row.created_at),
    updated_at: stringValue(row.updated_at),
  };
}

function normalizeExtractedClaimRow(row: Record<string, unknown>) {
  return {
    id: stringValue(row.id),
    source_id: stringValue(row.source_id),
    source_item_id: stringValue(row.source_item_id),
    source_chunk_id: stringValue(row.source_chunk_id),
    extractor_kind: stringValue(row.extractor_kind),
    extractor_version: stringValue(row.extractor_version),
    runner_job_id: nullableString(row.runner_job_id),
    claim_text: stringValue(row.claim_text),
    claim_type: stringValue(row.claim_type),
    target_hint: stringValue(row.target_hint),
    property_hint: stringValue(row.property_hint),
    value_json: jsonValue(row.value_json),
    confidence: numberValue(row.confidence),
    sensitivity_level: stringValue(row.sensitivity_level),
    prompt_injection_flag: booleanValue(row.prompt_injection_flag),
    secret_flag: booleanValue(row.secret_flag),
    status: stringValue(row.status),
    created_at: stringValue(row.created_at),
  };
}

function normalizeAssertionEvidenceRow(row: Record<string, unknown>) {
  return {
    id: stringValue(row.id),
    assertion_id: stringValue(row.assertion_id),
    extracted_claim_id: stringValue(row.extracted_claim_id),
    source_id: stringValue(row.source_id),
    source_item_id: stringValue(row.source_item_id),
    source_chunk_id: stringValue(row.source_chunk_id),
    session_id: nullableString(row.session_id),
    task_event_id: nullableString(row.task_event_id),
    contribution_type: stringValue(row.contribution_type),
    evidence_authority: stringValue(row.evidence_authority),
    evidence_confidence: numberValue(row.evidence_confidence),
    valid_from: nullableString(row.valid_from),
    valid_until: nullableString(row.valid_until),
    revocation_state: stringValue(row.revocation_state),
    forgetting_state: stringValue(row.forgetting_state),
    created_at: stringValue(row.created_at),
  };
}

function normalizeSourceRow(row: Record<string, unknown>) {
  return {
    id: stringValue(row.id),
    kind: stringValue(row.kind),
    display_name: stringValue(row.display_name),
    connector_id: nullableString(row.connector_id),
    locator: nullableString(row.locator),
    consent_state: stringValue(row.consent_state),
    enabled: booleanValue(row.enabled),
    paused_at: nullableString(row.paused_at),
    policy_id: nullableString(row.policy_id),
    metadata_json: jsonObject(row.metadata_json),
    created_at: stringValue(row.created_at),
    updated_at: stringValue(row.updated_at),
    archived_at: nullableString(row.archived_at),
  };
}

function normalizeSourceItemRow(row: Record<string, unknown>) {
  return {
    id: stringValue(row.id),
    source_id: stringValue(row.source_id),
    external_id: stringValue(row.external_id),
    origin_event: stringValue(row.origin_event),
    locator: nullableString(row.locator),
    title: stringValue(row.title),
    source_created_at: nullableString(row.source_created_at),
    source_updated_at: nullableString(row.source_updated_at),
    ingested_at: stringValue(row.ingested_at),
    content_hash: stringValue(row.content_hash),
    metadata_json: jsonObject(row.metadata_json),
    raw_copy_mode: stringValue(row.raw_copy_mode),
    raw_copy_ref: nullableString(row.raw_copy_ref),
    sensitivity_level: stringValue(row.sensitivity_level),
    ingest_status: stringValue(row.ingest_status),
    retention_policy_id: nullableString(row.retention_policy_id),
  };
}

function normalizeSourceChunkRow(row: Record<string, unknown>, includeRaw: boolean) {
  const secretRisk = stringValue(row.secret_risk);
  const promptRisk = stringValue(row.prompt_injection_risk);
  const redactedText = safeRedactedText(row.redacted_text, secretRisk, promptRisk);
  return {
    id: stringValue(row.id),
    source_item_id: stringValue(row.source_item_id),
    chunk_index: numberValue(row.chunk_index),
    chunk_hash: stringValue(row.chunk_hash),
    redacted_text: redactedText,
    raw_text: includeRaw && secretRisk === 'none' && promptRisk === 'none'
      ? stringValue(row.chunk_text)
      : undefined,
    token_count: numberValue(row.token_count),
    parser_version: stringValue(row.parser_version),
    extractor_version: stringValue(row.extractor_version),
    sensitivity_flags: jsonArray(row.sensitivity_flags),
    prompt_injection_risk: promptRisk,
    secret_risk: secretRisk,
    created_at: stringValue(row.created_at),
    expires_at: nullableString(row.expires_at),
  };
}

function normalizeCanonicalWriteAttemptRow(row: Record<string, unknown>) {
  return {
    id: stringValue(row.id),
    policy_decision: stringValue(row.policy_decision),
    policy_explanation: stringValue(row.policy_explanation),
    policy_explanation_hash: nullableString(row.policy_explanation_hash),
    assertion_ids: jsonArray(row.assertion_ids),
    assertion_evidence_ids: jsonArray(row.assertion_evidence_ids),
    extracted_claim_ids: jsonArray(row.extracted_claim_ids),
    source_refs: jsonArray(row.source_refs),
    target_projection_ids: jsonArray(row.target_projection_ids),
    before_db_hash: nullableString(row.before_db_hash),
    after_db_hash: nullableString(row.after_db_hash),
    before_markdown_hash: nullableString(row.before_markdown_hash),
    after_markdown_hash: nullableString(row.after_markdown_hash),
    actor: stringValue(row.actor),
    session_id: nullableString(row.session_id),
    job_id: nullableString(row.job_id),
    runner_id: nullableString(row.runner_id),
    status: stringValue(row.status),
    error_json: jsonObject(row.error_json),
    metadata_json: jsonObject(row.metadata_json),
    created_at: stringValue(row.created_at),
  };
}

function normalizeProjectionTargetRow(row: Record<string, unknown>) {
  return {
    id: stringValue(row.id),
    target_type: stringValue(row.target_type),
    target_id: stringValue(row.target_id),
    locator: stringValue(row.locator),
    source_assertion_ids: stringArray(row.source_assertion_ids),
    projection_hash: stringValue(row.projection_hash),
    last_rendered_at: nullableString(row.last_rendered_at),
    last_reconciled_at: nullableString(row.last_reconciled_at),
    status: stringValue(row.status),
    runtime_only: booleanValue(row.runtime_only),
    canonical_changed_since_projection: booleanValue(row.canonical_changed_since_projection),
    metadata_json: jsonObject(row.metadata_json),
    created_at: stringValue(row.created_at),
    updated_at: stringValue(row.updated_at),
  };
}

function normalizeProjectionMutationRow(row: Record<string, unknown>) {
  return {
    id: stringValue(row.id),
    canonical_write_attempt_id: nullableString(row.canonical_write_attempt_id),
    projection_kind: stringValue(row.projection_kind),
    projection_slug: stringValue(row.projection_slug),
    mutation_kind: stringValue(row.mutation_kind),
    assertion_ids: jsonArray(row.assertion_ids),
    assertion_evidence_ids: jsonArray(row.assertion_evidence_ids),
    extracted_claim_ids: jsonArray(row.extracted_claim_ids),
    source_refs: jsonArray(row.source_refs),
    before_markdown_hash: nullableString(row.before_markdown_hash),
    after_markdown_hash: nullableString(row.after_markdown_hash),
    status: stringValue(row.status),
    error_message: nullableString(row.error_message),
    created_at: stringValue(row.created_at),
  };
}

function safeRedactedText(redactedValue: unknown, secretRisk: string, promptRisk: string): string {
  const text = stringValue(redactedValue);
  if (text.length > 0) return text;
  if (secretRisk !== 'none' || promptRisk !== 'none') return '[REDACTED]';
  return '';
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  return Math.max(0, Math.min(Math.floor(value), 100));
}

function scanLimit(limit: number): number {
  return Math.max(100, limit * 20);
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    deduped.push(row);
  }
  return deduped;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function intersects(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
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

function booleanValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return false;
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function jsonArray(value: unknown): unknown[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

function stringArray(value: unknown): string[] {
  return jsonArray(value).filter((item): item is string => typeof item === 'string');
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
