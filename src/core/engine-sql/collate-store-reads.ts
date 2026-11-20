/**
 * Reads and writes of the decision, OAuth, feedback, question and credential tables that callers once ran through
 * `executeRaw`, as typed members: SQL once for both SQL engines, so a store that is not SQL serves the same members
 * (rust/docs/store). Each statement keeps the text its caller ran, and each listing breaks ties by byte
 * (`COLLATE "C"`), as the Rust store does.
 */
import type { BrainEngine } from '../engine.ts';
import { isMissingSchemaObject } from '../utils.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One OAuth client that references a source through `oauth_clients.source_id`; `deleted` marks a soft-deleted row. */
export interface SourceClientReferentRow {
  clientId: string;
  clientName: string;
  deleted: boolean;
}

/** The statements destructive-guard.ts clientsReferencingSource ran through executeRaw: the whole read, then the read of a brain without `deleted_at`. */
export const CLIENTS_REFERENCING_SOURCE_SQL = {
  primary: `SELECT client_id, client_name, (deleted_at IS NOT NULL) AS deleted
       FROM oauth_clients
       WHERE source_id = $1
       ORDER BY client_id COLLATE "C"`,
  without_deleted_at: `SELECT client_id, client_name FROM oauth_clients
         WHERE source_id = $1
         ORDER BY client_id COLLATE "C"`,
} as const;

/**
 * Every OAuth client that references `sourceId`, by client id in byte order. The reference is PHYSICAL (ON DELETE
 * RESTRICT), so soft-deleted rows are returned too, tagged `deleted`. A brain without the `oauth_clients` table, or
 * without its `source_id` column, has no referents (no column, no foreign key); a brain without `deleted_at` reads every
 * referent as live. Any other failure is thrown unchanged.
 */
export async function listClientsReferencingSource(tx: Raw, sourceId: string): Promise<SourceClientReferentRow[]> {
  try {
    const rows = await tx.executeRaw<{ client_id: string; client_name: string; deleted: boolean }>(CLIENTS_REFERENCING_SOURCE_SQL.primary, [sourceId]);
    return rows.map((r) => ({ clientId: r.client_id, clientName: r.client_name, deleted: r.deleted === true }));
  } catch (e) {
    if (isMissingSchemaObject(e, 'table', 'oauth_clients')) return [];
    // The primary query references BOTH optional columns; the strict predicate tells them apart by the column the error names.
    if (isMissingSchemaObject(e, 'column', 'source_id')) return [];
    if (!isMissingSchemaObject(e, 'column', 'deleted_at')) throw e;
    try {
      const rows = await tx.executeRaw<{ client_id: string; client_name: string }>(CLIENTS_REFERENCING_SOURCE_SQL.without_deleted_at, [sourceId]);
      return rows.map((r) => ({ clientId: r.client_id, clientName: r.client_name, deleted: false }));
    } catch (e2) {
      // The fallback's only optional column is source_id: no column, no foreign key.
      if (isMissingSchemaObject(e2, 'column', 'source_id')) return [];
      throw e2;
    }
  }
}

/** One live credential bound to a member: `kind` is `client` or `token`, `row` the grant columns of its table as JSON. */
export interface OwnerCredentialRow {
  kind: 'client' | 'token';
  id: string;
  name: string;
  row: unknown;
}

/** The statement guests/owner-credentials.ts ownerCredentials ran through executeRaw (a token row carries its grant columns and read floor, never the token hash). */
export const OWNER_CREDENTIALS_SQL = `SELECT * FROM (SELECT 'token' AS kind, t.id::text AS id, t.name, jsonb_build_object('id', t.id, 'scopes', t.scopes, 'permissions', t.permissions, 'private_pages', t.private_pages, 'private_facts', t.private_facts, 'grant_revision', t.grant_revision, 'source_grant', t.source_grant, 'source_id', t.source_id, 'federated_read', t.federated_read, 'allowed_operations', t.allowed_operations, 'takes_holders', t.takes_holders, 'min_trust', t.min_trust) AS row FROM access_tokens t WHERE t.member_id = $1 AND t.revoked_at IS NULL UNION ALL SELECT 'client' AS kind, c.client_id AS id, COALESCE(c.client_name, c.client_id) AS name, to_jsonb(c) - 'client_secret_hash' AS row FROM oauth_clients c WHERE c.member_id = $1 AND (to_jsonb(c)->>'deleted_at') IS NULL) q ORDER BY kind COLLATE "C", name COLLATE "C", id COLLATE "C"`;

/**
 * Every live credential (an access token not revoked, an OAuth client not deleted) bound to `memberId`: clients before tokens,
 * then by name, then by id in byte order. A client row is the whole row less its secret hash.
 */
export async function readOwnerCredentials(tx: Raw, memberId: string): Promise<OwnerCredentialRow[]> {
  return tx.executeRaw<OwnerCredentialRow>(OWNER_CREDENTIALS_SQL, [memberId]);
}

/** One `pinned_questions` row as the SQL engines return it (times as `Date` or ISO text; `answer` is JSON text). */
export type PinnedQuestionRow = Record<string, unknown>;

/** The pin a caller adds: the columns `insertPin` writes. */
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
 * The statements questions/store.ts insertPin, getPin and listPins ran through executeRaw. The listing was composed from
 * its filters; it is one statement here, each filter a parameter that is NULL when not given (the same rows, the same order).
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
  list: `SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions
   WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[]))
     AND ($2::text[] IS NULL OR state = ANY($2::text[]))
     AND ($3::boolean OR $2::text[] IS NOT NULL OR state <> 'archived')
   ORDER BY source_id COLLATE "C", created_at, id`,
} as const;

/** `INSERT` one pin; its row, or null when `(source_id, slug)` already has one. */
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
export async function listPinnedQuestions(tx: Raw, filter: PinnedQuestionFilter): Promise<PinnedQuestionRow[]> {
  return tx.executeRaw<PinnedQuestionRow>(PINNED_QUESTION_SQL.list, [filter.sourceIds ?? null, filter.states ?? null, filter.includeArchived === true]);
}
