/**
 * The pinned-question statements questions/store.ts ran through executeRaw (the insert, the read of one pin and the
 * listing), as typed members: PGLite and Postgres send the same text as before, and a Rust brain answers from its store
 * (rust/docs/store/pinned-questions.md). The listing was composed from its filters; each composition is one constant
 * here, so the text is unchanged byte for byte.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** A `pinned_questions` row as the statements return it (questions/store.ts toPinRow reads it). */
export type PinnedQuestionRow = Record<string, unknown>;

/** The pin a caller adds: the columns `insertPin` writes; the rest take the table's defaults. */
export interface PinnedQuestionInsert {
  sourceId: string;
  slug: string;
  question: string;
  scopeSlugPrefix: string | null;
  scopeEntity: string | null;
  state: string;
  inactiveReason: string | null;
  publishMode: string;
  createdBy: string;
}

/** What `listPinnedQuestions` keeps: the sources and states named, or (no states) every state but `archived` unless `includeArchived`. */
export interface PinnedQuestionFilter {
  sourceIds?: string[];
  states?: string[];
  includeArchived?: boolean;
}


/**
 * The statements questions/store.ts insertPin, getPin and listPins ran (one listing per filter combination), each
 * with the column list written out (questions/store.ts COLUMNS).
 */
export const PINNED_QUESTION_SQL = {
  insert: `INSERT INTO pinned_questions (source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_id, slug) DO NOTHING RETURNING id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at`,
  read: `SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE source_id = $1 AND slug = $2`,
  list_all: `SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions  ORDER BY source_id COLLATE "C", created_at, id`,
  list_unarchived: `SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE state <> 'archived' ORDER BY source_id COLLATE "C", created_at, id`,
  list_states: `SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE state = ANY($1::text[]) ORDER BY source_id COLLATE "C", created_at, id`,
  list_sources: `SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE source_id = ANY($1::text[]) ORDER BY source_id COLLATE "C", created_at, id`,
  list_sources_unarchived: `SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE source_id = ANY($1::text[]) AND state <> 'archived' ORDER BY source_id COLLATE "C", created_at, id`,
  list_sources_states: `SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE source_id = ANY($1::text[]) AND state = ANY($2::text[]) ORDER BY source_id COLLATE "C", created_at, id`,
} as const;

/** `INSERT` one pin; its row, or null when `(source_id, slug)` already has one. A failure is thrown unchanged. */
export async function insertPinnedQuestion(tx: Raw, p: PinnedQuestionInsert): Promise<PinnedQuestionRow | null> {
  const rows = await tx.executeRaw<PinnedQuestionRow>(PINNED_QUESTION_SQL.insert,
    [p.sourceId, p.slug, p.question, p.scopeSlugPrefix, p.scopeEntity, p.state, p.inactiveReason, p.publishMode, p.createdBy]);
  return rows[0] ?? null;
}

/** The row of one pin, or null. */
export async function readPinnedQuestion(tx: Raw, sourceId: string, slug: string): Promise<PinnedQuestionRow | null> {
  return (await tx.executeRaw<PinnedQuestionRow>(PINNED_QUESTION_SQL.read, [sourceId, slug]))[0] ?? null;
}

/** The pins that pass the filter, by source id in byte order, then by creation time, then by id. */
export function listPinnedQuestions(tx: Raw, filter: PinnedQuestionFilter): Promise<PinnedQuestionRow[]> {
  const { sourceIds, states } = filter;
  if (sourceIds) {
    if (states) return tx.executeRaw<PinnedQuestionRow>(PINNED_QUESTION_SQL.list_sources_states, [sourceIds, states]);
    return filter.includeArchived
      ? tx.executeRaw<PinnedQuestionRow>(PINNED_QUESTION_SQL.list_sources, [sourceIds])
      : tx.executeRaw<PinnedQuestionRow>(PINNED_QUESTION_SQL.list_sources_unarchived, [sourceIds]);
  }
  if (states) return tx.executeRaw<PinnedQuestionRow>(PINNED_QUESTION_SQL.list_states, [states]);
  return filter.includeArchived
    ? tx.executeRaw<PinnedQuestionRow>(PINNED_QUESTION_SQL.list_all, [])
    : tx.executeRaw<PinnedQuestionRow>(PINNED_QUESTION_SQL.list_unarchived, []);
}
