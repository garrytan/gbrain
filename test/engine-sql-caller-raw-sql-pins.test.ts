/**
 * Byte-identical pins for the caller raw SQL that became typed engine members (Rust engine lane 11).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text its caller ran through `executeRaw` before the
 *    move. Each expected text below is copied verbatim from the caller at the commit its `from` names (7470c703ed
 *    unless it says otherwise), except where a pin's comment names an equivalent statement.
 *  - Regression: an edited statement changes what Postgres and PGLite answer while the parity cases may still pass on
 *    a small fixture.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts),
 *    and these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records the text; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { runCase, withPinnedSqlEnvironment, type SqlCase } from './helpers/postgres-engine-sql-cases.ts';
import { FACT_PREIMAGE_SQL } from '../src/core/engine-sql/facts.ts';
import { TAKE_PREIMAGE_SQL } from '../src/core/engine-sql/takes-reads.ts';
import { trustRankSql } from '../src/core/trust/tier.ts';
import { edgeTrimSql } from '../src/core/edge-whitespace.ts';
import { budgetRowAppliesFilter } from '../src/core/page-size-policy.ts';
import { chunkGenerationFilter } from '../src/core/search/safe-chunks.ts';
import { quoteIdentifier } from '../src/core/search/embedding-column.ts';
import { retiredPageSql } from '../src/core/entities/resolve.ts';
import { rankingLinkSql } from '../src/core/link-ranking-policy.ts';
import { boundedBodyPrefixSql } from '../src/core/page-window/bounded-lead.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';
import { syncDeleteOrigin } from '../src/core/persistence/sync-delete-tombstones.ts';
import { MANAGED_MODE_SQL } from '../src/core/persistence/managed-mode.ts';
import { syncAdmissionEffectSql, syncAdmissionSettingSql } from '../src/core/persistence/sync-admission.ts';
import { GIT_PUSH_CODES } from '../src/core/persistence/git-push-holds.ts';
import { ACTIVE_REFRESH_STATES_SQL } from '../src/core/persistence/worktree-refresh-schema.ts';
import { APPLE_CONTACTS_PENDING_DELETES_OP, APPLE_CONTACTS_REVIEW_OP } from '../src/core/apple-contacts/review-status.ts';
import { identityDowngradeOpen } from '../src/core/sync-identity-downgrades.ts';
import { EFFECT_BYTES_SQL } from '../src/core/persistence/receipt-bytes.ts';
import { callerAccessAllowedSql, privateLinkOriginFilterForCaller, privatePagesFilterForCaller, remoteReadFloorSql } from '../src/core/search/private-visibility.ts';

/** caller.ts MEMBER_SQL at 7470c703ed: MEMBERS_WHERE_SQL(`m.id = (${member})`), copied verbatim. */
const memberSql = (member: string) => `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = (${member}) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`;

interface Pin {
  /** The caller site the statement came from, at 7470c703ed. */
  from: string;
  case: SqlCase;
  /** The statement texts, in order, as the caller sent them; a function renders them in the pinned environment. */
  texts: string[] | (() => string[]);
}

const PINS: Pin[] = [
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
    from: 'src/core/mentions/pass.ts:148 (at 0af1a6ecf0)',
    case: { method: 'listMentionSourceIds', variant: 'default', run: e => e.listMentionSourceIds() },
    texts: () => { return ['SELECT id FROM sources ORDER BY id']; },
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
  {
    from: 'src/core/mentions/pass.ts:423 (at 0af1a6ecf0)',
    case: { method: 'listMentionCandidatePages', variant: 'ascii', run: e => e.listMentionCandidatePages(['default'], 0, 500, ['%alice%']) },
    texts: () => { const ascii = true; return [`SELECT id, slug, source_id, body_storage, COALESCE(title, '') || E'\\n\\n' || COALESCE(compiled_truth, '') || E'\\n\\n' || COALESCE(timeline, '') AS body,
              frontmatter->'mention_ignore' AS mention_ignore
         FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND id > $2
          ${ascii ? `AND (body_storage = 'segmented' OR lower(COALESCE(title, '') || ' ' || COALESCE(compiled_truth, '') || ' ' || COALESCE(timeline, '')) LIKE ANY($4::text[]))` : ''}
        ORDER BY id LIMIT $3`]; },
  },
  {
    from: 'src/core/mentions/pass.ts:423 (at 0af1a6ecf0)',
    case: { method: 'listMentionCandidatePages', variant: 'all', run: e => e.listMentionCandidatePages(['default'], 0, 500, null) },
    texts: () => { const ascii = false; return [`SELECT id, slug, source_id, body_storage, COALESCE(title, '') || E'\\n\\n' || COALESCE(compiled_truth, '') || E'\\n\\n' || COALESCE(timeline, '') AS body,
              frontmatter->'mention_ignore' AS mention_ignore
         FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND id > $2
          ${ascii ? `AND (body_storage = 'segmented' OR lower(COALESCE(title, '') || ' ' || COALESCE(compiled_truth, '') || ' ' || COALESCE(timeline, '')) LIKE ANY($4::text[]))` : ''}
        ORDER BY id LIMIT $3`]; },
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
    from: 'src/core/by-mention.ts:527 (at 0af1a6ecf0)',
    case: { method: 'listGazetteerPages', variant: 'default', run: e => e.listGazetteerPages(['person'], ['x_handle', 'twitter', 'twitter_handle', 'x']) },
    texts: () => { return [`SELECT slug, source_id, title, type, (frontmatter ->> 'google_contact_id') IS NOT NULL AS connector_stub,
            frontmatter ->> $2 AS h1, frontmatter ->> $3 AS h2, frontmatter ->> $4 AS h3, frontmatter ->> $5 AS h4
     FROM pages
     WHERE type = ANY($1::text[])
       AND deleted_at IS NULL`]; },
  },
  {
    from: 'src/core/by-mention.ts:550 (at 0af1a6ecf0)',
    case: { method: 'listGazetteerAliases', variant: 'default', run: e => e.listGazetteerAliases(['person']) },
    texts: () => { return [`SELECT pa.alias_norm, pa.slug, pa.source_id, p.title, p.type, pa.origin, pa.case_sensitive, pa.alias_text, p.frontmatter->>'identity' AS identity
       FROM page_aliases pa
       JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id
       WHERE p.type = ANY($1::text[])
         AND p.deleted_at IS NULL`]; },
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
    from: 'src/core/access/caller.ts:376 appliedAccessSummary',
    case: { method: 'listAppliedPolicyRevisions', variant: 'default', run: e => e.listAppliedPolicyRevisions() },
    texts: [`SELECT s.source_id, (SELECT r.revision FROM access_policy_revisions r WHERE r.source_id = s.source_id AND r.applied_at IS NOT NULL
          ORDER BY r.revision DESC LIMIT 1) AS rev FROM access_policy_state s ORDER BY s.source_id`],
  },
  {
    from: 'src/core/reason-trailers.ts:262 cachedSyncReasonScan',
    case: { method: 'readSourcePurgeEpoch', variant: 'default', run: e => e.readSourcePurgeEpoch('default') },
    texts: ['SELECT purge_epoch FROM sources WHERE id = $1'],
  },
  {
    from: 'src/core/minions/submission-authority.ts:144 assertCurrentRemoteJobPrincipal (OAuth client)',
    case: { method: 'readJobPrincipal', variant: 'oauth-client', run: e => e.readJobPrincipal({ kind: 'oauth_client', id: 'client-1' }) },
    texts: ['SELECT client_id, deleted_at, scope, source_id, bound_slug_prefixes, surface, allowed_operations FROM oauth_clients WHERE client_id = $1'],
  },
  {
    from: 'src/core/minions/submission-authority.ts:160 assertCurrentRemoteJobPrincipal (legacy token)',
    case: { method: 'readJobPrincipal', variant: 'legacy-token', run: e => e.readJobPrincipal({ kind: 'legacy_token', id: 'tok-1' }) },
    texts: ['SELECT * FROM access_tokens WHERE id = $1'],
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
    from: 'src/core/access/caller.ts:253 resolveAudienceIdentities (members, then groups)',
    case: { method: 'readAudiencePrincipals', variant: 'members-and-groups', run: e => e.readAudiencePrincipals(['alice-example'], ['team-a']) },
    texts: [`SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
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
    from: 'src/core/access/members.ts:124 getMember (one member by id)',
    case: { method: 'readAccessMembers', variant: 'by-id', run: e => e.readAccessMembers({ id: 'alice-example' }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.id = $1 GROUP BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:160 memberByEmail and :143 assertEmailFree (members declaring one email)',
    case: { method: 'readAccessMembers', variant: 'by-email', run: e => e.readAccessMembers({ email: 'alice@example.com' }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.email = $1 GROUP BY m.id ORDER BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:129 listMembers (removed members filtered out)',
    case: { method: 'readAccessMembers', variant: 'live', run: e => e.readAccessMembers({ includeRemoved: false }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.tombstoned_at IS NULL GROUP BY m.id ORDER BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:129 listMembers (--all)',
    case: { method: 'readAccessMembers', variant: 'all', run: e => e.readAccessMembers({ includeRemoved: true }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id GROUP BY m.id ORDER BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:199 legacyTokenByName (active tokens with one name)',
    case: { method: 'readAccessCredentials', variant: 'token-name', run: e => e.readAccessCredentials({ tokenName: 'laptop' }) },
    texts: ['SELECT id::text AS id, name FROM access_tokens WHERE name = $1 AND revoked_at IS NULL ORDER BY created_at'],
  },
  {
    from: 'src/core/access/members.ts:305/307 boundCredentials (tokens, then clients)',
    case: { method: 'readAccessCredentials', variant: 'member', run: e => e.readAccessCredentials({ memberId: 'alice-example' }) },
    texts: ['SELECT id::text AS id, name FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL ORDER BY name',
      "SELECT client_id AS id, client_name AS name FROM oauth_clients WHERE member_id = $1 AND (to_jsonb(oauth_clients)->>'deleted_at') IS NULL ORDER BY client_id"],
  },
  {
    from: 'src/core/access/members.ts:295 audienceMemberIds',
    case: { method: 'listAudienceAccessMembers', variant: 'default', run: e => e.listAudienceAccessMembers() },
    texts: ["SELECT id FROM access_members WHERE kind = 'audience' AND disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id"],
  },
  {
    from: 'src/core/access/caller.ts:94 liveIdentity (member id: :120 stdioMember, :146 stdioMemberIdentity)',
    case: { method: 'readLiveMember', variant: 'member', run: e => e.readLiveMember('member', 'alice-example') },
    texts: [memberSql('$1')],
  },
  {
    from: 'src/core/access/caller.ts:94 liveIdentity (stdio config: :121)',
    case: { method: 'readLiveMember', variant: 'stdio-config', run: e => e.readLiveMember('stdio_config', 'mcp.stdio_member') },
    texts: [memberSql(`SELECT ${edgeTrimSql('value')} FROM config WHERE key = $1`)],
  },
  {
    from: 'src/core/access/caller.ts:94 liveIdentity (legacy token: :123)',
    case: { method: 'readLiveMember', variant: 'legacy-token', run: e => e.readLiveMember('legacy_token', 'tok-1') },
    texts: [memberSql('SELECT member_id FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL')],
  },
  {
    from: 'src/core/access/caller.ts:94 liveIdentity (OAuth client: :123)',
    case: { method: 'readLiveMember', variant: 'oauth-client', run: e => e.readLiveMember('oauth_client', 'client-1') },
    texts: [memberSql('SELECT member_id FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL')],
  },
  {
    from: 'src/core/access/caller.ts:170 folderAccessForAll (no readers: the rules read is skipped)',
    case: { method: 'readFolderAccess', variant: 'no_readers', run: e => e.readFolderAccess([]) },
    texts: [`SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id, prefix`],
  },
  {
    from: 'src/core/access/caller.ts:170 folderAccessForAll',
    case: { method: 'readFolderAccess', variant: 'readers', run: e => e.readFolderAccess(['member:alice-example', 'group:team-a']) },
    texts: [
      'SELECT source_id, rule_id, readable_by FROM access_rules WHERE readable_by && $1::text[]',
      `SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id, prefix`,
    ],
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
    from: 'src/core/access/policy.ts:117 appliedRules (at 6e123afe98)',
    case: { method: 'listAccessRules', variant: 'default', run: e => e.listAccessRules('src-a') },
    texts: ['SELECT rule_id, prefix, readable_by, covers_derived FROM access_rules WHERE source_id = $1 ORDER BY rule_id'],
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
    from: 'src/core/access/policy.ts:136 coverageRows (at 6e123afe98)',
    case: { method: 'listAccessCoverage', variant: 'default', run: e => e.listAccessCoverage('src-a') },
    texts: ['SELECT prefix, reason, revision, detail FROM access_pending_coverage WHERE source_id = $1 ORDER BY reason, prefix'],
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
    from: 'src/core/access/policy.ts:348 previewApply (derived release) (at 6e123afe98)',
    case: { method: 'listAccessPrefixSlugs', variant: 'one-prefix', run: e => e.listAccessPrefixSlugs('src-a', 'team/') },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND starts_with(slug, $2) ORDER BY slug'],
  },
  {
    from: 'src/core/access/policy.ts:354 previewApply (widened prefixes) (at 6e123afe98)',
    case: { method: 'listAccessPrefixSlugs', variant: 'prefixes', run: e => e.listAccessPrefixSlugs('src-a', ['team/', 'old/']) },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE starts_with(slug, pfx)) ORDER BY slug'],
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
      WHERE NOT s.archived ORDER BY s.id`],
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
      ORDER BY s.id LIMIT 200`],
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
      ORDER BY s.id LIMIT 200`],
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
    from: 'src/core/notifier/status.ts:130 readNotifierBlock (the markers; at f24fef9a03)',
    case: { method: 'listSourceWantedMarkers', variant: 'default', run: e => e.listSourceWantedMarkers('source-a') },
    texts: ['SELECT intent, wanted_head, first_due_at, requested_by FROM sync_wanted_markers WHERE source_id = $1 ORDER BY first_due_at, intent'],
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
  {
    from: 'src/commands/sync/plain-directory.ts:36 plainDirectorySyncRoot',
    case: { method: 'readPlainSyncSource', variant: 'default', run: e => e.readPlainSyncSource('default') },
    texts: ['SELECT local_path,last_commit,config FROM sources WHERE id=$1 AND NOT archived'],
  },
  {
    from: 'src/core/verbs/entity-card-identity.ts:141 readSiblingIdentity',
    case: { method: 'readEntityAliasRows', variant: 'siblings', run: e => e.readEntityAliasRows('default', ['people/alice-example', 'people/alice-twin']) },
    texts: ['SELECT slug, alias_norm, origin, alias_text FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY alias_norm'],
  },
  {
    // readAka ran `SELECT alias_norm FROM page_aliases WHERE source_id = $1 AND slug = $2 ORDER BY alias_norm`. It now
    // sends the sibling statement with a one-slug array: the same rows in the same order (one slug, so no tie).
    from: 'src/core/verbs/entity-card.ts:783 readAka (one slug)',
    case: { method: 'readEntityAliasRows', variant: 'aka', run: e => e.readEntityAliasRows('default', ['people/alice-example']) },
    texts: ['SELECT slug, alias_norm, origin, alias_text FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY alias_norm'],
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
    from: 'src/core/entity-identity.ts:220 listEntityIdentities',
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
       ORDER BY ei.entity_id, ei.canonical DESC, ei.source_id, p.slug`];
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
  {
    from: 'src/core/access/owner-only.ts:56 ownerOnlySourcesPresent',
    case: { method: 'readOwnerOnlySourcesPresent', variant: 'default', run: e => e.readOwnerOnlySourcesPresent() },
    // The version-aware test (ownerOnlyLineageReadable): a current schema reads the lineage function; below v320 the source test alone.
    texts: ['SELECT gbrain_owner_only_lineage() AS present'],
  },
  {
    from: 'src/core/access/owner-only.ts:66 sourceIsOwnerOnly',
    case: { method: 'readOwnerOnlySourceConfig', variant: 'default', run: e => e.readOwnerOnlySourceConfig('default') },
    texts: ['SELECT config FROM sources WHERE id = $1'],
  },
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
  ...([
    ['none', () => ''],
    ['caller', () => `AND ${privatePagesFilterForCaller('p')}`],
    ['floor', () => `AND ${remoteReadFloorSql('p')}`],
  ] as const).flatMap(([privacy, predicate]): Pin[] => [
    {
      from: `src/core/entities/resolve.ts:519 resolveStrictEntityReference same name (privacy ${privacy})`,
      case: { method: 'readTrigramCandidates', variant: `same_name_${privacy}`, run: e => e.readTrigramCandidates('default', { arm: 'same_name', titleLc: 'alice example', slugFragment: 'alice-example', privacy }) },
      texts: () => [`SELECT p.slug, p.title, p.type FROM pages p
          WHERE p.source_id = $1 AND p.deleted_at IS NULL ${predicate()} AND NOT ${retiredPageSql('p')}
            AND (lower(p.title) % $2 OR p.slug ILIKE '%' || $3 || '%')
          ORDER BY GREATEST(similarity(lower(p.title), $2), similarity(p.slug, $3)) DESC, p.slug ASC
          LIMIT 5`],
    },
    {
      from: `src/core/entities/resolve.ts:567 entityReferenceCandidates near (privacy ${privacy})`,
      case: { method: 'readTrigramCandidates', variant: `near_${privacy}`, run: e => e.readTrigramCandidates('default', { arm: 'near', titleLc: 'alice example', slugFragment: 'alice-example', privacy }) },
      texts: () => [`SELECT p.slug, p.title, p.type FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND NOT ${retiredPageSql('p')} ${predicate()}
        AND (lower(p.title) % $2 OR p.slug ILIKE '%' || $3 || '%')
      ORDER BY GREATEST(similarity(lower(p.title), $2), similarity(p.slug, $3)) DESC, p.slug ASC
      LIMIT 20`],
    },
  ]),
  {
    from: 'src/core/entities/resolve.ts:857 tryFuzzyMatch',
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
       ORDER BY score DESC, slug ASC
       LIMIT 5`],
  },
  {
    from: 'src/core/entities/resolve.ts:686 findPrefixCandidates',
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
       ORDER BY connection_count DESC, p.slug ASC
       LIMIT 10`],
  },
  {
    from: 'src/core/entities/resolve.ts:769 tryPrefixExpansion',
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
         ORDER BY connection_count DESC, p.slug ASC
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
    from: `src/core/entities/resolve.ts:552 entityReferenceCandidates named (privacy ${privacy})`,
    case: { method: 'readNamedEntitySlugs', variant: privacy, run: e => e.readNamedEntitySlugs('default', ['companies/acme', 'orgs/acme'], privacy) },
    texts: () => [`SELECT p.slug FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND NOT ${retiredPageSql('p')} AND p.slug = ANY($2::text[]) ${predicate()}
      ORDER BY p.slug LIMIT 5`],
  })),
  ...([
    ['all', {}],
    ['sources-run', { sourceIds: ['default'], runId: 'run-1' }],
  ] as const).map(([variant, opts]): Pin => ({
    from: `src/core/persistence/sync-holds.ts:575 readGitSourceHolds (${variant})`,
    case: { method: 'readGitHoldRecords', variant, run: e => e.readGitHoldRecords(opts) },
    texts: () => [`SELECT ${READ_HOLD_RECORD_SQL} AS record FROM op_checkpoints h
    JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND ($2::text[] IS NULL OR s.id=ANY($2::text[])) AND ($3::text IS NULL OR h.completed_keys->0->>'run_id'=$3)
    ORDER BY s.id,h.fingerprint`],
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
    // An equivalent statement: the caller read `created_at` alone; the member also reads `archived`, which the check ignores.
    from: 'src/core/persistence/sync-authority.ts:122 validateSyncAuthority (SELECT created_at FROM sources WHERE id=$1)',
    case: { method: 'readJobSourceState', variant: 'default', run: e => e.readJobSourceState('default') },
    texts: ['SELECT archived, created_at FROM sources WHERE id = $1'],
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
      ORDER BY x.fingerprint LIMIT $4) h ON true
    WHERE s.id=ANY($3::text[]) AND COALESCE((sm.completed_keys->0->>'count')::int,0)>0
    ORDER BY s.id, h.fingerprint`],
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
    from: 'src/commands/access-serves.ts:135 unboundCredentials (tokens) (at 6e123afe98)',
    case: { method: 'listUnboundTokenNames', variant: 'default', run: e => e.listUnboundTokenNames() },
    texts: ['SELECT DISTINCT name FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NULL ORDER BY name'],
  },
  {
    from: 'src/commands/access-serves.ts:136 unboundCredentials (clients) (at 6e123afe98)',
    case: { method: 'listUnboundClientIds', variant: 'default', run: e => e.listUnboundClientIds() },
    texts: ['SELECT client_id FROM oauth_clients WHERE deleted_at IS NULL AND member_id IS NULL ORDER BY client_id'],
  },
  {
    from: 'src/commands/access-serves.ts:186 member key plan (live token) (at 6e123afe98)',
    case: { method: 'readLiveAccessToken', variant: 'default', run: e => e.readLiveAccessToken('member-alice-example') },
    texts: ['SELECT member_id, token_hash, source_grant, source_id, federated_read, permissions FROM access_tokens WHERE name = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/commands/access-serves.ts:197 member key plan (active sources) (at 6e123afe98)',
    case: { method: 'listUnarchivedSourceIds', variant: 'default', run: e => e.listUnarchivedSourceIds(['src-a', 'src-b']) },
    texts: ['SELECT id FROM sources WHERE id = ANY($1::text[]) AND archived IS NOT TRUE'],
  },
  {
    from: 'src/commands/access-serves.ts:241 recordSetupReads (at 6e123afe98)',
    case: { method: 'recordTokenSetupReads', variant: 'default', run: e => e.recordTokenSetupReads('member-alice-example', ['src-a']) },
    texts: ["UPDATE access_tokens SET permissions = COALESCE(permissions, '{}'::jsonb) || jsonb_build_object('setup_reads', $2::text[]) WHERE name = $1 AND revoked_at IS NULL AND (permissions IS NULL OR jsonb_typeof(permissions) = 'object')"],
  },
  {
    from: 'src/commands/access-serves.ts:251 keysStillReading (at 6e123afe98)',
    case: { method: 'listKeysReadingSource', variant: 'default', run: e => e.listKeysReadingSource('src-a') },
    texts: ["SELECT name, member_id, federated_read FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NOT NULL AND source_grant = 'federated' AND source_id <> $1 AND $1 = ANY(federated_read) ORDER BY name"],
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
    from: 'src/core/access/policy-transfer.ts:34 exportPolicyFiles (at 6e123afe98)',
    case: { method: 'listAccessPolicySources', variant: 'default', run: e => e.listAccessPolicySources() },
    texts: ['SELECT source_id FROM access_policy_state ORDER BY source_id'],
  },
  {
    from: 'src/core/access/serves.ts:38 unlabeledPeopleFolders (at 6e123afe98)',
    case: { method: 'countPeopleFolderPages', variant: 'default', run: e => e.countPeopleFolderPages() },
    texts: [`SELECT source_id, split_part(slug, '/', 2) AS folder, count(*)::int AS pages FROM pages
      WHERE deleted_at IS NULL AND slug LIKE 'people/%/%' GROUP BY 1, 2 ORDER BY 1, 2`],
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
    from: 'src/core/link-reconciliation.ts:220 fileLinkOwnership scoped metadata (at 90ede8f55a)',
    case: { method: 'listLinkPageMetadataForSlugs', variant: 'default', run: e => e.listLinkPageMetadataForSlugs('default', ['a']) },
    texts: [`SELECT slug, source_id, type, title, frontmatter->'aliases' AS aliases, knowledge_revision
        FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[]) ORDER BY slug`],
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
];

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
