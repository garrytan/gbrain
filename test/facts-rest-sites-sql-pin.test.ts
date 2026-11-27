/**
 * The facts write-path and recall pool members that replaced raw `executeRaw` sites (engine-sql/facts-trust.ts and
 * facts-recall.ts) send Postgres the statement text and binds their callers sent before the move, in the same order. A
 * drift here changes a query plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member's recorded statements (text and params, in order) equal what its caller sent through
 *    `executeRaw` at 2eb69f4613 (softDeleteDerivedPages and markNeedsRederive: at cb17d047b7, #9653). Static texts below are copied from the callers at that commit. A text a caller built from
 *    shared builders (the read-policy fragments, the trust floor, the withdrawal predicates, the pool WHERE) is the text that
 *    caller rendered at that commit, captured by running the unchanged callers against a recording engine; one over
 *    3000 characters is pinned by its length and SHA-256 instead of being copied. One member differs on purpose:
 *    `listNearestFacts` sends the same statement with its placeholders renumbered, because the old text bound the model, the
 *    dimensions and the vector literal once and referenced them from two places, while the member binds each twice
 *    (the pool WHERE placeholders now follow the similarity expression's). The statement means the same; its params are
 *    [model, dims, literal, literal, ...pool params, model, dims, literal, limit] since the ANN read became an inner
 *    distance-ordered query with an outer id tie-break (the literal is bound once more), and dims bind only once when the column has declared
 *    dimensions (the pool then skips its vector_dims filter). This is the same shape listFactsForRelevance
 *    has used since lane 4's first batch.
 *    The three quote-read members (listFactsFromQuotedPages, listOwnerTierFacts, listReadablePageSlugs) are pinned
 *    to their callers at c33606182c (search/transcript-quote.ts, search/slot-history.ts),
 *    captured the same way. readClaimWithdrawal is pinned to factWithdrawnRefusal (facts/single-prepare.ts) at 8a5229aa8c,
 *    captured the same way.
 *    The digests of readClaimWithdrawal and of the remote listReadablePageSlugs case were re-captured at the merge of
 *    8d2e667543: the shared owner-only fragment gained the owner_only_held guard there, the same change that moved the
 *    readMemberPageWithdrawal digest from 15378 to 16084 characters. No other text changed.
 *  - Main join (da99c637a7): the cli-members line's callers (fact-relevance.ts at de72811022) sorted the pool keys and
 *    entity pairs with `COLLATE "C"` (`SELECT DISTINCT f.source_id COLLATE "C", f.entity_slug COLLATE "C"` and the same
 *    ORDER BY), and read the nearest facts in an inner query ordered by distance alone with an outer
 *    `ORDER BY f.distance, f.id` tie-break. The join kept main's members and re-applied both, so those pins carry them:
 *    the pool texts differ from 2eb69f4613 only by `COLLATE "C"` (four per statement; the two digest pins grew by 48
 *    characters, 4 x ` COLLATE "C"`), and `listNearestFacts` now selects `f.embedding <=> $4 AS distance` in the inner
 *    query, which binds the vector literal once more as $4 (params [model, dims, literal, literal, ...pool params, model,
 *    dims, literal, limit]) and shifts every later placeholder up by one.
 *    Three later changes are pinned on purpose: the owner-only read predicates also check the owner_only_held catalog
 *    mark, listCallOffCueFacts orders a future-dated fact by its created_at, and listFactProvenance is the facts-cycle
 *    member (it orders by id). Those pins hold the merged text, not the text at 2eb69f4613.
 *  - Trust floor (master sync 18, #10276): a floor that names no tier is refused (`TrustFloorError`), so the "trust floor"
 *    fixtures name `user_confirmed`, the strictest real tier, which admits one tier. They named `verified_user` before, which
 *    is not a tier and rendered `trust_tier IN ()`; the texts and digests below differ from the old ones only by that
 *    list (`IN ('user_confirmed')`, 16 characters longer each time it appears; checked by restoring `IN ()` and matching
 *    the old digests).
 *  - Regression: a member that reorders a clause, renumbers a placeholder, binds a value differently, drops a cast or
 *    sends the iterative-scan settings in another order changes what Postgres answers while the parity cases may still
 *    pass on a small fixture.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts)
 *    and these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records text and params; no database runs.
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';
import { KEEP_HIDDEN_AT } from '../src/core/facts/derivation-inputs.ts';

type Responder = Parameters<typeof makeFakeSql>[0];

function recordingEngine(responder?: Responder) {
  const fake = makeFakeSql(responder);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return { engine, statements: () => fake.statements().map(s => ({ text: s.text, params: s.params })) };
}

interface Stmt {
  /** The exact statement text, or its length and SHA-256 when it is too long to copy. */
  text?: string;
  digest?: { length: number; sha256: string };
  /** The params the statement was bound with (undefined: none). */
  params?: unknown[];
}
interface Pin {
  /** The caller site(s) the statement came from, at 2eb69f4613. */
  from: string;
  member: string;
  label?: string;
  run: (e: PostgresEngine) => Promise<unknown>;
  responder?: Responder;
  /** Every statement the member sends, in order. */
  statements: Stmt[];
}

const scopeA = { sourceId: 's1', worldOnly: false, excludePrivate: false } as never;
const scopeB = { sourceIds: ['s1', 's2'], worldOnly: true, excludePrivate: true, minTrust: 'user_confirmed', suppressFlagged: true } as never;
const VEC = { literal: '[0,0.1,0.2,0.3]', type: 'vector', model: 'openai:text-embedding-3-large', dims: 4 } as const;
/** The call-off cue regex the old laterRetractions bound (saved-facts-match.ts RETRACTION plus the cancellation words). */
const CALL_OFF_REGEX = "\\m(retract(s|ed|ing|ion)?|disregard|scratch that|i misspoke|i was wrong|not what (i|we) (posted|said|wrote)|ignore (the|my|that|what)|rumour|rumor|called off|cancelled|canceled|fell through|not happening|never happened|no longer planned)\\M";

const PINS: Pin[] = [
  {
    from: "src/core/facts/absorb-log.ts:218 pendingReceipt",
    member: 'readPendingWriteReceipt',
    run: e => e.readPendingWriteReceipt('cli', 'p1', '00000000-0000-4000-8000-000000000001'),
    statements: [{ text: `SELECT request_id::text AS request_id, state FROM persistence_requests
        WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid AND state IN ('queued','running','recovering')`, params: ['cli', 'p1', '00000000-0000-4000-8000-000000000001'] }],
  },
  {
    from: "src/core/facts/backstop.ts:730 insertDerivedFact",
    member: 'lockSourceShared',
    run: e => e.lockSourceShared('s1'),
    statements: [{ text: `SELECT id FROM sources WHERE id=$1 FOR SHARE`, params: ['s1'] }],
  },
  {
    from: "src/core/facts/embedding-identity.ts:58 readOversizedStaleFacts",
    member: 'listOversizedStaleFacts',
    run: e => e.listOversizedStaleFacts({ sourceId: 's1', model: 'm1', dims: 1536, maxTokens: 8000 }),
    statements: [{ text: `SELECT f.id::text, f.source_id, f.source_markdown_slug AS slug, f.fact FROM facts f
      WHERE ($1::text IS NULL OR f.source_id = $1) AND f.expired_at IS NULL AND f.superseded_by IS NULL
  AND (f.valid_until IS NULL OR f.valid_until>now())
  AND NOT (f.source = ANY($2::text[]))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id
    AND w.visibility=f.visibility AND w.subject = ANY(CASE WHEN starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') THEN ARRAY[f.source_markdown_slug] ELSE ARRAY['*', f.entity_slug] END)
    AND w.fact_hash = gbrain_fact_fingerprint(f.fact))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id
    AND w.visibility=f.visibility AND w.subject = ANY(CASE WHEN starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') THEN ARRAY[f.source_markdown_slug] ELSE ARRAY['*', f.entity_slug] END)
    AND w.fact_hash = gbrain_fact_fingerprint_v1(f.fact))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id
    AND w.visibility=f.visibility AND w.subject = ANY(CASE WHEN starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') THEN ARRAY[f.source_markdown_slug] ELSE ARRAY['*', f.entity_slug] END)
    AND w.fact_hash = gbrain_fact_fingerprint_v2(f.fact))
  AND EXISTS (SELECT 1 FROM sources s WHERE s.id=f.source_id AND NOT s.archived)
  AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id
    AND p.slug=f.source_markdown_slug AND p.deleted_at IS NOT NULL) AND (f.embedding IS NULL OR f.embedding_model IS DISTINCT FROM $3
  OR f.embedded_text_hash IS DISTINCT FROM md5(f.fact) OR vector_dims(f.embedding)<>$4::int)
        AND octet_length(f.fact) > $5::int ORDER BY f.id LIMIT 10000`, params: ['s1', ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], 'm1', 1536, 8000] }],
  },
  {
    from: "src/core/facts/embedding-identity.ts:58 readOversizedStaleFacts (no source)",
    member: 'listOversizedStaleFacts',
    label: "all sources",
    run: e => e.listOversizedStaleFacts({ model: 'm1', dims: 1536, maxTokens: 8000 }),
    statements: [{ text: `SELECT f.id::text, f.source_id, f.source_markdown_slug AS slug, f.fact FROM facts f
      WHERE ($1::text IS NULL OR f.source_id = $1) AND f.expired_at IS NULL AND f.superseded_by IS NULL
  AND (f.valid_until IS NULL OR f.valid_until>now())
  AND NOT (f.source = ANY($2::text[]))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id
    AND w.visibility=f.visibility AND w.subject = ANY(CASE WHEN starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') THEN ARRAY[f.source_markdown_slug] ELSE ARRAY['*', f.entity_slug] END)
    AND w.fact_hash = gbrain_fact_fingerprint(f.fact))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id
    AND w.visibility=f.visibility AND w.subject = ANY(CASE WHEN starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') THEN ARRAY[f.source_markdown_slug] ELSE ARRAY['*', f.entity_slug] END)
    AND w.fact_hash = gbrain_fact_fingerprint_v1(f.fact))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id
    AND w.visibility=f.visibility AND w.subject = ANY(CASE WHEN starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') THEN ARRAY[f.source_markdown_slug] ELSE ARRAY['*', f.entity_slug] END)
    AND w.fact_hash = gbrain_fact_fingerprint_v2(f.fact))
  AND EXISTS (SELECT 1 FROM sources s WHERE s.id=f.source_id AND NOT s.archived)
  AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id
    AND p.slug=f.source_markdown_slug AND p.deleted_at IS NOT NULL) AND (f.embedding IS NULL OR f.embedding_model IS DISTINCT FROM $3
  OR f.embedded_text_hash IS DISTINCT FROM md5(f.fact) OR vector_dims(f.embedding)<>$4::int)
        AND octet_length(f.fact) > $5::int ORDER BY f.id LIMIT 10000`, params: [null, ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], 'm1', 1536, 8000] }],
  },
  {
    from: "src/core/facts/slot-tagging.ts:66 tagSlots",
    member: 'listLivePersonTitles',
    run: e => e.listLivePersonTitles('s1', ['people/x', 'people/y']),
    statements: [{ text: `SELECT slug, title FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND type = 'person' AND slug = ANY($2::text[]) AND NOT (lower(COALESCE(pages.frontmatter->>'canonical', '')) IN ('false', 'no')
    OR btrim(COALESCE(pages.frontmatter->>'superseded_by', '')) <> ''
    OR btrim(COALESCE(pages.frontmatter->>'merged_into', '')) <> ''
    OR lower(COALESCE(pages.frontmatter->>'status', '')) ~ '(^|[^a-z])(alias|redirect|redirected)([^a-z]|$)')`, params: ['s1', ['people/x', 'people/y']] }],
  },
  {
    from: "src/core/facts/subject-infer.ts:257 liveFactEntityPage",
    member: 'readLiveFactEntityPage',
    label: "local",
    run: e => e.readLiveFactEntityPage('s1', 'people/x'),
    statements: [{ text: `SELECT p.slug, p.type FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL  LIMIT 1`, params: ['s1', 'people/x'] }],
  },
  {
    from: "src/core/facts/subject-infer.ts:257 liveFactEntityPage",
    member: 'readLiveFactEntityPage',
    label: "excludePrivate",
    run: e => e.readLiveFactEntityPage('s1', 'people/x', true),
    statements: [{ text: `SELECT p.slug, p.type FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL AND ((((p.page_readers IS NULL AND NOT (p.frontmatter ? 'readable_by'))) AND (p.folder_rule_ids IS NULL) AND NOT EXISTS (SELECT 1 FROM access_pending_coverage pc WHERE pc.source_id = p.source_id AND (starts_with(p.slug, pc.prefix) AND (pc.prefix = '' OR right(pc.prefix, 1) = '/' OR p.slug = pc.prefix))) AND NOT (SELECT gbrain_access_state_unreadable()) AND ((p.type NOT IN ('atom', 'question', 'concept', 'event') AND NOT (p.frontmatter ? 'derived_from'))
    OR NOT gbrain_access_origin_restricted(p.id, p.source_id, p.type, p.frontmatter)) AND NOT (EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id >= '' AND (read_source.config->>'kind' IN ('imessage') OR read_source.config->>'owner_only' = 'true')) OR EXISTS (SELECT 1 FROM pg_catalog.pg_description held
  WHERE held.objoid = pg_catalog.to_regclass('public.owner_only_marks') AND held.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND held.objsubid = 0 AND held.description = 'gbrain:owner_only_held (GST-3032): this brain has held owner-only data, so owner-only lineage stays guarded'))) AND ((COALESCE(p.frontmatter->>'visibility', CASE WHEN (p.type IN ('atom', 'question') OR (p.type = 'concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL)) THEN 'private' ELSE 'world' END) <> 'private'
    AND NOT COALESCE(p.frontmatter ? 'pinned_question', false)
    AND NOT (p.frontmatter->>'visibility' IS NULL AND (COALESCE(translate(btrim(p.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('private','restricted','confidential'), false) OR COALESCE(translate(btrim(p.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('confidential','secret','private','restricted'), false))))
    AND NOT (CASE WHEN p.type = 'atom' THEN (EXISTS (SELECT 1 FROM pages derived_origin WHERE derived_origin.source_id = p.source_id
      AND derived_origin.slug = ANY(ARRAY[(p.frontmatter->>'source_slug'), (SELECT renamed.canonical_slug FROM slug_aliases renamed
    WHERE renamed.source_id=p.source_id AND renamed.alias_slug=(p.frontmatter->>'source_slug') AND renamed.notes='rename')]) AND derived_origin.frontmatter->>'visibility' = 'private') OR EXISTS (SELECT 1 FROM slug_rename_history moved JOIN pages moved_to ON moved_to.source_id=moved.source_id
    AND moved_to.slug=moved.new_slug WHERE moved.source_id=p.source_id AND moved.old_slug=(p.frontmatter->>'source_slug')
    AND moved_to.frontmatter->>'visibility'='private'))
    WHEN (p.type IN ('atom', 'question') OR (p.type = 'concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL)) THEN EXISTS (SELECT 1 FROM links derived_input_link
      JOIN pages derived_input ON derived_input.id = derived_input_link.to_page_id
      WHERE derived_input_link.from_page_id = p.id AND derived_input_link.link_source = 'concept-provenance'
        AND derived_input_link.link_type = 'synthesized_from'
        AND (COALESCE(derived_input.frontmatter->>'visibility', CASE WHEN derived_input.type = 'atom' THEN 'private' ELSE 'world' END) = 'private'
          OR EXISTS (SELECT 1 FROM pages derived_input_origin WHERE derived_input_origin.source_id = derived_input.source_id
      AND derived_input_origin.slug = ANY(ARRAY[(derived_input.frontmatter->>'source_slug'), (SELECT renamed.canonical_slug FROM slug_aliases renamed
    WHERE renamed.source_id=derived_input.source_id AND renamed.alias_slug=(derived_input.frontmatter->>'source_slug') AND renamed.notes='rename')]) AND derived_input_origin.frontmatter->>'visibility' = 'private') OR EXISTS (SELECT 1 FROM slug_rename_history moved JOIN pages moved_to ON moved_to.source_id=moved.source_id
    AND moved_to.slug=moved.new_slug WHERE moved.source_id=derived_input.source_id AND moved.old_slug=(derived_input.frontmatter->>'source_slug')
    AND moved_to.frontmatter->>'visibility'='private')))
    WHEN p.type = 'event' AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%' THEN NOT EXISTS (SELECT 1 FROM pages chronicle_origin WHERE chronicle_origin.source_id = p.source_id
      AND chronicle_origin.slug = p.frontmatter->'event'->>'depth'
      AND (COALESCE(chronicle_origin.frontmatter->>'visibility', CASE WHEN (chronicle_origin.type IN ('atom', 'question') OR (chronicle_origin.type = 'concept' AND chronicle_origin.frontmatter->>'synthesized_by' IS NOT NULL)) THEN 'private' ELSE 'world' END) <> 'private'
    AND NOT COALESCE(chronicle_origin.frontmatter ? 'pinned_question', false)
    AND NOT (chronicle_origin.frontmatter->>'visibility' IS NULL AND (COALESCE(translate(btrim(chronicle_origin.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('private','restricted','confidential'), false) OR COALESCE(translate(btrim(chronicle_origin.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('confidential','secret','private','restricted'), false))))
      AND NOT (CASE WHEN jsonb_typeof(chronicle_origin.frontmatter->'derived_from') IN ('array', 'string') THEN EXISTS (
    SELECT 1 FROM pages declared_origin
    WHERE declared_origin.source_id = chronicle_origin.source_id
      AND declared_origin.frontmatter->>'visibility' = 'private'
      AND declared_origin.slug = ANY(ARRAY(
        SELECT regexp_replace(declared.slug, '\\.md$', '') FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(chronicle_origin.frontmatter->'derived_from') = 'array' THEN chronicle_origin.frontmatter->'derived_from'
            ELSE jsonb_build_array(chronicle_origin.frontmatter->'derived_from') END) AS declared(slug)))) ELSE false END))
    ELSE false END)
    AND NOT (CASE WHEN jsonb_typeof(p.frontmatter->'derived_from') IN ('array', 'string') THEN EXISTS (
    SELECT 1 FROM pages declared_origin
    WHERE declared_origin.source_id = p.source_id
      AND declared_origin.frontmatter->>'visibility' = 'private'
      AND declared_origin.slug = ANY(ARRAY(
        SELECT regexp_replace(declared.slug, '\\.md$', '') FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(p.frontmatter->'derived_from') = 'array' THEN p.frontmatter->'derived_from'
            ELSE jsonb_build_array(p.frontmatter->'derived_from') END) AS declared(slug)))) ELSE false END))) LIMIT 1`, params: ['s1', 'people/x'] }],
  },
  {
    from: "src/core/facts/writeback-settings.ts:121 setAgentWriteback",
    member: 'lockAgentWritebackSetting',
    run: e => e.lockAgentWritebackSetting('facts.agent_writeback'),
    statements: [{ text: `SELECT pg_advisory_xact_lock(hashtext($1))`, params: ['facts.agent_writeback'] }],
  },
  {
    from: "src/core/facts/retire.ts:31 retireFactsFromPage",
    member: 'listFactsToRetireFromPage',
    run: e => e.listFactsToRetireFromPage('s1', 'connector:s1:notes/a', 'notes/a', 'notes/a %'),
    statements: [{ text: `SELECT id,row_num,source_markdown_slug,entity_slug FROM facts
    WHERE source_id=$1 AND expired_at IS NULL AND (source_session=$2 OR context=$3 OR context LIKE $4)
    ORDER BY id`, params: ['s1', 'connector:s1:notes/a', 'notes/a', 'notes/a %'] }],
  },
  {
    from: "src/core/facts/contested-claims.ts:36 withDecideContested",
    member: 'listContestedProposalPairs',
    label: "local",
    run: e => e.listContestedProposalPairs([1, 2], { remote: false, excludePrivate: false }),
    statements: [{ text: `SELECT p.id, x.id AS delivered, p.new_fact_id, p.old_fact_id FROM unnest($1::bigint[]) AS x(id)
  JOIN decide_proposals p ON p.status = 'pending' AND (p.new_fact_id = x.id OR p.old_fact_id = x.id)
  JOIN facts n ON n.id = p.new_fact_id AND n.source_id = p.source_id
  JOIN facts o ON o.id = p.old_fact_id AND o.source_id = p.source_id
 WHERE n.expired_at IS NULL AND (n.valid_until IS NULL OR n.valid_until > now()) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = n.source_id
      AND elig_dp.slug = ANY(ARRAY[n.source_markdown_slug, n.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = n.source_id AND elig_qp.slug = n.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = n.id::text) AND o.expired_at IS NULL AND (o.valid_until IS NULL OR o.valid_until > now()) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = o.source_id
      AND elig_dp.slug = ANY(ARRAY[o.source_markdown_slug, o.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = o.source_id AND elig_qp.slug = o.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = o.id::text)
 ORDER BY p.id`, params: [[1, 2]] }],
  },
  {
    from: "src/core/facts/contested-claims.ts:36 withDecideContested",
    member: 'listContestedProposalPairs',
    label: "remote, private hidden",
    run: e => e.listContestedProposalPairs([1, 2], { remote: true, excludePrivate: true }),
    statements: [{ digest: { length: 50374, sha256: 'a3a91758257ac11f8dcf466f56b6dc20cab5423399a4e9e11bf58076479a422f' }, params: [[1, 2]] }],
  },
  {
    from: "src/core/facts/contested-claims.ts:36 withDecideContested",
    member: 'listContestedProposalPairs',
    label: "remote, trust floor",
    run: e => e.listContestedProposalPairs([1, 2], { remote: true, excludePrivate: false, eligibility: { floor: 'user_confirmed', suppressFlagged: true } as never }),
    statements: [{ text: `SELECT p.id, x.id AS delivered, p.new_fact_id, p.old_fact_id FROM unnest($1::bigint[]) AS x(id)
  JOIN decide_proposals p ON p.status = 'pending' AND (p.new_fact_id = x.id OR p.old_fact_id = x.id)
  JOIN facts n ON n.id = p.new_fact_id AND n.source_id = p.source_id
  JOIN facts o ON o.id = p.old_fact_id AND o.source_id = p.source_id
 WHERE n.expired_at IS NULL AND (n.valid_until IS NULL OR n.valid_until > now()) AND n.visibility = 'world' AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = n.source_id
      AND elig_dp.slug = ANY(ARRAY[n.source_markdown_slug, n.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = n.source_id AND elig_qp.slug = n.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = n.id::text) AND n.trust_tier IN ('user_confirmed') AND NOT ((CASE n.trust_tier WHEN 'user_confirmed' THEN 6 WHEN 'operator_curated' THEN 5 WHEN 'tool_observed' THEN 4 WHEN 'agent_written' THEN 3 WHEN 'unknown' THEN 2 WHEN 'external_untrusted' THEN 1 ELSE 0 END) <= 3
    AND EXISTS (SELECT 1 FROM write_gate_receipts elig_r WHERE elig_r.target_table = 'facts' AND elig_r.target_id = n.id::text
      AND elig_r.verdict = 'flag' AND elig_r.reason_families && ARRAY['standing_instruction','override','exfiltration','credential']::text[])) AND o.expired_at IS NULL AND (o.valid_until IS NULL OR o.valid_until > now()) AND o.visibility = 'world' AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = o.source_id
      AND elig_dp.slug = ANY(ARRAY[o.source_markdown_slug, o.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = o.source_id AND elig_qp.slug = o.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = o.id::text) AND o.trust_tier IN ('user_confirmed') AND NOT ((CASE o.trust_tier WHEN 'user_confirmed' THEN 6 WHEN 'operator_curated' THEN 5 WHEN 'tool_observed' THEN 4 WHEN 'agent_written' THEN 3 WHEN 'unknown' THEN 2 WHEN 'external_untrusted' THEN 1 ELSE 0 END) <= 3
    AND EXISTS (SELECT 1 FROM write_gate_receipts elig_r WHERE elig_r.target_table = 'facts' AND elig_r.target_id = o.id::text
      AND elig_r.verdict = 'flag' AND elig_r.reason_families && ARRAY['standing_instruction','override','exfiltration','credential']::text[]))
 ORDER BY p.id`, params: [[1, 2]] }],
  },
  {
    from: "src/core/ops/facts.ts:706 withProvenance",
    member: 'listFactProvenance',
    run: e => e.listFactProvenance('s1', [1, 2]),
    statements: [{ text: `SELECT id, source FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[]) ORDER BY id`, params: ['s1', [1, 2]] }],
  },
  {
    from: "src/core/facts/derivation-inputs.ts:39 recordDerivationInputs",
    member: 'recordDerivationEdges',
    run: e => e.recordDerivationEdges({ table: 'facts', id: '7' }, 's1', [{ table: 'pages', id: '3' }, { table: 'facts', id: '2' }]),
    statements: [{ text: `INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id)
    SELECT $1,$2,e.input_table,e.input_id,$3 FROM jsonb_to_recordset($4::text::jsonb) AS e(input_table text,input_id text)
    ON CONFLICT DO NOTHING`, params: ['facts', '7', 's1', '[{"input_table":"pages","input_id":"3"},{"input_table":"facts","input_id":"2"}]'] }],
  },
  {
    from: "src/core/facts/derivation-inputs.ts:58 derivedRowsFrom",
    member: 'listDerivedRows',
    run: e => e.listDerivedRows([{ table: 'facts', id: '7' }], 1001),
    statements: [{ text: `SELECT DISTINCT d.derived_table,d.derived_id
      FROM derivation_inputs d JOIN jsonb_to_recordset($1::text::jsonb) AS f(input_table text,input_id text)
        ON d.input_table=f.input_table AND d.input_id=f.input_id
      ORDER BY d.derived_table,d.derived_id LIMIT $2`, params: ['[{"input_table":"facts","input_id":"7"}]', 1001] }],
  },
  {
    from: "src/core/facts/derivation-inputs.ts:90 hideDerivedRows",
    member: 'expireDerivedFacts',
    run: e => e.expireDerivedFacts([1, 2], 's1'),
    statements: [{ text: `UPDATE facts SET expired_at=COALESCE(expired_at,now()) WHERE id=ANY($1::bigint[]) AND source_id=$2 RETURNING id`, params: [[1, 2], 's1'] }],
  },
  {
    from: "src/core/facts/derivation-inputs.ts:91 hideDerivedRows",
    member: 'deactivateDerivedTakes',
    run: e => e.deactivateDerivedTakes([3], 's1'),
    statements: [{ text: `UPDATE takes k SET active=false FROM pages p WHERE k.id=ANY($1::bigint[]) AND p.id=k.page_id AND p.source_id=$2 RETURNING k.id`, params: [[3], 's1'] }],
  },
  {
    from: "src/core/facts/derivation-inputs.ts:92 hideDerivedRows",
    member: 'softDeleteDerivedPages',
    run: e => e.softDeleteDerivedPages([4], 's1'),
    statements: [{ text: `WITH gone AS (SELECT id FROM pages WHERE id=ANY($1::integer[]) AND source_id=$2 AND deleted_at IS NOT NULL),
        hid AS (UPDATE pages SET deleted_at=now() WHERE id=ANY($1::integer[]) AND source_id=$2 AND deleted_at IS NULL RETURNING id)
        SELECT id, true AS now FROM hid UNION ALL SELECT id, false AS now FROM gone`, params: [[4], 's1'] }],
  },
  {
    from: "src/core/facts/derivation-inputs.ts:95 hideDerivedRows",
    member: 'markNeedsRederive',
    run: e => e.markNeedsRederive('facts', ['1', '2'], 's1', null, 'why', ['2']),
    statements: [{ text: `INSERT INTO needs_rederive(derived_table,derived_id,source_id,request_id,reason,marked_at)
      SELECT $1,d.id,$3,$4::uuid,$5,COALESCE((SELECT p.deleted_at FROM pages p WHERE d.id=ANY($6::text[]) AND p.id::text=d.id),now()) FROM unnest($2::text[]) AS d(id)
      ON CONFLICT (derived_table,derived_id) DO UPDATE SET reason=EXCLUDED.reason,request_id=EXCLUDED.request_id,
        marked_at=CASE WHEN EXCLUDED.derived_id=ANY($6::text[]) THEN EXCLUDED.marked_at ELSE CASE WHEN needs_rederive.derived_table='pages' AND EXISTS (SELECT 1 FROM pages hp
  WHERE hp.id::text=needs_rederive.derived_id AND hp.deleted_at=needs_rederive.marked_at) THEN needs_rederive.marked_at ELSE now() END END`, params: ['facts', ['1', '2'], 's1', null, 'why', ['2']] }],
  },
  {
    from: "src/core/facts/single-prepare.ts:97 memberPageWithdrawal",
    member: 'readMemberPageWithdrawal',
    run: e => e.readMemberPageWithdrawal({ sourceId: 's1', visibility: 'world', fact: 'F', entitySlug: 'people/x', page: 'memory/members/m1', owner: false, identity: [], satisfied: [] }),
    statements: [{ digest: { length: 16115, sha256: '36f1c0b304fba2d114da48c460bf21a3308d8fc08b8ab332a01739055d73f5d0' }, params: ['s1', 'world', 'F', 'people/x', 'memory/members/m1'] }],
  },
  {
    from: "src/core/facts/single-prepare.ts:106,117 factWithdrawnRefusal (at 8a5229aa8c)",
    member: 'readClaimWithdrawal',
    label: 'remote',
    run: e => e.readClaimWithdrawal({ sourceId: 's1', visibility: 'world', fact: 'F', entitySlug: 'people/x', ownPage: 'memory/members/m1', excludePrivate: true }),
    statements: [
      { digest: { length: 17340, sha256: 'e6494bb95c3c4571460c0da4300f24bd781aae82ab00501c263ea0454533bd4d' }, params: ['s1', 'world', 'F', 'people/x', 'memory/members/m1'] },
      { digest: { length: 9396, sha256: '65a9fd8216e195f50edf644623a55189274a5b8e74c7f20fbc27ff28d949b128' }, params: ['s1', 'world', 'F', 'people/x', true, 'memory/members/m1'] },
    ],
  },
  {
    from: "src/core/facts/single-prepare.ts:117 factWithdrawnRefusal (at 8a5229aa8c)",
    member: 'readClaimWithdrawal',
    label: 'local',
    run: e => e.readClaimWithdrawal({ sourceId: 's1', visibility: 'world', fact: 'F', entitySlug: 'people/x', ownPage: 'memory/members/m1', excludePrivate: false }),
    statements: [{ digest: { length: 9396, sha256: '65a9fd8216e195f50edf644623a55189274a5b8e74c7f20fbc27ff28d949b128' }, params: ['s1', 'world', 'F', 'people/x', false, 'memory/members/m1'] }],
  },
  {
    from: "src/core/facts/single-prepare.ts:215 replacementVisibility",
    member: 'readFactVisibility',
    run: e => e.readFactVisibility(7, 's1'),
    statements: [{ text: `SELECT visibility FROM facts WHERE id=$1 AND source_id=$2`, params: [7, 's1'] }],
  },
  {
    from: "src/core/facts/single-prepare.ts:231 decideReplacement",
    member: 'readReplacementTarget',
    label: "plain",
    run: e => e.readReplacementTarget({ targetId: 7, sourceId: 's1', ownPage: null }),
    statements: [{ text: `SELECT f.*,
      EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
        AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact),gbrain_fact_fingerprint_v2(f.fact),gbrain_fact_fingerprint_v1(f.fact))
        AND (CASE WHEN starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') THEN w.subject = f.source_markdown_slug
    ELSE (w.subject = '*' OR w.subject = COALESCE(f.entity_slug, '*') OR (COALESCE(strpos(f.entity_slug, '/') = 0 AND NOT EXISTS (SELECT 1 FROM pages unbacked_page
    WHERE unbacked_page.source_id = f.source_id AND unbacked_page.slug = f.entity_slug AND unbacked_page.deleted_at IS NULL), false) AND NOT (starts_with(w.subject, 'memory/members/') OR w.subject = 'memory/scope')) OR ((starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') OR COALESCE(f.source_markdown_slug, '') = 'memory/scope') AND w.subject = f.source_markdown_slug)) END)) AS withdrawn
    FROM facts f WHERE f.id=$1 AND f.source_id=$2`, params: [7, 's1'] }],
  },
  {
    from: "src/core/facts/single-prepare.ts:231 decideReplacement",
    member: 'readReplacementTarget',
    label: "excludePrivate",
    run: e => e.readReplacementTarget({ targetId: 7, sourceId: 's1', excludePrivate: true, ownPage: null }),
    statements: [{ digest: { length: 9089, sha256: '248f12b958390ecc43c4db78815aa26cc5cf41224ae2de3cedafa276177e82b1' }, params: [7, 's1'] }],
  },
  {
    from: "src/core/facts/single-prepare.ts:231 decideReplacement",
    member: 'readReplacementTarget',
    label: "excludePrivate, own member page",
    run: e => e.readReplacementTarget({ targetId: 7, sourceId: 's1', excludePrivate: true, ownPage: 'p1' }),
    statements: [{ digest: { length: 9122, sha256: '68ae3aa57f657017bfd032c2cee9af7b9d84e115945a546318349e66b7fd8f84' }, params: [7, 's1', 'p1'] }],
  },
  {
    from: "src/core/facts/single-prepare.ts:231 decideReplacement",
    member: 'readReplacementTarget',
    label: "row lock",
    run: e => e.readReplacementTarget({ targetId: 7, sourceId: 's1', ownPage: null, lock: true }),
    statements: [{ text: `SELECT f.*,
      EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
        AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact),gbrain_fact_fingerprint_v2(f.fact),gbrain_fact_fingerprint_v1(f.fact))
        AND (CASE WHEN starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') THEN w.subject = f.source_markdown_slug
    ELSE (w.subject = '*' OR w.subject = COALESCE(f.entity_slug, '*') OR (COALESCE(strpos(f.entity_slug, '/') = 0 AND NOT EXISTS (SELECT 1 FROM pages unbacked_page
    WHERE unbacked_page.source_id = f.source_id AND unbacked_page.slug = f.entity_slug AND unbacked_page.deleted_at IS NULL), false) AND NOT (starts_with(w.subject, 'memory/members/') OR w.subject = 'memory/scope')) OR ((starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') OR COALESCE(f.source_markdown_slug, '') = 'memory/scope') AND w.subject = f.source_markdown_slug)) END)) AS withdrawn
    FROM facts f WHERE f.id=$1 AND f.source_id=$2 FOR UPDATE OF f`, params: [7, 's1'] }],
  },
  {
    from: "src/core/facts/single-prepare.ts:231 decideReplacement",
    member: 'readReplacementTarget',
    label: "excludePrivate, own member page, row lock",
    run: e => e.readReplacementTarget({ targetId: 7, sourceId: 's1', excludePrivate: true, ownPage: 'p1', lock: true }),
    statements: [{ digest: { length: 9138, sha256: '23dd72adc38f957927ff402acb5695fb399160a1731331b763854e86037299a8' }, params: [7, 's1', 'p1'] }],
  },
  {
    from: "src/core/facts/proposal-supersede.ts:107 loadPairFact",
    member: 'readPairFactRow',
    label: "no lock",
    run: e => e.readPairFactRow(7),
    statements: [{ text: `SELECT id, source_id, entity_slug, visibility, fact, expired_at, valid_from, valid_until, superseded_by, row_num, source_markdown_slug
       FROM facts WHERE id = $1`, params: [7] }],
  },
  {
    from: "src/core/facts/proposal-supersede.ts:107 loadPairFact",
    member: 'readPairFactRow',
    label: "row lock",
    run: e => e.readPairFactRow(7, true),
    statements: [{ text: `SELECT id, source_id, entity_slug, visibility, fact, expired_at, valid_from, valid_until, superseded_by, row_num, source_markdown_slug
       FROM facts WHERE id = $1 FOR UPDATE`, params: [7] }],
  },
  {
    from: "src/core/facts/proposal-supersede.ts:183 expireOld",
    member: 'expireSupersededFact',
    run: e => e.expireSupersededFact({ oldId: 1, sourceId: 's1', newId: 2, until: '2026-01-02T00:00:00.000Z' }),
    statements: [{ text: `UPDATE facts SET expired_at = now(), valid_until = COALESCE($4::timestamptz, GREATEST(valid_from, LEAST(COALESCE(valid_until, now()), now()))), superseded_by = $3
      WHERE id = $1 AND source_id = $2 AND expired_at IS NULL RETURNING id`, params: [1, 's1', 2, '2026-01-02T00:00:00.000Z'] }],
  },
  {
    from: "src/core/facts/proposal-supersede.ts:202 applyUndoDb",
    member: 'restoreSupersededFact',
    run: e => e.restoreSupersededFact({ oldId: 1, sourceId: 's1', expiredAt: '2026-01-01T00:00:00.000Z', validUntil: null, supersededBy: null, expectedSupersededBy: 2 }),
    statements: [{ text: `UPDATE facts SET expired_at = $3::timestamptz, valid_until = $4::timestamptz, superseded_by = $5
      WHERE id = $1 AND source_id = $2 AND superseded_by IS NOT DISTINCT FROM $6 RETURNING id`, params: [1, 's1', '2026-01-01T00:00:00.000Z', null, null, 2] }],
  },
  {
    from: "src/core/facts/forget.ts:166 forgetFactInFence",
    member: 'readFactForForget',
    run: e => e.readFactForForget(7),
    statements: [{ text: `SELECT id, source_id, entity_slug, row_num, source_markdown_slug, expired_at, visibility
       FROM facts WHERE id = $1`, params: [7] }],
  },
  {
    from: "src/core/facts/forget.ts:194 forgetFactInFence",
    member: 'expireFactSuperseded',
    run: e => e.expireFactSuperseded(7, null),
    statements: [{ text: `UPDATE facts SET valid_until = COALESCE($2::timestamptz, GREATEST(valid_from, LEAST(COALESCE(valid_until, now()), now()))), expired_at = now()
      WHERE id = $1 AND expired_at IS NULL`, params: [7, null] }],
  },
  {
    from: "src/core/facts/forget.ts:359 forgetFactInFence",
    member: 'expireFactAtDate',
    run: e => e.expireFactAtDate(7, '2026-01-02'),
    statements: [{ text: `UPDATE facts SET valid_until = $1, expired_at = now()
         WHERE id = $2 AND expired_at IS NULL`, params: ['2026-01-02', 7] }],
  },
  {
    from: "src/core/facts/proposal-review.ts:41 staleReason",
    member: 'readWithdrawalAnchor',
    run: e => e.readWithdrawalAnchor(7, 's1'),
    statements: [{ text: `SELECT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = f.source_id AND w.visibility = f.visibility
        AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v2(f.fact), gbrain_fact_fingerprint_v1(f.fact))
        AND (CASE WHEN starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') THEN w.subject = f.source_markdown_slug
    ELSE (w.subject = '*' OR w.subject = COALESCE(f.entity_slug, '*') OR (COALESCE(strpos(f.entity_slug, '/') = 0 AND NOT EXISTS (SELECT 1 FROM pages unbacked_page
    WHERE unbacked_page.source_id = f.source_id AND unbacked_page.slug = f.entity_slug AND unbacked_page.deleted_at IS NULL), false) AND NOT (starts_with(w.subject, 'memory/members/') OR w.subject = 'memory/scope')) OR ((starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') OR COALESCE(f.source_markdown_slug, '') = 'memory/scope') AND w.subject = f.source_markdown_slug)) END)) AS withdrawn
       FROM facts f WHERE f.id = $1 AND f.source_id = $2`, params: [7, 's1'] }],
  },
  {
    from: "src/core/facts/proposal-review.ts:47 staleReason",
    member: 'readFactActivity',
    run: e => e.readFactActivity(8, 's1'),
    statements: [{ text: `SELECT (expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())) AS active, md5(fact) AS text_hash
       FROM facts WHERE id = $1 AND source_id = $2`, params: [8, 's1'] }],
  },
  {
    from: "src/core/facts/proposal-review.ts:78 acceptReviewProposal",
    member: 'readReviewAcceptedMark',
    run: e => e.readReviewAcceptedMark(8, 's1', '(review r5)'),
    statements: [{ text: `SELECT id FROM facts WHERE id = $1 AND source_id = $2 AND expired_at IS NOT NULL
      AND strpos(COALESCE(context, ''), $3) > 0`, params: [8, 's1', '(review r5)'] }],
  },
  {
    from: "src/core/facts/fts-index.ts:28 indexState",
    member: 'readFactsFtsIndexState',
    run: e => e.readFactsFtsIndexState('idx_facts_fts'),
    statements: [{ text: `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i WHERE i.indexrelid = to_regclass($1)`, params: ['idx_facts_fts'] }],
  },
  {
    from: "src/core/facts/fts-index.ts:54 ensureFactsFtsIndex",
    member: 'swapFactsFtsIndex',
    run: e => e.swapFactsFtsIndex(),
    statements: [{ text: `ALTER INDEX IF EXISTS idx_facts_fts RENAME TO idx_facts_fts_old` },
      { text: `ALTER INDEX idx_facts_fts_next RENAME TO idx_facts_fts` }],
  },
  {
    from: "src/core/search/fact-relevance.ts:157 factsEmbeddingColumn",
    member: 'readFactsEmbeddingColumn',
    run: e => e.readFactsEmbeddingColumn(),
    statements: [{ text: `SELECT t.typname AS type, a.atttypmod AS dims FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
     WHERE a.attrelid = to_regclass('facts') AND a.attname = 'embedding' AND NOT a.attisdropped` }],
  },
  {
    from: "src/core/facts/question-recall.ts:238 recallQuestion",
    member: 'listFactRowsByIds',
    run: e => e.listFactRowsByIds(['s1', 's2'], [1, 2]),
    statements: [{ text: `SELECT * FROM facts WHERE source_id = ANY($1::text[]) AND id = ANY($2::bigint[])`, params: [['s1', 's2'], [1, 2]] }],
  },
  {
    from: 'src/core/search/transcript-quote.ts:135 factsFromQuotedPages (at c33606182c)',
    member: 'listFactsFromQuotedPages',
    run: e => e.listFactsFromQuotedPages({ ids: [3, 1, 3], pageTypes: ['chat', 'transcript'], backstop: [['sync:import', 'sync:'], ['mcp:put_page', 'put_page:']] }),
    statements: [{ text: `SELECT f.id FROM facts f WHERE f.id = ANY($1::bigint[]) AND (
       EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND p.type = ANY($2::text[]))
       OR EXISTS (SELECT 1 FROM derivation_inputs d JOIN pages p ON p.id = (CASE WHEN d.input_id ~ '^[0-9]{1,18}$' THEN d.input_id::bigint END)
         WHERE d.derived_table = 'facts' AND d.derived_id = f.id::text AND d.input_table = 'pages' AND p.type = ANY($2::text[]))
       OR EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.type = ANY($2::text[]) AND p.slug = (CASE
         WHEN f.source = $3::text AND left(f.source_session, length($4::text)) = $4::text THEN substr(f.source_session, length($4::text) + 1)
         WHEN f.source = $5::text AND left(f.source_session, length($6::text)) = $6::text THEN substr(f.source_session, length($6::text) + 1) END)))`, params: [[3, 1], ['chat', 'transcript'], 'sync:import', 'sync:', 'mcp:put_page', 'put_page:'] }],
  },
  {
    from: 'src/core/search/transcript-quote.ts:510 ownerTierFacts (at c33606182c)',
    member: 'listOwnerTierFacts',
    run: e => e.listOwnerTierFacts({ ids: [3, 1, 3], floor: 'agent_written' }),
    statements: [{ text: `SELECT id FROM facts WHERE id = ANY($1::bigint[]) AND (CASE trust_tier WHEN 'user_confirmed' THEN 6 WHEN 'operator_curated' THEN 5 WHEN 'tool_observed' THEN 4 WHEN 'agent_written' THEN 3 WHEN 'unknown' THEN 2 WHEN 'external_untrusted' THEN 1 ELSE 0 END) >= $2::int`, params: [[3, 1], 3] }],
  },
  {
    from: 'src/core/search/slot-history.ts:88 entityKeys (at c33606182c)',
    member: 'listReadablePageSlugs',
    label: 'local scope',
    run: e => e.listReadablePageSlugs('s1', ['people/carol', 'companies/carol'], { sourceId: 's1', worldOnly: false, excludePrivate: false } as never, 2),
    statements: [{ text: `SELECT p.slug FROM pages p WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND p.deleted_at IS NULL AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'quarantine') AND EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id = p.source_id AND NOT read_source.archived) LIMIT 2`, params: ['s1', ['people/carol', 'companies/carol']] }],
  },
  {
    from: 'src/core/search/slot-history.ts:88 entityKeys (at c33606182c)',
    member: 'listReadablePageSlugs',
    label: 'remote scope, trust floor, two sources (the source filter is not applied)',
    run: e => e.listReadablePageSlugs('s1', ['people/carol', 'companies/carol'], scopeB, 2),
    statements: [{ digest: { length: 8110, sha256: 'cb5872de62eaaa5fd673b6c3afdfab503b21e5ea298a969d8c2f032ab455b7df' }, params: ['s1', ['people/carol', 'companies/carol']] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:277 readSlotRows",
    member: 'listSlotRows',
    label: "one source",
    run: e => e.listSlotRows(scopeA, [{ source_id: 's1', entity_slug: 'people/x', dimension: 'role' }, { source_id: 's1', entity_slug: 'people/y', dimension: 'city' }]),
    statements: [{ text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash FROM facts f
     WHERE f.source_id = ANY($1::text[]) AND f.source != ALL($2::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND f.dimension IS NOT NULL AND f.value_hash IS NOT NULL AND COALESCE(f.dim_status, 'active') = 'active' AND COALESCE(source, '') LIKE 'cli:extract-conversation-facts%'
       AND (f.source_id, f.entity_slug, f.dimension) IN (SELECT * FROM unnest($3::text[], $4::text[], $5::text[]))
     ORDER BY f.valid_from, f.id`, params: [['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], ['s1', 's1'], ['people/x', 'people/y'], ['role', 'city']] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:277 readSlotRows",
    member: 'listSlotRows',
    label: "remote, trust floor, two sources",
    run: e => e.listSlotRows(scopeB, [{ source_id: 's1', entity_slug: 'people/x', dimension: 'role' }, { source_id: 's1', entity_slug: 'people/y', dimension: 'city' }]),
    statements: [{ digest: { length: 26314, sha256: '566a0d10f739436b1ebf4c5e1c3c55683dbe83b740b3cf88f5a95a514e2a56bf' }, params: [['s1', 's2'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], ['s1', 's1'], ['people/x', 'people/y'], ['role', 'city']] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:293 poolUnbackedKeys",
    member: 'listPoolUnbackedKeys',
    label: "one source",
    run: e => e.listPoolUnbackedKeys(scopeA, ['people/x', 'people/y'], 5),
    statements: [{ text: `SELECT DISTINCT f.source_id COLLATE "C", f.entity_slug COLLATE "C" FROM facts f WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($2::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.entity_slug = ANY($3::text[])
       AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
     ORDER BY f.source_id COLLATE "C", f.entity_slug COLLATE "C" LIMIT $4`, params: [['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], ['people/x', 'people/y'], 5] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:293 poolUnbackedKeys",
    member: 'listPoolUnbackedKeys',
    label: "remote, trust floor, two sources",
    run: e => e.listPoolUnbackedKeys(scopeB, ['people/x'], 3),
    statements: [{ digest: { length: 26129, sha256: '9a3b8ac9c1f38568d08233187437c829ff3bf12c375e3464ee9309b617b2d29f' }, params: [['s1', 's2'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], ['people/x'], 3] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:324 laterRetractions",
    member: 'listCallOffCueFacts',
    label: "one source",
    run: e => e.listCallOffCueFacts(scopeA, [{ source_id: 's1', entity_slug: 'people/x' }, { source_id: 's1', entity_slug: 'people/y' }, { source_id: 's2', entity_slug: 'people/x' }]),
    statements: [{ text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash FROM (SELECT f.*, row_number() OVER (PARTITION BY f.source_id, f.entity_slug ORDER BY (CASE WHEN f.valid_from > now() THEN f.created_at ELSE f.valid_from END) DESC, f.id DESC) AS call_off_rank
       FROM facts f WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($2::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.fact ~* $3
         AND (f.source_id, f.entity_slug) IN (SELECT * FROM unnest($4::text[], $5::text[]))) f
     WHERE f.call_off_rank <= $6`, params: [['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], CALL_OFF_REGEX, ['s1', 's1', 's2'], ['people/x', 'people/y', 'people/x'], 50] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:324 laterRetractions",
    member: 'listCallOffCueFacts',
    label: "remote, trust floor, two sources",
    run: e => e.listCallOffCueFacts(scopeB, [{ source_id: 's1', entity_slug: 'people/x' }]),
    statements: [{ digest: { length: 26390, sha256: '84a0e5de167c674105336f8a3d56f4641ae07f1f4231afbb18ce870bf63dc208' }, params: [['s1', 's2'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], CALL_OFF_REGEX, ['s1'], ['people/x'], 50] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:355 poolEntityPairs",
    member: 'listPoolEntityPairs',
    label: "no filters",
    run: e => e.listPoolEntityPairs(scopeA, {}),
    statements: [{ text: `SELECT DISTINCT f.source_id COLLATE "C", f.entity_slug COLLATE "C" FROM facts f WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($2::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.entity_slug IS NOT NULL ORDER BY f.source_id COLLATE "C", f.entity_slug COLLATE "C"`, params: [['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal']] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:355 poolEntityPairs",
    member: 'listPoolEntityPairs',
    label: "remote, trust floor, every filter",
    run: e => e.listPoolEntityPairs(scopeB, { entities: [{ sourceId: 's1', slug: 'people/x' }], sessionId: 'sess', since: new Date('2026-01-02T03:04:05Z'), grep: 'a_b', includeExpired: true }),
    statements: [{ digest: { length: 26079, sha256: '949066e0f24ccf7c220c4ff813c1afa15ff6a0e335d58ff6558f1ed930e4b2ce' }, params: [['s1', 's2'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], ['s1'], ['people/x'], 'sess', '2026-01-02T03:04:05.000Z', '%a\\_b%'] }],
  },
  {
    from: 'src/core/search/fact-relevance.ts:224 collectFactCandidates (nearest); the text is the NEW renumbered one, see the header',
    member: 'listNearestFacts',
    label: "column without declared dimensions",
    run: e => e.listNearestFacts({ scope: scopeA, vector: VEC, declared: false, limit: 7 }),
    statements: [{ text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, f.similarity FROM (
       SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, CASE WHEN f.embedding IS NOT NULL AND f.embedding_model = $1 AND f.embedded_text_hash = md5(f.fact) AND vector_dims(f.embedding) = $2 THEN 1 - (f.embedding <=> $3::vector) END AS similarity, f.embedding <=> $4::vector AS distance FROM facts f WHERE f.source_id = ANY($5::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($6::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.embedding IS NOT NULL AND f.embedding_model = $7 AND vector_dims(f.embedding) = $8
        ORDER BY f.embedding <=> $9::vector LIMIT $10) f
       ORDER BY f.distance, f.id`, params: ['openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', '[0,0.1,0.2,0.3]', ['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], 'openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', 7] }],
  },
  {
    from: 'src/core/search/fact-relevance.ts:224 collectFactCandidates (nearest); the text is the NEW renumbered one, see the header',
    member: 'listNearestFacts',
    label: "column with declared dimensions",
    run: e => e.listNearestFacts({ scope: scopeA, vector: VEC, declared: true, limit: 7 }),
    statements: [{ text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, f.similarity FROM (
       SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, CASE WHEN f.embedding IS NOT NULL AND f.embedding_model = $1 AND f.embedded_text_hash = md5(f.fact) AND vector_dims(f.embedding) = $2 THEN 1 - (f.embedding <=> $3::vector) END AS similarity, f.embedding <=> $4::vector AS distance FROM facts f WHERE f.source_id = ANY($5::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($6::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.embedding IS NOT NULL AND f.embedding_model = $7
        ORDER BY f.embedding <=> $8::vector LIMIT $9) f
       ORDER BY f.distance, f.id`, params: ['openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', '[0,0.1,0.2,0.3]', ['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], 'openai:text-embedding-3-large', '[0,0.1,0.2,0.3]', 7] }],
  },
  {
    from: 'src/core/search/fact-relevance.ts:224 collectFactCandidates (nearest); the text is the NEW renumbered one, see the header',
    member: 'listNearestFacts',
    label: "halfvec column",
    run: e => e.listNearestFacts({ scope: scopeA, vector: { ...VEC, type: 'halfvec' }, declared: false, limit: 7 }),
    statements: [{ text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, f.similarity FROM (
       SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, CASE WHEN f.embedding IS NOT NULL AND f.embedding_model = $1 AND f.embedded_text_hash = md5(f.fact) AND vector_dims(f.embedding) = $2 THEN 1 - (f.embedding <=> $3::halfvec) END AS similarity, f.embedding <=> $4::halfvec AS distance FROM facts f WHERE f.source_id = ANY($5::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($6::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.embedding IS NOT NULL AND f.embedding_model = $7 AND vector_dims(f.embedding) = $8
        ORDER BY f.embedding <=> $9::halfvec LIMIT $10) f
       ORDER BY f.distance, f.id`, params: ['openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', '[0,0.1,0.2,0.3]', ['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], 'openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', 7] }],
  },
  {
    from: 'src/core/search/fact-relevance.ts:224 collectFactCandidates (nearest); the text is the NEW renumbered one, see the header',
    member: 'listNearestFacts',
    label: "hnsw iterative scan strict_order: version read, settings read, settings set, select, settings reset",
    run: e => e.listNearestFacts({ scope: scopeA, vector: VEC, declared: false, limit: 7, hnswIterativeScan: 'strict_order' }),
    responder: s => /pg_extension/.test(s.text) ? [{ extversion: '0.8.0' }] : undefined,
    statements: [{ text: `SELECT extversion FROM pg_extension WHERE extname = 'vector'`, params: [] },
      { text: `SELECT name, current_setting(name, true) AS value FROM unnest($1::text[]) AS settings(name)`, params: [['hnsw.ef_search','hnsw.iterative_scan','hnsw.max_scan_tuples']] },
      { text: `SELECT set_config(name, value, true) FROM unnest($1::text[], $2::text[]) AS settings(name, value)`, params: [['hnsw.ef_search','hnsw.iterative_scan','hnsw.max_scan_tuples'],['40','strict_order','20000']] },
      { text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, f.similarity FROM (
       SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, CASE WHEN f.embedding IS NOT NULL AND f.embedding_model = $1 AND f.embedded_text_hash = md5(f.fact) AND vector_dims(f.embedding) = $2 THEN 1 - (f.embedding <=> $3::vector) END AS similarity, f.embedding <=> $4::vector AS distance FROM facts f WHERE f.source_id = ANY($5::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($6::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.embedding IS NOT NULL AND f.embedding_model = $7 AND vector_dims(f.embedding) = $8
        ORDER BY f.embedding <=> $9::vector LIMIT $10) f
       ORDER BY f.distance, f.id`, params: ['openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', '[0,0.1,0.2,0.3]', ['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], 'openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', 7] },
      { text: `SELECT set_config(name, value, true) FROM unnest($1::text[], $2::text[]) AS settings(name, value)`, params: [[],[]] }],
  },
  {
    from: 'src/core/search/fact-relevance.ts:224 collectFactCandidates (nearest); the text is the NEW renumbered one, see the header',
    member: 'listNearestFacts',
    label: "hnsw iterative scan off: only ef_search is set",
    run: e => e.listNearestFacts({ scope: scopeA, vector: VEC, declared: false, limit: 7, hnswIterativeScan: 'off' }),
    responder: s => /pg_extension/.test(s.text) ? [{ extversion: '0.8.0' }] : undefined,
    statements: [{ text: `SELECT name, current_setting(name, true) AS value FROM unnest($1::text[]) AS settings(name)`, params: [['hnsw.ef_search']] },
      { text: `SELECT set_config(name, value, true) FROM unnest($1::text[], $2::text[]) AS settings(name, value)`, params: [['hnsw.ef_search'],['40']] },
      { text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, f.similarity FROM (
       SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, CASE WHEN f.embedding IS NOT NULL AND f.embedding_model = $1 AND f.embedded_text_hash = md5(f.fact) AND vector_dims(f.embedding) = $2 THEN 1 - (f.embedding <=> $3::vector) END AS similarity, f.embedding <=> $4::vector AS distance FROM facts f WHERE f.source_id = ANY($5::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($6::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.embedding IS NOT NULL AND f.embedding_model = $7 AND vector_dims(f.embedding) = $8
        ORDER BY f.embedding <=> $9::vector LIMIT $10) f
       ORDER BY f.distance, f.id`, params: ['openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', '[0,0.1,0.2,0.3]', ['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], 'openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', 7] },
      { text: `SELECT set_config(name, value, true) FROM unnest($1::text[], $2::text[]) AS settings(name, value)`, params: [[],[]] }],
  },
  {
    from: 'src/core/search/slot-history.ts:88 entityKeys (at c33606182c)',
    member: 'listReadablePageSlugs',
    label: 'local scope',
    run: e => e.listReadablePageSlugs('s1', ['people/carol', 'companies/carol'], { sourceId: 's1', worldOnly: false, excludePrivate: false } as never, 2),
    statements: [{ text: `SELECT p.slug FROM pages p WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND p.deleted_at IS NULL AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'quarantine') AND EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id = p.source_id AND NOT read_source.archived) LIMIT 2`, params: ['s1', ['people/carol', 'companies/carol']] }],
  },
  {
    from: 'src/core/search/slot-history.ts:88 entityKeys (at c33606182c)',
    member: 'listReadablePageSlugs',
    label: 'remote scope, trust floor, two sources (the source filter is not applied)',
    run: e => e.listReadablePageSlugs('s1', ['people/carol', 'companies/carol'], scopeB, 2),
    statements: [{ digest: { length: 8110, sha256: 'cb5872de62eaaa5fd673b6c3afdfab503b21e5ea298a969d8c2f032ab455b7df' }, params: ['s1', ['people/carol', 'companies/carol']] }],
  },
];

describe('caller raw SQL moved into facts write-path and recall members keeps its Postgres text byte for byte', () => {
  for (const pin of PINS) {
    test(`${pin.member}${pin.label ? ` (${pin.label})` : ''} <- ${pin.from}`, async () => {
      const { engine, statements } = recordingEngine(pin.responder);
      await pin.run(engine);
      const sent = statements();
      expect(sent.length).toBe(pin.statements.length);
      pin.statements.forEach((want, i) => {
        if (want.digest) {
          expect(sent[i]!.text.length).toBe(want.digest.length);
          expect(createHash('sha256').update(sent[i]!.text).digest('hex')).toBe(want.digest.sha256);
        } else expect(sent[i]!.text).toBe(want.text!);
        if (want.params !== undefined) expect(sent[i]!.params).toEqual(want.params);
        else expect(sent[i]!.params.length).toBe(0);
      });
    });
  }
});
