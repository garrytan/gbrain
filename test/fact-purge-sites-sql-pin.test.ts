/**
 * Byte-identical pins for the facts purge statements of src/core/facts/purge.ts that became typed engine members (Rust
 * engine lane 4, item 4.2, engine-sql/facts-purge.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text, with the same bound values, its caller ran
 *    through `executeRaw` before the move. Each expected text below is copied verbatim from purge.ts at 8ab1fcf644 (a
 *    `${...}` in a text is the caller's own interpolation of a vetted builder, kept as the caller wrote it; the two
 *    batch-size constants are written as the numbers they hold, because that is the text Postgres received).
 *  - Regression: an edited statement changes what a fact purge deletes, redacts and counts while the parity cases may
 *    still pass on a small fixture; a renumbered placeholder changes a plan on Postgres alone.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts),
 *    and these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records text and bound values; no database
 *    runs.
 *
 * One statement of purge.ts stays a raw read: rewriteVersionBodies builds its WHERE, column list and lock clause from its
 * callers (purge.ts and the held-fact move), so its text is not a constant.
 */
import { describe, expect, test } from 'bun:test';
import { makeEngineWithFake, withPinnedSqlEnvironment } from './helpers/postgres-engine-sql-cases.ts';
import type { RecordedStatement } from './helpers/fake-postgres-sql.ts';
import { holdingSlugSql } from '../src/core/facts-fence.ts';
import { carriesClaimSql } from '../src/core/facts/purge-verify.ts';
import { liveStagingSql } from '../src/core/page-body/schema.ts';

/** purge.ts:262, copied verbatim. */
const SEGMENTED_VERSION_CARRIES = `EXISTS (SELECT 1 FROM page_body_manifest m JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256
  WHERE m.page_id=v.page_id AND m.staging_id IS NULL AND m.gen_from<=v.body_generation AND (m.gen_to IS NULL OR m.gen_to>v.body_generation)
    AND strpos(lower(convert_from(t.body,'UTF8')),$2)>0)`;

interface Pin {
  /** The caller site the statement came from, at 8ab1fcf644. */
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
    from: 'src/core/facts/purge.ts:127 stagingsWithClaimAcrossParts',
    member: 'listStagingPartEdges',
    run: e => e.listStagingPartEdges('src-a', 7, { id: 'a0000000-0000-4000-8000-0000000000a1', part: 3 }),
    texts: [`SELECT pt.staging_id::text AS id,pt.part_no,
        substring(pt.body from 1 for $2) AS head,substring(pt.body from greatest(1,octet_length(pt.body)-$2+1)) AS tail
      FROM page_body_staging_parts pt JOIN page_body_stagings s ON s.id=pt.staging_id
      WHERE s.source_id=$1 AND s.state IN ('open','sealed','prepared') AND (pt.staging_id,pt.part_no)>($3::uuid,$4::int)
      ORDER BY pt.staging_id,pt.part_no LIMIT 1000`],
    params: [['src-a', 7, 'a0000000-0000-4000-8000-0000000000a1', 3]],
  },
  {
    from: 'src/core/facts/purge.ts:153 stagingsHoldingClaim',
    member: 'listStagingsHoldingClaim',
    run: e => e.listStagingsHoldingClaim('src-a', 'Tea | Milk'),
    texts: [`SELECT s.id::text AS id FROM page_body_stagings s
    WHERE s.source_id=$1 AND ((s.state IN ('open','sealed','prepared') AND (EXISTS (SELECT 1 FROM page_body_manifest m
        JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256 WHERE m.staging_id=s.id AND strpos(lower(convert_from(t.body,'UTF8')),$2)>0)
      OR EXISTS (SELECT 1 FROM page_body_staging_parts pt WHERE pt.staging_id=s.id AND position(convert_to($3::text,'UTF8') in pt.body)>0)))
      OR (${liveStagingSql('s')} AND EXISTS (SELECT 1 FROM page_body_staging_texts r JOIN page_segment_texts t ON t.source_id=r.source_id AND t.sha256=r.sha256
        WHERE r.staging_id=s.id AND (strpos(lower(convert_from(t.body,'UTF8')),$2)>0 OR strpos(lower(convert_from(t.body,'UTF8')),$4)>0))))
    ORDER BY s.id`],
    params: [['src-a', 'tea | milk', 'Tea | Milk', 'tea \\| milk']],
  },
  {
    from: 'src/core/facts/purge.ts:167 planFactPurge',
    member: 'purgeSubjectPageLive',
    run: e => e.purgeSubjectPageLive('src-a', 'people/a'),
    texts: [`SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL LIMIT 1`],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/purge.ts:177 planFactPurge',
    member: 'listPurgePagesById',
    run: e => e.listPurgePagesById('src-a', [3, 4]),
    texts: [`SELECT slug,id AS page_id,knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])`],
    params: [['src-a', [3, 4]]],
  },
  {
    from: 'src/core/facts/purge.ts:180 planFactPurge',
    member: 'countPurgeVersionsCarryingClaim',
    run: e => e.countPurgeVersionsCarryingClaim('src-a', 'needle', 'esc', 'reason'),
    texts: [`SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id
    WHERE p.source_id=$1 AND (${carriesClaimSql('v', 2)} OR strpos(lower(v.change_reason),$2)>0 OR strpos(lower(v.change_reason),$4)>0
      OR (v.body_storage='segmented' AND ${SEGMENTED_VERSION_CARRIES}))`],
    params: [['src-a', 'needle', 'esc', 'reason']],
  },
  {
    from: 'src/core/facts/purge.ts:195 planFactPurge',
    member: 'countPurgeReviewRows',
    run: e => e.countPurgeReviewRows('src-a', ['1', '2'], [1, 2]),
    texts: [`SELECT
    (SELECT count(*)::int FROM decide_review_queue WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))) AS q,
    (SELECT count(*)::int FROM decide_review_proposals WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))) AS rp,
    (SELECT count(*)::int FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($3::bigint[]) OR old_fact_id=ANY($3::bigint[]))) AS dp`],
    params: [['src-a', ['1', '2'], [1, 2]]],
  },
  {
    from: 'src/core/facts/purge.ts:210 factPurgeStreams',
    member: 'listPurgeStreamSlugs',
    run: e => e.listPurgeStreamSlugs([1, 2]),
    texts: [`SELECT DISTINCT COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts
    WHERE id = ANY($1::bigint[]) AND COALESCE(source_markdown_slug, entity_slug) IS NOT NULL`],
    params: [[[1, 2]]],
  },
  {
    from: 'src/core/facts/purge.ts:241 assertNoPendingPublication',
    member: 'findPurgeBlockedPublication',
    run: e => e.findPurgeBlockedPublication('src-a', ['people/a'], 'req-1'),
    texts: [`SELECT r.request_id::text,r.slug,r.state FROM persistence_requests r
      WHERE r.source_id=$1 AND r.id<>$3::uuid AND r.slug=ANY($2::text[]) AND (r.recovery IS NOT NULL OR r.state IN ('queued','deferred','running','recovering'))
    UNION ALL SELECT r.request_id::text,COALESCE(t->>'slug',r.slug),e.state FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.data->'targets','[]'::jsonb)) t
      WHERE e.source_id=$1 AND e.request_id<>$3::uuid AND e.kind='withdrawal-mirror' AND (e.state<>'committed' OR e.recovery IS NOT NULL) AND t->>'slug'=ANY($2::text[])
    LIMIT 1`],
    params: [['src-a', ['people/a'], 'req-1']],
  },
  {
    // Main join (da99c637a7): the cli-members line's caller (purge.ts:269 at de72811022) sorted the tag aggregate and the
    // pages with `COLLATE "C"`; the join re-applied that byte order to main's member, so the pin carries it too.
    from: 'src/core/facts/purge.ts:269 rewritePageBodies',
    member: 'listPagesForPurgeRewrite',
    run: e => e.listPagesForPurgeRewrite('src-a', [3, 4]),
    texts: [`SELECT p.*,COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id=p.id),'[]'::jsonb) AS purge_tags
    FROM pages p WHERE p.source_id=$1 AND p.id=ANY($2::int[]) ORDER BY p.slug COLLATE "C"`],
    params: [['src-a', [3, 4]]],
  },
  {
    from: 'src/core/facts/purge.ts:295 rewritePageBodies',
    member: 'updatePageBodyForPurge',
    run: e => e.updatePageBodyForPurge('src-a', 3, 'compiled', 'timeline', 'hash'),
    texts: [`UPDATE pages SET compiled_truth=$3,timeline=$4,content_hash=$5,updated_at=now(),text_projection_revision=NULL,embedding_signature=NULL
      WHERE source_id=$1 AND id=$2`],
    params: [['src-a', 3, 'compiled', 'timeline', 'hash']],
  },
  {
    from: 'src/core/facts/purge.ts:326 rewriteVersionBodies',
    member: 'setPurgeVersionBody',
    run: e => e.setPurgeVersionBody(9, 'compiled', null),
    texts: [`UPDATE page_versions SET compiled_truth=$2,timeline=$3 WHERE id=$1`],
    params: [[9, 'compiled', null]],
  },
  {
    from: 'src/core/facts/purge.ts:339 redactPageVersions',
    member: 'redactVersionChangeReasons',
    run: e => e.redactVersionChangeReasons('src-a', 'needle', 'reason'),
    texts: [`UPDATE page_versions v SET change_reason = '[purged]' FROM pages p
    WHERE p.id = v.page_id AND p.source_id = $1 AND (strpos(lower(v.change_reason), $2) > 0 OR strpos(lower(v.change_reason), $3) > 0) RETURNING v.id`],
    params: [['src-a', 'needle', 'reason']],
  },
  {
    from: 'src/core/facts/purge.ts:358 redactPageVersions',
    member: 'listSegmentedVersionsForPurge',
    run: e => e.listSegmentedVersionsForPurge('src-a', 'needle', [3], 40),
    texts: [`SELECT v.id,v.page_id,v.body_generation AS generation,p.slug,v.title,v.type,v.frontmatter,v.tags
      FROM page_versions v JOIN pages p ON p.id=v.page_id
      WHERE p.source_id=$1 AND v.body_storage='segmented' AND v.id>$4 AND (v.page_id=ANY($3::int[]) OR ${SEGMENTED_VERSION_CARRIES})
      ORDER BY v.id LIMIT 5000`],
    params: [['src-a', 'needle', [3], 40]],
  },
  {
    from: 'src/core/facts/purge.ts:396 purgeSegmentStorage',
    member: 'abortPurgedStagings',
    run: e => e.abortPurgedStagings(['a0000000-0000-4000-8000-0000000000a1']),
    texts: [`UPDATE page_body_stagings SET state='aborted',updated_at=now()
      WHERE id=ANY($1::uuid[]) AND state<>'committed' RETURNING page_id`],
    params: [[['a0000000-0000-4000-8000-0000000000a1']]],
  },
  {
    from: 'src/core/facts/purge.ts:398 purgeSegmentStorage',
    member: 'deletePurgedStagingParts',
    run: e => e.deletePurgedStagingParts(['a0000000-0000-4000-8000-0000000000a1']),
    texts: [`DELETE FROM page_body_staging_parts WHERE staging_id=ANY($1::uuid[]) RETURNING 1`],
    params: [[['a0000000-0000-4000-8000-0000000000a1']]],
  },
  {
    from: 'src/core/facts/purge.ts:402 purgeSegmentStorage',
    member: 'deletePageViewDigests',
    run: e => e.deletePageViewDigests([3, 4]),
    texts: [`DELETE FROM page_view_digests WHERE page_id=ANY($1::int[])`],
    params: [[[3, 4]]],
  },
  {
    from: 'src/core/facts/purge.ts:403 purgeSegmentStorage',
    member: 'deleteUnreferencedPurgedTexts',
    run: e => e.deleteUnreferencedPurgedTexts('src-a', [new Uint8Array([1, 171])], 'Tea | Milk'),
    texts: [`DELETE FROM page_segment_texts d WHERE (d.source_id,d.sha256) IN (SELECT t.source_id,t.sha256 FROM page_segment_texts t
      WHERE t.source_id=$1 AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=t.source_id AND m.sha256=t.sha256) OFFSET 0)
    AND (d.sha256=ANY(SELECT decode(h,'hex') FROM unnest($2::text[]) AS h) OR strpos(lower(convert_from(d.body,'UTF8')),$3)>0
      OR strpos(lower(convert_from(d.body,'UTF8')),$4)>0) RETURNING 1`],
    params: [['src-a', ['01ab'], 'tea | milk', 'tea \\| milk']],
  },
  {
    from: 'src/core/facts/purge.ts:427 matchCandidates',
    member: 'listPurgeMatchCandidates',
    run: e => e.listPurgeMatchCandidates('src-a', 'tea'),
    texts: [`SELECT id,entity_slug,visibility,
    expired_at IS NOT NULL AS expired,left(fact,160) AS fact FROM facts WHERE source_id=$1 AND strpos(lower(fact),lower($2))>0 ORDER BY id LIMIT 25`],
    params: [['src-a', 'tea']],
  },
  {
    from: 'src/core/facts/purge.ts:506 submitPurgeFactMutation',
    member: 'lockPurgeSource',
    run: e => e.lockPurgeSource('src-a'),
    texts: [`SELECT incarnation,archived FROM sources WHERE id=$1 FOR UPDATE`],
    params: [['src-a']],
  },
  {
    from: 'src/core/facts/purge.ts:548 submitPurgeFactMutation',
    member: 'insertHoldingPagePurges',
    run: e => e.insertHoldingPagePurges('src-a', 'world', 'hash-a', 'a0000000-0000-4000-8000-0000000000a1', 'local_cli:me', 'because', [1, 2]),
    texts: [`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,request_id,actor,reason)
        SELECT DISTINCT $1::text,$2::text,f.source_markdown_slug,$3::text,$4::uuid,$5::text,$6::text FROM facts f
          WHERE f.id=ANY($7::bigint[]) AND f.source_id=$1 AND ${holdingSlugSql('f.source_markdown_slug')} AND f.entity_slug IS NOT NULL ON CONFLICT DO NOTHING`],
    params: [['src-a', 'world', 'hash-a', 'a0000000-0000-4000-8000-0000000000a1', 'local_cli:me', 'because', [1, 2]]],
  },
  {
    from: 'src/core/facts/purge.ts:552 submitPurgeFactMutation',
    member: 'insertTakePurge',
    run: e => e.insertTakePurge({ sourceId: 'src-a', subject: '*', claimHash: 'hash-a', requestId: 'a0000000-0000-4000-8000-0000000000a1' }),
    texts: [`INSERT INTO take_purges(source_id,subject,claim_hash,request_id) VALUES ($1,$2,$3,$4::uuid) ON CONFLICT DO NOTHING RETURNING 1 AS inserted`],
    params: [['src-a', '*', 'hash-a', 'a0000000-0000-4000-8000-0000000000a1']],
  },
  {
    from: 'src/core/persistence/page-purge.ts tombstonePage',
    member: 'insertTakePurge',
    run: e => e.insertTakePurge({ sourceId: 'src-a', subject: 'people/alice', pageId: 7, requestId: 'a0000000-0000-4000-8000-0000000000a1' }),
    texts: [`INSERT INTO take_purges(source_id,subject,claim_hash,request_id)
      SELECT DISTINCT $1,$2,gbrain_fact_fingerprint(claim),$4::uuid FROM takes WHERE page_id=$3 ON CONFLICT DO NOTHING RETURNING 1 AS inserted`],
    params: [['src-a', 'people/alice', 7, 'a0000000-0000-4000-8000-0000000000a1']],
  },
  {
    from: 'src/core/facts/purge.ts:554 submitPurgeFactMutation',
    member: 'deletePurgedTakes',
    run: e => e.deletePurgedTakes([5, 6]),
    texts: [`DELETE FROM takes WHERE id=ANY($1::bigint[]) RETURNING id`],
    params: [[[5, 6]]],
  },
  {
    from: 'src/core/facts/purge.ts:556 submitPurgeFactMutation',
    member: 'deletePurgeReviewQueue',
    run: e => e.deletePurgeReviewQueue('src-a', ['1', '2']),
    texts: [`DELETE FROM decide_review_queue WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[])) RETURNING 1`],
    params: [['src-a', ['1', '2']]],
  },
  {
    from: 'src/core/facts/purge.ts:557 submitPurgeFactMutation',
    member: 'deletePurgeReviewProposals',
    run: e => e.deletePurgeReviewProposals('src-a', ['1', '2']),
    texts: [`DELETE FROM decide_review_proposals WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[])) RETURNING 1`],
    params: [['src-a', ['1', '2']]],
  },
  {
    from: 'src/core/facts/purge.ts:558 submitPurgeFactMutation',
    member: 'deletePurgeDecideProposals',
    run: e => e.deletePurgeDecideProposals('src-a', [1, 2]),
    texts: [`DELETE FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($2::bigint[]) OR old_fact_id=ANY($2::bigint[])) RETURNING 1`],
    params: [['src-a', [1, 2]]],
  },
  {
    from: 'src/core/facts/purge.ts:559 submitPurgeFactMutation',
    member: 'deletePurgeTrustProposals',
    run: e => e.deletePurgeTrustProposals('src-a', [1, 2], [5]),
    texts: [`DELETE FROM trust_proposals WHERE source_id=$1 AND ((target_table='facts' AND target_id=ANY($2::bigint[])) OR (related_table='facts' AND related_id=ANY($2::bigint[]))
            OR (target_table='takes' AND target_id=ANY($3::bigint[])) OR (related_table='takes' AND related_id=ANY($3::bigint[]))) RETURNING 1`],
    params: [['src-a', [1, 2], [5]]],
  },
  {
    from: 'src/core/facts/purge.ts:561 submitPurgeFactMutation',
    member: 'deletePurgeOpenLoops',
    run: e => e.deletePurgeOpenLoops('src-a', [1, 2]),
    texts: [`DELETE FROM open_loops WHERE source_id=$1 AND fact_id=ANY($2::bigint[]) RETURNING 1`],
    params: [['src-a', [1, 2]]],
  },
  {
    from: 'src/core/facts/purge.ts:563 submitPurgeFactMutation',
    member: 'deletePurgeWriteGateHolds',
    run: e => e.deletePurgeWriteGateHolds('src-a', 'hash-a'),
    texts: [`DELETE FROM write_gate_holds WHERE source_id=$1
          AND gbrain_fact_fingerprint(COALESCE(payload->>'fact', payload->>'claim', ''))=$2 RETURNING id::text AS id`],
    params: [['src-a', 'hash-a']],
  },
  {
    from: 'src/core/facts/purge.ts:565 submitPurgeFactMutation',
    member: 'deletePurgeWriteGateReceipts',
    run: e => e.deletePurgeWriteGateReceipts(['1', '2'], ['5'], ['h1']),
    texts: [`DELETE FROM write_gate_receipts WHERE (target_table='facts' AND target_id=ANY($1::text[]))
          OR (target_table='takes' AND target_id=ANY($2::text[])) OR (target_table='write_gate_holds' AND target_id=ANY($3::text[])) RETURNING 1`],
    params: [[['1', '2'], ['5'], ['h1']]],
  },
  {
    from: 'src/core/facts/purge.ts:568 submitPurgeFactMutation',
    member: 'deletePurgeTakeProposals',
    run: e => e.deletePurgeTakeProposals('src-a', 'hash-a'),
    texts: [`DELETE FROM take_proposals WHERE source_id=$1 AND gbrain_fact_fingerprint(claim_text)=$2 RETURNING 1`],
    params: [['src-a', 'hash-a']],
  },
  {
    from: 'src/core/facts/purge.ts:569 submitPurgeFactMutation',
    member: 'blankPurgeCoreEditNotices',
    run: e => e.blankPurgeCoreEditNotices('src-a', 'tea'),
    texts: [`UPDATE core_edit_notices SET base_text=NULL WHERE source_id=$1 AND strpos(lower(base_text),$2)>0 RETURNING 1`],
    params: [['src-a', 'tea']],
  },
  {
    from: 'src/core/facts/purge.ts:571 submitPurgeFactMutation',
    member: 'deletePurgedFacts',
    run: e => e.deletePurgedFacts([1, 2], 'src-a'),
    texts: [`DELETE FROM facts WHERE id=ANY($1::bigint[]) AND source_id=$2 RETURNING id`],
    params: [[[1, 2], 'src-a']],
  },
  {
    from: 'src/core/facts/purge.ts:581 submitPurgeFactMutation',
    member: 'deletePurgedChunks',
    run: e => e.deletePurgedChunks([3, 4]),
    texts: [`WITH gone AS (DELETE FROM content_chunks WHERE page_id=ANY($1::integer[]) RETURNING page_id),
        unsealed AS (UPDATE pages SET text_projection_revision=NULL WHERE id IN (SELECT page_id FROM gone) AND text_projection_revision IS NOT NULL)
        SELECT 1 FROM gone`],
    params: [[[3, 4]]],
  },
  {
    // Main join (da99c637a7): the cli-members line's caller (purge.ts:591 at de72811022) sorted `ORDER BY slug COLLATE
    // "C"`; the join re-applied that byte order to main's member, so the pin carries it too.
    from: 'src/core/facts/purge.ts:590 submitPurgeFactMutation',
    member: 'listPurgedPageRevisions',
    run: e => e.listPurgedPageRevisions('src-a', [3, 4]),
    texts: [`SELECT id,slug,knowledge_revision::text AS knowledge_revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[]) ORDER BY slug COLLATE "C"`],
    params: [['src-a', [3, 4]]],
  },
  {
    from: 'src/core/facts/purge.ts:592 submitPurgeFactMutation',
    member: 'insertPurgeEffects',
    run: e => e.insertPurgeEffects('a0000000-0000-4000-8000-0000000000a1', 'src-a', { version: 2, mode: 'purge' }),
    texts: [`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
        SELECT $1::uuid,k.kind,$3::text::jsonb,s.id,s.incarnation,b.worktree_id
        FROM sources s LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
        CROSS JOIN (VALUES ('withdrawal-mirror'),('git'),('embedding')) AS k(kind)
        WHERE s.id=$2 ON CONFLICT(request_id,kind) DO NOTHING`],
    params: [['a0000000-0000-4000-8000-0000000000a1', 'src-a', '{"version":2,"mode":"purge"}']],
  },
];

describe('fact purge statements moved into typed members keep their Postgres text and values byte for byte', () => {
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
