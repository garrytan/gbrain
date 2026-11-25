/**
 * Pinned-question rows: reads, idempotent pin, state changes and the durable
 * refresh lease. The rows are the typed pin members of the engine: the insert and the two reads are
 * engine-sql/pinned-questions.ts, the locked read, the state change, the lease and the spend are engine-sql/question-store.ts
 * (PGLite and Postgres), and a Rust brain keeps them all in jobs/pinned_questions.rs. `toPinRow` normalizes the rows. The
 * pinned_questions table is not a canonical-writer table, so no coordinator capability is needed; the question page
 * itself is written by ./pages.ts through the coordinator.
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
  const row = opts.forUpdate ? await engine.readPinnedQuestionForUpdate(sourceId, slug) : await engine.readPinnedQuestion(sourceId, slug);
  return row ? toPinRow(row) : null;
}

export async function listPins(engine: BrainEngine, opts: { sourceIds?: string[]; includeArchived?: boolean; states?: PinState[] } = {}): Promise<PinRow[]> {
  // One constant statement per filter combination (engine-sql/pinned-questions.ts PINNED_QUESTION_SQL).
  const rows = await engine.listPinnedQuestions({
    ...(opts.sourceIds ? { sourceIds: opts.sourceIds } : {}), ...(opts.states ? { states: opts.states } : {}), includeArchived: opts.includeArchived === true,
  });
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
  const inserted = await engine.insertPinnedQuestion({
    sourceId: p.sourceId, slug: p.slug, question: p.question, scopeSlugPrefix: p.scope.slug_prefix ?? null, scopeEntity: p.scope.entity ?? null,
    state: p.state, inactiveReason: p.inactiveReason, publishMode: p.publishMode, createdBy: p.createdBy,
  });
  if (inserted) return { row: toPinRow(inserted), created: true };
  return { row: (await getPin(engine, p.sourceId, p.slug))!, created: false };
}

/** State change that bumps the pin revision, so an in-flight refresh revalidating at commit sees it. */
export async function updatePinState(engine: BrainEngine, id: number, patch: {
  state?: PinState; inactiveReason?: InactiveReason | null; publishMode?: PublishMode;
}): Promise<PinRow> {
  const row = await engine.updatePinRowState(id, {
    state: patch.state ?? null, setInactiveReason: patch.inactiveReason !== undefined, inactiveReason: patch.inactiveReason ?? null,
    publishMode: patch.publishMode ?? null,
  });
  return toPinRow((row ?? undefined)!);
}

/**
 * Durable refresh lease. A second worker (or a duplicate cycle) gets null
 * while a live lease exists; an expired lease (a crashed worker) is taken over.
 */
export async function acquireLease(engine: BrainEngine, id: number, token: string, owner: string, ttlMs: number): Promise<PinRow | null> {
  const row = await engine.acquirePinLease(id, token, owner, ttlMs);
  return row ? toPinRow(row) : null;
}

/** Ends a refresh attempt without publishing: keeps the previous answer, records the cause and spend. */
export async function releaseLease(engine: BrainEngine, id: number, token: string, outcome: { error: string | null; spendUsd: number }): Promise<void> {
  await engine.releasePinLease(id, token, outcome.error, outcome.spendUsd);
}

export async function addSpend(engine: BrainEngine, id: number, usd: number): Promise<void> {
  if (usd <= 0) return;
  await engine.addPinSpend(id, usd);
}
