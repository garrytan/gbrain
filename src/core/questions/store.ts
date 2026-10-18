/**
 * Pinned-question rows: reads, idempotent pin, state changes and the durable
 * refresh lease. SQL runs through `engine.executeRaw` on the pinned_questions
 * table (not a canonical-writer table, so no coordinator capability is needed);
 * the question page itself is written by ./pages.ts through the coordinator.
 */
import type { BrainEngine } from '../engine.ts';
import { formatQuestionId, type QuestionScope } from './identity.ts';

export type PinState = 'active' | 'inactive' | 'archived';
export type InactiveReason = 'awaiting_consent' | 'migrated_disabled' | 'migrated_zero_budget' | 'migrated_enabled';
export type PublishMode = 'publish' | 'draft';
export type SentenceOrigin = 'model' | 'owner';

export interface AnswerSentence {
  id: string;
  text: string;
  origin: SentenceOrigin;
}

export interface PinRow {
  id: number;
  source_id: string;
  slug: string;
  question: string;
  scope_slug_prefix: string | null;
  scope_entity: string | null;
  state: PinState;
  inactive_reason: InactiveReason | null;
  publish_mode: PublishMode;
  model: string | null;
  cooldown_days: number | null;
  origin: string;
  created_by: string;
  revision: number;
  answer_revision: number;
  answer: AnswerSentence[];
  answer_model: string | null;
  last_refresh_at: Date | null;
  last_attempt_at: Date | null;
  last_error: string | null;
  watermark_generation: number | null;
  watermark_fact_id: number | null;
  watermark_at: Date | null;
  lease_token: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  refresh_attempts: number;
  spend_usd: number;
  created_at: Date;
  archived_at: Date | null;
}

const COLUMNS = `id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at`;

const date = (v: unknown): Date | null => v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v));
const num = (v: unknown): number | null => v === null || v === undefined ? null : Number(v);

export function parseAnswer(raw: unknown): AnswerSentence[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is AnswerSentence => s && typeof s.id === 'string' && typeof s.text === 'string'
      && (s.origin === 'model' || s.origin === 'owner'));
  } catch {
    return [];
  }
}

export function toPinRow(r: Record<string, unknown>): PinRow {
  return {
    id: Number(r.id), source_id: String(r.source_id), slug: String(r.slug), question: String(r.question),
    scope_slug_prefix: (r.scope_slug_prefix as string | null) ?? null, scope_entity: (r.scope_entity as string | null) ?? null,
    state: r.state as PinState, inactive_reason: (r.inactive_reason as InactiveReason | null) ?? null,
    publish_mode: r.publish_mode === 'draft' ? 'draft' : 'publish', model: (r.model as string | null) ?? null,
    cooldown_days: num(r.cooldown_days), origin: String(r.origin), created_by: String(r.created_by),
    revision: Number(r.revision), answer_revision: Number(r.answer_revision), answer: parseAnswer(r.answer),
    answer_model: (r.answer_model as string | null) ?? null, last_refresh_at: date(r.last_refresh_at),
    last_attempt_at: date(r.last_attempt_at), last_error: (r.last_error as string | null) ?? null,
    watermark_generation: num(r.watermark_generation), watermark_fact_id: num(r.watermark_fact_id), watermark_at: date(r.watermark_at),
    lease_token: (r.lease_token as string | null) ?? null, lease_owner: (r.lease_owner as string | null) ?? null,
    lease_expires_at: date(r.lease_expires_at), refresh_attempts: Number(r.refresh_attempts ?? 0),
    spend_usd: Number(r.spend_usd ?? 0), created_at: date(r.created_at)!, archived_at: date(r.archived_at),
  };
}

export function pinId(row: Pick<PinRow, 'source_id' | 'slug'>): string {
  return formatQuestionId(row.source_id, row.slug);
}

export function pinScope(row: Pick<PinRow, 'source_id' | 'scope_slug_prefix' | 'scope_entity'>): QuestionScope {
  return {
    source: row.source_id,
    ...(row.scope_slug_prefix ? { slug_prefix: row.scope_slug_prefix } : {}),
    ...(row.scope_entity ? { entity: row.scope_entity } : {}),
  };
}

export async function getPin(engine: BrainEngine, sourceId: string, slug: string, opts: { forUpdate?: boolean } = {}): Promise<PinRow | null> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM pinned_questions WHERE source_id = $1 AND slug = $2${opts.forUpdate ? ' FOR UPDATE' : ''}`, [sourceId, slug]);
  return rows[0] ? toPinRow(rows[0]) : null;
}

export async function listPins(engine: BrainEngine, opts: { sourceIds?: string[]; includeArchived?: boolean; states?: PinState[] } = {}): Promise<PinRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.sourceIds) { params.push(opts.sourceIds); where.push(`source_id = ANY($${params.length}::text[])`); }
  if (opts.states) { params.push(opts.states); where.push(`state = ANY($${params.length}::text[])`); }
  else if (!opts.includeArchived) where.push(`state <> 'archived'`);
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM pinned_questions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY source_id, created_at, id`, params);
  return rows.map(toPinRow);
}

export interface PinInsert {
  sourceId: string;
  slug: string;
  question: string;
  scope: QuestionScope;
  state: PinState;
  inactiveReason: InactiveReason | null;
  publishMode: PublishMode;
  createdBy: string;
}

/** Idempotent insert keyed on (source_id, slug). Returns the row and whether it was created. */
export async function insertPin(engine: BrainEngine, p: PinInsert): Promise<{ row: PinRow; created: boolean }> {
  const inserted = await engine.executeRaw<Record<string, unknown>>(
    `INSERT INTO pinned_questions (source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_id, slug) DO NOTHING RETURNING ${COLUMNS}`,
    [p.sourceId, p.slug, p.question, p.scope.slug_prefix ?? null, p.scope.entity ?? null, p.state, p.inactiveReason, p.publishMode, p.createdBy]);
  if (inserted[0]) return { row: toPinRow(inserted[0]), created: true };
  return { row: (await getPin(engine, p.sourceId, p.slug))!, created: false };
}

/** State change that bumps the pin revision, so an in-flight refresh revalidating at commit sees it. */
export async function updatePinState(engine: BrainEngine, id: number, patch: {
  state?: PinState; inactiveReason?: InactiveReason | null; publishMode?: PublishMode;
}): Promise<PinRow> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `UPDATE pinned_questions SET
       state = COALESCE($2, state),
       inactive_reason = CASE WHEN $3::boolean THEN $4 ELSE inactive_reason END,
       publish_mode = COALESCE($5, publish_mode),
       archived_at = CASE WHEN COALESCE($2, state) = 'archived' THEN COALESCE(archived_at, now()) ELSE NULL END,
       lease_token = CASE WHEN COALESCE($2, state) = 'archived' THEN NULL ELSE lease_token END,
       lease_expires_at = CASE WHEN COALESCE($2, state) = 'archived' THEN NULL ELSE lease_expires_at END,
       revision = revision + 1, updated_at = now()
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, patch.state ?? null, patch.inactiveReason !== undefined, patch.inactiveReason ?? null, patch.publishMode ?? null]);
  return toPinRow(rows[0]!);
}

/**
 * Durable refresh lease. A second worker (or a duplicate cycle) gets null
 * while a live lease exists; an expired lease (a crashed worker) is taken over.
 */
export async function acquireLease(engine: BrainEngine, id: number, token: string, owner: string, ttlMs: number): Promise<PinRow | null> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `UPDATE pinned_questions SET lease_token = $2, lease_owner = $3,
       lease_expires_at = now() + ($4::double precision * interval '1 millisecond'),
       last_attempt_at = now(), refresh_attempts = refresh_attempts + 1
     WHERE id = $1 AND state <> 'archived' AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
     RETURNING ${COLUMNS}`, [id, token, owner, ttlMs]);
  return rows[0] ? toPinRow(rows[0]) : null;
}

/** Ends a refresh attempt without publishing: keeps the previous answer, records the cause and spend. */
export async function releaseLease(engine: BrainEngine, id: number, token: string, outcome: { error: string | null; spendUsd: number }): Promise<void> {
  await engine.executeRaw(
    `UPDATE pinned_questions SET lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
       last_error = $3, spend_usd = spend_usd + $4, updated_at = now()
     WHERE id = $1 AND lease_token = $2`, [id, token, outcome.error, outcome.spendUsd]);
}

export async function addSpend(engine: BrainEngine, id: number, usd: number): Promise<void> {
  if (usd > 0) await engine.executeRaw('UPDATE pinned_questions SET spend_usd = spend_usd + $2 WHERE id = $1', [id, usd]);
}
