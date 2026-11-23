/**
 * Rendered-SQL pins for the engine-sql members rewritten into the house form (`sqlFragment` + `renderFragment`):
 * repair-plan-scans.ts, repair-bookkeeping.ts, managed-sync-orphans.ts, loop-mutes.ts and persistence-effect-scans.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends the engine exactly the statement text and bound values pinned below. Whitespace is
 *    compared collapsed. The text differs from the hand-numbered statements it replaced only where noted: parameters
 *    are numbered in the order they appear (a repeated value is bound once per use with the same cast), a LIMIT that
 *    was spliced as a number is now a bound value, `IN (<literals>)` is `= ANY(<array>::text[])`, and a statement
 *    with no values passes `[]` instead of no params. Rows and result shapes are unchanged and are covered by the
 *    engine-parity cases.
 *  - Regression: a member that shifts a placeholder number against its value, drops the cast Postgres needs to infer
 *    a type, or splices a value instead of binding it still passes the PGLite parity cases on a small fixture, then
 *    fails or misbinds on Postgres.
 *  - Why existing coverage misses it: test/engine-parity/*.test.ts compares results, never statement text, and the
 *    sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts).
 *  - Seam: a recording `executeRaw` that answers from a queue of rows; no database runs.
 *  - The drift-conflict private-page predicate is long and owned by `private-page-sql`, so the private case pins the
 *    statement head, tail and every bound value rather than copying the predicate.
 */
import { describe, expect, test } from 'bun:test';
import { unscopedExecutor } from '../src/core/engine-sql/brands.ts';
import type { SqlExecutor } from '../src/core/engine-sql/executor.ts';
import { listFailedWriteRequests, listDriftConflictGroups, listUntiledSegmentedPages } from '../src/core/engine-sql/repair-plan-scans.ts';
import {
  deleteOrphanConnectorCheckpoint, listConnectorSources, listOrphanBindings, listOrphanConnectorCheckpoints,
} from '../src/core/engine-sql/repair-bookkeeping.ts';
import {
  listManagedSyncOrphanRows, retireManagedSyncCursor, retireManagedSyncPassSlugMode,
} from '../src/core/engine-sql/managed-sync-orphans.ts';
import { requeueMutedLoops } from '../src/core/engine-sql/loop-mutes.ts';
import { embeddingCandidateWhere, listEmbeddingCandidates } from '../src/core/engine-sql/persistence-effect-scans.ts';

interface Call { text: string; params: unknown[] | undefined }

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const REQ = '00000000-0000-0000-0000-0000000000a1';

/** An executor that records every statement and answers each from a queue of row sets (no rows once it is empty). */
function recorder(queue: unknown[][] = []) {
  const calls: Call[] = [];
  const executeRaw = async (text: string, params?: unknown[]) => { calls.push({ text: norm(text), params }); return queue.shift() ?? []; };
  const exec = unscopedExecutor({ dialect: 'pglite', executeRaw } as unknown as SqlExecutor, 'rendered-sql pin');
  return { calls, exec };
}

describe('repair-plan-scans.ts rendered SQL', () => {
  const UNTILED = "SELECT p.id, p.source_id, p.slug, p.knowledge_revision::text AS revision, p.body_generation, p.body_bytes, p.segment_count, p.source_path, t.n, t.covered, t.gapless FROM pages p JOIN sources s ON s.id = p.source_id AND s.archived IS NOT TRUE CROSS JOIN LATERAL (SELECT count(*)::bigint AS n, COALESCE(sum(r.byte_len), 0)::bigint AS covered, COALESCE(bool_and(r.byte_start = r.prior), true) AS gapless FROM (SELECT m.byte_start, m.byte_len, COALESCE(sum(m.byte_len) OVER (ORDER BY m.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior FROM page_body_manifest m WHERE m.page_id = p.id AND m.staging_id IS NULL AND m.gen_from <= p.body_generation AND (m.gen_to IS NULL OR m.gen_to > p.body_generation)) r) t WHERE p.body_storage = 'segmented' AND p.deleted_at IS NULL AND ($1::text[] IS NULL OR p.source_id = ANY($2::text[])) AND ($3::text[] IS NULL OR p.slug = ANY($4::text[])) AND (NOT t.gapless OR t.covered <> p.body_bytes) ORDER BY p.source_id COLLATE \"C\", p.slug COLLATE \"C\" LIMIT $5";

  test('listUntiledSegmentedPages with no filter binds each filter slot as null and the default limit', async () => {
    const { calls, exec } = recorder();
    await listUntiledSegmentedPages(exec);
    expect(calls).toEqual([{ text: UNTILED, params: [null,null,null,null,1000] }]);
  });

  test('listUntiledSegmentedPages binds the source and slug arrays once per use and the limit last', async () => {
    const { calls, exec } = recorder();
    await listUntiledSegmentedPages(exec, { sourceIds: ['a', 'b'], slugs: ['x/y'], limit: 5 });
    expect(calls).toEqual([{ text: UNTILED, params: [["a","b"],["a","b"],["x/y"],["x/y"],5] }]);
  });

  const PLAIN = { replayable: ['put_page', 'capture'] };
  const FACTS = { ...PLAIN, factsMovedMessages: ['moved one', 'moved two'] };

  test('listFailedWriteRequests numbers the replayable operations, then the sources', async () => {
    const { calls, exec } = recorder();
    await listFailedWriteRequests(exec, ['a', 'b'], PLAIN);
    expect(calls).toEqual([{ text: "SELECT r.id::text, r.request_id::text, r.sequence::text, r.operation, r.source_id, r.slug, r.digest, r.state, r.intent, r.authority, to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at, r.error_detail->>'origin' AS origin, r.error_code, r.page_id::text AS page_id, CASE WHEN r.operation = ANY($1::text[]) AND NOT (r.operation='put_page' AND r.intent ? 'kind') THEN NULL ELSE r.operation || COALESCE(':' || (r.intent->>'kind'), '') END AS producer FROM persistence_requests r WHERE r.source_id = ANY($2::text[]) AND NOT r.compacted AND r.intent IS NOT NULL AND ((r.state='failed' AND (r.error_code='writer_coordinator_required' OR (r.error_code='storage_error' AND r.error_message LIKE 'Publication failed (P0001)%'))) OR (r.state='conflict' AND r.error_code='source_changed')) ORDER BY r.sequence", params: [["put_page","capture"],["a","b"]] }]);
  });

  test('listFailedWriteRequests binds the facts-moved messages between the sources and the id', async () => {
    const { calls, exec } = recorder();
    await listFailedWriteRequests(exec, ['a', 'b'], FACTS);
    expect(calls).toEqual([{ text: "SELECT r.id::text, r.request_id::text, r.sequence::text, r.operation, r.source_id, r.slug, r.digest, r.state, r.intent, r.authority, to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at, r.error_detail->>'origin' AS origin, r.error_code, r.page_id::text AS page_id, CASE WHEN r.operation = ANY($1::text[]) AND NOT (r.operation='put_page' AND r.intent ? 'kind') THEN NULL ELSE r.operation || COALESCE(':' || (r.intent->>'kind'), '') END AS producer FROM persistence_requests r WHERE r.source_id = ANY($2::text[]) AND NOT r.compacted AND r.intent IS NOT NULL AND ((r.state='failed' AND (r.error_code='writer_coordinator_required' OR (r.error_code='storage_error' AND r.error_message LIKE 'Publication failed (P0001)%'))) OR (r.state='conflict' AND r.error_code='source_changed') OR (r.operation='extract_facts' AND r.state='conflict' AND r.error_code='revision_conflict' AND r.error_message = ANY($3::text[]))) ORDER BY r.sequence", params: [["put_page","capture"],["a","b"],["moved one","moved two"]] }]);
  });

  test('listFailedWriteRequests by id binds the id after the sources', async () => {
    const { calls, exec } = recorder();
    await listFailedWriteRequests(exec, ['a', 'b'], { ...PLAIN, id: REQ });
    expect(calls).toEqual([{ text: "SELECT r.id::text, r.request_id::text, r.sequence::text, r.operation, r.source_id, r.slug, r.digest, r.state, r.intent, r.authority, to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at, r.error_detail->>'origin' AS origin, r.error_code, r.page_id::text AS page_id, CASE WHEN r.operation = ANY($1::text[]) AND NOT (r.operation='put_page' AND r.intent ? 'kind') THEN NULL ELSE r.operation || COALESCE(':' || (r.intent->>'kind'), '') END AS producer FROM persistence_requests r WHERE r.source_id = ANY($2::text[]) AND NOT r.compacted AND r.intent IS NOT NULL AND ((r.state='failed' AND (r.error_code='writer_coordinator_required' OR (r.error_code='storage_error' AND r.error_message LIKE 'Publication failed (P0001)%'))) OR (r.state='conflict' AND r.error_code='source_changed')) AND r.id=$3::uuid ORDER BY r.sequence", params: [["put_page","capture"],["a","b"],"00000000-0000-0000-0000-0000000000a1"] }]);
  });

  test('listFailedWriteRequests by id with facts-moved messages binds the messages before the id', async () => {
    const { calls, exec } = recorder();
    await listFailedWriteRequests(exec, ['a', 'b'], { ...FACTS, id: REQ });
    expect(calls).toEqual([{ text: "SELECT r.id::text, r.request_id::text, r.sequence::text, r.operation, r.source_id, r.slug, r.digest, r.state, r.intent, r.authority, to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at, r.error_detail->>'origin' AS origin, r.error_code, r.page_id::text AS page_id, CASE WHEN r.operation = ANY($1::text[]) AND NOT (r.operation='put_page' AND r.intent ? 'kind') THEN NULL ELSE r.operation || COALESCE(':' || (r.intent->>'kind'), '') END AS producer FROM persistence_requests r WHERE r.source_id = ANY($2::text[]) AND NOT r.compacted AND r.intent IS NOT NULL AND ((r.state='failed' AND (r.error_code='writer_coordinator_required' OR (r.error_code='storage_error' AND r.error_message LIKE 'Publication failed (P0001)%'))) OR (r.state='conflict' AND r.error_code='source_changed') OR (r.operation='extract_facts' AND r.state='conflict' AND r.error_code='revision_conflict' AND r.error_message = ANY($3::text[]))) AND r.id=$4::uuid ORDER BY r.sequence", params: [["put_page","capture"],["a","b"],["moved one","moved two"],"00000000-0000-0000-0000-0000000000a1"] }]);
  });

  test('listFailedWriteRequests reads the recovered-fact requests with the ids the first read returned', async () => {
    const { calls, exec } = recorder([[{ id: 'r1', operation: 'extract_facts' }, { id: 'r2', operation: 'put_page' }]]);
    await listFailedWriteRequests(exec, ['a'], FACTS);
    expect(calls).toEqual([
      { text: "SELECT r.id::text, r.request_id::text, r.sequence::text, r.operation, r.source_id, r.slug, r.digest, r.state, r.intent, r.authority, to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at, r.error_detail->>'origin' AS origin, r.error_code, r.page_id::text AS page_id, CASE WHEN r.operation = ANY($1::text[]) AND NOT (r.operation='put_page' AND r.intent ? 'kind') THEN NULL ELSE r.operation || COALESCE(':' || (r.intent->>'kind'), '') END AS producer FROM persistence_requests r WHERE r.source_id = ANY($2::text[]) AND NOT r.compacted AND r.intent IS NOT NULL AND ((r.state='failed' AND (r.error_code='writer_coordinator_required' OR (r.error_code='storage_error' AND r.error_message LIKE 'Publication failed (P0001)%'))) OR (r.state='conflict' AND r.error_code='source_changed') OR (r.operation='extract_facts' AND r.state='conflict' AND r.error_code='revision_conflict' AND r.error_message = ANY($3::text[]))) ORDER BY r.sequence", params: [["put_page","capture"],["a"],["moved one","moved two"]] },
      { text: "SELECT r.id::text FROM persistence_requests r WHERE r.id = ANY($1::uuid[]) AND EXISTS (SELECT 1 FROM persistence_requests c WHERE r.operation='extract_facts' AND c.operation='extract_facts' AND c.source_id=r.source_id AND c.slug=r.slug AND c.state='committed' AND c.sequence>r.sequence AND COALESCE(c.intent->>'inputDigest', c.outcome->>'input_digest')=r.intent->>'inputDigest' AND COALESCE(c.intent->>'batchKey', c.outcome->>'batch_key') IS DISTINCT FROM r.intent->>'batchKey')", params: [["r1"]] },
    ]);
  });

  const DRIFT = { incarnation: REQ, floor: '5', through: '99', requireLivePage: false, excludePrivate: false, after: '', limit: 50, driftMessage: 'drift msg' };

  test('listDriftConflictGroups without prefixes numbers the totals and rows reads separately', async () => {
    const { calls, exec } = recorder();
    await listDriftConflictGroups(exec, 's1', DRIFT);
    expect(calls).toEqual([
      { text: "SELECT count(DISTINCT r.slug)::int AS slugs, count(*)::int AS receipts FROM persistence_requests r WHERE r.source_id=$1 AND r.source_incarnation=$2::uuid AND r.sequence > $3::bigint AND r.sequence <= $4::bigint AND r.state='conflict' AND r.error_code='source_changed'", params: ["s1","00000000-0000-0000-0000-0000000000a1","5","99"] },
      { text: "SELECT r.slug COLLATE \"C\" AS slug, count(*)::int AS receipts, count(*) FILTER (WHERE r.error_message=$1)::int AS drift_receipts, to_char(min(r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS first_seen, to_char(max(r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_seen, array_agg(DISTINCT (r.operation || COALESCE(':' || (r.intent->>'kind'), '')) COLLATE \"C\" ORDER BY (r.operation || COALESCE(':' || (r.intent->>'kind'), '')) COLLATE \"C\") AS producers, (array_agg(r.request_id::text ORDER BY r.sequence DESC))[1] AS last_request_id FROM persistence_requests r WHERE r.source_id=$2 AND r.source_incarnation=$3::uuid AND r.sequence > $4::bigint AND r.sequence <= $5::bigint AND r.state='conflict' AND r.error_code='source_changed' AND r.slug COLLATE \"C\" > $6 GROUP BY r.slug COLLATE \"C\" ORDER BY r.slug COLLATE \"C\" LIMIT $7", params: ["drift msg","s1","00000000-0000-0000-0000-0000000000a1","5","99","",50] },
    ]);
  });

  test('listDriftConflictGroups binds a slash-free prefix twice and a directory prefix as a LIKE pattern', async () => {
    const { calls, exec } = recorder();
    await listDriftConflictGroups(exec, 's1', { ...DRIFT, slugPrefixes: ['notes/', 'people/ann'], requireLivePage: true });
    expect(calls).toEqual([
      { text: "SELECT count(DISTINCT r.slug)::int AS slugs, count(*)::int AS receipts FROM persistence_requests r WHERE r.source_id=$1 AND r.source_incarnation=$2::uuid AND r.sequence > $3::bigint AND r.sequence <= $4::bigint AND r.state='conflict' AND r.error_code='source_changed' AND (lower(r.slug) LIKE $5 OR (lower(r.slug) = $6 OR lower(r.slug) LIKE $7 || '/%')) AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id=r.source_id AND p.slug=r.slug AND p.deleted_at IS NULL)", params: ["s1","00000000-0000-0000-0000-0000000000a1","5","99","notes/%","people/ann","people/ann"] },
      { text: "SELECT r.slug COLLATE \"C\" AS slug, count(*)::int AS receipts, count(*) FILTER (WHERE r.error_message=$1)::int AS drift_receipts, to_char(min(r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS first_seen, to_char(max(r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_seen, array_agg(DISTINCT (r.operation || COALESCE(':' || (r.intent->>'kind'), '')) COLLATE \"C\" ORDER BY (r.operation || COALESCE(':' || (r.intent->>'kind'), '')) COLLATE \"C\") AS producers, (array_agg(r.request_id::text ORDER BY r.sequence DESC))[1] AS last_request_id FROM persistence_requests r WHERE r.source_id=$2 AND r.source_incarnation=$3::uuid AND r.sequence > $4::bigint AND r.sequence <= $5::bigint AND r.state='conflict' AND r.error_code='source_changed' AND (lower(r.slug) LIKE $6 OR (lower(r.slug) = $7 OR lower(r.slug) LIKE $8 || '/%')) AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id=r.source_id AND p.slug=r.slug AND p.deleted_at IS NULL) AND r.slug COLLATE \"C\" > $9 GROUP BY r.slug COLLATE \"C\" ORDER BY r.slug COLLATE \"C\" LIMIT $10", params: ["drift msg","s1","00000000-0000-0000-0000-0000000000a1","5","99","notes/%","people/ann","people/ann","",50] },
    ]);
  });

  test('listDriftConflictGroups excluding private pages escapes the prefix and binds it once', async () => {
    const { calls, exec } = recorder();
    await listDriftConflictGroups(exec, 's1', { ...DRIFT, slugPrefixes: ['a_b%/'], excludePrivate: true });
    expect(calls.map((c) => c.params)).toEqual([["s1","00000000-0000-0000-0000-0000000000a1","5","99","a\\_b\\%/%"], ["drift msg","s1","00000000-0000-0000-0000-0000000000a1","5","99","a\\_b\\%/%","",50]]);
    expect(calls[0].text.startsWith("SELECT count(DISTINCT r.slug)::int AS slugs, count(*)::int AS receipts FROM persistence_requests r WHERE r.source_id=$1 AND r.source_incarnation=$2::uuid AND r.sequence > $3::bigint AND r.sequence <= $4::bigint AND r.state='conflict' AND r.error_code='source_changed' AND (lower(r.slug) LIKE $5) AND EXISTS (SELECT 1 FROM pages p")).toBe(true);
    expect(calls[0].text.endsWith("atter->'derived_from' ELSE jsonb_build_array(p.frontmatter->'derived_from') END) AS declared(slug)))) ELSE false END))))")).toBe(true);
    expect(calls[1].text.endsWith("r->'derived_from') END) AS declared(slug)))) ELSE false END)))) AND r.slug COLLATE \"C\" > $7 GROUP BY r.slug COLLATE \"C\" ORDER BY r.slug COLLATE \"C\" LIMIT $8")).toBe(true);
    expect(calls[1].text).toContain('AND (lower(r.slug) LIKE $6) AND EXISTS (SELECT 1 FROM pages p');
    expect(calls[1].text).toContain('count(*) FILTER (WHERE r.error_message=$1)::int AS drift_receipts');
  });
});

describe('repair-bookkeeping.ts rendered SQL', () => {
  test('listOrphanBindings without a limit sends an empty parameter list', async () => {
    const { calls, exec } = recorder();
    await listOrphanBindings(exec);
    expect(calls).toEqual([{ text: "SELECT b.source_id, b.source_incarnation::text AS source_incarnation, b.worktree_id::text AS worktree_id, CASE WHEN s.id IS NULL THEN 'source_removed' ELSE 'incarnation_replaced' END AS reason, (SELECT COUNT(*)::int FROM persistence_requests r WHERE r.source_id = b.source_id AND r.source_incarnation = b.source_incarnation AND r.state IN ('queued','deferred','running','recovering')) AS pending_requests FROM persistence_source_bindings b LEFT JOIN sources s ON s.id = b.source_id WHERE s.id IS NULL OR s.incarnation <> b.source_incarnation ORDER BY b.source_id COLLATE \"C\"", params: [] }]);
  });

  test('listOrphanBindings binds the floored limit instead of splicing it', async () => {
    const { calls, exec } = recorder();
    await listOrphanBindings(exec, { limit: 7.9 });
    expect(calls).toEqual([{ text: "SELECT b.source_id, b.source_incarnation::text AS source_incarnation, b.worktree_id::text AS worktree_id, CASE WHEN s.id IS NULL THEN 'source_removed' ELSE 'incarnation_replaced' END AS reason, (SELECT COUNT(*)::int FROM persistence_requests r WHERE r.source_id = b.source_id AND r.source_incarnation = b.source_incarnation AND r.state IN ('queued','deferred','running','recovering')) AS pending_requests FROM persistence_source_bindings b LEFT JOIN sources s ON s.id = b.source_id WHERE s.id IS NULL OR s.incarnation <> b.source_incarnation ORDER BY b.source_id COLLATE \"C\" LIMIT $1", params: [7] }]);
  });

  const KINDS = ["google","github","meetings","slack","imessage","apple-contacts"];

  test('listConnectorSources matches the connector kinds with one bound array', async () => {
    const { calls, exec } = recorder();
    await listConnectorSources(exec);
    expect(calls).toEqual([{ text: "SELECT id,incarnation::text,local_path,config,archived FROM sources WHERE config->>'kind' = ANY($1::text[])", params: [KINDS] }]);
  });

  test('listConnectorSources with a lock takes the lock statement first and binds the kinds in both', async () => {
    const { calls, exec } = recorder();
    await listConnectorSources(exec, { lock: true });
    expect(calls).toEqual([
      { text: "SELECT id FROM sources WHERE config->>'kind' = ANY($1::text[]) ORDER BY id FOR SHARE", params: [KINDS] },
      { text: "SELECT id,incarnation::text,local_path,config,archived FROM sources WHERE config->>'kind' = ANY($1::text[])", params: [KINDS] },
    ]);
  });

  const BOUNDS = { before: '2026-01-01T00:00:00Z', minAgeDays: 3, stateOp: 'managed-connector-state' };

  test('listOrphanConnectorCheckpoints numbers the keys, bounds and limit in order of appearance', async () => {
    const { calls, exec } = recorder();
    await listOrphanConnectorCheckpoints(exec, ['k1', 'k2'], BOUNDS, 25);
    expect(calls).toEqual([{ text: "SELECT c.op, c.fingerprint, c.updated_at::text AS updated_at FROM op_checkpoints c WHERE c.op IN ('managed-connector','managed-connector-retry') AND ( ((c.op='managed-connector' AND NOT (c.fingerprint = ANY($1::text[]))) OR (c.op='managed-connector-retry' AND NOT (COALESCE(c.completed_keys->0->>'checkpointKey','') = ANY($2::text[])))) AND NOT EXISTS (SELECT 1 FROM persistence_requests r WHERE (r.state IN ('queued','deferred','running','recovering') OR r.recovery IS NOT NULL) AND (r.intent->>'kind' LIKE 'connector\\_v2\\_%' OR r.intent->>'kind' LIKE 'managed\\_connector\\_%') AND (r.intent->>'checkpointKey' = c.fingerprint OR r.intent->>'checkpointKey' = c.completed_keys->0->>'checkpointKey' OR r.request_id::text = c.completed_keys->0->>'requestId')) AND NOT EXISTS (SELECT 1 FROM op_checkpoints s CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.completed_keys->0->'pending','[]'::jsonb)) p JOIN persistence_requests r ON r.request_id::text = p->>'requestId' WHERE s.op=$3 AND (r.intent->>'checkpointKey' = c.fingerprint OR r.intent->>'checkpointKey' = c.completed_keys->0->>'checkpointKey' OR r.request_id::text = c.completed_keys->0->>'requestId')) AND ($4::text IS NULL OR c.updated_at <= $5::text::timestamptz) AND ($6::integer IS NULL OR c.updated_at < now() - make_interval(days => $7::integer))) ORDER BY c.op COLLATE \"C\", c.fingerprint COLLATE \"C\" LIMIT $8", params: [["k1","k2"],["k1","k2"],"managed-connector-state","2026-01-01T00:00:00Z","2026-01-01T00:00:00Z",3,3,25] }]);
  });

  test('listOrphanConnectorCheckpoints with no loadable keys and no age bounds binds nulls', async () => {
    const { calls, exec } = recorder();
    await listOrphanConnectorCheckpoints(exec, [], { stateOp: 'op' }, 10);
    expect(calls).toEqual([{ text: "SELECT c.op, c.fingerprint, c.updated_at::text AS updated_at FROM op_checkpoints c WHERE c.op IN ('managed-connector','managed-connector-retry') AND ( ((c.op='managed-connector' AND NOT (c.fingerprint = ANY($1::text[]))) OR (c.op='managed-connector-retry' AND NOT (COALESCE(c.completed_keys->0->>'checkpointKey','') = ANY($2::text[])))) AND NOT EXISTS (SELECT 1 FROM persistence_requests r WHERE (r.state IN ('queued','deferred','running','recovering') OR r.recovery IS NOT NULL) AND (r.intent->>'kind' LIKE 'connector\\_v2\\_%' OR r.intent->>'kind' LIKE 'managed\\_connector\\_%') AND (r.intent->>'checkpointKey' = c.fingerprint OR r.intent->>'checkpointKey' = c.completed_keys->0->>'checkpointKey' OR r.request_id::text = c.completed_keys->0->>'requestId')) AND NOT EXISTS (SELECT 1 FROM op_checkpoints s CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.completed_keys->0->'pending','[]'::jsonb)) p JOIN persistence_requests r ON r.request_id::text = p->>'requestId' WHERE s.op=$3 AND (r.intent->>'checkpointKey' = c.fingerprint OR r.intent->>'checkpointKey' = c.completed_keys->0->>'checkpointKey' OR r.request_id::text = c.completed_keys->0->>'requestId')) AND ($4::text IS NULL OR c.updated_at <= $5::text::timestamptz) AND ($6::integer IS NULL OR c.updated_at < now() - make_interval(days => $7::integer))) ORDER BY c.op COLLATE \"C\", c.fingerprint COLLATE \"C\" LIMIT $8", params: [[],[],"op",null,null,null,null,10] }]);
  });

  test('deleteOrphanConnectorCheckpoint repeats the orphan predicate after the row identity', async () => {
    const { calls, exec } = recorder();
    await deleteOrphanConnectorCheckpoint(exec, { op: 'managed-connector', fingerprint: 'fp', updated_at: '2026-01-01 00:00:00+00' }, ['k1'], BOUNDS);
    expect(calls).toEqual([{ text: "DELETE FROM op_checkpoints c WHERE c.op=$1 AND c.fingerprint=$2 AND c.updated_at=$3::text::timestamptz AND ( ((c.op='managed-connector' AND NOT (c.fingerprint = ANY($4::text[]))) OR (c.op='managed-connector-retry' AND NOT (COALESCE(c.completed_keys->0->>'checkpointKey','') = ANY($5::text[])))) AND NOT EXISTS (SELECT 1 FROM persistence_requests r WHERE (r.state IN ('queued','deferred','running','recovering') OR r.recovery IS NOT NULL) AND (r.intent->>'kind' LIKE 'connector\\_v2\\_%' OR r.intent->>'kind' LIKE 'managed\\_connector\\_%') AND (r.intent->>'checkpointKey' = c.fingerprint OR r.intent->>'checkpointKey' = c.completed_keys->0->>'checkpointKey' OR r.request_id::text = c.completed_keys->0->>'requestId')) AND NOT EXISTS (SELECT 1 FROM op_checkpoints s CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.completed_keys->0->'pending','[]'::jsonb)) p JOIN persistence_requests r ON r.request_id::text = p->>'requestId' WHERE s.op=$6 AND (r.intent->>'checkpointKey' = c.fingerprint OR r.intent->>'checkpointKey' = c.completed_keys->0->>'checkpointKey' OR r.request_id::text = c.completed_keys->0->>'requestId')) AND ($7::text IS NULL OR c.updated_at <= $8::text::timestamptz) AND ($9::integer IS NULL OR c.updated_at < now() - make_interval(days => $10::integer))) RETURNING c.op", params: ["managed-connector","fp","2026-01-01 00:00:00+00",["k1"],["k1"],"managed-connector-state","2026-01-01T00:00:00Z","2026-01-01T00:00:00Z",3,3] }]);
  });
});

describe('managed-sync-orphans.ts rendered SQL', () => {
  const MOVED = 'The source checkpoint changed during this sync.';
  const READS = [
    "SELECT c.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,c.completed_keys->0->>'runId' AS run_id, c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' AS principal_kind, c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AS principal_id, (c.completed_keys->0 ? 'syncOptions') AS has_sync_options, c.completed_keys->0->'pending'->>'requestId' AS pending_request_id,r.state AS pending_state, EXISTS(SELECT 1 FROM persistence_local_writers w WHERE w.revoked_at IS NULL AND w.id::text=c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AND c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' IN ('local_cli','local_stdio')) AS principal_live, EXISTS(SELECT 1 FROM op_checkpoints n WHERE n.op='managed-sync' AND n.fingerprint<>c.fingerprint AND n.completed_keys->0->>'sourceId'=s.id AND n.completed_keys->0->>'incarnation'=s.incarnation::text AND COALESCE(n.completed_keys->0->>'done','false')='true' AND n.updated_at>c.updated_at) AS superseded, (c.completed_keys->0->'pending'->'intent'->>'kind'='managed_sync_checkpoint' AND c.completed_keys->0->>'companyReceiptId' IS NULL AND (c.completed_keys->0->>'index')::int>=(c.completed_keys->0->>'total')::int AND s.last_commit IS DISTINCT FROM c.completed_keys->0->>'from' AND (c.completed_keys->0->'pending'->'intent'->'slice'->>'done'='false' OR s.last_commit IS DISTINCT FROM c.completed_keys->0->>'target') AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='revision_conflict' AND m.error_message=$1) AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'cursorKey'=c.fingerprint AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL))) AS checkpoint_moved, (c.completed_keys->0->'pending'->'intent'->>'kind'='managed_sync_checkpoint' AND c.completed_keys->0->>'companyReceiptId' IS NULL AND (c.completed_keys->0->>'index')::int>=(c.completed_keys->0->>'total')::int AND s.config->>'slug_root_mode' IS NOT NULL AND s.config->>'slug_root_mode' IS DISTINCT FROM c.completed_keys->0->>'slugMode' AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='slug_root_mode_mismatch') AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'cursorKey'=c.fingerprint AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL))) AS slug_mode_refused, to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at FROM op_checkpoints c JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text=c.completed_keys->0->>'incarnation' AND NOT COALESCE(s.archived,false) LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid AND r.principal_id=c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AND r.principal_kind=c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true' AND ($2::text[] IS NULL OR s.id=ANY($3::text[])) ORDER BY s.id COLLATE \"C\",c.updated_at,c.fingerprint COLLATE \"C\"",
    "SELECT f.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,f.completed_keys->0->>'run_id' AS run_id, f.completed_keys->0->>'request_id' AS request_id,to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at FROM op_checkpoints f JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text=f.completed_keys->0->>'source_incarnation' AND NOT COALESCE(s.archived,false) WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($2::text[])) AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op IN ('managed-sync','managed-sync-pass') AND c.fingerprint=f.fingerprint) ORDER BY s.id COLLATE \"C\",f.fingerprint COLLATE \"C\"",
    "SELECT p.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,p.completed_keys->0->'telemetry'->>'pass_id' AS run_id, (SELECT n.request_id FROM persistence_requests n WHERE n.source_id=s.id AND n.intent->>'kind'='managed_sync_checkpoint' AND n.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' ORDER BY n.sequence DESC LIMIT 1)::text AS request_id,(SELECT m.state FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(SELECT n.request_id FROM persistence_requests n WHERE n.source_id=s.id AND n.intent->>'kind'='managed_sync_checkpoint' AND n.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' ORDER BY n.sequence DESC LIMIT 1)) AS state, to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at FROM op_checkpoints p JOIN sources s ON p.fingerprint=s.id||':'||s.incarnation::text AND NOT COALESCE(s.archived,false) WHERE p.op='managed-sync-pass' AND ($1::text[] IS NULL OR s.id=ANY($2::text[])) AND (p.completed_keys->0->'obligations'->>'slug_mode' IS NOT NULL AND s.config->>'slug_root_mode' IS NOT NULL AND s.config->>'slug_root_mode' IS DISTINCT FROM p.completed_keys->0->'obligations'->>'slug_mode' AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(SELECT n.request_id FROM persistence_requests n WHERE n.source_id=s.id AND n.intent->>'kind'='managed_sync_checkpoint' AND n.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' ORDER BY n.sequence DESC LIMIT 1) AND m.intent->>'kind'='managed_sync_checkpoint' AND m.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='slug_root_mode_mismatch') AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL))) ORDER BY s.id COLLATE \"C\"",
    "SELECT c.fingerprint AS cursor_key,s.id AS source_id,c.completed_keys->0->>'incarnation' AS source_incarnation,c.completed_keys->0->>'runId' AS run_id, c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' AS principal_kind, c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AS principal_id, c.completed_keys->0->'pending'->>'requestId' AS pending_request_id,r.state AS pending_state, to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at FROM op_checkpoints c JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text<>c.completed_keys->0->>'incarnation' AND NOT COALESCE(s.archived,false) LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true' AND ($1::text[] IS NULL OR s.id=ANY($2::text[])) ORDER BY s.id COLLATE \"C\",c.updated_at,c.fingerprint COLLATE \"C\"",
    "SELECT f.fingerprint AS cursor_key,s.id AS source_id,f.completed_keys->0->>'source_incarnation' AS source_incarnation,f.completed_keys->0->>'run_id' AS run_id, f.completed_keys->0->>'request_id' AS request_id,to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at FROM op_checkpoints f JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text<>f.completed_keys->0->>'source_incarnation' AND NOT COALESCE(s.archived,false) WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($2::text[])) AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint AND COALESCE(c.completed_keys->0->>'done','false')<>'true') ORDER BY s.id COLLATE \"C\",f.fingerprint COLLATE \"C\"",
  ];

  test('listManagedSyncOrphanRows binds the id filter twice per read and the moved message first', async () => {
    const { calls, exec } = recorder();
    await listManagedSyncOrphanRows(exec, ['a', 'b']);
    expect(calls).toEqual([
      { text: READS[0], params: [MOVED, ['a', 'b'], ['a', 'b']] },
      ...READS.slice(1).map((text) => ({ text, params: [['a', 'b'], ['a', 'b']] })),
    ]);
  });

  test('listManagedSyncOrphanRows without an id filter binds null for every use', async () => {
    const { calls, exec } = recorder();
    await listManagedSyncOrphanRows(exec, null);
    expect(calls).toEqual([
      { text: READS[0], params: [MOVED, null, null] },
      ...READS.slice(1).map((text) => ({ text, params: [null, null] })),
    ]);
  });

  const TARGET = { cursorKey: 'ck', sourceId: 's', incarnation: 'inc', runId: 'run', requestId: REQ };

  test('retireManagedSyncPassSlugMode locks the state, then binds the request id twice with its uuid cast', async () => {
    const { calls, exec } = recorder([[{ live: false }]]);
    await retireManagedSyncPassSlugMode(exec, TARGET, 'lock');
    expect(calls).toEqual([
      { text: "SELECT ttl_expires_at > now() AS live FROM gbrain_cycle_locks WHERE id=$1 FOR UPDATE", params: ['lock'] },
      { text: "UPDATE op_checkpoints p SET completed_keys=jsonb_set(p.completed_keys,'{0,obligations}',(p.completed_keys->0->'obligations')-'slug_mode'),updated_at=now() FROM sources s WHERE p.op='managed-sync-pass' AND p.fingerprint=$1 AND s.id=$2 AND s.incarnation::text=$3 AND NOT COALESCE(s.archived,false) AND p.completed_keys->0->'telemetry'->>'pass_id' IS NOT DISTINCT FROM $4::text AND (p.completed_keys->0->'obligations'->>'slug_mode' IS NOT NULL AND s.config->>'slug_root_mode' IS NOT NULL AND s.config->>'slug_root_mode' IS DISTINCT FROM p.completed_keys->0->'obligations'->>'slug_mode' AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=$5::uuid AND m.intent->>'kind'='managed_sync_checkpoint' AND m.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='slug_root_mode_mismatch') AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL))) AND (SELECT n.request_id FROM persistence_requests n WHERE n.source_id=s.id AND n.intent->>'kind'='managed_sync_checkpoint' AND n.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' ORDER BY n.sequence DESC LIMIT 1)=$6::uuid RETURNING p.fingerprint", params: ['ck', 's', 'inc', 'run', REQ, REQ] },
    ]);
  });

  const RETIRE = "DELETE FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=$1 AND COALESCE(c.completed_keys->0->>'done','false')<>'true' AND c.completed_keys->0->>'sourceId'=$2 AND c.completed_keys->0->>'incarnation'=$3 AND NOT EXISTS(SELECT 1 FROM persistence_requests r WHERE r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid AND r.source_id=$4 AND r.state NOT IN ('committed','failed','conflict','cancelled')) AND ($5::text='retired' AND EXISTS(SELECT 1 FROM sources s WHERE s.id=$6 AND NOT COALESCE(s.archived,false) AND s.incarnation::text<>$7) OR $8::text='adoption' AND NOT EXISTS(SELECT 1 FROM persistence_requests r WHERE r.source_id=$9 AND r.intent->>'cursorKey'=$10 AND (r.state IN ('queued','running','recovering') OR r.recovery IS NOT NULL)) OR $11::text='checkpoint_moved' AND c.completed_keys->0->>'runId' IS NOT DISTINCT FROM $12::text AND c.completed_keys->0->'pending'->>'requestId' IS NOT DISTINCT FROM $13::text AND EXISTS(SELECT 1 FROM sources s WHERE s.id=$14 AND s.incarnation::text=$15 AND NOT COALESCE(s.archived,false) AND (c.completed_keys->0->'pending'->'intent'->>'kind'='managed_sync_checkpoint' AND c.completed_keys->0->>'companyReceiptId' IS NULL AND (c.completed_keys->0->>'index')::int>=(c.completed_keys->0->>'total')::int AND s.last_commit IS DISTINCT FROM c.completed_keys->0->>'from' AND (c.completed_keys->0->'pending'->'intent'->'slice'->>'done'='false' OR s.last_commit IS DISTINCT FROM c.completed_keys->0->>'target') AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='revision_conflict' AND m.error_message=$16) AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'cursorKey'=c.fingerprint AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL)))) OR $17::text='slug_mode_refused' AND c.completed_keys->0->>'runId' IS NOT DISTINCT FROM $18::text AND c.completed_keys->0->'pending'->>'requestId' IS NOT DISTINCT FROM $19::text AND EXISTS(SELECT 1 FROM sources s WHERE s.id=$20 AND s.incarnation::text=$21 AND NOT COALESCE(s.archived,false) AND (c.completed_keys->0->'pending'->'intent'->>'kind'='managed_sync_checkpoint' AND c.completed_keys->0->>'companyReceiptId' IS NULL AND (c.completed_keys->0->>'index')::int>=(c.completed_keys->0->>'total')::int AND s.config->>'slug_root_mode' IS NOT NULL AND s.config->>'slug_root_mode' IS DISTINCT FROM c.completed_keys->0->>'slugMode' AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='slug_root_mode_mismatch') AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'cursorKey'=c.fingerprint AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL)))) OR $22::text='orphan' AND NOT EXISTS(SELECT 1 FROM persistence_local_writers w WHERE w.revoked_at IS NULL AND w.id::text=c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AND c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' IN ('local_cli','local_stdio') AND (c.completed_keys->0 ? 'syncOptions'))) RETURNING fingerprint,c.completed_keys->0->'pending'->'intent' AS intent";
  const retireParams = (mode: string, inc: string | null, run: string | null, req: string | null) =>
    ['ck', 's', inc, 's', mode, 's', inc, mode, 's', 'ck', mode, run, req, 's', inc, MOVED, mode, run, req, 's', inc, mode];

  test.each(['retired', 'adoption', 'checkpoint_moved', 'slug_mode_refused', 'orphan'])(
    'retireManagedSyncCursor in %s mode binds the mode once per use',
    async (mode) => {
      const { calls, exec } = recorder();
      await retireManagedSyncCursor(exec, TARGET, mode as never);
      expect(calls).toEqual([{ text: RETIRE, params: retireParams(mode, 'inc', 'run', REQ) }]);
    },
  );

  test('retireManagedSyncCursor with no incarnation, run or request binds nulls', async () => {
    const { calls, exec } = recorder();
    await retireManagedSyncCursor(exec, { cursorKey: 'ck', sourceId: 's', incarnation: null, runId: null, requestId: null }, 'orphan');
    expect(calls).toEqual([{ text: RETIRE, params: retireParams('orphan', null, null, null) }]);
  });
});

describe('loop-mutes.ts rendered SQL', () => {
  test.each([
    ['sender', 'preview', "SELECT l.id, l.thread_id FROM open_loops l WHERE l.source_id = $1 AND l.closed_by = 'muted' AND l.counterparty_email = $2 AND NOT EXISTS (SELECT 1 FROM loop_suppressions s WHERE s.source_id = l.source_id AND NOT (s.kind = $3 AND s.value = $4) AND ((s.kind = 'thread' AND s.value = lower(l.thread_id)) OR (s.kind = 'sender' AND s.value = l.counterparty_email)))"],
    ['sender', 'apply', "UPDATE open_loops l SET closed_by = CASE WHEN l.thread_id IS NULL THEN 'unmuted' ELSE 'mute_recheck' END, updated_at = now() WHERE l.source_id = $1 AND l.closed_by = 'muted' AND l.counterparty_email = $2 AND NOT EXISTS (SELECT 1 FROM loop_suppressions s WHERE s.source_id = l.source_id AND NOT (s.kind = $3 AND s.value = $4) AND ((s.kind = 'thread' AND s.value = lower(l.thread_id)) OR (s.kind = 'sender' AND s.value = l.counterparty_email))) RETURNING l.id, l.thread_id"],
    ['thread', 'preview', "SELECT l.id, l.thread_id FROM open_loops l WHERE l.source_id = $1 AND l.closed_by = 'muted' AND lower(l.thread_id) = $2 AND NOT EXISTS (SELECT 1 FROM loop_suppressions s WHERE s.source_id = l.source_id AND NOT (s.kind = $3 AND s.value = $4) AND ((s.kind = 'thread' AND s.value = lower(l.thread_id)) OR (s.kind = 'sender' AND s.value = l.counterparty_email)))"],
    ['thread', 'apply', "UPDATE open_loops l SET closed_by = CASE WHEN l.thread_id IS NULL THEN 'unmuted' ELSE 'mute_recheck' END, updated_at = now() WHERE l.source_id = $1 AND l.closed_by = 'muted' AND lower(l.thread_id) = $2 AND NOT EXISTS (SELECT 1 FROM loop_suppressions s WHERE s.source_id = l.source_id AND NOT (s.kind = $3 AND s.value = $4) AND ((s.kind = 'thread' AND s.value = lower(l.thread_id)) OR (s.kind = 'sender' AND s.value = l.counterparty_email))) RETURNING l.id, l.thread_id"],
  ] as const)('requeueMutedLoops by %s in %s mode binds the value for the match and the suppression', async (kind, mode, text) => {
    const { calls, exec } = recorder();
    await requeueMutedLoops(exec, 's', kind, 'v@x.io', mode === 'apply');
    expect(calls).toEqual([{ text, params: ['s', 'v@x.io', kind, 'v@x.io'] }]);
  });
});

describe('persistence-effect-scans.ts rendered SQL', () => {
  test('listEmbeddingCandidates binds the never-retried codes as one array before the sources', async () => {
    const { calls, exec } = recorder();
    await listEmbeddingCandidates(exec, ['a', 'b'], ['targets_parked', 'zero_norm']);
    expect(calls).toEqual([{ text: "SELECT e.id::text AS effect_id, r.source_id, r.slug, r.request_id::text AS request_id, e.state, e.attempts, COALESCE(CASE WHEN e.data ? 'page_id' THEN (SELECT length(p.compiled_truth) + length(COALESCE(p.timeline,'')) FROM pages p WHERE p.id = (e.data->>'page_id')::int) WHEN e.data ? 'targets' THEN (SELECT SUM(length(p.compiled_truth) + length(COALESCE(p.timeline,''))) FROM pages p JOIN jsonb_array_elements(e.data->'targets') t ON p.id = (t->>'page_id')::int) ELSE (SELECT SUM(length(p.compiled_truth) + length(COALESCE(p.timeline,''))) FROM pages p WHERE p.source_id = e.source_id AND p.deleted_at IS NULL) END, 0)::bigint AS chars FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id WHERE e.kind='embedding' AND r.state='committed' AND e.recovery IS NULL AND e.execution_token IS NULL AND (e.state='failed' OR e.state='queued' AND (e.updated_at < now() - interval '1 hour' OR e.data ? 'repair_requeued_at')) AND NOT (e.state='failed' AND e.error_code = ANY($1::text[])) AND (r.source_id = ANY($2::text[]) OR NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = r.source_id AND s.incarnation = r.source_incarnation)) ORDER BY e.id", params: [['targets_parked', 'zero_norm'], ['a', 'b']] }]);
  });

  test('embeddingCandidateWhere matches the never-retried codes with one array literal', () => {
    expect(norm(embeddingCandidateWhere(['targets_parked', 'zero_norm']))).toBe("e.kind='embedding' AND r.state='committed' AND e.recovery IS NULL AND e.execution_token IS NULL AND (e.state='failed' OR e.state='queued' AND (e.updated_at < now() - interval '1 hour' OR e.data ? 'repair_requeued_at')) AND NOT (e.state='failed' AND e.error_code = ANY('{targets_parked,zero_norm}'::text[]))");
  });

  test('embeddingCandidateWhere rejects a code that is not an identifier', () => {
    expect(() => embeddingCandidateWhere(["x'); DROP TABLE pages; --"])).toThrow();
  });
});
