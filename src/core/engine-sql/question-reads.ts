/**
 * The reads of pinned questions (src/core/questions/): evidence retrieval (refresh.ts; its slug-prefix anchor is
 * readPrefixAnchoredPages, engine-sql/entity-reads.ts), the question page row (pages.ts), the freshness reads (freshness.ts), the refresh clock and
 * the publication's revalidation reads. One implementation for both SQL engines; the Rust store serves the members that
 * read no `pages.generation` and no pin record (src/core/rust-engine/store-members/question-reads.ts), and refuses the
 * others by name until it keeps a page generation counter and the pin records (rust-engine/question-stops.ts).
 *
 * Each statement is the text the caller sent through `executeRaw`, byte for byte (test/question-reads-sql-pin.test.ts),
 * with its fragments (quarantine, projection eligibility, evidence hashes) written out. Ids, generations and the fact id
 * read back as numbers (the callers read them through Number()); every other column is returned as the driver reads it.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** A page the evidence read may cite. */
export interface QuestionCandidatePage { id: number; slug: string; source_id: string; generation: number; revision: string | null; type: string; compiled_truth: string; marker: boolean; updated_at: Date | string }
/** A published answer of a pin of the source, with the pages its current revision cites. */
export interface PublishedQuestionAnswer { answer: string; published_at: Date | string; cited: number[] }
/** A live fact about one of the evidence pages. */
export interface QuestionEvidenceFact { id: number; fact: string; entity_slug: string | null; valid_from: unknown; hash: string }
/** A timeline entry of an evidence page. */
export interface QuestionEvidenceTimeline { id: number; date: unknown; summary: string; detail: string; page_id: number; slug: string; generation: number; revision: string | null; hash: string }
/** An active take of an evidence page. */
export interface QuestionEvidenceTake { id: number; claim: string; holder: string; weight: number | null; page_id: number; slug: string; generation: number; revision: string | null; hash: string }
/** The question page itself. */
export interface QuestionPageRow { id: number; generation: number; revision: string | null; compiled_truth: string; archived: boolean; body_storage: string }
/** The refresh clock: the highest page generation and the highest fact id of the source. */
export interface QuestionEvidenceClock { generation: number; fact_id: number }
/** One cited evidence row of an answer revision, joined to the row it cites. */
export type QuestionEvidenceJoinRow = Record<string, unknown>;
/** The evidence row kinds a publication locks and rereads. */
export type QuestionEvidenceLockKind = 'page' | 'fact' | 'timeline' | 'take';

const CANDIDATES_SQL = `SELECT id, slug, source_id, generation, knowledge_revision::text AS revision, type, compiled_truth, updated_at,
       (frontmatter ? 'pinned_question') AS marker
     FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL AND body_storage = 'inline'
       AND NOT (COALESCE(pages.frontmatter, '{}'::jsonb) ? 'quarantine')`;
const PUBLISHED_SQL = `SELECT q.answer, q.last_refresh_at AS published_at,
       COALESCE(array_agg(e.page_id) FILTER (WHERE e.page_id IS NOT NULL), ARRAY[]::integer[]) AS cited
     FROM pinned_questions q LEFT JOIN question_evidence e ON e.question_id = q.id AND e.answer_revision = q.answer_revision
     WHERE q.source_id = $1 AND q.answer IS NOT NULL GROUP BY q.id, q.answer, q.last_refresh_at`;
const FACTS_SQL = `SELECT f.id, f.fact, f.entity_slug, f.valid_from, md5(f.fact || '|' || f.visibility || '|' || COALESCE(f.entity_slug, '') || '|' || f.kind) AS hash FROM facts f
       WHERE f.source_id = $1 AND f.entity_slug = ANY($2::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL
         AND (f.valid_until IS NULL OR f.valid_until > now()) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine'))
         AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text)
         AND NOT EXISTS (SELECT 1 FROM pages fp WHERE fp.source_id = f.source_id AND fp.slug = f.source_markdown_slug
           AND (fp.type IN ('question', 'synthesis') OR fp.frontmatter ? 'pinned_question'))
       ORDER BY (CASE WHEN f.valid_from IS NULL OR f.valid_from > now() THEN f.created_at ELSE f.valid_from END) DESC, f.id DESC LIMIT 30`;
const TIMELINE_SQL = `SELECT t.id, t.date, t.summary, t.detail, p.id AS page_id, p.slug, p.generation, p.knowledge_revision::text AS revision, md5(t.date::text || '|' || t.summary || '|' || t.detail) AS hash
       FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.id = ANY($1::integer[]) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.id = t.page_id AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.id = t.page_id AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'timeline_entries' AND elig_nr.derived_id = t.id::text) ORDER BY t.date DESC, t.id DESC LIMIT 20`;
const TAKES_SQL = `SELECT k.id, k.claim, k.holder, k.weight, p.id AS page_id, p.slug, p.generation, p.knowledge_revision::text AS revision, md5(k.claim || '|' || k.holder || '|' || COALESCE(k.weight::text, '') || '|' || COALESCE(k.resolved_outcome::text, '')) AS hash
       FROM takes k JOIN pages p ON p.id = k.page_id WHERE p.id = ANY($1::integer[]) AND k.active AND k.superseded_by IS NULL
         AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.id = k.page_id AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.id = k.page_id AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'takes' AND elig_nr.derived_id = k.id::text)
       ORDER BY k.id DESC LIMIT 20`;
const CLOCK_SQL = `SELECT (SELECT COALESCE(MAX(generation), 0) FROM pages) AS generation,
              (SELECT COALESCE(MAX(id), 0) FROM facts WHERE source_id = $1) AS fact_id`;
const QUESTION_PAGE_SQL = `SELECT id, generation, knowledge_revision::text AS revision, compiled_truth, body_storage,
       COALESCE(frontmatter->>'status', '') = 'archived' AS archived
     FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`;
const EVIDENCE_JOIN_SQL = `SELECT e.sentence_id, e.kind, e.source_id, e.page_id, e.page_generation, e.page_revision, e.content_hash,
       p.id AS p_id, p.generation AS p_generation, p.knowledge_revision::text AS p_revision, p.deleted_at AS p_deleted,
       s.archived AS p_source_archived, CASE WHEN p.body_storage = 'segmented' THEN p.content_hash ELSE md5(p.compiled_truth) END AS p_body_hash,
       f.id AS f_id, f.expired_at AS f_expired, (f.valid_until IS NOT NULL AND f.valid_until <= now()) AS f_valid_until_passed,
       f.superseded_by AS f_superseded, md5(f.fact || '|' || f.visibility || '|' || COALESCE(f.entity_slug, '') || '|' || f.kind) AS f_hash,
       (f.id IS NOT NULL AND NOT NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine'))) AS f_source_quarantined,
       t.id AS t_id, md5(t.date::text || '|' || t.summary || '|' || t.detail) AS t_hash,
       k.id AS k_id, k.active AS k_active, k.superseded_by AS k_superseded, md5(k.claim || '|' || k.holder || '|' || COALESCE(k.weight::text, '') || '|' || COALESCE(k.resolved_outcome::text, '')) AS k_hash
     FROM question_evidence e
     LEFT JOIN pages p ON p.id = e.page_id
     LEFT JOIN sources s ON s.id = p.source_id
     LEFT JOIN facts f ON e.kind = 'fact' AND f.id = e.item_id AND f.source_id = e.source_id
     LEFT JOIN timeline_entries t ON e.kind = 'timeline' AND t.id = e.item_id
     LEFT JOIN takes k ON e.kind = 'take' AND k.id = e.item_id
     WHERE e.question_id = $1 AND e.answer_revision = $2`;
const NEW_PAGES_SQL = `SELECT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.generation > $2 AND p.deleted_at IS NULL
       AND p.type NOT IN ('question', 'synthesis') AND NOT (p.frontmatter ? 'pinned_question') ) AS hit`;
const NEW_PAGES_PREFIX_SQL = `SELECT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.generation > $2 AND p.deleted_at IS NULL
       AND p.type NOT IN ('question', 'synthesis') AND NOT (p.frontmatter ? 'pinned_question') AND p.slug LIKE $3) AS hit`;
const NEW_FACTS_SQL = `SELECT EXISTS (SELECT 1 FROM facts f WHERE f.source_id = $1 AND f.id > $2 AND f.expired_at IS NULL
       ) AS hit`;
const NEW_FACTS_ENTITY_SQL = `SELECT EXISTS (SELECT 1 FROM facts f WHERE f.source_id = $1 AND f.id > $2 AND f.expired_at IS NULL
       AND f.entity_slug = $3) AS hit`;
const LOCK_PAGES_SQL = `SELECT id, generation, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted, CASE WHEN pages.body_storage = 'segmented' THEN pages.content_hash ELSE md5(pages.compiled_truth) END AS body
       FROM pages WHERE id = ANY($1::integer[]) FOR SHARE`;
const LOCK_FACTS_SQL = `SELECT id, (expired_at IS NULL AND superseded_by IS NULL AND (valid_until IS NULL OR valid_until > now())) AS ok,
      md5(facts.fact || '|' || facts.visibility || '|' || COALESCE(facts.entity_slug, '') || '|' || facts.kind) AS hash FROM facts WHERE id = ANY($1::bigint[]) FOR SHARE`;
const LOCK_TIMELINE_SQL = `SELECT id, true AS ok, md5(timeline_entries.date::text || '|' || timeline_entries.summary || '|' || timeline_entries.detail) AS hash FROM timeline_entries WHERE id = ANY($1::integer[]) FOR SHARE`;
const LOCK_TAKES_SQL = `SELECT id, (active AND superseded_by IS NULL) AS ok, md5(takes.claim || '|' || takes.holder || '|' || COALESCE(takes.weight::text, '') || '|' || COALESCE(takes.resolved_outcome::text, '')) AS hash FROM takes WHERE id = ANY($1::bigint[]) FOR SHARE`;

const num = (v: unknown): number => Number(v);

/** The live inline pages of `sourceId` with these slugs that no quarantine marks, in no set order. */
export async function listQuestionCandidatePages(raw: EngineRawRead, sourceId: string, slugs: readonly string[]): Promise<QuestionCandidatePage[]> {
  return (await raw<QuestionCandidatePage>(CANDIDATES_SQL, [sourceId, [...slugs]])).map(r => ({ ...r, id: num(r.id), generation: num(r.generation) }));
}

/** Every published answer of the source's pins, with the page ids its current revision cites. */
export function listPublishedQuestionAnswers(raw: EngineRawRead, sourceId: string): Promise<PublishedQuestionAnswer[]> {
  return raw<PublishedQuestionAnswer>(PUBLISHED_SQL, [sourceId]);
}

/** The live, eligible facts about these entities, newest first, at most 30. */
export async function listQuestionEvidenceFacts(raw: EngineRawRead, sourceId: string, entitySlugs: readonly string[]): Promise<QuestionEvidenceFact[]> {
  return (await raw<QuestionEvidenceFact>(FACTS_SQL, [sourceId, [...entitySlugs]])).map(r => ({ ...r, id: num(r.id) }));
}

/** The eligible timeline entries of these pages, newest first, at most 20. */
export async function listQuestionEvidenceTimeline(raw: EngineRawRead, pageIds: readonly number[]): Promise<QuestionEvidenceTimeline[]> {
  return (await raw<QuestionEvidenceTimeline>(TIMELINE_SQL, [[...pageIds]]))
    .map(r => ({ ...r, id: num(r.id), page_id: num(r.page_id), generation: num(r.generation) }));
}

/** The active, eligible takes of these pages, newest first, at most 20. */
export async function listQuestionEvidenceTakes(raw: EngineRawRead, pageIds: readonly number[]): Promise<QuestionEvidenceTake[]> {
  return (await raw<QuestionEvidenceTake>(TAKES_SQL, [[...pageIds]]))
    .map(r => ({ ...r, id: num(r.id), page_id: num(r.page_id), generation: num(r.generation) }));
}

/** The highest page generation of the brain and the highest fact id of the source (0 when none). */
export async function readQuestionEvidenceClock(raw: EngineRawRead, sourceId: string): Promise<QuestionEvidenceClock> {
  const [row] = await raw<QuestionEvidenceClock>(CLOCK_SQL, [sourceId]);
  return { generation: num(row?.generation ?? 0), fact_id: num(row?.fact_id ?? 0) };
}

/** The live question page `slug` of `sourceId`, or null. */
export async function readQuestionPageRow(raw: EngineRawRead, sourceId: string, slug: string): Promise<QuestionPageRow | null> {
  const [row] = await raw<QuestionPageRow>(QUESTION_PAGE_SQL, [sourceId, slug]);
  return row ? { ...row, id: num(row.id), generation: num(row.generation) } : null;
}

/** The evidence rows of one answer revision of a pin, each joined to the page, fact, timeline entry or take it cites. */
export function listQuestionEvidenceJoin(raw: EngineRawRead, questionId: number, answerRevision: number): Promise<QuestionEvidenceJoinRow[]> {
  return raw<QuestionEvidenceJoinRow>(EVIDENCE_JOIN_SQL, [questionId, answerRevision]);
}

/** Whether a live page of `sourceId` (under `prefix` when given) that is not a question page has a generation above `generation`. */
export async function hasNewQuestionPages(raw: EngineRawRead, sourceId: string, generation: number, prefix: string | null): Promise<boolean> {
  const [row] = prefix === null
    ? await raw<{ hit: boolean }>(NEW_PAGES_SQL, [sourceId, generation])
    : await raw<{ hit: boolean }>(NEW_PAGES_PREFIX_SQL, [sourceId, generation, likePrefix(prefix)]);
  return row?.hit === true;
}

/** Whether `sourceId` holds an unexpired fact (about `entitySlug` when given) with an id above `factId`. */
export async function hasNewQuestionFacts(raw: EngineRawRead, sourceId: string, factId: number, entitySlug: string | null): Promise<boolean> {
  const [row] = entitySlug === null
    ? await raw<{ hit: boolean }>(NEW_FACTS_SQL, [sourceId, factId])
    : await raw<{ hit: boolean }>(NEW_FACTS_ENTITY_SQL, [sourceId, factId, entitySlug]);
  return row?.hit === true;
}

const LOCK_SQL: Record<QuestionEvidenceLockKind, string> = { page: LOCK_PAGES_SQL, fact: LOCK_FACTS_SQL, timeline: LOCK_TIMELINE_SQL, take: LOCK_TAKES_SQL };

/**
 * The evidence rows of one kind a publication rereads, FOR SHARE until its transaction ends: pages as
 * `{ id, generation, revision, deleted, body }`, the others as `{ id, ok, hash }`.
 */
export async function lockQuestionEvidenceRows(raw: EngineRawRead, kind: QuestionEvidenceLockKind, ids: readonly number[]): Promise<Array<Record<string, unknown>>> {
  return (await raw<Record<string, unknown>>(LOCK_SQL[kind], [[...ids]]))
    .map(r => ({ ...r, id: num(r.id), ...(kind === 'page' ? { generation: num(r.generation) } : {}) }));
}

/** A LIKE pattern that matches the slugs starting with `prefix` (backslash, `%` and `_` escaped). */
export function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
}
