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
import { quarantinedProvenanceFilterFragment } from '../quarantine.ts';

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

/** Content hashes computed in SQL, identically at capture and at read. */
export const FACT_HASH_SQL = (a: string) => `md5(${a}.fact || '|' || ${a}.visibility || '|' || COALESCE(${a}.entity_slug, '') || '|' || ${a}.kind)`;
export const TIMELINE_HASH_SQL = (a: string) => `md5(${a}.date::text || '|' || ${a}.summary || '|' || ${a}.detail)`;
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
  const rows = pin.answer.length === 0 ? [] : await engine.executeRaw<EvidenceJoinRow>(
    `SELECT e.sentence_id, e.kind, e.source_id, e.page_id, e.page_generation, e.page_revision, e.content_hash,
       p.id AS p_id, p.generation AS p_generation, p.knowledge_revision::text AS p_revision, p.deleted_at AS p_deleted,
       s.archived AS p_source_archived, md5(p.compiled_truth) AS p_body_hash,
       f.id AS f_id, f.expired_at AS f_expired, (f.valid_until IS NOT NULL AND f.valid_until <= now()) AS f_valid_until_passed,
       f.superseded_by AS f_superseded, ${FACT_HASH_SQL('f')} AS f_hash,
       (f.id IS NOT NULL AND NOT ${quarantinedProvenanceFilterFragment('f')}) AS f_source_quarantined,
       t.id AS t_id, ${TIMELINE_HASH_SQL('t')} AS t_hash,
       k.id AS k_id, k.active AS k_active, k.superseded_by AS k_superseded, ${TAKE_HASH_SQL('k')} AS k_hash
     FROM question_evidence e
     LEFT JOIN pages p ON p.id = e.page_id
     LEFT JOIN sources s ON s.id = p.source_id
     LEFT JOIN facts f ON e.kind = 'fact' AND f.id = e.item_id AND f.source_id = e.source_id
     LEFT JOIN timeline_entries t ON e.kind = 'timeline' AND t.id = e.item_id
     LEFT JOIN takes k ON e.kind = 'take' AND k.id = e.item_id
     WHERE e.question_id = $1 AND e.answer_revision = $2`,
    [pin.id, pin.answer_revision]);
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
  const params: unknown[] = [pin.source_id, pin.watermark_generation];
  let prefix = '';
  if (pin.scope_slug_prefix) { params.push(`${pin.scope_slug_prefix.replace(/[\\%_]/g, '\\$&')}%`); prefix = `AND p.slug LIKE $${params.length}`; }
  const [pageHit] = await engine.executeRaw<{ hit: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.generation > $2 AND p.deleted_at IS NULL
       AND p.type NOT IN ('question', 'synthesis') AND NOT (p.frontmatter ? 'pinned_question') ${prefix}) AS hit`, params);
  if (pageHit?.hit) return true;
  if (pin.watermark_fact_id === null) return false;
  const [factHit] = await engine.executeRaw<{ hit: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM facts f WHERE f.source_id = $1 AND f.id > $2 AND f.expired_at IS NULL
       ${pin.scope_entity ? 'AND f.entity_slug = $3' : ''}) AS hit`,
    pin.scope_entity ? [pin.source_id, pin.watermark_fact_id, pin.scope_entity] : [pin.source_id, pin.watermark_fact_id]);
  return factHit?.hit === true;
}
