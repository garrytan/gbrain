/**
 * Read-time staleness for pinned answers. Nothing here trusts a write hook:
 * every read joins the answer's evidence pointers against the current rows,
 * so hard deletes, purges, cascades, `forget`, expiry by the clock alone,
 * supersession and visibility changes all surface on the next read with no
 * cycle run. A pointer that no longer resolves, or a sentence with no pointer
 * at all, is stale (fail closed).
 */
import type { BrainEngine } from '../engine.ts';
import type { AnswerSentence, PinRow } from './store.ts';

export type StaleReason =
  | 'page_missing' | 'page_deleted' | 'page_changed' | 'source_archived'
  | 'fact_missing' | 'fact_withdrawn' | 'fact_expired' | 'fact_superseded' | 'fact_changed' | 'fact_source_quarantined'
  | 'timeline_missing' | 'timeline_changed' | 'take_missing' | 'take_inactive' | 'take_changed'
  | 'owner_edited' | 'unverifiable';

/** Reasons that remove or contradict evidence: an incremental edit can't recover from them, so refresh recomputes. */
const FULL_RECOMPUTE_REASONS: ReadonlySet<StaleReason> = new Set([
  'page_missing', 'page_deleted', 'source_archived', 'fact_missing', 'fact_withdrawn', 'fact_expired',
  'fact_superseded', 'fact_changed', 'fact_source_quarantined', 'timeline_missing', 'take_missing', 'take_inactive', 'take_changed', 'unverifiable',
]);

export type EvidenceKind = 'page' | 'fact' | 'timeline' | 'take' | 'owner';

/**
 * Content hashes computed in SQL, identically at capture and at read. The statements of engine-sql/question-reads.ts
 * write them out; test/question-reads-sql-pin.test.ts pins that text to these fragments.
 */
export const FACT_HASH_SQL = (a: string) => `md5(${a}.fact || '|' || ${a}.visibility || '|' || COALESCE(${a}.entity_slug, '') || '|' || ${a}.kind)`;
export const TIMELINE_HASH_SQL = (a: string) => `md5(${a}.date::text || '|' || ${a}.summary || '|' || ${a}.detail)`;
/**
 * The owner-evidence change signal of a question page: md5 of its body, or its
 * content_hash once the body is segmented (no body column to hash; a stored
 * md5 never equals it, so the owner's claims read as edited).
 */
export const OWNER_BODY_HASH_SQL = (a: string) => `CASE WHEN ${a}.body_storage = 'segmented' THEN ${a}.content_hash ELSE md5(${a}.compiled_truth) END`;
export const TAKE_HASH_SQL = (a: string) => `md5(${a}.claim || '|' || ${a}.holder || '|' || COALESCE(${a}.weight::text, '') || '|' || COALESCE(${a}.resolved_outcome::text, ''))`;

export interface EvaluatedSentence extends AnswerSentence {
  stale: boolean;
  /** Not readable by this caller (evidence outside its source grant): never returned as text. */
  hidden: boolean;
  reasons: StaleReason[];
}

export interface AnswerEvaluation {
  sentences: EvaluatedSentence[];
  fresh: number;
  stale: number;
  hidden: number;
  /** A stale reason an incremental edit cannot repair (deletion, withdrawal, conflicting correction). */
  needsFull: boolean;
}

interface EvidenceJoinRow {
  sentence_id: string;
  kind: string;
  source_id: string;
  page_id: number | null;
  page_generation: string | number | null;
  page_revision: string | null;
  content_hash: string | null;
  p_id: number | null;
  p_generation: string | number | null;
  p_revision: string | null;
  p_deleted: unknown;
  p_source_archived: boolean | null;
  p_body_hash: string | null;
  f_id: string | number | null;
  f_expired: unknown;
  f_valid_until_passed: boolean | null;
  f_superseded: string | number | null;
  f_hash: string | null;
  f_source_quarantined: boolean | null;
  t_id: number | null;
  t_hash: string | null;
  k_id: string | number | null;
  k_active: boolean | null;
  k_superseded: number | null;
  k_hash: string | null;
}

function pageReasons(r: EvidenceJoinRow, changed: StaleReason): StaleReason[] {
  if (r.page_id === null) return [];
  if (r.p_id === null) return ['page_missing'];
  if (r.p_deleted !== null && r.p_deleted !== undefined) return ['page_deleted'];
  if (r.p_source_archived) return ['source_archived'];
  if (String(r.p_generation) !== String(r.page_generation) || (r.page_revision ?? null) !== (r.p_revision ?? null)) return [changed];
  return [];
}

export function evidenceReasons(r: EvidenceJoinRow): StaleReason[] {
  switch (r.kind as EvidenceKind) {
    case 'page': return r.page_id === null ? ['unverifiable'] : pageReasons(r, 'page_changed');
    case 'owner': {
      if (r.page_id === null) return ['unverifiable'];
      if (r.p_id === null) return ['page_missing'];
      if (r.p_deleted !== null && r.p_deleted !== undefined) return ['page_deleted'];
      return r.p_body_hash === r.content_hash ? [] : ['owner_edited'];
    }
    case 'fact': {
      if (r.f_id === null) return ['fact_missing'];
      if (r.f_expired !== null && r.f_expired !== undefined) return ['fact_withdrawn'];
      if (r.f_superseded !== null && r.f_superseded !== undefined) return ['fact_superseded'];
      if (r.f_valid_until_passed) return ['fact_expired'];
      if (r.f_hash !== r.content_hash) return ['fact_changed'];
      if (r.f_source_quarantined) return ['fact_source_quarantined'];
      return [];
    }
    case 'timeline': {
      if (r.t_id === null) return ['timeline_missing'];
      if (r.t_hash !== r.content_hash) return ['timeline_changed'];
      return pageReasons(r, 'page_changed');
    }
    case 'take': {
      if (r.k_id === null) return ['take_missing'];
      if (r.k_active === false || (r.k_superseded !== null && r.k_superseded !== undefined)) return ['take_inactive'];
      if (r.k_hash !== r.content_hash) return ['take_changed'];
      return pageReasons(r, 'page_changed');
    }
    default: return ['unverifiable'];
  }
}

/**
 * Evaluate the current answer for one reader. `readableSources` null means the
 * trusted local view (every source); otherwise a sentence citing evidence in a
 * source outside the list is hidden, never returned.
 */
export async function evaluateAnswer(
  engine: BrainEngine,
  pin: Pick<PinRow, 'id' | 'answer' | 'answer_revision'>,
  opts: { readableSources: string[] | null },
): Promise<AnswerEvaluation> {
  const rows = pin.answer.length === 0 ? [] : await engine.listQuestionEvidenceJoin(pin.id, pin.answer_revision) as unknown as EvidenceJoinRow[];
  const bySentence = new Map<string, EvidenceJoinRow[]>();
  for (const r of rows) bySentence.set(r.sentence_id, [...(bySentence.get(r.sentence_id) ?? []), r]);
  const sentences = pin.answer.map((s): EvaluatedSentence => {
    const evidence = bySentence.get(s.id) ?? [];
    const reasons = evidence.length === 0 ? ['unverifiable' as const] : [...new Set(evidence.flatMap(evidenceReasons))];
    const hidden = opts.readableSources !== null && evidence.some(e => !opts.readableSources!.includes(e.source_id));
    return { ...s, stale: reasons.length > 0, hidden, reasons };
  });
  return {
    sentences,
    fresh: sentences.filter(s => !s.stale && !s.hidden).length,
    stale: sentences.filter(s => s.stale && !s.hidden).length,
    hidden: sentences.filter(s => s.hidden).length,
    needsFull: sentences.some(s => s.reasons.some(r => FULL_RECOMPUTE_REASONS.has(r))),
  };
}

/**
 * Evidence written in the pin's scope after its watermark (new pages or
 * edits by the global page-generation clock, new fact rows). Informational:
 * it schedules a refresh but never marks a cited sentence stale.
 */
export async function newEvidenceSinceWatermark(engine: BrainEngine, pin: PinRow): Promise<boolean> {
  if (pin.answer_revision === 0 || pin.watermark_generation === null) return false;
  if (await engine.hasNewQuestionPages(pin.source_id, pin.watermark_generation, pin.scope_slug_prefix || null)) return true;
  if (pin.watermark_fact_id === null) return false;
  return engine.hasNewQuestionFacts(pin.source_id, pin.watermark_fact_id, pin.scope_entity || null);
}
