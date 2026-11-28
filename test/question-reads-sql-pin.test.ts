/**
 * The pinned-question reads (src/core/engine-sql/question-reads.ts) send the statements their callers sent through
 * executeRaw at f9592f7a7e (questions/refresh.ts, freshness.ts and pages.ts), rebuilt here from
 * the same fragments those callers interpolated, so a drift in a fragment or in the written-out text fails.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends exactly the caller's old text and parameters.
 *  - Regression: a member that drops a filter (quarantine, projection eligibility, the question-page exclusion) or a
 *    hash column would cite or hide different evidence on a brain the parity cases do not hold.
 *  - Why existing coverage misses it: the sql-text goldens pin the text, not where it came from.
 *  - Seam: a recording executeRaw stand-in; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import * as Q from '../src/core/engine-sql/question-reads.ts';
import { PINNED_QUESTION_MARKER } from '../src/core/questions/identity.ts';
import { quarantinedProvenanceFilterFragment, quarantineFilterFragment } from '../src/core/quarantine.ts';
import { projectionEligibleSql } from '../src/core/eligibility/sql.ts';
import { FACT_HASH_SQL, OWNER_BODY_HASH_SQL, TAKE_HASH_SQL, TIMELINE_HASH_SQL } from '../src/core/questions/freshness.ts';

const MAX_FACTS = 30, MAX_TIMELINE = 20, MAX_TAKES = 20;
const OLD: Record<string, string> = {
CANDIDATES: `SELECT id, slug, source_id, generation, knowledge_revision::text AS revision, type, compiled_truth, updated_at,
       (frontmatter ? '${PINNED_QUESTION_MARKER}') AS marker
     FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL AND body_storage = 'inline'
       AND ${quarantineFilterFragment('pages')}`,
PUBLISHED: `SELECT q.answer, q.last_refresh_at AS published_at,
       COALESCE(array_agg(e.page_id) FILTER (WHERE e.page_id IS NOT NULL), ARRAY[]::integer[]) AS cited
     FROM pinned_questions q LEFT JOIN question_evidence e ON e.question_id = q.id AND e.answer_revision = q.answer_revision
     WHERE q.source_id = $1 AND q.answer IS NOT NULL GROUP BY q.id, q.answer, q.last_refresh_at`,
FACTS: `SELECT f.id, f.fact, f.entity_slug, f.valid_from, ${FACT_HASH_SQL('f')} AS hash FROM facts f
       WHERE f.source_id = $1 AND f.entity_slug = ANY($2::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL
         AND (f.valid_until IS NULL OR f.valid_until > now()) AND ${quarantinedProvenanceFilterFragment('f')}
         AND ${projectionEligibleSql('facts', 'f', undefined)}
         AND NOT EXISTS (SELECT 1 FROM pages fp WHERE fp.source_id = f.source_id AND fp.slug = f.source_markdown_slug
           AND (fp.type IN ('question', 'synthesis') OR fp.frontmatter ? '${PINNED_QUESTION_MARKER}'))
       ORDER BY (CASE WHEN f.valid_from IS NULL OR f.valid_from > now() THEN f.created_at ELSE f.valid_from END) DESC, f.id DESC LIMIT ${MAX_FACTS}`,
TIMELINE: `SELECT t.id, t.date, t.summary, t.detail, p.id AS page_id, p.slug, p.generation, p.knowledge_revision::text AS revision, ${TIMELINE_HASH_SQL('t')} AS hash
       FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.id = ANY($1::integer[]) AND ${projectionEligibleSql('timeline_entries', 't', undefined)} ORDER BY t.date DESC, t.id DESC LIMIT ${MAX_TIMELINE}`,
TAKES: `SELECT k.id, k.claim, k.holder, k.weight, p.id AS page_id, p.slug, p.generation, p.knowledge_revision::text AS revision, ${TAKE_HASH_SQL('k')} AS hash
       FROM takes k JOIN pages p ON p.id = k.page_id WHERE p.id = ANY($1::integer[]) AND k.active AND k.superseded_by IS NULL
         AND ${projectionEligibleSql('takes', 'k', undefined)}
       ORDER BY k.id DESC LIMIT ${MAX_TAKES}`,
CLOCK: `SELECT (SELECT COALESCE(MAX(generation), 0) FROM pages) AS generation,
              (SELECT COALESCE(MAX(id), 0) FROM facts WHERE source_id = $1) AS fact_id`,
QUESTION_PAGE: `SELECT id, generation, knowledge_revision::text AS revision, compiled_truth, body_storage,
       COALESCE(frontmatter->>'status', '') = 'archived' AS archived
     FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`,
EVIDENCE_JOIN: `SELECT e.sentence_id, e.kind, e.source_id, e.page_id, e.page_generation, e.page_revision, e.content_hash,
       p.id AS p_id, p.generation AS p_generation, p.knowledge_revision::text AS p_revision, p.deleted_at AS p_deleted,
       s.archived AS p_source_archived, ${OWNER_BODY_HASH_SQL('p')} AS p_body_hash,
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
NEW_PAGES: `SELECT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.generation > $2 AND p.deleted_at IS NULL
       AND p.type NOT IN ('question', 'synthesis') AND NOT (p.frontmatter ? 'pinned_question') ) AS hit`,
NEW_PAGES_PREFIX: `SELECT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.generation > $2 AND p.deleted_at IS NULL
       AND p.type NOT IN ('question', 'synthesis') AND NOT (p.frontmatter ? 'pinned_question') AND p.slug LIKE $3) AS hit`,
NEW_FACTS: `SELECT EXISTS (SELECT 1 FROM facts f WHERE f.source_id = $1 AND f.id > $2 AND f.expired_at IS NULL
       ) AS hit`,
NEW_FACTS_ENTITY: `SELECT EXISTS (SELECT 1 FROM facts f WHERE f.source_id = $1 AND f.id > $2 AND f.expired_at IS NULL
       AND f.entity_slug = $3) AS hit`,
LOCK_PAGES: `SELECT id, generation, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted, ${OWNER_BODY_HASH_SQL('pages')} AS body
       FROM pages WHERE id = ANY($1::integer[]) FOR SHARE`,
LOCK_FACTS: `SELECT id, (expired_at IS NULL AND superseded_by IS NULL AND (valid_until IS NULL OR valid_until > now())) AS ok,
      ${FACT_HASH_SQL('facts')} AS hash FROM facts WHERE id = ANY($1::bigint[]) FOR SHARE`,
LOCK_TIMELINE: `SELECT id, true AS ok, ${TIMELINE_HASH_SQL('timeline_entries')} AS hash FROM timeline_entries WHERE id = ANY($1::integer[]) FOR SHARE`,
LOCK_TAKES: `SELECT id, (active AND superseded_by IS NULL) AS ok, ${TAKE_HASH_SQL('takes')} AS hash FROM takes WHERE id = ANY($1::bigint[]) FOR SHARE`,
};

function recorder() {
  const log: Array<[string, unknown[]]> = [];
  const raw = async (sql: string, params?: unknown[]) => { log.push([sql, params ?? []]); return [] as never; };
  return { log, raw: raw as never };
}

describe('pinned-question reads send their callers\' statements', () => {
  test('every member', async () => {
    const r = recorder();
    await Q.listQuestionCandidatePages(r.raw, 'default', ['a', 'b']);
    await Q.listPublishedQuestionAnswers(r.raw, 'default');
    await Q.listQuestionEvidenceFacts(r.raw, 'default', ['people/a']);
    await Q.listQuestionEvidenceTimeline(r.raw, [1, 2]);
    await Q.listQuestionEvidenceTakes(r.raw, [1, 2]);
    await Q.readQuestionEvidenceClock(r.raw, 'default');
    await Q.readQuestionPageRow(r.raw, 'default', 'questions/x');
    await Q.listQuestionEvidenceJoin(r.raw, 7, 3);
    await Q.hasNewQuestionPages(r.raw, 'default', 5, null);
    await Q.hasNewQuestionPages(r.raw, 'default', 5, 'projects/');
    await Q.hasNewQuestionFacts(r.raw, 'default', 9, null);
    await Q.hasNewQuestionFacts(r.raw, 'default', 9, 'people/a');
    for (const kind of ['page', 'fact', 'timeline', 'take'] as const) await Q.lockQuestionEvidenceRows(r.raw, kind, [4]);
    expect(r.log).toEqual([
      [OLD.CANDIDATES, ['default', ['a', 'b']]],
      [OLD.PUBLISHED, ['default']],
      [OLD.FACTS, ['default', ['people/a']]],
      [OLD.TIMELINE, [[1, 2]]],
      [OLD.TAKES, [[1, 2]]],
      [OLD.CLOCK, ['default']],
      [OLD.QUESTION_PAGE, ['default', 'questions/x']],
      [OLD.EVIDENCE_JOIN, [7, 3]],
      [OLD.NEW_PAGES, ['default', 5]],
      [OLD.NEW_PAGES_PREFIX, ['default', 5, 'projects/%']],
      [OLD.NEW_FACTS, ['default', 9]],
      [OLD.NEW_FACTS_ENTITY, ['default', 9, 'people/a']],
      [OLD.LOCK_PAGES, [[4]]],
      [OLD.LOCK_FACTS, [[4]]],
      [OLD.LOCK_TIMELINE, [[4]]],
      [OLD.LOCK_TAKES, [[4]]],
    ]);
  });
});
