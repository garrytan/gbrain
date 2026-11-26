/**
 * Byte-identical pins for the caller raw SQL that became typed engine members (Rust engine lane 11).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text its caller ran through `executeRaw` before the
 *    move. Each expected text below is copied verbatim from the caller at 7470c703ed, or at the commit its `from`
 *    names, except where a pin's comment names an equivalent statement.
 *  - Regression: an edited statement changes what Postgres and PGLite answer while the parity cases may still pass on
 *    a small fixture.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts),
 *    and these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records the text; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { makeEngineWithFake, runCase, withPinnedSqlEnvironment, type SqlCase } from './helpers/postgres-engine-sql-cases.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { edgeTrimSql } from '../src/core/edge-whitespace.ts';
import { budgetRowAppliesFilter } from '../src/core/page-size-policy.ts';
import { chunkGenerationFilter, chunkGenerationProbe, requiresSafeChunks, safeChunksFilter, servedTextProjectionFilter } from '../src/core/search/safe-chunks.ts';
import { TIMELINE_SEPARATOR } from '../src/core/page-window/document.ts';
import { quoteIdentifier } from '../src/core/search/embedding-column.ts';
import { retiredPageSql } from '../src/core/entities/resolve.ts';
import { rankingLinkSql } from '../src/core/link-ranking-policy.ts';
import { boundedBodyPrefixSql } from '../src/core/page-window/bounded-lead.ts';
import { accessAllowedSql, privacyPartSql, callerAccessAllowedSql, privateLinkOriginFilterForCaller, privatePagesFilterFastForCaller, privatePagesFilterForCaller, remoteReadFloorSql, withCallerAccess, privateFactFilterForReader, privateFactFilterForCaller, privateTimelineEventFilterForCaller, privateTimelineEventFilterFragment } from '../src/core/search/private-visibility.ts';
import { planManualClient, GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { clientGrantInsert, grantValidationContext, insertClientGrant } from '../src/core/grants/service.ts';
import { CREDENTIAL_SQL, OAUTH_CODE_SQL, OAUTH_EXPIRE_ALL_SQL, OAUTH_REFRESH_SQL, OAUTH_TOKEN_SQL } from '../src/core/engine-sql/access-credentials.ts';
import { CLIENT_GRANT_SQL } from '../src/core/engine-sql/client-grants.ts';
import { PENDING_WRITE_HEALTH_SQL } from '../src/core/engine-sql/telemetry.ts';
import { ABANDONED_TAKES_SQL, TOP_RESOLVED_TAKES_SQL, TAKE_PREIMAGE_SQL } from '../src/core/engine-sql/takes-reads.ts';
import { createHash } from 'node:crypto';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

/** get_page's chunk generation probe as its caller built it (get-page-body.ts, a role that reads page_body_manifest). */
const GET_PAGE_GENERATION_PROBE = chunkGenerationProbe('content_chunks', true);
/** chunkManifestReads' privilege probe, which a Postgres engine runs before get_page's chunk reads (safe-chunks.ts). */
const CHUNK_MANIFEST_ACCESS = `-- chunk-visibility-ok: whether any chunk row of a segmented body exists, no row is returned
SELECT has_table_privilege('page_body_manifest', 'SELECT') AS readable,
  NOT has_table_privilege('page_body_manifest', 'SELECT')
    AND (EXISTS (SELECT 1 FROM content_chunks WHERE body_generation IS NOT NULL)
      OR EXISTS (SELECT 1 FROM content_chunks WHERE occurrence_id IS NOT NULL)) AS segmented`;
import { markedScopeSources } from '../src/core/access/attest-sources.ts';
import { resolveTokenGrant, touchTokenLastUsed } from '../src/core/grants/legacy-token.ts';
import { OAuthGrants } from '../src/core/oauth-grants.ts';
import { hashToken } from '../src/core/utils.ts';
import { activationSuppressedSql, pageEligibleSql, projectionEligibleSql } from '../src/core/eligibility/sql.ts';
import { trustRankSql } from '../src/core/trust/tier.ts';
import { grantedPrivateFactSql, memberFactAdmitSql } from '../src/core/access/member-facts.ts';
import { quarantineFilterFragment } from '../src/core/quarantine.ts';
import { MANAGED_MODE_SQL } from '../src/core/persistence/managed-mode.ts';
import { FACT_PREIMAGE_SQL } from '../src/core/engine-sql/facts.ts';
import { pageReadFilter } from '../src/core/search/read-policy-sql.ts';
import { NEUTRAL_WEIGHT } from '../src/core/feedback/store.ts';
import type { TrustTier } from '../src/core/trust/tier.ts';
import { SAVED_FACT_COLLAPSE_COLUMNS } from '../src/core/search/saved-fact-collapse.ts';
import { PINNED_QUESTION_MARKER } from '../src/core/questions/identity.ts';
import { MAX_ANCHORED } from '../src/core/search/entity-anchor.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';
import { syncDeleteOrigin } from '../src/core/persistence/sync-delete-tombstones.ts';
import { syncAdmissionEffectSql, syncAdmissionSettingSql } from '../src/core/persistence/sync-admission.ts';
import { GIT_PUSH_CODES } from '../src/core/persistence/git-push-holds.ts';
import { ACTIVE_REFRESH_STATES_SQL } from '../src/core/persistence/worktree-refresh-schema.ts';
import { APPLE_CONTACTS_PENDING_DELETES_OP, APPLE_CONTACTS_REVIEW_OP } from '../src/core/apple-contacts/review-status.ts';
import { identityDowngradeOpen } from '../src/core/sync-identity-downgrades.ts';
import { EFFECT_BYTES_SQL } from '../src/core/persistence/receipt-bytes.ts';
import { ruleCoversSql } from '../src/core/access/folder-rules.ts';
import { exactIdentityStatement } from '../src/core/engine-sql/exact-identity.ts';
import { extractedFromPageSql } from '../src/core/facts/gone-page-facts.ts';
import { holdAppliesToPageSql } from '../src/core/write-gate-binding.ts';
import { HELD_CONCEPT_SQL } from '../src/core/engine-sql/concept-rebuild.ts';
import { privatePagesFilterFragment } from '../src/core/search/private-visibility.ts';
import { tokenGrantJsonSql } from '../src/core/guests/owner-credentials.ts';
import { foldSql } from '../src/core/page-body/schema.ts';
import { CLIENT_INSPECTION_COLUMNS } from '../src/core/harness/client-setup.ts';
import { ownerOnlyPageSql } from '../src/core/access/owner-only.ts';

/** findPrivateOnlySlugs' statement, as the caller built it at f9592f7a7e (private-visibility.ts:1162). */
const privateOnlySlugsSql = (scopeClause: string, includeDeleted: boolean) => `SELECT p.slug FROM pages p
      WHERE p.slug = ANY($1::text[])
        ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
        ${scopeClause}
      GROUP BY p.slug
      HAVING bool_and(NOT (${privatePagesFilterForCaller('p')}))`;
/** persistence/concept-rebuild.ts STATED_SQL at 7c85d5696f, rebuilt from the builders it interpolated. */
const conceptStatedSql = () => `SELECT array_remove(ARRAY[
  CASE WHEN EXISTS (SELECT 1 FROM facts f WHERE f.source_id = $2 AND (f.entity_slug = $3 OR f.source_markdown_slug = $3) AND NOT ${extractedFromPageSql('f', '$3')}) THEN 'facts' END,
  CASE WHEN EXISTS (SELECT 1 FROM takes t WHERE t.page_id = $1) THEN 'takes' END,
  CASE WHEN EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id = $1) THEN 'timeline_entries' END,
  CASE WHEN EXISTS (SELECT 1 FROM links l WHERE (l.to_page_id = $1 OR l.from_page_id = $1) AND l.link_source IS NOT NULL
    AND l.link_source <> ALL($4::text[])) THEN 'links' END,
  CASE WHEN EXISTS (SELECT 1 FROM tags t WHERE t.page_id = $1) THEN 'tags' END,
  CASE WHEN EXISTS (SELECT 1 FROM files x WHERE x.page_id = $1) THEN 'files' END,
  CASE WHEN EXISTS (SELECT 1 FROM page_aliases a WHERE a.source_id = $2 AND a.slug = $3) THEN 'page_aliases' END,
  CASE WHEN EXISTS (SELECT 1 FROM slug_aliases a WHERE a.source_id = $2 AND a.canonical_slug = $3) THEN 'slug_aliases' END,
  CASE WHEN EXISTS (SELECT 1 FROM core_edit_notices c WHERE c.source_id = $2 AND c.slug = $3) THEN 'core_edit_notices' END,
  CASE WHEN EXISTS (SELECT 1 FROM write_gate_holds h WHERE h.source_id = $2 AND ${holdAppliesToPageSql('h', '$1', '$3')}) THEN 'write_gate_holds' END,
  CASE WHEN EXISTS (SELECT 1 FROM pages p WHERE p.id = $1 AND p.title <> replace(regexp_replace(p.slug, '^.*/', ''), '-', ' ')) THEN 'title' END,
  CASE WHEN EXISTS (SELECT 1 FROM pages p, jsonb_each(p.frontmatter) e WHERE p.id = $1 AND e.key <> ALL($6::text[]) AND e.key <> ALL($5::text[])
    AND NOT (e.key = 'tags' AND e.value = '[]'::jsonb)) THEN 'frontmatter' END,
  CASE WHEN EXISTS (SELECT 1 FROM pages p WHERE p.id = $1 AND p.body_storage IS DISTINCT FROM 'segmented' AND coalesce(p.timeline, '') <> '') THEN 'timeline' END,
  CASE WHEN EXISTS (SELECT 1 FROM pages p WHERE p.id = $1 AND ((p.source_path IS NOT NULL AND p.source_path <> p.slug || '.md')
    OR p.source_uri IS NOT NULL OR p.withheld_source_path IS NOT NULL)) THEN 'source_path' END,
  CASE WHEN EXISTS (SELECT 1 FROM link_transitions t WHERE t.from_page_id = $1 OR t.to_page_id = $1 OR t.origin_page_id = $1) THEN 'link_transitions' END,
  CASE WHEN EXISTS (SELECT 1 FROM raw_data r WHERE r.page_id = $1) THEN 'raw_data' END,
  CASE WHEN EXISTS (SELECT 1 FROM link_edge_proposals e WHERE $1 IN (e.from_page_id, e.a_to_page_id, e.b_to_page_id, e.ending_to_page_id)
    AND e.status IN ('rejected', 'undone', 'reverted_by_user')) THEN 'link_edge_proposals' END,
  CASE WHEN EXISTS (SELECT 1 FROM entity_identities i WHERE i.page_id = $1) THEN 'entity_identities' END,
  CASE WHEN EXISTS (SELECT 1 FROM guest_marks g WHERE g.page_id = $1) THEN 'guest_marks' END,
  CASE WHEN EXISTS (SELECT 1 FROM guest_promotions g WHERE g.guest_page_id = $1) THEN 'guest_promotions' END,
  CASE WHEN EXISTS (SELECT 1 FROM secret_store_occurrence o WHERE o.source_id = $2 AND o.commit_sha IS NULL
    AND (o.page_id = $1 OR (o.page_id IS NULL AND o.slug = $3)) AND NOT EXISTS (SELECT 1 FROM secret_store_occurrence k WHERE k.entry_id = o.entry_id
      AND NOT (k.source_id = $2 AND k.commit_sha IS NULL AND (k.page_id = $1 OR (k.page_id IS NULL AND k.slug = $3)))
      AND (k.commit_sha IS NOT NULL OR EXISTS (SELECT 1 FROM pages pk WHERE pk.deleted_at IS NULL
        AND (pk.id = k.page_id OR (k.page_id IS NULL AND pk.source_id = k.source_id AND pk.slug = k.slug)))))) THEN 'secret_store_occurrence' END,
  CASE WHEN EXISTS (SELECT 1 FROM page_label_guards g WHERE g.page_id = $1) OR EXISTS (SELECT 1 FROM pages p WHERE p.id = $1
    AND p.frontmatter ?| $5::text[]) THEN 'labels' END
], NULL) AS kinds,
  (SELECT ${boundedBodyPrefixSql('p')} FROM pages p WHERE p.id = $1) AS lead, (SELECT p.body_storage = 'segmented' FROM pages p WHERE p.id = $1) AS segmented`;

const memberSql = (member: string) => `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = (${member}) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`;


interface Pin {
  /** The caller site the statement came from, at 7470c703ed unless it names another commit. */
  from: string;
  case: SqlCase;
  /** The statement texts, in order, as the caller sent them; a function renders them in the pinned environment. */
  texts: string[] | (() => string[]);
}

const PINS: Pin[] = [
  {
    from: 'src/core/guests/sources.ts:96 initGuestSource, at dded7edc51',
    case: { method: 'upsertGuestSource', variant: 'default', run: e => e.upsertGuestSource('default', ['a-z', 'ab'], 'external_untrusted') },
    texts: [`INSERT INTO guest_sources (source_id, writers, trust_ceiling) VALUES ($1, $2::text[], $3)
      ON CONFLICT (source_id) DO UPDATE SET writers = ARRAY(SELECT DISTINCT w COLLATE "C" FROM unnest(guest_sources.writers || EXCLUDED.writers) AS w ORDER BY w COLLATE "C")
      RETURNING source_id, writers, trust_ceiling`],
  },
  {
    from: 'src/core/guests/promote.ts:50 guestNote, at dded7edc51',
    case: { method: 'listGuestNotes', variant: 'all', run: e => e.listGuestNotes('notes/a') },
    texts: ['SELECT p.id, p.source_id FROM pages p JOIN guest_sources g ON g.source_id = p.source_id WHERE p.slug = $1 AND p.deleted_at IS NULL ORDER BY p.source_id COLLATE "C"'],
  },
  {
    from: 'src/core/guests/promote.ts:50 guestNote (one source), at dded7edc51',
    case: { method: 'listGuestNotes', variant: 'one source', run: e => e.listGuestNotes('notes/a', 'default') },
    texts: ['SELECT p.id, p.source_id FROM pages p JOIN guest_sources g ON g.source_id = p.source_id WHERE p.slug = $1 AND p.deleted_at IS NULL AND p.source_id = $2 ORDER BY p.source_id COLLATE "C"'],
  },
  {
    from: 'src/commands/guests.ts:140 runGrantOwnerClients, the guest-source check (at a597e7a6c6)',
    case: { method: 'hasGuestSourceRow', variant: 'default', run: e => e.hasGuestSourceRow('guests') },
    texts: ['SELECT 1 FROM guest_sources WHERE source_id = $1'],
  },
  // The refusal-swallow sites (lane 8's triage) whose statements moved verbatim into typed members, at b7b18e5ab3.
  {
    from: 'src/commands/extract-explain.ts:169 the kind rollup (at b7b18e5ab3)',
    case: { method: 'readExtractKindRollup7d', variant: 'default', run: e => e.readExtractKindRollup7d('meeting') },
    texts: [`SELECT
         SUM(cost_usd) AS cost_7d_usd,
         SUM(eval_pass_count)::text AS eval_pass_count,
         SUM(eval_fail_count)::text AS eval_fail_count,
         SUM(halt_count)::text AS halt_count,
         SUM(round_completed_count)::text AS round_completed_count,
         MAX(updated_at) AS last_updated_at
       FROM extract_rollup_7d
       WHERE day >= CURRENT_DATE - 7 AND kind = $1`],
  },
  {
    from: 'src/core/mentions/siblings.ts:110 siblingCanonical (at b7b18e5ab3)',
    case: { method: 'readSiblingGroupRows', variant: 'default', run: e => e.readSiblingGroupRows('default', ['companies/a', 'companies/b']) },
    texts: [`SELECT slug, title, type, frontmatter->>'identity' AS identity FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])`],
  },
  {
    from: 'src/core/mentions/siblings.ts:110 siblingCanonical, excludePrivate (at b7b18e5ab3)',
    case: { method: 'readSiblingGroupRows', variant: 'excludePrivate', run: e => e.readSiblingGroupRows('default', ['companies/a', 'companies/b'], { excludePrivate: true }) },
    texts: () => [`SELECT slug, title, type, frontmatter->>'identity' AS identity FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[]) AND ${privatePagesFilterForCaller('pages')}`],
  },
  // The segmented page projection check and the derive pass's conditional store, then the mention pass, the gazetteer, the extract walk's snapshot, the by-mention rebuild and explain, copied verbatim
  {
    from: 'src/core/persistence/searchable.ts:33 (at 0af1a6ecf0)',
    case: { method: 'readSegmentedPageSealed', variant: 'default', run: e => e.readSegmentedPageSealed('default', 'notes/x') },
    texts: () => [`SELECT text_projection_revision=knowledge_revision AS sealed FROM pages
    WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`],
  },
  {
    from: 'src/core/page-body/segment-derive.ts:220 storeRuns (at 0af1a6ecf0)',
    case: { method: 'storeSegmentDerivationsIfLive', variant: 'default', run: e => e.storeSegmentDerivationsIfLive(1, 2, []) },
    texts: () => [`WITH live AS (SELECT id FROM pages WHERE id=$1 AND body_storage='segmented' AND body_generation=$2 FOR SHARE)
      INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256, context_hash, state, output, receipt)
      SELECT live.id, d.pipeline, d.occurrence_id, d.pipeline_version, decode(d.segment_sha256, 'hex'), decode(d.context_hash, 'hex'), 'done', d.output, NULL
      FROM live, jsonb_to_recordset($3::text::jsonb) AS d(pipeline text, occurrence_id bigint, pipeline_version int, segment_sha256 text, context_hash text, output jsonb)
      ON CONFLICT (page_id, pipeline, occurrence_id) DO UPDATE SET pipeline_version = EXCLUDED.pipeline_version, segment_sha256 = EXCLUDED.segment_sha256,
        context_hash = EXCLUDED.context_hash, state = EXCLUDED.state, output = EXCLUDED.output, receipt = EXCLUDED.receipt, updated_at = now()
      RETURNING 1`],
  },
  // from the callers at 0af1a6ecf0 (a literal's own variables are set as the caller set them).
  {
    // Not the caller's text: `COLLATE "C"` was added so a Postgres server with a linguistic locale orders the ids in byte
    // order, as PGLite and the Rust engine do (the sources id byte-order guard, test/source-id-order-collation.test.ts).
    from: 'src/core/mentions/pass.ts:148 (at 0af1a6ecf0), plus COLLATE "C"',
    case: { method: 'listMentionSourceIds', variant: 'default', run: e => e.listMentionSourceIds() },
    texts: () => { return ['SELECT id FROM sources ORDER BY id COLLATE "C"']; },
  },
  {
    from: 'src/core/mentions/pass.ts:162 (at 0af1a6ecf0)',
    case: { method: 'writeMentionIndexStatus', variant: 'default', run: e => e.writeMentionIndexStatus('default', { state: 'pending', pending: null, lastPassAt: null, error: null, bumpGeneration: true, fingerprint: null, setFingerprint: false }) },
    texts: () => { return [`INSERT INTO mention_index_status (source_id, generation, state, pending, counted_at, last_pass_at, policy_fingerprint, error, updated_at)
     VALUES ($1, CASE WHEN $6::boolean THEN 1 ELSE 0 END, $2, COALESCE($3::int, 0), now(), $4::timestamptz, $7, $5, now())
     ON CONFLICT (source_id) DO UPDATE SET
       state = EXCLUDED.state,
       pending = COALESCE($3::int, mention_index_status.pending),
       counted_at = CASE WHEN $3::int IS NULL THEN mention_index_status.counted_at ELSE now() END,
       last_pass_at = COALESCE($4::timestamptz, mention_index_status.last_pass_at),
       error = $5,
       generation = mention_index_status.generation + CASE WHEN $6::boolean THEN 1 ELSE 0 END,
       policy_fingerprint = CASE WHEN $8::boolean THEN $7 ELSE mention_index_status.policy_fingerprint END,
       updated_at = now()`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:183 (at 0af1a6ecf0)',
    case: { method: 'lockMentionSources', variant: 'shared', run: e => e.lockMentionSources(['default'], true) },
    texts: () => { const shared = true; return [`SELECT count(${shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'}(hashtext('gbrain:mention-publish:' || s)::bigint))
    FROM (SELECT DISTINCT s FROM unnest($1::text[]) AS x(s) ORDER BY s) k`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:183 (at 0af1a6ecf0)',
    case: { method: 'lockMentionSources', variant: 'exclusive', run: e => e.lockMentionSources(['default'], false) },
    texts: () => { const shared = false; return [`SELECT count(${shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'}(hashtext('gbrain:mention-publish:' || s)::bigint))
    FROM (SELECT DISTINCT s FROM unnest($1::text[]) AS x(s) ORDER BY s) k`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:236 (at 0af1a6ecf0)',
    case: { method: 'listMentionLinkOrigins', variant: 'default', run: e => e.listMentionLinkOrigins('default') },
    texts: () => { return [`SELECT DISTINCT f.slug FROM links l JOIN pages f ON f.id = l.from_page_id
        WHERE f.source_id = $1 AND l.link_source = 'mentions' AND (l.link_kind IS NULL OR l.link_kind = 'plain')`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:239 (at 0af1a6ecf0)',
    case: { method: 'deleteSourceMentionLinks', variant: 'default', run: e => e.deleteSourceMentionLinks('default', null) },
    texts: () => { return [`DELETE FROM links l USING pages f
        WHERE f.id = l.from_page_id AND f.source_id = $1 AND l.link_source = 'mentions'
          AND (l.link_kind IS NULL OR l.link_kind = 'plain') AND ($2::text[] IS NULL OR f.slug = ANY($2::text[])) RETURNING l.id`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:245; src/core/mentions/pass.ts:246; src/core/mentions/pass.ts:247 (at 0af1a6ecf0)',
    case: { method: 'clearMentionSourceIndex', variant: 'default', run: e => e.clearMentionSourceIndex('default') },
    texts: () => { return [`DELETE FROM page_aliases WHERE source_id = $1 AND origin IN ('declared','subject')`, 'DELETE FROM mention_gazetteer_entries WHERE source_id = $1', 'DELETE FROM page_mention_state WHERE source_id = $1']; },
  },
  {
    from: 'src/core/mentions/pass.ts:342 (at 0af1a6ecf0)',
    case: { method: 'listStaleDerivedAliasSlugs', variant: 'default', run: e => e.listStaleDerivedAliasSlugs('default', ['person']) },
    texts: () => { return [`SELECT DISTINCT pa.slug FROM page_aliases pa
       LEFT JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id
      WHERE pa.source_id = $1 AND pa.origin IN ('declared','subject')
        AND (p.id IS NULL OR p.deleted_at IS NOT NULL OR NOT (p.type = ANY($2::text[])))`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:348 (at 0af1a6ecf0)',
    case: { method: 'deleteDerivedAliasesForSlugs', variant: 'default', run: e => e.deleteDerivedAliasesForSlugs('default', ['people/alice-example']) },
    texts: () => { return [`DELETE FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) AND origin IN ('declared','subject')`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:356 (at 0af1a6ecf0)',
    case: { method: 'listAliasDuePages', variant: 'default', run: e => e.listAliasDuePages('default', ['person'], 0, 4, 200) },
    texts: () => { return [`SELECT p.id, p.slug, p.source_id, p.knowledge_revision::text AS revision, p.title, p.type, p.compiled_truth, p.timeline, NULL AS mention_ignore, p.frontmatter
         FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
        WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.body_storage = 'inline' AND p.type = ANY($2::text[]) AND p.id > $3
          AND (s.page_id IS NULL OR s.alias_revision IS DISTINCT FROM p.knowledge_revision OR s.alias_version IS DISTINCT FROM $4)
        ORDER BY p.id LIMIT $5`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:365 (at 0af1a6ecf0)',
    case: { method: 'listDerivedAliasRows', variant: 'default', run: e => e.listDerivedAliasRows('default', ['people/alice-example']) },
    texts: () => { return [`SELECT slug, alias_norm, origin, case_sensitive, alias_text FROM page_aliases
        WHERE source_id = $1 AND slug = ANY($2::text[]) AND origin IN ('declared','subject')`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:382 (at 0af1a6ecf0)',
    case: { method: 'readMentionPageRevisions', variant: 'plain', run: e => e.readMentionPageRevisions([1], { forShare: false }) },
    texts: () => { return [`SELECT id, knowledge_revision::text AS revision FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:564 (at 0af1a6ecf0)',
    case: { method: 'readMentionPageRevisions', variant: 'for_share', run: e => e.readMentionPageRevisions([1], { forShare: true }) },
    texts: () => { return [`SELECT id, knowledge_revision::text AS revision FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL FOR SHARE`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:392 (at 0af1a6ecf0)',
    case: { method: 'insertDerivedAliasRows', variant: 'default', run: e => e.insertDerivedAliasRows('default', [{ slug: 'people/alice-example', alias_norm: 'alice', origin: 'declared', case_sensitive: false, alias_text: 'Alice' }]) },
    texts: () => { return [`INSERT INTO page_aliases (source_id, alias_norm, slug, origin, case_sensitive, alias_text)
             SELECT $1, a, s, o, c::boolean, t FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS x(a, s, o, c, t)
             ON CONFLICT DO NOTHING`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:400 (at 0af1a6ecf0)',
    case: { method: 'upsertPageAliasState', variant: 'default', run: e => e.upsertPageAliasState('default', [{ id: 1, revision: '00000000-0000-4000-8000-000000000001' }], 4) },
    texts: () => { return [`INSERT INTO page_mention_state (page_id, source_id, alias_revision, alias_version, aliases_refreshed_at)
           SELECT id, $1, rev::uuid, $4, now() FROM unnest($2::int[], $3::text[]) AS x(id, rev)
           ON CONFLICT (page_id) DO UPDATE SET alias_revision = EXCLUDED.alias_revision, alias_version = EXCLUDED.alias_version,
             aliases_refreshed_at = EXCLUDED.aliases_refreshed_at`]; },
  },
  // The two listMentionCandidatePages texts below are master's (pagesMatchingNames in src/core/mentions/pass.ts at 913e459414, the
  // mention speedup #10255): the page window is picked by id in a subselect, then joined back to pages as p, and the LIKE
  // prefilter moved into the body CASE, so every page in the window comes back and an unmatched one has a null body.
  {
    from: 'src/core/mentions/pass.ts:423 (at 0af1a6ecf0)',
    case: { method: 'listMentionCandidatePages', variant: 'ascii', run: e => e.listMentionCandidatePages(['default'], 0, 500, ['%alice%']) },
    texts: () => { const ascii = true; return [`SELECT p.id, p.slug, p.source_id, p.body_storage,
              CASE WHEN ${ascii ? `p.body_storage = 'segmented' OR lower(COALESCE(p.title, '') || ' ' || COALESCE(p.compiled_truth, '') || ' ' || COALESCE(p.timeline, '')) LIKE ANY($4::text[])` : 'true'}
                   THEN COALESCE(p.title, '') || E'\\n\\n' || COALESCE(p.compiled_truth, '') || E'\\n\\n' || COALESCE(p.timeline, '') END AS body,
              p.frontmatter->'mention_ignore' AS mention_ignore
         FROM (SELECT id FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND id > $2 ORDER BY id LIMIT $3) w
         JOIN pages p ON p.id = w.id ORDER BY p.id`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:423 (at 0af1a6ecf0)',
    case: { method: 'listMentionCandidatePages', variant: 'all', run: e => e.listMentionCandidatePages(['default'], 0, 500, null) },
    texts: () => { const ascii = false; return [`SELECT p.id, p.slug, p.source_id, p.body_storage,
              CASE WHEN ${ascii ? `p.body_storage = 'segmented' OR lower(COALESCE(p.title, '') || ' ' || COALESCE(p.compiled_truth, '') || ' ' || COALESCE(p.timeline, '')) LIKE ANY($4::text[])` : 'true'}
                   THEN COALESCE(p.title, '') || E'\\n\\n' || COALESCE(p.compiled_truth, '') || E'\\n\\n' || COALESCE(p.timeline, '') END AS body,
              p.frontmatter->'mention_ignore' AS mention_ignore
         FROM (SELECT id FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND id > $2 ORDER BY id LIMIT $3) w
         JOIN pages p ON p.id = w.id ORDER BY p.id`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:462 (at 0af1a6ecf0)',
    case: { method: 'listGazetteerEntryKeys', variant: 'default', run: e => e.listGazetteerEntryKeys('default') },
    texts: () => { return ['SELECT source_id, name_norm, target_slug, case_sensitive FROM mention_gazetteer_entries WHERE source_id = $1']; },
  },
  {
    from: 'src/core/mentions/pass.ts:474 (at 0af1a6ecf0)',
    case: { method: 'listMentionLinkersOfTargets', variant: 'default', run: e => e.listMentionLinkersOfTargets('default', ['people/alice-example']) },
    texts: () => { return [`SELECT DISTINCT l.from_page_id AS id FROM links l JOIN pages t ON t.id = l.to_page_id
        WHERE t.source_id = $1 AND t.slug = ANY($2::text[]) AND l.link_source = 'mentions'`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:483 (at 0af1a6ecf0)',
    case: { method: 'lockMentionEntries', variant: 'default', run: e => e.lockMentionEntries('default') },
    texts: () => { return ['SELECT pg_advisory_xact_lock(hashtext($1)::bigint)']; },
  },
  {
    from: 'src/core/mentions/pass.ts:488; src/core/mentions/pass.ts:494 (at 0af1a6ecf0)',
    case: { method: 'applyGazetteerEntryChanges', variant: 'both', run: e => e.applyGazetteerEntryChanges('default', [{ source_id: 'default', name_norm: 'bob', target_slug: 'people/bob-example', case_sensitive: false }], [{ source_id: 'default', name_norm: 'alice', target_slug: 'people/alice-example', case_sensitive: false }]) },
    texts: () => { return [`DELETE FROM mention_gazetteer_entries e USING unnest($2::text[], $3::text[], $4::text[]) AS x(n, t, c)
          WHERE e.source_id = $1 AND e.name_norm = x.n AND e.target_slug = x.t AND e.case_sensitive = x.c::boolean`, `INSERT INTO mention_gazetteer_entries (source_id, name_norm, target_slug, case_sensitive)
         SELECT $1, n, t, c::boolean FROM unnest($2::text[], $3::text[], $4::text[]) AS x(n, t, c) ON CONFLICT DO NOTHING`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:500 (at 0af1a6ecf0)',
    case: { method: 'resetMentionRevisions', variant: 'sources', run: e => e.resetMentionRevisions({ sourceIds: ['default'] }) },
    texts: () => { return ['UPDATE page_mention_state SET mention_revision = NULL WHERE source_id = ANY($1::text[])']; },
  },
  {
    from: 'src/core/mentions/pass.ts:502 (at 0af1a6ecf0)',
    case: { method: 'resetMentionRevisions', variant: 'pages', run: e => e.resetMentionRevisions({ pageIds: [1] }) },
    texts: () => { return ['UPDATE page_mention_state SET mention_revision = NULL WHERE page_id = ANY($1::int[])']; },
  },
  {
    from: 'src/core/mentions/pass.ts (GST-3609, #10161)',
    case: { method: 'resetMentionRevisions', variant: 'tail', run: e => e.resetMentionRevisions({ pageIds: [1], sourceIds: ['default'], afterPageId: 1 }) },
    texts: () => {
      return [`UPDATE page_mention_state SET mention_revision = NULL
          WHERE page_id = ANY($1::int[]) OR ($3::int IS NOT NULL AND source_id = ANY($2::text[]) AND page_id > $3::int)`];
    },
  },
  {
    from: 'src/core/mentions/pass.ts:510 (at 0af1a6ecf0)',
    case: { method: 'readMentionGenerations', variant: 'plain', run: e => e.readMentionGenerations(['default'], false) },
    texts: () => { const lock = false; return [`SELECT source_id, generation::text AS generation FROM mention_index_status WHERE source_id = ANY($1::text[])${lock ? ' FOR SHARE' : ''}`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:510 (at 0af1a6ecf0)',
    case: { method: 'readMentionGenerations', variant: 'for_share', run: e => e.readMentionGenerations(['default'], true) },
    texts: () => { const lock = true; return [`SELECT source_id, generation::text AS generation FROM mention_index_status WHERE source_id = ANY($1::text[])${lock ? ' FOR SHARE' : ''}`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:530 (at 0af1a6ecf0)',
    case: { method: 'listMentionDuePages', variant: 'default', run: e => e.listMentionDuePages('default', 7, 0, 200) },
    texts: () => { const DUE_PREDICATE = `(s.page_id IS NULL OR s.mention_revision IS DISTINCT FROM p.knowledge_revision OR s.mention_version IS DISTINCT FROM $2)`; return [`SELECT p.id, p.slug, p.source_id, p.knowledge_revision::text AS revision, p.title, p.type, p.compiled_truth, p.timeline,
              p.frontmatter->'mention_ignore' AS mention_ignore, p.body_storage
         FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
        WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.id > $3 AND ${DUE_PREDICATE}
        ORDER BY p.id LIMIT $4`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:569 (at 0af1a6ecf0)',
    case: { method: 'listPageOutLinks', variant: 'default', run: e => e.listPageOutLinks([1]) },
    texts: () => { return [`SELECT l.id, l.from_page_id, t.slug AS to_slug, t.source_id AS to_source_id,
                (l.link_source = 'mentions' AND (l.link_kind IS NULL OR l.link_kind = 'plain')) AS plain
           FROM links l JOIN pages t ON t.id = l.to_page_id WHERE l.from_page_id = ANY($1::int[])`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:589 (at 0af1a6ecf0)',
    case: { method: 'deleteLinksById', variant: 'default', run: e => e.deleteLinksById([1]) },
    texts: () => { return ['DELETE FROM links WHERE id = ANY($1::int[])']; },
  },
  {
    from: 'src/core/mentions/pass.ts:596 (at 0af1a6ecf0)',
    case: { method: 'upsertPageMentionState', variant: 'default', run: e => e.upsertPageMentionState('default', [{ id: 1, revision: '00000000-0000-4000-8000-000000000001' }], 7, '0') },
    texts: () => { return [`INSERT INTO page_mention_state (page_id, source_id, mention_revision, mention_version, mention_generation, mentions_scanned_at)
         SELECT id, $1, rev::uuid, $4, $5::bigint, now() FROM unnest($2::int[], $3::text[]) AS x(id, rev)
         ON CONFLICT (page_id) DO UPDATE SET mention_revision = EXCLUDED.mention_revision, mention_version = EXCLUDED.mention_version,
           mention_generation = EXCLUDED.mention_generation, mentions_scanned_at = EXCLUDED.mentions_scanned_at`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:626 (at 0af1a6ecf0)',
    case: { method: 'readMentionStatusStates', variant: 'default', run: e => e.readMentionStatusStates(['default']) },
    texts: () => { return ['SELECT source_id, state FROM mention_index_status WHERE source_id = ANY($1::text[])']; },
  },
  {
    from: 'src/core/mentions/pass.ts:648 (at 0af1a6ecf0)',
    case: { method: 'readMentionPolicyFingerprints', variant: 'default', run: e => e.readMentionPolicyFingerprints(['default']) },
    texts: () => { return ['SELECT source_id, policy_fingerprint FROM mention_index_status WHERE source_id = ANY($1::text[])']; },
  },
  {
    from: 'src/core/mentions/pass.ts:657 (at 0af1a6ecf0)',
    case: { method: 'resetSourceMentionIndexRevisions', variant: 'default', run: e => e.resetSourceMentionIndexRevisions('default') },
    texts: () => { return ['UPDATE page_mention_state SET mention_revision = NULL, alias_revision = NULL WHERE source_id = $1']; },
  },
  {
    from: 'src/core/by-mention.ts:517 (at 0af1a6ecf0)',
    case: { method: 'listLivePageSourceIds', variant: 'default', run: e => e.listLivePageSourceIds() },
    texts: () => { return ['SELECT DISTINCT source_id AS id FROM pages WHERE deleted_at IS NULL']; },
  },
  {
    from: 'src/core/by-mention.ts:527 (at 0af1a6ecf0; the retired-page filter is master #9944)',
    case: { method: 'listGazetteerPages', variant: 'default', run: e => e.listGazetteerPages(['person'], ['x_handle', 'twitter', 'twitter_handle', 'x']) },
    texts: () => { return [`SELECT slug, source_id, title, type, (frontmatter ->> 'google_contact_id') IS NOT NULL AS connector_stub,
            frontmatter ->> $2 AS h1, frontmatter ->> $3 AS h2, frontmatter ->> $4 AS h3, frontmatter ->> $5 AS h4
     FROM pages
     WHERE type = ANY($1::text[])
       AND deleted_at IS NULL
       AND NOT ${retiredPageSql('pages')}`]; },
  },
  {
    from: 'src/core/by-mention.ts:550 (at 0af1a6ecf0)',
    case: { method: 'listGazetteerAliases', variant: 'default', run: e => e.listGazetteerAliases(['person']) },
    texts: () => { return [`SELECT pa.alias_norm, pa.slug, pa.source_id, p.title, p.type, pa.origin, pa.case_sensitive, pa.alias_text, p.frontmatter->>'identity' AS identity
       FROM page_aliases pa
       JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id
       WHERE p.type = ANY($1::text[])
         AND p.deleted_at IS NULL
         AND NOT ${retiredPageSql('p')}`]; },
  },
  {
    from: 'src/commands/extract.ts:207 (at 0af1a6ecf0)',
    case: { method: 'readPageStampTimes', variant: 'default', run: e => e.readPageStampTimes(['people/alice-example'], ['default']) },
    texts: () => { return [`SELECT p.slug, p.source_id,
              to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso
         FROM pages p
         JOIN unnest($1::text[], $2::text[]) AS v(slug, source_id)
           ON p.slug = v.slug AND p.source_id = v.source_id
        WHERE p.deleted_at IS NULL`]; },
  },
  {
    from: 'src/commands/extract.ts:2599 (at 0af1a6ecf0)',
    case: { method: 'readPageRevisionForShare', variant: 'default', run: e => e.readPageRevisionForShare('default', 'people/alice-example') },
    texts: () => { return ['SELECT knowledge_revision::text AS revision FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL FOR SHARE']; },
  },
  {
    from: 'src/commands/extract-mentions-explain.ts:80 (at 0af1a6ecf0)',
    case: { method: 'readExplainPage', variant: 'default', run: e => e.readExplainPage('default', 'people/alice-example') },
    texts: () => { return ['SELECT slug, type, title FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL']; },
  },
  {
    from: 'src/commands/extract-mentions-explain.ts:102 (at 0af1a6ecf0)',
    case: { method: 'readExplainScanPage', variant: 'default', run: e => e.readExplainScanPage('default', 'notes/x', 7) },
    texts: () => { return [`SELECT p.id, p.slug, p.title, p.compiled_truth, p.timeline, p.frontmatter->'mention_ignore' AS mention_ignore,
            (s.page_id IS NULL OR s.mention_revision IS DISTINCT FROM p.knowledge_revision OR s.mention_version IS DISTINCT FROM $3) AS due
       FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
      WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`]; },
  },
  {
    from: 'src/commands/extract-mentions-explain.ts:117 (at 0af1a6ecf0)',
    case: { method: 'countMentionLinksTo', variant: 'default', run: e => e.countMentionLinksTo(1, 'default', ['people/alice-example']) },
    texts: () => { return [`SELECT count(*)::int AS n FROM links l JOIN pages t ON t.id = l.to_page_id
      WHERE l.from_page_id = $1 AND l.link_source = 'mentions' AND t.source_id = $2 AND t.slug = ANY($3::text[])`]; },
  },
  {
    from: 'src/commands/extract-mentions-explain.ts:134 (at 0af1a6ecf0)',
    case: { method: 'readPageNameText', variant: 'default', run: e => e.readPageNameText('default', 'people/alice-example') },
    texts: () => { return ['SELECT title, compiled_truth, timeline, frontmatter FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL']; },
  },
  {
    from: 'src/commands/extract-mentions-explain.ts:138 (at 0af1a6ecf0)',
    case: { method: 'listFrontmatterAliasNorms', variant: 'default', run: e => e.listFrontmatterAliasNorms('default', 'people/alice-example') },
    texts: () => { return [`SELECT alias_norm FROM page_aliases WHERE source_id = $1 AND slug = $2 AND origin = 'frontmatter' ORDER BY alias_norm`]; },
  },
  {
    from: 'src/commands/extract-mentions-explain.ts:152 (at 0af1a6ecf0)',
    case: { method: 'listRejectedDeclarationPages', variant: 'default', run: e => e.listRejectedDeclarationPages('default', ['person'], '%alice%') },
    texts: () => { return [`SELECT title, compiled_truth, timeline, frontmatter FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND type = ANY($2::text[])
        AND (compiled_truth ILIKE $3 OR title ILIKE $3) LIMIT 50`]; },
  },
  {
    from: 'src/commands/sync/preflight.ts:195 the 0-change sync heartbeat',
    case: { method: 'writeSourceSyncHeartbeat', variant: 'default', run: e => e.writeSourceSyncHeartbeat('default') },
    texts: ['UPDATE sources SET last_sync_at = now() WHERE id = $1'],
  },
  {
    from: 'src/core/sync-upstream.ts:71 recordUpstreamObservation',
    case: { method: 'writeSourceUpstreamObservation', variant: 'default', run: e => e.writeSourceUpstreamObservation('default', { checkedAt: '2026-01-02T03:04:05.000Z', commit: 'c1', behind: 2 }) },
    texts: ['UPDATE sources SET upstream_checked_at = CASE WHEN upstream_commit = $3 AND upstream_checked_at > $2::timestamptz THEN upstream_checked_at ELSE $2::timestamptz END,\n  upstream_commit=$3,upstream_behind=$4 WHERE id=$1'],
  },
  {
    from: 'src/core/persistence/soak-counters.ts:40 recordSoakEvent',
    case: { method: 'addSoakCounterEvent', variant: 'default', run: e => e.addSoakCounterEvent('sync-soak-counters', '2026-01-02', 'repair_apply', 1) },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,jsonb_build_array(jsonb_build_object('day',$2::text,$3::text,$4::int)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array(op_checkpoints.completed_keys->0
      || jsonb_build_object($3::text, COALESCE((op_checkpoints.completed_keys->0->>$3)::int,0)+$4::int)), updated_at=now()`],
  },
  {
    from: 'src/core/sync-rename-identity.ts:365 redecideHeldRename',
    case: { method: 'readPageIdentity', variant: 'default', run: e => e.readPageIdentity(1) },
    texts: [`SELECT frontmatter->>'id' AS fm_id, title FROM pages WHERE id = $1 AND deleted_at IS NULL`],
  },
  {
    from: 'src/core/belief/purge.ts:50 bumpPurgeEpoch',
    case: { method: 'advanceSourcePurgeEpoch', variant: 'default', run: e => e.advanceSourcePurgeEpoch('default') },
    texts: ['UPDATE sources SET purge_epoch = purge_epoch + 1 WHERE id = $1 RETURNING purge_epoch'],
  },
  {
    // Moved after 7470c703ed: the statement is copied verbatim from the caller at 51df179097.
    from: 'src/core/page-body/segment-derive.ts:355 derivationNeedles',
    case: { method: 'listDerivationClaimForms', variant: 'default', run: e => e.listDerivationClaimForms(['Alice likes tea']) },
    texts: [`SELECT DISTINCT f COLLATE "C" AS f FROM (SELECT replace(translate(gbrain_fact_normalize(c), 'ς', 'σ'), 'i\u0307', 'i') AS f
    FROM unnest($1::text[]) c) x WHERE f <> '' ORDER BY f`],
  },
  {
    // Moved after 7470c703ed: the statement is copied verbatim from segment-derive.ts recordDerivationPurge at 4e49050bff.
    from: 'src/core/page-body/segment-derive.ts:421 recordDerivationPurge',
    case: { method: 'recordDerivationPurgeRow', variant: 'default', run: e => e.recordDerivationPurgeRow({ requestId: '00000000-0000-4000-8000-0000000000a1', sourceId: 'src-a',
      needles: [' alice likes tea '], patterns: ['%alice%likes%tea%'], pageIds: [1, 2] }) },
    texts: [`INSERT INTO page_segment_derivation_purges (request_id, source_id, needles, patterns, page_ids)
    VALUES ($1::uuid, $2, $3::text[], $4::text[], $5::int[]) ON CONFLICT (request_id) DO NOTHING`],
  },
  {
    from: 'src/core/access/caller.ts:376 appliedAccessSummary (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAppliedPolicyRevisions', variant: 'default', run: e => e.listAppliedPolicyRevisions() },
    texts: [`SELECT s.source_id, (SELECT r.revision FROM access_policy_revisions r WHERE r.source_id = s.source_id AND r.applied_at IS NOT NULL
          ORDER BY r.revision DESC LIMIT 1) AS rev FROM access_policy_state s ORDER BY s.source_id COLLATE "C"`],
  },
  ...([
    ['member', 'alice-example', '$1'],
    ['stdio_config', 'mcp.stdio_member', `SELECT ${edgeTrimSql('value')} FROM config WHERE key = $1`],
    ['legacy_token', '00000000-0000-4000-8000-0000000000aa', 'SELECT member_id FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL'],
    ['oauth_client', 'client-example', 'SELECT member_id FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL'],
  ] as const).map(([via, key, member]): Pin => ({
    from: 'src/core/access/caller.ts:94 liveIdentity (MEMBER_SQL; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readLiveMember', variant: via, run: e => e.readLiveMember(via, key) },
    texts: [`SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = (${member}) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`],
  })),
  {
    from: 'src/core/access/caller.ts:170 folderAccessForAll (no readers: the rules read is skipped; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readFolderAccess', variant: 'no_readers', run: e => e.readFolderAccess([]) },
    texts: [`SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id COLLATE "C", prefix COLLATE "C"`],
  },
  {
    from: 'src/core/access/caller.ts:170 folderAccessForAll (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readFolderAccess', variant: 'readers', run: e => e.readFolderAccess(['member:alice-example', 'group:team-a']) },
    texts: [
      'SELECT source_id, rule_id, readable_by FROM access_rules WHERE readable_by && $1::text[]',
      `SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id COLLATE "C", prefix COLLATE "C"`,
    ],
  },
  ...([
    ['none', () => ''],
    ['caller', () => `AND ${privatePagesFilterForCaller('p')}`],
    ['floor', () => `AND ${remoteReadFloorSql('p')}`],
    ['member_access', () => `AND ${callerAccessAllowedSql('p')}`],
  ] as const).map(([privacy, predicate]): Pin => ({
    from: `src/core/entities/resolve.ts:246 followRetirement (privacy ${privacy})`,
    case: { method: 'readRetirementHop', variant: privacy, run: e => e.readRetirementHop('default', 'people/alice-example', privacy) },
    texts: () => [`SELECT p.slug, p.type, ${retiredPageSql('p')} AS retired,
              COALESCE(NULLIF(btrim(p.frontmatter->>'superseded_by'), ''), NULLIF(btrim(p.frontmatter->>'merged_into'), '')) AS target
         FROM pages p
        WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL ${predicate()}
        LIMIT 1`],
  })),
  ...([
    ['name', ''],
    ['name+private', `private`],
  ] as const).map(([variant, priv]): Pin => ({
    from: `src/core/verbs/entity-card.ts:354 selectEntityCandidates (${variant})`,
    case: { method: 'readEntityCardRows', variant, run: e => e.readEntityCardRows('default', { titleLc: 'alice example', slugs: ['people/alice-example'], slugLike: '%/alice-example' }, { excludePrivate: priv !== '' }) },
    texts: () => [`SELECT ${CARD_ROW_COLUMNS()}
         FROM pages
        WHERE deleted_at IS NULL
          AND source_id = $1
          AND ( lower(title) = $2
             OR slug = ANY($3::text[])
             OR slug LIKE $4 )${priv ? ` AND ${privatePagesFilterForCaller('pages')}` : ''}`],
  })),
  ...([
    ['slugs', ''],
    ['slugs+private', `private`],
  ] as const).map(([variant, priv]): Pin => ({
    from: `src/core/verbs/entity-card.ts:380 selectEntityCandidates hydrate (${variant})`,
    case: { method: 'readEntityCardRows', variant, run: e => e.readEntityCardRows('default', { slugs: ['people/alice-example'] }, { excludePrivate: priv !== '' }) },
    texts: () => [`SELECT ${CARD_ROW_COLUMNS()}
           FROM pages
          WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[])${priv ? ` AND ${privatePagesFilterForCaller('pages')}` : ''}`],
  })),
  ...([
    ['all', ''],
    ['caller', `private`],
  ] as const).map(([variant, priv]): Pin => ({
    // Equivalent statement, not byte for byte: the caller at 9940056d12 bound the probe list once as $4 and wrote the cap
    // as the literal `LIMIT 201`; sqlFragment numbers each value where it appears (probes $1, $5, $6; the cap $7). The slug
    // sort key keeps main's COLLATE "C" (the caller at b7b18e5ab3), so Postgres sorts by byte like PGLite and the store.
    from: `src/core/verbs/entity-variants.ts:104 resolveNameVariant, entity card projection (${variant})`,
    case: { method: 'listNameVariantCardCandidates', variant, run: e => e.listNameVariantCardCandidates('default',
      { types: ['person'], slugPatterns: ['people/%'], probes: ['%alice%'], limit: 201 }, { excludePrivate: priv !== '' }) },
    texts: () => [`SELECT ${CARD_ROW_COLUMNS()},
                (SELECT count(*)::int FROM unnest($1::text[]) w WHERE pages.title ILIKE w OR pages.slug ILIKE w) AS probe_hits
           FROM pages
          WHERE deleted_at IS NULL AND source_id = $2
            AND (type = ANY($3::text[]) OR slug LIKE ANY($4::text[]))
            AND (title ILIKE ANY($5::text[]) OR slug ILIKE ANY($6::text[]))${priv ? ` AND ${privatePagesFilterForCaller('pages')}` : ''}
          ORDER BY probe_hits DESC, length(title), slug COLLATE "C"
          LIMIT $7`],
  })),
  {
    from: 'src/commands/sync/plain-directory.ts:36 plainDirectorySyncRoot',
    case: { method: 'readPlainSyncSource', variant: 'default', run: e => e.readPlainSyncSource('default') },
    texts: ['SELECT local_path,last_commit,config FROM sources WHERE id=$1 AND NOT archived'],
  },
  {
    from: 'src/core/verbs/entity-card-identity.ts:141 readSiblingIdentity (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readEntityAliasRows', variant: 'siblings', run: e => e.readEntityAliasRows('default', ['people/alice-example', 'people/alice-twin']) },
    texts: ['SELECT slug, alias_norm, origin, alias_text FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY alias_norm COLLATE "C"'],
  },
  {
    // readAka ran `SELECT alias_norm FROM page_aliases WHERE source_id = $1 AND slug = $2 ORDER BY alias_norm`. It now
    // sends the sibling statement with a one-slug array: the same rows in the same order (one slug, so no tie).
    from: 'src/core/verbs/entity-card.ts:783 readAka (one slug; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readEntityAliasRows', variant: 'aka', run: e => e.readEntityAliasRows('default', ['people/alice-example']) },
    texts: ['SELECT slug, alias_norm, origin, alias_text FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY alias_norm COLLATE "C"'],
  },
  // The caller bound the source once as $2 and named it three times (four for a remote read). The member binds it at
  // each use (engine-sql numbers every value once: check-engine-sql-dynamic), so the source is $2, $3 and $4: the same
  // value at each place, so the same rows in the same order.
  ...([[false, false], [true, true]] as const).map(([excludePrivate, remote]): Pin => ({
    from: 'src/core/verbs/entity-card.ts:617 assembleCard incoming edges',
    case: {
      method: 'readEntityInboundEdges', variant: excludePrivate ? 'remote+private' : 'local',
      run: e => e.readEntityInboundEdges('people/alice-example', 'default', { excludePrivate, originSameSource: remote }),
    },
    texts: () => [`SELECT f.slug AS from_slug, l.link_type, l.context, lr_t.valid_ranges::text AS temporal_ranges, lr_t.semantics AS temporal_semantics,
      lr_t.disputed AS temporal_disputed, lr_t.undated_past AS temporal_undated_past, lr_t.first_start::text AS temporal_first_start,
      lr_t.recorded_at AS temporal_recorded_at, lr_t.retired_at AS temporal_retired_at
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
           LEFT JOIN link_relationships lr_t ON lr_t.from_page_id = l.from_page_id
      AND lr_t.to_page_id = l.to_page_id AND lr_t.link_type = l.link_type
      AND lr_t.scope = '${excludePrivate ? 'world' : 'all'}'
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $3 AND f.deleted_at IS NULL
            AND COALESCE(l.link_source, '') <> 'mentions'${excludePrivate
    ? ` AND ${privatePagesFilterForCaller('f')} AND ${privateLinkOriginFilterForCaller('l')}`
    : ''} AND (l.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM pages lo WHERE lo.id = l.origin_page_id AND lo.deleted_at IS NULL${remote ? ' AND lo.source_id = $4' : ''}))
          ORDER BY l.id`],
  })),
  // Not the caller's text: the statement adds `id DESC` as the last ORDER BY key, so tied loops read in one order.
  {
    from: 'src/core/verbs/entity-card.ts:691 assembleCard open loops',
    case: { method: 'readEntityOpenLoops', variant: 'default', run: e => e.readEntityOpenLoops('people/alice-example', 'default', 3) },
    texts: [`SELECT id, loop_type, summary, due_at, last_activity_at, fact_id
       FROM open_loops
       WHERE status = 'open' AND counterparty_slug = $1
         AND COALESCE(counterparty_source_id, source_id) = $2
       ORDER BY last_activity_at DESC, id DESC
       LIMIT 3`],
  },
  ...([[true, 'canonical'], [null, 'keep']] as const).map(([canonical, variant]): Pin => ({
    from: 'src/core/entity-identity.ts:71/114/118 resolvePageId + linkEntityIdentity',
    case: {
      method: 'linkEntityIdentityRow', variant,
      rows: [[/SELECT id FROM pages/i, [{ id: 7 }]]],
      run: e => e.linkEntityIdentityRow({ entityId: 'alice', slug: 'people/alice-example', sourceId: 'default', confidence: 1, establishedBy: 'manual', canonical }),
    },
    texts: [
      'SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL',
      ...(canonical === true ? ['UPDATE entity_identities SET canonical = false WHERE entity_id = $1 AND canonical'] : []),
      `INSERT INTO entity_identities (entity_id, source_id, page_id, confidence, established_by, canonical)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::boolean, false))
       ON CONFLICT (source_id, page_id) DO UPDATE SET
         entity_id = EXCLUDED.entity_id,
         confidence = EXCLUDED.confidence,
         established_by = EXCLUDED.established_by,
         canonical = CASE WHEN $6::boolean IS NULL
           THEN entity_identities.canonical AND entity_identities.entity_id = EXCLUDED.entity_id
           ELSE EXCLUDED.canonical END,
         established_at = now()`,
    ],
  })),
  {
    from: 'src/core/entity-identity.ts:146 unlinkEntityIdentity',
    case: { method: 'unlinkEntityIdentityRow', variant: 'default', run: e => e.unlinkEntityIdentityRow({ entityId: 'alice', slug: 'people/alice-example', sourceId: 'default' }) },
    texts: [`DELETE FROM entity_identities ei
     USING pages p
     WHERE ei.page_id = p.id
       AND ei.entity_id = $1
       AND p.slug = $2
       AND ei.source_id = $3
     RETURNING ei.id`],
  },
  // Equivalent statement, not byte for byte: master expanded each source list into `IN ($4, $5)` placeholders;
  // engine-sql binds the list once as `= ANY($n::text[])` (check-engine-sql-dynamic bans a composed `IN (`
  // list). The same sources match, so the same rows come back in the same order. The rest of the text is verbatim.
  ...([
    ['all', {}],
    ['entity', { entityId: 'alice' }],
    ['seed+grant+private', { entityId: 'alice', slug: 'people/alice-example', slugSourceId: 'default', allowedSources: ['default', 'team'], excludePrivate: true }],
  ] as const).map(([variant, filter]): Pin => ({
    from: 'src/core/entity-identity.ts:220 listEntityIdentities (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listEntityIdentityRows', variant, run: e => e.listEntityIdentityRows(filter) },
    texts: () => {
      const f = filter as { entityId?: string; slug?: string; excludePrivate?: boolean };
      const where: string[] = [];
      if (f.excludePrivate) where.push(privatePagesFilterForCaller('p'));
      if (f.entityId) where.push('ei.entity_id = $1');
      if (f.slug) {
        where.push(`ei.entity_id IN (
      SELECT ei2.entity_id FROM entity_identities ei2
      JOIN pages p2 ON p2.id = ei2.page_id AND p2.source_id = ei2.source_id
      WHERE p2.slug = $2 AND p2.deleted_at IS NULL AND ei2.source_id = $3 AND ei2.source_id = ANY($4::text[]) AND ${privatePagesFilterForCaller('p2')}
    )`);
        where.push('ei.source_id = ANY($5::text[])');
      }
      return [`SELECT ei.entity_id, ei.source_id, p.slug, p.title, ei.confidence,
              ei.established_by, ei.established_at, ei.canonical
       FROM entity_identities ei
       JOIN pages p ON p.id = ei.page_id AND p.source_id = ei.source_id AND p.deleted_at IS NULL
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ei.entity_id COLLATE "C", ei.canonical DESC, ei.source_id COLLATE "C", p.slug COLLATE "C"`];
    },
  })),
  {
    from: 'src/core/entity-identity.ts:266 identityIdsForPages',
    case: { method: 'readEntityIdentityIdsForPages', variant: 'default', run: e => e.readEntityIdentityIdsForPages([{ sourceId: 'default', slug: 'people/alice-example' }]) },
    texts: [`SELECT ei.entity_id, ei.source_id, p.slug
         FROM entity_identities ei
         JOIN pages p ON p.id = ei.page_id AND p.source_id = ei.source_id AND p.deleted_at IS NULL
        WHERE ei.source_id = ANY($1::text[]) AND p.slug = ANY($2::text[])`],
  },
  {
    from: 'src/core/google/counterparty.ts:35 canonicalTwin',
    case: { method: 'readCanonicalTwin', variant: 'default', run: e => e.readCanonicalTwin('default', 'people/alice-example') },
    texts: [`SELECT c.slug, ei.source_id
         FROM entity_identities me
         JOIN pages p ON p.id = me.page_id AND p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL
         JOIN entity_identities ei ON ei.entity_id = me.entity_id AND ei.canonical AND ei.source_id <> $1
         JOIN pages c ON c.id = ei.page_id AND c.deleted_at IS NULL
        LIMIT 2`],
  },
  ...([[false, false], [true, true]] as const).map(([excludePrivate, floored]): Pin => ({
    from: 'src/core/mentions/referrers.ts:233 readReferrerGroups (with referrersCte at :108)',
    case: {
      method: 'readReferrerGroupRows', variant: excludePrivate ? 'remote+floor' : 'local',
      run: e => e.readReferrerGroupRows({ sources: ['default'], slugs: ['companies/acme-example'] }, {
        referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], excludePrivate,
        eligibility: floored ? { floor: 'operator_curated' } : undefined, includeQuarantined: false, perGroup: 10,
      }),
    },
    texts: () => [`WITH tgt AS MATERIALIZED (
      SELECT t.id FROM pages t JOIN unnest($1::text[], $2::text[]) AS k(s, g) ON t.source_id = k.s AND t.slug = k.g
       WHERE t.deleted_at IS NULL${excludePrivate ? ` AND ${privatePagesFilterForCaller('t')}` : ''}
    ),
    refs AS MATERIALIZED (
      SELECT DISTINCT l.from_page_id AS id FROM links l WHERE l.to_page_id IN (SELECT id FROM tgt)${excludePrivate ? ` AND ${privateLinkOriginFilterForCaller('l')}` : ''}
    ),
    typed AS MATERIALIZED (
      SELECT f.id, f.slug, f.source_id, f.type,
             COALESCE(f.effective_date, f.updated_at) AS d,
             COALESCE(($5::text[])[array_position($4::text[], f.type)], NULLIF(f.type, ''), 'untyped') AS canonical_type
        FROM pages f
       WHERE f.id IN (SELECT id FROM refs)
         AND f.deleted_at IS NULL AND f.source_id = ANY($3::text[])
         AND f.id NOT IN (SELECT id FROM tgt)${excludePrivate ? ` AND ${privatePagesFilterFastForCaller('f')}` : ''} AND ${pageEligibleSql('f', floored ? { floor: 'operator_curated' } : undefined)} AND ${quarantineFilterFragment('f')}
    ),
     counts AS (SELECT canonical_type, count(*)::int AS n FROM typed GROUP BY canonical_type)
     SELECT x.id, x.slug, x.source_id, x.type, c.canonical_type, to_char(x.d AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS d, c.n AS gtotal
       FROM counts c CROSS JOIN LATERAL (
         SELECT * FROM typed t WHERE t.canonical_type = c.canonical_type ORDER BY t.d DESC NULLS LAST, t.source_id COLLATE "C", t.slug COLLATE "C" LIMIT $6
       ) x
      ORDER BY c.canonical_type COLLATE "C", x.d DESC NULLS LAST, x.source_id COLLATE "C", x.slug COLLATE "C"`],
  })),
  ...([[false, false], [true, true]] as const).map(([excludePrivate, floored]): Pin => ({
    from: 'src/core/mentions/referrers.ts:387 readTargetReferences counts (with referrersCteBatched at :274)',
    case: {
      method: 'readReferrerTargetCounts', variant: excludePrivate ? 'remote+floor' : 'local',
      run: e => e.readReferrerTargetCounts({ sources: ['default', 'default'], slugs: ['companies/acme-example', 'people/alice-example'], indexes: [0, 1] }, {
        referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], excludePrivate,
        eligibility: floored ? { floor: 'operator_curated' } : undefined, includeQuarantined: false, recordTypes: ['meeting'],
      }),
    },
    texts: () => [`WITH tgt AS MATERIALIZED (
      SELECT k.i, t.id FROM pages t JOIN unnest($1::text[], $2::text[], $3::int[]) AS k(s, g, i) ON t.source_id = k.s AND t.slug = k.g
       WHERE t.deleted_at IS NULL${excludePrivate ? ` AND ${privatePagesFilterForCaller('t')}` : ''}
    ),
    refs AS MATERIALIZED (
      SELECT DISTINCT tg.i, l.from_page_id AS id FROM links l JOIN tgt tg ON l.to_page_id = tg.id WHERE true${excludePrivate ? ` AND ${privateLinkOriginFilterForCaller('l')}` : ''}
    ),
    typed AS MATERIALIZED (
      SELECT r.i, f.id, f.slug, f.source_id, f.type,
             COALESCE(f.effective_date, f.updated_at) AS d,
             COALESCE(($6::text[])[array_position($5::text[], f.type)], NULLIF(f.type, ''), 'untyped') AS canonical_type
        FROM refs r JOIN pages f ON f.id = r.id
       WHERE f.deleted_at IS NULL AND f.source_id = ANY($4::text[])
         AND NOT EXISTS (SELECT 1 FROM tgt x WHERE x.i = r.i AND x.id = f.id)${excludePrivate ? ` AND ${privatePagesFilterFastForCaller('f')}` : ''} AND ${pageEligibleSql('f', floored ? { floor: 'operator_curated' } : undefined)} AND ${quarantineFilterFragment('f')}
    )
     SELECT i, NULL::text AS canonical_type, count(*)::int AS n FROM typed GROUP BY i
     UNION ALL
     SELECT i, canonical_type, count(*)::int AS n FROM typed WHERE canonical_type = ANY($7::text[]) GROUP BY i, canonical_type`],
  })),
  {
    from: 'src/core/mentions/referrers.ts:99 hydrate',
    case: { method: 'readReferrerPageDetails', variant: 'default', run: e => e.readReferrerPageDetails([7, 3]) },
    texts: () => [`SELECT id, title, left(${boundedBodyPrefixSql('pages')}, 4000) AS body,
            CASE WHEN effective_date IS NULL THEN 'updated_at' ELSE COALESCE(effective_date_source, 'effective_date') END AS date_source,
            trust_tier, write_origin, ${activationSuppressedSql('pages', 'pages')} AS flagged, frontmatter
       FROM pages WHERE id = ANY($1::int[])`],
  },
  {
    from: 'src/core/ops/backlinks-paged.ts:50 targetSource (at 97bf5544dd)',
    case: { method: 'listReferrerTargetSources', variant: 'default', run: e => e.listReferrerTargetSources('companies/acme-example', ['default', 'other']) },
    texts: ['SELECT source_id FROM pages WHERE slug = $1 AND source_id = ANY($2::text[]) AND deleted_at IS NULL'],
  },
  ...([[false, false], [true, true]] as const).map(([excludePrivate, floored]): Pin => ({
    from: 'src/core/mentions/referrers.ts:143 readReferrerPage count (with referrersCte at mentions/referrers-sql.ts:43; lines at 97bf5544dd)',
    case: {
      method: 'countReferrerRows', variant: excludePrivate ? 'remote+floor' : 'local',
      run: e => e.countReferrerRows({ sources: ['default'], slugs: ['companies/acme-example'] }, {
        referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], excludePrivate,
        eligibility: floored ? { floor: 'operator_curated' } : undefined, includeQuarantined: false, type: 'meeting',
      }),
    },
    texts: () => [`${pinnedReferrersCte(excludePrivate, floored)} SELECT count(*)::int AS n FROM typed WHERE ($6::text IS NULL OR canonical_type = $6 OR type = $6)`],
  })),
  ...([[false, false, false], [true, true, true]] as const).map(([excludePrivate, floored, cursor]): Pin => ({
    // The cursor date binds as text ($7::text::timestamptz): bound as timestamptz, postgres.js cut it to milliseconds.
    from: `src/core/mentions/referrers.ts:151 readReferrerPage rows (${cursor ? 'after a cursor, its date bound as text since a4198fc65a' : 'first page'}; at 97bf5544dd)`,
    case: {
      method: 'readReferrerRows', variant: cursor ? 'remote+floor+cursor' : 'local',
      run: e => e.readReferrerRows({ sources: ['default'], slugs: ['companies/acme-example'] }, {
        referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], excludePrivate,
        eligibility: floored ? { floor: 'operator_curated' } : undefined, includeQuarantined: false, type: null,
        cursor: cursor ? ['2026-04-01T00:00:00.000000Z', 'default', 'notes/a-tie'] : null, limit: 3,
      }),
    },
    texts: () => [`${pinnedReferrersCte(excludePrivate, floored)}
     SELECT id, slug, source_id, type, canonical_type, to_char(d AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS d FROM typed
      WHERE ($6::text IS NULL OR canonical_type = $6 OR type = $6)${cursor ? ` AND ((d IS NOT DISTINCT FROM $7::text::timestamptz AND (source_id COLLATE "C", slug COLLATE "C") > ($8::text, $9::text))
                OR ($7::text::timestamptz IS NOT NULL AND (d < $7::text::timestamptz OR d IS NULL)))` : ''}
      ORDER BY d DESC NULLS LAST, source_id COLLATE "C", slug COLLATE "C" LIMIT $${cursor ? 10 : 7}`],
  })),
  ...([[false, false], [true, true]] as const).map(([excludePrivate, floored]): Pin => ({
    from: 'src/core/mentions/referrers.ts:369 readTargetReferences candidates (with referrersCteBatched at mentions/referrers-sql.ts:69; lines at 97bf5544dd)',
    case: {
      method: 'readReferrerRecordCandidates', variant: excludePrivate ? 'remote+floor' : 'local',
      run: e => e.readReferrerRecordCandidates({ sources: ['default', 'default'], slugs: ['companies/acme-example', 'people/alice-example'], indexes: [0, 1] }, {
        referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], excludePrivate,
        eligibility: floored ? { floor: 'operator_curated' } : undefined, includeQuarantined: false, recordTypes: ['meeting'], perTarget: 5,
      }),
    },
    texts: () => [`WITH tgt AS MATERIALIZED (
      SELECT k.i, t.id FROM pages t JOIN unnest($1::text[], $2::text[], $3::int[]) AS k(s, g, i) ON t.source_id = k.s AND t.slug = k.g
       WHERE t.deleted_at IS NULL${excludePrivate ? ` AND ${privatePagesFilterForCaller('t')}` : ''}
    ),
    refs AS MATERIALIZED (
      SELECT DISTINCT tg.i, l.from_page_id AS id FROM links l JOIN tgt tg ON l.to_page_id = tg.id WHERE true${excludePrivate ? ` AND ${privateLinkOriginFilterForCaller('l')}` : ''}
    ),
    typed AS MATERIALIZED (
      SELECT r.i, f.id, f.slug, f.source_id, f.type,
             COALESCE(f.effective_date, f.updated_at) AS d,
             COALESCE(($6::text[])[array_position($5::text[], f.type)], NULLIF(f.type, ''), 'untyped') AS canonical_type
        FROM refs r JOIN pages f ON f.id = r.id
       WHERE f.deleted_at IS NULL AND f.source_id = ANY($4::text[])
         AND NOT EXISTS (SELECT 1 FROM tgt x WHERE x.i = r.i AND x.id = f.id)${excludePrivate ? ` AND ${privatePagesFilterFastForCaller('f')}` : ''} AND ${pageEligibleSql('f', floored ? { floor: 'operator_curated' } : undefined)} AND ${quarantineFilterFragment('f')}
    )
     SELECT x.i, x.id, x.slug, x.source_id, x.canonical_type, to_char(x.d AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS d
       FROM (SELECT DISTINCT i FROM tgt) q CROSS JOIN LATERAL (
         SELECT * FROM typed t WHERE t.i = q.i AND t.canonical_type = ANY($7::text[])
          ORDER BY t.d DESC NULLS LAST, t.source_id COLLATE "C", t.slug COLLATE "C" LIMIT $8
       ) x
      ORDER BY x.i, x.d DESC NULLS LAST, x.source_id COLLATE "C", x.slug COLLATE "C"`],
  })),
  ...([[false, false], [true, true]] as const).map(([excludePrivate, floored]): Pin => ({
    from: 'src/core/mentions/referrers.ts:131 referrerTypes (with referrersCte at mentions/referrers-sql.ts:43; lines at a4198fc65a)',
    case: {
      method: 'readReferrerTypes', variant: excludePrivate ? 'remote+floor' : 'local',
      run: e => e.readReferrerTypes({ sources: ['default'], slugs: ['companies/acme-example'] }, {
        referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], excludePrivate,
        eligibility: floored ? { floor: 'operator_curated' } : undefined, includeQuarantined: false,
      }),
    },
    texts: () => [`${pinnedReferrersCte(excludePrivate, floored)} SELECT DISTINCT canonical_type, type FROM typed`],
  })),
  {
    // Not the caller's text: `COLLATE "C"` was added so a Postgres server with a linguistic locale orders the ids
    // in byte order, as PGLite and the Rust engine do (test/engine-parity/source-resolver-reads.test.ts).
    from: 'src/core/ops/backlinks-paged.ts:46 scopeSources and :149 backlinkTypeFilter (at a4198fc65a), plus COLLATE "C"',
    case: { method: 'listSourceIds', variant: 'default', run: e => e.listSourceIds() },
    texts: ['SELECT id FROM sources ORDER BY id COLLATE "C"'],
  },
  ...([
    'src/core/mentions/pass.ts:148 sourcesInScope', 'src/core/access/open-pages.ts:167 openPages', 'src/core/link-single-value.ts:82 previewSingleValue',
    'src/commands/doctor/skill-checks.ts:257 listSourceIds',
  ]).map((from): Pin => ({
    // Not the caller's text: the caller sent 'SELECT id FROM sources ORDER BY id'; COLLATE "C" makes Postgres give byte order.
    from: `${from} (at f579f07cfc), plus COLLATE "C"`,
    case: { method: 'listSourceIds', variant: 'default', run: e => e.listSourceIds() },
    texts: ['SELECT id FROM sources ORDER BY id COLLATE "C"'],
  })),
  {
    // Not the caller's text: the caller sent 'SELECT id FROM sources' with no order; listSourceIds adds ORDER BY id COLLATE "C".
    from: 'src/cli/enforced-member.ts:178 (at f579f07cfc), plus ORDER BY id COLLATE "C"',
    case: { method: 'listSourceIds', variant: 'default', run: e => e.listSourceIds() },
    texts: ['SELECT id FROM sources ORDER BY id COLLATE "C"'],
  },
  ...(['src/core/context/corpus-source.ts:250 soleSourceId', 'src/commands/sweep.ts:230', 'src/commands/doctor/checks/memory-writeback.ts:132 corpusSourceHoldProblem'])
    .map((from): Pin => ({
      from: `${from} (at f579f07cfc)`,
      case: { method: 'readSoleSourceId', variant: 'default', run: e => e.readSoleSourceId() },
      texts: ['SELECT id FROM sources ORDER BY id LIMIT 2'],
    })),
  {
    // Not the caller's text: the caller's id tie-break had no COLLATE "C", so a Postgres server with a linguistic locale
    // picked another first id than PGLite and the Rust engine when no `default` source exists.
    from: 'src/commands/doctor/checks/origin-twins.ts:35 (at f579f07cfc), plus COLLATE "C" on the id tie-break',
    case: { method: 'readFirstSourceId', variant: 'default', run: e => e.readFirstSourceId() },
    texts: [`SELECT id FROM sources ORDER BY (id = 'default') DESC, id COLLATE "C" LIMIT 1`],
  },
  ...(['src/core/persistence/deactivation.ts:298', 'src/core/persistence/pre-activation-release.ts:80']).map((from): Pin => ({
    from: `${from} (at f579f07cfc)`,
    case: { method: 'lockAllSourceRows', variant: 'update', run: e => e.lockAllSourceRows('update') },
    texts: ['SELECT id FROM sources ORDER BY id FOR UPDATE'],
  })),
  {
    from: 'src/core/persistence/skill-activation.ts:56 (at f579f07cfc)',
    case: { method: 'lockAllSourceRows', variant: 'share', run: e => e.lockAllSourceRows('share') },
    texts: ['SELECT id FROM sources ORDER BY id FOR SHARE'],
  },
  {
    from: 'src/core/mentions/referrers.ts:414 hydrateRecords (at 97bf5544dd)',
    case: { method: 'readReferrerRecordPages', variant: 'default', run: e => e.readReferrerRecordPages([7, 3]) },
    texts: [`SELECT id, title, CASE WHEN effective_date IS NULL THEN 'updated_at' ELSE COALESCE(effective_date_source, 'effective_date') END AS date_source
         FROM pages WHERE id = ANY($1::int[])`],
  },
  {
    from: 'src/core/access/owner-only.ts:56 ownerOnlySourcesPresent (rust-engine/main reads the v320 lineage function, OWNER_ONLY_LINEAGE_PRESENT_SQL)',
    case: { method: 'readOwnerOnlySourcesPresent', variant: 'default', run: e => e.readOwnerOnlySourcesPresent() },
    texts: ['SELECT gbrain_owner_only_lineage() AS present'],
  },
  {
    from: 'src/core/access/owner-only.ts:66 sourceIsOwnerOnly',
    case: { method: 'readOwnerOnlySourceConfig', variant: 'default', run: e => e.readOwnerOnlySourceConfig('default') },
    texts: ['SELECT config FROM sources WHERE id = $1'],
  },
  {
    from: 'src/core/context/session-state.ts:201 upsertSessionContextState, at eb30f47b89',
    case: { method: 'upsertSessionState', variant: 'default', run: e => e.upsertSessionState('default', 'local', 's', { standingEntities: ['people/alice-example'], surfacedSlugs: ['notes/a'], lastWakeAt: '2026-11-19T00:00:00Z', replaceStanding: true, replaceCursorSlug: true, factsCursorAt: null, factsCursorId: null, degradedWakes: 'increment' }) },
    texts: [`INSERT INTO session_context_state
         (source_id, client_id, session_id, standing_entities, surfaced_slugs, last_wake_at,
          facts_cursor_at, facts_cursor_id, degraded_wakes, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, $5::text::jsonb, $6::text::timestamptz, $9::text::timestamptz, $10::bigint,
               CASE WHEN $11::text = 'increment' THEN 1 ELSE 0 END, now())
       ON CONFLICT (source_id, client_id, session_id) DO UPDATE SET
         standing_entities = CASE WHEN $7::boolean THEN EXCLUDED.standing_entities
                                  ELSE session_context_state.standing_entities END,
         surfaced_slugs    = CASE WHEN $8::boolean THEN EXCLUDED.surfaced_slugs
                                  ELSE session_context_state.surfaced_slugs END,
         last_wake_at      = COALESCE(EXCLUDED.last_wake_at, session_context_state.last_wake_at),
         facts_cursor_at   = COALESCE(EXCLUDED.facts_cursor_at, session_context_state.facts_cursor_at),
         facts_cursor_id   = CASE WHEN EXCLUDED.facts_cursor_at IS NULL THEN session_context_state.facts_cursor_id
                                  ELSE EXCLUDED.facts_cursor_id END,
         degraded_wakes    = CASE $11::text WHEN 'increment' THEN session_context_state.degraded_wakes + 1
                                            WHEN 'reset' THEN 0
                                            ELSE session_context_state.degraded_wakes END,
         updated_at        = now()
       RETURNING degraded_wakes`],
  },
  {
    from: 'src/core/context/session-state.ts:113 getSessionContextState, at eb30f47b89',
    case: { method: 'readSessionCursor', variant: 'default', run: e => e.readSessionCursor('default', 'local', 's') },
    texts: [`SELECT standing_entities, surfaced_slugs,
              to_char(last_wake_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_wake_at
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`],
  },
  {
    from: 'src/core/context/session-state.ts:148 readDeltaSessionState, at eb30f47b89',
    case: { method: 'readDeltaSessionRow', variant: 'default', run: e => e.readDeltaSessionRow('default', 'local', 's') },
    texts: [`SELECT surfaced_slugs, to_char(last_wake_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_wake_at,
              to_char(facts_cursor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS facts_cursor_at, facts_cursor_id, degraded_wakes
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`],
  },
  {
    from: 'src/core/context/session-state.ts:299 getCheckpointManifest, at eb30f47b89',
    case: { method: 'readCheckpointManifestRow', variant: 'default', run: e => e.readCheckpointManifestRow('default', 'local', 's') },
    texts: [`SELECT checkpoint_manifest
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`],
  },
  {
    from: 'src/core/context/session-state.ts:355 appendCheckpointManifest, at eb30f47b89',
    case: { method: 'writeCheckpointManifest', variant: 'default', run: e => e.writeCheckpointManifest('default', 'local', 's', [{ slug: 'notes/a', title: 'A' }]) },
    texts: [`INSERT INTO session_context_state
         (source_id, client_id, session_id, checkpoint_manifest, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, now())
       ON CONFLICT (source_id, client_id, session_id) DO UPDATE SET
         checkpoint_manifest = EXCLUDED.checkpoint_manifest,
         updated_at          = now()`],
  },
  {
    from: 'src/core/context/session-state.ts:389 gcSessionContextState (age-out), at eb30f47b89',
    case: { method: 'ageOutSessionState', variant: 'default', run: e => e.ageOutSessionState(7) },
    texts: [`DELETE FROM session_context_state WHERE updated_at < now() - ($1 || ' days')::interval`],
  },
  {
    // The caller's statement at eb30f47b89, with `, session_id COLLATE "C"` added to the window's ORDER BY so tied
    // updated_at values rank by session_id bytes on every engine (test/engine-parity/session-state-cap.test.ts).
    from: 'src/core/context/session-state.ts:394 gcSessionContextState (per-client cap), at eb30f47b89',
    case: { method: 'capSessionStatePerClient', variant: 'default', run: e => e.capSessionStatePerClient(1000) },
    texts: [`DELETE FROM session_context_state s
       USING (
         SELECT source_id, client_id, session_id,
                row_number() OVER (
                  PARTITION BY source_id, client_id ORDER BY updated_at DESC, session_id COLLATE "C"
                ) AS rn
         FROM session_context_state
       ) ranked
       WHERE s.source_id = ranked.source_id
         AND s.client_id = ranked.client_id
         AND s.session_id = ranked.session_id
         AND ranked.rn > $1`],
  },
  {
    from: 'src/core/ops/facts.ts:706 withProvenance, at 0a68889b57',
    case: { method: 'listFactProvenance', variant: 'default', run: e => e.listFactProvenance('default', [1, 2]) },
    texts: ['SELECT id, source FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[]) ORDER BY id'],
  },
  {
    from: 'src/core/belief/writers.ts:41 ontologyStreamSlugs, at 432ac446f4',
    case: { method: 'listOntologyStreamSlugs', variant: 'default', run: e => e.listOntologyStreamSlugs('default', 'people/a', 'role') },
    texts: [`SELECT DISTINCT source_markdown_slug AS slug FROM facts
    WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND expired_at IS NULL AND valid_until IS NULL AND COALESCE(source, '') NOT LIKE 'cli:extract-conversation-facts%'`],
  },
  {
    from: 'src/core/trust/supersede-handlers.ts:169 contestOntologySupersession, at 432ac446f4',
    case: { method: 'readOntologyRival', variant: 'default', run: e => e.readOntologyRival('default', 'people/a', 'role', 1) },
    texts: [`SELECT id, trust_tier FROM facts WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND id <> $4
       AND expired_at IS NULL AND valid_until IS NULL AND (dim_status IS NULL OR dim_status = 'active') AND COALESCE(source, '') NOT LIKE 'cli:extract-conversation-facts%'
     ORDER BY valid_from DESC NULLS LAST, confidence DESC, id DESC LIMIT 1`],
  },
  {
    from: 'src/core/belief/writers.ts:29 beliefStreamSlugs (facts), at d2671f1342',
    case: { method: 'listBeliefStreamSlugs', variant: 'facts', run: e => e.listBeliefStreamSlugs('facts', [1, 2]) },
    texts: ['SELECT COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts WHERE id = ANY($1::bigint[])'],
  },
  {
    from: 'src/core/belief/writers.ts:29 beliefStreamSlugs (takes), at d2671f1342',
    case: { method: 'listBeliefStreamSlugs', variant: 'takes', run: e => e.listBeliefStreamSlugs('takes', [1]) },
    texts: ['SELECT p.slug FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = ANY($1::bigint[])'],
  },
  {
    from: 'src/core/belief/writers.ts:29 beliefStreamSlugs (pages), at d2671f1342',
    case: { method: 'listBeliefStreamSlugs', variant: 'pages', run: e => e.listBeliefStreamSlugs('pages', [1]) },
    texts: ['SELECT slug FROM pages WHERE id = ANY($1::int[])'],
  },
  {
    from: 'src/core/trust/privacy-hold-reply.ts:67 hiddenHoldRefs (a private-facts grant), at d2671f1342',
    case: { method: 'listUnreadablePrivacyHoldIds', variant: 'granted', run: e => withCallerAccess({ privateFactSources: ['default'] }, () => e.listUnreadablePrivacyHoldIds([1, 2])) },
    texts: () => withCallerAccess({ privateFactSources: ['default'] }, () => {
      const admits = [memberFactAdmitSql('f'), grantedPrivateFactSql('f')];
      return [`SELECT tp.id FROM trust_proposals tp LEFT JOIN facts f ON tp.target_table = 'facts' AND f.id = tp.target_id
        WHERE tp.id = ANY($1::bigint[]) AND tp.action = 'supersede_fact' AND tp.before_state->'visibility' IS NOT NULL
          AND (f.id IS NULL OR NOT (${admits.join(' OR ')}))`];
    }),
  },
  {
    from: 'src/core/access/caller.ts:196 mayActForOf (legacy token)',
    case: { method: 'readMayActFor', variant: 'legacy-token', run: e => e.readMayActFor('legacy_token', 'tok-1') },
    texts: ['SELECT may_act_for FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/access/caller.ts:200 mayActForOf (OAuth client)',
    case: { method: 'readMayActFor', variant: 'oauth-client', run: e => e.readMayActFor('oauth_client', 'client-1') },
    texts: ['SELECT may_act_for FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL'],
  },
  {
    from: 'src/core/access/caller.ts:204 mayActForOf (stdio config)',
    case: { method: 'readMayActFor', variant: 'stdio-config', run: e => e.readMayActFor('stdio_config', 'mcp.stdio_may_act_for') },
    texts: ['SELECT value FROM config WHERE key = $1'],
  },
  {
    from: 'src/core/access/caller.ts:253 resolveAudienceIdentities (members, then groups; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAudiencePrincipals', variant: 'members-and-groups', run: e => e.readAudiencePrincipals(['alice-example'], ['team-a']) },
    texts: [`SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = ANY($1::text[]) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`, 'SELECT id FROM access_groups WHERE id = ANY($1::text[])'],
  },
  {
    from: 'src/core/access/caller.ts:253 resolveAudienceIdentities (an empty list reads nothing)',
    case: { method: 'readAudiencePrincipals', variant: 'groups-only', run: e => e.readAudiencePrincipals([], ['team-a']) },
    texts: ['SELECT id FROM access_groups WHERE id = ANY($1::text[])'],
  },
  {
    from: 'src/core/access/caller.ts:168 folderAccessForAll (rules, then coverage; at 949a7c98cc; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readFolderAccess', variant: 'readers', run: e => e.readFolderAccess(['member:alice-example', 'group:team-a']) },
    texts: ['SELECT source_id, rule_id, readable_by FROM access_rules WHERE readable_by && $1::text[]', `SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id COLLATE "C", prefix COLLATE "C"`],
  },
  {
    from: 'src/core/access/caller.ts:171 folderAccessForAll (no readers reads the coverage only; at 949a7c98cc; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readFolderAccess', variant: 'no-readers', run: e => e.readFolderAccess([]) },
    texts: [`SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id COLLATE "C", prefix COLLATE "C"`],
  },
  {
    from: 'src/core/access/policy.ts:92 readAccessStore (at 6e123afe98)',
    case: { method: 'readAccessStoreConfig', variant: 'default', run: e => e.readAccessStoreConfig('src-a') },
    texts: [`SELECT config->>'access_store' AS store FROM sources WHERE id = $1`],
  },
  {
    from: 'src/core/access/policy.ts:99 writeAccessStore (at 6e123afe98)',
    case: { method: 'writeAccessStoreConfig', variant: 'default', run: e => e.writeAccessStoreConfig('src-a', 'database') },
    texts: [`UPDATE sources SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{access_store}', to_jsonb($2::text)) WHERE id = $1`],
  },
  {
    from: 'src/core/access/policy.ts:104 ensurePolicyState (at 6e123afe98)',
    case: { method: 'ensureAccessPolicyState', variant: 'default', run: e => e.ensureAccessPolicyState('src-a') },
    texts: ['INSERT INTO access_policy_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING'],
  },
  {
    from: 'src/core/access/policy.ts:112 and :113 lockSource (at 6e123afe98)',
    case: { method: 'lockAccessPolicy', variant: 'default', run: e => e.lockAccessPolicy('src-a') },
    texts: ['SELECT 1 FROM sources WHERE id = $1 FOR NO KEY UPDATE', 'SELECT 1 FROM access_policy_state WHERE source_id = $1 FOR UPDATE'],
  },
  {
    from: 'src/core/access/policy.ts:117 appliedRules (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAccessRules', variant: 'default', run: e => e.listAccessRules('src-a') },
    texts: ['SELECT rule_id, prefix, readable_by, covers_derived FROM access_rules WHERE source_id = $1 ORDER BY rule_id COLLATE "C"'],
  },
  {
    from: 'src/core/access/policy.ts:123 listRevisions (at 6e123afe98)',
    case: { method: 'readAccessPolicyRevisions', variant: 'recent', run: e => e.readAccessPolicyRevisions({ by: 'recent', sourceId: 'src-a', limit: 50 }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT $2'],
  },
  {
    from: 'src/core/access/policy.ts:130 getRevision (latest) (at 6e123afe98)',
    case: { method: 'readAccessPolicyRevisions', variant: 'latest', run: e => e.readAccessPolicyRevisions({ by: 'latest', sourceId: 'src-a' }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT 1'],
  },
  {
    from: 'src/core/access/policy.ts:131 getRevision (one revision) (at 6e123afe98)',
    case: { method: 'readAccessPolicyRevisions', variant: 'revision', run: e => e.readAccessPolicyRevisions({ by: 'revision', sourceId: 'src-a', revision: 2 }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE source_id = $1 AND revision = $2'],
  },
  {
    from: 'src/core/access/policy.ts:246 proposeRevision (idempotency read) (at 6e123afe98)',
    case: { method: 'readAccessPolicyRevisions', variant: 'operation', run: e => e.readAccessPolicyRevisions({ by: 'operation', operationId: 'op-1' }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE operation_id = $1'],
  },
  {
    from: 'src/core/access/policy.ts:136 coverageRows (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAccessCoverage', variant: 'default', run: e => e.listAccessCoverage('src-a') },
    texts: ['SELECT prefix, reason, revision, detail FROM access_pending_coverage WHERE source_id = $1 ORDER BY reason COLLATE "C", prefix COLLATE "C"'],
  },
  {
    from: 'src/core/access/policy.ts:151 requireReadableAccessState (at 6e123afe98)',
    case: { method: 'readAccessStateUnreadable', variant: 'default', run: e => e.readAccessStateUnreadable() },
    texts: ['SELECT gbrain_access_state_unreadable() AS unreadable'],
  },
  {
    from: 'src/core/access/policy.ts:168, :174 and :179 installRulebook (at 6e123afe98)',
    case: { method: 'applyAccessRuleChanges', variant: 'default', run: e => e.applyAccessRuleChanges('src-a', { remove: ['old'], insert: [{ rule_id: 'team', prefix: 'team/', readable_by: ['member:alice-example'], covers_derived: true }], pending: ['team/'], revision: 2, actor: 'cli' }) },
    texts: ['DELETE FROM access_rules WHERE source_id = $1 AND rule_id = $2', 'INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision, created_by, covers_derived) VALUES ($1, $2, $3, $4::text[], $5, $6, $7)', `INSERT INTO access_pending_coverage (source_id, prefix, reason, revision) VALUES ($1, $2, 'pending', $3)
      ON CONFLICT (source_id, prefix, reason) DO UPDATE SET revision = EXCLUDED.revision`],
  },
  {
    from: 'src/core/access/policy.ts:198 restampSource (batched window) (at 6e123afe98)',
    case: { method: 'restampAccessWindow', variant: 'default', run: e => e.restampAccessWindow('src-a', 0, 2000) },
    texts: [`WITH w AS (SELECT id FROM pages WHERE source_id = $1 AND id > $2 ORDER BY id LIMIT $3),
        u AS (UPDATE pages p SET folder_rule_ids = gbrain_access_folder_rules(p.source_id, p.slug) FROM w
              WHERE p.id = w.id AND p.folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(p.source_id, p.slug) RETURNING p.id)
      SELECT (SELECT max(id) FROM w) AS last, (SELECT count(*) FROM w)::int AS scanned, (SELECT count(*) FROM u)::int AS changed`],
  },
  {
    from: 'src/core/access/policy.ts:212, :216 and :217 restampSource (final pass) (at 6e123afe98)',
    case: { method: 'finishAccessRestamp', variant: 'default', run: e => e.finishAccessRestamp('src-a') },
    texts: [`UPDATE pages SET folder_rule_ids = gbrain_access_folder_rules(source_id, slug)
        WHERE source_id = $1 AND folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(source_id, slug) RETURNING id`, `DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'pending'`, 'UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL'],
  },
  {
    from: 'src/core/access/policy.ts:263 proposeRevision (revision insert) (at 6e123afe98)',
    case: { method: 'insertAccessPolicyRevision', variant: 'default', run: e => e.insertAccessPolicyRevision({ source_id: 'src-a', revision: 2, rules: [], digest: 'd', change_kind: 'narrowing', origin: 'cli', operation_id: null, proposed_by: 'cli', approved_by: 'auto:narrowing', approved: true }) },
    texts: [`INSERT INTO access_policy_revisions (source_id, revision, rules, digest, change_kind, origin, operation_id, proposed_by, approved_by, approved_at)
      VALUES ($1, $2, $3::text::jsonb, $4, $5, $6, $7, $8, $9, CASE WHEN $10::boolean THEN now() END)`],
  },
  {
    from: 'src/core/access/policy.ts:268 proposeRevision (applied mark) (at 6e123afe98)',
    case: { method: 'markAccessRevisionsApplied', variant: 'all', run: e => e.markAccessRevisionsApplied('src-a') },
    texts: ['UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL'],
  },
  {
    from: 'src/core/access/policy.ts:388 applyApproved (applied mark) (at 6e123afe98)',
    case: { method: 'markAccessRevisionsApplied', variant: 'up-to', run: e => e.markAccessRevisionsApplied('src-a', 3) },
    texts: ['UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL AND revision <= $2'],
  },
  {
    from: 'src/core/access/policy.ts:387 applyApproved (approval) (at 6e123afe98)',
    case: { method: 'approveAccessPolicyRevision', variant: 'default', run: e => e.approveAccessPolicyRevision('src-a', 3, 'cli') },
    texts: ['UPDATE access_policy_revisions SET approved_by = $3, approved_at = now() WHERE source_id = $1 AND revision = $2'],
  },
  {
    from: 'src/core/access/policy.ts:296 resumePolicy (at 6e123afe98)',
    case: { method: 'hasAccessPolicyState', variant: 'default', run: e => e.hasAccessPolicyState('src-a') },
    texts: ['SELECT count(*)::int AS n FROM access_policy_state WHERE source_id = $1'],
  },
  {
    from: 'src/core/access/policy.ts:348 previewApply (derived release) (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAccessPrefixSlugs', variant: 'one-prefix', run: e => e.listAccessPrefixSlugs('src-a', 'team/') },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND starts_with(slug, $2) ORDER BY slug COLLATE "C"'],
  },
  {
    from: 'src/core/access/policy.ts:354 previewApply (widened prefixes) (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAccessPrefixSlugs', variant: 'prefixes', run: e => e.listAccessPrefixSlugs('src-a', ['team/', 'old/']) },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE starts_with(slug, pfx)) ORDER BY slug COLLATE "C"'],
  },
  {
    from: 'src/core/access/policy.ts:420 policyStatus (at 6e123afe98)',
    case: { method: 'readAccessPolicyMarks', variant: 'default', run: e => e.readAccessPolicyMarks('src-a') },
    texts: ['SELECT max(revision) FILTER (WHERE applied_at IS NOT NULL) AS applied, max(revision) FILTER (WHERE approved_at IS NOT NULL) AS approved FROM access_policy_revisions WHERE source_id = $1'],
  },
  {
    from: 'src/core/access/policy.ts:420 and :431 policyStatus (with an operation) (at 6e123afe98)',
    case: { method: 'readAccessPolicyMarks', variant: 'operation', run: e => e.readAccessPolicyMarks('src-a', 'op-1') },
    texts: ['SELECT max(revision) FILTER (WHERE applied_at IS NOT NULL) AS applied, max(revision) FILTER (WHERE approved_at IS NOT NULL) AS approved FROM access_policy_revisions WHERE source_id = $1', 'SELECT revision, applied_at, approved_at FROM access_policy_revisions WHERE source_id = $1 AND operation_id = $2'],
  },
  {
    from: 'src/core/access/policy.ts:450 and :452 markPolicyInvalid (at 6e123afe98)',
    case: { method: 'replaceAccessInvalidCoverage', variant: 'prefixes', run: e => e.replaceAccessInvalidCoverage('src-a', ['bad/'], { line: 3 }) },
    texts: [`DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'invalid'`, `INSERT INTO access_pending_coverage (source_id, prefix, reason, detail) VALUES ($1, $2, 'invalid', $3::text::jsonb)`],
  },
  {
    from: 'src/core/access/policy.ts:459 clearPolicyInvalid (at 6e123afe98)',
    case: { method: 'replaceAccessInvalidCoverage', variant: 'clear', run: e => e.replaceAccessInvalidCoverage('src-a', [], null) },
    texts: [`DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'invalid'`],
  },
  {
    from: 'src/core/access/members.ts:124 getMember (one member by id; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessMembers', variant: 'by-id', run: e => e.readAccessMembers({ id: 'alice-example' }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.id = $1 GROUP BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:160 memberByEmail and :143 assertEmailFree (members declaring one email; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessMembers', variant: 'by-email', run: e => e.readAccessMembers({ email: 'alice@example.com' }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.email = $1 GROUP BY m.id ORDER BY m.id COLLATE "C"`],
  },
  {
    from: 'src/core/access/members.ts:129 listMembers (removed members filtered out; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessMembers', variant: 'live', run: e => e.readAccessMembers({ includeRemoved: false }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.tombstoned_at IS NULL GROUP BY m.id ORDER BY m.id COLLATE "C"`],
  },
  {
    from: 'src/core/access/members.ts:129 listMembers (--all; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessMembers', variant: 'all', run: e => e.readAccessMembers({ includeRemoved: true }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id GROUP BY m.id ORDER BY m.id COLLATE "C"`],
  },
  {
    from: 'src/commands/access-serves.ts:135 unboundCredentials (tokens) (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listUnboundTokenNames', variant: 'default', run: e => e.listUnboundTokenNames() },
    texts: ['SELECT DISTINCT name COLLATE "C" AS name FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NULL ORDER BY name'],
  },
  {
    from: 'src/commands/access-serves.ts:136 unboundCredentials (clients) (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listUnboundClientIds', variant: 'default', run: e => e.listUnboundClientIds() },
    texts: ['SELECT client_id FROM oauth_clients WHERE deleted_at IS NULL AND member_id IS NULL ORDER BY client_id COLLATE "C"'],
  },
  {
    from: 'src/commands/access-serves.ts:186 member key plan (live token) (at 6e123afe98)',
    case: { method: 'readLiveAccessToken', variant: 'default', run: e => e.readLiveAccessToken('member-alice-example') },
    texts: ['SELECT member_id, token_hash, source_grant, source_id, federated_read, permissions FROM access_tokens WHERE name = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/commands/access-serves.ts:197 member key plan (active sources) (at 6e123afe98); also grants/legacy-token.ts:193 assertActiveSources (at 5a32485552)',
    case: { method: 'filterUnarchivedSourceIds', variant: 'default', run: e => e.filterUnarchivedSourceIds(['src-a', 'src-b']) },
    texts: ['SELECT id FROM sources WHERE id = ANY($1::text[]) AND archived IS NOT TRUE'],
  },
  {
    from: 'src/commands/access-serves.ts:241 recordSetupReads (at 6e123afe98)',
    case: { method: 'recordTokenSetupReads', variant: 'default', run: e => e.recordTokenSetupReads('member-alice-example', ['src-a']) },
    texts: ["UPDATE access_tokens SET permissions = COALESCE(permissions, '{}'::jsonb) || jsonb_build_object('setup_reads', $2::text[]) WHERE name = $1 AND revoked_at IS NULL AND (permissions IS NULL OR jsonb_typeof(permissions) = 'object')"],
  },
  {
    from: 'src/commands/access-serves.ts:251 keysStillReading (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listKeysReadingSource', variant: 'default', run: e => e.listKeysReadingSource('src-a') },
    texts: ["SELECT name, member_id, federated_read FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NOT NULL AND source_grant = 'federated' AND source_id <> $1 AND $1 = ANY(federated_read) ORDER BY name COLLATE \"C\""],
  },
  {
    from: 'src/commands/access-serves.ts:265 companyCounts (at 6e123afe98)',
    case: { method: 'countCompanyPages', variant: 'default', run: e => e.countCompanyPages('company') },
    texts: ["SELECT count(*)::int AS pages, count(*) FILTER (WHERE slug LIKE 'company/calls/%')::int AS calls FROM pages WHERE source_id = $1 AND deleted_at IS NULL"],
  },
  {
    from: 'src/commands/access-serves.ts:339 serves key mint (revoke on a failed key file) (at 6e123afe98)',
    case: { method: 'revokeAccessTokenById', variant: 'default', run: e => e.revokeAccessTokenById('00000000-0000-0000-0000-000000000001') },
    texts: ['UPDATE access_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/access/policy-migrate.ts:41 unfinished (at 6e123afe98)',
    case: { method: 'readUnfinishedAccessMigration', variant: 'default', run: e => e.readUnfinishedAccessMigration('src-a') },
    texts: ["SELECT id, phase, direction, receipts FROM access_policy_migrations WHERE source_id = $1 AND phase <> 'switched' ORDER BY created_at DESC LIMIT 1"],
  },
  {
    from: 'src/core/access/policy-migrate.ts:80 migratePolicyStore (start) (at 6e123afe98)',
    case: { method: 'insertAccessMigration', variant: 'default', run: e => e.insertAccessMigration('mig_1', 'src-a', 'to_git') },
    texts: ["INSERT INTO access_policy_migrations (id, source_id, direction, phase) VALUES ($1, $2, $3, 'started')"],
  },
  {
    from: 'src/core/access/policy-migrate.ts:85 migratePolicyStore (record a phase) (at 6e123afe98)',
    case: { method: 'recordAccessMigrationPhase', variant: 'default', run: e => e.recordAccessMigrationPhase('mig_1', 'exported', { approved: 'abc' }) },
    texts: ['UPDATE access_policy_migrations SET phase = $2, receipts = $3::text::jsonb, updated_at = now() WHERE id = $1'],
  },
  {
    from: 'src/core/access/policy-migrate.ts:104 migratePolicyStore (switch) (at 6e123afe98)',
    case: { method: 'switchAccessMigration', variant: 'default', run: e => e.switchAccessMigration('mig_1', { approved: 'abc' }) },
    texts: ["UPDATE access_policy_migrations SET phase = 'switched', receipts = $2::text::jsonb, updated_at = now() WHERE id = $1"],
  },
  {
    from: 'src/core/access/policy-transfer.ts:34 exportPolicyFiles (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAccessPolicySources', variant: 'default', run: e => e.listAccessPolicySources() },
    texts: ['SELECT source_id FROM access_policy_state ORDER BY source_id COLLATE "C"'],
  },
  {
    from: 'src/core/access/serves.ts:38 unlabeledPeopleFolders (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'countPeopleFolderPages', variant: 'default', run: e => e.countPeopleFolderPages() },
    texts: [`SELECT source_id, split_part(slug, '/', 2) AS folder, count(*)::int AS pages FROM pages
      WHERE deleted_at IS NULL AND slug LIKE 'people/%/%' GROUP BY 1, 2 ORDER BY source_id COLLATE "C", split_part(slug, '/', 2) COLLATE "C"`],
  },
  {
    from: 'src/core/sweep.ts:216 runMaintenanceSweep pass 1 (the facts-fence pages, at c231d6c992)',
    case: { method: 'listFactsFencePages', variant: 'default', run: e => e.listFactsFencePages({ sourceId: 'default', since: '2026-01-01T00:00:00.000Z', scanCap: 500, limit: 8 }) },
    texts: [`SELECT slug FROM (
             SELECT id, slug, compiled_truth, body_storage, updated_at FROM pages
              WHERE source_id = $1
                AND deleted_at IS NULL
                AND updated_at >= $2::timestamptz
              ORDER BY updated_at DESC
              LIMIT $4
           ) AS recent
            WHERE compiled_truth LIKE $3
               OR (body_storage = 'segmented' AND EXISTS (SELECT 1 FROM page_body_manifest m
                     WHERE m.page_id = recent.id AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.facts_slots <> '[]'::jsonb))
            ORDER BY updated_at DESC
            LIMIT $5`],
  },
  {
    from: 'src/core/sweep.ts:381 runLinksTimelinePass (the link-stale recent pages, at c231d6c992)',
    case: { method: 'listSweepStalePages', variant: 'default', run: e => e.listSweepStalePages({ sourceId: 'default', since: '2026-01-01T00:00:00.000Z', limit: 8, exclude: ['a'] }) },
    texts: [`SELECT slug, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso,
            body_storage, body_bytes
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND updated_at >= $2::timestamptz
        AND (links_extracted_at IS NULL OR updated_at > links_extracted_at)
        AND NOT (slug = ANY($4::text[]))
      ORDER BY updated_at DESC
      LIMIT $3`],
  },
  {
    from: 'src/core/sweep.ts:655 liveDeferredPages (the deferred pages still stale, at c231d6c992)',
    case: { method: 'listSweepDeferredPages', variant: 'default', run: e => e.listSweepDeferredPages({ sourceId: 'default', since: '2026-01-01T00:00:00.000Z', slugs: ['a'] }) },
    texts: [`SELECT slug, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND updated_at >= $2::timestamptz
        AND (links_extracted_at IS NULL OR updated_at > links_extracted_at)
        AND slug = ANY($3::text[])`],
  },
  {
    // An equivalent statement: the caller sent `slug IN ($1, ...)`, 200 slugs to a statement; the member binds every slug
    // as one array (`slug = ANY($1::text[])`), so its text does not change with the number of slugs. A slug named twice
    // reads its pages once, where two chunks could read them twice.
    from: 'src/core/link-reconciliation.ts:442 lookupRefsForSlugs (the links and timeline pass\'s page refs, at 932324b281)',
    case: { method: 'listPageRefsForSlugs', variant: 'default', run: e => e.listPageRefsForSlugs(['a', 'b']) },
    texts: [`SELECT slug, source_id, type, knowledge_revision FROM pages
        WHERE deleted_at IS NULL AND slug = ANY($1::text[])`],
  },
  {
    from: 'src/core/access/open-pages.ts:187 openPages (the open-page count, rendered in the pinned access context)',
    case: { method: 'countOpenPages', variant: 'default', run: e => e.countOpenPages(['default'], [{ source: 'default', prefix: 'x/' }]) },
    texts: () => [`SELECT p.source_id AS source, CASE WHEN strpos(p.slug, '/') > 0 THEN split_part(p.slug, '/', 1) ELSE '(root)' END AS folder,
              p.type AS type, (${privacyPartSql('p')}) AS visible, count(*)::int AS pages
         FROM pages p
        WHERE p.deleted_at IS NULL AND ${accessAllowedSql('p', [], [])} AND p.source_id = ANY($1::text[]) AND NOT (p.source_id = $2 AND starts_with(p.slug, $3))
        GROUP BY 1, 2, 3, 4`],
  },
  {
    from: 'src/core/access/members.ts:199 legacyTokenByName (active tokens with one name)',
    case: { method: 'readAccessCredentials', variant: 'token-name', run: e => e.readAccessCredentials({ tokenName: 'laptop' }) },
    texts: ['SELECT id::text AS id, name FROM access_tokens WHERE name = $1 AND revoked_at IS NULL ORDER BY created_at, id'],
  },
  {
    from: 'src/core/access/members.ts:305/307 boundCredentials (tokens, then clients; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessCredentials', variant: 'member', run: e => e.readAccessCredentials({ memberId: 'alice-example' }) },
    texts: ['SELECT id::text AS id, name FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL ORDER BY name COLLATE "C", id',
      "SELECT client_id AS id, client_name AS name FROM oauth_clients WHERE member_id = $1 AND (to_jsonb(oauth_clients)->>'deleted_at') IS NULL ORDER BY client_id COLLATE \"C\""],
  },
  {
    from: 'src/core/access/members.ts:295 audienceMemberIds (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAudienceAccessMembers', variant: 'default', run: e => e.listAudienceAccessMembers() },
    texts: [`SELECT id FROM access_members WHERE kind = 'audience' AND disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id COLLATE "C"`],
  },
  {
    from: 'src/core/access/members.ts:345 listGroups (every group; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessGroups', variant: 'all', run: e => e.readAccessGroups(null) },
    texts: [`SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id COLLATE "C") FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
      GROUP BY g.id ORDER BY g.id COLLATE "C"`],
  },
  {
    from: 'src/core/access/members.ts:345 listGroups (one group by id; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessGroups', variant: 'by-id', run: e => e.readAccessGroups('team-a') },
    texts: [`SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id COLLATE "C") FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
     WHERE g.id = $1 GROUP BY g.id ORDER BY g.id COLLATE "C"`],
  },
  {
    from: 'src/core/access/members.ts:303 pagesNaming (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listPagesNamingReader', variant: 'default', run: e => e.listPagesNamingReader('member:alice-example') },
    texts: [`SELECT slug, source_id FROM pages WHERE frontmatter ? 'readable_by' AND gbrain_access_readers(frontmatter) @> ARRAY[$1]::text[]
     ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT 51`],
  },
  {
    from: 'src/commands/access-read-by-nobody.ts:45 pagesReadByNobodyNaming (at 30750dcd6c; the columns read slug first like the default read, and the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listPagesNamingReader', variant: 'live', run: e => e.listPagesNamingReader('member:alice-example', { live: true }) },
    texts: [`SELECT slug, source_id FROM pages WHERE deleted_at IS NULL AND frontmatter ? 'readable_by' AND gbrain_access_readers(frontmatter) @> ARRAY[$1]::text[]
     ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT 201`],
  },
  {
    from: 'src/core/wakeshift/forget.ts:23 forgetWakePrincipal (member), called from members.ts removeMember',
    case: { method: 'forgetWakeMember', variant: 'default', run: e => e.forgetWakeMember('alice-example') },
    texts: [
      `INSERT INTO wake_forgets (wake_user) SELECT DISTINCT wake_user FROM wake_subscriptions WHERE member_id = $1
        ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING RETURNING id`,
      `UPDATE wake_subscriptions SET state = 'ended', last_error = 'principal_revoked', lease_until = NULL, updated_at = now()
        WHERE member_id = $1 AND state = 'open' RETURNING id`,
      'DELETE FROM wake_terms_acceptances WHERE principal_key = $1',
    ],
  },
  {
    from: 'src/core/wakeshift/forget.ts forgetWakePrincipal (credential), called from auth.ts revoke/revokeById/revokeClient and token-mint.ts revokeLegacyTokenById',
    case: { method: 'forgetWakeCredential', variant: 'default', run: e => e.forgetWakeCredential('oauth_client', 'client-a') },
    texts: [
      `INSERT INTO wake_forgets (wake_user) SELECT DISTINCT wake_user FROM wake_subscriptions
      WHERE principal_kind = $1 AND principal_id = $2 AND member_id IS NULL
      ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING RETURNING id`,
      `UPDATE wake_subscriptions SET state = 'ended', last_error = 'principal_revoked', lease_until = NULL, updated_at = now()
      WHERE principal_kind = $1 AND principal_id = $2 AND state = 'open' RETURNING id`,
      'DELETE FROM wake_terms_acceptances WHERE principal_key = $1',
    ],
  },
  {
    from: 'src/commands/auth.ts revoke (by name)',
    case: { method: 'revokeAccessTokensNamed', variant: 'default', run: e => e.revokeAccessTokensNamed('laptop') },
    texts: [`
      UPDATE access_tokens SET revoked_at = now()
      WHERE name = $1 AND revoked_at IS NULL
      RETURNING id
    `],
  },
  {
    from: 'src/commands/auth.ts revokeById, src/core/token-mint.ts revokeLegacyTokenById',
    case: { method: 'revokeAccessToken', variant: 'default', run: e => e.revokeAccessToken('00000000-0000-4000-8000-0000000000c1') },
    texts: [`
      UPDATE access_tokens SET revoked_at = now()
      WHERE id = $1::uuid AND revoked_at IS NULL
      RETURNING name
    `],
  },
  {
    from: 'src/commands/auth.ts revokeClient',
    case: { method: 'deleteOAuthClient', variant: 'default', run: e => e.deleteOAuthClient('client-a') },
    texts: [`
        DELETE FROM oauth_clients WHERE client_id = $1
        RETURNING client_id, client_name
      `],
  },
  {
    from: 'src/core/oauth-grants.ts revokeToken (at d8d9956871; the template, as $N text)',
    case: { method: 'deleteOauthTokenByHash', variant: 'default', run: e => e.deleteOauthTokenByHash('hash-x', 'client-a') },
    texts: ['DELETE FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2'],
  },
  {
    from: 'src/core/oauth-grants.ts revokeClient soft delete (at d8d9956871)',
    case: { method: 'softDeleteOauthClient', variant: 'default', run: e => e.softDeleteOauthClient('client-a') },
    texts: ['UPDATE oauth_clients SET deleted_at = now() WHERE client_id = $1'],
  },
  {
    from: 'src/core/oauth-grants.ts revokeClient codes (at d8d9956871)',
    case: { method: 'deleteOauthClientCodes', variant: 'default', run: e => e.deleteOauthClientCodes('client-a') },
    texts: ['DELETE FROM oauth_codes WHERE client_id = $1'],
  },
  {
    from: 'src/core/oauth-grants.ts revokeClient tokens (at d8d9956871)',
    case: { method: 'deleteOauthClientTokens', variant: 'default', run: e => e.deleteOauthClientTokens('client-a') },
    texts: ['DELETE FROM oauth_tokens WHERE client_id = $1'],
  },
  {
    from: 'src/core/grants/lifecycle.ts delete (at d8d9956871)',
    case: { method: 'deleteOauthClientRow', variant: 'default', run: e => e.deleteOauthClientRow('client-a') },
    texts: ['DELETE FROM oauth_clients WHERE client_id = $1'],
  },
  {
    from: 'src/core/grants/lifecycle.ts revoke (at d8d9956871)',
    case: { method: 'setOauthClientRevision', variant: 'revoke', run: e => e.setOauthClientRevision('client-a', 2, true) },
    texts: ['UPDATE oauth_clients SET deleted_at = COALESCE(deleted_at, now()), grant_revision = $1 WHERE client_id = $2'],
  },
  {
    from: 'src/core/grants/lifecycle.ts invalidate-tokens (at d8d9956871)',
    case: { method: 'setOauthClientRevision', variant: 'invalidate', run: e => e.setOauthClientRevision('client-a', 2, false) },
    texts: ['UPDATE oauth_clients SET grant_revision = $1 WHERE client_id = $2'],
  },
  {
    from: 'src/core/grants/service.ts stampReadShared and src/core/grants/lifecycle.ts invalidate-tokens (at 3c72fae727)',
    case: { method: 'setOauthClientReadSharedRevision', variant: 'stamp', run: e => e.setOauthClientReadSharedRevision('client-a', 3) },
    texts: ['UPDATE oauth_clients SET read_shared_revision = $2 WHERE client_id = $1'],
  },
  {
    from: 'src/core/grants/read-shared.ts sharedRows (at 3c72fae727; its SqlQuery tag sent each ${} as the next $n)',
    case: { method: 'readSharedSourceRows', variant: 'default', run: e => e.readSharedSourceRows() },
    texts: [`
    SELECT s.id, s.config,
      (COALESCE(s.config->>'guest' = 'true', false) OR EXISTS (SELECT 1 FROM guest_sources gs WHERE gs.source_id = s.id)) AS guest,
      ARRAY(SELECT ms.member_id FROM access_member_sources ms WHERE ms.source_id = s.id ORDER BY ms.member_id) AS owners,
      (SELECT btrim(c.value) FROM config c WHERE c.key = $1) AS owner_member
    FROM sources s WHERE s.archived IS NOT TRUE ORDER BY s.id COLLATE "C"`],
  },
  {
    from: 'src/core/grants/service.ts stampReadShared clear (at 3c72fae727)',
    case: { method: 'setOauthClientReadSharedRevision', variant: 'clear', run: e => e.setOauthClientReadSharedRevision('client-a', null) },
    texts: ['UPDATE oauth_clients SET read_shared_revision = $2 WHERE client_id = $1'],
  },
  {
    from: 'src/core/grants/lifecycle.ts audit (at d8d9956871)',
    case: { method: 'insertOauthGrantAudit', variant: 'default', run: e => e.insertOauthGrantAudit({ client_id: 'client-a', actor: 'admin', action: 'revoke', revision: 2, before_grant: '{}', after_grant: '{}' }) },
    texts: [`INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
      VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb)`],
  },
  {
    from: 'src/commands/serve-http-admin-api.ts health-indicators expiring_soon (at dca1a50918)',
    case: { method: 'countOauthAccessTokens', variant: 'between', run: e => e.countOauthAccessTokens(1, 2) },
    texts: ["SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at BETWEEN $1 AND $2"],
  },
  {
    from: 'src/commands/serve-http-admin-api.ts stats active_tokens (at dca1a50918)',
    case: { method: 'countOauthAccessTokens', variant: 'after', run: e => e.countOauthAccessTokens(1, null) },
    texts: ["SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at > $1"],
  },
  {
    from: 'src/commands/serve-http-admin-api.ts stats requests_today (at dca1a50918)',
    case: { method: 'countMcpRequestsLastDay', variant: 'all', run: e => e.countMcpRequestsLastDay('all') },
    texts: ["SELECT count(*)::int as count FROM mcp_request_log WHERE created_at > now() - interval '24 hours'"],
  },
  {
    from: 'src/commands/serve-http-admin-api.ts health-indicators total (at dca1a50918)',
    case: { method: 'countMcpRequestsLastDay', variant: 'traffic', run: e => e.countMcpRequestsLastDay('traffic') },
    texts: ["SELECT count(*)::int as count FROM mcp_request_log WHERE operation != 'surface_change' AND created_at > now() - interval '24 hours'"],
  },
  {
    from: 'src/commands/serve-http-admin-api.ts health-indicators errors (at dca1a50918)',
    case: { method: 'countMcpRequestsLastDay', variant: 'errors', run: e => e.countMcpRequestsLastDay('errors') },
    texts: ["SELECT count(*)::int as count FROM mcp_request_log WHERE status NOT IN ('success', 'success_with_warnings', 'accepted_pending') AND operation != 'surface_change' AND created_at > now() - interval '24 hours'"],
  },
  {
    // New text: the agents list's per-row correlated subselects became one grouped read over the asked names.
    from: 'src/commands/serve-http-admin-api.ts agents requests_today (grouped, new at dca1a50918)',
    case: { method: 'countMcpRequestsLastDayByToken', variant: 'default', run: e => e.countMcpRequestsLastDayByToken(['client-a']) },
    texts: [`SELECT token_name, count(*)::int AS requests FROM mcp_request_log
    WHERE token_name = ANY($1::text[]) AND created_at > now() - interval '24 hours' GROUP BY token_name ORDER BY token_name COLLATE "C"`],
  },
  {
    from: 'src/commands/auth.ts:180 list (at 837c389e52)',
    case: { method: 'listAccessTokens', variant: 'default', run: e => e.listAccessTokens() },
    texts: [`
      SELECT * FROM access_tokens
      ORDER BY created_at DESC
    `],
  },
  {
    from: 'src/core/token-mint.ts:192 readActiveTokenPrivatePages (at 837c389e52)',
    case: { method: 'readActiveAccessTokenGrant', variant: 'private-pages', run: e => e.readActiveAccessTokenGrant('00000000-0000-4000-8000-0000000000c1', 'private_pages') },
    texts: ['SELECT private_pages FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/token-mint.ts:209 readActiveTokenPermissions (at 837c389e52)',
    case: { method: 'readActiveAccessTokenGrant', variant: 'permissions', run: e => e.readActiveAccessTokenGrant('00000000-0000-4000-8000-0000000000c1', 'permissions') },
    texts: ['SELECT permissions FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/wakeshift/drain.ts:80 principalLive (legacy token, at 837c389e52)',
    case: { method: 'accessTokenLive', variant: 'default', run: e => e.accessTokenLive('00000000-0000-4000-8000-0000000000c1') },
    texts: ['SELECT 1 FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/wakeshift/drain.ts:77 principalLive (OAuth client, at 837c389e52)',
    case: { method: 'oauthClientLive', variant: 'default', run: e => e.oauthClientLive('client-a') },
    texts: ['SELECT 1 FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL'],
  },
  {
    from: 'src/commands/auth.ts:581 preflightOauthClientColumns (at 837c389e52)',
    case: { method: 'readOauthClientColumns', variant: 'preflight', run: e => e.readOauthClientColumns('preflight') },
    texts: [`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'oauth_clients'
      AND table_schema = current_schema()
      AND column_name IN ('token_ttl', 'surface', 'federated_read', 'source_id', 'deleted_at')
  `],
  },
  {
    from: 'src/core/oauth-provider.ts:1112 registerClientManual column probe (at 837c389e52)',
    case: { method: 'readOauthClientColumns', variant: 'grant', run: e => e.readOauthClientColumns('grant') },
    texts: [`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'oauth_clients'
        AND column_name IN ('grant_revision', 'allowed_operations', 'delegated_slug_prefixes', 'delegated_namespace', 'grant_profile', 'grant_repair_reasons', 'surface', 'surface_set_by', 'token_ttl', 'source_id', 'federated_read', 'bound_slug_prefixes', 'bound_tools', 'bound_source_id', 'bound_brain_id', 'bound_max_concurrent', 'budget_usd_per_day')`],
  },
  {
    from: 'src/commands/auth.ts:677 registerScopedClient token_ttl write (at 837c389e52; the template, as $N text)',
    case: { method: 'setOauthClientTokenTtl', variant: 'default', run: e => e.setOauthClientTokenTtl('client-a', 3600) },
    texts: [`
        UPDATE oauth_clients SET token_ttl = $1
        WHERE client_id = $2
        RETURNING client_id
      `],
  },
  {
    from: 'src/commands/auth.ts:1111 tokenLifetimeClampedClients (at 837c389e52)',
    case: { method: 'readTokenLifetimeClampedClients', variant: 'default', run: e => e.readTokenLifetimeClampedClients() },
    texts: [`SELECT DISTINCT client_id FROM oauth_grant_audit WHERE actor = 'migration' AND action IN ('clamp_token_ttl', 'shorten_access_tokens')`],
  },
  {
    from: 'src/core/access/attest-sources.ts:67 markedScopeSources FOR UPDATE (at 758c3b853e)',
    case: { method: 'readScopeSourceConfigs', variant: 'update', run: e => e.readScopeSourceConfigs(['team-a'], 'update') },
    texts: ['SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR UPDATE'],
  },
  {
    from: 'src/core/access/attest-sources.ts:69 markedScopeSources FOR SHARE (at 758c3b853e)',
    case: { method: 'readScopeSourceConfigs', variant: 'share', run: e => e.readScopeSourceConfigs(['team-a'], 'share') },
    texts: ['SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR SHARE'],
  },
  {
    from: 'src/core/access/attest-sources.ts:70 markedScopeSources (at 758c3b853e)',
    case: { method: 'readScopeSourceConfigs', variant: 'default', run: e => e.readScopeSourceConfigs(['team-a']) },
    texts: ['SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))'],
  },  {
    from: 'src/core/oauth-provider.ts:778 verifyAccessToken OAuth rung 0 (at d51679a5fd)',
    case: { method: 'readOauthAccessTokenRows', variant: 'rung0', run: e => e.readOauthAccessTokenRows('hash-x', 0) },
    texts: [`
        SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes, to_jsonb(t)->>'grant_type' AS token_grant,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
               c.source_id, c.federated_read, c.bound_slug_prefixes,
               c.surface, c.surface_set_by
        FROM oauth_tokens t
        LEFT JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
      `],
  },
  {
    from: 'src/core/oauth-provider.ts:824 verifyAccessToken OAuth rung 1 (at d51679a5fd)',
    case: { method: 'readOauthAccessTokenRows', variant: 'rung1', run: e => e.readOauthAccessTokenRows('hash-x', 1) },
    texts: [`
          SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
                 c.source_id, c.federated_read, c.bound_slug_prefixes
          FROM oauth_tokens t
          LEFT JOIN oauth_clients c ON c.client_id = t.client_id
          WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
        `],
  },
  {
    from: 'src/core/oauth-provider.ts:841 verifyAccessToken OAuth rung 2 (at d51679a5fd)',
    case: { method: 'readOauthAccessTokenRows', variant: 'rung2', run: e => e.readOauthAccessTokenRows('hash-x', 2) },
    texts: [`
            SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
                   c.source_id, c.federated_read
            FROM oauth_tokens t
            LEFT JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
          `],
  },
  {
    from: 'src/core/oauth-provider.ts:858 verifyAccessToken OAuth rung 3 (at d51679a5fd)',
    case: { method: 'readOauthAccessTokenRows', variant: 'rung3', run: e => e.readOauthAccessTokenRows('hash-x', 3) },
    texts: [`
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources, c.source_id
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
            `],
  },
  {
    from: 'src/core/oauth-provider.ts:873 verifyAccessToken OAuth rung 4 (at d51679a5fd)',
    case: { method: 'readOauthAccessTokenRows', variant: 'rung4', run: e => e.readOauthAccessTokenRows('hash-x', 4) },
    texts: [`
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
            `],
  },
  {
    from: 'src/core/grants/legacy-token.ts:240 rescopeInTransaction by id (at 30750dcd6c)',
    case: { method: 'lockActiveAccessTokens', variant: 'by-id', run: e => e.lockActiveAccessTokens({ id: '00000000-0000-4000-8000-0000000000b1' }) },
    texts: ['SELECT * FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL FOR UPDATE'],
  },
  {
    from: 'src/core/grants/legacy-token.ts:241 rescopeInTransaction by name (at 30750dcd6c)',
    case: { method: 'lockActiveAccessTokens', variant: 'by-name', run: e => e.lockActiveAccessTokens({ name: 'laptop' }) },
    texts: ['SELECT * FROM access_tokens WHERE name = $1 AND revoked_at IS NULL FOR UPDATE'],
  },
  {
    from: 'src/core/grants/legacy-token.ts:211 writeTokenGrant (at 5a32485552)',
    case: { method: 'writeAccessTokenGrant', variant: 'default', run: e => e.writeAccessTokenGrant('00000000-0000-4000-8000-0000000000b1',
      { columns: { source_grant: 'federated', source_id: 'default', federated_read: ['default', 'wiki'], allowed_operations: null, takes_holders: ['world'] },
        scopes: ['read'], permissions: { source_id: ['default', 'wiki'] } }) },
    texts: [`UPDATE access_tokens SET source_grant = $2, source_id = $3, federated_read = $4::text[], allowed_operations = $5::text[],
       takes_holders = $6::text[], scopes = COALESCE($7::text[], scopes), grant_revision = grant_revision + 1, permissions = $8::jsonb
     WHERE id = $1::uuid RETURNING grant_revision`],
  },
  {
    from: 'src/core/grants/legacy-token.ts:317 rescopeInTransaction --private-pages (at 5a32485552)',
    case: { method: 'writeAccessTokenPrivateGrant', variant: 'private_pages', run: e => e.writeAccessTokenPrivateGrant('00000000-0000-4000-8000-0000000000b1', 'private_pages', 'granted_sources') },
    texts: ['UPDATE access_tokens SET private_pages = $2 WHERE id = $1::uuid'],
  },
  {
    from: 'src/core/grants/legacy-token.ts:321 rescopeInTransaction --private-facts (at 5a32485552)',
    case: { method: 'writeAccessTokenPrivateGrant', variant: 'private_facts', run: e => e.writeAccessTokenPrivateGrant('00000000-0000-4000-8000-0000000000b1', 'private_facts', 'none') },
    texts: ['UPDATE access_tokens SET private_facts = $2 WHERE id = $1::uuid'],
  },
  {
    from: 'src/core/grants/legacy-token.ts:227 writeTokenGrant read-shared re-stamp (at 3c72fae727)',
    case: { method: 'setAccessTokenReadSharedRevision', variant: 'stamp', run: e => e.setAccessTokenReadSharedRevision('00000000-0000-4000-8000-0000000000b1', 4) },
    texts: ['UPDATE access_tokens SET read_shared_revision = $2 WHERE id = $1::uuid'],
  },
  {
    from: 'src/core/grants/legacy-token.ts:347 migrateLegacyTokens (at 5a32485552)',
    case: { method: 'lockLegacyAccessTokens', variant: 'default', run: e => e.lockLegacyAccessTokens() },
    texts: ['SELECT * FROM access_tokens WHERE revoked_at IS NULL AND source_grant IS NULL ORDER BY created_at, id FOR UPDATE'],
  },
  {
    from: 'src/core/persistence/identity.ts:404 revokeLocalWriter (at 6631e1bb57)',
    case: { method: 'revokeLocalWriterRow', variant: 'default', run: e => e.revokeLocalWriterRow('00000000-0000-4000-8000-0000000000c1') },
    texts: ['UPDATE persistence_local_writers SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1::uuid RETURNING id'],
  },
  {
    from: 'src/core/oauth-provider.ts:1021 verifyAccessToken legacy fallback (at d51679a5fd)',
    case: { method: 'readActiveAccessTokenByHash', variant: 'provider', run: e => e.readActiveAccessTokenByHash('hash-x', 'provider') },
    texts: [`
      SELECT * FROM access_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL
    `],
  },
  {
    from: 'src/mcp/http-transport.ts:297 validateToken (at d51679a5fd)',
    case: { method: 'readActiveAccessTokenByHash', variant: 'transport', run: e => e.readActiveAccessTokenByHash('hash-x', 'transport') },
    texts: [`
        SELECT * FROM access_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL
      `],
  },
  {
    from: 'src/core/grants/legacy-token.ts:413 touchTokenLastUsed unified row (at d51679a5fd)',
    case: { method: 'touchAccessTokenLastUsed', variant: 'unified', run: e => e.touchAccessTokenLastUsed('00000000-0000-4000-8000-0000000000b1', true) },
    texts: [`UPDATE access_tokens SET last_used_at = now()
        WHERE id IN (SELECT id FROM access_tokens WHERE id = $1::uuid AND source_grant IS NOT NULL
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED)`],
  },
  {
    from: 'src/core/grants/legacy-token.ts:416 touchTokenLastUsed legacy row (at d51679a5fd)',
    case: { method: 'touchAccessTokenLastUsed', variant: 'legacy', run: e => e.touchAccessTokenLastUsed('00000000-0000-4000-8000-0000000000b1', false) },
    texts: [`UPDATE access_tokens SET last_used_at = now()
        WHERE id IN (SELECT id FROM access_tokens WHERE id = $1::uuid
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED)`],
  },
  {
    from: 'src/core/grants/legacy-token.ts:390 resolveTokenGrant legacy-shape conversion (at afc2094edd)',
    case: { method: 'convertLegacyAccessTokenGrant', variant: 'default', run: e => e.convertLegacyAccessTokenGrant('00000000-0000-4000-8000-0000000000b1',
      { source_grant: 'federated', source_id: 'default', federated_read: ['default', 'wiki'], allowed_operations: null, takes_holders: ['world'] }) },
    texts: [`
      UPDATE access_tokens SET source_grant = $1, source_id = $2, federated_read = $3::text[],
        allowed_operations = $4::text[], takes_holders = $5::text[], grant_revision = grant_revision + 1,
        last_used_at = now()
      WHERE id IN (SELECT id FROM access_tokens WHERE id = $6::uuid AND source_grant IS NULL FOR UPDATE SKIP LOCKED)
      RETURNING *
    `],
  },
  {
    from: 'src/core/oauth-provider.ts:1144 sweepExpiredTokens (at afc2094edd)',
    case: { method: 'deleteExpiredOauthCredentials', variant: 'default', run: e => e.deleteExpiredOauthCredentials(1_700_000_000) },
    texts: [`
      DELETE FROM oauth_tokens WHERE expires_at < $1 RETURNING 1
    `, `
      DELETE FROM oauth_codes WHERE expires_at < $1 RETURNING 1
    `],
  },
  {
    from: 'src/core/mentions/coverage.ts:43 readMentionCoverage',
    case: { method: 'readMentionIndexStatus', variant: 'default', run: e => e.readMentionIndexStatus(['default', 'other']) },
    texts: [`SELECT source_id, state, pending, counted_at, last_pass_at, policy_fingerprint FROM mention_index_status WHERE source_id = ANY($1::text[])`],
  },
  {
    from: 'src/core/mentions/coverage.ts:54 readMentionCoverage',
    case: { method: 'countLivePagesInSource', variant: 'default', run: e => e.countLivePagesInSource('default') },
    texts: ['SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL'],
  },
  {
    from: 'src/core/mentions/coverage.ts:71 readMentionCoverage',
    case: { method: 'countMentionDueSince', variant: 'default', run: e => e.countMentionDueSince('default', '-infinity', 1) },
    texts: [`SELECT count(*)::int AS n FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
        WHERE p.source_id = $1 AND p.updated_at >= $2::text::timestamptz AND p.deleted_at IS NULL
          AND (s.page_id IS NULL OR s.mention_revision IS DISTINCT FROM p.knowledge_revision OR s.mention_version IS DISTINCT FROM $3)`],
  },
  {
    from: 'src/core/mentions/coverage.ts:63 readMentionCoverage (the recount write)',
    case: { method: 'recountMentionIndexStatus', variant: 'default', run: e => e.recountMentionIndexStatus('default', { pending: 2, fingerprint: 'h;v', expectedFingerprint: null }) },
    texts: [`UPDATE mention_index_status SET pending = $2, counted_at = now(), policy_fingerprint = $3, updated_at = now(),
                state = CASE WHEN state = 'complete' AND $2::int > 0 THEN 'pending' ELSE state END
          WHERE source_id = $1 AND policy_fingerprint IS NOT DISTINCT FROM $4`],
  },
  {
    from: 'src/core/entities/resolve.ts:162 tryOrgDirVariant',
    case: { method: 'readLiveSlugs', variant: 'default', run: e => e.readLiveSlugs('default', ['orgs/acme', 'organizations/acme']) },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])'],
  },
  {
    from: 'src/core/entities/resolve.ts:360 findExactBasenameCandidates',
    case: { method: 'readLiveSlugs', variant: 'limit_2', run: e => e.readLiveSlugs('default', ['people/alice-example', 'companies/alice-example'], { limit: 2 }) },
    texts: [`SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])
        LIMIT 2`],
  },
  ...([
    ['none', () => ''],
    ['caller', () => `AND ${privatePagesFilterForCaller('p')}`],
    ['floor', () => `AND ${remoteReadFloorSql('p')}`],
  ] as const).map(([privacy, predicate]): Pin => ({
    from: `src/core/entities/resolve.ts:478 resolveStrictEntityReference live (privacy ${privacy})`,
    case: { method: 'readLivePageTypes', variant: privacy, run: e => e.readLivePageTypes('default', ['people/alice-example'], privacy) },
    texts: () => [`SELECT p.slug, p.type FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug = ANY($2::text[]) ${predicate()}`],
  })),
  ...([
    ['none', () => ''],
    ['caller', () => `AND ${privatePagesFilterForCaller('p')}`],
    ['floor', () => `AND ${remoteReadFloorSql('p')}`],
  ] as const).flatMap(([privacy, predicate]): Pin[] => [
    {
      from: `src/core/entities/resolve.ts:519 resolveStrictEntityReference same name (privacy ${privacy}; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)`,
      case: { method: 'readTrigramCandidates', variant: `same_name_${privacy}`, run: e => e.readTrigramCandidates('default', { arm: 'same_name', titleLc: 'alice example', slugFragment: 'alice-example', privacy }) },
      texts: () => [`SELECT p.slug, p.title, p.type FROM pages p
          WHERE p.source_id = $1 AND p.deleted_at IS NULL ${predicate()} AND NOT ${retiredPageSql('p')}
            AND (lower(p.title) % $2 OR p.slug ILIKE '%' || $3 || '%')
          ORDER BY GREATEST(similarity(lower(p.title), $2), similarity(p.slug, $3)) DESC, p.slug COLLATE "C" ASC
          LIMIT 5`],
    },
    {
      from: `src/core/entities/resolve.ts:567 entityReferenceCandidates near (privacy ${privacy}; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)`,
      case: { method: 'readTrigramCandidates', variant: `near_${privacy}`, run: e => e.readTrigramCandidates('default', { arm: 'near', titleLc: 'alice example', slugFragment: 'alice-example', privacy }) },
      texts: () => [`SELECT p.slug, p.title, p.type FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND NOT ${retiredPageSql('p')} ${predicate()}
        AND (lower(p.title) % $2 OR p.slug ILIKE '%' || $3 || '%')
      ORDER BY GREATEST(similarity(lower(p.title), $2), similarity(p.slug, $3)) DESC, p.slug COLLATE "C" ASC
      LIMIT 20`],
    },
  ]),
  {
    from: 'src/core/entities/resolve.ts:857 tryFuzzyMatch (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readTrigramCandidates', variant: 'fuzzy', run: e => e.readTrigramCandidates('default', { arm: 'fuzzy', titleLc: 'alice example', slugFragment: 'alice-example' }) },
    texts: () => [`SELECT slug, title, type,
         GREATEST(
           similarity(lower(title), $2),
           similarity(slug, $3)
         ) AS score
       FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND NOT ${retiredPageSql('pages')}
         AND (
           lower(title) % $2
           OR slug ILIKE '%' || $3 || '%'
         )
       ORDER BY score DESC, slug COLLATE "C" ASC
       LIMIT 5`],
  },
  {
    from: 'src/core/entities/resolve.ts:686 findPrefixCandidates (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readPrefixCandidates', variant: 'patterns', run: e => e.readPrefixCandidates('default', { patterns: ['people/alice', 'people/alice-%'] }) },
    texts: () => [`SELECT p.slug,
              ((SELECT COUNT(*)::int FROM links l WHERE l.to_page_id = p.id AND ${rankingLinkSql('l')})
               + (SELECT COUNT(*)::int FROM links l WHERE l.from_page_id = p.id AND ${rankingLinkSql('l')})
               + (SELECT COUNT(*)::int FROM content_chunks WHERE page_id = p.id))
                AS connection_count
       FROM pages p
       WHERE p.source_id = $1
         AND p.deleted_at IS NULL
         AND NOT ${retiredPageSql('p')}
         AND p.slug LIKE ANY($2::text[])
       ORDER BY connection_count DESC, p.slug COLLATE "C" ASC
       LIMIT 10`],
  },
  {
    from: 'src/core/entities/resolve.ts:769 tryPrefixExpansion (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readPrefixCandidates', variant: 'pattern', run: e => e.readPrefixCandidates('default', { pattern: 'people/alice-%' }) },
    texts: () => [`SELECT p.slug,
                ((SELECT COUNT(*)::int FROM links l WHERE l.to_page_id = p.id AND ${rankingLinkSql('l')})
                 + (SELECT COUNT(*)::int FROM links l WHERE l.from_page_id = p.id AND ${rankingLinkSql('l')})
                 + (SELECT COUNT(*)::int FROM content_chunks WHERE page_id = p.id))
                  AS connection_count
         FROM pages p
         WHERE p.source_id = $1
           AND p.deleted_at IS NULL
           AND NOT ${retiredPageSql('p')}
           AND p.slug LIKE $2
         ORDER BY connection_count DESC, p.slug COLLATE "C" ASC
         LIMIT 5`],
  },
  {
    from: 'src/core/entities/resolve.ts:732 tryUnambiguousPrefixExpansion dirs',
    case: { method: 'readPrefixDirs', variant: 'default', run: e => e.readPrefixDirs('default', ['people/alice', 'people/alice-%']) },
    texts: () => [`SELECT DISTINCT split_part(slug, '/', 1) AS dir FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND NOT ${retiredPageSql('pages')} AND slug LIKE ANY($2::text[])
        LIMIT 2`],
  },
  {
    from: 'src/core/entities/resolve.ts:739 tryUnambiguousPrefixExpansion exact titles',
    case: { method: 'readPrefixTitleMatches', variant: 'default', run: e => e.readPrefixTitleMatches('default', ['companies/acme', 'companies/acme-%'], 'Acme') },
    texts: () => [`SELECT slug, title FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND NOT ${retiredPageSql('pages')}
          AND slug LIKE ANY($2::text[]) AND lower(title) = lower($3)
        LIMIT 3`],
  },
  ...([
    ['none', () => ''],
    ['caller', () => `AND ${privatePagesFilterForCaller('p')}`],
    ['floor', () => `AND ${remoteReadFloorSql('p')}`],
  ] as const).map(([privacy, predicate]): Pin => ({
    from: `src/core/entities/resolve.ts:552 entityReferenceCandidates named (privacy ${privacy}; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)`,
    case: { method: 'readNamedEntitySlugs', variant: privacy, run: e => e.readNamedEntitySlugs('default', ['companies/acme', 'orgs/acme'], privacy) },
    texts: () => [`SELECT p.slug FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND NOT ${retiredPageSql('p')} AND p.slug = ANY($2::text[]) ${predicate()}
      ORDER BY p.slug COLLATE "C" LIMIT 5`],
  })),
  ...([
    ['all', {}],
    ['sources-run', { sourceIds: ['default'], runId: 'run-1' }],
  ] as const).map(([variant, opts]): Pin => ({
    from: `src/core/persistence/sync-holds.ts:575 readGitSourceHolds (${variant}, at f549f444af; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)`,
    case: { method: 'readGitHoldRecords', variant, run: e => e.readGitHoldRecords(opts) },
    texts: () => [`SELECT ${READ_HOLD_RECORD_SQL} AS record FROM op_checkpoints h
    JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND ($2::text[] IS NULL OR s.id=ANY($2::text[])) AND ($3::text IS NULL OR h.completed_keys->0->>'run_id'=$3)
    ORDER BY s.id COLLATE "C",h.fingerprint COLLATE "C"`],
  })),
  {
    from: 'src/core/sync-dispatch-read.ts:51 syncDispatchRow',
    case: { method: 'readSyncDispatchRow', variant: 'default', run: e => e.readSyncDispatchRow('default') },
    texts: () => [`SELECT s.id, s.archived, s.config, s.incarnation::text AS incarnation, s.local_path,
  EXISTS(SELECT 1 FROM persistence_source_bindings b WHERE b.source_id=s.id AND b.source_incarnation=s.incarnation) AS claimed,
  EXISTS(SELECT 1 FROM source_ingestion_receipts r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.profile='company-brain') AS company_receipt,
  (SELECT COALESCE(jsonb_agg(m.enabled), '[]'::jsonb) FROM (${MANAGED_MODE_SQL}) m) AS modes
  FROM (SELECT $1::text AS want) w LEFT JOIN sources s ON s.id=w.want`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:1186 readGitHoldRetryPaths',
    case: { method: 'readGitHoldRetryRequest', variant: 'default', run: e => e.readGitHoldRetryRequest('default:1') },
    texts: ['SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    // An equivalent statement: the caller read the pairs unordered into a Set; the member orders them by commit, then path.
    from: 'src/core/reason-trailers.ts:151 scanSyncReasons',
    case: { method: 'readReasonPurgeTombstones', variant: 'default', run: e => e.readReasonPurgeTombstones('default') },
    texts: ['SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1 ORDER BY commit_sha, path'],
  },
  {
    from: 'src/core/reason-trailers.ts:262 cachedSyncReasonScan',
    case: { method: 'readSourcePurgeEpoch', variant: 'default', run: e => e.readSourcePurgeEpoch('default') },
    texts: ['SELECT purge_epoch FROM sources WHERE id = $1'],
  },
  {
    from: 'src/core/minions/submission-authority.ts assertCurrentRemoteJobPrincipal (OAuth client; the check now reads readOauthClient, this pins readJobPrincipal)',
    case: { method: 'readJobPrincipal', variant: 'oauth-client', run: e => e.readJobPrincipal({ kind: 'oauth_client', id: 'client-1' }) },
    texts: ['SELECT client_id, deleted_at, scope, source_id, bound_slug_prefixes, surface, allowed_operations FROM oauth_clients WHERE client_id = $1'],
  },
  {
    from: 'src/core/minions/submission-authority.ts:160 assertCurrentRemoteJobPrincipal (legacy token)',
    case: { method: 'readJobPrincipal', variant: 'legacy-token', run: e => e.readJobPrincipal({ kind: 'legacy_token', id: 'tok-1' }) },
    texts: ['SELECT * FROM access_tokens WHERE id = $1'],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:1452,1458 buildHoldReport',
    case: { method: 'readGitHoldReportInputs', variant: 'default', run: e => e.readGitHoldReportInputs('default', 'default:1') },
    texts: [`SELECT COALESCE((completed_keys->0->>'count')::int,0) AS count,
      COALESCE((completed_keys->0->>'drift')::int,0) AS drift,
      COALESCE((completed_keys->0->>'images')::int,0) AS images, COALESCE((completed_keys->0->>'fences')::int,0) AS fences, COALESCE((completed_keys->0->>'stalled')::int,0) AS stalled,
      COALESCE((completed_keys->0->>'concurrent')::int,0) AS concurrent, COALESCE((completed_keys->0->>'dirty')::int,0) AS dirty
    FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`, "SELECT config->>'mirror_read_only' AS mirror FROM sources WHERE id=$1"],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:334 lockSummary (at 8b80bd80ab)',
    case: { method: 'lockGitHoldSummary', variant: 'default', run: e => e.lockGitHoldSummary('default', '1') },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('source_id',$3::text,'incarnation',$4::text,'count',0,'stale',0)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET updated_at=now()
    RETURNING COALESCE((completed_keys->0->>'count')::int,0) AS count`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:351-352 adjustSummary (SUMMARY_COUNTERS rendered) (at 8b80bd80ab)',
    case: { method: 'adjustGitHoldSummary', variant: 'default', run: e => e.adjustGitHoldSummary('default', '1', 1, { stale: 0, images: 0, fences: 0, concurrent: 0, stalled: 0, dirty: 0, drift: 0 }) },
    texts: () => {
      const pairs = ['stale', 'images', 'fences', 'concurrent', 'stalled', 'dirty', 'drift']
        .map((name, i) => `'${name}',GREATEST(0,COALESCE((completed_keys->0->>'${name}')::int,0)+$${i + 4}::int)`).join(',');
      return [`UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0)||jsonb_build_object(
      'count',GREATEST(0,COALESCE((completed_keys->0->>'count')::int,0)+$3::int),${pairs})),updated_at=now() WHERE op=$1 AND fingerprint=$2`];
    },
  },
  {
    from: 'src/core/persistence/sync-holds.ts:368 readRow (at 8b80bd80ab)',
    case: { method: 'readGitHoldRow', variant: 'default', run: e => e.readGitHoldRow('default', '1', 'a.md') },
    texts: ['SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:395 writeGitHold (at 8b80bd80ab)',
    case: { method: 'writeGitHoldRow', variant: 'default', run: e => e.writeGitHoldRow('default', '1', 'a.md', { path: 'a.md' }) },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:456 rewriteHoldMeta (at 8b80bd80ab)',
    case: { method: 'replaceGitHoldRow', variant: 'default', run: e => e.replaceGitHoldRow('default', '1', 'a.md', { path: 'a.md' }, { path: 'a.md', meta: {} }) },
    texts: [`UPDATE op_checkpoints SET completed_keys=$3::text::jsonb, updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND completed_keys=$4::text::jsonb RETURNING 1`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:482 clearGitHold (at 8b80bd80ab)',
    case: { method: 'deleteGitHoldRow', variant: 'default', run: e => e.deleteGitHoldRow('default', '1', 'a.md') },
    texts: ['DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:573 countGitHolds (at 8b80bd80ab)',
    case: { method: 'countGitHolds', variant: 'default', run: e => e.countGitHolds('default', '1') },
    texts: ["SELECT COALESCE((completed_keys->0->>'count')::int,0) AS count FROM op_checkpoints WHERE op=$1 AND fingerprint=$2"],
  },
  {
    from: 'src/core/persistence/sync-pass-row.ts:178 readPassRow (at 8b80bd80ab)',
    case: { method: 'readSyncPassRow', variant: 'default', run: e => e.readSyncPassRow('default', '1') },
    texts: ['SELECT completed_keys->0 AS value, updated_at, now() AS read_at FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    from: 'src/core/persistence/sync-pass-row.ts:185 readLivePassRows (at 8b80bd80ab)',
    case: { method: 'readLiveSyncPassRows', variant: 'default', run: e => e.readLiveSyncPassRows(null) },
    texts: [`SELECT s.id AS source_id, c.completed_keys->0 AS value, c.updated_at, now() AS read_at FROM sources s
       JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text
      WHERE ($2::text[] IS NULL OR s.id=ANY($2::text[]))`],
  },
  ...([
    ['default', {}, '$3::text::jsonb'],
    ['clock', { clock: true }, `jsonb_set($3::text::jsonb,'{telemetry,started_at}',to_jsonb(to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`],
  ] as const).map(([variant, opts, json]): Pin => ({
    from: 'src/core/persistence/sync-pass-row.ts:206 writePassRow (at 8b80bd80ab)',
    case: { method: 'writeSyncPassRow', variant, run: e => e.writeSyncPassRow('default', '1', { lease_token: 't' }, opts) },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,jsonb_build_array(${json}),now())
      ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()
        WHERE ($4::boolean OR op_checkpoints.completed_keys->0->>'lease_token'=$5) RETURNING 1`],
  })),
  {
    from: 'src/core/persistence/sync-pass-row.ts:204 writePassRow (onlyOpen) (at 8b80bd80ab)',
    case: { method: 'writeSyncPassRow', variant: 'only-open', run: e => e.writeSyncPassRow('default', '1', { lease_token: 't' }, { onlyOpen: true }) },
    texts: [`UPDATE op_checkpoints SET completed_keys=jsonb_build_array($3::text::jsonb), updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND ($4::boolean OR completed_keys->0->>'lease_token'=$5) AND completed_keys->0->'telemetry'->>'outcome'='open' RETURNING 1`],
  },
  {
    from: 'src/core/persistence/applied-watermark.ts:88,92 readWriteWatermark',
    case: { method: 'readWriteWatermarkRow', variant: 'default', run: e => e.readWriteWatermarkRow('default') },
    texts: [`SELECT s.last_commit, s.last_sync_at, p.pending_min, p.pending_count, p.pending_since
    FROM sources s LEFT JOIN LATERAL (SELECT min(r.sequence) AS pending_min, count(*) AS pending_count, min(r.created_at) AS pending_since FROM persistence_requests r
      WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.state IN ('queued','deferred','running','recovering')) p ON true WHERE s.id=$1`,
    'SELECT max(sequence) AS sequence FROM persistence_requests'],
  },
  {
    from: 'src/core/persistence/sync-movement.ts:159,160,163 readSourceMovement (at b7b18e5ab3)',
    case: { method: 'readSourceMovementRows', variant: 'default', run: e => e.readSourceMovementRows({ source_id: 'default', worktree_id: '00000000-0000-4000-8000-000000000001', source_incarnation: '00000000-0000-4000-8000-000000000002' }) },
    texts: [`SELECT
        (SELECT r.completed_at FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state='committed' AND r.source_incarnation=$2::uuid
           AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' ORDER BY r.completed_at DESC LIMIT 1) AS last_commit_at,
        (SELECT count(*) FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state IN ('queued','running') AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS admitted,
        (SELECT min(r.created_at) FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state IN ('queued','running') AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS admitted_since`,
      `SELECT request_id::text AS request_id, state, claim_phase, execution_token::text AS execution_token,
        (claim_expires_at IS NOT NULL AND claim_expires_at < now()) AS claim_lapsed, publication_started
      FROM persistence_requests WHERE worktree_id=$1::uuid AND state IN ('queued','running','recovering') ORDER BY (state <> 'running'), sequence LIMIT 1`,
      `SELECT (completed_keys->0->>'count')::int AS count, (completed_keys->0->>'stalled')::int AS stalled,
        (completed_keys->0->>'fences')::int AS fences, (completed_keys->0->>'concurrent')::int AS concurrent, updated_at
      FROM op_checkpoints WHERE op='sync-hold-summary' AND completed_keys->0->>'source_id'=$1 AND completed_keys->0->>'incarnation'=$2 LIMIT 1`],
  },
  {
    from: 'src/core/persistence/sync-movement.ts:133 liveSyncJob (at b7b18e5ab3)',
    case: { method: 'readLiveSyncJobId', variant: 'default', run: e => e.readLiveSyncJobId('default') },
    texts: [`SELECT id FROM minion_jobs WHERE name='sync' AND status='active' AND lock_until > now() AND queue <> 'gbrain-drain-lease'
    AND (COALESCE(data->>'sourceId', data->>'source_id')=$1 OR (COALESCE(data->>'sourceId', data->>'source_id') IS NULL
      AND (data->>'repoPath' IS NULL AND $1='default' OR data->>'repoPath'=(SELECT local_path FROM sources WHERE id=$1)))) ORDER BY started_at, id LIMIT 1`],
  },
  {
    from: 'src/core/persistence/applied-watermark.ts:104 readCheckoutRoot',
    case: { method: 'readSourceCheckoutRoot', variant: 'default', run: e => e.readSourceCheckoutRoot('default', null) },
    texts: [`SELECT s.incarnation::text AS incarnation,
      COALESCE((SELECT h.local_path FROM persistence_host_bindings h JOIN persistence_source_bindings b ON b.worktree_id=h.worktree_id
        WHERE b.source_id=s.id AND h.host_id::text=$2 LIMIT 1), s.local_path) AS root FROM sources s WHERE s.id=$1`],
  },
  {
    from: 'src/core/persistence/applied-watermark.ts:132 readAppliedWatermark',
    case: { method: 'readUnembeddedPageSummary', variant: 'default', run: e => e.readUnembeddedPageSummary('default', 'embedding') },
    texts: () => [`WITH w AS (SELECT DISTINCT p.id, p.updated_at FROM content_chunks cc
        JOIN pages p ON p.id=cc.page_id WHERE ${`cc.${quoteIdentifier('embedding')}`} IS NULL AND p.source_id=$1 AND p.deleted_at IS NULL AND ${chunkGenerationFilter('p', 'cc')}
          AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip'))
      SELECT count(*) AS pages, min(w.updated_at) AS oldest,
        (SELECT count(*) FROM w JOIN page_embedding_budget b ON b.page_id=w.id JOIN pages p ON p.id=w.id WHERE ${budgetRowAppliesFilter('b', 'p')}) AS held FROM w`],
  },
  {
    from: 'src/core/notifier/store.ts:190 claimLease (the claim, then the holder a lost claim reads; at 6e123afe98)',
    case: { method: 'claimNotifierLease', variant: 'default', run: e => e.claimNotifierLease({ hostId: 'host-1', ownerId: 'owner-1', kind: 'serve', pid: 4242, leaseMs: 30_000 }) },
    texts: [`INSERT INTO sync_notifier_leases (host_id, owner_id, fence, resident_kind, pid, renewed_at, expires_at)
     VALUES ($1, $2, 1, $3, $4, now(), now() + $5::int * interval '1 millisecond')
     ON CONFLICT (host_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, resident_kind = EXCLUDED.resident_kind, pid = EXCLUDED.pid,
       fence = sync_notifier_leases.fence + CASE WHEN sync_notifier_leases.owner_id = EXCLUDED.owner_id THEN 0 ELSE 1 END,
       renewed_at = now(), expires_at = EXCLUDED.expires_at
     WHERE sync_notifier_leases.owner_id = EXCLUDED.owner_id OR sync_notifier_leases.expires_at <= now()
     RETURNING fence`,
      'SELECT owner_id, fence, resident_kind, pid, expires_at, expires_at > now() AS live FROM sync_notifier_leases WHERE host_id = $1'],
  },
  {
    from: 'src/core/notifier/store.ts:193 readLease (at 6e123afe98)',
    case: { method: 'readNotifierLease', variant: 'default', run: e => e.readNotifierLease('host-1') },
    texts: ['SELECT owner_id, fence, resident_kind, pid, expires_at, expires_at > now() AS live FROM sync_notifier_leases WHERE host_id = $1'],
  },
  {
    from: 'src/core/notifier/store.ts:198 holdsLease (at 6e123afe98)',
    case: { method: 'holdsNotifierLease', variant: 'default', run: e => e.holdsNotifierLease('host-1', 'owner-1', 3) },
    texts: ['SELECT host_id FROM sync_notifier_leases WHERE host_id = $1 AND owner_id = $2 AND fence = $3 AND expires_at > now()'],
  },
  {
    from: 'src/core/notifier/store.ts:205 releaseLease (at 6e123afe98)',
    case: { method: 'releaseNotifierLease', variant: 'default', run: e => e.releaseNotifierLease('host-1', 'owner-1') },
    texts: ['UPDATE sync_notifier_leases SET expires_at = now() WHERE host_id = $1 AND owner_id = $2'],
  },
  {
    from: 'src/core/notifier/resident.ts:71 listHostSources (at 6e123afe98)',
    case: { method: 'listNotifierHostSourceRows', variant: 'default', run: e => e.listNotifierHostSourceRows() },
    texts: [`SELECT s.id, s.local_path, s.last_commit, (b.source_id IS NOT NULL) AS bound, w.owner_host_id::text AS owner, h.local_path AS root, n.syncer_host_id AS syncer, s.config
       FROM sources s
       LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
       LEFT JOIN persistence_worktrees w ON w.id = b.worktree_id
       LEFT JOIN persistence_host_bindings h ON h.worktree_id = w.id AND h.host_id = w.owner_host_id
       LEFT JOIN sync_notifier_sources n ON n.source_id = s.id
      WHERE NOT s.archived ORDER BY s.id COLLATE "C"`],
  },
  {
    from: 'src/core/notifier/store.ts:222 readNotifierSources (the listed sources; at 6e123afe98)',
    case: { method: 'readNotifierSources', variant: 'ids', run: e => e.readNotifierSources(['source-a', 'source-b']) },
    texts: ['SELECT * FROM sync_notifier_sources WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY source_id'],
  },
  {
    from: 'src/core/notifier/store.ts:222 readNotifierSources (every source; at 6e123afe98)',
    case: { method: 'readNotifierSources', variant: 'all', run: e => e.readNotifierSources(null) },
    texts: ['SELECT * FROM sync_notifier_sources WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY source_id'],
  },
  {
    from: 'src/core/notifier/store.ts:241 writeState (at 6e123afe98)',
    case: { method: 'writeNotifierState', variant: 'default', run: e => e.writeNotifierState('source-a', { state: 'retry', reason: 'sync_failed', firstDue: 'keep', attempts: 2, nextRetryInMs: 60_000, progress: true, error: { code: 'E_SYNC', message: 'failed', tracePath: null } }) },
    texts: [`INSERT INTO sync_notifier_sources (source_id, source_incarnation, state, reason, first_due_at, attempts, next_retry_at, last_progress_at,
        last_error_code, last_error, last_error_at, trace_path, updated_at)
     SELECT s.id, s.incarnation::text, $2, $3, CASE WHEN $4::text = 'keep' THEN now() END, COALESCE($5::int, 0),
        CASE WHEN $6::int IS NULL THEN NULL ELSE now() + $6::int * interval '1 millisecond' END, CASE WHEN $7::boolean THEN now() END,
        $8::text, $9::text, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END, $10::text, now()
       FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id) DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason,
       first_due_at = CASE WHEN $4::text = 'clear' THEN NULL ELSE COALESCE(sync_notifier_sources.first_due_at, now()) END,
       attempts = COALESCE($5::int, sync_notifier_sources.attempts), next_retry_at = EXCLUDED.next_retry_at,
       last_progress_at = CASE WHEN $7::boolean THEN now() ELSE sync_notifier_sources.last_progress_at END,
       last_error_code = CASE WHEN $11::boolean THEN EXCLUDED.last_error_code ELSE sync_notifier_sources.last_error_code END,
       last_error = CASE WHEN $11::boolean THEN EXCLUDED.last_error ELSE sync_notifier_sources.last_error END,
       last_error_at = CASE WHEN $11::boolean THEN EXCLUDED.last_error_at ELSE sync_notifier_sources.last_error_at END,
       trace_path = CASE WHEN $11::boolean THEN EXCLUDED.trace_path ELSE sync_notifier_sources.trace_path END,
       source_incarnation = EXCLUDED.source_incarnation, updated_at = now()`],
  },
  {
    from: 'src/core/notifier/store.ts:265 writeCoverage (at 6e123afe98)',
    case: { method: 'writeNotifierCoverage', variant: 'default', run: e => e.writeNotifierCoverage('source-a', { head: 'abc123', mode: 'watch', ownerHostId: 'host-1', ownerKind: 'serve', ownerPid: 4242 }) },
    texts: [`INSERT INTO sync_notifier_sources (source_id, source_incarnation, observed_head, observed_at, detection_mode, owner_host_id, owner_kind, owner_pid, owner_seen_at, updated_at)
     SELECT s.id, s.incarnation::text, $2, now(), $3, $4, $5, $6, now(), now() FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id) DO UPDATE SET observed_head = EXCLUDED.observed_head, observed_at = now(), detection_mode = EXCLUDED.detection_mode,
       owner_host_id = EXCLUDED.owner_host_id, owner_kind = EXCLUDED.owner_kind, owner_pid = EXCLUDED.owner_pid, owner_seen_at = now(),
       source_incarnation = EXCLUDED.source_incarnation, updated_at = now()`],
  },
  {
    from: 'src/core/notifier/store.ts:276 recordSyncerHost (at 6e123afe98)',
    case: { method: 'recordNotifierSyncerHost', variant: 'default', run: e => e.recordNotifierSyncerHost('source-a', 'host-1') },
    texts: [`INSERT INTO sync_notifier_sources (source_id, source_incarnation, syncer_host_id, syncer_recorded_at, updated_at)
     SELECT s.id, s.incarnation::text, $2, now(), now() FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id) DO UPDATE SET syncer_host_id = EXCLUDED.syncer_host_id, syncer_recorded_at = now(), updated_at = now()
     WHERE sync_notifier_sources.syncer_host_id IS DISTINCT FROM EXCLUDED.syncer_host_id`],
  },
  {
    from: 'src/core/notifier/status.ts:72 readRows (the listed sources; at 6e123afe98)',
    case: { method: 'readNotifierStatusRows', variant: 'ids', run: e => e.readNotifierStatusRows(['source-a']) },
    texts: [`SELECT s.id, s.last_commit, n.state, n.reason, n.first_due_at, n.attempts, n.next_retry_at, n.last_error_code, n.last_error, n.last_error_at,
            n.trace_path, n.observed_head, n.observed_at, n.detection_mode, n.owner_host_id, n.owner_kind, n.owner_pid, n.owner_seen_at,
            EXISTS (SELECT 1 FROM sync_notifier_leases l WHERE l.host_id = n.owner_host_id AND l.expires_at > now()) AS lease_live,
            (SELECT l.expires_at FROM sync_notifier_leases l WHERE l.host_id = n.owner_host_id) AS lease_expires_at,
            (SELECT count(*) FROM sync_wanted_markers m WHERE m.source_id = s.id
               AND (m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit)) AS due_markers
       FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id
      WHERE NOT s.archived AND ($1::text[] IS NULL OR s.id = ANY($1::text[]))
      ORDER BY s.id COLLATE "C" LIMIT 200`],
  },
  {
    from: 'src/core/notifier/status.ts:72 readRows (every source; at 6e123afe98)',
    case: { method: 'readNotifierStatusRows', variant: 'all', run: e => e.readNotifierStatusRows(null) },
    texts: [`SELECT s.id, s.last_commit, n.state, n.reason, n.first_due_at, n.attempts, n.next_retry_at, n.last_error_code, n.last_error, n.last_error_at,
            n.trace_path, n.observed_head, n.observed_at, n.detection_mode, n.owner_host_id, n.owner_kind, n.owner_pid, n.owner_seen_at,
            EXISTS (SELECT 1 FROM sync_notifier_leases l WHERE l.host_id = n.owner_host_id AND l.expires_at > now()) AS lease_live,
            (SELECT l.expires_at FROM sync_notifier_leases l WHERE l.host_id = n.owner_host_id) AS lease_expires_at,
            (SELECT count(*) FROM sync_wanted_markers m WHERE m.source_id = s.id
               AND (m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit)) AS due_markers
       FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id
      WHERE NOT s.archived AND ($1::text[] IS NULL OR s.id = ANY($1::text[]))
      ORDER BY s.id COLLATE "C" LIMIT 200`],
  },
  {
    from: 'src/core/notifier/status.ts:107 freshnessReported (at 6e123afe98)',
    case: { method: 'hasNotifierCoverage', variant: 'default', run: e => e.hasNotifierCoverage() },
    texts: ['SELECT EXISTS (SELECT 1 FROM sync_notifier_sources WHERE observed_at IS NOT NULL) AS covered'],
  },  {
    from: 'src/core/notifier/store.ts:71 upsertMarker (at f24fef9a03)',
    case: { method: 'upsertWantedMarker', variant: 'default', run: e => e.upsertWantedMarker({ sourceId: 'source-a', intent: 'freshness', wantedHead: 'abc123', requestedBy: 'webhook', jobId: 7 }) },
    texts: [`INSERT INTO sync_wanted_markers (source_id, intent, source_incarnation, wanted_head, generation, first_due_at, updated_at, requested_by, job_id)
     SELECT s.id, $2, s.incarnation::text, $3, 1, now(), now(), $4, $5 FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id, intent) DO UPDATE SET wanted_head = EXCLUDED.wanted_head, generation = sync_wanted_markers.generation + 1,
       updated_at = now(), requested_by = EXCLUDED.requested_by, job_id = COALESCE(EXCLUDED.job_id, sync_wanted_markers.job_id),
       first_due_at = CASE WHEN sync_wanted_markers.source_incarnation IS DISTINCT FROM EXCLUDED.source_incarnation THEN now() ELSE sync_wanted_markers.first_due_at END,
       source_incarnation = EXCLUDED.source_incarnation
     RETURNING *`],
  },
  {
    from: 'src/core/notifier/store.ts:86 attachMarkerJob (at f24fef9a03)',
    case: { method: 'attachWantedMarkerJob', variant: 'default', run: e => e.attachWantedMarkerJob('source-a', 'pull', 2, 7) },
    texts: ['UPDATE sync_wanted_markers SET job_id = $4 WHERE source_id = $1 AND intent = $2 AND generation = $3'],
  },
  {
    from: 'src/core/notifier/store.ts:90 readMarkers (the listed sources; at f24fef9a03)',
    case: { method: 'readWantedMarkers', variant: 'ids', run: e => e.readWantedMarkers(['source-a', 'source-b']) },
    texts: ['SELECT * FROM sync_wanted_markers WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY first_due_at, source_id, intent LIMIT 1000'],
  },
  {
    from: 'src/core/notifier/store.ts:90 readMarkers (every source; at f24fef9a03)',
    case: { method: 'readWantedMarkers', variant: 'all', run: e => e.readWantedMarkers(null) },
    texts: ['SELECT * FROM sync_wanted_markers WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY first_due_at, source_id, intent LIMIT 1000'],
  },
  {
    from: 'src/core/notifier/store.ts:100 readDueMarkers (the listed sources; at f24fef9a03)',
    case: { method: 'readDueWantedMarkers', variant: 'ids', run: e => e.readDueWantedMarkers(['source-a']) },
    texts: [`SELECT m.* FROM sync_wanted_markers m JOIN sources s ON s.id = m.source_id
      WHERE ($1::text[] IS NULL OR m.source_id = ANY($1::text[]))
        AND (m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit)
      ORDER BY m.first_due_at, m.source_id, m.intent LIMIT 1000`],
  },
  {
    from: 'src/core/notifier/store.ts:100 readDueMarkers (every source; at f24fef9a03)',
    case: { method: 'readDueWantedMarkers', variant: 'all', run: e => e.readDueWantedMarkers(null) },
    texts: [`SELECT m.* FROM sync_wanted_markers m JOIN sources s ON s.id = m.source_id
      WHERE ($1::text[] IS NULL OR m.source_id = ANY($1::text[]))
        AND (m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit)
      ORDER BY m.first_due_at, m.source_id, m.intent LIMIT 1000`],
  },
  {
    from: 'src/core/notifier/store.ts:113 pruneSatisfiedMarkers (at f24fef9a03)',
    case: { method: 'pruneSatisfiedWantedMarkers', variant: 'default', run: e => e.pruneSatisfiedWantedMarkers(['source-a']) },
    texts: [`DELETE FROM sync_wanted_markers m USING sources s WHERE m.source_id = s.id AND m.source_id = ANY($1::text[])
       AND m.intent IN ('freshness','pull') AND m.wanted_head IS NOT NULL AND m.wanted_head = s.last_commit`],
  },
  {
    from: 'src/core/notifier/store.ts:120 clearMarker (at f24fef9a03)',
    case: { method: 'clearWantedMarker', variant: 'default', run: e => e.clearWantedMarker('source-a', 'pull', 2) },
    texts: ['DELETE FROM sync_wanted_markers WHERE source_id = $1 AND intent = $2 AND generation = $3 RETURNING source_id'],
  },
  {
    from: 'src/core/notifier/store.ts:139 settleMarkers (the freshness marker; at f24fef9a03)',
    case: { method: 'settleFreshnessMarker', variant: 'default', run: e => e.settleFreshnessMarker('source-a', 2, 'abc123') },
    texts: [`DELETE FROM sync_wanted_markers m USING sources s WHERE m.source_id = s.id AND m.source_id = $1 AND m.intent = 'freshness'
           AND m.generation = $2 AND (m.wanted_head IS NULL OR m.wanted_head IS NOT DISTINCT FROM s.last_commit
             OR ($3::text IS NOT NULL AND s.last_commit = $3::text))`],
  },
  {
    from: 'src/core/notifier/status.ts:130 readNotifierBlock (the markers; at f24fef9a03; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listSourceWantedMarkers', variant: 'default', run: e => e.listSourceWantedMarkers('source-a') },
    texts: ['SELECT intent, wanted_head, first_due_at, requested_by FROM sync_wanted_markers WHERE source_id = $1 ORDER BY first_due_at, intent COLLATE "C"'],
  },
  {
    from: 'src/core/notifier/nudge.ts:17 sourceSyncShape (at 87bd59b208)',
    case: { method: 'readSourceSyncShape', variant: 'default', run: e => e.readSourceSyncShape('source-a') },
    texts: [`SELECT s.local_path, h.local_path AS root, (b.source_id IS NOT NULL) AS bound
       FROM sources s
       LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
       LEFT JOIN persistence_worktrees w ON w.id = b.worktree_id
       LEFT JOIN persistence_host_bindings h ON h.worktree_id = w.id AND h.host_id = w.owner_host_id
      WHERE s.id = $1 AND NOT s.archived LIMIT 1`],
  },
  {
    from: 'src/core/sync-pending.ts:101 readFirstDue (at 87bd59b208)',
    case: { method: 'readNotifierFirstDue', variant: 'default', run: e => e.readNotifierFirstDue(['source-a']) },
    texts: [`SELECT s.id AS source_id, n.observed_head,
              LEAST(CASE WHEN n.state <> 'idle' THEN n.first_due_at END,
                    (SELECT min(m.first_due_at) FROM sync_wanted_markers m WHERE m.source_id = s.id AND m.intent = 'freshness'
                       AND m.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
                       AND (m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit))) AS first_due_at
         FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id AND n.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
        WHERE s.id = ANY($1::text[])`],
  },
  {
    from: 'src/core/sync-anchor.ts:272 writeSyncAnchor, with a newest content time (at 87bd59b208)',
    case: { method: 'advanceSourceCommit', variant: 'newest-content', run: e => e.advanceSourceCommit('source-a', 'abc123', '2026-01-02T03:04:05.000Z') },
    texts: ['UPDATE sources SET last_commit = $1, last_sync_at = now(), newest_content_at = $3 WHERE id = $2'],
  },
  {
    from: 'src/core/sync-anchor.ts:277 writeSyncAnchor, without a newest content time (at 87bd59b208)',
    case: { method: 'advanceSourceCommit', variant: 'default', run: e => e.advanceSourceCommit('source-a', 'abc123') },
    texts: ['UPDATE sources SET last_commit = $1, last_sync_at = now() WHERE id = $2'],
  },  {
    from: 'src/core/notifier/resident.ts:50 sqlNotifierStore liveJobs (at e98683e983)',
    case: { method: 'readLiveJobIds', variant: 'default', run: e => e.readLiveJobIds([1, 2]) },
    texts: ["SELECT id FROM minion_jobs WHERE id = ANY($1::bigint[]) AND status IN ('waiting','active','delayed','waiting-children','paused')"],
  },
  {
    from: 'src/core/notifier/resident.ts:169 residentNotifierOptions lastCommit (at e98683e983)',
    case: { method: 'readSourceLastCommit', variant: 'default', run: e => e.readSourceLastCommit('source-a') },
    texts: ['SELECT last_commit FROM sources WHERE id=$1'],
  },
  {
    from: 'src/core/persistence/sync-lease.ts:136 readDrainLease (at e98683e983)',
    case: { method: 'readDrainLeaseBeacon', variant: 'default', run: e => e.readDrainLeaseBeacon('token-a') },
    texts: ["SELECT data->'drain_lease_beacon' AS meta FROM minion_jobs WHERE queue=$1 AND lock_token=$2"],
  },
  {
    from: 'src/core/persistence/sync-lease.ts:161 holderProgress (at e98683e983)',
    case: { method: 'readDrainHolderProgress', variant: 'default', run: e => e.readDrainHolderProgress('source-a', '1970-01-01T00:00:00.000Z') },
    texts: [`
    SELECT (SELECT count(*) FROM persistence_requests r WHERE r.worktree_id=b.worktree_id AND r.state='committed'
        AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' AND r.completed_at >= $2::timestamptz) AS committed,
      (SELECT max(r.completed_at) FROM persistence_requests r WHERE r.worktree_id=b.worktree_id AND r.source_incarnation=b.source_incarnation
        AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS last_committed_at,
      GREATEST((SELECT max(c.updated_at) FROM op_checkpoints c WHERE c.op='managed-sync' AND c.completed_keys->0->>'sourceId'=$1),
        (SELECT c.updated_at FROM op_checkpoints c WHERE c.op=$3 AND c.fingerprint=b.source_id||':'||b.source_incarnation::text),
        (SELECT c.updated_at FROM op_checkpoints c WHERE c.op='sync-hold-summary' AND c.fingerprint=b.source_id||':'||b.source_incarnation::text)) AS last_saved_at
    FROM persistence_source_bindings b WHERE b.source_id=$1`],
  },
  {
    from: 'src/core/persistence/sync-lease.ts:259 writeHolderRecord (at e98683e983)',
    case: { method: 'writeDrainLeaseHolder', variant: 'default', run: e => e.writeDrainLeaseHolder({ sourceId: 'source-a', lockToken: 'token-a', beacon: { kind: 'job', id: '7', version: '0.0.0.0' }, ttlMinutes: 5 }) },
    texts: [`WITH gone AS (DELETE FROM minion_jobs WHERE queue=$1 AND name='sync' AND data->>'sourceId'=$5 RETURNING 1)
    INSERT INTO minion_jobs(name,queue,status,submission_authority,data,max_attempts,max_stalled,lock_token,lock_until,started_at,remove_on_complete,remove_on_fail)
    SELECT 'sync',$1,'active','{"version":1,"kind":"application"}'::jsonb,$2::text::jsonb,1,0,$3,now()+make_interval(mins => $4),now(),true,true FROM (SELECT count(*) FROM gone) g`],
  },
  {
    from: 'src/core/persistence/sync-lease.ts:284 withDrainLease beacon refresh (at e98683e983)',
    case: { method: 'refreshDrainLeaseHolder', variant: 'default', run: e => e.refreshDrainLeaseHolder('token-a', 5) },
    texts: ['UPDATE minion_jobs SET lock_until=now()+make_interval(mins => $3),updated_at=now() WHERE queue=$1 AND lock_token=$2'],
  },
  {
    from: 'src/core/persistence/sync-lease.ts:295 withDrainLease release (at e98683e983)',
    case: { method: 'releaseDrainLeaseHolder', variant: 'default', run: e => e.releaseDrainLeaseHolder('token-a') },
    texts: ['DELETE FROM minion_jobs WHERE queue=$1 AND lock_token=$2'],
  },
  {
    // The before-state column list is the shared FACT_PREIMAGE_SQL, which the caller interpolated as well.
    from: 'src/core/generations/adapters/fact-rows.ts:50 factPreimages (at ede09fdf45)',
    case: { method: 'readFactPreimages', variant: 'default', run: e => e.readFactPreimages('default', [3, 1]) },
    texts: [`SELECT ${FACT_PREIMAGE_SQL} AS preimage FROM facts f WHERE f.source_id=$1 AND f.id = ANY($2::bigint[]) ORDER BY f.id`],
  },
  {
    from: 'src/core/generations/adapters/page.ts:53 readPageRows (at a2d331ad57) with COLLATE "C" on both sorts, where text of single-page.ts:39',
    case: { method: 'readGenerationPageRows', variant: 'slug', run: e => e.readGenerationPageRows({ sourceId: 'default', match: 'slug', slug: 'dream/summary' }) },
    texts: [`SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,\n            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags\n       FROM pages p WHERE p.source_id = $1 AND (p.slug = $2) ORDER BY p.slug COLLATE "C"`],
  },
  {
    from: 'src/core/generations/adapters/page.ts:53 readPageRows (at a2d331ad57) with COLLATE "C" on both sorts, where text of synthesis.ts:53',
    case: { method: 'readGenerationPageRows', variant: 'synthesis', run: e => e.readGenerationPageRows({ sourceId: 'default', match: 'synthesis', slugs: ['synth/a'], locator: 'loc.md' }) },
    texts: [`SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,\n            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags\n       FROM pages p WHERE p.source_id = $1 AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND $3::text IS NOT NULL\n      AND p.frontmatter->>'raw_source' = $3 AND p.frontmatter->>'dream_generated' = 'true')) ORDER BY p.slug COLLATE "C"`],
  },
  {
    from: 'src/core/generations/adapters/page.ts:53 readPageRows (at a2d331ad57) with COLLATE "C" on both sorts, where text of atoms.ts:90',
    case: { method: 'readGenerationPageRows', variant: 'atoms-source-slug', run: e => e.readGenerationPageRows({ sourceId: 'default', match: 'atoms', slugs: ['atoms/a'], field: 'source_slug', value: 'notes/a' }) },
    texts: [`SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,\n            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags\n       FROM pages p WHERE p.source_id = $1 AND (p.type='atom' AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND $3::text IS NOT NULL AND p.frontmatter->>'source_slug' = $3))) ORDER BY p.slug COLLATE "C"`],
  },
  {
    from: 'src/core/generations/adapters/page.ts:53 readPageRows (at a2d331ad57) with COLLATE "C" on both sorts, where text of atoms.ts:90',
    case: { method: 'readGenerationPageRows', variant: 'atoms-source-path', run: e => e.readGenerationPageRows({ sourceId: 'default', match: 'atoms', slugs: ['atoms/a'], field: 'source_path', value: 'notes/a.md' }) },
    texts: [`SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,\n            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags\n       FROM pages p WHERE p.source_id = $1 AND (p.type='atom' AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND $3::text IS NOT NULL AND p.frontmatter->>'source_path' = $3))) ORDER BY p.slug COLLATE "C"`],
  },
  {
    from: 'src/core/generations/adapters/page.ts:53 readPageRows (at a2d331ad57) with COLLATE "C" on both sorts, where text of chronicle-events.ts:162',
    case: { method: 'readGenerationPageRows', variant: 'chronicle', run: e => e.readGenerationPageRows({ sourceId: 'default', match: 'chronicle', slugs: ['events/a'], depth: 'year' }) },
    texts: [`SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,\n            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags\n       FROM pages p WHERE p.source_id = $1 AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND p.type='event' AND p.frontmatter->'event'->>'depth' = $3\n      AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%')) ORDER BY p.slug COLLATE "C"`],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:112 depthRow (at 358967a48a)',
    case: { method: 'readChronicleDepthRow', variant: 'default', run: e => e.readChronicleDepthRow('default', 'people/a') },
    texts: ["SELECT id, deleted_at IS NULL AS live FROM pages WHERE source_id=$1 AND slug=$2 ORDER BY deleted_at NULLS FIRST, id DESC LIMIT 1"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:119 ownedEventHashes (at 358967a48a)',
    case: { method: 'listChronicleOwnedHashes', variant: 'default', run: e => e.listChronicleOwnedHashes('default', 7) },
    texts: ["SELECT DISTINCT unnest(event_hashes) AS hash FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:126 ledgerRetired (at 358967a48a)',
    case: { method: 'listRetiredGenerationItemKeys', variant: 'default', run: e => e.listRetiredGenerationItemKeys('default', 'chronicle_event', ['events/a']) },
    texts: ["SELECT DISTINCT i.item_key FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id\n      WHERE g.source_id=$1 AND g.kind=$2 AND i.action='retired' AND i.item_key=ANY($3::text[])"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:150 projectionRows (at 358967a48a)',
    case: { method: 'listEventProjectionRows', variant: 'default', run: e => e.listEventProjectionRows([3, 1]) },
    texts: ["SELECT event_page_id, date::text AS date, summary, detail FROM timeline_entries WHERE event_page_id = ANY($1::bigint[]) ORDER BY date"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:164 readEventItems (at 358967a48a)',
    case: { method: 'listPageContentHashes', variant: 'ids', run: e => e.listPageContentHashes({ sourceId: 'default', match: 'ids', ids: [3, 1] }) },
    texts: ["SELECT slug, content_hash FROM pages WHERE source_id=$1 AND id = ANY($2::bigint[])"],
  },
  {
    from: 'src/core/chronicle/publish.ts:186 writtenEvents (at 358967a48a)',
    case: { method: 'listPageContentHashes', variant: 'live-slugs', run: e => e.listPageContentHashes({ sourceId: 'default', match: 'live_slugs', slugs: ['events/a'] }) },
    texts: ["SELECT slug, content_hash FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:170 readEventItems (at 358967a48a)',
    case: { method: 'listLiveGenerationItems', variant: 'default', run: e => e.listLiveGenerationItems({ sourceId: 'default', kind: 'chronicle_event', ownerKey: 'depth:people/a' }) },
    texts: ["SELECT i.item_key, i.identity_hash FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id\n      WHERE g.source_id=$1 AND g.kind=$2 AND g.owner_key=$3 AND g.state='live' AND i.action <> 'retired'"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:197 recordProjectionFlag, where text of publish.ts:306 (at 358967a48a)',
    case: { method: 'readEventProjectionId', variant: 'default', run: e => e.readEventProjectionId(3, '2026-03-02') },
    texts: ["SELECT id FROM timeline_entries WHERE event_page_id=$1 AND date=$2::date"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:239 publishItems (at 358967a48a)',
    case: { method: 'pageSlugExists', variant: 'default', run: e => e.pageSlugExists('default', 'events/a') },
    texts: ["SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:257 retireItems (at 358967a48a)',
    case: { method: 'deleteEventProjections', variant: 'default', run: e => e.deleteEventProjections('default', ['events/a']) },
    texts: ["DELETE FROM timeline_entries t USING pages p WHERE p.id=t.event_page_id AND p.source_id=$1 AND p.slug=ANY($2::text[])"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:269 restoreItem (at 358967a48a)',
    case: { method: 'restoreEventProjection', variant: 'default', run: e => e.restoreEventProjection({ depthPageId: 1, date: '2026-03-02', source: 'life-chronicle:event:events/a', summary: 's', detail: 'd', eventPageId: 3 }) },
    texts: ["INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id) VALUES ($1, $2::date, $3, $4, $5, $6)\n        ON CONFLICT (event_page_id, date) WHERE event_page_id IS NOT NULL DO UPDATE SET summary=EXCLUDED.summary, detail=EXCLUDED.detail, page_id=EXCLUDED.page_id, source=EXCLUDED.source"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:280 proofHolds (at 358967a48a)',
    case: { method: 'hasChronicleSkipDecision', variant: 'default', run: e => e.hasChronicleSkipDecision({ sourceId: 'default', pageId: 1, contentHash: 'h', extractorVersion: 2, reason: 'no_events' }) },
    texts: ["SELECT 1 FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND state=$5 AND reason=$6"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:288 orphanedDepthKeys (at 358967a48a)',
    case: { method: 'listOrphanedChronicleOwners', variant: 'default', run: e => e.listOrphanedChronicleOwners('default', 'chronicle_event', 50) },
    texts: ["SELECT g.owner_key FROM derived_generations g\n      WHERE g.source_id=$1 AND g.kind=$2 AND g.state='live'\n        AND EXISTS (SELECT 1 FROM derived_generation_items i JOIN pages e ON e.source_id=g.source_id AND e.slug=i.item_key AND e.deleted_at IS NULL\n          WHERE i.generation_id=g.id AND i.action <> 'retired')\n        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=g.source_id AND p.slug=substr(g.owner_key, 7) AND p.deleted_at IS NULL)\n      ORDER BY g.updated_at, g.id LIMIT $3"],
  },
  {
    from: 'src/core/chronicle/event-identity.ts:90 resolveChronicleEventSlugs (at 358967a48a)',
    case: { method: 'listChronicleEventSlotRows', variant: 'default', run: e => e.listChronicleEventSlotRows('default', ['events/a']) },
    texts: ["SELECT slug, frontmatter->'event'->>'when' AS \"when\", frontmatter->'event'->>'where' AS \"where\", frontmatter->'event'->>'kind' AS kind\n       FROM pages WHERE source_id=$1 AND slug = ANY($2::text[])"],
  },
  {
    from: 'src/core/generations/adapters/atoms.ts:82 readInput (at ec2fbe7ba3)',
    case: { method: 'readAtomOriginInput', variant: 'default', run: e => e.readAtomOriginInput('default', 'notes/origin') },
    texts: [`SELECT id, content_hash, knowledge_revision::text AS revision,\n        CASE WHEN body_storage = 'segmented' THEN body_bytes ELSE octet_length(COALESCE(compiled_truth, '')) + octet_length(COALESCE(timeline, '')) END AS body_bytes\n       FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`],
  },
  {
    from: 'src/core/trust/taint.ts:127 lowerToDerivedTier (at d7fb3a97b7; the values bind through sqlFragment, so the placeholders follow text order and the compared tier binds as its rank)',
    case: { method: 'lowerTrustTier', variant: 'pages', run: e => e.lowerTrustTier('pages', [3, 1], 'external_untrusted', { channel: 'derive:test' }) },
    texts: [`UPDATE pages SET trust_tier=$1,write_origin=$2::text::jsonb
      WHERE id=ANY($3::bigint[]) AND ${trustRankSql('trust_tier')}>$4::int RETURNING id`],
  },
  {
    from: 'src/core/trust/taint.ts:235 readDerivedTaintShare (at d7fb3a97b7)',
    case: { method: 'countDerivedRowTaint', variant: 'takes', run: e => e.countDerivedRowTaint('takes') },
    texts: [`SELECT count(*) FILTER (WHERE write_origin ? 'taint_inputs') AS derived,
                count(*) FILTER (WHERE write_origin ? 'taint_inputs' AND trust_tier = 'external_untrusted') AS external FROM takes`],
  },
  {
    from: 'src/core/persistence/derived-retirement-hold.ts:51 stampDerivedRetirement (at d7fb3a97b7)',
    case: { method: 'stampPageFrontmatter', variant: 'retired', run: e => e.stampPageFrontmatter({ match: 'retired', sourceId: 'default', slugs: ['synth/a'], retiredBy: 'synthesis-cleanup', retiredAt: '2026-01-01T00:00:00.000Z' }) },
    texts: [`UPDATE pages SET frontmatter=frontmatter||jsonb_build_object('retired_by',$1::text,'retired_at',$2::text)
    WHERE source_id=$3 AND slug=ANY($4::text[]) AND deleted_at IS NOT NULL`],
  },
  {
    from: 'src/core/generations/adapters/atoms.ts:110 completeItems (at d7fb3a97b7)',
    case: { method: 'stampPageFrontmatter', variant: 'atom-source-hash', run: e => e.stampPageFrontmatter({ match: 'atom_source_hash', sourceId: 'default', slugs: ['atoms/a'], sourceHash: '0123456789abcdef' }) },
    texts: [`UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('source_hash', $1::text)
      WHERE source_id = $2 AND type = 'atom' AND slug = ANY($3::text[]) AND deleted_at IS NULL`],
  },
  {
    from: 'src/core/generations/adapters/page.ts:95 pageVersionEvidence (at ec2fbe7ba3), producer text of atoms.ts:95',
    case: { method: 'listProducerVersionRows', variant: 'extract-atoms', run: e => e.listProducerVersionRows('default', ['atoms/a'], 'extract_atoms') },
    texts: [`SELECT p.slug, v.type, v.title, v.compiled_truth, v.timeline, v.frontmatter, v.tags, p.frontmatter->'visibility' AS live_visibility\n       FROM page_versions v JOIN pages p ON p.id = v.page_id\n      WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND v.compiled_truth IS NOT NULL AND v.title IS NOT NULL AND (v.frontmatter->>'extracted_by' LIKE 'extract\\_atoms%')`],
  },
  {
    from: 'src/core/generations/adapters/atoms.ts:127 receiptEvidence (at ec2fbe7ba3)',
    case: { method: 'listAtomWriteReceipts', variant: 'default', run: e => e.listAtomWriteReceipts('default', ['atoms/a']) },
    texts: [`SELECT r.slug, r.intent->>'content' AS content FROM persistence_requests r\n      WHERE r.source_id=$1 AND r.slug=ANY($2::text[]) AND r.state='committed' AND r.intent->>'kind'='managed_atom_page' AND r.intent ? 'content'\n        AND (r.intent->>'activationId' IS NULL OR EXISTS (SELECT 1 FROM derived_generation_activations a WHERE a.id=r.intent->>'activationId' AND a.state='activated'))`],
  },
  {
    from: 'src/core/generations/adapters/extracted-facts.ts:71 storedRows (at 0d76adc0e6)',
    case: { method: 'listFactIdsBySourcePrefix', variant: 'default', run: e => e.listFactIdsBySourcePrefix('default', 'conversations/c', 'cli:extract-conversation-facts') },
    texts: [`SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND COALESCE(source,'') LIKE $3 ORDER BY id`],
  },
  {
    from: 'src/core/generations/adapters/extracted-facts.ts:113 retireItems (at 0d76adc0e6)',
    case: { method: 'expireFactRows', variant: 'default', run: e => e.expireFactRows('default', [3, 4]) },
    texts: ['UPDATE facts SET expired_at = now() WHERE source_id=$1 AND id = ANY($2::bigint[]) AND expired_at IS NULL'],
  },
  {
    from: 'src/core/generations/adapters/fact-rows.ts:82 restoreFactRow (at c0a2bbe921)',
    case: { method: 'restoreFactPreimage', variant: 'default', run: e => e.restoreFactPreimage('default', { id: 3, fact: 'f', visibility: 'private', expired_at: null, valid_until: null, superseded_by: null, consolidated_at: null, consolidated_into: null, row_num: 1 }) },
    texts: [`UPDATE facts f SET expired_at=$4::timestamptz, valid_until=$5::timestamptz, superseded_by=$6::bigint,
      consolidated_at=$7::timestamptz, consolidated_into=$8::bigint,
      row_num=CASE WHEN $9::integer IS NULL OR f.row_num IS NOT DISTINCT FROM $9::integer THEN f.row_num
        WHEN NOT EXISTS (SELECT 1 FROM facts o WHERE o.source_id=f.source_id AND o.source_markdown_slug=f.source_markdown_slug AND o.row_num=$9::integer AND o.id<>f.id)
        THEN $9::integer ELSE f.row_num END
    WHERE f.source_id=$1 AND f.id=$2::bigint AND f.fact=$3 AND f.visibility=$10 RETURNING f.id`],
  },
  {
    from: 'src/core/generations/adapters/fact-rows.ts:142 consolidationRestored (at c0a2bbe921)',
    case: { method: 'readGenerationRestored', variant: 'default', run: e => e.readGenerationRestored({ sourceId: 'default', kind: 'consolidation', ownerKey: 'entity:a:cluster:1' }) },
    texts: [`SELECT restore_of IS NOT NULL AS restored FROM derived_generations
    WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'`],
  },
  {
    from: 'src/core/generations/adapters/fact-rows.ts:150 clearConsolidationTies (at c0a2bbe921)',
    case: { method: 'clearTieHeldGenerationRows', variant: 'default', run: e => e.clearTieHeldGenerationRows('default', 'consolidation', 'entity:a:cluster:') },
    texts: [`DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND state='held' AND held_reason='tie' AND left(owner_key, $3)=$4`],
  },
  {
    // The before-state column list is the shared TAKE_PREIMAGE_SQL, which the caller interpolated as well.
    from: 'src/core/generations/adapters/take-rows.ts:36 takePreimages (at 46b54a156e)',
    case: { method: 'readTakePreimages', variant: 'by-id', run: e => e.readTakePreimages({ pageId: 1, by: 'id', gone: [3], incoming: [{ row_num: 2, claim: 'c', kind: 'take', holder: 'h' }] }) },
    texts: [`SELECT ${TAKE_PREIMAGE_SQL} AS preimage, k.id = ANY($2::bigint[]) AS gone FROM takes k
      LEFT JOIN jsonb_to_recordset($3::text::jsonb) AS n(row_num integer, claim text, kind text, holder text) ON n.row_num = k.row_num
     WHERE k.page_id = $1 AND (k.id = ANY($2::bigint[]) OR (n.row_num IS NOT NULL AND (k.claim, k.kind, k.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder)))
     ORDER BY k.row_num`],
  },
  {
    from: 'src/core/generations/adapters/take-rows.ts:51 projectTakeFenceGeneration (at 46b54a156e)',
    case: { method: 'readTakePreimages', variant: 'by-row', run: e => e.readTakePreimages({ pageId: 1, by: 'row_num', gone: [3], incoming: [] }) },
    texts: [`SELECT ${TAKE_PREIMAGE_SQL} AS preimage, k.row_num = ANY($2::integer[]) AS gone FROM takes k
      LEFT JOIN jsonb_to_recordset($3::text::jsonb) AS n(row_num integer, claim text, kind text, holder text) ON n.row_num = k.row_num
     WHERE k.page_id = $1 AND (k.row_num = ANY($2::integer[]) OR (n.row_num IS NOT NULL AND (k.claim, k.kind, k.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder)))
     ORDER BY k.row_num`],
  },
  // The unowned admin and serve routes (Rust engine lane admin-unowned-rust), each text copied from its caller at 1bc04e66a8.
  {
    from: 'src/commands/serve-http-api-keys.ts:131 the admin key list (at 1bc04e66a8)',
    case: { method: 'listAccessTokenRows', variant: 'default', run: e => e.listAccessTokenRows() },
    texts: ['SELECT * FROM access_tokens ORDER BY created_at DESC, id'],
  },
  {
    // serve-http-registration.ts:199 sent this text; mcp-provision.ts:36 sent the same statement through the SqlQuery tag.
    from: 'src/commands/serve-http-registration.ts:199 the same-name registration lock (at 1bc04e66a8)',
    case: { method: 'lockOauthClientName', variant: 'default', run: e => e.lockOauthClientName('agent-register:pin-client') },
    texts: ['SELECT pg_advisory_xact_lock(hashtext($1)::bigint)'],
  },
  {
    from: 'src/core/access/actor.ts:315 linkRow (at 1bc04e66a8)',
    case: { method: 'readAccessMemberLink', variant: 'default', run: e => e.readAccessMemberLink('slack', 'U123') },
    texts: ['SELECT system, external_id, member_id, created_at FROM access_member_links WHERE system = $1 AND external_id = $2'],
  },
  {
    from: 'src/core/access/actor.ts:329 linkMember (at 1bc04e66a8)',
    case: { method: 'insertAccessMemberLink', variant: 'default', run: e => e.insertAccessMemberLink('slack', 'U123', 'alice-example') },
    texts: ['INSERT INTO access_member_links (system, external_id, member_id) VALUES ($1, $2, $3)'],
  },
  {
    from: 'src/core/access/actor.ts:343 unlinkMember (at 1bc04e66a8)',
    case: { method: 'deleteAccessMemberLink', variant: 'default', run: e => e.deleteAccessMemberLink('slack', 'U123') },
    texts: ['DELETE FROM access_member_links WHERE system = $1 AND external_id = $2'],
  },
  {
    from: 'src/core/access/actor.ts:349 listMemberLinks, every member (at 1bc04e66a8; merge 64 adds the byte order)',
    case: { method: 'listAccessMemberLinks', variant: 'all', run: e => e.listAccessMemberLinks(null) },
    texts: ['SELECT system, external_id, member_id, created_at FROM access_member_links ORDER BY member_id COLLATE "C", system COLLATE "C", external_id COLLATE "C"'],
  },
  {
    from: 'src/core/access/actor.ts:349 listMemberLinks, one member (at 1bc04e66a8; merge 64 adds the byte order)',
    case: { method: 'listAccessMemberLinks', variant: 'member', run: e => e.listAccessMemberLinks('alice-example') },
    texts: ['SELECT system, external_id, member_id, created_at FROM access_member_links WHERE member_id = $1 ORDER BY member_id COLLATE "C", system COLLATE "C", external_id COLLATE "C"'],
  },
  {
    from: 'src/core/persistence/page-visibility.ts:298 defaultSourceMemberWriter, a legacy token (at 1bc04e66a8)',
    case: { method: 'readCredentialMemberId', variant: 'token', run: e => e.readCredentialMemberId({ kind: 'token', id: '00000000-0000-4000-8000-0000000000b1' }) },
    texts: ['SELECT member_id FROM access_tokens WHERE id::text = $1'],
  },
  {
    from: 'src/core/persistence/page-visibility.ts:299 defaultSourceMemberWriter, an OAuth client (at 1bc04e66a8)',
    case: { method: 'readCredentialMemberId', variant: 'client', run: e => e.readCredentialMemberId({ kind: 'client', id: 'client-example' }) },
    texts: ['SELECT member_id FROM oauth_clients WHERE client_id = $1'],
  },
  {
    // serve-http-metrics.ts:263 sent this text; doctor/checks/db-connection.ts:317 sent the equivalent 'SELECT 1 AS ok'.
    from: 'src/commands/serve-http-metrics.ts:263 the health probe (at 1bc04e66a8)',
    case: { method: 'pingStore', variant: 'default', run: e => e.pingStore() },
    texts: ['SELECT 1'],
  },
  {
    // The minion worker's health probe sent this text on the direct lane (worker.ts probeDatabase, db-probe.ts assertWorkerDbReadiness).
    from: 'src/core/minions/worker.ts:403 and :405, the worker health probe (at a6e972420c)',
    case: { method: 'pingStore', variant: 'direct', run: e => e.pingStore({ direct: true }) },
    texts: ['SELECT 1'],
  },
  {
    from: 'src/core/minions/worker.ts:997-1003 releaseClaimForPause (at a6e972420c)',
    case: { method: 'releaseClaimForPause', variant: 'default', run: e => e.releaseClaimForPause(7, 'w1:a') },
    texts: [`UPDATE minion_jobs
         SET status = 'delayed', lock_token = NULL, lock_until = NULL,
             delay_until = now() + interval '1 minute',
             updated_at = now()
         WHERE id = $1 AND lock_token = $2`],
  },
  {
    from: 'src/core/minions/worker.ts:1041-1047 handleQuietHoursDefer, verdict defer (at a6e972420c)',
    case: { method: 'deferClaimForQuietHours', variant: 'default', run: e => e.deferClaimForQuietHours(7, 'w1:a') },
    texts: [`UPDATE minion_jobs
           SET status = 'delayed', lock_token = NULL, lock_until = NULL,
               delay_until = now() + interval '15 minutes',
               updated_at = now()
           WHERE id = $1 AND lock_token = $2`],
  },
  {
    // The minion worker's stall check sent this text on the default lane when idle past stallWarnAfterMs (worker.ts, health tick).
    from: 'src/core/minions/worker.ts:762-771 the stall check waiting-job count (at a59ee3ca58)',
    case: { method: 'countWaitingJobsForNames', variant: 'default', run: e => e.countWaitingJobsForNames('default', ['noop']) },
    texts: [`SELECT count(*)::text AS cnt FROM minion_jobs
                     WHERE status = 'waiting'
                       AND queue = $1
                       AND name = ANY($2::text[])`],
  },
  {
    from: 'src/commands/serve-http-webhooks.ts:303 legacyIngestJob (at 1bc04e66a8)',
    case: { method: 'readJobDataByIdempotencyKey', variant: 'default', run: e => e.readJobDataByIdempotencyKey('ingest:pin') },
    texts: ['SELECT data FROM minion_jobs WHERE idempotency_key = $1'],
  },
  {
    from: 'src/commands/jobs-watch.ts:163 the budget owners (at 1bc04e66a8)',
    case: { method: 'listBudgetOwners', variant: 'default', run: e => e.listBudgetOwners() },
    texts: [`SELECT
         mj.id AS owner_id,
         mj.budget_remaining_cents AS remaining_cents,
         COALESCE((SELECT SUM(ABS(cents_delta)) FROM minion_budget_log
                    WHERE owner_id = mj.id AND event_type = 'reserved'), 0) AS total_spent_cents
       FROM minion_jobs mj
       WHERE mj.budget_remaining_cents IS NOT NULL
         AND mj.budget_owner_job_id = mj.id
         AND mj.status NOT IN ('completed', 'failed', 'dead', 'cancelled')
       ORDER BY mj.id DESC
       LIMIT 5`],
  },
  {
    from: 'src/core/access/actor.ts:171 linkedMember, the attested-actor link (at a38152fde1, with its COLLATE "C" group order)',
    case: { method: 'readLinkedMember', variant: 'default', run: e => e.readLinkedMember('qm', 'person-1') },
    texts: [`SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
       FROM access_member_links l JOIN access_members m ON m.id = l.member_id LEFT JOIN access_group_members g ON g.member_id = m.id
       WHERE l.system = $1 AND l.external_id = $2 AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL GROUP BY m.id`],
  },
  {
    from: 'src/core/persistence/semantic-pages.ts:101 prepareSemanticPageMutation (the flagged entry\'s row id; at 0740badd2c)',
    case: { method: 'readNewestTimelineEntryId', variant: 'default', run: e => e.readNewestTimelineEntryId('default', 'people/alice-example', '2026-01-02', 'Met for coffee') },
    texts: [`SELECT t.id FROM timeline_entries t JOIN pages p ON p.id = t.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND t.date = $3::date AND t.summary = $4 ORDER BY t.id DESC LIMIT 1`],
  },
  {
    from: 'src/core/mentions/newer-mentions.ts:77 readNewerMentions (the entity page date; at d1ec6f64c1)',
    case: { method: 'readPageReferenceDate', variant: 'default', run: e => e.readPageReferenceDate('default', 'people/alice-example') },
    texts: [`SELECT to_char(COALESCE(effective_date, updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS d
         FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`],
  },
  {
    from: 'src/core/search/saved-facts-match.ts:58 headStems (the english configuration; at d1ec6f64c1)',
    case: { method: 'matchHeadStems', variant: 'default', run: e => e.matchHeadStems(['widget'], ['widgets']) },
    texts: [`SELECT h, ARRAY(SELECT t.i FROM unnest($2::text[]) WITH ORDINALITY AS t(term, i)
       WHERE to_tsvector('english'::regconfig, h) @@ plainto_tsquery('english'::regconfig, t.term)) AS i
     FROM unnest($1::text[]) AS h`],
  },
  {
    from: 'src/core/search/ignored-privacy-labels.ts:179 withIgnoredPrivacyLabelNotice (the stored page; at efeb078093)',
    case: { method: 'readLivePageFrontmatter', variant: 'default', run: e => e.readLivePageFrontmatter('default', 'people/alice-example') },
    // The caller's NOTICE_READ_TIMEOUT_MS bound rides along: the same server-side envelope its executeRaw call sent.
    texts: ['BEGIN READ WRITE; SET LOCAL statement_timeout = 1000',
      'SELECT type, frontmatter FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', 'COMMIT'],
  },
  {
    from: 'src/core/ops/search-type-filter.ts:42 reconcileTypeFilter (a remote caller, one empty set; at efeb078093)',
    case: { method: 'probePageTypes', variant: 'remote', run: e => e.probePageTypes([['person', 'people'], [], ['deal']], { sourceId: 'default', excludePrivate: true }) },
    // The caller's JIT-off bound rides along: the same server-side envelope its executeRaw call sent.
    texts: () => ["SELECT current_setting('jit') AS jit", 'BEGIN READ WRITE; SET LOCAL jit = off', pinnedTypeProbe([['person', 'people'], [], ['deal']], { sourceId: 'default', excludePrivate: true }), 'COMMIT'],
  },
  {
    from: 'src/core/ops/search-type-filter.ts:42 reconcileTypeFilter (federated sources under a trust floor; at efeb078093)',
    case: { method: 'probePageTypes', variant: 'floored', run: e => e.probePageTypes([['note']], { sourceIds: ['default', 'wiki'], minTrust: 'operator_curated' }) },
    // The caller's JIT-off bound rides along: the same server-side envelope its executeRaw call sent.
    texts: () => ["SELECT current_setting('jit') AS jit", 'BEGIN READ WRITE; SET LOCAL jit = off', pinnedTypeProbe([['note']], { sourceIds: ['default', 'wiki'], minTrust: 'operator_curated' }), 'COMMIT'],
  },
  {
    from: 'src/core/search/entity-facts.ts:53 newestFacts (a local caller under a trust floor; at efeb078093)',
    case: { method: 'readEntityNewestFacts', variant: 'local', run: e => e.readEntityNewestFacts({ sourceId: 'default', slugs: ['people/alice-example'], remote: false, worldOnly: false, minTrust: 'operator_curated' }) },
    texts: () => [pinnedNewestFacts(false, false, 'operator_curated')],
  },
  {
    from: 'src/core/search/entity-facts.ts:53 newestFacts (a remote caller with world-only facts; at efeb078093)',
    case: { method: 'readEntityNewestFacts', variant: 'remote', run: e => e.readEntityNewestFacts({ sourceId: 'default', slugs: ['people/alice-example', 'alice-example'], remote: true, worldOnly: true }) },
    texts: () => [pinnedNewestFacts(true, true)],
  },
  {
    from: 'src/core/search/entity-facts.ts:53 newestFacts (a remote caller with private facts allowed; at efeb078093)',
    case: { method: 'readEntityNewestFacts', variant: 'remotePrivate', run: e => e.readEntityNewestFacts({ sourceId: 'default', slugs: ['people/alice-example'], remote: true, worldOnly: false }) },
    texts: () => [pinnedNewestFacts(true, false)],
  },
  {
    from: 'src/core/search/entity-anchor.ts:38 and :42 entityAnchoredPages (the entity page, then the anchored pages; at efeb078093)',
    case: { method: 'readEntityAnchoredPages', variant: 'default', run: e => e.readEntityAnchoredPages('default', 'people/alice-example') },
    // The second statement is written out in engine-sql (the dynamic-SQL guard allows `$4` twice only in a static
    // statement); the caller's interpolations are rebuilt here from their constants, so a drift in either fails.
    texts: () => ['SELECT id, title FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL',
      `SELECT p.id, p.slug FROM pages p WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug <> $2
       AND p.type NOT IN ('question', 'synthesis') AND NOT (p.frontmatter ? '${PINNED_QUESTION_MARKER}')
       AND (p.compiled_truth ~* $3 OR ($4::integer IS NOT NULL AND EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id AND l.to_page_id = $4::integer AND ${rankingLinkSql('l')})))
     ORDER BY COALESCE(p.effective_date, p.updated_at) DESC, p.id DESC LIMIT ${MAX_ANCHORED}`],
  },
  {
    from: 'src/core/persistence/concept-rebuild.ts:140 statedKinds (STATED_SQL; at 7c85d5696f)',
    case: { method: 'readConceptStatedKinds', variant: 'default', run: e => e.readConceptStatedKinds(7, 'default', 'concepts/a', { derivedLinkSources: ['markdown'], statedLabelKeys: ['readable_by'], synthesisKeys: ['type'] }) },
    // The caller's interpolations are rebuilt here from their builders, so a drift in either fails.
    texts: () => [conceptStatedSql()],
  },
  {
    from: 'src/core/persistence/concept-rebuild.ts:176 readRebuildAccess (ACCESS_SQL; at 7c85d5696f)',
    case: { method: 'readRebuildAccess', variant: 'default', run: e => e.readRebuildAccess(7) },
    texts: () => [`SELECT ${privatePagesFilterFragment('p')} AS open, ${privacyPartSql('p')} AS public_part, gbrain_access_readers(p.frontmatter) AS readers,
  p.page_readers, p.folder_rule_ids FROM pages p WHERE p.id = $1`],
  },
  {
    from: 'src/core/persistence/concept-rebuild.ts:319 readHeldConceptRows (the held-concept report; at 7c85d5696f)',
    case: { method: 'readHeldConceptRows', variant: 'default', run: e => e.readHeldConceptRows() },
    texts: () => [`SELECT p.id, p.source_id, p.slug,
    NOT ${privacyPartSql('p')} AS private,
    EXISTS (SELECT 1 FROM derivation_inputs d JOIN pages m ON m.id::text = d.input_id AND d.input_table = 'pages'
      WHERE d.derived_table = 'pages' AND d.derived_id = p.id::text AND m.deleted_at IS NULL AND NOT (${privatePagesFilterFragment('m')})) AS members_private
    FROM (SELECT $1::text AS owed_op) q, pages p WHERE ${HELD_CONCEPT_SQL} ORDER BY p.source_id, p.slug`],
  },
  {
    from: 'src/core/repair/visibility.ts:169 planVisibilityRepair (the apply re-decide page type; at 85ad984039; now listPageRefsByIds, which also names id, source_id and slug)',
    case: { method: 'listPageRefsByIds', variant: 'default', run: e => e.listPageRefsByIds([7]) },
    texts: ['SELECT id, source_id, slug, type FROM pages WHERE id = ANY($1::bigint[]) ORDER BY id'],
  },
  {
    from: 'src/core/repair/visibility.ts:252 applyFactItem (the fenced fact read back after the page write; at 85ad984039)',
    case: { method: 'readFactLiveVisibility', variant: 'default', run: e => e.readFactLiveVisibility(7) },
    texts: ['SELECT visibility, expired_at IS NULL AS live FROM facts WHERE id=$1'],
  },
  {
    from: 'src/core/repair/visibility.ts:254 applyFactItem (the fenced fact made private in place; at 85ad984039)',
    case: { method: 'tightenFencedFactVisibility', variant: 'default', run: e => e.tightenFencedFactVisibility('default', 7, 1) },
    texts: ["UPDATE facts SET visibility='private' WHERE source_id=$1 AND id=$2 AND row_num=$3 AND visibility='world' AND expired_at IS NULL RETURNING id"],
  },
  {
    from: 'src/core/page-state/contextual-proof.ts:12 reconcileContextualEmbeddingInputs (the recorded input hashes; at 85ad984039)',
    case: { method: 'readChunkInputHashes', variant: 'default', run: e => e.readChunkInputHashes(7) },
    texts: ['SELECT id,embedding_input_hash FROM content_chunks WHERE page_id=$1'],
  },
  {
    from: 'src/core/page-state/contextual-proof.ts:19 reconcileContextualEmbeddingInputs (the stale vectors cleared; at 85ad984039)',
    case: { method: 'clearChunkEmbeddingsByIds', variant: 'default', run: e => e.clearChunkEmbeddingsByIds(7, { name: 'embedding', dimensions: 1536 }, [1, 2]) },
    // The caller's interpolation (the quoted column) is rebuilt from its builder, so a drift fails.
    texts: () => [`UPDATE content_chunks SET ${quoteIdentifier('embedding')}=NULL,
    embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,embedding_pending_since=now() WHERE page_id=$1 AND id=ANY($2::int[])`],
  },
  {
    from: 'src/core/page-state/contextual-proof.ts:23 reconcileContextualEmbeddingInputs (the proof hashes recorded; at 85ad984039)',
    case: { method: 'writeChunkInputHashes', variant: 'default', run: e => e.writeChunkInputHashes(7, [1], ['h']) },
    texts: [`UPDATE content_chunks c SET embedding_input_hash=proof.hash
    FROM unnest($2::int[],$3::text[]) AS proof(id,hash) WHERE c.page_id=$1 AND c.id=proof.id`],
  },
  {
    from: 'src/core/search/entity-anchor.ts:116 applyEntityAnchoring (the anchored page titles; at efeb078093)',
    case: { method: 'readPageTitlesById', variant: 'default', run: e => e.readPageTitlesById([1, 2]) },
    texts: ['SELECT id, title FROM pages WHERE id = ANY($1::int[])'],
  },
  {
    from: 'src/core/search/safe-chunks.ts:192 provenanceDistrusted (the stored chunker version; at f9592f7a7e)',
    case: { method: 'readPageChunkerVersion', variant: 'default', run: e => e.readPageChunkerVersion(7) },
    texts: ['SELECT chunker_version FROM pages WHERE id = $1'],
  },
  {
    from: 'src/core/import-file.ts:1896 importImageFile (the unchanged image\'s seal probe; at f9592f7a7e)',
    case: { method: 'readImageSealProbe', variant: 'default', run: e => e.readImageSealProbe('default', 'images/a.png') },
    // The fence test is written out in engine-sql; it is rebuilt here from the caller's builder, so a drift in either fails.
    texts: () => [`SELECT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id AND c.embedding_image IS NOT NULL) AS has_visual
         FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND ${safeChunksFilter('p')}`],
  },
  {
    from: 'src/core/search/entity-anchor.ts:43 prefixAnchoredPages (the newest pages under a slug prefix; at f9592f7a7e)',
    case: { method: 'readPrefixAnchoredPages', variant: 'default', run: e => e.readPrefixAnchoredPages('default', 'projects/widget_') },
    // The marker and the limit are written out in engine-sql; the caller's interpolations are rebuilt from their constants.
    texts: () => [`SELECT id, slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE $2
       AND type NOT IN ('question', 'synthesis') AND NOT (frontmatter ? '${PINNED_QUESTION_MARKER}')
     ORDER BY COALESCE(effective_date, updated_at) DESC, id DESC LIMIT ${MAX_ANCHORED}`],
  },
  {
    from: 'src/core/search/private-visibility.ts:1162 findPrivateOnlySlugs (no scope, live rows; at f9592f7a7e)',
    case: { method: 'readPrivateOnlySlugs', variant: 'default', run: e => e.readPrivateOnlySlugs(['notes/a'], {}) },
    texts: () => [privateOnlySlugsSql('', false)],
  },
  {
    from: 'src/core/search/private-visibility.ts:1162 findPrivateOnlySlugs (a federated scope; at f9592f7a7e)',
    case: { method: 'readPrivateOnlySlugs', variant: 'federated', run: e => e.readPrivateOnlySlugs(['notes/a'], { sourceId: 'x', sourceIds: ['default', 'work'] }) },
    texts: () => [privateOnlySlugsSql('AND p.source_id = ANY($2::text[])', false)],
  },
  {
    from: 'src/core/search/private-visibility.ts:1162 findPrivateOnlySlugs (one source, deleted rows too; at f9592f7a7e)',
    case: { method: 'readPrivateOnlySlugs', variant: 'scalar-deleted', run: e => e.readPrivateOnlySlugs(['notes/a'], { sourceId: 'default' }, { includeDeleted: true }) },
    texts: () => [privateOnlySlugsSql('AND p.source_id = $2', true)],
  },
  {
    from: 'src/core/verbs/entity-text-mentions.ts:103 probe (the text-mention pages; at efeb078093)',
    case: { method: 'readTextMentionPages', variant: 'default', run: e => e.readTextMentionPages(['default'], ['notes/a']) },
    texts: [`SELECT slug, source_id, title, type, frontmatter, COALESCE(effective_date, updated_at) AS date
       FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND slug = ANY($2::text[])`],
  },
  {
    from: 'src/core/search/evidence-delivery.ts:416 selectLongPages (the long-page size preflight with the timeline; at efeb078093)',
    case: { method: 'readLongPageSizes', variant: 'timeline', run: e => e.readLongPageSizes([3, 5], { sourceId: 'default' }, { includeTimeline: true }) },
    texts: () => [pinnedLongPageSizes({ sourceId: 'default' }, true)],
  },
  {
    from: 'src/core/search/evidence-delivery.ts:416 selectLongPages (detail low, a remote caller under a trust floor; at efeb078093)',
    case: { method: 'readLongPageSizes', variant: 'low', run: e => e.readLongPageSizes([3], { sourceIds: ['default', 'wiki'], excludePrivate: true, minTrust: 'operator_curated' }, { includeTimeline: false }) },
    texts: () => [pinnedLongPageSizes({ sourceIds: ['default', 'wiki'], excludePrivate: true, minTrust: 'operator_curated' }, false)],
  },
  ...reflexPins(),
  ...briefPins(),
  {
    // readSyncImportProvenance (the one-page form, `fingerprint=$2`) now sends this statement with a one-element list.
    from: 'src/core/persistence/sync-holds.ts:1360 readSyncImportProvenances',
    case: { method: 'readOpCheckpointRecords', variant: 'default', run: e => e.readOpCheckpointRecords('sync-import-provenance', ['default:inc-1:1']) },
    texts: ['SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint = ANY($2::text[])'],
  },
  {
    // recordSyncImportProvenance (the one-page `VALUES($1,$2,$3::text::jsonb)` form) now sends this statement with one row.
    from: 'src/core/persistence/sync-holds.ts:1349 recordSyncImportProvenances',
    case: { method: 'writeOpCheckpointRecords', variant: 'default', run: e => e.writeOpCheckpointRecords('sync-import-provenance', [{ fingerprint: 'default:inc-1:1', record: { page_id: 1 } }]) },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
    SELECT $1, entry->>'fingerprint', jsonb_build_array(entry->'record') FROM jsonb_array_elements($2::text::jsonb) AS entry
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`],
  },
  {
    from: 'src/core/guests/owner-credentials.ts:73 ownerCredentials (at b7b18e5ab3; the token row is tokenGrantJsonSql(\'t\'))',
    case: { method: 'listOwnerCredentialRows', variant: 'default', run: e => e.listOwnerCredentialRows('owner-example') },
    texts: () => ["SELECT * FROM (SELECT 'token' AS kind, t.id::text AS id, t.name, " + tokenGrantJsonSql('t') + " AS row FROM access_tokens t WHERE t.member_id = $1 AND t.revoked_at IS NULL "
      + "UNION ALL SELECT 'client' AS kind, c.client_id AS id, COALESCE(c.client_name, c.client_id) AS name, to_jsonb(c) - 'client_secret_hash' AS row "
      + "FROM oauth_clients c WHERE c.member_id = $1 AND (to_jsonb(c)->>'deleted_at') IS NULL) q ORDER BY kind COLLATE \"C\", name COLLATE \"C\", id COLLATE \"C\""],
  },
  {
    from: 'src/core/shared-skills/migration-members.ts:13 inspectSharedMemberMigration (at b7b18e5ab3)',
    case: { method: 'listSharedMemberMigrationRows', variant: 'default', run: e => e.listSharedMemberMigrationRows('s') },
    texts: [`SELECT m.installation_id,m.adapter,m.epoch,m.active,m.follow_policy->'sources'->>$1 AS approved_incarnation,
      m.desired_view,m.acknowledged_view,
      (SELECT b.evidence->>'stage' FROM shared_skill_delivery_batches b WHERE b.installation_id=m.installation_id
        AND b.epoch=m.epoch AND b.sequence=m.acknowledged_sequence AND b.acknowledged_at IS NOT NULL LIMIT 1) AS stage
    FROM shared_skill_members m WHERE m.follow_policy->'sources' ? $1 ORDER BY m.adapter COLLATE "C",m.installation_id LIMIT 4096`],
  },
  {
    from: 'src/commands/reconcile-links.ts:120 runReconcileLinks (at b7b18e5ab3)',
    case: { method: 'listMarkdownPageSlugs', variant: 'default', run: e => e.listMarkdownPageSlugs('work') },
    texts: [`SELECT slug FROM pages WHERE page_kind = 'markdown' AND source_id = $1 ORDER BY slug COLLATE "C"`],
  },
  {
    from: 'src/commands/serve-http-clients.ts:21 mountAdminClients (at b7b18e5ab3)',
    case: { method: 'listAdminClientRows', variant: 'default', run: e => e.listAdminClientRows() },
    texts: () => [`SELECT ${CLIENT_INSPECTION_COLUMNS} FROM oauth_clients ORDER BY created_at DESC, client_id COLLATE "C"`],
  },
  {
    from: 'src/core/questions/store.ts:133 insertPin (at b7b18e5ab3)',
    case: { method: 'insertPinnedQuestion', variant: 'default', run: e => e.insertPinnedQuestion({ sourceId: 'default', slug: 'q', question: 'q?', scopeSlugPrefix: null, scopeEntity: null, state: 'active', inactiveReason: null, publishMode: 'publish', createdBy: 't' }) },
    texts: [`INSERT INTO pinned_questions (source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_id, slug) DO NOTHING RETURNING id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at`],
  },
  {
    from: 'src/core/questions/store.ts:104 getPin (at b7b18e5ab3; without forUpdate)',
    case: { method: 'readPinnedQuestion', variant: 'default', run: e => e.readPinnedQuestion('default', 'q') },
    texts: [`SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE source_id = $1 AND slug = $2`],
  },
  {
    from: 'src/core/questions/store.ts:115 listPins (at b7b18e5ab3; the all composition)',
    case: { method: 'listPinnedQuestions', variant: 'all', run: e => e.listPinnedQuestions({ includeArchived: true }) },
    texts: [`SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions  ORDER BY source_id COLLATE "C", created_at, id`],
  },
  {
    from: 'src/core/questions/store.ts:115 listPins (at b7b18e5ab3; the unarchived composition)',
    case: { method: 'listPinnedQuestions', variant: 'unarchived', run: e => e.listPinnedQuestions({ includeArchived: false }) },
    texts: [`SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE state <> 'archived' ORDER BY source_id COLLATE "C", created_at, id`],
  },
  {
    from: 'src/core/questions/store.ts:115 listPins (at b7b18e5ab3; the states composition)',
    case: { method: 'listPinnedQuestions', variant: 'states', run: e => e.listPinnedQuestions({ states: ['active'] }) },
    texts: [`SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE state = ANY($1::text[]) ORDER BY source_id COLLATE "C", created_at, id`],
  },
  {
    from: 'src/core/questions/store.ts:115 listPins (at b7b18e5ab3; the sources composition)',
    case: { method: 'listPinnedQuestions', variant: 'sources', run: e => e.listPinnedQuestions({ sourceIds: ['default'], includeArchived: true }) },
    texts: [`SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE source_id = ANY($1::text[]) ORDER BY source_id COLLATE "C", created_at, id`],
  },
  {
    from: 'src/core/questions/store.ts:115 listPins (at b7b18e5ab3; the sources-unarchived composition)',
    case: { method: 'listPinnedQuestions', variant: 'sources-unarchived', run: e => e.listPinnedQuestions({ sourceIds: ['default'] }) },
    texts: [`SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE source_id = ANY($1::text[]) AND state <> 'archived' ORDER BY source_id COLLATE "C", created_at, id`],
  },
  {
    from: 'src/core/questions/store.ts:115 listPins (at b7b18e5ab3; the sources-states composition)',
    case: { method: 'listPinnedQuestions', variant: 'sources-states', run: e => e.listPinnedQuestions({ sourceIds: ['default'], states: ['active'] }) },
    texts: [`SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE source_id = ANY($1::text[]) AND state = ANY($2::text[]) ORDER BY source_id COLLATE "C", created_at, id`],
  },
  {
    from: 'src/core/context/volunteer-events.ts:178 insertVolunteerEvents (at b7b18e5ab3; two rows)',
    case: { method: 'insertVolunteerEvents', variant: 'default', run: e => e.insertVolunteerEvents([
      { source_id: 'default', slug: 'p', confidence: 0.5, match_arm: 'a', rationale: '', channel: 'op' },
      { source_id: 'default', slug: 'q', confidence: 0.5, match_arm: 'b', rationale: '', channel: 'op', session_id: 's', turn: 1 }]) },
    texts: [`INSERT INTO context_volunteer_events
       (source_id, slug, confidence, match_arm, rationale, channel, session_id, turn)
     SELECT v.* FROM (VALUES ($1::text, $2::text, $3::float8, $4::text, $5::text, $6::text, $7::text, $8::int), ($9::text, $10::text, $11::float8, $12::text, $13::text, $14::text, $15::text, $16::int)) AS v(source_id, slug, confidence, match_arm, rationale, channel, session_id, turn)
     WHERE EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = v.source_id AND pg.slug = v.slug FOR KEY SHARE)`],
  },
  {
    from: 'src/core/context/volunteer.ts:370 volunteerUsageStats (at b7b18e5ab3)',
    case: { method: 'readVolunteerUsage', variant: 'default', run: e => e.readVolunteerUsage(['default'], 30) },
    texts: [`SELECT e.match_arm, e.channel,
              count(*)::text AS volunteered,
              count(*) FILTER (WHERE GREATEST(p.last_retrieved_at, r.last_retrieved_at) > e.volunteered_at)::text AS used
         FROM context_volunteer_events e
         LEFT JOIN pages p
           ON p.source_id = e.source_id AND p.slug = e.slug AND p.deleted_at IS NULL
         LEFT JOIN page_retrievals r ON r.page_id = p.id
        WHERE e.source_id = ANY($1::text[])
          AND e.volunteered_at > now() - ($2 || ' days')::interval
        GROUP BY e.match_arm, e.channel
        ORDER BY e.match_arm COLLATE "C", e.channel COLLATE "C"`],
  },
  {
    from: 'src/core/context/volunteer-events.ts:287 purgeStaleVolunteerEvents (at 9ddd6ac59a)',
    case: { method: 'deleteVolunteerEventsOlderThan', variant: 'default', run: e => e.deleteVolunteerEventsOlderThan(90) },
    texts: [`WITH deleted AS (
         DELETE FROM context_volunteer_events
         WHERE volunteered_at < now() - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`],
  },
  {
    from: 'src/commands/sources-git-gap.ts:153 censusGitGap (at b7b18e5ab3; the source row)',
    case: { method: 'readGitGapSourceRow', variant: 'default', run: e => e.readGitGapSourceRow('work') },
    texts: ['SELECT local_path, incarnation::text AS incarnation FROM sources WHERE id=$1'],
  },
  {
    from: 'src/commands/sources-git-gap.ts:167 censusGitGap (at b7b18e5ab3; the live page count)',
    case: { method: 'countGitGapLivePages', variant: 'default', run: e => e.countGitGapLivePages('work') },
    texts: ['SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL'],
  },
  {
    from: 'src/commands/sources-git-gap.ts:175 censusGitGap (at b7b18e5ab3; also :189 and :205)',
    case: { method: 'markTransactionReadOnly', variant: 'default', run: e => e.markTransactionReadOnly() },
    texts: ['SET TRANSACTION READ ONLY'],
  },
  {
    from: 'src/commands/sources-git-gap.ts:176 censusGitGap (at b7b18e5ab3; the --newest pages)',
    case: { method: 'listGitGapNewestPages', variant: 'default', run: e => e.listGitGapNewestPages('work', 5) },
    texts: [`SELECT id::text, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
        FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT $2`],
  },
  {
    from: 'src/commands/sources-git-gap.ts:178 censusGitGap (at b7b18e5ab3; facts on the pages --newest leaves unread)',
    case: { method: 'countGitGapUnreadFacts', variant: 'default', run: e => e.countGitGapUnreadFacts('work', ['1', '2']) },
    texts: [`SELECT count(*)::int AS n FROM facts f
        JOIN pages p ON p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL
        WHERE f.source_id=$1 AND f.row_num IS NOT NULL AND NOT (p.id = ANY($2::bigint[]))`],
  },
  {
    from: 'src/commands/sources-git-gap.ts:190 censusGitGap (at b7b18e5ab3; the keyset batch)',
    case: { method: 'readGitGapPageBatch', variant: 'after', run: e => e.readGitGapPageBatch('work', { after: '0' }) },
    texts: () => [`SELECT id::text, slug, source_id, source_path, octet_length(source_path) AS source_path_bytes, source_uri, withheld_source_path, type, frontmatter,
          database_only_reason, body_storage='segmented' AS segmented, knowledge_revision::text AS revision, NOT ${privacyPartSql('pages')} AS lineage_private
        FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND pages.id > $2::bigint ORDER BY pages.id LIMIT 256`],
  },
  {
    from: 'src/commands/sources-git-gap.ts:190 censusGitGap (at b7b18e5ab3; the --newest batch)',
    case: { method: 'readGitGapPageBatch', variant: 'ids', run: e => e.readGitGapPageBatch('work', { ids: ['1', '2'] }) },
    texts: () => [`SELECT id::text, slug, source_id, source_path, octet_length(source_path) AS source_path_bytes, source_uri, withheld_source_path, type, frontmatter,
          database_only_reason, body_storage='segmented' AS segmented, knowledge_revision::text AS revision, NOT ${privacyPartSql('pages')} AS lineage_private
        FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND pages.id = ANY($2::bigint[]) ORDER BY pages.id LIMIT 256`],
  },
  {
    from: 'src/commands/sources-git-gap.ts:369 countRowsWithoutFile (at b7b18e5ab3; the facts)',
    case: { method: 'countGitGapFactsOnPages', variant: 'default', run: e => e.countGitGapFactsOnPages('work', ['notes/a']) },
    texts: ['SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND row_num IS NOT NULL AND source_markdown_slug = ANY($2::text[])'],
  },
  {
    from: 'src/commands/sources-git-gap.ts:371 countRowsWithoutFile (at b7b18e5ab3; the timeline rows)',
    case: { method: 'countGitGapTimelineOnPages', variant: 'default', run: e => e.countGitGapTimelineOnPages([1, 2]) },
    texts: ['SELECT count(*)::int AS n FROM timeline_entries WHERE page_id = ANY($1::int[])'],
  },
  {
    from: 'src/commands/sources-git-gap.ts:385-398 countSourceRows (at b7b18e5ab3; the five statements, in order)',
    case: { method: 'readGitGapSourceRows', variant: 'default', run: e => e.readGitGapSourceRows('work', ['frontmatter'], 'sync-hold') },
    texts: ['SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND row_num IS NULL AND expired_at IS NULL',
      `SELECT count(*)::int AS n FROM facts f WHERE f.source_id=$1 AND f.row_num IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL)`,
      `SELECT COALESCE(l.link_source, '(none)') COLLATE "C" AS link_source, count(*)::int AS n
    FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 AND p.deleted_at IS NULL AND (l.link_source IS NULL OR NOT (l.link_source = ANY($2::text[])))
    GROUP BY 1 ORDER BY 1`,
      `SELECT h.completed_keys->0->>'code' COLLATE "C" AS code, count(*)::int AS n FROM op_checkpoints h
    JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND s.id=$2 GROUP BY 1 ORDER BY 1`,
      `SELECT e.kind COLLATE "C" AS kind, p->>'error_code' COLLATE "C" AS code, count(*)::int AS targets
    FROM persistence_effects e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.data->'parked')='array' THEN e.data->'parked' ELSE '[]'::jsonb END) p
    WHERE e.source_id=$1 GROUP BY 1, 2 ORDER BY 1, 2`],
  },
  {
    from: 'src/core/persistence/sync-admission.ts:34 readSyncAdmission',
    case: { method: 'readStoredConfigValue', variant: 'default', run: e => e.readStoredConfigValue('sync.admission') },
    texts: ['SELECT value FROM config WHERE key=$1'],
  },
  {
    from: 'src/core/persistence/sync-pass.ts:460 readPages (a confirm round: the named page ids)',
    case: { method: 'readSyncImportPageRows', variant: 'ids', run: e => e.readSyncImportPageRows(SYNC_PASS_Q, { ids: ['1', '2'] }) },
    texts: () => [`${syncPassSelect(false)} AND p.id = ANY($5::bigint[]) ORDER BY p.id`],
  },
  {
    from: 'src/core/persistence/sync-pass.ts:488 readPages (PGLite\'s keyset page)',
    case: { method: 'readSyncImportPageRows', variant: 'keyset', run: e => e.readSyncImportPageRows(SYNC_PASS_Q, { after: 0, limit: 2_000 }) },
    texts: () => [`${syncPassSelect(false)} AND p.id>$5 ORDER BY p.id LIMIT 2000`],
  },
  {
    from: 'src/core/persistence/sync-pass.ts:468 readPages (Postgres\'s whole-source cursor, the record subquery kept by OFFSET 0)',
    case: { method: 'declareSyncImportPageCursor', variant: 'default', run: e => e.declareSyncImportPageCursor(SYNC_PASS_Q) },
    texts: () => ['SET LOCAL cursor_tuple_fraction = 1', `DECLARE sync_pass_pages NO SCROLL CURSOR FOR ${syncPassSelect(true)}`],
  },
  {
    from: 'src/core/persistence/sync-pass.ts:472 readPages (a cursor fetch)',
    case: { method: 'fetchSyncImportPageCursor', variant: 'default', run: e => e.fetchSyncImportPageCursor(4_000) },
    texts: ['FETCH 4000 FROM sync_pass_pages'],
  },
  // The managed sync run's journal reads and the sync.admission statements, copied verbatim from the callers at bdb0fb17a4.
  {
    from: 'src/core/persistence/sync-admitted.ts:38 readAdmitted (every admitted request)',
    case: { method: 'readAdmittedWriteRequests', variant: 'all', run: e => e.readAdmittedWriteRequests('local_cli', 'writer-1', [ADMITTED_REQUEST], false) },
    texts: ['SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[])'],
  },
  {
    from: 'src/core/persistence/sync-admitted.ts:38 readAdmitted (committed only)',
    case: { method: 'readAdmittedWriteRequests', variant: 'committed', run: e => e.readAdmittedWriteRequests('local_cli', 'writer-1', [ADMITTED_REQUEST], true) },
    texts: ["SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[]) AND state='committed'"],
  },
  {
    from: 'src/core/persistence/sync-concurrent-write.ts:30 concurrentWriteProof (the page; the same text as sync-page-fault.ts:76 pageChangeProof)',
    case: { method: 'readPageRevisionWriter', variant: 'default', run: e => e.readPageRevisionWriter(7, 'default') },
    texts: ['SELECT knowledge_revision::text AS revision, revision_write_request_id::text AS writer FROM pages WHERE id=$1 AND source_id=$2'],
  },
  {
    from: 'src/core/persistence/sync-concurrent-write.ts:33 concurrentWriteProof (the writer; the same text as sync-page-fault.ts:79 and :99)',
    case: { method: 'readRevisionWriterRequest', variant: 'default', run: e => e.readRevisionWriterRequest(ADMITTED_REQUEST) },
    texts: [`SELECT request_id::text, operation, intent->>'kind' AS kind, state, source_incarnation::text AS incarnation, page_id FROM persistence_requests WHERE id=$1::uuid`],
  },
  {
    from: 'src/core/persistence/sync-admission.ts:98 writeSyncAdmission (the dating row)',
    case: { method: 'writeSyncAdmissionStamp', variant: 'default', run: e => e.writeSyncAdmissionStamp('sync-admission', 'brain', 'imports_only'),
      rows: [[/^INSERT INTO op_checkpoints\(op,fingerprint,completed_keys,updated_at\)/, [{ set_at: '2026-01-01T00:00:00+00:00' }]]] },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('value',$3::text,'set_at',clock_timestamp())),now())
      ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()
      RETURNING completed_keys->0->>'set_at' AS set_at`],
  },
  {
    from: 'src/core/persistence/sync-admission.ts:150 syncAdmissionStatus (the effective probes, effectProbes over $1..$7)',
    case: { method: 'readSyncAdmissionEffects', variant: 'default', run: e => e.readSyncAdmissionEffects({ lockId: 'sync-lock-example', passOp: 'sync-pass-example',
      passKey: 'default:inc-1', setAt: null, sourceId: 'default', incarnation: 'inc-1', kinds: ['managed_sync_delete'] }),
      rows: [[/^SELECT EXISTS \(SELECT 1 FROM op_checkpoints p JOIN gbrain_cycle_locks/, [{ pinned: false, destructive: false }]]] },
    texts: () => [`SELECT EXISTS (SELECT 1 FROM op_checkpoints p JOIN gbrain_cycle_locks l ON l.id=$1 AND l.ttl_expires_at > now()
          AND l.acquisition_token::text = p.completed_keys->0->>'lease_token'
        WHERE p.op=$2 AND p.fingerprint=$3 AND p.completed_keys->0->'telemetry'->>'outcome'='open'
          AND ($4::timestamptz IS NULL OR (p.completed_keys->0->'telemetry'->>'started_at')::timestamptz < $4::timestamptz)) AS pinned, EXISTS (SELECT 1 FROM persistence_requests r WHERE r.source_id=$5 AND r.source_incarnation=$6::uuid
          AND r.state IN ('queued','running','recovering') AND r.intent->>'kind' = ANY($7::text[])
          AND ($4::timestamptz IS NULL OR r.created_at < $4::timestamptz)) AS destructive`],
  },
  {
    from: 'src/core/persistence/sync-administration.ts:19 runAuthenticatedSyncSlice (now the existing readSourceMembership, the same text)',
    case: { method: 'readSourceMembership', variant: 'default', run: e => e.readSourceMembership('default') },
    texts: ['SELECT incarnation,archived FROM sources WHERE id=$1'],
  },
  {
    from: 'src/core/entities/resolve.ts:162 tryOrgDirVariant',
    case: { method: 'readLiveSlugs', variant: 'default', run: e => e.readLiveSlugs('default', ['orgs/acme', 'organizations/acme']) },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])'],
  },
  {
    from: 'src/core/entities/resolve.ts:360 findExactBasenameCandidates',
    case: { method: 'readLiveSlugs', variant: 'limit_2', run: e => e.readLiveSlugs('default', ['people/alice-example', 'companies/alice-example'], { limit: 2 }) },
    texts: [`SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])
        LIMIT 2`],
  },
  ...([
    ['none', () => ''],
    ['caller', () => `AND ${privatePagesFilterForCaller('p')}`],
    ['floor', () => `AND ${remoteReadFloorSql('p')}`],
  ] as const).map(([privacy, predicate]): Pin => ({
    from: `src/core/entities/resolve.ts:478 resolveStrictEntityReference live (privacy ${privacy})`,
    case: { method: 'readLivePageTypes', variant: privacy, run: e => e.readLivePageTypes('default', ['people/alice-example'], privacy) },
    texts: () => [`SELECT p.slug, p.type FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug = ANY($2::text[]) ${predicate()}`],
  })),
  {
    from: 'src/core/entities/resolve.ts:732 tryUnambiguousPrefixExpansion dirs',
    case: { method: 'readPrefixDirs', variant: 'default', run: e => e.readPrefixDirs('default', ['people/alice', 'people/alice-%']) },
    texts: () => [`SELECT DISTINCT split_part(slug, '/', 1) AS dir FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND NOT ${retiredPageSql('pages')} AND slug LIKE ANY($2::text[])
        LIMIT 2`],
  },
  {
    from: 'src/core/entities/resolve.ts:739 tryUnambiguousPrefixExpansion exact titles',
    case: { method: 'readPrefixTitleMatches', variant: 'default', run: e => e.readPrefixTitleMatches('default', ['companies/acme', 'companies/acme-%'], 'Acme') },
    texts: () => [`SELECT slug, title FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND NOT ${retiredPageSql('pages')}
          AND slug LIKE ANY($2::text[]) AND lower(title) = lower($3)
        LIMIT 3`],
  },
  {
    from: 'src/core/sync-dispatch-read.ts:51 syncDispatchRow',
    case: { method: 'readSyncDispatchRow', variant: 'default', run: e => e.readSyncDispatchRow('default') },
    texts: () => [`SELECT s.id, s.archived, s.config, s.incarnation::text AS incarnation, s.local_path,
  EXISTS(SELECT 1 FROM persistence_source_bindings b WHERE b.source_id=s.id AND b.source_incarnation=s.incarnation) AS claimed,
  EXISTS(SELECT 1 FROM source_ingestion_receipts r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.profile='company-brain') AS company_receipt,
  (SELECT COALESCE(jsonb_agg(m.enabled), '[]'::jsonb) FROM (${MANAGED_MODE_SQL}) m) AS modes
  FROM (SELECT $1::text AS want) w LEFT JOIN sources s ON s.id=w.want`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:1186 readGitHoldRetryPaths',
    case: { method: 'readGitHoldRetryRequest', variant: 'default', run: e => e.readGitHoldRetryRequest('default:1') },
    texts: ['SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:1452,1458 buildHoldReport',
    case: { method: 'readGitHoldReportInputs', variant: 'default', run: e => e.readGitHoldReportInputs('default', 'default:1') },
    texts: [`SELECT COALESCE((completed_keys->0->>'count')::int,0) AS count,
      COALESCE((completed_keys->0->>'drift')::int,0) AS drift,
      COALESCE((completed_keys->0->>'images')::int,0) AS images, COALESCE((completed_keys->0->>'fences')::int,0) AS fences, COALESCE((completed_keys->0->>'stalled')::int,0) AS stalled,
      COALESCE((completed_keys->0->>'concurrent')::int,0) AS concurrent, COALESCE((completed_keys->0->>'dirty')::int,0) AS dirty
    FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`, "SELECT config->>'mirror_read_only' AS mirror FROM sources WHERE id=$1"],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:334 lockSummary (at 8b80bd80ab)',
    case: { method: 'lockGitHoldSummary', variant: 'default', run: e => e.lockGitHoldSummary('default', '1') },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('source_id',$3::text,'incarnation',$4::text,'count',0,'stale',0)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET updated_at=now()
    RETURNING COALESCE((completed_keys->0->>'count')::int,0) AS count`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:351-352 adjustSummary (SUMMARY_COUNTERS rendered) (at 8b80bd80ab)',
    case: { method: 'adjustGitHoldSummary', variant: 'default', run: e => e.adjustGitHoldSummary('default', '1', 1, { stale: 0, images: 0, fences: 0, concurrent: 0, stalled: 0, dirty: 0, drift: 0 }) },
    texts: () => {
      const pairs = ['stale', 'images', 'fences', 'concurrent', 'stalled', 'dirty', 'drift']
        .map((name, i) => `'${name}',GREATEST(0,COALESCE((completed_keys->0->>'${name}')::int,0)+$${i + 4}::int)`).join(',');
      return [`UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0)||jsonb_build_object(
      'count',GREATEST(0,COALESCE((completed_keys->0->>'count')::int,0)+$3::int),${pairs})),updated_at=now() WHERE op=$1 AND fingerprint=$2`];
    },
  },
  {
    from: 'src/core/persistence/sync-holds.ts:368 readRow (at 8b80bd80ab)',
    case: { method: 'readGitHoldRow', variant: 'default', run: e => e.readGitHoldRow('default', '1', 'a.md') },
    texts: ['SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:395 writeGitHold (at 8b80bd80ab)',
    case: { method: 'writeGitHoldRow', variant: 'default', run: e => e.writeGitHoldRow('default', '1', 'a.md', { path: 'a.md' }) },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:456 rewriteHoldMeta (at 8b80bd80ab)',
    case: { method: 'replaceGitHoldRow', variant: 'default', run: e => e.replaceGitHoldRow('default', '1', 'a.md', { path: 'a.md' }, { path: 'a.md', meta: {} }) },
    texts: [`UPDATE op_checkpoints SET completed_keys=$3::text::jsonb, updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND completed_keys=$4::text::jsonb RETURNING 1`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:482 clearGitHold (at 8b80bd80ab)',
    case: { method: 'deleteGitHoldRow', variant: 'default', run: e => e.deleteGitHoldRow('default', '1', 'a.md') },
    texts: ['DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:573 countGitHolds (at 8b80bd80ab)',
    case: { method: 'countGitHolds', variant: 'default', run: e => e.countGitHolds('default', '1') },
    texts: ["SELECT COALESCE((completed_keys->0->>'count')::int,0) AS count FROM op_checkpoints WHERE op=$1 AND fingerprint=$2"],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:598 readGitHoldListing (at 77ac0ed0e9)',
    case: { method: 'readGitHoldListingRows', variant: 'default', run: e => e.readGitHoldListingRows(['default'], 5) },
    texts: [`SELECT s.id AS source_id,
      s.incarnation::text AS incarnation, COALESCE((sm.completed_keys->0->>'count')::int,0) AS count, h.record
    FROM sources s
    JOIN op_checkpoints sm ON sm.op=$1 AND sm.fingerprint=s.id||':'||s.incarnation::text
    LEFT JOIN LATERAL (SELECT x.fingerprint, CASE WHEN COALESCE(s.config->>'mirror_read_only','false')='true' THEN jsonb_set(x.completed_keys->0,'{read_only_checkout}','true'::jsonb) ELSE x.completed_keys->0 END AS record FROM op_checkpoints x
      WHERE x.op=$2 AND x.completed_keys->0->>'source_id'=s.id AND x.completed_keys->0->>'incarnation'=s.incarnation::text
      ORDER BY x.fingerprint COLLATE "C" LIMIT $4) h ON true
    WHERE s.id=ANY($3::text[]) AND COALESCE((sm.completed_keys->0->>'count')::int,0)>0
    ORDER BY s.id COLLATE "C", h.fingerprint COLLATE "C"`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:620 readGitHoldCodeCounts (at 77ac0ed0e9)',
    case: { method: 'readGitHoldCodeCountRows', variant: 'default', run: e => e.readGitHoldCodeCountRows(['default']) },
    texts: [`SELECT s.id AS source_id, x.completed_keys->0->>'code' AS code, count(*) AS n
    FROM sources s JOIN op_checkpoints x ON x.op=$1 AND x.completed_keys->0->>'source_id'=s.id AND x.completed_keys->0->>'incarnation'=s.incarnation::text
    WHERE s.id=ANY($2::text[]) GROUP BY 1,2`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:562 readGitImageHoldCounts (at 77ac0ed0e9)',
    case: { method: 'readGitImageHoldCountRows', variant: 'default', run: e => e.readGitImageHoldCountRows(['default']) },
    texts: [`SELECT s.id AS source_id, COALESCE((h.completed_keys->0->>'images')::int,0) AS images
    FROM op_checkpoints h JOIN sources s ON h.fingerprint=s.id||':'||s.incarnation::text
    WHERE h.op=$1 AND s.id=ANY($2::text[]) AND COALESCE((h.completed_keys->0->>'images')::int,0)>0`],
  },
  {
    from: 'src/core/persistence/connector-state.ts:151 recordConnectorSyncAttempt (at 0eb4da776e)',
    case: { method: 'recordConnectorSyncAttempt', variant: 'default', rows: [[/^SELECT incarnation::text AS incarnation FROM sources/, [{ incarnation: '1' }]]],
      run: e => e.recordConnectorSyncAttempt('default', '2026-01-01T00:00:00.000Z', [{ version: 1 }]) },
    texts: ['SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', `INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_set(op_checkpoints.completed_keys, ARRAY['0','first_attempt_at'], to_jsonb($4::text), true), updated_at=now()
    WHERE op_checkpoints.completed_keys->0->>'first_attempt_at' IS NULL`],
  },
  {
    from: 'src/core/connectors/db-cursor.ts:37 writeConnectorDbCursor (at 0eb4da776e)',
    case: { method: 'writeConnectorDbCursor', variant: 'default', run: e => e.writeConnectorDbCursor('cursor-key', [{ version: 1, state: {}, last_run: null }]) },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array(jsonb_build_object('version',1,'state',EXCLUDED.completed_keys->0->'state',
      'last_run',COALESCE(EXCLUDED.completed_keys->0->'last_run',op_checkpoints.completed_keys->0->'last_run'))),updated_at=now()`],
  },
  {
    from: 'src/core/link-extraction.ts:1836 makeResolver resolveAttendance (at 34057d8e2f)',
    case: { method: 'listAttendanceMatches', variant: 'default', run: e => e.listAttendanceMatches('default', ['people/a'], 'A') },
    texts: [`SELECT slug FROM pages
        WHERE source_id=$1 AND deleted_at IS NULL AND type='person'
          AND (slug=ANY($2::text[]) OR lower(title)=lower($3)
            OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(frontmatter->'aliases')='array'
              THEN frontmatter->'aliases' ELSE '[]'::jsonb END) alias WHERE lower(alias)=lower($3))) LIMIT 2`],
  },
  {
    from: 'src/core/meetings/meetings-source.ts:297 existingPath (at 34057d8e2f)',
    case: { method: 'readMeetingPage', variant: 'default', run: e => e.readMeetingPage('default', 'm-1') },
    texts: [`SELECT slug,source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter->>'meeting_id'=$2 ORDER BY id LIMIT 1`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:1168 readSyncConversions (at 77ac0ed0e9)',
    case: { method: 'readSyncConversionRows', variant: 'default', run: e => e.readSyncConversionRows(['default']) },
    texts: [`SELECT s.id AS source_id, c.completed_keys->0->'conversions' AS conversions
    FROM sources s JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text WHERE s.id=ANY($2::text[])`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:1157 recordSyncConversion (at c03c5edfa2)',
    case: { method: 'recordSyncConversion', variant: 'default', run: e => e.recordSyncConversion('default', '1', { request_id: 'r1', path: null, slug: null, run_id: 'run-1', outcome: 'held', converted_at: '2026-01-01T00:00:00.000Z' }) },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('source_id',$3::text,'incarnation',$4::text,'conversions',$5::text::jsonb)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array((op_checkpoints.completed_keys->0)||jsonb_build_object('conversions',
      (SELECT COALESCE(jsonb_agg(c ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements($5::text::jsonb||COALESCE(op_checkpoints.completed_keys->0->'conversions','[]'::jsonb))
        WITH ORDINALITY AS e(c,n) WHERE n<=$6))),updated_at=now()`],
  },
  {
    from: 'src/core/persistence/sync-pass-row.ts:178 readPassRow (at 8b80bd80ab)',
    case: { method: 'readSyncPassRow', variant: 'default', run: e => e.readSyncPassRow('default', '1') },
    texts: ['SELECT completed_keys->0 AS value, updated_at, now() AS read_at FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    from: 'src/core/persistence/sync-pass-row.ts:185 readLivePassRows (at 8b80bd80ab)',
    case: { method: 'readLiveSyncPassRows', variant: 'default', run: e => e.readLiveSyncPassRows(null) },
    texts: [`SELECT s.id AS source_id, c.completed_keys->0 AS value, c.updated_at, now() AS read_at FROM sources s
       JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text
      WHERE ($2::text[] IS NULL OR s.id=ANY($2::text[]))`],
  },
  ...([
    ['default', {}, '$3::text::jsonb'],
    ['clock', { clock: true }, `jsonb_set($3::text::jsonb,'{telemetry,started_at}',to_jsonb(to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`],
  ] as const).map(([variant, opts, json]): Pin => ({
    from: 'src/core/persistence/sync-pass-row.ts:206 writePassRow (at 8b80bd80ab)',
    case: { method: 'writeSyncPassRow', variant, run: e => e.writeSyncPassRow('default', '1', { lease_token: 't' }, opts) },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,jsonb_build_array(${json}),now())
      ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()
        WHERE ($4::boolean OR op_checkpoints.completed_keys->0->>'lease_token'=$5) RETURNING 1`],
  })),
  {
    from: 'src/core/persistence/sync-pass-row.ts:204 writePassRow (onlyOpen) (at 8b80bd80ab)',
    case: { method: 'writeSyncPassRow', variant: 'only-open', run: e => e.writeSyncPassRow('default', '1', { lease_token: 't' }, { onlyOpen: true }) },
    texts: [`UPDATE op_checkpoints SET completed_keys=jsonb_build_array($3::text::jsonb), updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND ($4::boolean OR completed_keys->0->>'lease_token'=$5) AND completed_keys->0->'telemetry'->>'outcome'='open' RETURNING 1`],
  },
  {
    from: 'src/core/persistence/applied-watermark.ts:88,92 readWriteWatermark',
    case: { method: 'readWriteWatermarkRow', variant: 'default', run: e => e.readWriteWatermarkRow('default') },
    texts: [`SELECT s.last_commit, s.last_sync_at, p.pending_min, p.pending_count, p.pending_since
    FROM sources s LEFT JOIN LATERAL (SELECT min(r.sequence) AS pending_min, count(*) AS pending_count, min(r.created_at) AS pending_since FROM persistence_requests r
      WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.state IN ('queued','deferred','running','recovering')) p ON true WHERE s.id=$1`,
    'SELECT max(sequence) AS sequence FROM persistence_requests'],
  },
  {
    from: 'src/core/persistence/sync-movement.ts:159,160,163 readSourceMovement (at b7b18e5ab3)',
    case: { method: 'readSourceMovementRows', variant: 'default', run: e => e.readSourceMovementRows({ source_id: 'default', worktree_id: '00000000-0000-4000-8000-000000000001', source_incarnation: '00000000-0000-4000-8000-000000000002' }) },
    texts: [`SELECT
        (SELECT r.completed_at FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state='committed' AND r.source_incarnation=$2::uuid
           AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' ORDER BY r.completed_at DESC LIMIT 1) AS last_commit_at,
        (SELECT count(*) FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state IN ('queued','running') AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS admitted,
        (SELECT min(r.created_at) FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state IN ('queued','running') AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS admitted_since`,
      `SELECT request_id::text AS request_id, state, claim_phase, execution_token::text AS execution_token,
        (claim_expires_at IS NOT NULL AND claim_expires_at < now()) AS claim_lapsed, publication_started
      FROM persistence_requests WHERE worktree_id=$1::uuid AND state IN ('queued','running','recovering') ORDER BY (state <> 'running'), sequence LIMIT 1`,
      `SELECT (completed_keys->0->>'count')::int AS count, (completed_keys->0->>'stalled')::int AS stalled,
        (completed_keys->0->>'fences')::int AS fences, (completed_keys->0->>'concurrent')::int AS concurrent, updated_at
      FROM op_checkpoints WHERE op='sync-hold-summary' AND completed_keys->0->>'source_id'=$1 AND completed_keys->0->>'incarnation'=$2 LIMIT 1`],
  },
  {
    from: 'src/core/persistence/sync-movement.ts:133 liveSyncJob (at b7b18e5ab3)',
    case: { method: 'readLiveSyncJobId', variant: 'default', run: e => e.readLiveSyncJobId('default') },
    texts: [`SELECT id FROM minion_jobs WHERE name='sync' AND status='active' AND lock_until > now() AND queue <> 'gbrain-drain-lease'
    AND (COALESCE(data->>'sourceId', data->>'source_id')=$1 OR (COALESCE(data->>'sourceId', data->>'source_id') IS NULL
      AND (data->>'repoPath' IS NULL AND $1='default' OR data->>'repoPath'=(SELECT local_path FROM sources WHERE id=$1)))) ORDER BY started_at, id LIMIT 1`],
  },
  {
    from: 'src/core/persistence/applied-watermark.ts:104 readCheckoutRoot',
    case: { method: 'readSourceCheckoutRoot', variant: 'default', run: e => e.readSourceCheckoutRoot('default', null) },
    texts: [`SELECT s.incarnation::text AS incarnation,
      COALESCE((SELECT h.local_path FROM persistence_host_bindings h JOIN persistence_source_bindings b ON b.worktree_id=h.worktree_id
        WHERE b.source_id=s.id AND h.host_id::text=$2 LIMIT 1), s.local_path) AS root FROM sources s WHERE s.id=$1`],
  },
  {
    from: 'src/core/persistence/applied-watermark.ts:132 readAppliedWatermark',
    case: { method: 'readUnembeddedPageSummary', variant: 'default', run: e => e.readUnembeddedPageSummary('default', 'embedding') },
    texts: () => [`WITH w AS (SELECT DISTINCT p.id, p.updated_at FROM content_chunks cc
        JOIN pages p ON p.id=cc.page_id WHERE ${`cc.${quoteIdentifier('embedding')}`} IS NULL AND p.source_id=$1 AND p.deleted_at IS NULL AND ${chunkGenerationFilter('p', 'cc')}
          AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip'))
      SELECT count(*) AS pages, min(w.updated_at) AS oldest,
        (SELECT count(*) FROM w JOIN page_embedding_budget b ON b.page_id=w.id JOIN pages p ON p.id=w.id WHERE ${budgetRowAppliesFilter('b', 'p')}) AS held FROM w`],
  },
  {
    from: 'src/commands/access-serves.ts:186 member key plan (live token) (at 6e123afe98)',
    case: { method: 'readLiveAccessToken', variant: 'default', run: e => e.readLiveAccessToken('member-alice-example') },
    texts: ['SELECT member_id, token_hash, source_grant, source_id, federated_read, permissions FROM access_tokens WHERE name = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/commands/access-serves.ts:197 member key plan (active sources) (at 6e123afe98)',
    case: { method: 'filterUnarchivedSourceIds', variant: 'default', run: e => e.filterUnarchivedSourceIds(['src-a', 'src-b']) },
    texts: ['SELECT id FROM sources WHERE id = ANY($1::text[]) AND archived IS NOT TRUE'],
  },
  {
    from: 'src/commands/access-serves.ts:241 recordSetupReads (at 6e123afe98)',
    case: { method: 'recordTokenSetupReads', variant: 'default', run: e => e.recordTokenSetupReads('member-alice-example', ['src-a']) },
    texts: ["UPDATE access_tokens SET permissions = COALESCE(permissions, '{}'::jsonb) || jsonb_build_object('setup_reads', $2::text[]) WHERE name = $1 AND revoked_at IS NULL AND (permissions IS NULL OR jsonb_typeof(permissions) = 'object')"],
  },
  {
    from: 'src/commands/access-serves.ts:265 companyCounts (at 6e123afe98)',
    case: { method: 'countCompanyPages', variant: 'default', run: e => e.countCompanyPages('company') },
    texts: ["SELECT count(*)::int AS pages, count(*) FILTER (WHERE slug LIKE 'company/calls/%')::int AS calls FROM pages WHERE source_id = $1 AND deleted_at IS NULL"],
  },
  {
    from: 'src/commands/access-serves.ts:339 serves key mint (revoke on a failed key file) (at 6e123afe98)',
    case: { method: 'revokeAccessTokenById', variant: 'default', run: e => e.revokeAccessTokenById('00000000-0000-0000-0000-000000000001') },
    texts: ['UPDATE access_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/access/policy-migrate.ts:41 unfinished (at 6e123afe98)',
    case: { method: 'readUnfinishedAccessMigration', variant: 'default', run: e => e.readUnfinishedAccessMigration('src-a') },
    texts: ["SELECT id, phase, direction, receipts FROM access_policy_migrations WHERE source_id = $1 AND phase <> 'switched' ORDER BY created_at DESC LIMIT 1"],
  },
  {
    from: 'src/core/access/policy-migrate.ts:80 migratePolicyStore (start) (at 6e123afe98)',
    case: { method: 'insertAccessMigration', variant: 'default', run: e => e.insertAccessMigration('mig_1', 'src-a', 'to_git') },
    texts: ["INSERT INTO access_policy_migrations (id, source_id, direction, phase) VALUES ($1, $2, $3, 'started')"],
  },
  {
    from: 'src/core/access/policy-migrate.ts:85 migratePolicyStore (record a phase) (at 6e123afe98)',
    case: { method: 'recordAccessMigrationPhase', variant: 'default', run: e => e.recordAccessMigrationPhase('mig_1', 'exported', { approved: 'abc' }) },
    texts: ['UPDATE access_policy_migrations SET phase = $2, receipts = $3::text::jsonb, updated_at = now() WHERE id = $1'],
  },
  {
    from: 'src/core/access/policy-migrate.ts:104 migratePolicyStore (switch) (at 6e123afe98)',
    case: { method: 'switchAccessMigration', variant: 'default', run: e => e.switchAccessMigration('mig_1', { approved: 'abc' }) },
    texts: ["UPDATE access_policy_migrations SET phase = 'switched', receipts = $2::text::jsonb, updated_at = now() WHERE id = $1"],
  },
  {
    from: 'src/core/source-health.ts:384 pageCountsBySource (at cd882f06e6)',
    case: { method: 'countLivePagesBySource', variant: 'default', run: e => e.countLivePagesBySource() },
    texts: [`SELECT source_id, COUNT(*)::int AS n
       FROM pages
      WHERE deleted_at IS NULL
      GROUP BY source_id`],
  },
  {
    from: 'src/core/source-health.ts:403 chunkCountsBySource (at cd882f06e6)',
    case: { method: 'countChunksBySource', variant: 'default', run: e => e.countChunksBySource('embedding') },
    texts: [`SELECT p.source_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE c."embedding" IS NOT NULL)::int AS embedded
       FROM content_chunks c
       JOIN pages p ON p.id = c.page_id
      WHERE p.deleted_at IS NULL
      GROUP BY p.source_id`],
  },
  {
    from: 'src/commands/extract.ts:497 loadSlugAliasTargets (at a18d118d27)',
    case: { method: 'listSlugAliases', variant: 'default', run: e => e.listSlugAliases('default') },
    texts: ['SELECT alias_slug, canonical_slug FROM slug_aliases WHERE source_id = $1'],
  },
  {
    from: 'src/core/persistence/links-preparation.ts:29 liveSlugAliases (at 0af1a6ecf0)',
    case: { method: 'readLiveSlugAliases', variant: 'default', run: e => e.readLiveSlugAliases('default', ['a', 'b']) },
    texts: [`SELECT a.alias_slug, a.canonical_slug FROM slug_aliases a
      WHERE a.source_id=$1 AND a.alias_slug IN (SELECT unnest($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=a.alias_slug AND p.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM pages c WHERE c.source_id=a.source_id AND c.slug=a.canonical_slug AND c.deleted_at IS NULL)`],
  },
  {
    // An equivalent statement: links-preparation.ts:46/55 (at 0af1a6ecf0) sent the fingerprint with the slugs above the
    // known max id, or the fingerprint with every slug; this one statement answers both (afterId 0 lists every slug).
    from: 'src/core/persistence/links-preparation.ts:46 refreshSourceSlugIndex (at 0af1a6ecf0)',
    case: { method: 'readSourceSlugProbe', variant: 'default', run: e => e.readSourceSlugProbe('default', 0) },
    texts: [`SELECT
      count(*)::int AS n, coalesce(sum(hashtextextended(slug, 0)), 0)::text AS h, coalesce(max(id), 0)::int AS m,
      coalesce(array_agg(slug) FILTER (WHERE id > $2), '{}') AS added,
      coalesce(sum(hashtextextended(slug, 0)) FILTER (WHERE id > $2), 0)::text AS added_h
      FROM pages WHERE source_id=$1`],
  },
  {
    from: 'src/core/ops/slug-params.ts:203 storedSpellings, unscoped (at a59ee3ca58)',
    case: { method: 'readStoredSlugSpellings', variant: 'unscoped', run: e => e.readStoredSlugSpellings('notesab', {}, '') },
    texts: [`SELECT DISTINCT slug COLLATE "C" AS s FROM pages WHERE regexp_replace(normalize(translate(replace(replace(slug, chr(304), 'i' || chr(775)), chr(8490), 'k'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), NFC), '[^a-z0-9]', '', 'g') = $1  AND slug COLLATE "C" > $2 ORDER BY s LIMIT 200`],
  },
  {
    from: 'src/core/ops/slug-params.ts:203 storedSpellings, source (at a59ee3ca58)',
    case: { method: 'readStoredSlugSpellings', variant: 'source', run: e => e.readStoredSlugSpellings('notesab', { sourceId: 'default' }, '') },
    texts: [`SELECT DISTINCT slug COLLATE "C" AS s FROM pages WHERE regexp_replace(normalize(translate(replace(replace(slug, chr(304), 'i' || chr(775)), chr(8490), 'k'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), NFC), '[^a-z0-9]', '', 'g') = $1 AND source_id = $2 AND slug COLLATE "C" > $3 ORDER BY s LIMIT 200`],
  },
  {
    from: 'src/core/ops/slug-params.ts:203 storedSpellings, sources (at a59ee3ca58)',
    case: { method: 'readStoredSlugSpellings', variant: 'sources', run: e => e.readStoredSlugSpellings('notesab', { sourceIds: ['default'] }, 'notes/a') },
    texts: [`SELECT DISTINCT slug COLLATE "C" AS s FROM pages WHERE regexp_replace(normalize(translate(replace(replace(slug, chr(304), 'i' || chr(775)), chr(8490), 'k'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), NFC), '[^a-z0-9]', '', 'g') = $1 AND source_id = ANY($2::text[]) AND slug COLLATE "C" > $3 ORDER BY s LIMIT 200`],
  },
  {
    from: 'src/core/repair/slug-spelling-guards.ts:43 rowSecurityTables (at f9592f7a7e)',
    case: { method: 'readRowSecurityTables', variant: 'default', run: e => e.readRowSecurityTables(['pages']) },
    texts: ['SELECT t FROM unnest($1::text[]) AS t WHERE pg_catalog.row_security_active(t) ORDER BY t'],
  },
  {
    from: 'src/core/repair/slug-spelling.ts:301 countSlugSpellings (at f9592f7a7e; LIMIT ${BATCH} rendered, BATCH 5_000)',
    case: { method: 'listSlugSpellingCandidates', variant: 'default', run: e => e.listSlugSpellingCandidates(0) },
    texts: [`SELECT id, source_id, slug FROM pages
      WHERE id > $1 AND (slug <> lower(slug) OR slug ~ '[^ -~]') ORDER BY id LIMIT 5000`],
  },
  {
    from: 'src/core/slug-spelling-key.ts:36 serverEncoding (at f9592f7a7e)',
    case: { method: 'readServerEncoding', variant: 'default', run: e => e.readServerEncoding() },
    texts: ['SHOW server_encoding'],
  },
  {
    from: 'src/core/repair/slug-spelling-guards.ts:34 rowSecurityBrainTables (at f9592f7a7e)',
    case: { method: 'readRowSecurityBrainTables', variant: 'default', run: e => e.readRowSecurityBrainTables() },
    texts: [`SELECT c.relname::text AS t FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY(pg_catalog.current_schemas(false)) AND c.relkind IN ('r', 'p') AND pg_catalog.row_security_active(c.oid) ORDER BY 1`],
  },
  {
    from: 'src/core/repair/slug-spelling.ts:239 and :459 SOURCE_SQL (at f9592f7a7e)',
    case: { method: 'readSlugRepairSource', variant: 'default', run: e => e.readSlugRepairSource('default') },
    texts: ["SELECT local_path, incarnation::text AS incarnation, CASE WHEN config->>'slug_root_mode' IN ('git-root', 'source-root') THEN config->>'slug_root_mode' END AS slug_root_mode FROM sources WHERE id=$1"],
  },
  {
    from: 'src/core/repair/slug-spelling.ts:245 scanSlugSpellings (at f9592f7a7e; LIMIT ${BATCH} rendered, BATCH 5_000)',
    case: { method: 'listSourceSlugSpellingCandidates', variant: 'default', run: e => e.listSourceSlugSpellingCandidates('default', 0) },
    texts: [`SELECT id, slug, knowledge_revision::text AS revision, source_path, deleted_at IS NOT NULL AS deleted FROM pages
      WHERE source_id=$1 AND id > $2 AND (slug <> lower(slug) OR slug ~ '[^ -~]') ORDER BY id LIMIT 5000`],
  },
  {
    from: 'src/core/repair/slug-spelling.ts:290 samePrintedName, index keys (at f9592f7a7e)',
    case: { method: 'readSpellingKeyPages', variant: 'keys', run: e => e.readSpellingKeyPages('default', ['notes/caf\u00e9'], 'notescaf', 0) },
    texts: [`SELECT id, slug FROM pages WHERE normalize(translate(replace(replace(slug, chr(304), 'i' || chr(775)), chr(8490), 'k'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), NFC) = ANY($1::text[]) AND source_id = $2 AND id <> $3 ORDER BY id`],
  },
  {
    from: 'src/core/repair/slug-spelling.ts:290 samePrintedName, scan key (at f9592f7a7e)',
    case: { method: 'readSpellingKeyPages', variant: 'scan', run: e => e.readSpellingKeyPages('default', null, 'notescaf', 0) },
    texts: [`SELECT id, slug FROM pages WHERE regexp_replace(normalize(translate(replace(replace(slug, chr(304), 'i' || chr(775)), chr(8490), 'k'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), NFC), '[^a-z0-9]', '', 'g') = $1 AND source_id = $2 AND id <> $3 ORDER BY id`],
  },
  {
    from: 'src/core/repair/slug-spelling.ts:402 plan re-check (at f9592f7a7e)',
    case: { method: 'readPageSlugInSource', variant: 'default', run: e => e.readPageSlugInSource(1, 'default') },
    texts: ['SELECT slug FROM pages WHERE id=$1 AND source_id=$2'],
  },
  {
    from: 'src/core/repair/slug-spelling.ts:461 movePageUnderStoredSlug page re-read (at f9592f7a7e)',
    case: { method: 'readSlugRepairPage', variant: 'default', run: e => e.readSlugRepairPage(1, 'default') },
    texts: ['SELECT id, slug, knowledge_revision::text AS revision, source_path, deleted_at IS NOT NULL AS deleted FROM pages WHERE id=$1 AND source_id=$2'],
  },
  {
    from: 'src/core/access/federation-exposure.ts:32 remotePagesFederationExposes, privacy part on (at 0af1a6ecf0)',
    case: { method: 'readFederationExposedPages', variant: 'hidden', run: e => e.readFederationExposedPages('default', true) },
    texts: () => { const hidden = ` AND ${privacyPartSql('p')}`; return [`WITH open AS (SELECT p.id, p.slug, p.revision_principal_kind, p.revision_principal_id FROM pages p
       WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.page_readers IS NULL AND p.folder_rule_ids IS NULL${hidden}),
     authored AS (
       SELECT slug, revision_principal_kind AS kind, revision_principal_id AS pid FROM open
       UNION ALL
       SELECT o.slug, v.write_principal_kind, v.write_principal_id FROM open o JOIN page_versions v ON v.page_id = o.id)
     SELECT a.slug, min(coalesce(t.member_id, c.member_id)) AS member, (count(*) OVER ())::int AS total
       FROM authored a
       LEFT JOIN access_tokens t ON a.kind = 'legacy_token' AND t.id::text = a.pid
       LEFT JOIN oauth_clients c ON a.kind = 'oauth_client' AND c.client_id = a.pid
      WHERE a.kind IN ('legacy_token', 'oauth_client')
      GROUP BY a.slug ORDER BY a.slug LIMIT 5`]; },
  },
  {
    from: 'src/core/access/federation-exposure.ts:32 remotePagesFederationExposes, privacy relaxed (at 0af1a6ecf0)',
    case: { method: 'readFederationExposedPages', variant: 'relaxed', run: e => e.readFederationExposedPages('default', false) },
    texts: () => { const hidden = ''; return [`WITH open AS (SELECT p.id, p.slug, p.revision_principal_kind, p.revision_principal_id FROM pages p
       WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.page_readers IS NULL AND p.folder_rule_ids IS NULL${hidden}),
     authored AS (
       SELECT slug, revision_principal_kind AS kind, revision_principal_id AS pid FROM open
       UNION ALL
       SELECT o.slug, v.write_principal_kind, v.write_principal_id FROM open o JOIN page_versions v ON v.page_id = o.id)
     SELECT a.slug, min(coalesce(t.member_id, c.member_id)) AS member, (count(*) OVER ())::int AS total
       FROM authored a
       LEFT JOIN access_tokens t ON a.kind = 'legacy_token' AND t.id::text = a.pid
       LEFT JOIN oauth_clients c ON a.kind = 'oauth_client' AND c.client_id = a.pid
      WHERE a.kind IN ('legacy_token', 'oauth_client')
      GROUP BY a.slug ORDER BY a.slug LIMIT 5`]; },
  },
  {
    from: 'src/core/quarantine.ts:116 quarantinedSlugs (at 90ede8f55a)',
    case: { method: 'listQuarantinedSlugs', variant: 'default', run: e => e.listQuarantinedSlugs('default') },
    texts: [`SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND NOT NOT (COALESCE(pages.frontmatter, '{}'::jsonb) ? 'quarantine')`],
  },
  {
    from: 'src/core/trust/timeline-projection.ts:22 pageInputs (at 1a12510b10)',
    case: { method: 'listPageTrustTiersByKey', variant: 'default', run: e => e.listPageTrustTiersByKey([{ source_id: 'default', slug: 'a' }]) },
    texts: [`SELECT p.id,p.source_id,p.slug,p.trust_tier FROM pages p
      JOIN jsonb_to_recordset($1::text::jsonb) AS r(source_id text,slug text) ON p.source_id=r.source_id AND p.slug=r.slug`],
  },
  {
    from: 'src/core/trust/timeline-projection.ts:59 addProjectedTimelineBatch requirePages (at 1a12510b10)',
    case: { method: 'lockLivePagesByKey', variant: 'default', run: e => e.lockLivePagesByKey([{ source_id: 'default', slug: 'a' }]) },
    texts: [`SELECT p.source_id,p.slug FROM pages p
          JOIN jsonb_to_recordset($1::text::jsonb) AS r(source_id text,slug text) ON p.source_id=r.source_id AND p.slug=r.slug
          WHERE p.deleted_at IS NULL FOR SHARE OF p`],
  },
  {
    from: 'src/core/facts/writeback-audience.ts:82 classifyBrainAudience (the credential binding read, at b7b18e5ab3)',
    case: { method: 'listCredentialMemberBindings', variant: 'default', run: e => e.listCredentialMemberBindings(['alice-laptop', 'alice-agent']) },
    texts: [`SELECT name, member_id FROM access_tokens WHERE name = ANY($1::text[]) AND revoked_at IS NULL
       UNION ALL SELECT client_id AS name, member_id FROM oauth_clients WHERE client_id = ANY($1::text[]) AND deleted_at IS NULL`],
  },
  {
    from: 'src/core/search/facts-arm.ts:417 applyFactSourcePages (the fact source page read, at b7b18e5ab3)',
    case: { method: 'listFactSourcePages', variant: 'default', run: e => e.listFactSourcePages([1, 2]) },
    texts: [`SELECT f.id, p.id AS page_id, p.slug, p.title, p.type FROM facts f
       JOIN pages p ON p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND p.deleted_at IS NULL
       WHERE f.id = ANY($1::bigint[]) AND f.source_markdown_slug IS DISTINCT FROM f.entity_slug`],
  },
  {
    from: 'src/core/link-reconciliation.ts:229 fileLinkOwnership attendance origins (at 90ede8f55a)',
    case: { method: 'listAttendedOriginSlugs', variant: 'default', run: e => e.listAttendedOriginSlugs('default') },
    texts: [`SELECT DISTINCT o.slug FROM links l
    JOIN pages o ON o.id=l.origin_page_id WHERE o.source_id=$1 AND l.link_source IN ('markdown','wikilink-resolved','frontmatter')
      AND l.link_type='attended' AND l.to_page_id=l.origin_page_id`],
  },
  {
    from: 'src/core/sync-pending.ts:106 readFirstDue (at 4e39797ed0)',
    case: { method: 'readFirstDue', variant: 'default', run: e => e.readFirstDue(['default']) },
    texts: [`SELECT s.id AS source_id, n.observed_head,
              LEAST(CASE WHEN n.state <> 'idle' THEN n.first_due_at END,
                    (SELECT min(m.first_due_at) FROM sync_wanted_markers m WHERE m.source_id = s.id AND m.intent = 'freshness'
                       AND m.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
                       AND (m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit))) AS first_due_at
         FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id AND n.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
        WHERE s.id = ANY($1::text[])`],
  },
  {
    from: 'src/core/persistence/sync-status.ts:297 cursorHeader (at 21cd64e151)',
    case: { method: 'readManagedSyncCursorHeader', variant: 'default', run: e => e.readManagedSyncCursorHeader('default', '1', 'k') },
    texts: [`SELECT completed_keys->0 AS header, fingerprint AS key FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'=$2
      ORDER BY (fingerprint=$3) DESC, updated_at DESC LIMIT 1`],
  },
  {
    from: 'src/core/persistence/sync-status.ts:304 retiredCursorStands (at 21cd64e151)',
    case: { method: 'readRetiredManagedSyncCursor', variant: 'default', run: e => e.readRetiredManagedSyncCursor('default', '1') },
    texts: [`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_seen FROM op_checkpoints
    WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'<>$2 AND COALESCE(completed_keys->0->>'done','false')<>'true' ORDER BY updated_at LIMIT 1`],
  },
  {
    from: 'src/core/persistence/sync-status.ts:364 readSyncStatus (source row) (at 21cd64e151, with the Apple Contacts review columns main adds at c9e289dbed)',
    case: { method: 'readSyncStatusSourceRow', variant: 'default', run: e => e.readSyncStatusSourceRow('default') },
    texts: () => {
      const admissionSql = syncAdmissionSettingSql(4);
      return [`SELECT s.incarnation::text AS incarnation, s.last_commit, s.last_sync_at, EXISTS (SELECT 1 FROM gbrain_cycle_locks l WHERE l.id=$7) AS drain_lock,
      p.completed_keys->0 AS pass_value, p.updated_at AS pass_updated_at, now() AS pass_read_at, w.completed_keys->0 AS withheld, ${admissionSql.columns}, ${syncAdmissionEffectSql(7, 's')},
      (SELECT r.request_id::text FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='git' AND e.state='failed' AND NOT (e.data ? 'settled')
        AND e.request_id IN (SELECT id::uuid FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.completed_keys->0->'obligations'->'converged'->'writeback')='array'
          THEN p.completed_keys->0->'obligations'->'converged'->'writeback' ELSE '[]'::jsonb END) AS w(id)) ORDER BY e.id LIMIT 1) AS writeback_failed,
      (SELECT row_to_json(f) FROM (SELECT r.id,r.worktree_id,r.state,r.source_ids,r.outcome,r.old_head,r.target_head,r.barrier_sequence,r.updated_at,w.owner_host_id FROM persistence_worktree_refreshes r
        LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id WHERE s.id=ANY(r.source_ids) AND r.state IN ${ACTIVE_REFRESH_STATES_SQL} LIMIT 1) f) AS refresh,
      (SELECT ir.completed_keys FROM op_checkpoints ir WHERE ir.op='${APPLE_CONTACTS_REVIEW_OP}' AND ir.fingerprint=s.id) AS identity_reviews,
      (SELECT hd.completed_keys FROM op_checkpoints hd WHERE hd.op='${APPLE_CONTACTS_PENDING_DELETES_OP}' AND hd.fingerprint=s.id) AS held_deletes, s.config FROM sources s
      LEFT JOIN op_checkpoints p ON p.op=$2 AND p.fingerprint=s.id||':'||s.incarnation::text
      LEFT JOIN op_checkpoints w ON w.op=$3 AND w.fingerprint=s.id||':'||s.incarnation::text
      ${admissionSql.joins}
      WHERE s.id=$1 AND s.archived IS NOT TRUE`];
    },
  },
  {
    from: 'src/core/persistence/sync-status.ts:380 readSyncStatus (committed row) (at 21cd64e151)',
    case: { method: 'readSyncStatusCommittedRow', variant: 'default', run: e => e.readSyncStatusCommittedRow('default') },
    texts: () => [`SELECT count(*) AS n, EXISTS (SELECT 1 FROM persistence_effects e
      WHERE e.source_id=$1 AND e.kind='git' AND e.state IN ('queued','running','failed') AND e.error_code IN ('targets_parked', ${GIT_PUSH_CODES.map(code => `'${code}'`).join(',')})
        AND NOT (e.data ? 'settled')) AS git_push_held,
      EXISTS (SELECT 1 FROM derived_generations g WHERE g.source_id=$1 AND g.kind IN ('fact_fence','take_fence') AND g.state='held') AS fence_held,
      (SELECT max(r.completed_at) FROM persistence_source_bindings b JOIN persistence_requests r ON r.worktree_id=b.worktree_id AND r.source_incarnation=b.source_incarnation
        WHERE b.source_id=$1 AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS last_committed_at
    FROM persistence_requests WHERE source_id=$1 AND state='committed'
    AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND completed_at > now() - interval '10 minutes'`],
  },
  {
    from: 'src/core/persistence/sync-status.ts:589 recoveryProbe (at 21cd64e151)',
    case: { method: 'readSyncRecoveryProbeRow', variant: 'default', run: e => e.readSyncRecoveryProbeRow('default', { timeoutMs: 2_000 }) },
    // The `timeoutMs` option wraps the statement in the engine's statement-timeout transaction, as the caller's executeRaw did.
    texts: ['BEGIN READ WRITE; SET LOCAL statement_timeout = 2000', `SELECT (SELECT count(*) FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL) AS n, f.request_id::text AS request_id, f.slug,
         f.blocked_reason IN ('unexpected_staging_bytes','unexpected_file_bytes') AS blocked
       FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT request_id, slug, blocked_reason FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL ORDER BY sequence LIMIT 1) f ON true`, 'COMMIT'],
  },
  {
    from: 'src/core/persistence/sync-failures.ts:171 readManagedSyncFailures (at 21cd64e151)',
    case: { method: 'readManagedSyncFailureRows', variant: 'default', run: e => e.readManagedSyncFailureRows(['default']) },
    texts: [`
    SELECT c.fingerprint AS cursor_key,jsonb_build_object('sourceId',s.id,'incarnation',s.incarnation,'runId',c.completed_keys->0->>'runId',
      'index',c.completed_keys->0->'index','target',c.completed_keys->0->>'target',
      'syncOptions',c.completed_keys->0->'syncOptions','processingOptions',c.completed_keys->0->'processingOptions',
      'pending',jsonb_build_object('requestId',c.completed_keys->0->'pending'->>'requestId')) AS value,
      CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('state',r.state,'request_id',r.request_id,'error_code',r.error_code,'error_message',r.error_message,'error_detail',r.error_detail) END AS receipt,
      f.completed_keys->0 AS failure,m.completed_keys->((c.completed_keys->0->>'index')::int)->>'path' AS path,c.updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text=c.completed_keys->0->>'incarnation'
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
      AND r.principal_id=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
      AND r.principal_kind=c.completed_keys->0->'authority'->'writer'->'principal'->>'kind'
    LEFT JOIN op_checkpoints f ON f.op='managed-sync-failure' AND f.fingerprint=c.fingerprint
    LEFT JOIN op_checkpoints m ON m.op='managed-sync-manifest' AND m.fingerprint=c.completed_keys->0->>'runId'
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))`],
  },
  {
    from: 'src/core/persistence/sync-failures.ts:202 readManagedSyncFailures (orphaned failures) (at 21cd64e151)',
    case: { method: 'readOrphanedManagedSyncFailureRows', variant: 'default', run: e => e.readOrphanedManagedSyncFailureRows(null) },
    texts: [`
    SELECT f.completed_keys->0 AS failure FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text=f.completed_keys->0->>'source_incarnation'
    WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint)`],
  },
  {
    from: 'src/core/persistence/sync-drain.ts:807 engineStallProbe head (at 21cd64e151)',
    case: { method: 'readSyncHeadRequestRow', variant: 'default', run: e => e.readSyncHeadRequestRow('default', { timeoutMs: 2_000 }) },
    // The `timeoutMs` option wraps the statement in the engine's statement-timeout transaction, as the caller's executeRaw did.
    texts: ['BEGIN READ WRITE; SET LOCAL statement_timeout = 2000', `SELECT h.state AS head_state, h.id::text AS head_request_id, h.request_id::text AS head_write_request_id, h.claim_phase AS head_claim_phase, h.execution_token::text AS head_token,
           (h.claim_expires_at IS NOT NULL AND h.claim_expires_at < now()) AS head_lapsed, h.intent->>'kind' AS head_kind
         FROM persistence_source_bindings b
         JOIN sources s ON s.id = b.source_id AND s.incarnation = b.source_incarnation
         JOIN LATERAL (SELECT e.id, e.request_id, e.state, e.claim_phase, e.execution_token, e.claim_expires_at, e.intent FROM persistence_requests e
           WHERE e.worktree_id = b.worktree_id AND e.state IN ('queued','running','recovering') ORDER BY (e.state <> 'running'), e.sequence LIMIT 1) h ON true
         WHERE b.source_id = $1`, 'COMMIT'],
  },
  {
    from: 'src/core/sync-identity-downgrades.ts:114 listIdentityDowngrades (at 21cd64e151)',
    case: { method: 'readIdentityDowngradeRows', variant: 'default', run: e => e.readIdentityDowngradeRows(['default']) },
    texts: () => [`SELECT dg.completed_keys->0 AS record, np.slugs AS new_slugs FROM op_checkpoints dg JOIN pages p ON p.id::text = dg.fingerprint
      LEFT JOIN LATERAL (SELECT array_agg(slug ORDER BY slug) AS slugs FROM pages WHERE source_id = p.source_id AND deleted_at IS NULL AND source_path = dg.completed_keys->0->>'to') np ON true
      WHERE dg.op = $1 AND p.deleted_at IS NOT NULL AND ${identityDowngradeOpen('p')}
        AND p.source_id = dg.completed_keys->0->>'source_id' AND ($2::text[] IS NULL OR p.source_id = ANY($2::text[]))
      ORDER BY dg.completed_keys->0->>'recorded_at', dg.fingerprint`],
  },
  {
    from: 'src/core/chronicle/ledger.ts:134 upsertChronicleRow, at dded7edc51',
    case: { method: 'upsertChronicleRow', variant: 'default', run: e => e.upsertChronicleRow({ sourceId: 'default', pageId: 1, contentHash: 'h', extractorVersion: 2, slug: 'p', state: 'skipped', reason: 'r', trigger: 'auto', principalKind: null, principalId: null, requestId: null, noExtract: false, nextAttemptAt: null }) },
    texts: [`INSERT INTO chronicle_page_state AS c (source_id, page_id, content_hash, extractor_version, slug, state, reason, trigger,
       principal_kind, principal_id, request_id, no_extract, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12, $13::timestamptz)
     ON CONFLICT (source_id, page_id, content_hash, extractor_version) DO UPDATE SET
       slug=EXCLUDED.slug, state=EXCLUDED.state, reason=EXCLUDED.reason, trigger=EXCLUDED.trigger,
       principal_kind=EXCLUDED.principal_kind, principal_id=EXCLUDED.principal_id, request_id=EXCLUDED.request_id,
       no_extract=EXCLUDED.no_extract, next_attempt_at=EXCLUDED.next_attempt_at, decided_at=now(), updated_at=now(),
       campaign_id=NULL, attempt_cap_usd=NULL, max_attempts=NULL, pricing_policy=NULL, campaign_max_usd=NULL
     WHERE NOT (EXCLUDED.trigger='auto' AND c.trigger='backfill' AND c.state IN ('pending','failed'))
       AND (c.state <> 'extracted' OR EXISTS (SELECT 1 FROM chronicle_page_state newer
         WHERE newer.source_id=c.source_id AND newer.page_id=c.page_id AND newer.content_hash<>c.content_hash
           AND newer.state='extracted' AND newer.updated_at > c.updated_at))
     RETURNING page_id`],
  },
  // The write-time chronicle decision's other statements (engine-sql/chronicle-ledger.ts), from ledger.ts at ac7d551949.
  {
    from: 'src/core/chronicle/ledger.ts:219 readChronicleRow, at ac7d551949',
    case: { method: 'readChronicleRow', variant: 'default', run: e => e.readChronicleRow({ sourceId: 'default', pageId: 1, contentHash: 'h', extractorVersion: 2 }) },
    texts: ['SELECT * FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4'],
  },
  {
    from: 'src/core/chronicle/ledger.ts:181 recordChronicleDecision (the add_link pending read), at ac7d551949',
    case: { method: 'hasPendingAutoChronicleRow', variant: 'default', run: e => e.hasPendingAutoChronicleRow('default', 1, 2) },
    texts: [`SELECT 1 FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND state='pending'
      AND trigger='auto' AND no_extract=false AND extractor_version=$3 LIMIT 1`],
  },
  {
    from: 'src/core/chronicle/ledger.ts:84 chronicleDailyRemaining, at ac7d551949',
    case: { method: 'countRecentChronicleReservations', variant: 'default', run: e => e.countRecentChronicleReservations() },
    texts: ["SELECT count(*) AS n FROM chronicle_judge_reservations WHERE reserved_at > now() - interval '24 hours'"],
  },
  {
    from: 'src/core/chronicle/ledger.ts:92 reserveChronicleSlot, at e4420913f5',
    case: { method: 'reserveChronicleJudgeSlot', variant: 'default', run: e => e.reserveChronicleJudgeSlot(2, { sourceId: 'default', pageId: 1, contentHash: 'h' }) },
    texts: ["SELECT pg_advisory_xact_lock(hashtext('gbrain:chronicle:daily_reservation'))",
      "SELECT count(*) AS n FROM chronicle_judge_reservations WHERE reserved_at > now() - interval '24 hours'",
      'INSERT INTO chronicle_judge_reservations (source_id, page_id, content_hash) VALUES ($1, $2, $3)'],
  },
  {
    from: 'src/core/chronicle/ledger.ts:107 pruneChronicleReservations, at e4420913f5',
    case: { method: 'pruneChronicleReservations', variant: 'default', run: e => e.pruneChronicleReservations() },
    texts: ["DELETE FROM chronicle_judge_reservations WHERE reserved_at < now() - interval '48 hours'"],
  },
  {
    from: 'src/core/chronicle/ledger.ts:195 recordChronicleDecision (the activation insert), at ac7d551949',
    case: { method: 'insertConfigIfAbsent', variant: 'default', run: e => e.insertConfigIfAbsent('chronicle.activated_at', '2026-01-01T00:00:00.000Z') },
    texts: ['INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING'],
  },
  {
    from: 'src/core/chronicle/ledger.ts:201 recordChronicleDecision (the truth-lead read), at ac7d551949',
    case: { method: 'readPageTruthLead', variant: 'default', run: e => e.readPageTruthLead(1) },
    texts: ['SELECT truth_lead FROM pages WHERE id=$1'],
  },
  // The reads a page write makes before admission (engine-sql/page-mutation-reads.ts), from page-mutations.ts at e4420913f5.
  {
    from: 'src/core/persistence/page-mutations.ts:350 unquotedPutContent, at e4420913f5',
    case: { method: 'readStoredPageHead', variant: 'default', run: e => e.readStoredPageHead('default', 'notes/a') },
    texts: ['SELECT type, trust_tier, title, frontmatter FROM pages WHERE source_id = $1 AND slug = $2'],
  },
  {
    from: 'src/core/persistence/page-mutations.ts:585 preparePageAdmission (a revert\'s version file), at e4420913f5',
    case: { method: 'readVersionSourcePath', variant: 'default', run: e => e.readVersionSourcePath(1, 1) },
    texts: ['SELECT source_path FROM page_versions WHERE id=$1 AND page_id=$2'],
  },
  // get_page's chunk reads (engine-sql/page-window-chunks.ts), copied from get-page-body.ts at f9592f7a7e with the
  // generation probe in its manifest form (chunkGenerationProbe('content_chunks', true)).
  {
    from: 'src/core/ops/get-page-body.ts:338 aroundChunk, at f9592f7a7e',
    case: { method: 'readWindowChunk', variant: 'default', run: e => e.readWindowChunk(1, 1) },
    texts: [CHUNK_MANIFEST_ACCESS, `SELECT chunk_text, chunk_source, occurrence_id, projected_byte_start, projected_byte_end FROM content_chunks
      WHERE id = $1 AND page_id = $2 AND COALESCE(modality, 'text') = 'text' AND ${GET_PAGE_GENERATION_PROBE}`],
  },
  {
    from: 'src/core/ops/get-page-body.ts:514 noneResult, at f9592f7a7e',
    case: { method: 'countPageChunks', variant: 'default', run: e => e.countPageChunks(1) },
    texts: [CHUNK_MANIFEST_ACCESS, `SELECT count(*) AS total, count(*) FILTER (WHERE embedded_at IS NOT NULL) AS embedded FROM content_chunks
      WHERE page_id = $1 AND ${GET_PAGE_GENERATION_PROBE}`],
  },
  {
    from: 'src/core/persistence/intent-redaction.ts:248 cancelRequestsHoldingStagings (at b220b0df91)',
    case: { method: 'lockWriteRequestsById', variant: 'default', run: e => e.lockWriteRequestsById(['b0000000-0000-4000-8000-0000000000d1']) },
    texts: ['SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE'],
  },
  {
    from: 'src/core/persistence/journal.ts:1068 finishTerminal (at b220b0df91)',
    case: { method: 'compactTerminalIntent', variant: 'default', run: e => e.compactTerminalIntent({ id: 'b0000000-0000-4000-8000-0000000000d1', left: 512, reservation: 4096, counterKeys: ['brain'] }) },
    texts: [`WITH effects AS (SELECT COALESCE(SUM(${EFFECT_BYTES_SQL}),0) AS bytes,
        COALESCE(bool_or(state<>'committed'),false) AS unfinished FROM persistence_effects WHERE request_id=$1::uuid),
      r AS (UPDATE persistence_requests SET intent=NULL,compacted=true,terminal_reservation=CASE WHEN (SELECT unfinished FROM effects) THEN terminal_reservation
        ELSE LEAST(terminal_reservation,$2::bigint+(SELECT bytes FROM effects)) END WHERE id=$1::uuid RETURNING *),
      released AS (UPDATE persistence_counters c SET terminal_bytes=c.terminal_bytes-LEAST($3::bigint-r.terminal_reservation,c.terminal_bytes)
        FROM r WHERE c.key=ANY($4::text[]))
      SELECT * FROM r`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:598 readGitHoldListing (at 77ac0ed0e9)',
    case: { method: 'readGitHoldListingRows', variant: 'default', run: e => e.readGitHoldListingRows(['default'], 5) },
    texts: [`SELECT s.id AS source_id,
      s.incarnation::text AS incarnation, COALESCE((sm.completed_keys->0->>'count')::int,0) AS count, h.record
    FROM sources s
    JOIN op_checkpoints sm ON sm.op=$1 AND sm.fingerprint=s.id||':'||s.incarnation::text
    LEFT JOIN LATERAL (SELECT x.fingerprint, CASE WHEN COALESCE(s.config->>'mirror_read_only','false')='true' THEN jsonb_set(x.completed_keys->0,'{read_only_checkout}','true'::jsonb) ELSE x.completed_keys->0 END AS record FROM op_checkpoints x
      WHERE x.op=$2 AND x.completed_keys->0->>'source_id'=s.id AND x.completed_keys->0->>'incarnation'=s.incarnation::text
      ORDER BY x.fingerprint COLLATE "C" LIMIT $4) h ON true
    WHERE s.id=ANY($3::text[]) AND COALESCE((sm.completed_keys->0->>'count')::int,0)>0
    ORDER BY s.id COLLATE "C", h.fingerprint COLLATE "C"`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:620 readGitHoldCodeCounts (at 77ac0ed0e9)',
    case: { method: 'readGitHoldCodeCountRows', variant: 'default', run: e => e.readGitHoldCodeCountRows(['default']) },
    texts: [`SELECT s.id AS source_id, x.completed_keys->0->>'code' AS code, count(*) AS n
    FROM sources s JOIN op_checkpoints x ON x.op=$1 AND x.completed_keys->0->>'source_id'=s.id AND x.completed_keys->0->>'incarnation'=s.incarnation::text
    WHERE s.id=ANY($2::text[]) GROUP BY 1,2`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:562 readGitImageHoldCounts (at 77ac0ed0e9)',
    case: { method: 'readGitImageHoldCountRows', variant: 'default', run: e => e.readGitImageHoldCountRows(['default']) },
    texts: [`SELECT s.id AS source_id, COALESCE((h.completed_keys->0->>'images')::int,0) AS images
    FROM op_checkpoints h JOIN sources s ON h.fingerprint=s.id||':'||s.incarnation::text
    WHERE h.op=$1 AND s.id=ANY($2::text[]) AND COALESCE((h.completed_keys->0->>'images')::int,0)>0`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:1168 readSyncConversions (at 77ac0ed0e9)',
    case: { method: 'readSyncConversionRows', variant: 'default', run: e => e.readSyncConversionRows(['default']) },
    texts: [`SELECT s.id AS source_id, c.completed_keys->0->'conversions' AS conversions
    FROM sources s JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text WHERE s.id=ANY($2::text[])`],
  },
  {
    from: 'src/commands/access-serves.ts:197 member key plan (active sources) (at 6e123afe98)',
    case: { method: 'filterUnarchivedSourceIds', variant: 'default', run: e => e.filterUnarchivedSourceIds(['src-a', 'src-b']) },
    texts: ['SELECT id FROM sources WHERE id = ANY($1::text[]) AND archived IS NOT TRUE'],
  },
  {
    from: 'src/core/source-health.ts:384 pageCountsBySource (at cd882f06e6)',
    case: { method: 'countLivePagesBySource', variant: 'default', run: e => e.countLivePagesBySource() },
    texts: [`SELECT source_id, COUNT(*)::int AS n
       FROM pages
      WHERE deleted_at IS NULL
      GROUP BY source_id`],
  },
  {
    from: 'src/core/source-health.ts:403 chunkCountsBySource (at cd882f06e6)',
    case: { method: 'countChunksBySource', variant: 'default', run: e => e.countChunksBySource('embedding') },
    texts: [`SELECT p.source_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE c."embedding" IS NOT NULL)::int AS embedded
       FROM content_chunks c
       JOIN pages p ON p.id = c.page_id
      WHERE p.deleted_at IS NULL
      GROUP BY p.source_id`],
  },
  {
    from: 'src/commands/extract.ts:497 loadSlugAliasTargets (at a18d118d27)',
    case: { method: 'listSlugAliases', variant: 'default', run: e => e.listSlugAliases('default') },
    texts: ['SELECT alias_slug, canonical_slug FROM slug_aliases WHERE source_id = $1'],
  },
  {
    from: 'src/core/quarantine.ts:116 quarantinedSlugs (at 90ede8f55a)',
    case: { method: 'listQuarantinedSlugs', variant: 'default', run: e => e.listQuarantinedSlugs('default') },
    texts: [`SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND NOT NOT (COALESCE(pages.frontmatter, '{}'::jsonb) ? 'quarantine')`],
  },
  {
    from: 'src/core/trust/timeline-projection.ts:22 pageInputs (at 1a12510b10)',
    case: { method: 'listPageTrustTiersByKey', variant: 'default', run: e => e.listPageTrustTiersByKey([{ source_id: 'default', slug: 'a' }]) },
    texts: [`SELECT p.id,p.source_id,p.slug,p.trust_tier FROM pages p
      JOIN jsonb_to_recordset($1::text::jsonb) AS r(source_id text,slug text) ON p.source_id=r.source_id AND p.slug=r.slug`],
  },
  {
    from: 'src/core/trust/timeline-projection.ts:59 addProjectedTimelineBatch requirePages (at 1a12510b10)',
    case: { method: 'lockLivePagesByKey', variant: 'default', run: e => e.lockLivePagesByKey([{ source_id: 'default', slug: 'a' }]) },
    texts: [`SELECT p.source_id,p.slug FROM pages p
          JOIN jsonb_to_recordset($1::text::jsonb) AS r(source_id text,slug text) ON p.source_id=r.source_id AND p.slug=r.slug
          WHERE p.deleted_at IS NULL FOR SHARE OF p`],
  },
  {
    from: 'src/core/link-reconciliation.ts:229 fileLinkOwnership attendance origins (at 90ede8f55a)',
    case: { method: 'listAttendedOriginSlugs', variant: 'default', run: e => e.listAttendedOriginSlugs('default') },
    texts: [`SELECT DISTINCT o.slug FROM links l
    JOIN pages o ON o.id=l.origin_page_id WHERE o.source_id=$1 AND l.link_source IN ('markdown','wikilink-resolved','frontmatter')
      AND l.link_type='attended' AND l.to_page_id=l.origin_page_id`],
  },
  {
    from: 'src/core/link-reconciliation.ts:229 fileLinkOwnership scoped attendance origins (at 90ede8f55a)',
    case: { method: 'listAttendedOriginSlugs', variant: 'default', run: e => e.listAttendedOriginSlugs('default', ['a']) },
    texts: [`SELECT DISTINCT o.slug FROM links l
    JOIN pages o ON o.id=l.origin_page_id WHERE o.source_id=$1 AND l.link_source IN ('markdown','wikilink-resolved','frontmatter')
      AND l.link_type='attended' AND l.to_page_id=l.origin_page_id AND o.slug = ANY($2::text[])`],
  },
  {
    from: 'src/core/sync-pending.ts:106 readFirstDue (at 4e39797ed0)',
    case: { method: 'readFirstDue', variant: 'default', run: e => e.readFirstDue(['default']) },
    texts: [`SELECT s.id AS source_id, n.observed_head,
              LEAST(CASE WHEN n.state <> 'idle' THEN n.first_due_at END,
                    (SELECT min(m.first_due_at) FROM sync_wanted_markers m WHERE m.source_id = s.id AND m.intent = 'freshness'
                       AND m.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
                       AND (m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit))) AS first_due_at
         FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id AND n.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
        WHERE s.id = ANY($1::text[])`],
  },
  {
    from: 'src/core/persistence/sync-status.ts:297 cursorHeader (at 21cd64e151)',
    case: { method: 'readManagedSyncCursorHeader', variant: 'default', run: e => e.readManagedSyncCursorHeader('default', '1', 'k') },
    texts: [`SELECT completed_keys->0 AS header, fingerprint AS key FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'=$2
      ORDER BY (fingerprint=$3) DESC, updated_at DESC LIMIT 1`],
  },
  {
    from: 'src/core/persistence/sync-status.ts:304 retiredCursorStands (at 21cd64e151)',
    case: { method: 'readRetiredManagedSyncCursor', variant: 'default', run: e => e.readRetiredManagedSyncCursor('default', '1') },
    texts: [`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_seen FROM op_checkpoints
    WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'<>$2 AND COALESCE(completed_keys->0->>'done','false')<>'true' ORDER BY updated_at LIMIT 1`],
  },
  {
    from: 'src/core/persistence/sync-status.ts:380 readSyncStatus (committed row) (at 21cd64e151)',
    case: { method: 'readSyncStatusCommittedRow', variant: 'default', run: e => e.readSyncStatusCommittedRow('default') },
    texts: () => [`SELECT count(*) AS n, EXISTS (SELECT 1 FROM persistence_effects e
      WHERE e.source_id=$1 AND e.kind='git' AND e.state IN ('queued','running','failed') AND e.error_code IN ('targets_parked', ${GIT_PUSH_CODES.map(code => `'${code}'`).join(',')})
        AND NOT (e.data ? 'settled')) AS git_push_held,
      EXISTS (SELECT 1 FROM derived_generations g WHERE g.source_id=$1 AND g.kind IN ('fact_fence','take_fence') AND g.state='held') AS fence_held,
      (SELECT max(r.completed_at) FROM persistence_source_bindings b JOIN persistence_requests r ON r.worktree_id=b.worktree_id AND r.source_incarnation=b.source_incarnation
        WHERE b.source_id=$1 AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS last_committed_at
    FROM persistence_requests WHERE source_id=$1 AND state='committed'
    AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND completed_at > now() - interval '10 minutes'`],
  },
  {
    from: 'src/core/persistence/sync-status.ts:589 recoveryProbe (at 21cd64e151)',
    case: { method: 'readSyncRecoveryProbeRow', variant: 'default', run: e => e.readSyncRecoveryProbeRow('default', { timeoutMs: 2_000 }) },
    // The `timeoutMs` option wraps the statement in the engine's statement-timeout transaction, as the caller's executeRaw did.
    texts: ['BEGIN READ WRITE; SET LOCAL statement_timeout = 2000', `SELECT (SELECT count(*) FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL) AS n, f.request_id::text AS request_id, f.slug,
         f.blocked_reason IN ('unexpected_staging_bytes','unexpected_file_bytes') AS blocked
       FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT request_id, slug, blocked_reason FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL ORDER BY sequence LIMIT 1) f ON true`, 'COMMIT'],
  },
  {
    from: 'src/core/persistence/sync-failures.ts:171 readManagedSyncFailures (at 21cd64e151)',
    case: { method: 'readManagedSyncFailureRows', variant: 'default', run: e => e.readManagedSyncFailureRows(['default']) },
    texts: [`
    SELECT c.fingerprint AS cursor_key,jsonb_build_object('sourceId',s.id,'incarnation',s.incarnation,'runId',c.completed_keys->0->>'runId',
      'index',c.completed_keys->0->'index','target',c.completed_keys->0->>'target',
      'syncOptions',c.completed_keys->0->'syncOptions','processingOptions',c.completed_keys->0->'processingOptions',
      'pending',jsonb_build_object('requestId',c.completed_keys->0->'pending'->>'requestId')) AS value,
      CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('state',r.state,'request_id',r.request_id,'error_code',r.error_code,'error_message',r.error_message,'error_detail',r.error_detail) END AS receipt,
      f.completed_keys->0 AS failure,m.completed_keys->((c.completed_keys->0->>'index')::int)->>'path' AS path,c.updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text=c.completed_keys->0->>'incarnation'
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
      AND r.principal_id=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
      AND r.principal_kind=c.completed_keys->0->'authority'->'writer'->'principal'->>'kind'
    LEFT JOIN op_checkpoints f ON f.op='managed-sync-failure' AND f.fingerprint=c.fingerprint
    LEFT JOIN op_checkpoints m ON m.op='managed-sync-manifest' AND m.fingerprint=c.completed_keys->0->>'runId'
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))`],
  },
  {
    from: 'src/core/persistence/sync-failures.ts:202 readManagedSyncFailures (orphaned failures) (at 21cd64e151)',
    case: { method: 'readOrphanedManagedSyncFailureRows', variant: 'default', run: e => e.readOrphanedManagedSyncFailureRows(null) },
    texts: [`
    SELECT f.completed_keys->0 AS failure FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text=f.completed_keys->0->>'source_incarnation'
    WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint)`],
  },
  {
    from: 'src/core/persistence/sync-drain.ts:807 engineStallProbe head (at 21cd64e151)',
    case: { method: 'readSyncHeadRequestRow', variant: 'default', run: e => e.readSyncHeadRequestRow('default', { timeoutMs: 2_000 }) },
    // The `timeoutMs` option wraps the statement in the engine's statement-timeout transaction, as the caller's executeRaw did.
    texts: ['BEGIN READ WRITE; SET LOCAL statement_timeout = 2000', `SELECT h.state AS head_state, h.id::text AS head_request_id, h.request_id::text AS head_write_request_id, h.claim_phase AS head_claim_phase, h.execution_token::text AS head_token,
           (h.claim_expires_at IS NOT NULL AND h.claim_expires_at < now()) AS head_lapsed, h.intent->>'kind' AS head_kind
         FROM persistence_source_bindings b
         JOIN sources s ON s.id = b.source_id AND s.incarnation = b.source_incarnation
         JOIN LATERAL (SELECT e.id, e.request_id, e.state, e.claim_phase, e.execution_token, e.claim_expires_at, e.intent FROM persistence_requests e
           WHERE e.worktree_id = b.worktree_id AND e.state IN ('queued','running','recovering') ORDER BY (e.state <> 'running'), e.sequence LIMIT 1) h ON true
         WHERE b.source_id = $1`, 'COMMIT'],
  },
  {
    from: 'src/core/sync-identity-downgrades.ts:114 listIdentityDowngrades (at 21cd64e151)',
    case: { method: 'readIdentityDowngradeRows', variant: 'default', run: e => e.readIdentityDowngradeRows(['default']) },
    texts: () => [`SELECT dg.completed_keys->0 AS record, np.slugs AS new_slugs FROM op_checkpoints dg JOIN pages p ON p.id::text = dg.fingerprint
      LEFT JOIN LATERAL (SELECT array_agg(slug ORDER BY slug) AS slugs FROM pages WHERE source_id = p.source_id AND deleted_at IS NULL AND source_path = dg.completed_keys->0->>'to') np ON true
      WHERE dg.op = $1 AND p.deleted_at IS NOT NULL AND ${identityDowngradeOpen('p')}
        AND p.source_id = dg.completed_keys->0->>'source_id' AND ($2::text[] IS NULL OR p.source_id = ANY($2::text[]))
      ORDER BY dg.completed_keys->0->>'recorded_at', dg.fingerprint`],
  },
  // The doctor checks from the rust-engine/main join, copied verbatim from the callers at 3c72fae727.
  {
    from: 'src/commands/doctor/checks/access-pages-read-by-nobody.ts:32 the member statuses (at 3c72fae727)',
    case: { method: 'listAccessMemberStatuses', variant: 'default', run: e => e.listAccessMemberStatuses() },
    texts: ["SELECT id, CASE WHEN tombstoned_at IS NOT NULL THEN 'removed' WHEN disabled_at IS NOT NULL THEN 'disabled' ELSE 'enabled' END AS status FROM access_members ORDER BY id"],
  },
  {
    from: 'src/commands/doctor/checks/access-pages-read-by-nobody.ts:35 the group memberships (at 3c72fae727)',
    case: { method: 'listAccessGroupMemberships', variant: 'default', run: e => e.listAccessGroupMemberships() },
    texts: ['SELECT group_id, member_id FROM access_group_members'],
  },
  {
    from: 'src/commands/doctor/checks/access-pages-read-by-nobody.ts:42 the labelled pages no enabled member reads (at 3c72fae727)',
    case: { method: 'listPagesReadByNobody', variant: 'default', run: e => e.listPagesReadByNobody(['member:alice-example'], { timeoutMs: 5000 }) },
    // The caller passed { timeoutMs } to executeRaw, so the statement runs in its bounded transaction, as before.
    texts: ['BEGIN READ WRITE; SET LOCAL statement_timeout = 5000',
      'SELECT source_id, slug, page_readers AS readers FROM pages WHERE deleted_at IS NULL AND page_readers IS NOT NULL AND NOT (page_readers && $1::text[]) AND NOT ($2 = ANY(page_readers)) AND NOT starts_with(slug, $3)',
      'COMMIT'],
  },
  {
    from: 'src/commands/doctor/checks/access-pages-read-by-nobody.ts:50 the pages a folder rule covers that no admitted member reads (at 3c72fae727; the caller spliced ruleCoversSql in, rendered here the same way)',
    case: { method: 'listRulePagesReadByNobody', variant: 'default', run: e => e.listRulePagesReadByNobody('default', 'people/', 1, ['member:alice-example'], { timeoutMs: 5000 }) },
    texts: () => ['BEGIN READ WRITE; SET LOCAL statement_timeout = 5000',
      'SELECT source_id, slug, page_readers AS readers FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND ' + ruleCoversSql('slug', '$2') +
      ' AND NOT starts_with(slug, $5) AND (page_readers IS NULL OR NOT ($4 = ANY(page_readers))) AND ($3::int = 0 OR (page_readers IS NOT NULL AND NOT (page_readers && $6::text[])))',
      'COMMIT'],
  },
  {
    from: 'src/core/identity/owner.ts:77 the Google sources and their bound members (at 3c72fae727)',
    case: { method: 'listGoogleSourceMembers', variant: 'default', run: e => e.listGoogleSourceMembers() },
    texts: [`SELECT s.id, s.config->>'g_account' AS account,
            (SELECT array_agg(b.member_id ORDER BY b.member_id) FROM access_member_sources b WHERE b.source_id = s.id) AS members
       FROM sources s
      WHERE s.archived IS NOT TRUE AND s.config->>'kind' = 'google'
      ORDER BY s.id COLLATE "C"`],
  },
  {
    from: 'src/core/identity/owner.ts:111 the owner member\'s external ids (at 3c72fae727)',
    case: { method: 'listOwnerMemberLinks', variant: 'default', run: e => e.listOwnerMemberLinks('alice-example') },
    texts: ['SELECT system, external_id FROM access_member_links WHERE member_id = $1 ORDER BY system, external_id'],
  },
  {
    from: 'src/core/identity/owner.ts:131 the owner email pages (at 3c72fae727; the caller built the same statement with exactIdentityStatement and ran it through executeRaw)',
    case: { method: 'listExactIdentityCandidates', variant: 'owner_emails', run: e => e.listExactIdentityCandidates({
      probes: { titleKeys: [], titleRaw: '', basenames: [], aliasKeys: [], emails: ['alice@example.com'] }, sourceIds: ['a-z', 'ab', 'default'], types: { types: ['person'], per_source: [] }, emailsOnly: true, limit: 50 }) },
    texts: () => [exactIdentityStatement({
      probes: { titleKeys: [], titleRaw: '', basenames: [], aliasKeys: [], emails: ['alice@example.com'] }, sourceIds: ['a-z', 'ab', 'default'], types: { types: ['person'], per_source: [] }, emailsOnly: true, limit: 50 }).text],
  },
  {
    // EQUIVALENT, not verbatim: access-pages-read-by-nobody.ts:45 and identity/owner.ts:123 (at 3c72fae727) ran
    // 'SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id COLLATE "C"'. They now read listAllSources() and sort
    // its ids with sortSourcesById (byte order, as COLLATE "C"): the same live sources (archived ones left out by the
    // same predicate) in the same order, on every engine.
    from: 'src/commands/doctor/checks/access-pages-read-by-nobody.ts:45 and src/core/identity/owner.ts:123, the live source ids (equivalent: listAllSources + sortSourcesById)',
    case: { method: 'listAllSources', variant: 'live_source_ids', run: e => e.listAllSources() },
    texts: [`
      SELECT id, name, local_path, last_sync_at, config
        FROM sources
       WHERE ($1 OR archived IS NOT TRUE)
         AND ($2 OR (local_path IS NOT NULL AND config->>'role' IS DISTINCT FROM 'storage_manifest'))
       ORDER BY (id = 'default') DESC, id COLLATE "C"
    `],
  },
  {
    from: 'src/commands/extract.ts:497 loadSlugAliasTargets (at a18d118d27)',
    case: { method: 'listSlugAliases', variant: 'default', run: e => e.listSlugAliases('default') },
    texts: ['SELECT alias_slug, canonical_slug FROM slug_aliases WHERE source_id = $1'],
  },
  {
    from: 'src/core/quarantine.ts:116 quarantinedSlugs (at 3c72fae727)',
    case: { method: 'listQuarantinedSlugs', variant: 'default', run: e => e.listQuarantinedSlugs('default') },
    texts: [`SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND NOT NOT (COALESCE(pages.frontmatter, '{}'::jsonb) ? 'quarantine')`],
  },
  {
    from: 'src/core/link-reconciliation.ts:220 fileLinkOwnership scoped metadata (at 3c72fae727)',
    case: { method: 'listLinkPageMetadataForSlugs', variant: 'default', run: e => e.listLinkPageMetadataForSlugs('default', ['a']) },
    texts: [`SELECT slug, source_id, type, title, frontmatter->'aliases' AS aliases, knowledge_revision
        FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[]) ORDER BY slug COLLATE "C"`],
  },
  {
    from: 'src/core/link-reconciliation.ts:229 fileLinkOwnership attendance origins (at 3c72fae727)',
    case: { method: 'listAttendedOriginSlugs', variant: 'default', run: e => e.listAttendedOriginSlugs('default') },
    texts: [`SELECT DISTINCT o.slug FROM links l
    JOIN pages o ON o.id=l.origin_page_id WHERE o.source_id=$1 AND l.link_source IN ('markdown','wikilink-resolved','frontmatter')
      AND l.link_type='attended' AND l.to_page_id=l.origin_page_id`],
  },
  {
    from: 'src/core/link-reconciliation.ts:229 fileLinkOwnership scoped attendance origins (at 3c72fae727)',
    case: { method: 'listAttendedOriginSlugs', variant: 'default', run: e => e.listAttendedOriginSlugs('default', ['a']) },
    texts: [`SELECT DISTINCT o.slug FROM links l
    JOIN pages o ON o.id=l.origin_page_id WHERE o.source_id=$1 AND l.link_source IN ('markdown','wikilink-resolved','frontmatter')
      AND l.link_type='attended' AND l.to_page_id=l.origin_page_id AND o.slug = ANY($2::text[])`],
  },
  // The takes publication's prepare step and a remote takes write's holder check, copied verbatim from their callers.
  {
    from: 'src/core/persistence/takes-prepare.ts:276 the resolved_at stamp (at a6e972420c)',
    case: { method: 'stampTakeResolvedAt', variant: 'default', run: e => e.stampTakeResolvedAt(1, 2, '2026-11-20') },
    texts: ['UPDATE takes SET resolved_at=$3::timestamptz WHERE page_id=$1 AND row_num=$2'],
  },
  {
    from: 'src/core/persistence/takes-prepare.ts:261 the request\'s takeHoldersUsed (at a6e972420c)',
    case: { method: 'recordTakeHoldersUsed', variant: 'default', run: e => e.recordTakeHoldersUsed('00000000-0000-4000-8000-000000000001', ['world']) },
    texts: [`UPDATE persistence_requests
      SET authority=jsonb_set(authority,'{takeHoldersUsed}',$2::text::jsonb)
      WHERE id=$1::uuid`],
  },
  {
    from: 'src/core/persistence/authority.ts:279 authorizeStoredTakeHolders (at a6e972420c)',
    case: { method: 'listTakeHoldersAtRows', variant: 'default', run: e => e.listTakeHoldersAtRows(1, [2, 3]) },
    texts: ['SELECT DISTINCT holder FROM takes WHERE page_id=$1 AND row_num=ANY($2::integer[])'],
  },
  // The frontmatter `where` check on finished search rows, copied verbatim from its caller (one key with one value, one
  // whose string value also reads as a number).
  {
    from: 'src/core/search/frontmatter-where.ts:104 keepFrontmatterMatches (at 26a78ed132)',
    case: { method: 'filterPageIdsByFrontmatter', variant: 'default', run: e => e.filterPageIdsByFrontmatter([1, 2], { status: ['active'], cycle: ['2024'] }) },
    texts: ['SELECT p.id FROM pages p WHERE p.id = ANY($1::bigint[]) AND (p.frontmatter @> $2::text::jsonb OR p.frontmatter @> $3::text::jsonb)'
      + ' AND (p.frontmatter @> $4::text::jsonb OR p.frontmatter @> $5::text::jsonb OR p.frontmatter @> $6::text::jsonb OR p.frontmatter @> $7::text::jsonb)'],
  },
  // The chronicle-backfill page batch (engine-sql/chronicle-reads.ts), carried from 6f801f6d17's pins of 3ac6224f3b;
  // the builder at 68c48d9824 sends the same texts.
  {
    from: 'src/core/chronicle/backfill.ts:139 runChronicleBackfill (no scope, no since; the literals 5 and 500 spelled in), at 3ac6224f3b',
    case: { method: 'readChronicleBackfillBatch', variant: 'default', run: e => e.readChronicleBackfillBatch({ types: ['meeting'], slugPatterns: ['meetings/%'], extractorVersion: 2, afterId: 0 }) },
    texts: [`SELECT p.id, p.source_id, p.slug, p.type, coalesce(p.compiled_truth, p.truth_lead) AS compiled_truth, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash,
              EXISTS (SELECT 1 FROM chronicle_page_state c WHERE c.page_id=p.id AND c.content_hash=p.content_hash
                AND c.extractor_version=$3 AND (c.state='extracted' OR (c.state IN ('pending','failed') AND c.trigger='backfill' AND c.attempts < 5))) AS done
         FROM pages p
        WHERE p.deleted_at IS NULL AND (p.type = ANY($1::text[]) OR p.slug LIKE ANY($2::text[])) AND p.id > $4
        ORDER BY p.id LIMIT 500`],
  },
  {
    from: 'src/core/chronicle/backfill.ts:139 runChronicleBackfill (a source list and since), at 3ac6224f3b',
    case: { method: 'readChronicleBackfillBatch', variant: 'sources-since', run: e => e.readChronicleBackfillBatch({ types: ['meeting'], slugPatterns: ['meetings/%'], extractorVersion: 2, sourceIds: ['default'], since: '2026-01-01', afterId: 0 }) },
    texts: [`SELECT p.id, p.source_id, p.slug, p.type, coalesce(p.compiled_truth, p.truth_lead) AS compiled_truth, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash,
              EXISTS (SELECT 1 FROM chronicle_page_state c WHERE c.page_id=p.id AND c.content_hash=p.content_hash
                AND c.extractor_version=$3 AND (c.state='extracted' OR (c.state IN ('pending','failed') AND c.trigger='backfill' AND c.attempts < 5))) AS done
         FROM pages p
        WHERE p.deleted_at IS NULL AND (p.type = ANY($1::text[]) OR p.slug LIKE ANY($2::text[])) AND p.source_id = ANY($4::text[]) AND p.updated_at >= $5::date AND p.id > $6
        ORDER BY p.id LIMIT 500`],
  },
  {
    from: 'src/core/chronicle/backfill.ts:139 runChronicleBackfill (one source), at 3ac6224f3b',
    case: { method: 'readChronicleBackfillBatch', variant: 'source', run: e => e.readChronicleBackfillBatch({ types: ['meeting'], slugPatterns: ['meetings/%'], extractorVersion: 2, sourceId: 'default', afterId: 0 }) },
    texts: [`SELECT p.id, p.source_id, p.slug, p.type, coalesce(p.compiled_truth, p.truth_lead) AS compiled_truth, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash,
              EXISTS (SELECT 1 FROM chronicle_page_state c WHERE c.page_id=p.id AND c.content_hash=p.content_hash
                AND c.extractor_version=$3 AND (c.state='extracted' OR (c.state IN ('pending','failed') AND c.trigger='backfill' AND c.attempts < 5))) AS done
         FROM pages p
        WHERE p.deleted_at IS NULL AND (p.type = ANY($1::text[]) OR p.slug LIKE ANY($2::text[])) AND p.source_id = $4 AND p.id > $5
        ORDER BY p.id LIMIT 500`],
  },
  // The facts arm's superseded-claim read, copied verbatim from its caller.
  {
    from: 'src/core/search/facts-arm.ts:156 stampSupersededClaims, at f9592f7a7e',
    case: { method: 'listTypedClaimFactsAtPages', variant: 'default', run: e => e.listTypedClaimFactsAtPages(['meetings/a'], ['people/a']) },
    texts: [`SELECT f.id, f.source_markdown_slug, f.source_id, f.entity_slug, f.claim_metric, f.claim_period, f.valid_from FROM facts f
     WHERE f.source_markdown_slug = ANY($1::text[]) AND f.entity_slug = ANY($2::text[]) AND f.claim_metric IS NOT NULL`],
  },
  // The observed-date read of the facts arm and recall's date header (search/evidence-date.ts factObservationDates).
  {
    from: 'src/core/search/evidence-date.ts:110 loadPageDateHeaders, at 4ca2fa285e',
    case: { method: 'readPageDateFieldsByIds', variant: 'default', run: e => e.readPageDateFieldsByIds([1, 2]) },
    texts: ['SELECT id, slug, frontmatter, import_filename FROM pages WHERE id = ANY($1::int[])'],
  },
  // The search feedback stage's weight read; NEUTRAL_WEIGHT (0.5) was interpolated into the text.
  {
    from: 'src/core/search/feedback-boost.ts:40 readPageFeedback, at 4ca2fa285e',
    case: { method: 'readPageFeedbackWeights', variant: 'default', run: e => e.readPageFeedbackWeights([1, 2]) },
    texts: [`SELECT p.id, p.content_hash,
            CASE WHEN w.weight IS NULL THEN NULL
                 WHEN p.content_hash IS DISTINCT FROM w.content_hash
                   THEN ${NEUTRAL_WEIGHT} + (w.weight - ${NEUTRAL_WEIGHT}) / 2
                 ELSE w.weight END AS weight
       FROM pages p
       LEFT JOIN retrieval_weights w
         ON w.source_id = p.source_id AND w.element_kind = 'page' AND w.element_key = p.slug
      WHERE p.id = ANY($1::int[])`],
  },
  {
    from: 'src/core/search/evidence-date.ts:158 factObservationDates, at 4ca2fa285e',
    case: { method: 'listFactHoldingRefs', variant: 'default', run: e => e.listFactHoldingRefs([1, 2]) },
    texts: ['SELECT id, source_id, source_markdown_slug AS slug, entity_slug FROM facts WHERE id = ANY($1::bigint[])'],
  },
  {
    from: 'src/core/search/evidence-date.ts:165 factObservationDates (no read scope), at 4ca2fa285e',
    case: { method: 'readAdmittedPageDateFields', variant: 'default', run: e => e.readAdmittedPageDateFields([{ source_id: 'default', slug: 'meetings/a' }], {}) },
    texts: [pinnedPageDateFields({})],
  },
  {
    from: 'src/core/search/evidence-date.ts:165 factObservationDates (a scoped, private-filtered caller), at 4ca2fa285e',
    case: { method: 'readAdmittedPageDateFields', variant: 'scoped', run: e => e.readAdmittedPageDateFields([{ source_id: 'default', slug: 'meetings/a' }], { sourceIds: ['default'], excludePrivate: true }) },
    texts: [pinnedPageDateFields({ sourceIds: ['default'], excludePrivate: true })],
  },
];

type PinPrivacy = 'none' | 'caller' | 'floor';

/** context/retrieval-reflex.ts's `privacySql` at efeb078093 (`excludePrivate === false` is 'none'). */
function pinnedReflexPrivacy(privacy: PinPrivacy): string {
  return privacy === 'none' ? '' : `AND ${privacy === 'caller' ? privatePagesFilterForCaller('p') : remoteReadFloorSql('p')}`;
}

/** Each retrieval-reflex statement and the brief's entity-page statement at efeb078093, verbatim, for every privacy mode. */
function reflexPins(): Pin[] {
  const PREFIX_SQL = boundedBodyPrefixSql('p');
  const at = (line: string) => `src/core/context/retrieval-reflex.ts:${line} at efeb078093`;
  const scope = (privacy: PinPrivacy) => ({ sourceIds: ['default', 'wiki'], privacy });
  const names = { kind: 'names' as const, titlesLc: ['alice example'], exactSlugs: ['alice-example'], slugSuffixes: ['%/alice-example'] };
  return (['none', 'caller', 'floor'] as const).flatMap((privacy): Pin[] => {
    const privacySql = pinnedReflexPrivacy(privacy);
    return [
      { from: `${at('79')} weakTitleHits (${privacy})`,
        case: { method: 'readReflexPages', variant: `titles-${privacy}`, run: e => e.readReflexPages(scope(privacy), { kind: 'titles', titlesLc: ['acme example'] }) },
        texts: () => [`SELECT p.slug, p.source_id, p.title, p.type, p.frontmatter, ${PREFIX_SQL} AS compiled_truth
         FROM pages p
        WHERE p.deleted_at IS NULL ${privacySql}
          AND p.source_id = ANY($1::text[])
          AND lower(p.title) = ANY($2::text[])`] },
      { from: `${at('357')} the alias live check (${privacy})`,
        case: { method: 'readReflexLiveKeys', variant: privacy, run: e => e.readReflexLiveKeys(scope(privacy), ['people/alice-example']) },
        texts: () => [`SELECT p.slug, p.source_id FROM pages p
            WHERE p.deleted_at IS NULL AND p.source_id = ANY($1::text[]) AND p.slug = ANY($2::text[]) ${privacySql}`] },
      { from: `${at('417')} the title, slug and surname arm (${privacy})`,
        case: { method: 'readReflexPages', variant: `surname-${privacy}`, run: e => e.readReflexPages(scope(privacy), { ...names, surnamePatterns: ['% example'] }) },
        texts: () => [`SELECT p.slug, p.source_id, p.title, p.type, p.frontmatter, ${PREFIX_SQL} AS compiled_truth
             FROM pages p
            WHERE p.deleted_at IS NULL ${privacySql}
              AND p.source_id = ANY($1::text[])
              AND ( lower(p.title) = ANY($2::text[])
                 OR p.slug = ANY($3::text[])
                 OR p.slug LIKE ANY($4::text[])
                 OR (lower(p.title) LIKE ANY($5::text[]) AND p.type = 'person') ) ORDER BY p.id`] },
      { from: `${at('428')} the title and slug arm (${privacy})`,
        case: { method: 'readReflexPages', variant: `names-${privacy}`, run: e => e.readReflexPages(scope(privacy), names) },
        texts: () => [`SELECT p.slug, p.source_id, p.title, p.type, p.frontmatter, ${PREFIX_SQL} AS compiled_truth
             FROM pages p
            WHERE p.deleted_at IS NULL ${privacySql}
              AND p.source_id = ANY($1::text[])
              AND ( lower(p.title) = ANY($2::text[])
             OR p.slug = ANY($3::text[])
             OR p.slug LIKE ANY($4::text[]) ) ORDER BY p.id`] },
      { from: `${at('447')} the alias-only hydration (${privacy})`,
        case: { method: 'readReflexPages', variant: `slugs-${privacy}`, run: e => e.readReflexPages(scope(privacy), { kind: 'slugs', slugs: ['people/alice-example'] }) },
        texts: () => [`SELECT p.slug, p.source_id, p.title, p.type, p.frontmatter, ${PREFIX_SQL} AS compiled_truth
           FROM pages p
          WHERE p.deleted_at IS NULL ${privacySql} AND p.source_id = ANY($1::text[]) AND p.slug = ANY($2::text[])`] },
      { from: `${at('531')} the CJK exact arm (${privacy})`,
        case: { method: 'readReflexPages', variant: `cjk-${privacy}`, run: e => e.readReflexPages(scope(privacy), { kind: 'cjkExact', norms: ['爱丽丝'] }) },
        texts: () => [`SELECT p.slug, p.source_id, p.title, p.type, p.frontmatter, ${PREFIX_SQL} AS compiled_truth
             FROM pages p
            WHERE p.deleted_at IS NULL ${privacySql}
              AND p.source_id = ANY($1::text[])
              AND ( lower(p.title) = ANY($2::text[]) OR p.slug = ANY($3::text[]) )`] },
      { from: `src/core/context/proactive-brief.ts:203 entityPages at efeb078093 (${privacy}, a trust floor)`,
        case: { method: 'readBriefEntityPages', variant: privacy, run: e => e.readBriefEntityPages('default', ['people/alice-example'], { privacy, eligibility: { floor: 'operator_curated', suppressFlagged: true } }) },
        texts: () => [`SELECT p.slug, p.title, p.type FROM pages p
      WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND p.deleted_at IS NULL
        ${privacy !== 'none' ? `AND ${privacy === 'caller' ? privatePagesFilterForCaller('p') : remoteReadFloorSql('p')}` : ''}
        AND ${pageEligibleSql('p', { floor: 'operator_curated', suppressFlagged: true })}`] },
    ];
  });
}

/**
 * The proactive brief's meeting, alias, world-fact, edit-page, timeline and revision statements at 0ea77f47bd.
 * The meeting, alias and world-fact texts are verbatim. The edit-page, timeline and revision texts are equivalent
 * statements, not byte for byte: master bound `[source, slug, maxBytes]` and `[pageId, since(, maxBytes)]` and used
 * `$3` before `$1`, and the timeline read used `$2` twice; engine-sql numbers placeholders in the order they appear
 * (renderFragment), so the byte ceiling binds first and `since` binds twice. The same values reach the same places,
 * so the same rows come back in the same order. The rest of each text is verbatim; the parameter test below pins
 * the new order.
 */
function briefPins(): Pin[] {
  const at = (line: string) => `src/core/context/proactive-brief.ts:${line} at 0ea77f47bd`;
  const elig = { floor: 'operator_curated' as const, suppressFlagged: true };
  const fixed: Pin[] = [
    { from: `${at('276')} upcomingMeetings (a trust floor)`,
      case: { method: 'readBriefMeetingPages', variant: 'floor', run: e => e.readBriefMeetingPages(['g1'], '2026-11-20', '2026-11-21~', elig) },
      texts: () => [`SELECT p.slug, p.source_id, p.frontmatter->>'start' AS start, p.frontmatter->'attendees' AS attendees, p.frontmatter->>'account' AS account
       FROM pages p
      WHERE p.deleted_at IS NULL AND p.type = 'meeting' AND p.source_id = ANY($1::text[])
        AND p.frontmatter->>'start' >= $2 AND p.frontmatter->>'start' <= $3
        AND ${remoteReadFloorSql('p')} AND ${pageEligibleSql('p', elig)}`] },
    { from: `${at('338')} meetingCounterparties (a trust floor)`,
      case: { method: 'readBriefEmailAliasPages', variant: 'floor', run: e => e.readBriefEmailAliasPages('default', ['alice@example.com'], elig) },
      texts: () => [`SELECT a.alias_norm, p.slug, p.title, p.type FROM page_aliases a
       JOIN pages p ON p.source_id = a.source_id AND p.slug = a.slug AND p.deleted_at IS NULL
      WHERE a.source_id = $1 AND a.alias_norm = ANY($2::text[])
        AND ${remoteReadFloorSql('p')} AND ${pageEligibleSql('p', elig)}`] },
    { from: `${at('421')} loopItems worldProjections (a trust floor)`,
      case: { method: 'readBriefWorldFacts', variant: 'floor', run: e => e.readBriefWorldFacts([7], elig) },
      texts: () => [`SELECT facts.id, facts.fact, facts.trust_tier, facts.write_origin FROM facts
        WHERE facts.id = ANY($1::bigint[]) AND facts.expired_at IS NULL AND facts.visibility = 'world'
          AND ${privateFactFilterForCaller('facts')}
          AND ${projectionEligibleSql('facts', 'facts', elig)}`] },
    { from: `${at('499')} editItem revisions (renumbered: maxBytes $1, pageId $2, since $3)`,
      case: { method: 'readBriefPageVersions', variant: 'default', run: e => e.readBriefPageVersions(5, '2026-11-01T00:00:00.000Z', 65536, 5) },
      texts: [`SELECT v.id, CASE WHEN octet_length(v.compiled_truth) + octet_length(COALESCE(v.timeline, '')) <= $1 THEN v.compiled_truth END AS compiled_truth,
              v.timeline, v.snapshot_at, v.is_deleted
         FROM page_versions v WHERE v.page_id = $2 AND v.snapshot_at >= $3::timestamptz
        ORDER BY v.id DESC LIMIT 5`] },
  ];
  const byPrivacy = (['none', 'caller', 'floor'] as const).flatMap((privacy): Pin[] => [
    { from: `${at('479')} editItem page (${privacy}, a trust floor; renumbered: maxBytes $1, source $2, slug $3)`,
      case: { method: 'readBriefEditPage', variant: privacy, run: e => e.readBriefEditPage('default', 'people/alice-example', 65536, { privacy, eligibility: elig }) },
      texts: () => [`SELECT p.id, CASE WHEN octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) <= $1 THEN p.compiled_truth END AS compiled_truth,
            p.timeline, p.trust_tier, p.write_origin
       FROM pages p
      WHERE p.source_id = $2 AND p.slug = $3 AND p.deleted_at IS NULL
        AND ${privacy === 'none' ? 'TRUE' : privacy === 'caller' ? privatePagesFilterForCaller('p') : remoteReadFloorSql('p')}
        AND ${pageEligibleSql('p', elig)}`] },
    { from: `${at('491')} editItem timeline entry (${privacy}, a trust floor; renumbered: since $2 and $3)`,
      case: { method: 'readBriefTimelineEntry', variant: privacy, run: e => e.readBriefTimelineEntry(5, '2026-11-01T00:00:00.000Z', { privacy, eligibility: elig }) },
      texts: () => [`SELECT te.id, te.date::text AS date, te.summary, te.detail, te.created_at FROM timeline_entries te
        WHERE te.page_id = $1 AND te.created_at >= $2::timestamptz AND te.date >= $3::timestamptz::date
          AND ${privacy === 'none' ? 'TRUE' : privacy === 'caller' ? privateTimelineEventFilterForCaller('te') : privateTimelineEventFilterFragment('te')}
          AND ${projectionEligibleSql('timeline_entries', 'te', elig)}
        ORDER BY te.created_at DESC, te.date DESC, te.id DESC LIMIT 1`] },
  ]);
  return [...fixed, ...byPrivacy];
}

/**
 * search/entity-facts.ts newestFacts's statement at efeb078093 (`worldOnly` stands for `worldOnlyFacts(opts.remote)`), with
 * main's ordering: a fact whose `valid_from` lies in the future sorts by `created_at`.
 */
function pinnedNewestFacts(remote: boolean, worldOnly: boolean, minTrust?: TrustTier): string {
  const visibility = remote ? `${worldOnly ? `AND (f.visibility = 'world' OR ${grantedPrivateFactSql('f')})` : ''} AND ${privateFactFilterForReader('f')}` : '';
  return `SELECT f.id, f.fact, f.entity_slug, f.kind, f.valid_from::text AS valid_from, f.source, ${SAVED_FACT_COLLAPSE_COLUMNS}
       FROM facts f
      WHERE f.source_id = $1 AND f.entity_slug = ANY($2::text[])
        AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())
        AND f.source != ALL($3::text[])
        ${visibility}
        AND ${projectionEligibleSql('facts', 'f', { floor: minTrust })}
      ORDER BY (CASE WHEN f.valid_from > now() THEN f.created_at ELSE f.valid_from END) DESC, f.id DESC
      LIMIT 50`;
}

/** search/evidence-date.ts factObservationDates' page read at 4ca2fa285e, verbatim. */
function pinnedPageDateFields(scope: { sourceId?: string; sourceIds?: string[]; minTrust?: TrustTier; excludePrivate?: boolean }): string {
  const params: unknown[] = [['default'], ['meetings/a']];
  const policy = pageReadFilter('p', scope, params, true);
  return `SELECT p.source_id, p.slug, p.frontmatter, p.import_filename FROM pages p
     JOIN unnest($1::text[], $2::text[]) AS w(source_id, slug) ON p.source_id = w.source_id AND p.slug = w.slug WHERE ${policy}`;
}

/** ops/search-type-filter.ts reconcileTypeFilter's probe statement at efeb078093, verbatim (`{ ...scope, excludePrivate }`). */
function pinnedTypeProbe(expanded: string[][], scope: { sourceId?: string; sourceIds?: string[]; minTrust?: TrustTier; excludePrivate?: boolean }): string {
  const params: unknown[] = [];
  const filter = pageReadFilter('p', scope, params, true);
  const probes = expanded.flatMap((set, i) => {
    if (set.length === 0) return [];
    params.push(set);
    return [{ name: `t${i}`, sql: `EXISTS (SELECT 1 FROM pages p WHERE ${filter} AND p.type = ANY($${params.length}::text[])) AS t${i}` }];
  });
  return `SELECT probe.*, CASE WHEN ${probes.map(p => `probe.${p.name}`).join(' AND ')} THEN NULL
         ELSE ARRAY(SELECT DISTINCT p.type FROM pages p WHERE ${filter} LIMIT 500) END AS available
       FROM (SELECT ${probes.map(p => p.sql).join(', ')} OFFSET 0) probe`;
}

/** search/evidence-delivery.ts selectLongPages size preflight at efeb078093, verbatim; `timeline` is detail other than low. */
function pinnedLongPageSizes(scope: { sourceId?: string; sourceIds?: string[]; minTrust?: TrustTier; excludePrivate?: boolean }, timeline: boolean): string {
  const params: unknown[] = [[3]];
  const filter = pageReadFilter('p', scope, params, true);
  const tl = !timeline ? null : `CASE WHEN COALESCE(p.timeline, '') !~ '\\S' THEN 0 ELSE ${TIMELINE_SEPARATOR.length} + `;
  return `SELECT p.id, char_length(COALESCE(p.compiled_truth, ''))${tl ? ` + ${tl}char_length(p.timeline) END` : ''} AS chars,
              octet_length(COALESCE(p.compiled_truth, ''))${tl ? ` + ${tl}octet_length(p.timeline) END` : ''} AS bytes FROM pages p
        WHERE p.id = ANY($1::int[]) AND ${filter} AND ${servedTextProjectionFilter('p')}${requiresSafeChunks(scope) ? ` AND ${safeChunksFilter('p')}` : ''}`;
}

/** mentions/referrers-sql.ts referrersCte at 97bf5544dd, verbatim, for the floored remote scope or the local one. */
function pinnedReferrersCte(excludePrivate: boolean, floored: boolean): string {
  return `WITH tgt AS MATERIALIZED (
      SELECT t.id FROM pages t JOIN unnest($1::text[], $2::text[]) AS k(s, g) ON t.source_id = k.s AND t.slug = k.g
       WHERE t.deleted_at IS NULL${excludePrivate ? ` AND ${privatePagesFilterForCaller('t')}` : ''}
    ),
    refs AS MATERIALIZED (
      SELECT DISTINCT l.from_page_id AS id FROM links l WHERE l.to_page_id IN (SELECT id FROM tgt)${excludePrivate ? ` AND ${privateLinkOriginFilterForCaller('l')}` : ''}
    ),
    typed AS MATERIALIZED (
      SELECT f.id, f.slug, f.source_id, f.type,
             COALESCE(f.effective_date, f.updated_at) AS d,
             COALESCE(($5::text[])[array_position($4::text[], f.type)], NULLIF(f.type, ''), 'untyped') AS canonical_type
        FROM pages f
       WHERE f.id IN (SELECT id FROM refs)
         AND f.deleted_at IS NULL AND f.source_id = ANY($3::text[])
         AND f.id NOT IN (SELECT id FROM tgt)${excludePrivate ? ` AND ${privatePagesFilterFastForCaller('f')}` : ''} AND ${pageEligibleSql('f', floored ? { floor: 'operator_curated' } : undefined)} AND ${quarantineFilterFragment('f')}
    )`;
}

/** caller.ts MEMBER_SQL at 7470c703ed: MEMBERS_WHERE_SQL(`m.id = (${member})`), copied verbatim. */

const ADMITTED_REQUEST = 'b0000000-0000-4000-8000-0000000000b1';

const SYNC_PASS_Q = { sourceId: 'default', incarnation: 'inc-1', expected: { parser_version: 'p', markdown_chunker: 4, schema_pack: null } };

/** sync-pass.ts readPages `select` at 2e7e4b6554, verbatim; `offsetZero` is `kind === 'postgres' && !only`. */
function syncPassSelect(offsetZero: boolean): string {
  return `SELECT p.id, p.slug, p.source_path, p.knowledge_revision::text AS revision, p.deleted_at IS NOT NULL AS deleted,
      p.revision_write_request_id::text AS request_id, c.fingerprint IS NOT NULL AS has_record,
      c.origin IS NOT DISTINCT FROM p.source_path AS rec_origin_same,
      CASE WHEN c.origin IS DISTINCT FROM p.source_path THEN c.origin END AS rec_origin,
      c.blob_oid AS rec_blob_oid,
      c.disk_blob_oid IS NOT DISTINCT FROM c.blob_oid AS rec_disk_same,
      CASE WHEN c.disk_blob_oid IS DISTINCT FROM c.blob_oid THEN c.disk_blob_oid END AS rec_disk_blob_oid,
      c.revision IS NULL AS rec_revision_null,
      NULLIF(c.revision, p.knowledge_revision::text) AS rec_revision,
      CASE WHEN c.parser IS DISTINCT FROM $4::jsonb THEN c.parser::text END AS rec_parser, c.parser = $4::jsonb AS rec_parser_expected,
      c.full_episode AS rec_full_episode, c.working AS rec_working,
      (p.page_kind = 'markdown' AND p.chunker_version = ${MARKDOWN_CHUNKER_VERSION} AND p.body_storage IS DISTINCT FROM 'segmented'
        AND p.text_projection_revision IS NOT DISTINCT FROM p.knowledge_revision AND p.contextual_retrieval_mode IS NOT NULL) AS derived_current,
      CASE WHEN p.deleted_at IS NOT NULL THEN ${syncDeleteOrigin('p')} ELSE false END AS sync_deleted
    FROM pages p LEFT JOIN (SELECT fingerprint, completed_keys->0->>'origin' AS origin, completed_keys->0->>'blob_oid' AS blob_oid,
        completed_keys->0->>'disk_blob_oid' AS disk_blob_oid, completed_keys->0->>'revision' AS revision,
        completed_keys->0->'parser' AS parser, completed_keys->0->>'full_episode' AS full_episode, (completed_keys->0->'working')::text AS working
      FROM op_checkpoints WHERE op=$2${offsetZero ? ' OFFSET 0' : ''}) c ON c.fingerprint=$3||p.id::text
    WHERE p.source_id=$1 AND p.source_path IS NOT NULL`;
}

/** sync-holds.ts READ_HOLD_RECORD_SQL at 8bfcd19ad8, verbatim. */
const READ_HOLD_RECORD_SQL = `CASE WHEN COALESCE(s.config->>'mirror_read_only','false')='true' THEN jsonb_set(h.completed_keys->0,'{read_only_checkout}','true'::jsonb) ELSE h.completed_keys->0 END`;

/** entity-card.ts CARD_ROW_COLUMNS at 7470c703ed, verbatim. */
function CARD_ROW_COLUMNS(): string {
  return `slug, source_id, title, type, frontmatter, ${boundedBodyPrefixSql('pages')} AS compiled_truth, updated_at,
              GREATEST(last_retrieved_at, (SELECT r.last_retrieved_at FROM page_retrievals r WHERE r.page_id = pages.id)) AS last_retrieved_at`;
}

describe('caller raw SQL moved into typed members keeps its Postgres text byte for byte', () => {
  for (const pin of PINS) {
    test(`${pin.case.method}/${pin.case.variant} (${pin.from})`, async () => {
      let expected: string[] = [];
      const capture = await withPinnedSqlEnvironment(undefined, () => {
        expected = typeof pin.texts === 'function' ? pin.texts() : pin.texts;
        return runCase(pin.case);
      });
      expect(capture.error).toBeUndefined();
      const sent = capture.trace.filter(s => s.kind === 'query').map(s => s.text);
      expect(sent).toEqual(expected);
    });
  }
});

describe('the reflex and brief members keep the request-abort check of executeRaw', () => {
  // The warm CLI socket and the Rust owner IPC server abort a request whose client left; the Postgres engine then
  // refuses every later statement of it. The reflex and brief members delegate through executeRaw so that check stays.
  const scope = { sourceIds: ['default'], privacy: 'floor' as const };
  const calls: Array<[string, (e: any) => Promise<unknown>]> = [
    ['readReflexPages', e => e.readReflexPages(scope, { kind: 'slugs', slugs: ['people/alice-example'] })],
    ['readReflexLiveKeys', e => e.readReflexLiveKeys(scope, ['people/alice-example'])],
    ['readBriefEntityPages', e => e.readBriefEntityPages('default', ['people/alice-example'], { privacy: 'floor' })],
    ['readBriefMeetingPages', e => e.readBriefMeetingPages(['g1'], '2026-11-20', '2026-11-21~')],
    ['readBriefEmailAliasPages', e => e.readBriefEmailAliasPages('default', ['alice@example.com'])],
    ['readBriefWorldFacts', e => e.readBriefWorldFacts([7])],
    ['readBriefEditPage', e => e.readBriefEditPage('default', 'people/alice-example', 65536, { privacy: 'floor' })],
    ['readBriefTimelineEntry', e => e.readBriefTimelineEntry(5, '2026-11-01T00:00:00.000Z', { privacy: 'floor' })],
    ['readBriefPageVersions', e => e.readBriefPageVersions(5, '2026-11-01T00:00:00.000Z', 65536, 5)],
  ];
  for (const [method, call] of calls) {
    test(`${method} throws AbortError and sends no statement on an aborted request`, async () => {
      const { engine, fake } = makeEngineWithFake();
      const controller = new AbortController();
      controller.abort(new Error('client left'));
      const error = await withRequestSignal(controller.signal, () => call(engine)).then(() => undefined, (e: unknown) => e);
      expect((error as DOMException | undefined)?.name).toBe('AbortError');
      expect(fake.trace.filter(s => s.kind === 'query')).toEqual([]);
    });
  }
});

describe('the renumbered brief statements bind the same values in placeholder order', () => {
  const since = '2026-11-01T00:00:00.000Z';
  const cases: Array<[string, (e: any) => Promise<unknown>, unknown[]]> = [
    ['readBriefEditPage', e => e.readBriefEditPage('default', 'people/alice-example', 65536, { privacy: 'none' }), [65536, 'default', 'people/alice-example']],
    ['readBriefTimelineEntry', e => e.readBriefTimelineEntry(5, since, { privacy: 'none' }), [5, since, since]],
    ['readBriefPageVersions', e => e.readBriefPageVersions(5, since, 65536, 5), [65536, 5, since]],
  ];
  for (const [method, run, expected] of cases) {
    test(`${method} parameters`, async () => {
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method, variant: 'params', run }));
      expect(capture.error).toBeUndefined();
      expect(capture.trace.filter(s => s.kind === 'query').map(s => s.params)).toEqual([expected]);
    });
  }
  test('readBriefPageVersions refuses a limit that is not a positive integer and sends no statement', async () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'readBriefPageVersions', variant: 'bad-limit', run: e => e.readBriefPageVersions(5, since, 65536, limit) }));
      expect(capture.error).toStartWith('RangeError: readBriefPageVersions: limit must be a positive integer');
      expect(capture.trace.filter(s => s.kind === 'query')).toEqual([]);
    }
  });
});

describe('insertOauthClientGrant sends what insertClientGrant sends', () => {
  // The drift pin: grants/service.ts insertClientGrant stays the provider's path, so the member's constant text and
  // parameter order must keep matching the template it was captured from.
  test('same statement text and parameters for one planned client', async () => {
    const plan = planManualClient('pin-client', ['client_credentials'], 'read write', [], 'default', ['default']);
    const context = await grantValidationContext({ listAllSources: async () => [{ id: 'default' }] } as never);
    const grant = plan.grant(context);
    const sent = async (run: (e: any) => Promise<unknown>) => {
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'insert', variant: 'default', run }));
      expect(capture.error).toBeUndefined();
      return capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params }));
    };
    const template = await sent(e => insertClientGrant(sqlQueryForEngine(e), grant, plan.metadata));
    const member = await sent(e => e.insertOauthClientGrant(clientGrantInsert(grant, plan.metadata)));
    expect(template.length).toBe(1);
    expect(member).toEqual(template);
    expect(member[0].text).toBe(CREDENTIAL_SQL.client_grant_insert);
  });
});

describe('markedScopeSources sends the same statement through an engine as through a SqlQuery', () => {
  // The drift pin: the grant writes still pass a transaction SqlQuery (the template path); an engine caller now reads
  // through readScopeSourceConfigs. Both must send one text and one parameter list.
  for (const lock of [undefined, 'share', 'update'] as const) {
    test(`lock ${lock ?? 'none'}`, async () => {
      const sent = async (run: (e: any) => Promise<unknown>) => {
        const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'markedScopeSources', variant: lock ?? 'none', run }));
        expect(capture.error).toBeUndefined();
        return capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params }));
      };
      const ids = ['team-b', 'team-a', 'team-b'];
      const template = await sent(e => markedScopeSources(sqlQueryForEngine(e), ids, lock));
      const member = await sent(e => markedScopeSources(e, ids, lock));
      expect(template.length).toBe(1);
      expect(member).toEqual(template);
      expect(member[0].params).toEqual([JSON.stringify(['team-b', 'team-a'])]);
    });
  }
});

describe('the bearer check sends the same statements through an engine as through a SqlQuery', () => {
  // The drift pin: a provider built with only `sql` (no engine) keeps the template statements; serve --http passes its
  // engine, which reads through readOauthAccessTokenRows, readActiveAccessTokenByHash and touchAccessTokenLastUsed.
  const TOKEN_ROW = { id: '00000000-0000-4000-8000-0000000000b1', name: 'bearer', scopes: ['read'], permissions: {}, source_grant: 'default',
    source_id: null, federated_read: null, allowed_operations: null, takes_holders: null, grant_revision: 1, min_trust: null,
    private_pages: 'none', member_id: null, may_act_for: null, reads_unscoped: null, created_at: new Date(0) };
  const sent = async (rows: unknown[], degrade: number, run: (e: any) => Promise<unknown>) => {
    let failures = degrade;
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({
      method: 'verifyAccessToken', variant: 'default', run: async e => {
        await run(e).catch(() => undefined);
        await new Promise(r => setTimeout(r, 20)); // the last-use stamp is fire-and-forget
      },
      rows: [
        [/FROM oauth_tokens t/, () => { if (failures-- > 0) throw Object.assign(new Error('column "surface" does not exist'), { code: '42703' }); return []; }],
        [/SELECT \* FROM access_tokens/, rows],
        [/UPDATE access_tokens SET last_used_at/, []],
      ],
    }));
    expect(capture.error).toBeUndefined();
    return capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params }));
  };
  for (const degrade of [0, 4]) {
    test(`a legacy token with ${degrade} failed OAuth rungs`, async () => {
      const template = await sent([TOKEN_ROW], degrade, e => new GBrainOAuthProvider({ sql: sqlQueryForEngine(e) }).verifyAccessToken('tok'));
      const member = await sent([TOKEN_ROW], degrade, e => new GBrainOAuthProvider({ sql: sqlQueryForEngine(e), engine: e }).verifyAccessToken('tok'));
      expect(template.length).toBe(degrade + 3);
      expect(member).toEqual(template);
    });
  }
  test('an unknown token', async () => {
    const template = await sent([], 0, e => new GBrainOAuthProvider({ sql: sqlQueryForEngine(e) }).verifyAccessToken('tok'));
    const member = await sent([], 0, e => new GBrainOAuthProvider({ sql: sqlQueryForEngine(e), engine: e }).verifyAccessToken('tok'));
    expect(template.length).toBe(2);
    expect(member).toEqual(template);
  });
  for (const unified of [true, false]) {
    test(`touchTokenLastUsed on a ${unified ? 'unified' : 'legacy'} row`, async () => {
      const row: Record<string, unknown> = unified ? { id: TOKEN_ROW.id, source_grant: 'default' } : { id: TOKEN_ROW.id };
      const template = await sent([], 0, e => touchTokenLastUsed(sqlQueryForEngine(e), row));
      const member = await sent([], 0, e => touchTokenLastUsed(e, row));
      expect(template.length).toBe(1);
      expect(member).toEqual(template);
    });
  }
});

describe('a legacy-shape token converts with the same statement through an engine as through a SqlQuery', () => {
  // serve --http and the legacy transport pass their engine, so resolveTokenGrant runs convertLegacyAccessTokenGrant;
  // without an engine it keeps the template. Both send the same text and params and authorize the same grant.
  const LEGACY_ROW = { id: '00000000-0000-4000-8000-0000000000b2', name: 'legacy', scopes: null, source_grant: null, source_id: null,
    federated_read: null, allowed_operations: null, takes_holders: null, grant_revision: 0, created_at: new Date(0),
    permissions: { source_id: 'default', federated_read: ['default', 'wiki'], takes_holders: ['world', 'garry'] } };
  const converted = { ...LEGACY_ROW, source_grant: 'federated', source_id: 'default', federated_read: ['default', 'wiki'],
    takes_holders: ['garry', 'world'], grant_revision: 1 };
  const resolved = async (run: (e: any) => Promise<unknown>, returned: unknown[]) => {
    let grant: unknown;
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({
      method: 'resolveTokenGrant', variant: 'legacy', run: async e => { grant = await run(e); },
      rows: [[/UPDATE access_tokens SET source_grant/, returned]],
    }));
    expect(capture.error).toBeUndefined();
    return { grant, sent: capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params })) };
  };
  for (const [label, returned] of [['the row converts', [converted]], ['another reader converted it first', []]] as const) {
    test(label, async () => {
      const template = await resolved(e => resolveTokenGrant(sqlQueryForEngine(e), LEGACY_ROW), [...returned]);
      const member = await resolved(e => resolveTokenGrant(sqlQueryForEngine(e), LEGACY_ROW, e), [...returned]);
      expect(template.sent.length).toBe(1);
      expect(member).toEqual(template);
    });
  }
});

describe('the expired-credential sweep sends the same statements through an engine as through a SqlQuery', () => {
  // serve --http passes its engine, so sweepExpiredTokens runs deleteExpiredOauthCredentials; a provider built with only
  // `sql` keeps the template statements. Both send the same text and params and return the same count.
  const swept = async (run: (e: any) => Promise<number>) => {
    let count: number | undefined;
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({
      method: 'sweepExpiredTokens', variant: 'default', run: async e => { count = await run(e); },
      rows: [[/DELETE FROM oauth_tokens/, [{ '?column?': 1 }, { '?column?': 1 }]], [/DELETE FROM oauth_codes/, [{ '?column?': 1 }]]],
    }));
    expect(capture.error).toBeUndefined();
    return { count, sent: capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params })) };
  };
  test('two expired tokens and one expired code', async () => {
    const template = await swept(e => new GBrainOAuthProvider({ sql: sqlQueryForEngine(e) }).sweepExpiredTokens());
    const member = await swept(e => new GBrainOAuthProvider({ sql: sqlQueryForEngine(e), engine: e }).sweepExpiredTokens());
    expect(template.sent.length).toBe(2);
    expect(template.count).toBe(3);
    expect({ ...member, sent: member.sent.map(s => ({ ...s, params: s.params.map(() => 'now') })) })
      .toEqual({ ...template, sent: template.sent.map(s => ({ ...s, params: s.params.map(() => 'now') })) });
  });
});

describe('insertOauthToken sends what OAuthGrants.issue sends', () => {
  // The drift pin for a grant built without the transaction handle (mcp-provision, auth.ts): issue() sends the templates
  // through the grant transaction's SqlQuery, so the member's constant text and parameter order must keep matching them.
  // The next describe pins the handle route (what serve --http runs) against the same statements.
  const NOW = 1_700_000_000_000;
  const CLIENT = { client_id: 'pin-oauth', client_name: 'pin', grant_types: ['client_credentials'], scope: 'read write', client_secret_hash: hashToken('secret'),
    client_secret_expires_at: 0, deleted_at: null };
  for (const marked of [true, false]) {
    test(marked ? 'a schema with grant_type' : 'a schema without grant_type', async () => {
      const client = marked ? { ...CLIENT, attest_actor: false } : CLIENT;
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase({
        method: 'issue', variant: marked ? 'grant' : 'plain',
        rows: [[/FROM oauth_clients WHERE client_id = \$1 FOR UPDATE/, [client]]],
        run: async e => {
          const grants = new OAuthGrants({ sql: sqlQueryForEngine(e), transaction: fn => fn(sqlQueryForEngine(e)) as never, tokenTtl: 3600, refreshTtl: 86400, now: () => NOW });
          await grants.clientCredentials('pin-oauth', 'secret');
        },
      }));
      expect(capture.error).toBeUndefined();
      const template = capture.trace.flatMap(t => (t.kind === 'query' && /INSERT INTO oauth_tokens/.test(t.text) ? [{ text: t.text, params: t.params as unknown[] }] : []));
      expect(template.length).toBe(1);
      expect(template[0].text).toBe(marked ? OAUTH_TOKEN_SQL.insert_grant : OAUTH_TOKEN_SQL.insert_plain);
      const [hash, type, clientId, scopes, expiresAt, resource, created, grantType] = template[0].params;
      expect([type, clientId, scopes, expiresAt, resource, created, grantType]).toEqual(['access', 'pin-oauth', '{"read","write"}', NOW / 1000 + 3600, null, NOW / 1000, ...(marked ? ['client_credentials'] : [])]);
      const row = { token_hash: hash as string, token_type: 'access' as const, client_id: 'pin-oauth', scopes: ['read', 'write'], expires_at: expiresAt as number, resource: null, created_at: created as number,
        ...(marked ? { grant_type: 'client_credentials' as const } : {}) };
      const member = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'insertOauthToken', variant: marked ? 'grant' : 'plain', run: e => e.insertOauthToken(row) }));
      expect(member.error).toBeUndefined();
      expect(member.trace.flatMap(t => (t.kind === 'query' ? [{ text: t.text, params: t.params }] : []))).toEqual(template);
    });
  }
});

describe('the OAuth code flow and the token grant send the same statements through the transaction handle as through the SqlQuery', () => {
  // serve --http hands the grant transaction's engine handle to OAuthGrants (`fn(sql, tx)`): the client lock, the code
  // and the token INSERTs then run as members (a store with no raw SQL runs them in one write). A grant built without
  // the handle keeps the templates. Both routes must send the same text and params, in the same order.
  const NOW = 1_700_000_000_000;
  const VERIFIER = 'v'.repeat(43);
  const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
  const REDIRECT = 'https://client.example/callback';
  const CLIENT = { client_id: 'pin-code', client_name: 'pin', grant_types: ['authorization_code', 'client_credentials'], redirect_uris: [REDIRECT], scope: 'read write',
    client_secret_hash: hashToken('secret'), client_secret_expires_at: 0, deleted_at: null, grant_revision: 0, registered_via: 'manual', attest_actor: false };
  const CODE_ROW = { code_hash: 'x', client_id: 'pin-code', scopes: ['read'], code_challenge: CHALLENGE, code_challenge_method: 'S256', redirect_uri: REDIRECT,
    state: null, resource: null, expires_at: NOW / 1000 + 300, created_at: new Date(NOW) };
  const REFRESH_ROW = { token_hash: 'r', token_type: 'refresh', client_id: 'pin-code', scopes: ['read'], expires_at: NOW / 1000 + 3600, resource: null, created_at: new Date(NOW) };
  const sentBy = async (variant: string, run: (e: any) => Promise<unknown>) => {
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'issue', variant, run: async e => { await run(e); },
      rows: [[/FROM oauth_clients WHERE client_id = \$1/, [CLIENT]], [/FROM oauth_codes WHERE code_hash/, [CODE_ROW]], [/SELECT code_challenge FROM oauth_codes/, [{ code_challenge: CHALLENGE }]], [/FROM oauth_tokens WHERE token_hash = \$1 AND token_type = 'refresh'/, [REFRESH_ROW]]] }));
    expect(capture.error).toBeUndefined();
    // The random code and token hashes differ per run; every other parameter must match.
    return capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: (s.params as unknown[]).map(p => typeof p === 'string' && /^[a-f0-9]{64}$/.test(p) ? 'hash' : p) }));
  };
  const grants = (e: any, handle: boolean) => new OAuthGrants({ sql: sqlQueryForEngine(e), ...(handle ? { engine: e } : {}),
    transaction: fn => (handle ? fn(sqlQueryForEngine(e), e) : fn(sqlQueryForEngine(e))) as never, tokenTtl: 3600, refreshTtl: 86400, now: () => NOW });
  const flow = (handle: boolean) => async (e: any) => {
    const g = grants(e, handle);
    const id = await g.begin('pin-code', { redirectUri: REDIRECT, codeChallenge: CHALLENGE, scopes: ['read'], state: undefined } as never);
    const code = new URL(await g.decide(id, true)).searchParams.get('code')!;
    const issued = await g.exchangeCode('pin-code', code, VERIFIER, REDIRECT, undefined, hashToken('secret'));
    await g.refresh('pin-code', issued.refresh_token!, undefined, undefined, hashToken('secret'));
    await g.clientCredentials('pin-code', 'secret');
    await new GBrainOAuthProvider({ sql: sqlQueryForEngine(e), ...(handle ? { engine: e } : {}) }).challengeForAuthorizationCode({ client_id: 'pin-code' } as never, code);
  };
  test('begin, decide, the code lookup, exchangeCode, refresh and clientCredentials', async () => {
    const template = await sentBy('flow-template', flow(false));
    const member = await sentBy('flow-member', flow(true));
    expect(template.map(s => s.text.trim().split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'SELECT * FROM', 'SELECT * FROM', 'INSERT INTO oauth_codes', 'SELECT * FROM', 'SELECT * FROM',
      'DELETE FROM oauth_codes', 'INSERT INTO oauth_tokens', 'INSERT INTO oauth_tokens', 'SELECT * FROM', 'SELECT * FROM', 'DELETE FROM oauth_tokens',
      'INSERT INTO oauth_tokens', 'INSERT INTO oauth_tokens', 'SELECT * FROM', 'INSERT INTO oauth_tokens', 'SELECT code_challenge FROM']);
    expect(member).toEqual(template);
  });
  test('the member texts are the constants the templates were captured into', async () => {
    const sent = await sentBy('flow-constants', flow(true));
    const texts = new Set(sent.map(s => s.text));
    for (const text of [CLIENT_GRANT_SQL.client_for_update, OAUTH_CODE_SQL.insert, OAUTH_CODE_SQL.for_update, OAUTH_CODE_SQL.delete, OAUTH_CODE_SQL.challenge, OAUTH_TOKEN_SQL.insert_grant, OAUTH_REFRESH_SQL.for_update, OAUTH_REFRESH_SQL.delete]) {
      expect(texts.has(text)).toBe(true);
    }
  });
  test('the refresh-token read and delete members send their constants with the hash and client id', async () => {
    const read = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'readOauthRefreshTokenForUpdate', variant: 'member', run: e => e.readOauthRefreshTokenForUpdate('h', 'pin-code') }));
    const del = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'deleteOauthRefreshToken', variant: 'member', run: e => e.deleteOauthRefreshToken('h', 'pin-code') }));
    for (const [capture, text] of [[read, OAUTH_REFRESH_SQL.for_update], [del, OAUTH_REFRESH_SQL.delete]] as const) {
      expect(capture.error).toBeUndefined();
      expect(capture.trace.flatMap(t => (t.kind === 'query' ? [{ text: t.text, params: t.params }] : []))).toEqual([{ text, params: ['h', 'pin-code'] }]);
    }
  });
  test('the restore quarantine member sends the two expiry statements restore.ts sent, tokens first, with no params', async () => {
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'expireAllOauthCredentials', variant: 'member', run: e => e.expireAllOauthCredentials() }));
    expect(capture.error).toBeUndefined();
    expect(OAUTH_EXPIRE_ALL_SQL).toEqual({ tokens: 'UPDATE oauth_tokens SET expires_at=0', codes: 'UPDATE oauth_codes SET expires_at=0' });
    expect(capture.trace.flatMap(t => (t.kind === 'query' ? [t.text] : []))).toEqual([OAUTH_EXPIRE_ALL_SQL.tokens, OAUTH_EXPIRE_ALL_SQL.codes]);
  });
  test('the pending-write health member sends the two statements serve-http-admin-api.ts sent, in flight first, with no params', async () => {
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'readPendingWriteHealth', variant: 'member', run: e => e.readPendingWriteHealth() }));
    expect(capture.error).toBeUndefined();
    // The texts at 982540fd6e src/commands/serve-http-admin-api.ts:90-96, byte for byte.
    expect(PENDING_WRITE_HEALTH_SQL.pending).toBe(`SELECT count(*)::int AS count,
    COALESCE(floor(extract(epoch FROM now() - min(created_at))), 0)::int AS oldest_age_seconds
    FROM persistence_requests WHERE state IN ('queued', 'deferred', 'running', 'recovering')`);
    expect(PENDING_WRITE_HEALTH_SQL.later_failed).toBe(`SELECT count(DISTINCT r.id)::int AS count FROM mcp_request_log l
    JOIN persistence_requests r ON r.request_id::text = l.params->>'write_request_id'
    WHERE l.status = 'accepted_pending' AND l.created_at > now() - interval '24 hours'
      AND r.state IN ('conflict', 'failed', 'cancelled')`);
    expect(capture.trace.flatMap(t => (t.kind === 'query' ? [t.text] : []))).toEqual([PENDING_WRITE_HEALTH_SQL.pending, PENDING_WRITE_HEALTH_SQL.later_failed]);
  });
  test('the request-log page member sends the list and count serve-http-admin-api.ts sent, filters numbered in order', async () => {
    const queries = async (spec: Parameters<import('../src/core/engine.ts').BrainEngine['readMcpRequestLogPage']>[0]) => {
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'readMcpRequestLogPage', variant: 'member', run: e => e.readMcpRequestLogPage(spec) }));
      expect(capture.error).toBeUndefined();
      return capture.trace.flatMap(t => (t.kind === 'query' ? [{ text: t.text, params: t.params }] : []));
    };
    // The texts at 0b8fde313c src/commands/serve-http-admin-api.ts:509-519, byte for byte, with the filters built there.
    const list = (filterSql: string, limit: string, offset: string) => `SELECT id, token_name, COALESCE(agent_name, token_name) as agent_name,
                operation, latency_ms, status, params, error_message, created_at
         FROM mcp_request_log
         WHERE 1=1 ${filterSql}
         ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`;
    const count = (filterSql: string) => `SELECT count(*)::int as total FROM mcp_request_log
         WHERE 1=1 ${filterSql}`;
    expect(await queries({ limit: 50, offset: 0 })).toEqual([{ text: list('', '$1', '$2'), params: [50, 0] }, { text: count(''), params: [] }]);
    expect(await queries({ tokenName: 'a', operation: null, status: 'error', limit: 50, offset: 100 })).toEqual([
      { text: list('AND token_name = $1 AND status = $2', '$3', '$4'), params: ['a', 'error', 50, 100] },
      { text: count('AND token_name = $1 AND status = $2'), params: ['a', 'error'] },
    ]);
    expect(await queries({ tokenName: 'a', operation: 'search', status: 'ok', limit: 50, offset: 0 })).toEqual([
      { text: list('AND token_name = $1 AND operation = $2 AND status = $3', '$4', '$5'), params: ['a', 'search', 'ok', 50, 0] },
      { text: count('AND token_name = $1 AND operation = $2 AND status = $3'), params: ['a', 'search', 'ok'] },
    ]);
  });
  test('the calibration take reads send the statements serve-http-admin-api.ts sent', async () => {
    // The texts at 0b8fde313c src/commands/serve-http-admin-api.ts:357-361 and 441-448, byte for byte.
    expect(TOP_RESOLVED_TAKES_SQL).toBe(`SELECT t.id::text AS id, p.slug AS page_slug, t.row_num, t.claim, t.weight, t.resolved_quality, t.since_date
           FROM takes t JOIN pages p ON p.id = t.page_id
           WHERE t.holder = $1 AND t.active = true AND t.resolved_at IS NOT NULL
           ORDER BY t.weight DESC, t.since_date DESC, t.id
           LIMIT 25`);
    expect(ABANDONED_TAKES_SQL).toBe(`SELECT t.id, p.slug AS page_slug, t.claim, t.weight, t.since_date
             FROM takes t JOIN pages p ON p.id = t.page_id
             WHERE t.active = true AND t.resolved_at IS NULL AND t.superseded_by IS NULL
               AND t.weight >= 0.7
               AND (t.since_date || CASE WHEN length(t.since_date) = 7 THEN '-01' ELSE '' END)::date
                   < (now() - INTERVAL '12 months')
             ORDER BY t.since_date ASC, t.id
             LIMIT 5`);
    const top = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'listTopResolvedTakesForHolder', variant: 'member', run: e => e.listTopResolvedTakesForHolder('alice-example') }));
    const abandoned = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'listAbandonedTakes', variant: 'member', run: e => e.listAbandonedTakes() }));
    const expected: Array<[typeof top, string, unknown[]]> = [[top, TOP_RESOLVED_TAKES_SQL, ['alice-example']], [abandoned, ABANDONED_TAKES_SQL, []]];
    for (const [capture, text, params] of expected) {
      expect(capture.error).toBeUndefined();
      expect(capture.trace.flatMap(t => (t.kind === 'query' ? [{ text: t.text, params: t.params }] : []))).toEqual([{ text, params }]);
    }
  });
  test('issueOauthTokens runs on the transaction handle, never on the pool', async () => {
    // The client row is locked by the grant's transaction: a token INSERT on another connection waits on its foreign key.
    const used: string[] = [];
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'issue', variant: 'handle', rows: [[/FROM oauth_clients WHERE client_id = \$1/, [CLIENT]]],
      run: async pool => {
        const names = ['readOauthClientForUpdate', 'issueOauthTokens'];
        const originals = Object.fromEntries(names.map(name => [name, (pool as any)[name].bind(pool)]));
        const tx = Object.create(pool);
        for (const name of names) {
          (pool as any)[name] = (...args: unknown[]) => { used.push(`pool.${name}`); return originals[name](...args); };
          tx[name] = (...args: unknown[]) => { used.push(`tx.${name}`); return originals[name](...args); };
        }
        const g = new OAuthGrants({ sql: sqlQueryForEngine(pool), engine: pool, transaction: fn => fn(sqlQueryForEngine(tx), tx) as never, tokenTtl: 3600, refreshTtl: 86400, now: () => NOW });
        await g.clientCredentials('pin-code', 'secret');
      } }));
    expect(capture.error).toBeUndefined();
    expect(used).toEqual(['tx.readOauthClientForUpdate', 'tx.issueOauthTokens']);
  });
});

describe('the typed job reads of the refusal-swallow fixes send the statement their callers sent, with the same parameters', () => {
  // Copied verbatim from the callers at b7b18e5ab3 (src/core/remediation/run.ts manualOnlySkips, src/commands/autopilot-fanout.ts
  // readRecentSourceFailures: the base text, then ` AND data->>'source_id' = $2` for one source, then ` GROUP BY ...`).
  const UNFINISHED = `SELECT id, name, status FROM minion_jobs
          WHERE name = ANY($1::text[]) AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
          ORDER BY id`;
  const FAILURES = `SELECT data->>'source_id' AS source_id,
              count(*)::int AS fail_count,
              max(finished_at) AS last_failed_at
         FROM minion_jobs
        WHERE name = 'autopilot-cycle'
          AND status IN ('dead','failed')
          AND (result->>'job_outcome' IS NULL OR result->>'job_outcome' <> 'phase_failed')
          AND data->>'source_id' IS NOT NULL
          AND finished_at IS NOT NULL
          AND finished_at > $1 GROUP BY data->>'source_id'`;
  const FAILURES_ONE_SOURCE = `SELECT data->>'source_id' AS source_id,
              count(*)::int AS fail_count,
              max(finished_at) AS last_failed_at
         FROM minion_jobs
        WHERE name = 'autopilot-cycle'
          AND status IN ('dead','failed')
          AND (result->>'job_outcome' IS NULL OR result->>'job_outcome' <> 'phase_failed')
          AND data->>'source_id' IS NOT NULL
          AND finished_at IS NOT NULL
          AND finished_at > $1 AND data->>'source_id' = $2 GROUP BY data->>'source_id'`;
  const sent = async (run: (e: any) => Promise<unknown>) => {
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'pin', variant: 'default', run }));
    expect(capture.error).toBeUndefined();
    return capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params }));
  };

  test('listUnfinishedJobsByName: the old text (one read, ordered by id) and the names as one array parameter', async () => {
    expect(await sent(e => e.listUnfinishedJobsByName(['unify-types', 'extract-takes-from-pages'])))
      .toEqual([{ text: UNFINISHED, params: [['unify-types', 'extract-takes-from-pages']] }]);
  });

  test('listRecentSourceCycleFailures: the old 471-byte statement and the cutoff, unscoped', async () => {
    const cutoff = '2026-11-23T00:00:00.000Z';
    expect(Buffer.byteLength(FAILURES)).toBe(471);
    expect(await sent(e => e.listRecentSourceCycleFailures({ cutoff }))).toEqual([{ text: FAILURES, params: [cutoff] }]);
  });

  test('listRecentSourceCycleFailures: the old 499-byte statement, the cutoff then the source id, for one source', async () => {
    const cutoff = '2026-11-23T00:00:00.000Z';
    expect(Buffer.byteLength(FAILURES_ONE_SOURCE)).toBe(499);
    expect(await sent(e => e.listRecentSourceCycleFailures({ cutoff, sourceId: 'src-1' }))).toEqual([{ text: FAILURES_ONE_SOURCE, params: [cutoff, 'src-1'] }]);
  });

  test('listRecentSourceCycleFailures: an empty or null source id is no filter (the unscoped statement)', async () => {
    const cutoff = '2026-11-23T00:00:00.000Z';
    for (const sourceId of ['', null, undefined]) {
      expect(await sent(e => e.listRecentSourceCycleFailures({ cutoff, sourceId }))).toEqual([{ text: FAILURES, params: [cutoff] }]);
    }
  });
});
