/**
 * The facts write-path and recall pool members that replaced raw `executeRaw` sites (engine-sql/facts-trust.ts and
 * facts-recall.ts) send Postgres the statement text and binds their callers sent before the move, in the same order. A
 * drift here changes a query plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member's recorded statements (text and params, in order) equal what its caller sent through
 *    `executeRaw` at 2eb69f4613. Static texts below are copied from the callers at that commit. A text a caller built from
 *    shared builders (the read-policy fragments, the trust floor, the withdrawal predicates, the pool WHERE) is the text that
 *    caller rendered at that commit, captured by running the unchanged callers against a recording engine; one over
 *    3000 characters is pinned by its length and SHA-256 instead of being copied. One member differs on purpose:
 *    `listNearestFacts` sends the same statement with its placeholders renumbered, because the old text bound the model, the
 *    dimensions and the vector literal once and referenced them from two places, while the member binds each twice
 *    (the pool WHERE placeholders now follow the similarity expression's). The statement means the same; its params are
 *    [model, dims, literal, ...pool params, model, dims, literal, limit], and dims bind only once when the column has declared
 *    dimensions (the pool then skips its vector_dims filter). This is the same shape listFactsForRelevance
 *    has used since lane 4's first batch.
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
const scopeB = { sourceIds: ['s1', 's2'], worldOnly: true, excludePrivate: true, minTrust: 'verified_user', suppressFlagged: true } as never;
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
    OR NOT gbrain_access_origin_restricted(p.id, p.source_id, p.type, p.frontmatter)) AND NOT EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id >= '' AND (read_source.config->>'kind' IN ('imessage') OR read_source.config->>'owner_only' = 'true'))) AND ((COALESCE(p.frontmatter->>'visibility', CASE WHEN (p.type IN ('atom', 'question') OR (p.type = 'concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL)) THEN 'private' ELSE 'world' END) <> 'private'
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
    statements: [{ digest: { length: 47550, sha256: '67c554205a39bc23051b6838e76d8c1f30ee3f80c1772328192be5048d72cdbf' }, params: [[1, 2]] }],
  },
  {
    from: "src/core/facts/contested-claims.ts:36 withDecideContested",
    member: 'listContestedProposalPairs',
    label: "remote, trust floor",
    run: e => e.listContestedProposalPairs([1, 2], { remote: true, excludePrivate: false, eligibility: { floor: 'verified_user', suppressFlagged: true } as never }),
    statements: [{ text: `SELECT p.id, x.id AS delivered, p.new_fact_id, p.old_fact_id FROM unnest($1::bigint[]) AS x(id)
  JOIN decide_proposals p ON p.status = 'pending' AND (p.new_fact_id = x.id OR p.old_fact_id = x.id)
  JOIN facts n ON n.id = p.new_fact_id AND n.source_id = p.source_id
  JOIN facts o ON o.id = p.old_fact_id AND o.source_id = p.source_id
 WHERE n.expired_at IS NULL AND (n.valid_until IS NULL OR n.valid_until > now()) AND n.visibility = 'world' AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = n.source_id
      AND elig_dp.slug = ANY(ARRAY[n.source_markdown_slug, n.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = n.source_id AND elig_qp.slug = n.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = n.id::text) AND n.trust_tier IN () AND NOT ((CASE n.trust_tier WHEN 'user_confirmed' THEN 6 WHEN 'operator_curated' THEN 5 WHEN 'tool_observed' THEN 4 WHEN 'agent_written' THEN 3 WHEN 'unknown' THEN 2 WHEN 'external_untrusted' THEN 1 ELSE 0 END) <= 3
    AND EXISTS (SELECT 1 FROM write_gate_receipts elig_r WHERE elig_r.target_table = 'facts' AND elig_r.target_id = n.id::text
      AND elig_r.verdict = 'flag' AND elig_r.reason_families && ARRAY['standing_instruction','override','exfiltration','credential']::text[])) AND o.expired_at IS NULL AND (o.valid_until IS NULL OR o.valid_until > now()) AND o.visibility = 'world' AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = o.source_id
      AND elig_dp.slug = ANY(ARRAY[o.source_markdown_slug, o.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = o.source_id AND elig_qp.slug = o.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = o.id::text) AND o.trust_tier IN () AND NOT ((CASE o.trust_tier WHEN 'user_confirmed' THEN 6 WHEN 'operator_curated' THEN 5 WHEN 'tool_observed' THEN 4 WHEN 'agent_written' THEN 3 WHEN 'unknown' THEN 2 WHEN 'external_untrusted' THEN 1 ELSE 0 END) <= 3
    AND EXISTS (SELECT 1 FROM write_gate_receipts elig_r WHERE elig_r.target_table = 'facts' AND elig_r.target_id = o.id::text
      AND elig_r.verdict = 'flag' AND elig_r.reason_families && ARRAY['standing_instruction','override','exfiltration','credential']::text[]))
 ORDER BY p.id`, params: [[1, 2]] }],
  },
  {
    from: "src/core/ops/facts.ts:706 withProvenance",
    member: 'listFactProvenance',
    run: e => e.listFactProvenance('s1', [1, 2]),
    statements: [{ text: `SELECT id, source FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[])`, params: ['s1', [1, 2]] }],
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
    statements: [{ digest: { length: 24886, sha256: '579c0b0473445651ff951471ca2e9173b32067a273f2a9858232d64662aac816' }, params: [['s1', 's2'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], ['s1', 's1'], ['people/x', 'people/y'], ['role', 'city']] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:293 poolUnbackedKeys",
    member: 'listPoolUnbackedKeys',
    label: "one source",
    run: e => e.listPoolUnbackedKeys(scopeA, ['people/x', 'people/y'], 5),
    statements: [{ text: `SELECT DISTINCT f.source_id, f.entity_slug FROM facts f WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($2::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.entity_slug = ANY($3::text[])
       AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
     ORDER BY f.source_id, f.entity_slug LIMIT $4`, params: [['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], ['people/x', 'people/y'], 5] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:293 poolUnbackedKeys",
    member: 'listPoolUnbackedKeys',
    label: "remote, trust floor, two sources",
    run: e => e.listPoolUnbackedKeys(scopeB, ['people/x'], 3),
    statements: [{ digest: { length: 24653, sha256: '6f7fae9afcfcd429acfa7b19f67898e5e16c6e1d71f6d12beadd0eb3385518a4' }, params: [['s1', 's2'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], ['people/x'], 3] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:324 laterRetractions",
    member: 'listCallOffCueFacts',
    label: "one source",
    run: e => e.listCallOffCueFacts(scopeA, [{ source_id: 's1', entity_slug: 'people/x' }, { source_id: 's1', entity_slug: 'people/y' }, { source_id: 's2', entity_slug: 'people/x' }]),
    statements: [{ text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash FROM (SELECT f.*, row_number() OVER (PARTITION BY f.source_id, f.entity_slug ORDER BY f.valid_from DESC, f.id DESC) AS call_off_rank
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
    statements: [{ digest: { length: 24902, sha256: '60a6240b932bf607cc743f86e522db8747d6fc122d683959317a1d6b0c8bdf83' }, params: [['s1', 's2'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], CALL_OFF_REGEX, ['s1'], ['people/x'], 50] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:355 poolEntityPairs",
    member: 'listPoolEntityPairs',
    label: "no filters",
    run: e => e.listPoolEntityPairs(scopeA, {}),
    statements: [{ text: `SELECT DISTINCT f.source_id, f.entity_slug FROM facts f WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($2::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.entity_slug IS NOT NULL ORDER BY f.source_id, f.entity_slug`, params: [['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal']] }],
  },
  {
    from: "src/core/search/fact-relevance.ts:355 poolEntityPairs",
    member: 'listPoolEntityPairs',
    label: "remote, trust floor, every filter",
    run: e => e.listPoolEntityPairs(scopeB, { entities: [{ sourceId: 's1', slug: 'people/x' }], sessionId: 'sess', since: new Date('2026-01-02T03:04:05Z'), grep: 'a_b', includeExpired: true }),
    statements: [{ digest: { length: 24603, sha256: '287ccb4d542d8cdddbc18b6df8dbf3f8883f44e5d69a81c9092a406cf30231ef' }, params: [['s1', 's2'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], ['s1'], ['people/x'], 'sess', '2026-01-02T03:04:05.000Z', '%a\\_b%'] }],
  },
  {
    from: 'src/core/search/fact-relevance.ts:224 collectFactCandidates (nearest); the text is the NEW renumbered one, see the header',
    member: 'listNearestFacts',
    label: "column without declared dimensions",
    run: e => e.listNearestFacts({ scope: scopeA, vector: VEC, declared: false, limit: 7 }),
    statements: [{ text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, CASE WHEN f.embedding IS NOT NULL AND f.embedding_model = $1 AND f.embedded_text_hash = md5(f.fact) AND vector_dims(f.embedding) = $2 THEN 1 - (f.embedding <=> $3::vector) END AS similarity FROM facts f WHERE f.source_id = ANY($4::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($5::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.embedding IS NOT NULL AND f.embedding_model = $6 AND vector_dims(f.embedding) = $7
       ORDER BY f.embedding <=> $8::vector LIMIT $9`, params: ['openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', ['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], 'openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', 7] }],
  },
  {
    from: 'src/core/search/fact-relevance.ts:224 collectFactCandidates (nearest); the text is the NEW renumbered one, see the header',
    member: 'listNearestFacts',
    label: "column with declared dimensions",
    run: e => e.listNearestFacts({ scope: scopeA, vector: VEC, declared: true, limit: 7 }),
    statements: [{ text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, CASE WHEN f.embedding IS NOT NULL AND f.embedding_model = $1 AND f.embedded_text_hash = md5(f.fact) AND vector_dims(f.embedding) = $2 THEN 1 - (f.embedding <=> $3::vector) END AS similarity FROM facts f WHERE f.source_id = ANY($4::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($5::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.embedding IS NOT NULL AND f.embedding_model = $6
       ORDER BY f.embedding <=> $7::vector LIMIT $8`, params: ['openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', ['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], 'openai:text-embedding-3-large', '[0,0.1,0.2,0.3]', 7] }],
  },
  {
    from: 'src/core/search/fact-relevance.ts:224 collectFactCandidates (nearest); the text is the NEW renumbered one, see the header',
    member: 'listNearestFacts',
    label: "halfvec column",
    run: e => e.listNearestFacts({ scope: scopeA, vector: { ...VEC, type: 'halfvec' }, declared: false, limit: 7 }),
    statements: [{ text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, CASE WHEN f.embedding IS NOT NULL AND f.embedding_model = $1 AND f.embedded_text_hash = md5(f.fact) AND vector_dims(f.embedding) = $2 THEN 1 - (f.embedding <=> $3::halfvec) END AS similarity FROM facts f WHERE f.source_id = ANY($4::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($5::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.embedding IS NOT NULL AND f.embedding_model = $6 AND vector_dims(f.embedding) = $7
       ORDER BY f.embedding <=> $8::halfvec LIMIT $9`, params: ['openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', ['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], 'openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', 7] }],
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
      { text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, CASE WHEN f.embedding IS NOT NULL AND f.embedding_model = $1 AND f.embedded_text_hash = md5(f.fact) AND vector_dims(f.embedding) = $2 THEN 1 - (f.embedding <=> $3::vector) END AS similarity FROM facts f WHERE f.source_id = ANY($4::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($5::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.embedding IS NOT NULL AND f.embedding_model = $6 AND vector_dims(f.embedding) = $7
       ORDER BY f.embedding <=> $8::vector LIMIT $9`, params: ['openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', ['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], 'openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', 7] },
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
      { text: `SELECT f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash, CASE WHEN f.embedding IS NOT NULL AND f.embedding_model = $1 AND f.embedded_text_hash = md5(f.fact) AND vector_dims(f.embedding) = $2 THEN 1 - (f.embedding <=> $3::vector) END AS similarity FROM facts f WHERE f.source_id = ANY($4::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($5::text[]) AND NOT EXISTS (SELECT 1 FROM pages qp WHERE qp.source_id = f.source_id AND qp.slug = f.source_markdown_slug AND NOT NOT (COALESCE(qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM pages elig_dp WHERE elig_dp.source_id = f.source_id
      AND elig_dp.slug = ANY(ARRAY[f.source_markdown_slug, f.entity_slug]) AND elig_dp.deleted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = f.source_id AND elig_qp.slug = f.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND (COALESCE(elig_qp.frontmatter, '{}'::jsonb) ? 'quarantine')) AND NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = 'facts' AND elig_nr.derived_id = f.id::text) AND f.embedding IS NOT NULL AND f.embedding_model = $6 AND vector_dims(f.embedding) = $7
       ORDER BY f.embedding <=> $8::vector LIMIT $9`, params: ['openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', ['s1'], ['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal'], 'openai:text-embedding-3-large', 4, '[0,0.1,0.2,0.3]', 7] },
      { text: `SELECT set_config(name, value, true) FROM unnest($1::text[], $2::text[]) AS settings(name, value)`, params: [[],[]] }],
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
