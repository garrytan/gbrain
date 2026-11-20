/**
 * Byte-identical pins for the caller raw SQL that became typed engine members (Rust engine lane 11).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text its caller ran through `executeRaw` before the
 *    move. Each expected text below is copied verbatim from the caller at the commit its `from` names (7470c703ed
 *    unless it says otherwise).
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
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';

const ROLLUP_ROW = { kind: 'facts', sourceId: 'src-a', day: '2026-01-01', cost: 0.5, halts: 1, evalFails: 0, evalPasses: 2, completed: 0, expectedLimits: 0, failures: 0, reason: 'unknown' };

interface Pin {
  /** The caller site the statement came from, at 7470c703ed. */
  from: string;
  case: SqlCase;
  /** The statement texts, in order, as the caller sent them. */
  texts: string[];
}

const PINS: Pin[] = [
  {
    from: 'src/core/access/caller.ts:376 appliedAccessSummary',
    case: { method: 'listAppliedPolicyRevisions', variant: 'default', run: e => e.listAppliedPolicyRevisions() },
    texts: [`SELECT s.source_id, (SELECT r.revision FROM access_policy_revisions r WHERE r.source_id = s.source_id AND r.applied_at IS NOT NULL
          ORDER BY r.revision DESC LIMIT 1) AS rev FROM access_policy_state s ORDER BY s.source_id`],
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
    from: 'src/core/link-reconciliation.ts:442 lookupRefsForSlugs (the links and timeline pass\'s page refs, at 932324b281)',
    case: { method: 'listPageRefsForSlugs', variant: 'default', run: e => e.listPageRefsForSlugs(['a', 'b']) },
    texts: [`SELECT slug, source_id, type, knowledge_revision FROM pages
        WHERE deleted_at IS NULL AND slug IN ($1, $2)`],
  },
  {
    from: 'src/core/extract/rollup-writer.ts:199 upsertExtractRollup (at 54246f2bd8)',
    case: { method: 'upsertExtractRollup', variant: 'default', run: e => e.upsertExtractRollup(ROLLUP_ROW) },
    texts: [`INSERT INTO extract_rollup_7d (
         kind, source_id, day,
         cost_usd, halt_count, eval_fail_count, eval_pass_count,
         round_completed_count, expected_limit_count, rollup_write_failures, halt_reasons, updated_at
       )
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10,
         CASE WHEN $11::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object($11::text, $5::int) END, now())
       ON CONFLICT (kind, source_id, day) DO UPDATE SET
         cost_usd               = extract_rollup_7d.cost_usd               + EXCLUDED.cost_usd,
         halt_count             = extract_rollup_7d.halt_count             + EXCLUDED.halt_count,
         eval_fail_count        = extract_rollup_7d.eval_fail_count        + EXCLUDED.eval_fail_count,
         eval_pass_count        = extract_rollup_7d.eval_pass_count        + EXCLUDED.eval_pass_count,
         round_completed_count  = extract_rollup_7d.round_completed_count  + EXCLUDED.round_completed_count,
         expected_limit_count   = extract_rollup_7d.expected_limit_count   + EXCLUDED.expected_limit_count,
         rollup_write_failures  = extract_rollup_7d.rollup_write_failures  + EXCLUDED.rollup_write_failures,
         halt_reasons           = CASE WHEN $11::text IS NULL THEN extract_rollup_7d.halt_reasons
           ELSE jsonb_set(extract_rollup_7d.halt_reasons, ARRAY[$11::text],
             to_jsonb(COALESCE((extract_rollup_7d.halt_reasons->>$11::text)::int, 0) + $5::int)) END,
         updated_at             = now()`],
  },
  {
    from: 'src/core/extract/rollup-writer.ts:238 upsertExtractRollup, the pre-v141 retry (at 54246f2bd8)',
    case: { method: 'upsertExtractRollup', variant: 'pre-v141', run: e => e.upsertExtractRollup(ROLLUP_ROW, 'pre_v141') },
    texts: [`INSERT INTO extract_rollup_7d (
             kind, source_id, day,
             cost_usd, halt_count, eval_fail_count, eval_pass_count,
             round_completed_count, rollup_write_failures, updated_at
           )
           VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, now())
           ON CONFLICT (kind, source_id, day) DO UPDATE SET
             cost_usd               = extract_rollup_7d.cost_usd               + EXCLUDED.cost_usd,
             halt_count             = extract_rollup_7d.halt_count             + EXCLUDED.halt_count,
             eval_fail_count        = extract_rollup_7d.eval_fail_count        + EXCLUDED.eval_fail_count,
             eval_pass_count        = extract_rollup_7d.eval_pass_count        + EXCLUDED.eval_pass_count,
             round_completed_count  = extract_rollup_7d.round_completed_count  + EXCLUDED.round_completed_count,
             rollup_write_failures  = extract_rollup_7d.rollup_write_failures  + EXCLUDED.rollup_write_failures,
             updated_at             = now()`],
  },
  {
    from: 'src/core/extract/receipt-writer.ts:226 writeReceipt, the prior-row check (at 54246f2bd8)',
    case: { method: 'readExtractReceiptPrior', variant: 'default', run: e => e.readExtractReceiptPrior('src-a', 'extracts/a') },
    texts: ['SELECT type, source_path, source_uri, withheld_source_path FROM pages WHERE source_id=$1 AND slug=$2'],
  },
  {
    from: 'src/core/extract/receipt-writer.ts:242 writeReceipt, the seal check (at 54246f2bd8)',
    case: { method: 'readExtractReceiptSealed', variant: 'default', run: e => e.readExtractReceiptSealed('src-a', 'extracts/a') },
    texts: [`SELECT chunker_version >= ${SAFE_FENCE_CHUNKER_VERSION} AND text_projection_revision = knowledge_revision AS sealed FROM pages WHERE source_id=$1 AND slug=$2`],
  },
];

describe('caller raw SQL moved into typed members keeps its Postgres text byte for byte', () => {
  for (const pin of PINS) {
    test(`${pin.case.method}/${pin.case.variant} (${pin.from})`, async () => {
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase(pin.case));
      expect(capture.error).toBeUndefined();
      const sent = capture.trace.filter(s => s.kind === 'query').map(s => s.text);
      expect(sent).toEqual(pin.texts);
    });
  }
});
