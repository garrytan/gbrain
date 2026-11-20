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
    from: 'src/core/generations/adapters/atoms.ts:82 readInput (at ec2fbe7ba3)',
    case: { method: 'readAtomOriginInput', variant: 'default', run: e => e.readAtomOriginInput('default', 'notes/origin') },
    texts: [`SELECT id, content_hash, knowledge_revision::text AS revision,\n        CASE WHEN body_storage = 'segmented' THEN body_bytes ELSE octet_length(COALESCE(compiled_truth, '')) + octet_length(COALESCE(timeline, '')) END AS body_bytes\n       FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`],
  },
  {
    from: 'src/core/trust/taint.ts:127 lowerToDerivedTier (at d7fb3a97b7)',
    case: { method: 'lowerTrustTier', variant: 'pages', run: e => e.lowerTrustTier('pages', [3, 1], 'external_untrusted', { channel: 'derive:test' }) },
    texts: [`UPDATE pages SET trust_tier=$2,write_origin=$3::text::jsonb
      WHERE id=ANY($1::bigint[]) AND ${trustRankSql('trust_tier')}>${trustRankSql('$2::text')} RETURNING id`],
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
