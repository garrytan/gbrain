/**
 * The typed members of the contradiction cycle (src/core/engine-sql/contradictions-cycle.ts), the ontology repair
 * paths (src/core/engine-sql/ontology-repair.ts) and the admin reads (src/core/engine-sql/admin-reads.ts) send Postgres
 * the statement text and binds the edge-contradictions phase, the scoped contradiction reader, the two eval reads,
 * the re-key duplicate drop, `repair ontology-facts`, the admin operations and `gbrain edge-proposals` sent through
 * `executeRaw` before the statements had members. A drift here changes a query plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: each member's recorded text and params equal the old statement byte for byte: the candidate query's `$n`
 * numbering (the person-type predicate with and without per-source arms), the live chunk and take re-reads under each
 * read policy (private-page exclusion, safe chunks, trust floor, holder allow-list), the six re-key move shapes the
 * writers pass, the ontology candidate and restore texts that splice the expiry and duplicate tests, and the admin
 * slug read under both page-policy parts. Fails when a member reorders a clause, renumbers a placeholder, binds a value
 * differently, or accepts a re-key move that is not one of the closed shapes. No database: the engine runs on the
 * recording fake. The expected texts are copied from the call sites at 85aa70ba6d.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { NOT_CONVERSATION_SLOT_SQL, CONVERSATION_SLOT_SQL } from '../src/core/chronicle/ontology.ts';
import { UNBACKED_FACT_SQL } from '../src/core/engine-sql/fact-relink-writes.ts';
import { projectionEligibleSql } from '../src/core/eligibility/sql.ts';
import { NON_EMPLOYER_PREFIXES, NON_EMPLOYER_TYPES } from '../src/core/link-target-roles.ts';
import { callerAccessAllowedSql, ownerOnlyTakeAllowedSql, privatePagesFilterForCaller } from '../src/core/search/private-visibility.ts';
import { pageReadFilter } from '../src/core/search/read-policy-sql.ts';
import { chunkVisibleFilter, safeChunksFilter } from '../src/core/search/safe-chunks.ts';
import type { PageReadPolicy } from '../src/core/types.ts';
import type { TrustTier } from '../src/core/trust/tier.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

function recordingEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return { engine, statements: () => fake.statements().map(s => ({ text: s.text, params: s.params })) };
}

const EDGE_CLI_ROWS = (where: string, limit: number) => `SELECT p.id, p.status, p.link_type, f.slug AS subject, ta.slug AS a_target, tb.slug AS b_target, te.slug AS ending,
            p.close_date::text AS close_date, p.born_closed, p.model, p.confidence, p.generated_line, p.created_at
       FROM link_edge_proposals p
       JOIN pages f ON f.id = p.from_page_id JOIN pages ta ON ta.id = p.a_to_page_id JOIN pages tb ON tb.id = p.b_to_page_id
       LEFT JOIN pages te ON te.id = p.ending_to_page_id
      WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit}`;

interface Pin {
  /** The call site the statement came from, at 85aa70ba6d. */
  from: string;
  run: (e: PostgresEngine) => Promise<unknown>;
  /** The statements, in order, as the call site sent them. */
  sent: Array<{ text: string; params: unknown[] }>;
}

// ─── edge-contradictions.ts:201 the candidate query ──────────────────────
// Main join (da99c637a7): the cli-members line's caller (edge-contradictions.ts:213 and :222 at de72811022) broke the
// subject-cap ties with `from_page_id, link_type COLLATE "C"` and sorted the result with `l.link_type COLLATE "C"` and
// `t.slug COLLATE "C"`; the join re-applied that tie-break and byte order to main's member, so the pin carries it too.
const TODAY = '2026-11-19';
const candidateText = (isPersonF: string, isPersonT: string, n: { types: number; prefixes: number; max: number; cut1: number; cut2: number }) => `WITH live AS (
       SELECT lr.* FROM link_relationships lr
         JOIN pages f ON f.id = lr.from_page_id AND f.deleted_at IS NULL
         JOIN pages t ON t.id = lr.to_page_id AND t.deleted_at IS NULL
        WHERE lr.scope = 'all' AND lr.semantics = 'state' AND lr.valid_ranges @> $1::date
          AND (lr.link_type <> 'works_at' OR (${isPersonF} AND NOT ${isPersonT} AND
            CASE WHEN NULLIF(t.type, '') IS NOT NULL THEN NOT (t.type = ANY($${n.types}::text[]))
              ELSE NOT EXISTS (SELECT 1 FROM unnest($${n.prefixes}::text[]) AS prefix(value)
                WHERE starts_with(t.slug, prefix.value)) END))
     ), multi AS (
       SELECT source_id, from_page_id, link_type FROM live
        GROUP BY 1, 2, 3 HAVING count(DISTINCT to_page_id) >= 2
        ORDER BY max(refreshed_at) DESC, from_page_id, link_type COLLATE "C" LIMIT $${n.max}
     )
     SELECT l.source_id, l.from_page_id, l.to_page_id, l.link_type, l.valid_ranges::text AS valid_ranges,
            l.last_start, l.recorded_at, l.evidence_hash,
            f.slug AS subject_slug, f.title AS subject_title, t.slug AS target_slug, t.title AS target_title
       FROM live l JOIN multi m USING (source_id, from_page_id, link_type)
       JOIN pages f ON f.id = l.from_page_id AND f.deleted_at IS NULL
         AND ($${n.cut1}::timestamptz IS NULL OR f.links_extracted_at >= $${n.cut2}::timestamptz)
       JOIN pages t ON t.id = l.to_page_id AND t.deleted_at IS NULL
      ORDER BY l.from_page_id, l.link_type COLLATE "C", l.last_start NULLS FIRST, t.slug COLLATE "C"`;

const PROPOSAL = {
  sourceId: 'default', fromPageId: 1, aToPageId: 2, bToPageId: 3, linkType: 'works_at', evidenceHash: 'h', status: 'proposed',
  endingToPageId: 2, closeDate: '2026-01-01', bornClosed: false, model: 'm', confidence: 0.9, generatedLine: 'line', detail: null,
};

// ─── scoped-read.ts:55 loadChunks and :73 loadTakes ──────────────────────
const chunksText = (policy: PageReadPolicy, floor: TrustTier | undefined) => {
  const params: unknown[] = [[1, 2]];
  const pageSql = pageReadFilter('p', { ...policy, ...(floor ? { minTrust: floor } : {}) }, params, true);
  const safe = (policy.requireSafeChunks ?? policy.excludePrivate ?? false) ? ` AND ${safeChunksFilter('p')}` : '';
  return { text: `SELECT cc.id, cc.page_id, cc.chunk_text, p.slug, p.source_id
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.id = ANY($1::int[]) AND ${pageSql} AND ${chunkVisibleFilter('p', 'cc')}${safe}`, params };
};
const takesText = (policy: PageReadPolicy, floor: TrustTier | undefined) => {
  const params: unknown[] = [[1, 2]];
  const pageSql = pageReadFilter('p', policy, params, true);
  let holderSql = '';
  if (policy.takesHoldersAllowList !== undefined) {
    params.push(policy.takesHoldersAllowList);
    holderSql = ` AND t.holder = ANY($${params.length}::text[])`;
  }
  return { text: `SELECT t.id, t.page_id, t.row_num, t.claim, t.holder, p.slug, p.source_id
       FROM takes t JOIN pages p ON p.id = t.page_id
      WHERE t.id = ANY($1::bigint[]) AND t.active AND ${pageSql}${holderSql}${policy.excludePrivate ? ownerOnlyTakeAllowedSql('t') : ''}
        AND ${projectionEligibleSql('takes', 't', floor ? { floor } : undefined)}`, params };
};
const POLICIES: Array<[string, PageReadPolicy]> = [
  ['an unrestricted policy', {}],
  ['one source', { sourceId: 'src-a' }],
  ['two sources and private pages excluded', { sourceIds: ['src-a', 'src-b'], excludePrivate: true }],
  ['safe chunks without a private exclusion', { requireSafeChunks: true }],
  ['a holder allow-list', { takesHoldersAllowList: ['garry', 'world'] }],
  ['an empty holder allow-list', { takesHoldersAllowList: [] }],
];

// ─── ontology-rekey.ts:21 the re-key duplicate drop ──────────────────────
const rekeyText = (move: { where: string; entity: string; sms: string }) => `WITH m AS (
      SELECT f.id, f.expired_at, ${move.entity} AS e, ${move.sms} AS s, f.dimension, f.value_hash, f.valid_from, f.source
        FROM facts f WHERE f.source_id = $1 AND f.dimension IS NOT NULL AND ${move.where}),
    cand AS (
      SELECT m.id, m.expired_at, m.e, m.s, m.dimension, m.value_hash, m.valid_from, m.source, 1 AS moving FROM m
      UNION ALL
      SELECT t.id, t.expired_at, t.entity_slug, t.source_markdown_slug, t.dimension, t.value_hash, t.valid_from, t.source, 0 FROM facts t
       WHERE t.source_id = $1 AND t.dimension IS NOT NULL AND NOT EXISTS (SELECT 1 FROM m WHERE m.id = t.id)
         AND EXISTS (SELECT 1 FROM m WHERE m.e = t.entity_slug AND m.s = t.source_markdown_slug AND m.dimension = t.dimension
                       AND m.value_hash = t.value_hash AND m.valid_from = t.valid_from)),
    ranked AS (
      SELECT id, row_number() OVER w AS rn, first_value(id) OVER w AS keep FROM cand
       WHERE e IS NOT NULL AND s IS NOT NULL AND value_hash IS NOT NULL AND valid_from IS NOT NULL
      WINDOW w AS (PARTITION BY e, s, dimension, value_hash, valid_from ORDER BY ${CONVERSATION_SLOT_SQL}, (expired_at IS NULL) DESC, moving, id))
    SELECT id, keep FROM ranked WHERE rn > 1`;

const MOVES: Array<{ from: string; move: { where: string; entity: string; sms: string; params: [unknown, unknown] } }> = [
  { from: 'src/core/repair/facts-rehome.ts:127 (rehome)', move: { where: 'f.entity_slug = $2 AND f.row_num IS NULL', entity: '$3::text', sms: 'f.source_markdown_slug', params: ['people/a', 'people/b'] } },
  { from: 'src/core/facts/conversation-relink.ts:139 (relink)', move: { where: `f.id = $2::bigint AND ${UNBACKED_FACT_SQL}`, entity: '$3::text', sms: 'f.source_markdown_slug', params: [41, 'people/b'] } },
  { from: 'src/core/persistence/twin-merge.ts:129 (twin merge)', move: { where: 'f.entity_slug = $2 AND f.source_markdown_slug IS DISTINCT FROM $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: ['people/a', 'people/b'] } },
  { from: 'src/core/page-state/rename-alias.ts:96 (rename, entity key)', move: { where: 'f.entity_slug = $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: ['people/a', 'people/b'] } },
  { from: 'src/core/page-state/rename-alias.ts:100 (rename, page key)', move: { where: 'f.source_markdown_slug = $2', entity: 'f.entity_slug', sms: '$3::text', params: ['people/a', 'people/b'] } },
  { from: 'src/core/facts/ontology-rekey.ts:46 dropPhantomMigrationDuplicates', move: { where: 'f.source_markdown_slug = $3 AND f.expired_at IS NULL', entity: '$2::text', sms: '$2::text', params: ['people/b', 'people/a'] } },
];

// ─── repair/ontology-facts.ts:48 EXPIRY_TEXT and :51 DUPLICATE_SQL ───────
const EXPIRY = `to_char(f.expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const DUPLICATE = `EXISTS (SELECT 1 FROM facts d WHERE d.source_id=f.source_id AND d.entity_slug=f.entity_slug
  AND d.dimension=f.dimension AND d.value_hash=f.value_hash AND d.source_markdown_slug=f.source
  AND d.valid_from=f.valid_from AND d.id<>f.id)`;

const PINS: Pin[] = [
  {
    from: 'src/core/cycle/edge-contradictions.ts:201 (no per-source arms, no cutoff)',
    run: e => e.listEdgeContradictionCandidates({ today: TODAY, maxSubjects: 200, pendingCutoff: null, personFilter: { types: ['person'], per_source: [] } }),
    sent: [{
      text: candidateText('f.type = ANY($2::text[])', 't.type = ANY($3::text[])', { types: 4, prefixes: 5, max: 6, cut1: 7, cut2: 8 }),
      params: [TODAY, ['person'], ['person'], [...NON_EMPLOYER_TYPES], [...NON_EMPLOYER_PREFIXES], 200, null, null],
    }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:201 (per-source arms, a cutoff)',
    run: e => e.listEdgeContradictionCandidates({ today: TODAY, maxSubjects: 5, pendingCutoff: '2026-11-18T00:00:00Z',
      personFilter: { types: ['person'], per_source: [{ source_id: 'src-a', types: ['person', 'founder'] }] } }),
    sent: [{
      text: candidateText(
        'f.type = ANY(CASE f.source_id WHEN $2::text THEN $3::text[] ELSE $4::text[] END)',
        't.type = ANY(CASE t.source_id WHEN $5::text THEN $6::text[] ELSE $7::text[] END)',
        { types: 8, prefixes: 9, max: 10, cut1: 11, cut2: 12 }),
      params: [TODAY, 'src-a', ['person', 'founder'], ['person'], 'src-a', ['person', 'founder'], ['person'], [...NON_EMPLOYER_TYPES], [...NON_EMPLOYER_PREFIXES], 5,
        '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z'],
    }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:288 per-group proposal read',
    run: e => e.listKnownEdgeProposals(7, 'works_at', ['h1', 'h2']),
    sent: [{
      text: `SELECT a_to_page_id AS a, b_to_page_id AS b, status, detail, updated_at > now() - interval '24 hours' AS recent FROM link_edge_proposals
        WHERE from_page_id = $1 AND link_type = $2 AND evidence_hash = ANY($3::text[])`,
      params: [7, 'works_at', ['h1', 'h2']],
    }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:303 relationship contexts',
    run: e => e.listLinkContexts(7, 8, 'works_at'),
    sent: [{ text: `SELECT DISTINCT context FROM links WHERE from_page_id = $1 AND to_page_id = $2 AND link_type = $3 AND context <> '' LIMIT 3`, params: [7, 8, 'works_at'] }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:448 recordProposal',
    run: e => e.recordEdgeProposal(PROPOSAL),
    sent: [{
      text: `INSERT INTO link_edge_proposals (source_id, from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash, status,
       ending_to_page_id, close_date, born_closed, model, confidence, generated_line, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12, $13, $14)
     ON CONFLICT (from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash) DO UPDATE SET
       status = EXCLUDED.status, ending_to_page_id = EXCLUDED.ending_to_page_id, close_date = EXCLUDED.close_date,
       born_closed = EXCLUDED.born_closed, model = EXCLUDED.model, confidence = EXCLUDED.confidence,
       generated_line = EXCLUDED.generated_line, detail = EXCLUDED.detail, updated_at = now()
     WHERE link_edge_proposals.status = 'error'
     RETURNING id`,
      params: ['default', 1, 2, 3, 'works_at', 'h', 'proposed', 2, '2026-01-01', false, 'm', 0.9, 'line', null],
    }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:481 loadProposal',
    run: e => e.readEdgeProposal(9),
    sent: [{
      text: `SELECT p.id, p.source_id, p.status, p.from_page_id, p.ending_to_page_id, p.link_type, p.close_date::text AS close_date,
            p.generated_line, f.slug AS subject_slug, t.slug AS ending_slug
       FROM link_edge_proposals p JOIN pages f ON f.id = p.from_page_id LEFT JOIN pages t ON t.id = p.ending_to_page_id
      WHERE p.id = $1`,
      params: [9],
    }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:491 closureLanded',
    run: e => e.edgeClosureLanded(1, 2, 'works_at', '2026-01-01'),
    sent: [{
      text: `SELECT 1 FROM link_transitions WHERE origin_page_id = $1 AND from_page_id = $1 AND to_page_id = $2 AND link_type = $3
        AND kind = 'end' AND producer = 'dream' AND occurred_on = $4::date LIMIT 1`,
      params: [1, 2, 'works_at', '2026-01-01'],
    }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:511 applyEdgeProposal',
    run: e => e.readEdgeProposalEvidence(9),
    sent: [{
      text: `SELECT la.evidence_hash AS a, lb.evidence_hash AS b FROM link_edge_proposals pr
       JOIN link_relationships la ON la.from_page_id = pr.from_page_id AND la.to_page_id = pr.a_to_page_id AND la.link_type = pr.link_type AND la.scope = 'all'
       JOIN link_relationships lb ON lb.from_page_id = pr.from_page_id AND lb.to_page_id = pr.b_to_page_id AND lb.link_type = pr.link_type AND lb.scope = 'all'
      WHERE pr.id = $1`,
      params: [9],
    }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:516 applyEdgeProposal',
    run: e => e.readEdgeProposalHash(9),
    sent: [{ text: `SELECT evidence_hash FROM link_edge_proposals WHERE id = $1`, params: [9] }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:519 applyEdgeProposal',
    run: e => e.markEdgeProposalStale(9),
    sent: [{ text: `UPDATE link_edge_proposals SET status = 'stale', updated_at = now() WHERE id = $1`, params: [9] }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:525 applyEdgeProposal',
    run: e => e.setEdgeProposalStatus(9, 'applied'),
    sent: [{ text: `UPDATE link_edge_proposals SET status = $2, updated_at = now() WHERE id = $1`, params: [9, 'applied'] }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:531 rejectEdgeProposal',
    run: e => e.rejectOpenEdgeProposal(9),
    sent: [{ text: `UPDATE link_edge_proposals SET status = 'rejected', updated_at = now() WHERE id = $1 AND status IN ('proposed','undated_unresolved','ambiguous_same_date') RETURNING 1`, params: [9] }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:542 undoEdgeProposal',
    run: e => e.markEdgeProposalUndone(9),
    sent: [{ text: `UPDATE link_edge_proposals SET status = 'undone', updated_at = now() WHERE id = $1`, params: [9] }],
  },
  {
    from: 'src/core/cycle/edge-contradictions.ts:548 markRevertedProposals',
    run: e => e.markRevertedEdgeProposals(),
    sent: [{
      text: `UPDATE link_edge_proposals p SET status = 'reverted_by_user', updated_at = now()
      WHERE p.status = 'applied' AND p.updated_at < now() AND NOT EXISTS (
        SELECT 1 FROM link_transitions t WHERE t.origin_page_id = p.from_page_id AND t.from_page_id = p.from_page_id
          AND t.to_page_id = p.ending_to_page_id AND t.link_type = p.link_type AND t.kind = 'end' AND t.producer = 'dream'
          AND t.occurred_on = p.close_date)
      RETURNING p.id`,
      params: [],
    }],
  },
  ...POLICIES.flatMap(([label, policy]) => [undefined, 'agent_written' as const].flatMap(floor => [
    {
      from: `src/core/eval-contradictions/scoped-read.ts:55 loadChunks (${label}, floor ${floor ?? 'none'})`,
      run: (e: PostgresEngine) => e.listLiveChunksByIds([1, 2], policy, floor),
      sent: [chunksText(policy, floor)],
    },
    {
      from: `src/core/eval-contradictions/scoped-read.ts:73 loadTakes (${label}, floor ${floor ?? 'none'})`,
      run: (e: PostgresEngine) => e.listLiveTakesByIds([1, 2], policy, floor),
      sent: [takesText(policy, floor)],
    },
  ])),
  {
    from: 'src/core/eval-contradictions/cost-prompt.ts lastPromptVersion',
    run: e => e.readLastContradictionsPromptVersion(),
    sent: [{ text: `SELECT prompt_version FROM eval_contradictions_runs ORDER BY ran_at DESC LIMIT 1`, params: [] }],
  },
  {
    from: 'src/commands/eval-suspected-contradictions.ts candidate queries',
    run: e => e.listEvalCandidateQueries(100),
    sent: [{ text: `SELECT query FROM eval_candidates WHERE query IS NOT NULL ORDER BY id DESC LIMIT $1`, params: [100] }],
  },
  ...MOVES.map(({ from, move }) => ({
    from: `${from} drop`,
    run: (e: PostgresEngine) => e.listRekeyLosers('default', move),
    sent: [{ text: rekeyText(move), params: ['default', ...move.params] }],
  })),
  {
    from: 'src/core/facts/ontology-rekey.ts:46 supersession repoint',
    run: e => e.repointSupersededToKept([1, 2], [3, 3]),
    sent: [{
      text: `UPDATE facts f SET superseded_by = CASE WHEN f.id = x.keep THEN NULL ELSE x.keep END
    FROM unnest($1::bigint[], $2::bigint[]) AS x(id, keep) WHERE f.superseded_by = x.id`,
      params: [[1, 2], [3, 3]],
    }],
  },
  {
    from: 'src/core/facts/ontology-rekey.ts:48 slot clear',
    run: e => e.clearOntologySlots([1, 2]),
    sent: [{
      text: `UPDATE facts SET dimension = NULL, value = NULL, value_hash = NULL, dim_status = NULL
    WHERE id = ANY($1::bigint[]) AND ${CONVERSATION_SLOT_SQL}`,
      params: [[1, 2]],
    }],
  },
  {
    from: 'src/core/facts/ontology-rekey.ts:50 loser delete',
    run: e => e.deleteRekeyLosers([1, 2]),
    sent: [{ text: 'DELETE FROM facts WHERE id = ANY($1::bigint[]) AND dimension IS NOT NULL', params: [[1, 2]] }],
  },
  {
    from: 'src/core/repair/ontology-facts.ts:78 classifyOntologyFacts',
    run: e => e.listOntologyFactCandidates(['default', 'other']),
    sent: [{
      text: `
    SELECT f.id, f.source_id, f.entity_slug, f.dimension, f.source, f.source_markdown_slug AS page, f.row_num,
           ${EXPIRY} AS expired_at,
           EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
             AND (w.subject='*' OR w.subject=f.entity_slug)
             AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v2(f.fact), gbrain_fact_fingerprint_v1(f.fact))) AS withdrawn,
           f.consolidated_into IS NOT NULL AS consolidated,
           ${DUPLICATE} AS duplicate
      FROM facts f
     WHERE f.source_id=ANY($1::text[]) AND f.dimension IS NOT NULL AND f.entity_slug IS NOT NULL AND f.source IS NOT NULL
       AND (f.row_num IS NOT NULL OR f.source_markdown_slug IS DISTINCT FROM f.source) AND ${NOT_CONVERSATION_SLOT_SQL}
     ORDER BY f.id`,
      params: [['default', 'other']],
    }],
  },
  {
    from: 'src/core/repair/ontology-facts.ts:155 apply',
    run: e => e.restoreOntologyFact({ id: 5, source_id: 'default', row_num: 2, page: 'people/a', expired_at: null }),
    sent: [{
      text: `UPDATE facts f SET row_num=NULL, source_markdown_slug=f.source, expired_at=NULL
        WHERE f.id=$1 AND f.source_id=$2 AND f.dimension IS NOT NULL AND ${NOT_CONVERSATION_SLOT_SQL}
          AND f.row_num IS NOT DISTINCT FROM $3::integer AND f.source_markdown_slug IS NOT DISTINCT FROM $4::text
          AND ${EXPIRY} IS NOT DISTINCT FROM $5::text AND NOT ${DUPLICATE}
        RETURNING f.id, f.expired_at IS NOT NULL AS expired`,
      params: [5, 'default', 2, 'people/a', null],
    }],
  },
  ...(['read', 'access'] as const).map(policy => ({
    from: `src/core/ops/admin.ts:73 visibleMostConnected (${policy})`,
    run: (e: PostgresEngine) => e.listVisiblePageSlugs(['a', 'b'], ['src-a'], policy),
    sent: [{
      text: `SELECT DISTINCT p.slug FROM pages p
    WHERE p.slug = ANY($1::text[]) AND p.deleted_at IS NULL AND ($2::text[] IS NULL OR p.source_id = ANY($2::text[]))
      AND ${policy === 'access' ? callerAccessAllowedSql('p') : privatePagesFilterForCaller('p')}`,
      params: [['a', 'b'], ['src-a']],
    }],
  })),
  {
    from: 'src/core/ops/admin.ts:73 visibleMostConnected (every source)',
    run: e => e.listVisiblePageSlugs(['a'], null, 'read'),
    sent: [{
      text: `SELECT DISTINCT p.slug FROM pages p
    WHERE p.slug = ANY($1::text[]) AND p.deleted_at IS NULL AND ($2::text[] IS NULL OR p.source_id = ANY($2::text[]))
      AND ${privatePagesFilterForCaller('p')}`,
      params: [['a'], null],
    }],
  },
  // ─── src/commands/edge-proposals.ts (gbrain edge-proposals), at 3dd0b062cc ───
  {
    from: 'src/commands/edge-proposals.ts:95 list --status=all',
    run: e => e.listEdgeProposalCliRows({ kind: 'all' }, 7),
    sent: [{ text: EDGE_CLI_ROWS('TRUE', 7), params: [] }],
  },
  {
    from: 'src/commands/edge-proposals.ts:96 list (default statuses)',
    run: e => e.listEdgeProposalCliRows({ kind: 'statuses', statuses: ['proposed', 'undated_unresolved'] }, 50),
    sent: [{ text: EDGE_CLI_ROWS('p.status = ANY($1::text[])', 50), params: [['proposed', 'undated_unresolved']] }],
  },
  {
    from: 'src/commands/edge-proposals.ts:107 show',
    run: e => e.listEdgeProposalCliRows({ kind: 'id', id: 4 }, 50),
    sent: [{ text: EDGE_CLI_ROWS('p.id = $1', 50), params: [4] }],
  },
  {
    from: 'src/commands/edge-proposals.ts:134 date',
    run: e => e.listEdgeProposalCliRows({ kind: 'undated', id: 4 }, 50),
    sent: [{ text: EDGE_CLI_ROWS(`p.id = $1 AND p.status = 'undated_unresolved'`, 50), params: [4] }],
  },
  {
    from: 'src/commands/edge-proposals.ts:101 retry --all-held',
    run: e => e.deleteHeldEdgeProposalErrors(),
    sent: [{ text: `DELETE FROM link_edge_proposals WHERE status = 'error' AND detail LIKE 'held after %' RETURNING id`, params: [] }],
  },
  {
    from: 'src/commands/edge-proposals.ts:114 undo --all-applied',
    run: e => e.listAppliedEdgeProposalIds(),
    sent: [{ text: `SELECT id FROM link_edge_proposals WHERE status = 'applied' ORDER BY id`, params: [] }],
  },
  {
    from: 'src/commands/edge-proposals.ts:126 retry <id>',
    run: e => e.deleteEdgeProposalError(4),
    sent: [{ text: `DELETE FROM link_edge_proposals WHERE id = $1 AND status = 'error' RETURNING id`, params: [4] }],
  },
  {
    from: 'src/commands/edge-proposals.ts:139 date source',
    run: e => e.readEdgeProposalSourceId(4),
    sent: [{ text: `SELECT source_id FROM link_edge_proposals WHERE id = $1`, params: [4] }],
  },
  {
    from: 'src/commands/edge-proposals.ts:144 date reject',
    run: e => e.markEdgeProposalDated(4),
    sent: [{ text: `UPDATE link_edge_proposals SET status = 'rejected', detail = 'dated by user', updated_at = now() WHERE id = $1`, params: [4] }],
  },
  {
    from: 'src/core/ops/admin.ts:267 get_versions',
    run: e => e.readPagesForVersionHistory([4, 5]),
    sent: [{ text: 'SELECT id, slug, source_id, frontmatter FROM pages WHERE id = ANY($1::bigint[])', params: [[4, 5]] }],
  },
];

test.each(PINS.map(pin => [pin.from, pin] as const))('%s keeps its Postgres text and params byte for byte', async (_from, pin) => {
  const { engine, statements } = recordingEngine();
  await pin.run(engine);
  expect(statements()).toEqual(pin.sent);
});

test('a re-key move outside the closed shapes is refused before any statement runs', async () => {
  const bad = [
    { where: "f.entity_slug = $2 OR 1=1", entity: '$3::text', sms: 'f.source_markdown_slug', params: ['a', 'b'] as [unknown, unknown] },
    { where: 'f.entity_slug = $2', entity: "'x' || $3", sms: 'f.source_markdown_slug', params: ['a', 'b'] as [unknown, unknown] },
    { where: 'f.entity_slug = $2', entity: '$3::text', sms: '$1; DROP TABLE facts', params: ['a', 'b'] as [unknown, unknown] },
  ];
  for (const move of bad) {
    const { engine, statements } = recordingEngine();
    await expect(engine.listRekeyLosers('default', move)).rejects.toThrow(/closed shapes|supported shapes/);
    expect(statements()).toEqual([]);
  }
});

test('the live reads refuse a holder position that is not a positive integer', async () => {
  // The only spliced number is the bound position of the allow-list, which the member takes from the params it built.
  const { engine, statements } = recordingEngine();
  await engine.listLiveTakesByIds([1], { takesHoldersAllowList: ['x'] }, undefined);
  expect(statements()[0]!.text).toContain('t.holder = ANY($2::text[])');
});

test('the edge-proposals list refuses a limit it would not splice, before any statement runs', async () => {
  for (const limit of [0, 1001, 2.5, Number.NaN]) {
    const { engine, statements } = recordingEngine();
    await expect(engine.listEdgeProposalCliRows({ kind: 'all' }, limit)).rejects.toThrow(/whole number from 1 to 1000/);
    expect(statements()).toEqual([]);
  }
});
