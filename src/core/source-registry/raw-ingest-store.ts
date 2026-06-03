import type { BrainEngine } from '../engine.ts';
import type {
  PromptInjectionFlagRecord,
  RawIngestPlan,
  SecretDetectionRecord,
  SourceChunkRecord,
  SourceItemEventRecord,
  SourceItemRecord,
} from './raw-ingest.ts';

type QueryableEngine = BrainEngine & {
  database?: {
    query<T = Record<string, unknown>>(sql: string): {
      get(...params: unknown[]): T | null;
      all(...params: unknown[]): T[];
      run(...params: unknown[]): unknown;
    };
  };
  db?: { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
  sql?: { unsafe(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> };
};

const SOURCE_ORIGIN_EVENTS = [
  'initial_import',
  'connector_sync',
  'manual_entry',
  'user_direct_entry',
  'session_capture',
  'markdown_edit',
] as const satisfies readonly SourceItemRecord['origin_event'][];

export async function persistRawIngestPlan(engine: BrainEngine, plan: RawIngestPlan): Promise<void> {
  await upsertSourceItem(engine, plan.item);
  await deleteRawIngestChildRecords(engine, plan.item.id);
  for (const chunk of plan.chunks) await insertSourceChunk(engine, chunk);
  for (const event of plan.events) await insertSourceItemEvent(engine, event);
  for (const detection of plan.secret_detections) await insertSecretDetection(engine, detection);
  for (const flag of plan.prompt_injection_flags) await insertPromptInjectionFlag(engine, flag);
}

export async function insertSourceItemEvent(engine: BrainEngine, event: SourceItemEventRecord): Promise<void> {
  const candidate = engine as QueryableEngine;
  const values = [event.id, event.source_item_id, event.event_type, '{}', event.created_at];
  if (candidate.database) {
    candidate.database.query(`
      INSERT INTO source_item_events (id, source_item_id, event_type, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(...values);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      INSERT INTO source_item_events (id, source_item_id, event_type, metadata_json, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
    `, values);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      INSERT INTO source_item_events (id, source_item_id, event_type, metadata_json, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
    `, values);
    return;
  }
  throw new Error('raw ingest operations require a SQL-backed engine');
}

export async function readSourceItemByExternalId(
  engine: BrainEngine,
  sourceId: string,
  externalId: string,
): Promise<SourceItemRecord | null> {
  const candidate = engine as QueryableEngine;
  const sql = `
    SELECT id, source_id, external_id, origin_event, locator, title, source_created_at, source_updated_at,
           ingested_at, content_hash, metadata_json, raw_copy_mode, raw_copy_ref, sensitivity_level,
           ingest_status, retention_policy_id
    FROM source_items
    WHERE source_id = ? AND external_id = ?
  `;
  if (candidate.database) {
    const row = candidate.database.query<Record<string, unknown>>(sql).get(sourceId, externalId);
    return row ? mapSourceItem(row) : null;
  }
  const pgSql = sql.replace('?', '$1').replace('?', '$2');
  const rows = candidate.sql?.unsafe
    ? await candidate.sql.unsafe(pgSql, [sourceId, externalId])
    : candidate.db
      ? (await candidate.db.query(pgSql, [sourceId, externalId])).rows
      : null;
  if (!rows) throw new Error('source item inspection operations require a SQL-backed engine');
  return rows[0] ? mapSourceItem(rows[0]) : null;
}

export async function readSourceItemChunks(engine: BrainEngine, sourceItemId: string): Promise<SourceChunkRecord[]> {
  const candidate = engine as QueryableEngine;
  const sql = `
    SELECT id, source_item_id, chunk_index, chunk_hash, chunk_text, redacted_text, token_count,
           parser_version, extractor_version, sensitivity_flags, prompt_injection_risk, secret_risk,
           created_at, expires_at
    FROM source_chunks
    WHERE source_item_id = ?
    ORDER BY chunk_index ASC
  `;
  if (candidate.database) {
    return candidate.database.query<Record<string, unknown>>(sql).all(sourceItemId).map(mapSourceChunk);
  }
  const pgSql = sql.replace('?', '$1');
  const rows = candidate.sql?.unsafe
    ? await candidate.sql.unsafe(pgSql, [sourceItemId])
    : candidate.db
      ? (await candidate.db.query(pgSql, [sourceItemId])).rows
      : null;
  if (!rows) throw new Error('source chunk inspection operations require a SQL-backed engine');
  return rows.map(mapSourceChunk);
}

async function upsertSourceItem(engine: BrainEngine, item: SourceItemRecord): Promise<void> {
  const candidate = engine as QueryableEngine;
  const values = [
    item.id,
    item.source_id,
    item.external_id,
    item.origin_event,
    item.locator,
    item.title,
    item.source_created_at,
    item.source_updated_at,
    item.ingested_at,
    item.content_hash,
    JSON.stringify(item.metadata_json),
    item.raw_copy_mode,
    item.raw_copy_ref,
    item.sensitivity_level,
    item.ingest_status,
    item.retention_policy_id,
  ];
  if (candidate.database) {
    candidate.database.query(`
      INSERT INTO source_items (
        id, source_id, external_id, origin_event, locator, title, source_created_at, source_updated_at,
        ingested_at, content_hash, metadata_json, raw_copy_mode, raw_copy_ref, sensitivity_level,
        ingest_status, retention_policy_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, external_id) DO UPDATE SET
        origin_event = excluded.origin_event,
        locator = excluded.locator,
        title = excluded.title,
        source_created_at = excluded.source_created_at,
        source_updated_at = excluded.source_updated_at,
        ingested_at = excluded.ingested_at,
        content_hash = excluded.content_hash,
        metadata_json = excluded.metadata_json,
        raw_copy_mode = excluded.raw_copy_mode,
        raw_copy_ref = excluded.raw_copy_ref,
        sensitivity_level = excluded.sensitivity_level,
        ingest_status = excluded.ingest_status,
        retention_policy_id = excluded.retention_policy_id
    `).run(...values);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      INSERT INTO source_items (
        id, source_id, external_id, origin_event, locator, title, source_created_at, source_updated_at,
        ingested_at, content_hash, metadata_json, raw_copy_mode, raw_copy_ref, sensitivity_level,
        ingest_status, retention_policy_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16)
      ON CONFLICT(source_id, external_id) DO UPDATE SET
        origin_event = excluded.origin_event,
        locator = excluded.locator,
        title = excluded.title,
        source_created_at = excluded.source_created_at,
        source_updated_at = excluded.source_updated_at,
        ingested_at = excluded.ingested_at,
        content_hash = excluded.content_hash,
        metadata_json = excluded.metadata_json,
        raw_copy_mode = excluded.raw_copy_mode,
        raw_copy_ref = excluded.raw_copy_ref,
        sensitivity_level = excluded.sensitivity_level,
        ingest_status = excluded.ingest_status,
        retention_policy_id = excluded.retention_policy_id
    `, values);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      INSERT INTO source_items (
        id, source_id, external_id, origin_event, locator, title, source_created_at, source_updated_at,
        ingested_at, content_hash, metadata_json, raw_copy_mode, raw_copy_ref, sensitivity_level,
        ingest_status, retention_policy_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16)
      ON CONFLICT(source_id, external_id) DO UPDATE SET
        origin_event = excluded.origin_event,
        locator = excluded.locator,
        title = excluded.title,
        source_created_at = excluded.source_created_at,
        source_updated_at = excluded.source_updated_at,
        ingested_at = excluded.ingested_at,
        content_hash = excluded.content_hash,
        metadata_json = excluded.metadata_json,
        raw_copy_mode = excluded.raw_copy_mode,
        raw_copy_ref = excluded.raw_copy_ref,
        sensitivity_level = excluded.sensitivity_level,
        ingest_status = excluded.ingest_status,
        retention_policy_id = excluded.retention_policy_id
    `, values);
    return;
  }
  throw new Error('raw ingest operations require a SQL-backed engine');
}

async function deleteRawIngestChildRecords(engine: BrainEngine, sourceItemId: string): Promise<void> {
  const candidate = engine as QueryableEngine;
  if (candidate.database) {
    candidate.database.query('DELETE FROM source_item_events WHERE source_item_id = ?').run(sourceItemId);
    candidate.database.query('DELETE FROM prompt_injection_flags WHERE source_item_id = ?').run(sourceItemId);
    candidate.database.query('DELETE FROM secret_detections WHERE source_item_id = ?').run(sourceItemId);
    candidate.database.query('DELETE FROM source_chunks WHERE source_item_id = ?').run(sourceItemId);
    return;
  }
  const sql = [
    'DELETE FROM source_item_events WHERE source_item_id = $1',
    'DELETE FROM prompt_injection_flags WHERE source_item_id = $1',
    'DELETE FROM secret_detections WHERE source_item_id = $1',
    'DELETE FROM source_chunks WHERE source_item_id = $1',
  ];
  if (candidate.sql?.unsafe) {
    for (const statement of sql) await candidate.sql.unsafe(statement, [sourceItemId]);
    return;
  }
  if (candidate.db) {
    for (const statement of sql) await candidate.db.query(statement, [sourceItemId]);
    return;
  }
  throw new Error('raw ingest operations require a SQL-backed engine');
}

async function insertSourceChunk(engine: BrainEngine, chunk: SourceChunkRecord): Promise<void> {
  const candidate = engine as QueryableEngine;
  const values = [
    chunk.id,
    chunk.source_item_id,
    chunk.chunk_index,
    chunk.chunk_hash,
    chunk.chunk_text,
    chunk.redacted_text,
    chunk.token_count,
    chunk.parser_version,
    chunk.extractor_version,
    JSON.stringify(chunk.sensitivity_flags),
    chunk.prompt_injection_risk,
    chunk.secret_risk,
    chunk.created_at,
    chunk.expires_at,
  ];
  if (candidate.database) {
    candidate.database.query(`
      INSERT INTO source_chunks (
        id, source_item_id, chunk_index, chunk_hash, chunk_text, redacted_text, token_count,
        parser_version, extractor_version, sensitivity_flags, prompt_injection_risk, secret_risk,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...values);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      INSERT INTO source_chunks (
        id, source_item_id, chunk_index, chunk_hash, chunk_text, redacted_text, token_count,
        parser_version, extractor_version, sensitivity_flags, prompt_injection_risk, secret_risk,
        created_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
    `, values);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      INSERT INTO source_chunks (
        id, source_item_id, chunk_index, chunk_hash, chunk_text, redacted_text, token_count,
        parser_version, extractor_version, sensitivity_flags, prompt_injection_risk, secret_risk,
        created_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
    `, values);
    return;
  }
  throw new Error('raw ingest operations require a SQL-backed engine');
}

async function insertSecretDetection(engine: BrainEngine, detection: SecretDetectionRecord): Promise<void> {
  const candidate = engine as QueryableEngine;
  const values = [
    detection.id,
    detection.source_item_id,
    detection.source_chunk_id,
    detection.secret_type,
    detection.secret_hash,
    detection.confidence,
    detection.redaction_status,
    detection.purge_plan_status,
    detection.created_at,
  ];
  if (candidate.database) {
    candidate.database.query(`
      INSERT INTO secret_detections (
        id, source_item_id, source_chunk_id, secret_type, secret_hash, confidence,
        redaction_status, purge_plan_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...values);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      INSERT INTO secret_detections (
        id, source_item_id, source_chunk_id, secret_type, secret_hash, confidence,
        redaction_status, purge_plan_status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, values);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      INSERT INTO secret_detections (
        id, source_item_id, source_chunk_id, secret_type, secret_hash, confidence,
        redaction_status, purge_plan_status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, values);
    return;
  }
  throw new Error('raw ingest operations require a SQL-backed engine');
}

async function insertPromptInjectionFlag(engine: BrainEngine, flag: PromptInjectionFlagRecord): Promise<void> {
  const candidate = engine as QueryableEngine;
  const values = [
    flag.id,
    flag.source_item_id,
    flag.source_chunk_id,
    flag.flag_type,
    flag.risk,
    flag.evidence_hash,
    flag.created_at,
  ];
  if (candidate.database) {
    candidate.database.query(`
      INSERT INTO prompt_injection_flags (
        id, source_item_id, source_chunk_id, flag_type, risk, evidence_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(...values);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      INSERT INTO prompt_injection_flags (
        id, source_item_id, source_chunk_id, flag_type, risk, evidence_hash, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, values);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      INSERT INTO prompt_injection_flags (
        id, source_item_id, source_chunk_id, flag_type, risk, evidence_hash, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, values);
    return;
  }
  throw new Error('raw ingest operations require a SQL-backed engine');
}

export function mapSourceItem(row: Record<string, unknown>): SourceItemRecord {
  return {
    id: String(row.id),
    source_id: String(row.source_id),
    external_id: String(row.external_id),
    origin_event: sourceOriginEvent(row.origin_event),
    locator: nullableString(row.locator),
    title: String(row.title ?? ''),
    source_created_at: nullableDateString(row.source_created_at),
    source_updated_at: nullableDateString(row.source_updated_at),
    ingested_at: dateString(row.ingested_at),
    content_hash: String(row.content_hash),
    metadata_json: parseJsonRecord(row.metadata_json),
    raw_copy_mode: String(row.raw_copy_mode),
    raw_copy_ref: nullableString(row.raw_copy_ref),
    sensitivity_level: String(row.sensitivity_level ?? 'normal'),
    ingest_status: sourceItemStatus(row.ingest_status),
    retention_policy_id: nullableString(row.retention_policy_id),
  };
}

function mapSourceChunk(row: Record<string, unknown>): SourceChunkRecord {
  return {
    id: String(row.id),
    source_item_id: String(row.source_item_id),
    chunk_index: Number(row.chunk_index),
    chunk_hash: String(row.chunk_hash),
    chunk_text: String(row.chunk_text),
    redacted_text: String(row.redacted_text ?? ''),
    token_count: Number(row.token_count ?? 0),
    parser_version: String(row.parser_version),
    extractor_version: String(row.extractor_version ?? ''),
    sensitivity_flags: parseJsonArray(row.sensitivity_flags),
    prompt_injection_risk: promptInjectionRisk(row.prompt_injection_risk),
    secret_risk: secretRisk(row.secret_risk),
    created_at: dateString(row.created_at),
    expires_at: nullableDateString(row.expires_at),
  };
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function dateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function nullableDateString(value: unknown): string | null {
  if (value == null) return null;
  return dateString(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  if (isPlainObject(value)) return value as Record<string, unknown>;
  return {};
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function sourceOriginEvent(value: unknown): SourceItemRecord['origin_event'] {
  const raw = String(value);
  if (SOURCE_ORIGIN_EVENTS.includes(raw as SourceItemRecord['origin_event'])) {
    return raw as SourceItemRecord['origin_event'];
  }
  throw new Error(`stored source item has invalid origin_event: ${raw}`);
}

function sourceItemStatus(value: unknown): SourceItemRecord['ingest_status'] {
  const status = String(value);
  if (status === 'pending' || status === 'ready' || status === 'failed' || status === 'revoked' || status === 'purged') {
    return status;
  }
  throw new Error(`stored source item has invalid ingest_status: ${status}`);
}

function promptInjectionRisk(value: unknown): SourceChunkRecord['prompt_injection_risk'] {
  const risk = String(value);
  if (risk === 'none' || risk === 'flagged' || risk === 'quarantined') return risk;
  throw new Error(`stored source chunk has invalid prompt_injection_risk: ${risk}`);
}

function secretRisk(value: unknown): SourceChunkRecord['secret_risk'] {
  const risk = String(value);
  if (risk === 'none' || risk === 'flagged' || risk === 'detected' || risk === 'redacted') return risk;
  throw new Error(`stored source chunk has invalid secret_risk: ${risk}`);
}
