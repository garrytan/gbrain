/**
 * The facts repair, doctor and trust members that replaced raw `executeRaw` sites (engine-sql/facts-repair.ts, facts-doctor.ts,
 * facts-trust.ts) send Postgres the statement text and binds their callers sent before the move. A drift here changes a
 * query plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member's recorded text and params equal the caller's old `executeRaw` statement byte for byte. Each
 *    expected text below is copied verbatim from the caller at 5e22f0c134 (the three that spliced shared builders, the
 *    facts pages read, the capture-dedup candidate read and the two claim-conflict reads, are the text those callers
 *    rendered at that commit).
 *  - Regression: a member that reorders a clause, renumbers a placeholder, binds a value differently or drops a cast
 *    changes what Postgres answers while the parity cases may still pass on a small fixture.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts) and
 *    these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records text and params; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

function recordingEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return { engine, statements: () => fake.statements().map(s => ({ text: s.text, params: s.params })) };
}

interface Pin {
  /** The caller site(s) the statement came from, at 5e22f0c134. */
  from: string;
  member: string;
  /** Runs the member and the params the caller bound with the statement (undefined: the caller bound none). */
  runs: Array<{ run: (e: PostgresEngine) => Promise<unknown>; params: unknown[] | undefined }>;
  text: string;
}

const PINS: Pin[] = [
  {
    // Main join (da99c637a7): the cli-members line's callers (agent-session-facts.ts:334 and captured-facts.ts:238 at
    // de72811022) sorted `ORDER BY id COLLATE "C"`; the join re-applied that byte order to main's member, so the pin
    // carries it too.
    from: 'src/core/repair/agent-session-facts.ts:334 activeSources; src/core/repair/captured-facts.ts:238 activeSources',
    member: 'listActiveSourceIds',
    runs: [{ run: e => e.listActiveSourceIds(), params: undefined }],
    text: `SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id COLLATE "C"`,
  },
  {
    from: 'src/core/repair/agent-session-facts.ts:338 brainId; src/core/repair/captured-facts.ts:254 plan; src/core/repair/captured-facts.ts:283 plan (emptyHash)',
    member: 'readRepairBrainId',
    runs: [{ run: e => e.readRepairBrainId(), params: undefined }],
    text: `SELECT brain_id FROM persistence_brain WHERE singleton=1`,
  },
  {
    from: 'src/core/repair/agent-session-facts.ts:299 agentSessionTakes',
    member: 'listAgentSessionTakeCandidates',
    runs: [{ run: e => e.listAgentSessionTakeCandidates(['s1', 's2'], [4, 5], 'NOTE'), params: [['s1', 's2'], [4, 5], 'NOTE'] }, { run: e => e.listAgentSessionTakeCandidates(['s1'], null, 'NOTE'), params: [['s1'], null, 'NOTE'] }],
    text: `
    WITH contributing AS (
      SELECT f.consolidated_into AS take_id, array_agg(f.id ORDER BY f.id) AS fact_ids,
             COALESCE(array_agg(f.id ORDER BY f.id) FILTER (WHERE f.attributed_to IS NULL OR f.attributed_to='user'), '{}'::bigint[]) AS user_fact_ids,
             COALESCE(bool_or(f.attributed_to='other' AND position($3::text in COALESCE(f.context,''))>0), false) AS noted,
             min(f.consolidated_at) AS first_consolidated_at
        FROM facts f
       WHERE f.source_id=ANY($1::text[]) AND f.consolidated_into IS NOT NULL AND ($2::bigint[] IS NULL OR f.consolidated_into=ANY($2::bigint[]))
       GROUP BY f.consolidated_into)
    SELECT t.id, p.source_id, p.slug, t.row_num, t.claim, c.fact_ids, c.user_fact_ids, c.noted
      FROM contributing c JOIN takes t ON t.id=c.take_id JOIN pages p ON p.id=t.page_id
     WHERE p.source_id=ANY($1::text[]) AND t.kind='fact' AND t.holder='self' AND t.active AND t.resolved_at IS NULL
       AND t.created_at >= c.first_consolidated_at - interval '1 second'
     ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C", t.id`,
  },
  {
    from: 'src/core/repair/agent-session-facts.ts:423 apply',
    member: 'listSettledSessionFacts',
    runs: [{ run: e => e.listSettledSessionFacts('s1', [1, 2]), params: ['s1', [1, 2]] }],
    text: `SELECT id, context FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND attributed_to='other' AND expired_at IS NULL AND superseded_by IS NULL`,
  },
  {
    from: 'src/core/repair/agent-session-facts.ts:458 applyAgentSessionWrite',
    member: 'reattributeSessionFacts',
    runs: [{ run: e => e.reattributeSessionFacts('s1', [{ id: 1, note: 'n1' }, { id: 2, note: 'n2' }], ' | '), params: ['s1', '[{"id":1,"note":"n1"},{"id":2,"note":"n2"}]', ' | '] }],
    text: `UPDATE facts f
      SET attributed_to='other',
          context=CASE WHEN position(r.note in COALESCE(f.context,''))>0 THEN f.context ELSE concat_ws($3::text, NULLIF(f.context,''), r.note) END
     FROM jsonb_to_recordset($2::text::jsonb) AS r(id bigint, note text)
    WHERE f.source_id=$1 AND f.id=r.id AND (f.attributed_to IS NULL OR f.attributed_to='user') AND f.expired_at IS NULL AND f.superseded_by IS NULL
      AND f.row_num IS NULL
    RETURNING f.id`,
  },
  {
    from: 'src/core/repair/agent-session-facts.ts:465 applyAgentSessionWrite',
    member: 'retireSessionTakes',
    runs: [{ run: e => e.retireSessionTakes('s1', [7, 8]), params: ['s1', [7, 8]] }],
    text: `UPDATE takes t SET active=false, updated_at=now()
     FROM pages p
    WHERE p.id=t.page_id AND p.source_id=$1 AND t.id=ANY($2::bigint[]) AND t.active AND t.resolved_at IS NULL AND t.kind='fact' AND t.holder='self'
      AND t.created_at >= (SELECT min(f.consolidated_at) FROM facts f WHERE f.consolidated_into=t.id) - interval '1 second'
      AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.consolidated_into=t.id AND (f.attributed_to IS NULL OR f.attributed_to='user'))
    RETURNING t.id`,
  },
  {
    from: 'src/core/repair/agent-session-facts.ts:517 rewriteFencedFacts; src/core/repair/captured-facts.ts:362 strikeFencedRows',
    member: 'listFenceRewriteRows',
    runs: [{ run: e => e.listFenceRewriteRows('s1', [1, 2]), params: ['s1', [1, 2]] }],
    text: `SELECT id, fact, row_num FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND expired_at IS NULL`,
  },
  {
    from: 'src/core/repair/agent-session-facts.ts:535 rewriteFencedFacts',
    member: 'listOtherAttributedFactIds',
    runs: [{ run: e => e.listOtherAttributedFactIds('s1', [1]), params: ['s1', [1]] }],
    text: `SELECT id FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND attributed_to='other'`,
  },
  {
    from: 'src/core/repair/agent-session-facts.ts:558 retireTakes',
    member: 'listInactiveTakeIds',
    runs: [{ run: e => e.listInactiveTakeIds([1, 2]), params: [[1, 2]] }],
    text: `SELECT id FROM takes WHERE id=ANY($1::bigint[]) AND active=false`,
  },
  {
    from: 'src/core/repair/captured-facts.ts:318 expireRows',
    member: 'expireCapturedFacts',
    runs: [{ run: e => e.expireCapturedFacts('s1', [1, 2], 'CTX'), params: ['s1', [1, 2], 'CTX'] }],
    text: `UPDATE facts
    SET expired_at=now(), context=concat_ws(' | ', $3::text, NULLIF(context,''))
  WHERE source_id=$1 AND id=ANY($2::bigint[]) AND expired_at IS NULL AND row_num IS NULL RETURNING id`,
  },
  {
    from: 'src/core/repair/captured-facts.ts:381 strikeFencedRows',
    member: 'listExpiredFactIds',
    runs: [{ run: e => e.listExpiredFactIds('s1', [1]), params: ['s1', [1]] }],
    text: `SELECT id FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND expired_at IS NOT NULL`,
  },
  {
    // Main join (da99c637a7): the cli-members line's caller (facts-rehome.ts:65 at de72811022) sorted `f.source_id
    // COLLATE "C", f.entity_slug COLLATE "C"`; the join re-applied that byte order to main's member, so the pin
    // carries it too.
    from: 'src/core/repair/facts-rehome.ts:57 classifyPagelessEntities',
    member: 'listPagelessEntityFacts',
    runs: [{ run: e => e.listPagelessEntityFacts(['s1', 's2']), params: [['s1', 's2']] }],
    text: `
    SELECT f.source_id, f.entity_slug AS slug,
           array_agg(f.id ORDER BY f.id) FILTER (WHERE f.row_num IS NULL) AS ids,
           count(*) FILTER (WHERE f.row_num IS NOT NULL) AS fenced
      FROM facts f
     WHERE f.source_id = ANY($1::text[]) AND f.entity_slug IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
     GROUP BY f.source_id, f.entity_slug
     ORDER BY f.source_id COLLATE "C", f.entity_slug COLLATE "C"`,
  },
  {
    // Main join (da99c637a7): the cli-members line's caller (facts-rehome.ts:86 at de72811022) sorted `ORDER BY id
    // COLLATE "C"`; the join re-applied that byte order to main's member, so the pin carries it too.
    from: 'src/core/repair/facts-rehome.ts:85 sourcesOf',
    member: 'listSourceIncarnations',
    runs: [{ run: e => e.listSourceIncarnations(['s1']), params: [['s1']] }],
    text: `SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C"`,
  },
  {
    from: 'src/core/repair/facts-rehome.ts:134 apply',
    member: 'readEntityRehomeState',
    runs: [{ run: e => e.readEntityRehomeState('s1', 'old/slug', 'new/slug'), params: ['s1', 'old/slug', 'new/slug'] }],
    text: `
        SELECT EXISTS (SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL) AS from_live,
               EXISTS (SELECT 1 FROM pages WHERE source_id = $1 AND slug = $3 AND deleted_at IS NULL) AS to_live,
               (SELECT array_agg(id ORDER BY id) FROM facts WHERE source_id = $1 AND entity_slug = $2 AND row_num IS NULL) AS ids`,
  },
  {
    from: 'src/core/repair/facts-rehome.ts:142 apply',
    member: 'rehomeEntityFacts',
    runs: [{ run: e => e.rehomeEntityFacts('s1', 'old/slug', 'new/slug'), params: ['s1', 'old/slug', 'new/slug'] }],
    text: `UPDATE facts SET entity_slug = $3 WHERE source_id = $1 AND entity_slug = $2 AND row_num IS NULL`,
  },
  {
    from: 'src/commands/doctor/checks/fence-integrity.ts:193 fenceIntegrity',
    member: 'countSegmentedCensusPages',
    runs: [{ run: e => e.countSegmentedCensusPages(['a', 'b'], ['b']), params: [['a', 'b'], ['b']] }],
    text: `SELECT COUNT(*)::int AS n FROM pages
    WHERE deleted_at IS NULL AND page_kind = 'markdown' AND body_storage = 'segmented' AND source_id = ANY($1::text[])
      AND (source_path IS NULL OR NOT (source_id = ANY($2::text[])))`,
  },
  {
    from: 'src/commands/doctor/checks/facts-pages.ts:25 factsUndatedLines',
    member: 'listFactsPageBodies',
    runs: [{ run: e => e.listFactsPageBodies(), params: undefined }],
    text: `SELECT p.slug, p.source_id, p.body_storage = 'segmented' AS segmented, left(coalesce(p.compiled_truth, p.truth_lead), 65536) AS body
         FROM pages p WHERE p.type = 'facts' AND p.deleted_at IS NULL ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C"`,
  },
  {
    from: 'src/commands/doctor/checks/unlinked-facts.ts:72 unlinkedFactsStats',
    member: 'readFactTableCatalog',
    runs: [{ run: e => e.readFactTableCatalog(), params: undefined }],
    text: `SELECT to_regclass('facts')::text AS facts, to_regclass('fact_relink_attempts')::text AS attempts`,
  },
  {
    from: 'src/core/facts/write-single.ts:171 writeSingleFact',
    member: 'readFactEntitySlugById',
    runs: [{ run: e => e.readFactEntitySlugById(9), params: [9] }],
    text: `SELECT entity_slug FROM facts WHERE id=$1`,
  },
  {
    from: 'src/core/facts/write-single.ts:307 expireSuperseded',
    member: 'readSupersessionReplacement',
    runs: [{ run: e => e.readSupersessionReplacement(5, 4), params: [5, 4] }],
    text: `SELECT n.row_num, n.source_markdown_slug IS NOT DISTINCT FROM o.source_markdown_slug AS same_page, n.valid_from, o.valid_from AS old_from, o.valid_until AS old_until
         FROM facts n, facts o WHERE n.id = $1 AND o.id = $2`,
  },
  {
    from: 'src/core/facts/write-single.ts:317 expireSuperseded',
    member: 'linkSupersededFact',
    runs: [{ run: e => e.linkSupersededFact(4, 5), params: [5, 4] }],
    text: `UPDATE facts SET superseded_by = $1 WHERE id = $2`,
  },
  {
    from: 'src/core/facts/capture-dedup.ts:138 entityNames',
    member: 'listLivePageTitles',
    runs: [{ run: e => e.listLivePageTitles('s1', ['people/a']), params: ['s1', ['people/a']] }],
    text: `SELECT slug,title FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL`,
  },
  {
    from: 'src/core/facts/capture-dedup.ts:142 entityNames',
    member: 'listPageAliasNames',
    runs: [{ run: e => e.listPageAliasNames('s1', ['people/a']), params: ['s1', ['people/a']] }],
    text: `SELECT slug,alias_norm FROM page_aliases WHERE source_id=$1 AND slug=ANY($2::text[])`,
  },
  {
    from: 'src/core/facts/capture-dedup.ts:174 findCaptureDuplicate',
    member: 'listCaptureDuplicateCandidates',
    runs: [{ run: e => e.listCaptureDuplicateCandidates({ sourceId: 's1', visibilities: ['world', 'private'], fact: 'f', attributedTo: null, replacingPage: 'p/x', scanLimit: 50 }), params: ['s1', ['world', 'private'], 'f', null, 'p/x'] }],
    text: `SELECT id,entity_slug,source,source_session,created_at FROM facts WHERE source_id=$1 AND visibility=ANY($2::text[])
      AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($3) AND expired_at IS NULL AND (valid_until IS NULL OR valid_until>now())
      AND ($4::text IS NULL OR attributed_to IS NULL OR attributed_to=$4)
      AND ($5::text IS NULL OR source_markdown_slug IS DISTINCT FROM $5 OR source NOT LIKE 'cli:extract-conversation-facts%')
      AND NOT (starts_with(COALESCE(facts.source_markdown_slug, ''), 'memory/members/') OR COALESCE(facts.source_markdown_slug, '') = 'memory/scope')
      ORDER BY created_at DESC, id DESC LIMIT 50`,
  },
  {
    from: 'src/core/facts/capture-dedup.ts:346 collapseFactReads',
    member: 'computeFactFingerprints',
    runs: [{ run: e => e.computeFactFingerprints(['x', 'y']), params: [['x', 'y']] }],
    text: `SELECT gbrain_fact_fingerprint(c) AS fp FROM unnest($1::text[]) WITH ORDINALITY AS t(c, n) ORDER BY n`,
  },
  {
    from: 'src/core/facts/claim-conflicts.ts:103 findClaimConflicts',
    member: 'listClaimConflictPairs',
    runs: [{ run: e => e.listClaimConflictPairs('s1', ['audit:a', 'audit:b'], 3), params: ['s1', ['audit:a', 'audit:b'], 3] }],
    text: `WITH f AS (
  SELECT id, entity_slug, visibility, claim_metric, claim_value, claim_unit, claim_period, valid_from, source_markdown_slug, (CASE WHEN lower(btrim(COALESCE(facts.claim_period, ''))) IN ('annual', 'annually', 'yearly') THEN to_char((facts.valid_from AT TIME ZONE 'UTC'), 'YYYY') WHEN lower(btrim(COALESCE(facts.claim_period, ''))) IN ('quarterly') THEN to_char((facts.valid_from AT TIME ZONE 'UTC'), 'YYYY-"Q"Q') WHEN lower(btrim(COALESCE(facts.claim_period, ''))) IN ('monthly') THEN to_char((facts.valid_from AT TIME ZONE 'UTC'), 'YYYY-MM') WHEN lower(btrim(COALESCE(facts.claim_period, ''))) IN ('weekly') THEN to_char((facts.valid_from AT TIME ZONE 'UTC'), 'IYYY-"W"IW') ELSE to_char((facts.valid_from AT TIME ZONE 'UTC'), 'YYYY-MM-DD') END) AS bucket
    FROM facts
   WHERE source_id = $1 AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())
     AND entity_slug IS NOT NULL AND claim_metric IS NOT NULL AND claim_value IS NOT NULL AND source <> ALL($2::text[]))
SELECT n.id AS new_fact_id, o.id AS old_fact_id, n.entity_slug, n.visibility, n.claim_metric, n.claim_unit, n.claim_period, n.bucket, n.claim_value AS new_value, o.claim_value AS old_value
FROM f n JOIN f o
    ON o.entity_slug = n.entity_slug AND o.visibility = n.visibility AND o.claim_metric = n.claim_metric
   AND o.claim_unit IS NOT DISTINCT FROM n.claim_unit AND o.claim_period IS NOT DISTINCT FROM n.claim_period
   AND o.bucket = n.bucket AND o.claim_value <> n.claim_value
   AND (NOT ((starts_with(COALESCE(n.source_markdown_slug, ''), 'memory/members/') OR COALESCE(n.source_markdown_slug, '') = 'memory/scope') OR (starts_with(COALESCE(o.source_markdown_slug, ''), 'memory/members/') OR COALESCE(o.source_markdown_slug, '') = 'memory/scope')) OR o.source_markdown_slug = n.source_markdown_slug)
   AND (o.valid_from < n.valid_from OR (o.valid_from = n.valid_from AND o.id < n.id))
 WHERE NOT EXISTS (SELECT 1 FROM decide_proposals p WHERE p.source_id = $1
         AND LEAST(p.new_fact_id, p.old_fact_id) = LEAST(n.id, o.id) AND GREATEST(p.new_fact_id, p.old_fact_id) = GREATEST(n.id, o.id))
   AND NOT EXISTS (SELECT 1 FROM trust_proposals tp WHERE tp.status = 'pending' AND tp.action = 'supersede_fact'
         AND tp.target_table = 'facts' AND tp.related_table = 'facts'
         AND ((tp.target_id = o.id AND tp.related_id = n.id) OR (tp.target_id = n.id AND tp.related_id = o.id)))
 ORDER BY n.id, o.id
 LIMIT $3`,
  },
  {
    from: 'src/core/facts/claim-conflicts.ts:112 findClaimConflicts',
    member: 'countClaimConflictPairs',
    runs: [{ run: e => e.countClaimConflictPairs('s1', ['audit:a', 'audit:b']), params: ['s1', ['audit:a', 'audit:b']] }],
    text: `WITH f AS (
  SELECT id, entity_slug, visibility, claim_metric, claim_value, claim_unit, claim_period, valid_from, source_markdown_slug, (CASE WHEN lower(btrim(COALESCE(facts.claim_period, ''))) IN ('annual', 'annually', 'yearly') THEN to_char((facts.valid_from AT TIME ZONE 'UTC'), 'YYYY') WHEN lower(btrim(COALESCE(facts.claim_period, ''))) IN ('quarterly') THEN to_char((facts.valid_from AT TIME ZONE 'UTC'), 'YYYY-"Q"Q') WHEN lower(btrim(COALESCE(facts.claim_period, ''))) IN ('monthly') THEN to_char((facts.valid_from AT TIME ZONE 'UTC'), 'YYYY-MM') WHEN lower(btrim(COALESCE(facts.claim_period, ''))) IN ('weekly') THEN to_char((facts.valid_from AT TIME ZONE 'UTC'), 'IYYY-"W"IW') ELSE to_char((facts.valid_from AT TIME ZONE 'UTC'), 'YYYY-MM-DD') END) AS bucket
    FROM facts
   WHERE source_id = $1 AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())
     AND entity_slug IS NOT NULL AND claim_metric IS NOT NULL AND claim_value IS NOT NULL AND source <> ALL($2::text[]))
SELECT COUNT(*) AS n
FROM f n JOIN f o
    ON o.entity_slug = n.entity_slug AND o.visibility = n.visibility AND o.claim_metric = n.claim_metric
   AND o.claim_unit IS NOT DISTINCT FROM n.claim_unit AND o.claim_period IS NOT DISTINCT FROM n.claim_period
   AND o.bucket = n.bucket AND o.claim_value <> n.claim_value
   AND (NOT ((starts_with(COALESCE(n.source_markdown_slug, ''), 'memory/members/') OR COALESCE(n.source_markdown_slug, '') = 'memory/scope') OR (starts_with(COALESCE(o.source_markdown_slug, ''), 'memory/members/') OR COALESCE(o.source_markdown_slug, '') = 'memory/scope')) OR o.source_markdown_slug = n.source_markdown_slug)
   AND (o.valid_from < n.valid_from OR (o.valid_from = n.valid_from AND o.id < n.id))
 WHERE NOT EXISTS (SELECT 1 FROM decide_proposals p WHERE p.source_id = $1
         AND LEAST(p.new_fact_id, p.old_fact_id) = LEAST(n.id, o.id) AND GREATEST(p.new_fact_id, p.old_fact_id) = GREATEST(n.id, o.id))
   AND NOT EXISTS (SELECT 1 FROM trust_proposals tp WHERE tp.status = 'pending' AND tp.action = 'supersede_fact'
         AND tp.target_table = 'facts' AND tp.related_table = 'facts'
         AND ((tp.target_id = o.id AND tp.related_id = n.id) OR (tp.target_id = n.id AND tp.related_id = o.id)))`,
  },
  {
    // Main join (da99c637a7): the cli-members line's caller (claim-conflicts.ts:125 at de72811022) sorted `ORDER BY id
    // COLLATE "C"`; the join re-applied that byte order to main's member, so the pin carries it too.
    from: 'src/core/facts/claim-conflicts.ts:125 runClaimConflicts',
    member: 'listUnarchivedSourceRows',
    runs: [{ run: e => e.listUnarchivedSourceRows(), params: undefined }],
    // The byte-order pass (source-id-order-collation guard, commit 5065136f1f) added COLLATE "C" to the member's one read.
    text: `SELECT id FROM sources WHERE NOT archived ORDER BY id COLLATE "C"`,
  },
  {
    from: 'src/core/engine-sql/facts-trust.ts listAllUnarchivedSourceIds (the same read as listUnarchivedSourceRows, byte order)',
    member: 'listAllUnarchivedSourceIds',
    runs: [{ run: e => e.listAllUnarchivedSourceIds(), params: undefined }],
    text: `SELECT id FROM sources WHERE NOT archived ORDER BY id COLLATE "C"`,
  },
];

describe('caller raw SQL moved into facts repair, doctor and trust members keeps its Postgres text byte for byte', () => {
  for (const pin of PINS) {
    test(`${pin.member} (${pin.from})`, async () => {
      for (const r of pin.runs) {
        const { engine, statements } = recordingEngine();
        await r.run(engine);
        const sent = statements();
        expect(sent.length).toBe(1);
        expect(sent[0]!.text).toBe(pin.text);
        if (r.params !== undefined) expect(sent[0]!.params).toEqual(r.params);
        else expect(sent[0]!.params.length).toBe(0);
      }
    });
  }
});
