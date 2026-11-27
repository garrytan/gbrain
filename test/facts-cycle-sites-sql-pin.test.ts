/**
 * Byte-identical pins for the facts cycle, fence, phantom-redirect and file-guard raw SQL that became typed engine members
 * (Rust engine lane 4, item 4.2; src/core/engine-sql/facts-cycle.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text and binds its caller ran through `executeRaw` before
 *    the move. Each expected text below is the caller's text at 5e22f0c134, with the caller's own constants (the facts-home
 *    column list and holding-slug tests, the page-state history limit, the `FOR UPDATE` suffix) written out.
 *  - Regression: an edited statement changes what Postgres and PGLite answer while the parity cases may still pass on a
 *    small fixture, and a renumbered placeholder or a reordered bind changes a write.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts),
 *    and these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records the text and binds; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { holdingSlugSql } from '../src/core/facts-fence.ts';
import { runCase, withPinnedSqlEnvironment, type SqlCase } from './helpers/postgres-engine-sql-cases.ts';

interface Pin {
  /** The caller sites the statement came from, at 5e22f0c134. */
  from: string;
  case: SqlCase;
  /** The statement texts, in order, as the caller sent them. */
  texts: string[];
  /** The bound values of each statement, in order. */
  params: unknown[][];
}

const CELLS = {
  kind: 'preference', visibility: 'private', notability: 'high', context: 'ctx', validFrom: '2026-02-01T00:00:00.000Z', setValidUntil: true,
  validUntil: '2031-01-01T00:00:00.000Z', expiredAt: null, source: 'fence:edit', confidence: 0.4, claimMetric: 'arr', claimValue: 2.5, claimUnit: 'usd', claimPeriod: 'q2',
};

const PINS: Pin[] = [
  {
    from: 'src/core/cycle/phantom-redirect.ts:417 movePhantomFacts',
    case: { method: 'listPhantomFactRows', variant: 'default', run: async e => { await e.listPhantomFactRows('src-a', 'phantom'); } },
    texts: [`SELECT id, row_num FROM facts WHERE source_id = $1 AND source_markdown_slug = $2`],
    params: [['src-a', 'phantom']],
  },
  {
    from: 'src/core/cycle/phantom-redirect.ts:421 movePhantomFacts',
    case: { method: 'listCanonicalFenceRowNums', variant: 'default', run: async e => { await e.listCanonicalFenceRowNums('src-a', 'canon'); } },
    texts: [`SELECT row_num FROM facts WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL`],
    params: [['src-a', 'canon']],
  },
  {
    from: 'src/core/cycle/phantom-redirect.ts:433 movePhantomFacts',
    case: { method: 'moveFactToPage', variant: 'default', run: async e => { await e.moveFactToPage('src-a', 7, 'canon', 3); await e.moveFactToPage('src-a', 8, 'canon', null); } },
    texts: [`UPDATE facts SET entity_slug = $3, source_markdown_slug = $3, row_num = $4::integer,
          expired_at = CASE WHEN $4::integer IS NULL THEN COALESCE(expired_at, now()) ELSE expired_at END
        WHERE id = $1 AND source_id = $2`,
      `UPDATE facts SET entity_slug = $3, source_markdown_slug = $3, row_num = $4::integer,
          expired_at = CASE WHEN $4::integer IS NULL THEN COALESCE(expired_at, now()) ELSE expired_at END
        WHERE id = $1 AND source_id = $2`],
    params: [[7, 'src-a', 'canon', 3], [8, 'src-a', 'canon', null]],
  },
  {
    from: 'src/core/cycle/phantom-redirect.ts:450 mergePhantomLinks',
    case: { method: 'repointInboundLinks', variant: 'default', run: async e => { await e.repointInboundLinks(1, 2); } },
    texts: [`UPDATE links l SET to_page_id = $2
      WHERE l.to_page_id = $1 AND l.from_page_id <> $2
        AND NOT EXISTS (SELECT 1 FROM links d
          WHERE d.from_page_id = l.from_page_id AND d.to_page_id = $2 AND d.link_type = l.link_type
            AND d.link_source IS NOT DISTINCT FROM l.link_source
            AND d.origin_page_id IS NOT DISTINCT FROM l.origin_page_id)`],
    params: [[1, 2]],
  },
  {
    from: 'src/core/cycle/phantom-redirect.ts:459 mergePhantomLinks',
    case: { method: 'repointOutboundLinks', variant: 'default', run: async e => { await e.repointOutboundLinks(1, 2); } },
    texts: [`UPDATE links l SET from_page_id = $2
      WHERE l.from_page_id = $1 AND l.to_page_id <> $2
        AND NOT EXISTS (SELECT 1 FROM links d
          WHERE d.from_page_id = $2 AND d.to_page_id = l.to_page_id AND d.link_type = l.link_type
            AND d.link_source IS NOT DISTINCT FROM l.link_source
            AND d.origin_page_id IS NOT DISTINCT FROM l.origin_page_id)`],
    params: [[1, 2]],
  },
  {
    from: 'src/core/cycle/phantom-redirect.ts:564 phantomHasResidue; src/core/cycle/phantom-redirect-managed.ts:122 noTimeline',
    case: { method: 'pageHasTimelineEntries', variant: 'default', run: async e => { await e.pageHasTimelineEntries(5); } },
    texts: [`SELECT 1 FROM timeline_entries WHERE page_id=$1 LIMIT 1`],
    params: [[5]],
  },
  {
    from: 'src/core/cycle/phantom-redirect.ts:664 tryRedirectPhantom; src/core/cycle/phantom-redirect-managed.ts:47 redirectManagedPhantom',
    case: { method: 'maxFenceRowNumOfPage', variant: 'default', run: async e => { await e.maxFenceRowNumOfPage('src-a', 'canon'); } },
    texts: [`SELECT MAX(row_num) AS n FROM facts WHERE source_id = $1 AND source_markdown_slug = $2`],
    params: [['src-a', 'canon']],
  },
  {
    // Main join (da99c637a7): the cli-members line's caller (phantom-redirect.ts:788 at de72811022) compared and sorted
    // with `slug COLLATE "C"`; the join re-applied that byte order to main's member, so the pin carries it too.
    from: 'src/core/cycle/phantom-redirect.ts:782 runPhantomRedirectPass',
    case: { method: 'listRootPageSlugsAfter', variant: 'default', run: async e => { await e.listRootPageSlugsAfter('src-a', 51, ['held'], 'after'); } },
    texts: [`SELECT slug FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND slug NOT LIKE '%/%'
         AND slug <> ALL($3::text[])
         AND slug COLLATE "C" > $4
       ORDER BY slug COLLATE "C" ASC
       LIMIT $2`],
    params: [['src-a', 51, ['held'], 'after']],
  },
  {
    from: 'src/core/cycle/phantom-redirect-managed.ts:97 apply',
    case: { method: 'listOwnLinkIds', variant: 'default', run: async e => { await e.listOwnLinkIds(3); } },
    texts: [`SELECT id FROM links WHERE from_page_id = $1 AND origin_page_id IS NULL`],
    params: [[3]],
  },
  {
    from: 'src/core/cycle/phantom-redirect-managed.ts:98 apply',
    case: { method: 'listActiveFactIdsOfPage', variant: 'default', run: async e => { await e.listActiveFactIdsOfPage('src-a', 'phantom'); } },
    texts: [`SELECT id FROM facts WHERE source_id = $1 AND source_markdown_slug = $2 AND expired_at IS NULL`],
    params: [['src-a', 'phantom']],
  },
  {
    from: 'src/core/cycle/phantom-redirect-managed.ts:104 apply',
    case: { method: 'listFactIdsStillOnPage', variant: 'default', run: async e => { await e.listFactIdsStillOnPage([1, 2], 'canon'); } },
    texts: [`SELECT id FROM facts WHERE id = ANY($1::bigint[]) AND source_markdown_slug = $2 AND expired_at IS NULL`],
    params: [[[1, 2], 'canon']],
  },
  {
    from: 'src/core/cycle/phantom-redirect-managed.ts:106 apply',
    case: { method: 'listLinkIdsOnPage', variant: 'default', run: async e => { await e.listLinkIdsOnPage([1, 2], 4); } },
    texts: [`SELECT id FROM links WHERE id = ANY($1::int[]) AND from_page_id = $2`],
    params: [[[1, 2], 4]],
  },
  {
    from: 'src/core/facts/unfenced-facts.ts:272 databaseOnlyPlacement; src/core/facts/facts-home.ts:136 heldUnmovable',
    case: { method: 'readPageFileOrigin', variant: 'default', run: async e => { await e.readPageFileOrigin('src-a', 'people/a'); } },
    texts: [`SELECT source_path, source_uri FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/write-through.ts:389 resolvePageWriteTarget (includeDeleted)',
    case: { method: 'readPageFileOrigin', variant: 'includeDeleted', run: async e => { await e.readPageFileOrigin('src-a', 'people/a', { includeDeleted: true }); } },
    texts: [`SELECT source_path, source_uri FROM pages WHERE source_id=$1 AND slug=$2`],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/unfenced-facts.ts:392 planFence',
    case: { method: 'listFenceRowClaims', variant: 'default', run: async e => { await e.listFenceRowClaims('src-a', 'people/a'); } },
    texts: [`SELECT row_num, fact, source FROM facts
      WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL`],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/unfenced-facts.ts:678 write',
    case: { method: 'adoptFactIntoFence', variant: 'default', run: async e => { await e.adoptFactIntoFence('src-a', '42', 7, 'people/a', 'a claim'); } },
    texts: [`UPDATE facts SET row_num = $1, source_markdown_slug = $2, fact = $5
            WHERE id = $3 AND source_id = $4 AND row_num IS NULL`],
    params: [[7, 'people/a', '42', 'src-a', 'a claim']],
  },
  {
    from: 'src/core/cycle/extract-facts.ts:202 syncSupersession',
    case: { method: 'listFenceRowSupersession', variant: 'default', run: async e => { await e.listFenceRowSupersession('src-a', 'people/a'); } },
    texts: [`SELECT id, row_num, expired_at, superseded_by FROM facts
      WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL`],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/cycle/extract-facts.ts:219 syncSupersession',
    case: { method: 'setFactSupersededBy', variant: 'default', run: async e => { await e.setFactSupersededBy('src-a', 4, 9); await e.setFactSupersededBy('src-a', 4, null); } },
    texts: [`UPDATE facts SET superseded_by = $1 WHERE id = $2 AND source_id = $3`,
      `UPDATE facts SET superseded_by = $1 WHERE id = $2 AND source_id = $3`],
    params: [[9, 4, 'src-a'], [null, 4, 'src-a']],
  },
  {
    from: 'src/core/cycle/extract-facts.ts:457 planFenceReconcile',
    case: { method: 'listHeldWideningFactIds', variant: 'default', run: async e => { await e.listHeldWideningFactIds('src-a', [1, 2]); } },
    texts: [`SELECT related_id AS id FROM trust_proposals WHERE source_id = $1 AND action IN ('supersede_fact', 'confirm') AND related_table = 'facts'
      AND related_id = ANY($2::bigint[]) AND status IN ('pending', 'rejected', 'undone') AND before_state->'visibility' IS NOT NULL`],
    params: [['src-a', [1, 2]]],
  },
  {
    from: 'src/core/cycle/extract-facts.ts:526 writeFenceReconcile',
    case: { method: 'expireFactInPlace', variant: 'default', run: async e => { await e.expireFactInPlace('src-a', 4); } },
    texts: [`UPDATE facts SET expired_at = COALESCE(expired_at, now()) WHERE id = $1 AND source_id = $2`],
    params: [[4, 'src-a']],
  },
  {
    from: 'src/core/cycle/extract-facts.ts:529 writeFenceReconcile',
    case: { method: 'expireAndDetachFact', variant: 'default', run: async e => { await e.expireAndDetachFact('src-a', 4); } },
    texts: [`UPDATE facts SET expired_at = COALESCE(expired_at, now()), row_num = NULL
        WHERE id = $1 AND source_id = $2`],
    params: [[4, 'src-a']],
  },
  {
    // master #10389 (313005fe9a) changed the valid_from rule of this statement; the pin follows master's new text.
    from: 'src/core/cycle/extract-facts.ts:536 writeFenceReconcile',
    case: { method: 'updateFenceFactCells', variant: 'default', run: async e => { await e.updateFenceFactCells('src-a', 4, CELLS); } },
    texts: [`UPDATE facts SET kind = $3, visibility = $4, notability = $5, context = $6,
          valid_from = CASE WHEN $7::timestamptz IS NULL OR valid_from = $7::timestamptz OR date_trunc('second', valid_from) = $7::timestamptz THEN valid_from ELSE $7::timestamptz END,
          valid_until = CASE WHEN $8::boolean THEN $9::timestamptz ELSE valid_until END,
          expired_at = CASE WHEN $10::timestamptz IS NULL THEN NULL ELSE COALESCE(expired_at, $10::timestamptz) END,
          source = $11, confidence = $12,
          claim_metric = $13, claim_value = $14, claim_unit = $15, claim_period = $16
        WHERE id = $1 AND source_id = $2`],
    params: [[4, 'src-a', 'preference', 'private', 'high', 'ctx', '2026-02-01T00:00:00.000Z', true, '2031-01-01T00:00:00.000Z', null, 'fence:edit', 0.4, 'arr', 2.5, 'usd', 'q2']],
  },
  {
    from: 'src/core/cycle/extract-facts.ts:671 expireDeletedPageFacts',
    case: { method: 'listExpirableFactIdsOfDeletedPage', variant: 'default', run: async e => { await e.listExpirableFactIdsOfDeletedPage('src-a', 'people/a', 12); await e.listExpirableFactIdsOfDeletedPage('src-a', 'people/a', null); } },
    texts: [`SELECT f.id FROM facts f WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.row_num IS NOT NULL AND f.expired_at IS NULL
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND ($3::integer IS NULL OR p.id = $3::integer) AND p.deleted_at IS NOT NULL)`,
      `SELECT f.id FROM facts f WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.row_num IS NOT NULL AND f.expired_at IS NULL
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND ($3::integer IS NULL OR p.id = $3::integer) AND p.deleted_at IS NOT NULL)`],
    params: [['src-a', 'people/a', 12], ['src-a', 'people/a', null]],
  },
  {
    from: 'src/core/cycle/extract-facts.ts:676 expireDeletedPageFacts',
    case: { method: 'readDeletedPageBody', variant: 'default', run: async e => { await e.readDeletedPageBody('src-a', 'people/a'); } },
    texts: [`SELECT compiled_truth, timeline, body_storage FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NOT NULL ORDER BY id DESC LIMIT 1`],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/cycle/extract-facts.ts:681 expireDeletedPageFacts',
    case: { method: 'expireFactsByIds', variant: 'default', run: async e => { await e.expireFactsByIds('src-a', [1, 2]); } },
    texts: [`UPDATE facts SET expired_at = now() WHERE source_id = $1 AND id = ANY($2::bigint[]) AND expired_at IS NULL RETURNING id`],
    params: [['src-a', [1, 2]]],
  },
  {
    from: 'src/core/cycle/extract-facts.ts:898 runExtractFacts',
    case: { method: 'listOntologyObservationSlugs', variant: 'default', run: async e => { await e.listOntologyObservationSlugs('src-a'); } },
    texts: [`SELECT DISTINCT source_markdown_slug AS slug FROM facts
        WHERE source_id = $1 AND dimension IS NOT NULL AND expired_at IS NULL AND source_markdown_slug NOT LIKE '%/%'`],
    params: [['src-a']],
  },
  {
    from: 'src/core/cycle/extract-facts.ts:1178 deletedPagesWithActiveFacts',
    case: { method: 'listDeletedPageSlugsWithActiveFacts', variant: 'default', run: async e => { await e.listDeletedPageSlugsWithActiveFacts('src-a'); } },
    texts: [`SELECT DISTINCT f.source_markdown_slug AS slug FROM facts f
      WHERE f.source_id = $1 AND f.row_num IS NOT NULL AND f.expired_at IS NULL
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND p.deleted_at IS NOT NULL)
      ORDER BY 1`],
    params: [['src-a']],
  },
  {
    // Main join (da99c637a7): the cli-members line's caller (facts-home.ts:79 at de72811022) sorted
    // `f.entity_slug COLLATE "C" NULLS FIRST, f.id`; the join re-applied that byte order to main's member.
    from: 'src/core/facts/facts-home.ts:77 scanFactsHome',
    case: { method: 'scanUnfencedFactRows', variant: 'default', run: async e => { await e.scanUnfencedFactRows('src-a'); } },
    texts: [`SELECT f.id, f.source_id, f.entity_slug, f.fact, f.kind, f.visibility, f.notability, f.context, f.valid_from, f.valid_until, f.source,
  f.confidence, f.claim_metric, f.claim_value, f.claim_unit, f.claim_period, f.attributed_to, f.dimension, EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NULL) AS page_exists,
    EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NOT NULL) AS page_deleted FROM facts f
    WHERE f.source_id=$1 AND f.row_num IS NULL AND f.expired_at IS NULL ORDER BY f.entity_slug COLLATE "C" NULLS FIRST, f.id`],
    params: [['src-a']],
  },
  {
    // Main join (da99c637a7): the cli-members line's caller (facts-home.ts:97 at de72811022) sorted
    // `f.entity_slug COLLATE "C", f.id`; the join re-applied that byte order to main's member.
    from: 'src/core/facts/facts-home.ts:94 scanFactsHome',
    case: { method: 'listHeldFactRows', variant: 'default', run: async e => { await e.listHeldFactRows('src-a', '30'); } },
    texts: [`SELECT f.id, f.source_id, f.entity_slug, f.fact, f.kind, f.visibility, f.notability, f.context, f.valid_from, f.valid_until, f.source,
  f.confidence, f.claim_metric, f.claim_value, f.claim_unit, f.claim_period, f.attributed_to, EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NULL) AS page_exists, f.source_markdown_slug AS from_slug,
      to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS held_since, f.created_at < now() - ($2 || ' days')::interval AS old
     FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug IN (SELECT hp.slug FROM pages hp WHERE hp.source_id = $1 AND (hp.slug = 'memory/unattributed' OR hp.slug LIKE '%/memory/unattributed')) AND f.row_num IS NOT NULL AND f.expired_at IS NULL AND f.dimension IS NULL
      AND f.entity_slug IS NOT NULL AND NOT (f.entity_slug = 'memory/unattributed' OR f.entity_slug LIKE '%/memory/unattributed') ORDER BY f.entity_slug COLLATE "C", f.id`],
    params: [['src-a', '30']],
  },
  {
    from: 'src/core/facts/facts-home.ts:112 scanFactsHome',
    case: { method: 'listFencedFactsOfMissingPages', variant: 'default', run: async e => { await e.listFencedFactsOfMissingPages('src-a'); } },
    texts: [`SELECT f.id, f.source_markdown_slug AS slug FROM facts f WHERE f.source_id=$1 AND f.row_num IS NOT NULL
      AND f.expired_at IS NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL) ORDER BY f.id`],
    params: [['src-a']],
  },
  {
    from: 'src/core/facts/fence-write.ts:508 writeFactsToFence',
    case: { method: 'readFenceRowNumHint', variant: 'default', run: async e => { await e.readFenceRowNumHint('src-a', 'people/a'); } },
    texts: [`SELECT MAX(row_num) AS max_row_num FROM facts
            WHERE source_id = $1 AND source_markdown_slug = $2`],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/fence-write.ts:684 lookupSourceLocalPath',
    case: { method: 'readSourceCheckoutPath', variant: 'default', run: async e => { await e.readSourceCheckoutPath('src-a'); } },
    texts: [`SELECT local_path FROM sources WHERE id = $1 LIMIT 1`],
    params: [['src-a']],
  },
  {
    from: 'src/core/facts/file-body-guard.ts:49 readStoredBody',
    case: { method: 'readLiveStoredBody', variant: 'default', run: async e => { await e.readLiveStoredBody('src-a', 'people/a'); await e.readLiveStoredBody('src-a', 'people/a', true); } },
    texts: [`SELECT compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`,
      `SELECT compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE`],
    params: [['src-a', 'people/a'], ['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/file-body-guard.ts:145 replaceableFile',
    case: { method: 'listPageStates', variant: 'default', run: async e => { await e.listPageStates('src-a', 'people/a'); } },
    texts: [`(SELECT p.compiled_truth, p.timeline, p.frontmatter, p.title, p.type,
             to_jsonb(ARRAY(SELECT t.tag FROM tags t WHERE t.page_id = p.id)) AS tags
        FROM pages p WHERE p.source_id = $1 AND p.slug = $2)
     UNION ALL
     (SELECT v.compiled_truth, v.timeline, v.frontmatter, v.title, v.type, v.tags FROM page_versions v JOIN pages p ON p.id = v.page_id
       WHERE p.source_id = $1 AND p.slug = $2 AND v.compiled_truth IS NOT NULL ORDER BY v.id DESC LIMIT 20)`],
    params: [['src-a', 'people/a']],
  },
  {
    from: 'src/core/facts/fence-fact-append.ts:262 heldRowsInVersions',
    case: { method: 'countSegmentedVersionsOfPage', variant: 'default', run: async e => { await e.countSegmentedVersionsOfPage('src-a', 'people/a'); } },
    texts: [`SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id = v.page_id
    WHERE p.source_id = $1 AND p.slug = $2 AND v.body_storage = 'segmented'`],
    params: [['src-a', 'people/a']],
  },
];

describe('facts cycle raw SQL moved into typed members keeps its Postgres text and binds byte for byte', () => {
  for (const pin of PINS) {
    test(`${pin.case.method} (${pin.from})`, async () => {
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase(pin.case));
      expect(capture.error).toBeUndefined();
      const sent = capture.trace.filter(s => s.kind === 'query');
      expect(sent.map(s => s.text)).toEqual(pin.texts);
      expect(sent.map(s => s.params)).toEqual(pin.params);
    });
  }
});

describe('the facts-home held-row statement spells the holding-slug test the same way holdingSlugSql does', () => {
  test('both tests in listHeldFactRows are holdingSlugSql output', () => {
    const held = PINS.find(p => p.case.method === 'listHeldFactRows')!.texts[0];
    expect(held).toContain(holdingSlugSql('hp.slug'));
    expect(held).toContain(`NOT ${holdingSlugSql('f.entity_slug')}`);
  });
});
