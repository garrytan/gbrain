/**
 * The fact purge plan, dry run and --match members (src/core/engine-sql/facts-purge-plan.ts and the plan members of
 * src/core/engine-sql/facts-purge.ts) send Postgres the statement
 * text and binds planFactPurge (src/core/facts/purge.ts), verifyFactPurge (src/core/facts/purge-verify.ts),
 * findRequestsCarrying / findRequestsHoldingStagings (src/core/persistence/intent-redaction.ts) and derivedRowsFrom
 * (src/core/facts/derivation-inputs.ts) sent through `executeRaw` before they had members. A drift here changes a query
 * plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: each member's recorded text and params equal the old raw statement byte for byte (the texts below were
 * recorded from the raw callers before the move, with the byte-order sorts and the nearest-fact tie-break the main join added
 * to the page-body scan, the nearest-fact read and the probe item list), and the whole plan plus dry run still sends the same 101 statements,
 * in the same order and on the same lane (pool or transaction), as a sha256 of their texts, params and lanes.
 * Fails when a member reorders a clause, renumbers a placeholder, binds a value as text or moves a probe off the
 * transaction.
 * No database: the engine runs on the recording fake.
 */
import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { planFactPurge } from '../src/core/facts/purge.ts';
import { verifyFactPurge } from '../src/core/facts/purge-verify.ts';
import { findRequestsCarrying, findRequestsHoldingStagings } from '../src/core/persistence/intent-redaction.ts';
import { derivedRowsFrom } from '../src/core/facts/derivation-inputs.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

const CLAIM = 'Acme "raised" a Seed';
const CLAIM_LOWER = CLAIM.toLowerCase();
const CLAIM_JSON = JSON.stringify(CLAIM).slice(1, -1).toLowerCase();
const NEEDLES = { sourceId: 'src-a', claimLower: CLAIM_LOWER, claimJson: CLAIM_JSON, reason: CLAIM_LOWER };

function recordingEngine(rows?: Parameters<typeof makeFakeSql>[0]) {
  const fake = makeFakeSql(rows);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const last = () => {
    const s = fake.statements().at(-1)!;
    return { text: s.text, params: s.params };
  };
  return { engine, fake, last };
}

/** The old raw statements, recorded from the callers before the move. */
const OLD = {
  s0: { text: "SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL LIMIT 1",
    params: ["src-a", "acmename"] },
  s10: { text: "SELECT slug,id AS page_id,knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])",
    params: ["src-a", [9]] },
  s11: { text: "SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id\n    WHERE p.source_id=$1 AND ((strpos(lower(v.compiled_truth),$2)>0 OR strpos(lower(COALESCE(v.timeline,'')),$2)>0\n  OR strpos(lower(COALESCE(v.title,'')),$2)>0 OR strpos(lower(COALESCE(v.frontmatter::text,'')),$3)>0) OR strpos(lower(v.change_reason),$2)>0 OR strpos(lower(v.change_reason),$4)>0\n      OR (v.body_storage='segmented' AND EXISTS (SELECT 1 FROM page_body_manifest m JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256\n  WHERE m.page_id=v.page_id AND m.staging_id IS NULL AND m.gen_from<=v.body_generation AND (m.gen_to IS NULL OR m.gen_to>v.body_generation)\n    AND strpos(lower(convert_from(t.body,'UTF8')),$2)>0)))",
    params: ["src-a", "acme \"raised\" a seed", "acme \\\"raised\\\" a seed", "acme \"raised\" a seed"] },
  s12: { text: "SELECT s.id::text AS id FROM page_body_stagings s\n    WHERE s.source_id=$1 AND ((s.state IN ('open','sealed','prepared') AND (EXISTS (SELECT 1 FROM page_body_manifest m\n        JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256 WHERE m.staging_id=s.id AND strpos(lower(convert_from(t.body,'UTF8')),$2)>0)\n      OR EXISTS (SELECT 1 FROM page_body_staging_parts pt WHERE pt.staging_id=s.id AND position(convert_to($3::text,'UTF8') in pt.body)>0)))\n      OR ((s.state IN ('open','sealed','prepared')\n          OR EXISTS (SELECT 1 FROM persistence_requests rq WHERE rq.state IN ('queued','deferred','running','recovering')\n                      AND rq.intent->'body_ref'->>'staging_id' = s.id::text)) AND EXISTS (SELECT 1 FROM page_body_staging_texts r JOIN page_segment_texts t ON t.source_id=r.source_id AND t.sha256=r.sha256\n        WHERE r.staging_id=s.id AND (strpos(lower(convert_from(t.body,'UTF8')),$2)>0 OR strpos(lower(convert_from(t.body,'UTF8')),$4)>0))))\n    ORDER BY s.id",
    params: ["src-a", "acme \"raised\" a seed", "Acme \"raised\" a Seed", "acme \"raised\" a seed"] },
  s13: { text: "SELECT pt.staging_id::text AS id,pt.part_no,\n        substring(pt.body from 1 for $2) AS head,substring(pt.body from greatest(1,octet_length(pt.body)-$2+1)) AS tail\n      FROM page_body_staging_parts pt JOIN page_body_stagings s ON s.id=pt.staging_id\n      WHERE s.source_id=$1 AND s.state IN ('open','sealed','prepared') AND (pt.staging_id,pt.part_no)>($3::uuid,$4::int)\n      ORDER BY pt.staging_id,pt.part_no LIMIT 1000",
    params: ["src-a", 19, "00000000-0000-0000-0000-000000000000", -1] },
  s14: { text: "SELECT id::text AS id,principal_kind,principal_id FROM persistence_requests\n    WHERE source_id=$1 AND state IN ('queued','deferred','running','recovering') AND intent->'body_ref'->>'staging_id'=ANY($2::text[]) ORDER BY sequence",
    params: ["src-a", ["00000000-0000-0000-0000-0000000000aa"]] },
  s15: { text: "SELECT id::text AS id,principal_kind,principal_id FROM persistence_requests\n    WHERE source_id=$1 AND ((intent IS NOT NULL AND (strpos(lower(intent::text),$2)>0 OR strpos(lower(intent::text),$3)>0 OR strpos(lower(intent::text),$4)>0)) OR (outcome IS NOT NULL AND (strpos(lower(outcome::text),$2)>0 OR strpos(lower(outcome::text),$3)>0 OR strpos(lower(outcome::text),$4)>0)) OR (error_detail IS NOT NULL AND (strpos(lower(error_detail::text),$2)>0 OR strpos(lower(error_detail::text),$3)>0 OR strpos(lower(error_detail::text),$4)>0)) OR (error_message IS NOT NULL AND (strpos(lower(error_message::text),$2)>0 OR strpos(lower(error_message::text),$3)>0 OR strpos(lower(error_message::text),$4)>0)))\n    ORDER BY sequence LIMIT $5",
    params: ["src-a", "acme \"raised\" a seed", "acme \\\"raised\\\" a seed", "acme \\\"raised\\\" a seed", 10000] },
  s16: { text: "SELECT DISTINCT d.derived_table,d.derived_id\n      FROM derivation_inputs d JOIN jsonb_to_recordset($1::text::jsonb) AS f(input_table text,input_id text)\n        ON d.input_table=f.input_table AND d.input_id=f.input_id\n      ORDER BY d.derived_table,d.derived_id LIMIT $2",
    params: ["[{\"input_table\":\"takes\",\"input_id\":\"1\"}]", 1001] },
  s17: { text: "SELECT\n    (SELECT count(*)::int FROM decide_review_queue WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))) AS q,\n    (SELECT count(*)::int FROM decide_review_proposals WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))) AS rp,\n    (SELECT count(*)::int FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($3::bigint[]) OR old_fact_id=ANY($3::bigint[]))) AS dp",
    params: ["src-a", [], []] },
  s18: { text: "SELECT v.page_id,p.slug,v.body_generation AS generation,v.id AS version_id\n      FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND v.body_storage='segmented' ORDER BY v.id LIMIT $2",
    params: ["src-a", 1001] },
  s19: { text: "SELECT count(*)::int AS n FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL\n    AND (p.type='atom' OR p.frontmatter->>'dream_generated'='true')\n    AND NOT EXISTS (SELECT 1 FROM derivation_inputs d WHERE d.derived_table='pages' AND d.derived_id=p.id::text)",
    params: ["src-a"] },
  s20: { text: "SELECT set_config('statement_timeout',$1,true)",
    params: ["2000ms"] },
  s49: { text: "SELECT count(*)::int AS n FROM (SELECT 'link:' || l.id || ' ' || f.slug || ' -> ' || t.slug AS item FROM links l JOIN pages f ON f.id = l.from_page_id\n    JOIN pages t ON t.id = l.to_page_id WHERE (f.source_id = $1 OR t.source_id = $1) AND ((strpos(lower(l.context::text),$2)>0 OR strpos(lower(l.context::text),$3)>0)) LIMIT 1001) bounded",
    params: ["src-a", "acme \"raised\" a seed", "acme \\\"raised\\\" a seed"] },
  s71: { text: "SELECT count(*)::int AS n FROM (SELECT 'raw_data:' || r.id || ' ' || p.slug || ' ' || r.source AS item FROM raw_data r JOIN pages p ON p.id = r.page_id WHERE p.source_id = $1 AND ((strpos(lower(r.data::text),$2)>0 OR strpos(lower(r.data::text),$3)>0)) LIMIT 1001) bounded",
    params: ["src-a", "acme \"raised\" a seed", "acme \\\"raised\\\" a seed"] },
  s89: { text: "SELECT count(*)::int AS n FROM (SELECT 'timeline:' || x.id || ' ' || p.slug || ' ' || x.date::text AS item FROM timeline_entries x\n    JOIN pages p ON p.id = x.page_id WHERE p.source_id = $1 AND ((strpos(lower(x.summary::text),$2)>0 OR strpos(lower(x.summary::text),$3)>0) OR (strpos(lower(x.detail::text),$2)>0 OR strpos(lower(x.detail::text),$3)>0)) LIMIT 1001) bounded",
    params: ["src-a", "acme \"raised\" a seed", "acme \\\"raised\\\" a seed"] },
  s91: { text: "SELECT count(*)::int AS n FROM (SELECT 1 FROM wanted_links WHERE source_id=$1 AND ((strpos(lower(context::text),$2)>0 OR strpos(lower(context::text),$3)>0)) LIMIT 1001) bounded",
    params: ["src-a", "acme \"raised\" a seed", "acme \\\"raised\\\" a seed"] },
  s94: { text: "SELECT DISTINCT source_path FROM (\n      SELECT source_path FROM pages WHERE id=ANY($1::int[]) UNION ALL SELECT source_path FROM page_versions WHERE page_id=ANY($1::int[])) s\n    WHERE source_path IS NOT NULL AND source_path<>'' AND source_path NOT LIKE '/%' AND source_path NOT LIKE '%..%' LIMIT 64",
    params: [[9]] },
  s95: { text: "SELECT id, similarity, contains_claim FROM (\n        SELECT id,(1-(embedding <=> $1::halfvec))::float8 AS similarity, embedding <=> $1::halfvec AS distance,\n          strpos(gbrain_fact_normalize(fact),gbrain_fact_normalize($4))>0 AS contains_claim\n        FROM facts WHERE source_id=$2 AND embedding_model=$3 AND embedding IS NOT NULL\n        ORDER BY embedding <=> $1::halfvec LIMIT 5) nearest\n      ORDER BY distance, id",
    params: ["[1,0]", "src-a", "m", "Acme \"raised\" a Seed"] },
};

test('each plan and dry-run member sends the old statement text and binds', async () => {
  const { engine, last } = recordingEngine();
  await engine.purgeSubjectPageLive('src-a', 'acmename');
  expect(last()).toEqual(OLD.s0);
  await engine.listPurgePagesById('src-a', [9]);
  expect(last()).toEqual(OLD.s10);
  await engine.countPurgeVersionsCarryingClaim(NEEDLES.sourceId, NEEDLES.claimLower, NEEDLES.claimJson, NEEDLES.reason);
  expect(last()).toEqual(OLD.s11);
  await engine.listStagingsHoldingClaim('src-a', CLAIM);
  expect(last()).toEqual(OLD.s12);
  await engine.listStagingPartEdges('src-a', 19, { id: '00000000-0000-0000-0000-000000000000', part: -1 });
  expect(last()).toEqual(OLD.s13);
  await engine.listRequestsHoldingStagings('src-a', ['00000000-0000-0000-0000-0000000000aa']);
  expect(last()).toEqual(OLD.s14);
  await engine.listRequestsCarryingClaim({ ...NEEDLES, reason: CLAIM_JSON, limit: 10_000 });
  expect(last()).toEqual(OLD.s15);
  await engine.listDerivedRows([{ table: 'takes', id: '1' }], 1001);
  expect(last()).toEqual(OLD.s16);
  await engine.countPurgeReviewRows('src-a', [], []);
  expect(last()).toEqual(OLD.s17);
  await engine.listSegmentedVersionBodies('src-a', 1001);
  expect(last()).toEqual(OLD.s18);
  await engine.countLegacyDerivedPages('src-a');
  expect(last()).toEqual(OLD.s19);
  await engine.setPurgeProbeTimeout(2000);
  expect(last()).toEqual(OLD.s20);
  await engine.countPurgeProbe({ kind: 'named', table: 'links', sourceId: 'src-a', needles: [CLAIM] }, 1000);
  expect(last()).toEqual(OLD.s49);
  await engine.countPurgeProbe({ kind: 'named', table: 'raw_data', sourceId: 'src-a', needles: [CLAIM] }, 1000);
  expect(last()).toEqual(OLD.s71);
  await engine.countPurgeProbe({ kind: 'named', table: 'timeline_entries', sourceId: 'src-a', needles: [CLAIM] }, 1000);
  expect(last()).toEqual(OLD.s89);
  await engine.countPurgeProbe({ kind: 'table', table: 'wanted_links', sourceId: 'src-a', needles: [CLAIM] }, 1000);
  expect(last()).toEqual(OLD.s91);
  await engine.listPageSourcePathsForPurge([9]);
  expect(last()).toEqual(OLD.s94);
  await engine.listNearestFactsForPurge('[1,0]', 'src-a', 'm', CLAIM);
  expect(last()).toEqual(OLD.s95);
});

test('listPurgeMatchCandidates sends the old --match statement', async () => {
  const { engine, last } = recordingEngine();
  await engine.listPurgeMatchCandidates('src-a', 'Raised');
  expect(last()).toEqual({ text: `SELECT id,entity_slug,visibility,
    expired_at IS NOT NULL AS expired,left(fact,160) AS fact FROM facts WHERE source_id=$1 AND strpos(lower(fact),lower($2))>0 ORDER BY id LIMIT 25`,
  params: ['src-a', 'Raised'] });
});

test('listPurgeProbeItems names the rows of a named probe, 20 at most, in byte order of the item', async () => {
  const { engine, last } = recordingEngine();
  await engine.listPurgeProbeItems({ kind: 'named', table: 'links', sourceId: 'src-a', needles: [CLAIM] });
  const count = OLD.s49.text;
  const select = count.slice('SELECT count(*)::int AS n FROM ('.length, count.lastIndexOf(' LIMIT '));
  expect(last()).toEqual({ text: `SELECT item FROM (${select}) probe_items ORDER BY item COLLATE "C" LIMIT 20`, params: OLD.s49.params });
});

/**
 * sha256 of the 101 statements (text, params, lane) the plan and dry run below send: the 99 recorded before the move, plus
 * the learning_items.subject_slug probe (its statement_timeout and its bounded count, on the transaction, after ingest_log)
 * that master #10193 added to src/core/deletion-inventory.ts. The withdrawal-discovery key read also matches
 * gbrain_fact_fingerprint_v2 (migration v353, segment-pending-stamp), which changes the digest.
 */
const SEQUENCE_SHA256 = "cfd632242d68cb5af88173307fdf3d06ff5ff6f8c50e141f3ca62682012d95cc";

test('the plan, dry run and request finders send the same 101 statements as before (99 plus the learning_items probe), in order, on the same lanes', async () => {
  const { engine, fake } = recordingEngine(stmt => {
    const t = stmt.text;
    if (t.startsWith('SELECT DISTINCT k.id,k.page_id FROM takes')) return [{ id: 1, page_id: 9 }];
    if (t.includes('FROM sources')) return [{ id: 'src-a', local_path: '/var/tmp/gbrain-purge-plan-sql-pin-absent', config: {} }];
    if (t.startsWith('SELECT s.id::text AS id FROM page_body_stagings')) return [{ id: '00000000-0000-0000-0000-0000000000aa' }];
    return undefined;
  });
  const target = { id: 7, source_id: 'src-a', visibility: 'world' as const, fact: CLAIM, entity_slug: 'acmename', source_markdown_slug: 'notes/a',
    fact_hash: 'abcdef0123456789', embedding: '[1,0]', embedding_model: 'm' };
  const plan = await planFactPurge(engine, target as never, false);
  await verifyFactPurge(engine, { target: target as never, plan: { ...plan, pages: [{ slug: 'notes/a', page_id: 9, revision: 'r' }] } as never, dryRun: true });
  await findRequestsCarrying(engine, 'src-a', CLAIM, 'acme reason');
  await findRequestsHoldingStagings(engine, 'src-a', ['00000000-0000-0000-0000-0000000000aa']);
  await derivedRowsFrom(engine, [{ table: 'facts', id: '7' }]);
  const sent = fake.statements().map(s => ({ text: s.text, params: s.params, lane: s.lane }));
  expect(sent.length).toBe(101);
  expect(createHash('sha256').update(JSON.stringify(sent)).digest('hex')).toBe(SEQUENCE_SHA256);
});
