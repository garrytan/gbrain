/**
 * Byte-identical pins for the facts purge statements that became typed engine members (Rust engine lane 4, item 4.2:
 * gone-page-facts.ts, purge-reasons.ts, held-fact-move.ts and purge-verify.ts, engine-sql/facts-purge.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text, in the same order, with the same bound values,
 *    its caller ran through `executeRaw` before the move. Each expected text below is copied verbatim from the caller
 *    at 5e22f0c134 (a `${...}` in a text is the caller's own interpolation, kept as the caller wrote it), except
 *    the statements that carry this repo's byte-order rule (`COLLATE "C"` on text sort keys, an id tie-break, a
 *    wrapped SELECT DISTINCT so its sort can name a collation), which are pinned as they now read.
 *  - Regression: an edited statement changes what Postgres and PGLite answer while the parity cases may still pass on
 *    a small fixture; a renumbered placeholder changes a plan on Postgres alone.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts),
 *    and these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records text and bound values; no database
 *    runs. The held-fact move's planning view (a Proxy that ends every read at a deadline) is checked with a second
 *    test that a typed member called on it still reaches the deadline-wrapped executeRaw.
 *
 * Two statements differ from their twin only in spaces, so they have two members: purge-reasons.ts:34 and
 * purge-verify.ts:711 both read `sources.local_path`.
 */
import { describe, expect, test } from 'bun:test';
import { makeEngineWithFake, withPinnedSqlEnvironment } from './helpers/postgres-engine-sql-cases.ts';
import type { RecordedStatement } from './helpers/fake-postgres-sql.ts';
import { CONVERSATION_SLOT_SQL } from '../src/core/chronicle/ontology.ts';
import { holdingSlugSql } from '../src/core/facts-fence.ts';
import { extractedFromPageSql } from '../src/core/facts/gone-page-facts.ts';
import { outcomeMarkerSql } from '../src/core/facts/audit-sources.ts';
import { privatePagesFilterFragment } from '../src/core/search/private-visibility.ts';
import { moveRuledSharedHeld } from '../src/core/facts/held-fact-move.ts';
import { derivationAfterSql } from '../src/core/page-body/segment-derive.ts';
import { derivationClaimCandidateSql, derivationHoldsClaimSql, derivationSweepScopeSql } from '../src/core/page-body/schema.ts';

/** gone-page-facts.ts:42, copied verbatim. */
const GONE = 'unnest($1::text[], $2::text[]) AS g(source_id, slug)';
/** held-fact-move.ts:167, copied verbatim. */
const onHolding = `f.source_id = $1 AND f.source_markdown_slug IN (SELECT hp.slug FROM pages hp WHERE hp.source_id = $1 AND ${holdingSlugSql('hp.slug')})
    AND f.row_num IS NOT NULL AND f.dimension IS NULL AND f.entity_slug IS NOT NULL AND NOT ${holdingSlugSql('f.entity_slug')}`;

interface Pin {
  /** The caller site the statement came from, at 5e22f0c134. */
  from: string;
  member: string;
  run: (engine: any) => Promise<unknown>;
  /** The statement texts, in order, as the caller sent them. */
  texts: string[];
  /** The bound values of each statement, in order. */
  params: unknown[][];
}

const PINS: Pin[] = [
  {
    from: 'src/core/facts/gone-page-facts.ts:55-63 expireGonePageFacts (four statements)',
    member: 'expireFactsOfGonePages',
    run: e => e.expireFactsOfGonePages(['src-a', 'src-b'], ['people/a', 'people/b']),
    texts: [
      `UPDATE facts f SET expired_at = now(), row_num = NULL FROM ${GONE}
  WHERE f.source_id = g.source_id AND f.source_markdown_slug = g.slug AND f.expired_at IS NULL AND f.dimension IS NULL`,
      `UPDATE facts f SET expired_at = now(), row_num = NULL, dimension = NULL, value = NULL, value_hash = NULL, dim_status = NULL
  FROM ${GONE} WHERE f.source_id = g.source_id AND f.source_markdown_slug = g.slug AND f.expired_at IS NULL AND f.dimension IS NOT NULL AND f.row_num IS NOT NULL AND ${CONVERSATION_SLOT_SQL}`,
      `UPDATE facts f SET expired_at = now(), row_num = NULL FROM ${GONE}
  WHERE f.source_id = g.source_id AND f.expired_at IS NULL AND ${extractedFromPageSql('f', 'g.slug')}`,
      `UPDATE facts f SET expired_at = now(), row_num = NULL FROM ${GONE}
  WHERE f.source_id = g.source_id AND f.entity_slug = g.slug AND f.expired_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM pages hp WHERE hp.source_id = f.source_id AND hp.slug = f.source_markdown_slug AND hp.slug <> g.slug)`,
    ],
    params: [[['src-a', 'src-b'], ['people/a', 'people/b']], [['src-a', 'src-b'], ['people/a', 'people/b']], [['src-a', 'src-b'], ['people/a', 'people/b']], [['src-a', 'src-b'], ['people/a', 'people/b']]],
  },
  {
    from: 'src/core/facts/purge-reasons.ts:34 scanPurgeTrailers',
    member: 'readPurgeSourceLocalPath',
    run: e => e.readPurgeSourceLocalPath('src-a'),
    texts: ['SELECT local_path FROM sources WHERE id = $1'],
    params: [['src-a']],
  },
  {
    from: 'src/core/facts/purge-reasons.ts:82 redactGitEffectReasons',
    member: 'listGitEffectsCarryingReason',
    run: e => e.listGitEffectsCarryingReason('src-a', 'needle', 'escaped', 'folded'),
    texts: [`SELECT e.id::text AS id, e.state, r.request_id::text AS request_id, e.data
    FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
    WHERE e.source_id = $1 AND e.kind = 'git' AND (strpos(lower(e.data::text), $2) > 0 OR strpos(lower(e.data::text), $3) > 0 OR strpos(lower(e.data::text), $4) > 0)
    ORDER BY e.id FOR UPDATE OF e`],
    params: [['src-a', 'needle', 'escaped', 'folded']],
  },
  {
    from: 'src/core/facts/purge-reasons.ts:99 and :139 redactGitEffectReasons, stripPageGitNotes',
    member: 'setPurgeEffectData',
    run: e => e.setPurgeEffectData('12', { commit_line: '[purged]' }),
    texts: ['UPDATE persistence_effects SET data = $2::text::jsonb WHERE id = $1::bigint'],
    params: [['12', '{"commit_line":"[purged]"}']],
  },
  {
    from: 'src/core/facts/purge-reasons.ts:110 pageChangeReasons',
    member: 'listPageChangeReasons',
    run: e => e.listPageChangeReasons('src-a', 'people/a', 7),
    texts: [`SELECT change_reason AS reason FROM page_versions WHERE page_id = $1
    UNION SELECT intent->>'reason' FROM persistence_requests WHERE source_id = $2 AND slug = $3
    UNION SELECT outcome->'reason_recorded'->>'reason' FROM persistence_requests WHERE source_id = $2 AND slug = $3`],
    params: [[7, 'src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/purge-reasons.ts:118 requestsRecordingReasons',
    member: 'listRequestsRecordingReasons',
    run: e => e.listRequestsRecordingReasons('src-a', 'people/a'),
    texts: [`SELECT id::text AS id, principal_kind, principal_id FROM persistence_requests
    WHERE source_id = $1 AND slug = $2 AND ((intent->>'reason') IS NOT NULL OR (outcome->'reason_recorded') IS NOT NULL) ORDER BY sequence LIMIT 10000`],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/purge-reasons.ts:127 stripPageGitNotes',
    member: 'listPageGitEffectsForStrip',
    run: e => e.listPageGitEffectsForStrip('src-a', 'people/a'),
    texts: [`SELECT e.id::text AS id, e.state, r.request_id::text AS request_id, e.data
    FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
    WHERE e.source_id = $1 AND e.kind = 'git' AND e.data->>'slug' = $2
      AND ((e.data->'commit_line') IS NOT NULL OR (e.data->'commit_trailers') IS NOT NULL OR (e.data->'commit_trailer') IS NOT NULL) ORDER BY e.id FOR UPDATE OF e`],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/held-fact-move.ts:57 holdingHome',
    member: 'heldEntityPageDeleted',
    run: e => e.heldEntityPageDeleted('src-a', 'people/a'),
    texts: ['SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NOT NULL'],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/held-fact-move.ts:65 holdingPageFor',
    member: 'readHeldAccessState',
    run: e => e.readHeldAccessState('src-a', 'people/a'),
    texts: [`SELECT gbrain_access_state_unreadable() AS unreadable,
       (EXISTS (SELECT 1 FROM access_rules r WHERE r.source_id=$1 AND r.prefix=$2)
         OR EXISTS (SELECT 1 FROM access_pending_coverage c WHERE c.source_id=$1 AND c.prefix=$2)) AS page_rule,
       (gbrain_access_folder_rules($1, $2) IS NOT NULL OR gbrain_access_pending_covers($1, $2)) AS restricted`],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/held-fact-move.ts:86 heldFactTarget',
    member: 'heldTargetPageLive',
    run: e => e.heldTargetPageLive('src-a', 'alice'),
    texts: ['SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL'],
    params: [['src-a', 'alice']],
  },
  {
    from: 'src/core/facts/held-fact-move.ts:169 planHeldMoves (held rows)',
    member: 'listHeldMoveRows',
    run: e => e.listHeldMoveRows('src-a'),
    texts: [`SELECT id, source_id, entity_slug, fact, kind, visibility, notability, context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period, attributed_to, true AS page_exists, source_markdown_slug AS from_slug
       FROM facts f WHERE ${onHolding} AND f.expired_at IS NULL ORDER BY f.source_markdown_slug COLLATE "C", f.entity_slug COLLATE "C", f.id`],
    params: [['src-a']],
  },
  {
    from: 'src/core/facts/held-fact-move.ts:174 planHeldMoves (struck rows)',
    member: 'listStruckHeldRows',
    run: e => e.listStruckHeldRows('src-a'),
    texts: [`SELECT DISTINCT ON (f.source_markdown_slug COLLATE "C", f.row_num) f.source_markdown_slug AS from_slug, f.entity_slug, f.row_num, f.fact FROM facts f
      WHERE ${onHolding} AND f.expired_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM facts a WHERE a.source_id = f.source_id
        AND a.source_markdown_slug = f.source_markdown_slug AND a.row_num = f.row_num AND a.expired_at IS NULL)
      ORDER BY f.source_markdown_slug COLLATE "C", f.row_num, f.id DESC`],
    params: [['src-a']],
  },
  {
    from: 'src/core/facts/held-fact-move.ts:193 planHeldMoves (visibility)',
    member: 'readHeldRowVisibility',
    run: e => e.readHeldRowVisibility('src-a', 'people/a'),
    texts: [`SELECT ${privatePagesFilterFragment('p')} AS visible FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL`],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/held-fact-move.ts:222 moveRuledSharedHeld',
    member: 'heldMoveDue',
    run: e => e.heldMoveDue('src-a'),
    texts: [`SELECT EXISTS (SELECT 1 FROM facts f WHERE f.source_id = $1
      AND f.source_markdown_slug IN (SELECT hp.slug FROM pages hp WHERE hp.source_id = $1 AND ${holdingSlugSql('hp.slug')})
      AND f.row_num IS NOT NULL AND f.dimension IS NULL AND f.entity_slug IS NOT NULL AND NOT ${holdingSlugSql('f.entity_slug')}
      AND (NOT COALESCE(gbrain_access_folder_rules(f.source_id, f.entity_slug), '{}') <@ COALESCE(gbrain_access_folder_rules(f.source_id, f.source_markdown_slug), '{}')
        OR (gbrain_access_pending_covers(f.source_id, f.entity_slug) AND NOT gbrain_access_pending_covers(f.source_id, f.source_markdown_slug)))) AS due`],
    params: [['src-a']],
  },
  {
    from: 'src/core/facts/held-fact-move.ts:258 planningView getConfig',
    member: 'readHeldConfigValue',
    run: e => e.readHeldConfigValue('sync.write_through'),
    texts: ['SELECT value FROM config WHERE key = $1'],
    params: [['sync.write_through']],
  },
  {
    from: 'src/core/facts/held-fact-move.ts:297 and :302 moveHeldFacts',
    member: 'readHeldPageLocation',
    run: e => e.readHeldPageLocation('src-a', 'people/a'),
    texts: ['SELECT source_path, source_uri FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL'],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/held-fact-move.ts:319 moveHeldFacts',
    member: 'readHeldVersionsEdited',
    run: e => e.readHeldVersionsEdited('b0000000-0000-4000-8000-0000000000b1'),
    texts: [`SELECT (outcome->'held_versions_edited'->>'segmented_versions_not_edited')::int AS n
        FROM persistence_requests WHERE request_id = $1::uuid`],
    params: [['b0000000-0000-4000-8000-0000000000b1']],
  },
  {
    from: 'src/core/facts/purge-verify.ts:86 segmentedProse (pages)',
    member: 'listSegmentedPageBodies',
    run: e => e.listSegmentedPageBodies('src-a', 1001),
    texts: [`SELECT id AS page_id,slug,NULL AS generation,NULL AS version_id FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND body_storage='segmented' ORDER BY id LIMIT $2`],
    params: [['src-a', 1001]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:88 segmentedProse (page_versions)',
    member: 'listSegmentedVersionBodies',
    run: e => e.listSegmentedVersionBodies('src-a', 1001),
    texts: [`SELECT v.page_id,p.slug,v.body_generation AS generation,v.id AS version_id
      FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND v.body_storage='segmented' ORDER BY v.id LIMIT $2`],
    params: [['src-a', 1001]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:165 and :214 derivationTextReport, boundedCount',
    member: 'setPurgeProbeTimeout',
    run: e => e.setPurgeProbeTimeout(2000),
    texts: ["SELECT set_config('statement_timeout',$1,true)"],
    params: [['2000ms']],
  },
  {
    from: 'src/core/facts/purge-verify.ts:167 derivationTextReport',
    member: 'probePurgeDerivations',
    run: e => e.probePurgeDerivations('src-a', ['needle'], [1, 2], ['pattern'], [5, 'synopsis', '9'], 500),
    texts: [`WITH batch AS MATERIALIZED (
            SELECT d.page_id, d.pipeline, d.occurrence_id, ${derivationSweepScopeSql('d', 'p', '$3')} AS swept FROM page_segment_derivations d
            JOIN pages p ON p.id=d.page_id WHERE p.source_id=$1 AND ${derivationAfterSql('d', ['$5', '$6', '$7'])}
            ORDER BY d.page_id, d.pipeline, d.occurrence_id LIMIT $8
          ), checked AS MATERIALIZED (
            SELECT b.swept, c.candidate, CASE WHEN c.candidate THEN ${derivationHoldsClaimSql('d', '$2', '$4')} ELSE false END AS hit
            FROM batch b JOIN page_segment_derivations d ON d.page_id=b.page_id AND d.pipeline=b.pipeline AND d.occurrence_id=b.occurrence_id
            CROSS JOIN LATERAL (SELECT ${derivationClaimCandidateSql('d', '$4')} AS candidate) c
          ), last AS (
            SELECT b.page_id, b.pipeline, b.occurrence_id::text AS occurrence_id FROM batch b ORDER BY b.page_id DESC, b.pipeline DESC, b.occurrence_id DESC LIMIT 1
          ) SELECT (SELECT count(*)::int FROM batch) AS scanned, count(*) FILTER (WHERE candidate)::int AS normalized,
            count(*) FILTER (WHERE hit AND swept)::int AS swept, count(*) FILTER (WHERE hit AND NOT swept)::int AS kept,
            (SELECT page_id FROM last) AS last_page, (SELECT pipeline FROM last) AS last_pipeline, (SELECT occurrence_id FROM last) AS last_occurrence
          FROM checked`],
    params: [['src-a', ['needle'], [1, 2], ['pattern'], 5, 'synopsis', '9', 500]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:167 derivationTextReport (first batch, no cursor)',
    member: 'probePurgeDerivations',
    run: e => e.probePurgeDerivations('src-a', ['needle'], [], ['pattern'], null, 1000),
    texts: [`WITH batch AS MATERIALIZED (
            SELECT d.page_id, d.pipeline, d.occurrence_id, ${derivationSweepScopeSql('d', 'p', '$3')} AS swept FROM page_segment_derivations d
            JOIN pages p ON p.id=d.page_id WHERE p.source_id=$1 AND ${derivationAfterSql('d', ['$5', '$6', '$7'])}
            ORDER BY d.page_id, d.pipeline, d.occurrence_id LIMIT $8
          ), checked AS MATERIALIZED (
            SELECT b.swept, c.candidate, CASE WHEN c.candidate THEN ${derivationHoldsClaimSql('d', '$2', '$4')} ELSE false END AS hit
            FROM batch b JOIN page_segment_derivations d ON d.page_id=b.page_id AND d.pipeline=b.pipeline AND d.occurrence_id=b.occurrence_id
            CROSS JOIN LATERAL (SELECT ${derivationClaimCandidateSql('d', '$4')} AS candidate) c
          ), last AS (
            SELECT b.page_id, b.pipeline, b.occurrence_id::text AS occurrence_id FROM batch b ORDER BY b.page_id DESC, b.pipeline DESC, b.occurrence_id DESC LIMIT 1
          ) SELECT (SELECT count(*)::int FROM batch) AS scanned, count(*) FILTER (WHERE candidate)::int AS normalized,
            count(*) FILTER (WHERE hit AND swept)::int AS swept, count(*) FILTER (WHERE hit AND NOT swept)::int AS kept,
            (SELECT page_id FROM last) AS last_page, (SELECT pipeline FROM last) AS last_pipeline, (SELECT occurrence_id FROM last) AS last_occurrence
          FROM checked`],
    params: [['src-a', ['needle'], [], ['pattern'], null, null, null, 1000]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:334 ledgerReports (belief events)',
    member: 'listBeliefEventsForPurgeProbe',
    run: e => e.listBeliefEventsForPurgeProbe('src-a', 40),
    texts: [`SELECT id, subject_kind, subject_key, value
      FROM belief_events WHERE source_id = $1 AND id > $2 AND value IS NOT NULL ORDER BY id LIMIT 1000`],
    params: [['src-a', 40]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:356 ledgerReports (fact contexts)',
    member: 'listFactContextsForPurgeProbe',
    run: e => e.listFactContextsForPurgeProbe('src-a', 40),
    texts: [`SELECT id, context FROM facts WHERE source_id = $1 AND id > $2 AND expired_at IS NULL
      AND COALESCE(context, '') <> '' ORDER BY id LIMIT 1000`],
    params: [['src-a', 40]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:444 pageFilePaths',
    member: 'listPageSourcePathsForPurge',
    run: e => e.listPageSourcePathsForPurge([1, 2]),
    texts: [`SELECT DISTINCT source_path FROM (
      SELECT source_path FROM pages WHERE id=ANY($1::int[]) UNION ALL SELECT source_path FROM page_versions WHERE page_id=ANY($1::int[])) s
    WHERE source_path IS NOT NULL AND source_path<>'' AND source_path NOT LIKE '/%' AND source_path NOT LIKE '%..%' LIMIT 64`],
    params: [[[1, 2]]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:474 vectorProbe',
    member: 'listNearestFactsForPurge',
    run: e => e.listNearestFactsForPurge('[0.1,0.2]', 'src-a', 'model-a', 'the claim'),
    texts: [`SELECT id, similarity, contains_claim FROM (
        SELECT id,(1-(embedding <=> $1::halfvec))::float8 AS similarity, embedding <=> $1::halfvec AS distance,
          strpos(gbrain_fact_normalize(fact),gbrain_fact_normalize($4))>0 AS contains_claim
        FROM facts WHERE source_id=$2 AND embedding_model=$3 AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::halfvec LIMIT 5) nearest
      ORDER BY distance, id`],
    params: [['[0.1,0.2]', 'src-a', 'model-a', 'the claim']],
  },
  {
    from: 'src/core/facts/purge-verify.ts:533 verifyFactPurge (legacy derived pages)',
    member: 'countLegacyDerivedPages',
    run: e => e.countLegacyDerivedPages('src-a'),
    texts: [`SELECT count(*)::int AS n FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL
    AND (p.type='atom' OR p.frontmatter->>'dream_generated'='true')
    AND NOT EXISTS (SELECT 1 FROM derivation_inputs d WHERE d.derived_table='pages' AND d.derived_id=p.id::text)`],
    params: [['src-a']],
  },
  {
    from: 'src/core/facts/purge-verify.ts:560 verifyFactPurge (VACUUM, no query cache)',
    member: 'vacuumPurgedTables',
    run: e => e.vacuumPurgedTables(false),
    texts: ['VACUUM facts, takes, pages, content_chunks, page_versions, persistence_requests'],
    params: [[]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:560 verifyFactPurge (VACUUM, with query cache)',
    member: 'vacuumPurgedTables',
    run: e => e.vacuumPurgedTables(true),
    texts: ['VACUUM facts, takes, pages, content_chunks, page_versions, persistence_requests, query_cache'],
    params: [[]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:682 and :694 purgePageReceipt (prose in pages)',
    member: 'listPageProseHits',
    run: e => e.listPageProseHits('pages', 'src-a', ['needle']),
    texts: [`SELECT * FROM (SELECT DISTINCT p.slug FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(p.compiled_truth),n)>0 OR strpos(lower(COALESCE(p.timeline,'')),n)>0)) q ORDER BY slug COLLATE "C" LIMIT 20`],
    params: [['src-a', ['needle']]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:684 and :694 purgePageReceipt (prose in content_chunks)',
    member: 'listPageProseHits',
    run: e => e.listPageProseHits('content_chunks', 'src-a', ['needle']),
    texts: [`SELECT * FROM (SELECT DISTINCT p.slug FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(c.chunk_text),n)>0)) q ORDER BY slug COLLATE "C" LIMIT 20`],
    params: [['src-a', ['needle']]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:686 and :694 purgePageReceipt (prose in page_versions)',
    member: 'listPageProseHits',
    run: e => e.listPageProseHits('page_versions', 'src-a', ['needle']),
    texts: [`SELECT * FROM (SELECT DISTINCT p.slug FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(v.compiled_truth),n)>0 OR strpos(lower(COALESCE(v.timeline,'')),n)>0)) q ORDER BY slug COLLATE "C" LIMIT 20`],
    params: [['src-a', ['needle']]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:688 and :694 purgePageReceipt (prose in timeline_entries)',
    member: 'listPageProseHits',
    run: e => e.listPageProseHits('timeline_entries', 'src-a', ['needle']),
    texts: [`SELECT * FROM (SELECT DISTINCT p.slug FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(t.summary),n)>0 OR strpos(lower(COALESCE(t.detail,'')),n)>0)) q ORDER BY slug COLLATE "C" LIMIT 20`],
    params: [['src-a', ['needle']]],
  },
  {
    from: 'src/core/facts/purge-verify.ts:711 pageReceipt (source path)',
    member: 'readPurgeReceiptSourcePath',
    run: e => e.readPurgeReceiptSourcePath('src-a'),
    texts: ['SELECT local_path FROM sources WHERE id=$1'],
    params: [['src-a']],
  },
  {
    from: 'src/core/facts/purge-verify.ts:718 pageReceipt (page purges)',
    member: 'countPagePurgeTombstones',
    run: e => e.countPagePurgeTombstones('src-a', 'people/a'),
    texts: ['SELECT count(*)::int AS n FROM page_purges WHERE source_id=$1 AND slug=$2'],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/purge-verify.ts:723 pageReceipt (delete_page request)',
    member: 'readDeletePageRequest',
    run: e => e.readDeletePageRequest('src-a', 'b0000000-0000-4000-8000-0000000000b1'),
    texts: [`SELECT id,request_id,state,source_id,outcome FROM persistence_requests
    WHERE source_id=$1 AND request_id=$2::uuid AND operation='delete_page' ORDER BY created_at DESC, id LIMIT 1`],
    params: [['src-a', 'b0000000-0000-4000-8000-0000000000b1']],
  },
  {
    from: 'src/core/facts/purge-verify.ts:743 purgeCompletion (effects)',
    member: 'listPurgeEffects',
    run: e => e.listPurgeEffects('b0000000-0000-4000-8000-0000000000b1'),
    texts: [`SELECT kind,state,error_code,
    jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 AS parked FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind COLLATE "C"`],
    params: [['b0000000-0000-4000-8000-0000000000b1']],
  },
  {
    from: 'src/core/facts/purge-verify.ts:748 purgeCompletion (fingerprint probe)',
    member: 'countPurgeFingerprintResidue',
    run: e => e.countPurgeFingerprintResidue('src-a', 'hash-a', '*'),
    texts: [`SELECT
      (SELECT count(*)::int FROM facts WHERE source_id=$1 AND gbrain_fact_fingerprint(fact)=$2 AND ($3='*' OR entity_slug=$3) AND NOT ${outcomeMarkerSql('facts')}) AS facts,
      (SELECT count(*)::int FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1 AND gbrain_fact_fingerprint(k.claim)=$2 AND ($3='*' OR p.slug=$3)) AS takes`],
    params: [['src-a', 'hash-a', '*']],
  },
];

describe('facts purge statements moved into typed members keep their Postgres text and values byte for byte', () => {
  for (const pin of PINS) {
    test(`${pin.member} (${pin.from})`, async () => {
      const capture = await withPinnedSqlEnvironment(undefined, async () => {
        const { engine, fake } = makeEngineWithFake();
        let error: string | undefined;
        try { await pin.run(engine); } catch (e) { error = e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
        return { error, sent: fake.trace.filter((s): s is RecordedStatement => s.kind === 'query') };
      });
      expect(capture.error).toBeUndefined();
      expect(capture.sent.map(s => s.text)).toEqual(pin.texts);
      expect(capture.sent.map(s => s.params)).toEqual(pin.params);
    });
  }
});

describe('the held-fact move planning view still ends a typed member read at its deadline', () => {
  const statementTimeouts = (sent: RecordedStatement[]) => sent.flatMap(s => [...s.text.matchAll(/SET LOCAL statement_timeout = (\d+)/g)].map(m => Number(m[1])));

  test('heldMoveDue called through moveRuledSharedHeld runs in a bounded statement, as the raw read it replaced did', async () => {
    const sent = await withPinnedSqlEnvironment(undefined, async () => {
      const { engine, fake } = makeEngineWithFake();
      await moveRuledSharedHeld(engine, 'src-a');
      return fake.trace.filter((s): s is RecordedStatement => s.kind === 'query');
    });
    // The budget read is the engine's own config read, unbounded; the due check is the statement the view bounds.
    const due = sent.find(s => s.text.startsWith('SELECT EXISTS (SELECT 1 FROM facts f WHERE f.source_id = $1'));
    expect(due?.params).toEqual(['src-a']);
    const timeouts = statementTimeouts(sent);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(120000);
    expect(sent.findIndex(s => /SET LOCAL statement_timeout/.test(s.text))).toBeLessThan(sent.indexOf(due!));
  });

  test('the same member called on the bare engine is not bounded', async () => {
    const sent = await withPinnedSqlEnvironment(undefined, async () => {
      const { engine, fake } = makeEngineWithFake();
      await engine.heldMoveDue('src-a');
      return fake.trace.filter((s): s is RecordedStatement => s.kind === 'query');
    });
    expect(statementTimeouts(sent)).toEqual([]);
  });
});
