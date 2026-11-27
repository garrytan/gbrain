/**
 * engine-sql/belief-purge-ledger.ts: the statements PGLite and Postgres run for the belief-ledger half of a purge are the
 * text belief/purge.ts and belief/preimages.ts ran through `executeRaw` before they became typed members, byte for byte
 * and with the same parameters (derivedStreamSlugs, missingPreimages, redactPurgedKeys with and without the legacy
 * fingerprint CTE, redactCarryingFields' read, value read, rewrite and re-chain, quotingSlugs' three reads,
 * pageLifetimesOf, pagePurgeClaims' three reads, registerVersionCarriers' version read and appendDerivedHidden's
 * known-keys read).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends exactly the old statement text and parameter list; the old texts below were recorded
 *    from the call sites on rust-engine/purge-receipt-e2e abd75465fb.
 *  - Regression: a reworded statement changes what the SQL engines redact or read, which the parity cases compare only
 *    by outcome.
 *  - Seam: a recording executor in place of the engine's `executeRaw`.
 */
import { describe, expect, test } from 'bun:test';
import * as L from '../src/core/engine-sql/belief-purge-ledger.ts';

const OLD_DERIVED = "SELECT 'facts:' || id AS ref, COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts\n      WHERE source_id = $1 AND id = ANY($2::bigint[]) AND COALESCE(source_markdown_slug, entity_slug) IS NOT NULL\n    UNION ALL SELECT 'takes:' || k.id, p.slug FROM takes k JOIN pages p ON p.id = k.page_id WHERE p.source_id = $1 AND k.id = ANY($3::bigint[])\n    UNION ALL SELECT 'pages:' || id, slug FROM pages WHERE source_id = $1 AND id = ANY($4::int[])";
const OLD_MISSING = "SELECT n.i FROM unnest($1::bigint[], $2::uuid[]) WITH ORDINALITY AS n(page_id, revision, i)\n    WHERE NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.page_id = n.page_id AND v.knowledge_revision = n.revision)";
const OLD_REDACT = "UPDATE belief_events SET value = NULL, value_hash = NULL, prior_hash = NULL, purged = true\n    WHERE source_id = $1 AND ((subject_kind IN ('fact','take') AND (claim_fp = ANY($2::text[])))\n        OR page_lifetime = ANY($3::uuid[]))\n      AND (purged = false OR value IS NOT NULL OR prior_hash IS NOT NULL) RETURNING id";
const OLD_REDACT_LEGACY = "WITH legacy AS (SELECT DISTINCT e.subject_key FROM unnest($4::text[]) AS c\n  CROSS JOIN LATERAL (SELECT gbrain_fact_fingerprint(c) AS fp, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.translate(pg_catalog.lower(c), '!\"$%&''()*,-/:;<=>?@[\\]^_`{|}~\u2018\u2019\u201a\u201c\u201d\u201e\u00ab\u00bb\u2039\u203a\u2013\u2014\u2015\u2026\u00b7\u2022\u00a1\u00bf', '                                               '), '[[:space:]]+', ' ', 'g'), '\\.(?=[. ]|$)', ' ', 'g'), ' +', ' ', 'g'), ' '), 'UTF8')), 'hex') AS v2) x\n  JOIN belief_events e ON e.source_id = $1 AND e.claim_fp = x.v2\n  WHERE x.v2 <> x.fp AND e.subject_kind IN ('fact','take') AND e.value IS NOT NULL\n    AND gbrain_fact_fingerprint(COALESCE(e.value->>'fact', e.value->>'claim')) = x.fp)\nUPDATE belief_events SET value = NULL, value_hash = NULL, prior_hash = NULL, purged = true\n    WHERE source_id = $1 AND ((subject_kind IN ('fact','take') AND (claim_fp = ANY($2::text[]) OR subject_key IN (SELECT subject_key FROM legacy)))\n        OR page_lifetime = ANY($3::uuid[]))\n      AND (purged = false OR value IS NOT NULL OR prior_hash IS NOT NULL) RETURNING id";
const OLD_CARRIERS = "SELECT e.id,\n        e.subject_kind, e.subject_key, e.value->>'context' AS context, e.value->>'resolved_source' AS resolved_source FROM belief_events e\n      WHERE e.source_id = $1 AND e.id > $2 AND e.subject_kind IN ('fact','take','link')\n        AND (COALESCE(e.value->>'context', '') <> '' OR COALESCE(e.value->>'resolved_source', '') <> '')\n      ORDER BY e.id LIMIT 1000";
const OLD_EVENT_VALUE = "SELECT value, value_hash, redacted_fields FROM belief_events WHERE id = $1";
const OLD_REWRITE = "UPDATE belief_events e SET value = $2::text::jsonb, value_hash = $3, redacted_fields = $4::text[],\n          prior_hash = CASE WHEN EXISTS (SELECT 1 FROM belief_events o WHERE o.source_id = e.source_id AND o.subject_key = e.subject_key AND o.id < e.id\n            AND o.value_hash = e.prior_hash) THEN e.prior_hash END WHERE e.id = $1";
const OLD_RECHAIN = "UPDATE belief_events SET prior_hash = $4 WHERE source_id = $1 AND subject_key = $2 AND id > $5 AND prior_hash = $3";
const OLD_LIFETIMES = "SELECT page_lifetime::text AS page_lifetime FROM belief_page_lifetimes\n    WHERE source_id = $1 AND (page_id = $3 OR (slug = $2 AND ended_at IS NULL AND page_id IS NULL))";
const OLD_LIVE_CLAIMS = "SELECT fact AS claim, gbrain_fact_fingerprint(fact) AS fp FROM facts WHERE source_id = $1 AND source_markdown_slug = $2\n    UNION SELECT claim, gbrain_fact_fingerprint(claim) FROM takes WHERE page_id = $3";
const OLD_VERSION_BODIES = "SELECT id, compiled_truth, timeline FROM page_versions\n      WHERE page_id = $1 AND id > $2 ORDER BY id LIMIT 1000";
const OLD_LIFETIME_EVENTS = "SELECT id, COALESCE(value->>'fact', value->>'claim') AS claim, claim_fp\n      FROM belief_events WHERE page_lifetime = ANY($1::uuid[]) AND subject_kind IN ('fact','take') AND id > $2 ORDER BY id LIMIT 1000";
const OLD_QUOTE_FACTS = "SELECT f.id, COALESCE(f.source_markdown_slug, f.entity_slug) AS slug, f.context AS text FROM facts f\n    WHERE f.source_id = $1 AND f.id > $2 AND f.expired_at IS NULL AND COALESCE(f.context, '') <> '' ORDER BY 1 LIMIT 1000";
const OLD_QUOTE_TAKES = "SELECT k.id, p.slug, k.resolved_source AS text FROM takes k JOIN pages p ON p.id = k.page_id\n    WHERE p.source_id = $1 AND k.id > $2 AND COALESCE(k.resolved_source, '') <> '' ORDER BY 1 LIMIT 1000";
const OLD_QUOTE_LINKS = "SELECT l.id, COALESCE(o.slug, f.slug) AS slug, l.context AS text FROM links l JOIN pages f ON f.id = l.from_page_id\n    LEFT JOIN pages o ON o.id = l.origin_page_id WHERE COALESCE(o.source_id, f.source_id) = $1 AND l.id > $2 AND l.context <> '' ORDER BY 1 LIMIT 1000";
const OLD_CARRIER_VERSIONS = "SELECT p.id AS page_id, p.slug,\n        (((((p.page_readers IS NULL AND NOT (p.frontmatter ? 'readable_by'))) AND (p.folder_rule_ids IS NULL) AND NOT EXISTS (SELECT 1 FROM access_pending_coverage pc WHERE pc.source_id = p.source_id AND (starts_with(p.slug, pc.prefix) AND (pc.prefix = '' OR right(pc.prefix, 1) = '/' OR p.slug = pc.prefix))) AND NOT (SELECT gbrain_access_state_unreadable()) AND ((p.type NOT IN ('atom', 'question', 'concept', 'event') AND NOT (p.frontmatter ? 'derived_from'))\n    OR NOT gbrain_access_origin_restricted(p.id, p.source_id, p.type, p.frontmatter)) AND NOT (EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id >= '' AND (read_source.config->>'kind' IN ('imessage') OR read_source.config->>'owner_only' = 'true')) OR EXISTS (SELECT 1 FROM pg_catalog.pg_description held\n  WHERE held.objoid = pg_catalog.to_regclass('public.owner_only_marks') AND held.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass\n    AND held.objsubid = 0 AND held.description = 'gbrain:owner_only_held (GST-3032): this brain has held owner-only data, so owner-only lineage stays guarded'))) AND ((COALESCE(p.frontmatter->>'visibility', CASE WHEN (p.type IN ('atom', 'question') OR (p.type = 'concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL)) THEN 'private' ELSE 'world' END) <> 'private'\n    AND NOT COALESCE(p.frontmatter ? 'pinned_question', false)\n    AND NOT (p.frontmatter->>'visibility' IS NULL AND (COALESCE(translate(btrim(p.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('private','restricted','confidential'), false) OR COALESCE(translate(btrim(p.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('confidential','secret','private','restricted'), false))))\n    AND NOT (CASE WHEN p.type = 'atom' THEN (EXISTS (SELECT 1 FROM pages derived_origin WHERE derived_origin.source_id = p.source_id\n      AND derived_origin.slug = ANY(ARRAY[(p.frontmatter->>'source_slug'), (SELECT renamed.canonical_slug FROM slug_aliases renamed\n    WHERE renamed.source_id=p.source_id AND renamed.alias_slug=(p.frontmatter->>'source_slug') AND renamed.notes='rename')]) AND derived_origin.frontmatter->>'visibility' = 'private') OR EXISTS (SELECT 1 FROM slug_rename_history moved JOIN pages moved_to ON moved_to.source_id=moved.source_id\n    AND moved_to.slug=moved.new_slug WHERE moved.source_id=p.source_id AND moved.old_slug=(p.frontmatter->>'source_slug')\n    AND moved_to.frontmatter->>'visibility'='private'))\n    WHEN (p.type IN ('atom', 'question') OR (p.type = 'concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL)) THEN EXISTS (SELECT 1 FROM links derived_input_link\n      JOIN pages derived_input ON derived_input.id = derived_input_link.to_page_id\n      WHERE derived_input_link.from_page_id = p.id AND derived_input_link.link_source = 'concept-provenance'\n        AND derived_input_link.link_type = 'synthesized_from'\n        AND (COALESCE(derived_input.frontmatter->>'visibility', CASE WHEN derived_input.type = 'atom' THEN 'private' ELSE 'world' END) = 'private'\n          OR EXISTS (SELECT 1 FROM pages derived_input_origin WHERE derived_input_origin.source_id = derived_input.source_id\n      AND derived_input_origin.slug = ANY(ARRAY[(derived_input.frontmatter->>'source_slug'), (SELECT renamed.canonical_slug FROM slug_aliases renamed\n    WHERE renamed.source_id=derived_input.source_id AND renamed.alias_slug=(derived_input.frontmatter->>'source_slug') AND renamed.notes='rename')]) AND derived_input_origin.frontmatter->>'visibility' = 'private') OR EXISTS (SELECT 1 FROM slug_rename_history moved JOIN pages moved_to ON moved_to.source_id=moved.source_id\n    AND moved_to.slug=moved.new_slug WHERE moved.source_id=derived_input.source_id AND moved.old_slug=(derived_input.frontmatter->>'source_slug')\n    AND moved_to.frontmatter->>'visibility'='private')))\n    WHEN p.type = 'event' AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%' THEN NOT EXISTS (SELECT 1 FROM pages chronicle_origin WHERE chronicle_origin.source_id = p.source_id\n      AND chronicle_origin.slug = p.frontmatter->'event'->>'depth'\n      AND (COALESCE(chronicle_origin.frontmatter->>'visibility', CASE WHEN (chronicle_origin.type IN ('atom', 'question') OR (chronicle_origin.type = 'concept' AND chronicle_origin.frontmatter->>'synthesized_by' IS NOT NULL)) THEN 'private' ELSE 'world' END) <> 'private'\n    AND NOT COALESCE(chronicle_origin.frontmatter ? 'pinned_question', false)\n    AND NOT (chronicle_origin.frontmatter->>'visibility' IS NULL AND (COALESCE(translate(btrim(chronicle_origin.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('private','restricted','confidential'), false) OR COALESCE(translate(btrim(chronicle_origin.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('confidential','secret','private','restricted'), false))))\n      AND NOT (CASE WHEN jsonb_typeof(chronicle_origin.frontmatter->'derived_from') IN ('array', 'string') THEN EXISTS (\n    SELECT 1 FROM pages declared_origin\n    WHERE declared_origin.source_id = chronicle_origin.source_id\n      AND declared_origin.frontmatter->>'visibility' = 'private'\n      AND declared_origin.slug = ANY(ARRAY(\n        SELECT regexp_replace(declared.slug, '\\.md$', '') FROM jsonb_array_elements_text(\n          CASE WHEN jsonb_typeof(chronicle_origin.frontmatter->'derived_from') = 'array' THEN chronicle_origin.frontmatter->'derived_from'\n            ELSE jsonb_build_array(chronicle_origin.frontmatter->'derived_from') END) AS declared(slug)))) ELSE false END))\n    ELSE false END)\n    AND NOT (CASE WHEN jsonb_typeof(p.frontmatter->'derived_from') IN ('array', 'string') THEN EXISTS (\n    SELECT 1 FROM pages declared_origin\n    WHERE declared_origin.source_id = p.source_id\n      AND declared_origin.frontmatter->>'visibility' = 'private'\n      AND declared_origin.slug = ANY(ARRAY(\n        SELECT regexp_replace(declared.slug, '\\.md$', '') FROM jsonb_array_elements_text(\n          CASE WHEN jsonb_typeof(p.frontmatter->'derived_from') = 'array' THEN p.frontmatter->'derived_from'\n            ELSE jsonb_build_array(p.frontmatter->'derived_from') END) AS declared(slug)))) ELSE false END)))) AS visible, v.compiled_truth, v.timeline\n      FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.source_id = $1 AND v.id = ANY($2::bigint[]) ORDER BY v.id";
const OLD_KNOWN_KEYS = "SELECT DISTINCT subject_key FROM belief_events WHERE source_id = $1 AND subject_key = ANY($2::text[])";

function recorder(rows: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const exec = { executeRaw: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return rows; } };
  return { calls, exec: exec as never };
}

const NEW_VALUE = "{\"context\":\"[redacted: purge 00000000-0000-4000-8000-000000000001]\"}";
const NEW_HASH = "49e300bfbd7ea601afc5757b366c373c1f52fc97dc62765804818b98f151d02c";

describe('belief-ledger purge statements: the SQL engines run the old text', () => {
  test('the derived rows\' stream slugs and the preimage check', async () => {
    const r = recorder([{ i: '2' }]);
    await L.listDerivedStreamSlugs(r.exec, 'default', [1], [2], [3]);
    expect(await L.listMissingPreimages(r.exec, [4], ['r1'])).toEqual([2]);
    expect(r.calls).toEqual([{ sql: OLD_DERIVED, params: ['default', [1], [2], [3]] }, { sql: OLD_MISSING, params: [[4], ['r1']] }]);
  });

  test('the purged-key redaction, with the legacy fingerprint CTE only when a claim may have one', async () => {
    const r = recorder([{ id: 1 }, { id: 2 }]);
    expect(await L.redactPurgedBeliefKeys(r.exec, { sourceId: 'default', claimFps: ['fp'], lifetimes: ['l1'], legacyClaims: [] })).toBe(2);
    await L.redactPurgedBeliefKeys(r.exec, { sourceId: 'default', claimFps: ['fp'], lifetimes: [], legacyClaims: ['a\u0085b claim here'] });
    expect(r.calls).toEqual([{ sql: OLD_REDACT, params: ['default', ['fp'], ['l1']] },
      { sql: OLD_REDACT_LEGACY, params: ['default', ['fp'], [], ['a\u0085b claim here']] }]);
  });

  test('the carrying-field redaction\'s read, value read, rewrite and re-chain', async () => {
    const r = recorder();
    await L.listBeliefCarrierEvents(r.exec, 'default', 0);
    expect(await L.readBeliefEventValue(r.exec, 'default', 5)).toBeNull();
    await L.rewriteBeliefEventFields(r.exec, { sourceId: 'default', id: 5, value: NEW_VALUE, valueHash: NEW_HASH, redactedFields: ['context'] });
    await L.rechainBeliefPriorHash(r.exec, { sourceId: 'default', subjectKey: 'f1', oldHash: 'h0', newHash: NEW_HASH, afterId: 5 });
    expect(r.calls).toEqual([{ sql: OLD_CARRIERS, params: ['default', 0] }, { sql: OLD_EVENT_VALUE, params: [5] },
      { sql: OLD_REWRITE, params: [5, NEW_VALUE, NEW_HASH, ['context']] }, { sql: OLD_RECHAIN, params: ['default', 'f1', 'h0', NEW_HASH, 5] }]);
  });

  test('the live carriers\' three reads', async () => {
    const r = recorder();
    for (const kind of ['facts', 'takes', 'links'] as const) await L.listBeliefQuotingRows(r.exec, kind, 'default', 0);
    expect(r.calls).toEqual([OLD_QUOTE_FACTS, OLD_QUOTE_TAKES, OLD_QUOTE_LINKS].map(sql => ({ sql, params: ['default', 0] })));
  });

  test('the page purge\'s lifetimes and claim inventory', async () => {
    const r = recorder([{ page_lifetime: 'l1' }]);
    expect(await L.listPageBeliefLifetimes(r.exec, 'default', 'people/a', 4)).toEqual(['l1']);
    await L.listPagePurgeLiveClaims(r.exec, 'default', 'people/a', 4);
    await L.listPageVersionFenceBodies(r.exec, 4, 0);
    await L.listLifetimeClaimEvents(r.exec, 'default', ['l1'], 0);
    expect(r.calls).toEqual([{ sql: OLD_LIFETIMES, params: ['default', 'people/a', 4] }, { sql: OLD_LIVE_CLAIMS, params: ['default', 'people/a', 4] },
      { sql: OLD_VERSION_BODIES, params: [4, 0] }, { sql: OLD_LIFETIME_EVENTS, params: [['l1'], 0] }]);
  });

  test('the version carriers\' read and the derived-hidden known keys', async () => {
    const r = recorder([{ subject_key: 'f1' }]);
    await L.listPurgeCarrierVersions(r.exec, 'default', [7, 9]);
    expect(await L.listKnownBeliefSubjectKeys(r.exec, 'default', ['f1'])).toEqual(['f1']);
    expect(r.calls).toEqual([{ sql: OLD_CARRIER_VERSIONS, params: ['default', [7, 9]] }, { sql: OLD_KNOWN_KEYS, params: ['default', ['f1']] }]);
  });
});
