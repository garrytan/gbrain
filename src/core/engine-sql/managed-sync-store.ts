/**
 * The managed sync's statements (`runSyncStatement`): the reads and writes `gbrain sync` of a managed source sends through the
 * rows the sync keeps (the source row, the pages and requests it reads, the `op_checkpoints` rows of its cursor, pass row,
 * holds, markers, failures, tail and ghost report). Each statement keeps the text its caller sent, moved unchanged and named;
 * PGLite and Postgres run that text on the engine's own `executeRaw`, so a statement fault a test injects on the engine
 * reaches it and a transaction-bound engine runs it in its transaction.
 *
 * A Rust brain answers a statement by name from its records (rust/crates/gbrain-store/src/persistence/managed_sync_store.rs),
 * one tagged read call and one tagged write call. Row locks (`FOR UPDATE`, `FOR SHARE`) stay in the SQL text here; on Rust
 * each is a stated guarantee instead (the module doc of managed_sync_store.rs): an explicit transaction is Serialized (it holds
 * the store's writer, so no other commit interleaves with what it read) and, under optimistic transactions, the rows read are
 * in the transaction's read set, so a racing change aborts the commit with `write_conflict`.
 *
 * Callers use `syncRows(engine, name, params)`: an engine that serves `runSyncStatement` answers it, and an `executeRaw`-only
 * view of one (a test double, a bounded read view) runs the same text.
 */
import type { BrainEngine } from '../engine.ts';
import type { LeaseToken } from './lease-token.ts';
import { KERNEL_PAGE_BY_ID_SQL, KERNEL_PAGE_BY_ID_UNMANIFESTED_SQL, KERNEL_PAGES_BY_SLUG_SQL, KERNEL_PAGES_BY_SLUG_UNMANIFESTED_SQL, REFUSED_CHECKPOINT_SQL, UNFINISHED_PAGE_REQUEST_SQL } from '../persistence/sync-run-sql.ts';

/** A statement: `read` leaves the rows alone, `write` may change them (its `RETURNING` rows come back as rows). */
interface SyncStatement { readonly kind: 'read' | 'write'; readonly sql: string }


export const SYNC_STATEMENTS = {
  // The source row (sync-discovery.ts, sync-screen.ts, sync-prepare.ts, sync-failures.ts).
  source_row: { kind: 'read', sql: 'SELECT incarnation,archived,local_path,last_commit,config FROM sources WHERE id=$1' },
  source_config: { kind: 'read', sql: 'SELECT config FROM sources WHERE id=$1' },
  source_local_path: { kind: 'read', sql: 'SELECT local_path FROM sources WHERE id=$1' },
  source_last_commit: { kind: 'read', sql: 'SELECT last_commit FROM sources WHERE id=$1 AND incarnation=$2::uuid' },

  // The slug-root probe (sync-anchor.ts resolveSlugRootMode): whether a live page of the source sits under the inferred prefix.
  slug_prefix_probe: { kind: 'read', sql: `SELECT 1 AS one FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE $2 LIMIT 1` },

  // The stored timeline rows of a page, one keyset page at a time (timeline-extract.ts eachStoredTimelineRow, read by the managed extract).
  stored_timeline_page: { kind: 'read', sql: `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, date::text AS date_text, source, summary, detail FROM timeline_entries
        WHERE page_id = $1 AND event_page_id IS NULL AND id > $2 ORDER BY id LIMIT $3` },

  // The config rows the pass reads (sync-held-deletions.ts).
  config_values: { kind: 'read', sql: 'SELECT key, value FROM config WHERE key = ANY($1::text[])' },

  // op_checkpoints reads (sync-holds.ts, sync-tail-record.ts, sync-pass.ts, sync-pass-row.ts, sync-markers.ts, sync-pass-episode.ts).
  hold_fingerprints: { kind: 'read', sql: "SELECT fingerprint FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'=$2" },
  held_fingerprints: { kind: 'read', sql: 'SELECT fingerprint FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])' },
  checkpoint_keys: { kind: 'read', sql: 'SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2' },
  checkpoint_first: { kind: 'read', sql: 'SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2' },
  checkpoint_prefix: { kind: 'read', sql: 'SELECT fingerprint, completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND starts_with(fingerprint, $2)' },
  failure_key_present: { kind: 'read', sql: "SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=ANY($1::text[]) LIMIT 1" },
  idle_facts: { kind: 'read', sql: `SELECT EXISTS(SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND completed_keys->0->>'source_id'=$1) AS failures,
      COALESCE((SELECT (completed_keys->0->>'count')::int FROM op_checkpoints WHERE op=$2 AND fingerprint=$3),0) AS hold_summary` },
  cursor_rows: { kind: 'read', sql: `SELECT fingerprint AS key, COALESCE(completed_keys->0->>'done','false')='true' AS done,
      completed_keys->0->>'companyReceiptId' AS company_receipt_id, completed_keys->0->>'runId' AS run_id
    FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'=$2
    ORDER BY updated_at DESC, fingerprint COLLATE "C"` },
  reserved_usd: { kind: 'read', sql: `SELECT COALESCE(sum((completed_keys->0->>'usd')::numeric),0)::float8 AS usd, count(*) AS rows FROM op_checkpoints WHERE op=$1 AND starts_with(fingerprint, $2)` },

  // The pages and requests the pass reads (sync-pass.ts, sync-pass-run.ts, sync-origin.ts, sync-run.ts).
  open_requests: { kind: 'read', sql: `SELECT page_id, intent->>'sourcePath' AS source_path, intent->>'path' AS path
    FROM persistence_requests WHERE state IN ('queued','running','recovering') AND source_id=$2 AND (worktree_id=$1 OR worktree_id IS NULL AND source_incarnation=$3::uuid)` },
  open_git_effects: { kind: 'read', sql: `SELECT r.page_id, e.data->>'relative_path' AS path
    FROM persistence_requests r JOIN persistence_effects e ON e.request_id=r.id
    WHERE r.worktree_id=$1 AND r.source_id=$2 AND e.kind='git' AND e.state IN ('queued','running')` },
  foreground_request: { kind: 'read', sql: `SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid
            AND state IN ('queued','running','recovering') AND NOT(COALESCE(intent->>'kind','') LIKE 'managed_sync_%') LIMIT 1` },
  pages_for_adoption: { kind: 'read', sql: "SELECT id, slug, source_path, deleted_at, frontmatter->>'id' AS fm_id FROM pages WHERE source_id=$1 AND (source_path IS NULL OR slug=ANY($2::text[]))" },
  pages_by_slug: { kind: 'read', sql: `SELECT id, slug, source_path, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted, pages.database_only_reason IS NOT DISTINCT FROM 'unbound_source' AND COALESCE(btrim(pages.source_path, (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '')='' AND COALESCE(btrim(pages.source_uri, (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '')='' AS unbound, frontmatter->>'id' AS fm_id FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])` },
  origin_pages: { kind: 'read', sql: 'SELECT id,slug,source_path,deleted_at FROM pages WHERE source_id=$1 AND source_path=ANY($2::text[])' },
  origin_pages_folded: { kind: 'read', sql: "SELECT id,slug,source_path,deleted_at FROM pages WHERE source_id=$1 AND lower(replace(source_path,chr(92),'/'))=ANY($2::text[])" },

  // The fence-trend reads (sync-prepare.ts).
  max_request_sequence: { kind: 'read', sql: 'SELECT max(sequence)::text AS through FROM persistence_requests' },
  open_import_sequences: { kind: 'read', sql: `SELECT sequence::text AS sequence FROM persistence_requests
    WHERE worktree_id=$1::uuid AND sequence > $2::bigint AND sequence <= $3::bigint AND state IN ('queued','deferred','running','recovering')
      AND source_id=$4 AND intent->>'kind'='managed_sync_import' ORDER BY persistence_requests.sequence` },
  fence_trend_range: { kind: 'read', sql: `SELECT intent->>'path' AS path, outcome->'fences_normalized' AS fences, sequence::text AS sequence
    FROM persistence_requests WHERE worktree_id=$1::uuid AND source_id=$2 AND sequence > $3::bigint AND sequence <= $4::bigint AND state='committed'
      AND intent->>'kind'='managed_sync_import' AND intent->>'passId' IS NOT NULL AND jsonb_typeof(outcome->'fences_normalized')='array' ORDER BY persistence_requests.sequence` },
  fence_trend_open: { kind: 'read', sql: `SELECT intent->>'path' AS path, outcome->'fences_normalized' AS fences
    FROM persistence_requests WHERE worktree_id=$1::uuid AND source_id=$2 AND (sequence > $3::bigint OR sequence = ANY($4::text::bigint[])) AND state='committed'
      AND intent->>'kind'='managed_sync_import' AND intent->>'passId' IS NOT NULL AND jsonb_typeof(outcome->'fences_normalized')='array' ORDER BY persistence_requests.sequence` },
  fence_trend_after: { kind: 'read', sql: `SELECT intent->>'path' AS path, outcome->'fences_normalized' AS fences
    FROM persistence_requests WHERE worktree_id=$1::uuid AND source_id=$2 AND sequence > $3::bigint AND state='committed'
      AND intent->>'kind'='managed_sync_import' AND intent->>'passId' IS NOT NULL AND jsonb_typeof(outcome->'fences_normalized')='array' ORDER BY persistence_requests.sequence` },

  // The idle probe (sync-pass.ts passIdleProbe).
  pass_idle_probe: { kind: 'read', sql: `WITH pass AS (
      SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2),
    stamp AS (SELECT unnest(COALESCE($5::text[], ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(value->'obligations'->'converged'->'open_at_stamp')='array'
      THEN value->'obligations'->'converged'->'open_at_stamp' ELSE '[]'::jsonb END) FROM pass))) AS id)
    SELECT (SELECT value FROM pass) AS pass_row,
      EXISTS (SELECT 1 FROM persistence_requests WHERE sequence > COALESCE($3::bigint, ((SELECT value FROM pass)->'obligations'->'converged'->>'request_hwm')::bigint, 0)
        AND (worktree_id = $4 OR worktree_id IS NULL AND source_id = $6 AND source_incarnation = $7::uuid)) AS newer,
      EXISTS (SELECT 1 FROM persistence_requests WHERE state IN ('queued','running','recovering') AND (worktree_id = $4 OR worktree_id IS NULL AND source_id = $6 AND source_incarnation = $7::uuid)) AS pending,
      (SELECT count(*) FROM persistence_requests WHERE state IN ('queued','running','recovering') AND (worktree_id = $4 OR worktree_id IS NULL AND source_id = $6 AND source_incarnation = $7::uuid)
        AND 'r:'||request_id::text IN (SELECT id FROM stamp))
        + (SELECT count(*) FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
            WHERE r.worktree_id = $4 AND e.kind = 'git' AND e.state IN ('queued','running') AND 'e:'||e.id::text IN (SELECT id FROM stamp)) AS still_open,
      EXISTS (SELECT 1 FROM persistence_effects e WHERE e.kind = 'git' AND e.state <> 'committed' AND NOT (e.data ? 'settled') AND e.request_id IN (SELECT id::uuid FROM pass,
        jsonb_array_elements_text(CASE WHEN jsonb_typeof(value->'obligations'->'converged'->'writeback')='array' THEN value->'obligations'->'converged'->'writeback' ELSE '[]'::jsonb END) AS w(id))) AS writeback_open` },

  // op_checkpoints writes (sync-failures.ts, sync-tail-record.ts, sync-tail.ts, sync-pass-episode.ts, sync-ghosts.ts).
  failure_clear: { kind: 'write', sql: `DELETE FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1
    AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=$1 AND COALESCE(c.completed_keys->0->>'done','false')<>'true') RETURNING fingerprint` },
  tail_record_run: { kind: 'write', sql: `INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
    SELECT $1, $2, jsonb_build_array(jsonb_build_object('run_id',$3::text,'at',now(),
      'changed',COALESCE((c.completed_keys->0->'counts'->>'added')::int,0)+COALESCE((c.completed_keys->0->'counts'->>'modified')::int,0)+COALESCE((c.completed_keys->0->'counts'->>'deleted')::int,0),
      'extract',COALESCE(c.completed_keys->0->'processingOptions'->>'noExtract','false')<>'true' AND c.completed_keys->0->>'companyReceiptId' IS NULL)), now()
    FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=$4
    ON CONFLICT (op,fingerprint) DO UPDATE SET updated_at=now(), completed_keys=CASE WHEN jsonb_array_length(op_checkpoints.completed_keys)>=16
      THEN (op_checkpoints.completed_keys-0)||EXCLUDED.completed_keys ELSE op_checkpoints.completed_keys||EXCLUDED.completed_keys END` },
  tail_record_pass: { kind: 'write', sql: `INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
    VALUES ($1, $2, jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('run_id',$3::text,'at',now(),'changed',$4::int,'extract',$5::boolean,'since',$6::text))), now())
    ON CONFLICT (op,fingerprint) DO UPDATE SET updated_at=now(), completed_keys=CASE WHEN jsonb_array_length(op_checkpoints.completed_keys)>=16
      THEN (op_checkpoints.completed_keys-0)||EXCLUDED.completed_keys ELSE op_checkpoints.completed_keys||EXCLUDED.completed_keys END` },
  tail_clear: { kind: 'write', sql: 'DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb' },
  tail_slugs: { kind: 'read', sql: `SELECT DISTINCT slug FROM (SELECT e->>'slug' AS slug FROM op_checkpoints m, jsonb_array_elements(m.completed_keys) e
        WHERE m.op='managed-sync-manifest' AND m.fingerprint=ANY($1::text[]) AND e->>'action'='import' AND e->>'slug' IS NOT NULL
        UNION SELECT r.slug FROM persistence_requests r, jsonb_to_recordset($2::text::jsonb) AS p(run_id text, since timestamptz, at timestamptz)
        WHERE r.recovery IS NULL AND NOT r.compacted AND r.state='committed' AND r.completed_at BETWEEN p.since AND p.at AND r.source_id=$3
          AND r.intent->>'passId'=p.run_id AND r.intent->>'kind'='managed_sync_import') imported LIMIT 1001` },
  pass_cost_insert: { kind: 'write', sql: 'INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,jsonb_build_array($3::text::jsonb),now()) ON CONFLICT (op,fingerprint) DO NOTHING' },
  ghost_report_read: { kind: 'read', sql: 'SELECT completed_keys AS report, false AS claimed FROM op_checkpoints WHERE op=$1 AND fingerprint=$2' },
  ghost_report_claim: { kind: 'write', sql: `WITH prior AS (SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2),
       claim AS (INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
         SELECT $1, $2, '[]'::jsonb, now() WHERE EXISTS (SELECT 1 FROM sources WHERE id=$2 AND last_sync_at IS NOT NULL)
         ON CONFLICT (op, fingerprint) DO UPDATE SET updated_at = now()
         WHERE op_checkpoints.updated_at <= now() - ($3::bigint * interval '1 millisecond')
           AND EXISTS (SELECT 1 FROM sources WHERE id=$2 AND last_sync_at > op_checkpoints.updated_at) RETURNING 1)
     SELECT (SELECT completed_keys FROM prior) AS report, EXISTS (SELECT 1 FROM claim) AS claimed` },
  ghost_report_write: { kind: 'write', sql: 'UPDATE op_checkpoints SET completed_keys=$3::text::jsonb, updated_at=now() WHERE op=$1 AND fingerprint=$2' },
  ghost_held_paths: { kind: 'read', sql: "SELECT completed_keys->0->>'path' AS path FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])" },
  // The round snapshot and the pass reads that follow it (sync-pass.ts, sync-pass-run.ts).
  round_snapshot: { kind: 'read', sql: 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY' },
  cursor_header_slices: { kind: 'read', sql: `SELECT (SELECT completed_keys->0 FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1) AS header,
      EXISTS (SELECT 1 FROM op_checkpoints WHERE op=$2 AND left(fingerprint, length($3))=$3) AS slices` },
  revision_attestations: { kind: 'read', sql: `SELECT x.page_id,
        (r.intent->>'kind' = ANY($3::text[]) AND r.source_incarnation::text=$2 AND (r.page_id IS NULL OR r.page_id=x.page_id)) AS arm1,
        COALESCE((SELECT e.data->>'expected_hash' FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='git' AND e.revision=x.revision
          AND e.data->>'expected_hash' IS NOT NULL AND (e.data->>'relative_path'=x.source_path OR right(e.data->>'relative_path', length(x.source_path)+1)='/'||x.source_path) LIMIT 1),
          CASE WHEN r.intent->>'kind'='managed_file_import' AND r.intent->>'sourcePath'=x.source_path AND r.intent->>'inputHash'=r.intent->>'targetHash' THEN r.intent->>'targetHash' END) AS attested_hash
      FROM unnest($4::int[], $5::uuid[], $6::uuid[], $7::text[]) AS x(page_id, request_id, revision, source_path)
      JOIN persistence_requests r ON r.id=x.request_id AND r.state='committed' AND r.source_id=$1` },
  file_removing_deletes: { kind: 'read', sql: `SELECT x.path FROM unnest($2::text[], $3::text[], $4::int[]) AS x(path, slug, page_id)
      CROSS JOIN LATERAL (SELECT r.sequence, r.outcome FROM persistence_requests r WHERE r.source_id=$1 AND r.slug=x.slug AND r.state='committed'
          AND r.operation='delete_page' AND (r.page_id IS NULL OR r.page_id=x.page_id) AND r.outcome->>'noop' IS DISTINCT FROM 'true'
          AND r.outcome->>'retention' IS DISTINCT FROM 'true' AND (r.intent IS NULL OR r.intent->>'retention' IS DISTINCT FROM 'true')
        ORDER BY r.sequence DESC LIMIT 1) d
      WHERE d.outcome->'write_through'->>'written'='true' AND d.outcome->>'status' IS DISTINCT FROM 'purged'
        AND NOT EXISTS (SELECT 1 FROM persistence_requests l WHERE l.source_id=$1 AND l.slug=x.slug AND l.sequence>d.sequence
          AND l.state='committed' AND l.operation IN ('restore_page','put_page') AND (l.page_id IS NULL OR l.page_id=x.page_id)
          AND l.outcome->>'noop' IS DISTINCT FROM 'true' AND l.outcome->>'status' IS DISTINCT FROM 'duplicate')` },
  legacy_deletions: { kind: 'read', sql: `SELECT DISTINCT ON (slug) slug, id::text AS id FROM persistence_requests
    WHERE source_id=$1 AND source_incarnation=$2::uuid AND state='committed' AND slug=ANY($3::text[])
      AND (operation='delete_page' OR intent->>'kind'='managed_sync_delete') ORDER BY slug, sequence DESC` },
  page_writers: { kind: 'read', sql: `SELECT p.id::text AS id, r.intent->>'level' AS level, r.intent->>'path' AS path
    FROM pages p JOIN persistence_requests r ON r.id=p.revision_write_request_id WHERE p.source_id=$1 AND p.id = ANY($2::bigint[])` },
  // The drain lease fence and the database clock (db-lock.ts fenceLockRow, sync-pass-run.ts databaseNow).
  lease_fence: { kind: 'read', sql: 'SELECT 1 FROM gbrain_cycle_locks WHERE id=$1 AND acquisition_token=$2::uuid AND ttl_expires_at > now() FOR KEY SHARE' },
  database_now: { kind: 'read', sql: 'SELECT now() AS at' },
  // Managed sync, lane LM slice 2 part B (sync-page-fault.ts, sync-prepare.ts, sync-status.ts, sync-dry-run-writer.ts, sync-stop-class.ts, sync-freshness.ts).
  // The page and request reads of the page-fault proofs (sync-page-fault.ts pageChangeProof, idempotentDeletionProof): the text of the typed
  // readPageRevisionWriter and readRevisionWriterRequest (engine-sql/sync-run-reads.ts), kept as statements so that a held Rust brain refuses them as executeRaw did.
  page_revision_writer: { kind: 'read', sql: 'SELECT knowledge_revision::text AS revision, revision_write_request_id::text AS writer FROM pages WHERE id=$1 AND source_id=$2' },
  request_writer: { kind: 'read', sql: `SELECT request_id::text, operation, intent->>'kind' AS kind, state, source_incarnation::text AS incarnation, page_id FROM persistence_requests WHERE id=$1::uuid` },
  page_deleted_revision_writer: { kind: 'read', sql: 'SELECT knowledge_revision::text AS revision, revision_write_request_id::text AS writer, deleted_at IS NOT NULL AS deleted FROM pages WHERE id=$1 AND source_id=$2' },
  live_page_at_origin: { kind: 'read', sql: 'SELECT 1 FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id<>$2 AND source_path=$3 LIMIT 1' },
  // The older cursor's manifest and checkpoint publication (sync-prepare.ts resolveSyncOrigin, applyManagedSyncCheckpoint).
  manifest_entry: { kind: 'read', sql: "SELECT completed_keys->$2::integer AS entry FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1" },
  cursor_keys_locked: { kind: 'read', sql: "SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1 FOR UPDATE" },
  manifest_length: { kind: 'read', sql: "SELECT jsonb_array_length(completed_keys) AS count FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1" },
  cursor_mark_done: { kind: 'write', sql: "UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,done}','true'::jsonb),updated_at=now() WHERE op='managed-sync' AND fingerprint=$1" },
  // `gbrain sync status` (sync-status.ts): the failure's clock against the newest commit and admission, the company-brain test, the live incarnation, the knock-on receipts and the live cursors.
  failure_supersession: { kind: 'read', sql: `SELECT now() AS now_at,
      (SELECT f.updated_at FROM op_checkpoints f WHERE f.op='managed-sync-failure' AND f.fingerprint=$2) AS failure_at,
      (SELECT max(r.completed_at) FROM persistence_source_bindings b JOIN persistence_requests r ON r.worktree_id=b.worktree_id AND r.source_incarnation=b.source_incarnation
        WHERE b.source_id=$1 AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS committed_at,
      (SELECT max(r.created_at) FROM persistence_source_bindings b JOIN persistence_requests r ON r.worktree_id=b.worktree_id AND r.source_incarnation=b.source_incarnation
        WHERE b.source_id=$1 AND r.state<>'committed' AND r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete')) AS admitted_at` },
  source_company_brain: { kind: 'read', sql: "SELECT id FROM sources WHERE id=$1 AND config->'company_brain' IS NOT NULL" },
  source_live_incarnation: { kind: 'read', sql: 'SELECT incarnation::text AS incarnation FROM sources WHERE id=$1 AND archived IS NOT TRUE' },
  // `syncKnockOnSql('r')` written out (a composed `$1` statement is not allowed here; test/persistence-sync-statements pins the text against it). A Rust brain
  // takes the predicate's strings (sync-knock-on.ts) as one extra trailing parameter, added by its store member.
  knock_on_requests: { kind: 'read', sql: `SELECT request_id::text AS request_id FROM persistence_requests r
    WHERE r.request_id::text = ANY($1::text[]) AND COALESCE((r.state IN ('cancelled','failed','conflict') AND r.recovery IS NULL AND NOT COALESCE(r.publication_started,false)
    AND (r.error_detail->>'origin' = 'sync_knock_on'
      OR (r.state='cancelled' AND r.error_code='cancelled' AND (r.error_message IN ('An earlier page of the same sync did not commit; this page was not published and is re-frozen after that failure is resolved.','An earlier page of the same sync did not commit after lock_timeout on its lane group; this page was not published and is re-frozen on the next sync pass.','An earlier page of the same sync did not commit after statement_timeout on its lane group; this page was not published and is re-frozen on the next sync pass.','An earlier page of the same bulk sync group failed; this page was not published and is re-frozen after that failure is resolved.')
        OR r.error_message LIKE 'Its predecessor request % was never admitted; this page was not published and is re-frozen on the next sync pass.' OR r.error_message LIKE 'The first page of its group (request %) was cancelled because its predecessor request % was never admitted; this page was not published and is re-frozen on the next sync pass.'))
      OR (r.state IN ('conflict','failed') AND r.error_code='revision_conflict' AND r.error_message='An earlier page of this sync did not commit.'))), false)` },
  live_cursor_rows: { kind: 'read', sql: `SELECT c.fingerprint, c.completed_keys->0 AS header, to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at, r.state
       FROM op_checkpoints c LEFT JOIN persistence_requests r ON r.source_id=$1 AND r.request_id::text=c.completed_keys->0->'pending'->>'requestId'
      WHERE c.op='managed-sync' AND c.completed_keys->0->>'sourceId'=$1 AND c.completed_keys->0->>'incarnation'=$2 ORDER BY c.updated_at DESC LIMIT 20` },
  // The dry run's open writer requests (sync-dry-run-writer.ts), the stop a run recorded (sync-stop-class.ts) and the freshness aggregate (sync-freshness.ts; the sample and the visible-chunk predicates written out).
  open_writer_requests: { kind: 'read', sql: `SELECT count(*) AS n, EXTRACT(EPOCH FROM now() - min(created_at)) AS age
    FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering')` },
  recorded_stop: { kind: 'read', sql: "SELECT completed_keys->0->>'gbrain_version' AS gbrain_version FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1 AND completed_keys->0->>'run_id'=$2" },
  // chunk-visibility-ok: chunkVisibleFilter('p', 'cc', currentTextProjectionFilter) written out in the text (test/persistence-journal-statements.test.ts pins it)
  freshness_aggregate: { kind: 'read', sql: `WITH c AS (SELECT key AS target, to_timestamp(value::double precision) AS committed_at FROM jsonb_each_text($4::text::jsonb)),
      sample AS (SELECT r.source_id, r.slug, r.sequence, r.page_id, r.completed_at, c.committed_at
        FROM persistence_requests r JOIN c ON c.target=r.intent->>'target' WHERE r.worktree_id=$1::uuid AND r.source_incarnation=$2::uuid AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
    AND r.completed_at > now() - ($3::int * interval '1 hour') AND r.intent->>'kind'='managed_sync_import' AND r.intent->>'from' IS NOT NULL
    AND COALESCE(r.intent->>'working','false') <> 'true'),
      later AS MATERIALIZED (SELECT l.source_id, l.slug, max(l.sequence) AS sequence FROM persistence_requests l
        WHERE l.state='committed' AND l.source_id IN (SELECT source_id FROM sample) AND l.sequence > (SELECT min(sequence) FROM sample) GROUP BY l.source_id, l.slug),
      s AS (SELECT r.completed_at, r.committed_at, COALESCE(r.page_id, (SELECT p.id FROM pages p WHERE p.source_id=r.source_id AND p.slug=r.slug LIMIT 1)) AS page_id,
          COALESCE(later.sequence > r.sequence, false) AS superseded
        FROM sample r LEFT JOIN later ON later.source_id=r.source_id AND later.slug=r.slug),
      e AS (SELECT s.completed_at, s.committed_at, s.superseded, ch.n, ch.missing, ch.last_at FROM s
        LEFT JOIN LATERAL (SELECT count(*) AS n, count(*) FILTER (WHERE cc.embedded_at IS NULL) AS missing, max(cc.embedded_at) AS last_at FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
          WHERE cc.page_id=s.page_id AND ((p.text_projection_revision = p.knowledge_revision) IS TRUE
       AND (cc.body_generation IS NULL OR cc.body_generation <= p.body_generation))) ch ON true),
      l AS (SELECT GREATEST(0, extract(epoch FROM completed_at - committed_at)) AS searchable,
          CASE WHEN NOT superseded AND n > 0 AND missing = 0 AND last_at >= completed_at THEN GREATEST(0, extract(epoch FROM last_at - committed_at)) END AS embedded,
          (NOT superseded AND n > 0 AND missing > 0) AS pending FROM e)
      SELECT count(*) AS samples, percentile_cont(0.5) WITHIN GROUP (ORDER BY searchable) AS s50, percentile_cont(0.95) WITHIN GROUP (ORDER BY searchable) AS s95,
        count(embedded) AS embedded, percentile_cont(0.5) WITHIN GROUP (ORDER BY embedded) AS e50, percentile_cont(0.95) WITHIN GROUP (ORDER BY embedded) AS e95,
        count(*) FILTER (WHERE pending) AS pending FROM l` },
  // The soak counters and the needs-human stamp of the hold sweep (soak-counters.ts) and the landing gaps of `sync status` (landing-gaps.ts; its receipt limit, LANDING_RECEIPT_LIMIT, written out).
  soak_counter_add: { kind: 'write', sql: `INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,jsonb_build_array(jsonb_build_object('day',$2::text,$3::text,$4::int)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array(op_checkpoints.completed_keys->0
      || jsonb_build_object($3::text, COALESCE((op_checkpoints.completed_keys->0->>$3)::int,0)+$4::int)), updated_at=now()` },
  hold_needs_human_stamp: { kind: 'write', sql: `UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta,needs_human_at}',to_jsonb($3::text))
      WHERE op=$1 AND fingerprint=$2 AND completed_keys->0->>'code'=$4 AND NOT (completed_keys->0->'meta' ? 'needs_human_at') RETURNING 1` },
  landing_binding: { kind: 'read', sql: `SELECT b.worktree_id::text AS worktree_id, b.source_incarnation::text AS incarnation
    FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation WHERE b.source_id=$1` },
  landing_live_slugs: { kind: 'read', sql: 'SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug = ANY($2::text[])' },
  landing_receipts: { kind: 'read', sql: `SELECT DISTINCT ON (w.slug COLLATE "C") w.slug, w.kind, w.completed_at, extract(epoch FROM now() - w.completed_at)::float8 AS age FROM (
        SELECT r.slug, r.sequence, r.completed_at, r.intent->>'kind' AS kind FROM persistence_requests r
         WHERE r.worktree_id=$1::uuid AND r.source_incarnation=$2::uuid AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
           AND r.completed_at > now() - ($3::int * interval '1 hour') AND r.slug IS NOT NULL
         ORDER BY r.completed_at DESC, r.sequence DESC LIMIT 2000) w
      ORDER BY w.slug COLLATE "C", w.sequence DESC` },
  // Markers, the withheld-deletes record and the origin checks (sync-markers.ts).
  source_commit_config: { kind: 'read', sql: 'SELECT last_commit, config FROM sources WHERE id=$1' },
  source_state: { kind: 'read', sql: 'SELECT incarnation::text AS incarnation, last_commit, config FROM sources WHERE id=$1' },
  page_owning_origin: { kind: 'read', sql: 'SELECT 1 FROM pages WHERE source_id=$1 AND id<>$2 AND deleted_at IS NULL AND source_path = ANY($3::text[]) LIMIT 1' },
  checkpoint_put_first: { kind: 'write', sql: `INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,jsonb_build_array($3::text::jsonb),now())
    ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()` },
  checkpoint_delete_if_first: { kind: 'write', sql: 'DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys->0 = $3::text::jsonb RETURNING 1' },
  checkpoint_delete: { kind: 'write', sql: 'DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 RETURNING 1' },

  // The recorded failure of a run (sync-failures.ts).
  failure_record: { kind: 'write', sql: `
      WITH pair AS (SELECT completed_keys->0 AS was, $2::text::jsonb->0 AS incoming FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1),
      same AS (SELECT was, incoming, was->>'path'=incoming->>'path' AND was->>'code'=incoming->>'code' AND was->>'message'=incoming->>'message' AS same,
        COALESCE((was->>'repeats')::int,1)+1 AS repeats FROM pair)
      INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync-failure',$1,$2::text::jsonb)
      ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=CASE
        WHEN op_checkpoints.completed_keys->0->>'observation_id'=EXCLUDED.completed_keys->0->>'observation_id'
        THEN CASE WHEN (SELECT same AND incoming->>'invocation' IS NOT NULL AND was->>'invocation' IS DISTINCT FROM incoming->>'invocation' FROM same)
          THEN jsonb_build_array(op_checkpoints.completed_keys->0 || jsonb_build_object('repeats',(SELECT repeats FROM same),'invocation',EXCLUDED.completed_keys->0->>'invocation'))
          ELSE op_checkpoints.completed_keys END
        WHEN op_checkpoints.completed_keys->0->>'target' IS DISTINCT FROM EXCLUDED.completed_keys->0->>'target'
        THEN EXCLUDED.completed_keys
        ELSE jsonb_build_array(EXCLUDED.completed_keys->0 || jsonb_build_object(
          'first_seen',op_checkpoints.completed_keys->0->>'first_seen',
          'attempts',COALESCE((op_checkpoints.completed_keys->0->>'attempts')::int,0)+1,
          'repeats',(SELECT CASE WHEN same THEN repeats ELSE 1 END FROM same))) END,
        updated_at=now()
      RETURNING completed_keys` },

  // Carried requests, the checkout heads and the converged watermark (sync-pass-carried.ts, sync-pass-readers.ts, sync-pass-batch.ts).
  open_pass_requests: { kind: 'read', sql: `SELECT id::text AS id FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering')
      AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND (intent->>'passId'=$2 OR id=ANY($3::uuid[])) ORDER BY sequence LIMIT $4` },
  settle_carried: { kind: 'read', sql: `SELECT id::text AS id, state, intent->>'kind' AS kind, intent ? 'renameFrom' AS renamed, outcome->>'status' AS status,
      COALESCE((outcome->>'noop')::boolean, false) AS noop, (outcome->>'chunks')::int AS chunks FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence` },
  checkout_heads: { kind: 'read', sql: `SELECT b.source_id, h.local_path, b.relative_path
    FROM persistence_source_bindings b JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$2::uuid
    WHERE b.source_id=ANY($1::text[])` },
  converged_hwm: { kind: 'read', sql: `SELECT GREATEST((SELECT max(sequence) FROM persistence_requests WHERE worktree_id=$1::uuid),
    (SELECT max(sequence) FROM persistence_requests WHERE worktree_id IS NULL AND source_id=$2 AND source_incarnation=$3::uuid))::text AS hwm` },
  converged_open: { kind: 'read', sql: `(SELECT 'r:'||request_id::text AS id FROM persistence_requests
      WHERE state IN ('queued','running','recovering') AND (worktree_id=$1::uuid OR worktree_id IS NULL AND source_id=$4 AND source_incarnation=$5::uuid)
        AND request_id IS DISTINCT FROM $2::uuid LIMIT $3)
    UNION ALL (SELECT 'e:'||e.id::text FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
      WHERE r.worktree_id=$1::uuid AND e.kind='git' AND e.state IN ('queued','running') LIMIT $3)` },
  converged_writeback: { kind: 'read', sql: `SELECT DISTINCT e.request_id::text AS id FROM persistence_effects e
      WHERE e.request_id = ANY($1::uuid[]) AND e.kind='git' AND e.state<>'committed' AND NOT (e.data ? 'settled')` },

  // The pass status reads (sync-pass-status.ts).
  open_pass_rows: { kind: 'read', sql: `SELECT s.id AS source_id, c.updated_at,
    c.completed_keys->0->'telemetry'->>'outcome' AS outcome FROM sources s JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text
    WHERE s.id=ANY($2::text[]) AND s.archived IS NOT TRUE` },
  pass_banked: { kind: 'read', sql: `SELECT EXISTS (SELECT 1 FROM persistence_requests r JOIN persistence_source_bindings b ON b.worktree_id=r.worktree_id
      WHERE b.source_id=$1 AND b.source_incarnation::text=$6 AND r.source_incarnation=b.source_incarnation AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
        AND r.completed_at >= $5::timestamptz AND r.intent->>'passId'=$2)
    OR EXISTS (SELECT 1 FROM op_checkpoints WHERE op=$3 AND left(fingerprint, length($4))=$4 AND completed_keys->0->>'run_id'=$2 AND (completed_keys->0->>'held_at')::timestamptz >= $5::timestamptz
        AND completed_keys->0->'meta'->'basis_moved' IS NULL) AS banked` },
  pass_rewritten_holds: { kind: 'read', sql: `SELECT h.fingerprint, h.completed_keys->0 AS record, p.knowledge_revision::text AS revision
      FROM op_checkpoints h LEFT JOIN pages p ON p.source_id=$1 AND p.id=(h.completed_keys->0->>'page_id')::bigint
      WHERE h.op=$2 AND left(h.fingerprint, length($3))=$3 AND h.completed_keys->0->>'run_id'=$4 AND (h.completed_keys->0->>'updated_at')::timestamptz >= $5::timestamptz
        AND NOT (h.completed_keys->0->>'code' = ANY($6::text[])) AND h.completed_keys->0->'meta'->'basis_moved' IS NULL
        AND h.completed_keys->0->'meta'->'retry_only' IS NULL AND h.completed_keys->0->'meta'->'keep_deleted' IS NULL AND h.fingerprint > $7 ORDER BY h.fingerprint LIMIT $8` },

  // The apply round (sync-pass-apply.ts) and the folded stamp (sync-pass-fold.ts).
  live_slugs: { kind: 'read', sql: 'SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug=ANY($2::text[])' },
  unreadable_hold_paths: { kind: 'read', sql: `SELECT completed_keys->0->>'path' AS path FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])
    AND completed_keys->0->>'code'='file_unreadable'` },
  pages_revisions_shared: { kind: 'read', sql: 'SELECT id, knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id=ANY($2::int[]) FOR SHARE' },
  writeback_effects: { kind: 'read', sql: `SELECT data->>'relative_path' AS path, data->>'expected_hash' AS hash, state
    FROM persistence_effects WHERE request_id = ANY($1::uuid[]) AND kind='git'` },
  source_mode: { kind: 'read', sql: `SELECT last_commit, config->>'slug_root_mode' AS mode FROM sources WHERE id=$1 AND incarnation=$2::uuid` },
  // The source's slug mode, the slice records and the retry paths (sync-slug-mode.ts, sync-slices.ts, sync-holds.ts).
  source_slug_mode: { kind: 'read', sql: "SELECT config->>'slug_root_mode' AS mode FROM sources WHERE id=$1 AND incarnation=$2::uuid" },
  source_mode_commit: { kind: 'read', sql: "SELECT config->>'slug_root_mode' AS mode, last_commit FROM sources WHERE id=$1 AND incarnation=$2::uuid" },
  slice_put: { kind: 'write', sql: `INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()` },
  slice_clear: { kind: 'write', sql: "DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND ($3::text IS NULL OR completed_keys->0->>'target'=$3)" },
  retry_paths_remove: { kind: 'write', sql: `UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,paths}',
      (SELECT COALESCE(jsonb_agg(p),'[]'::jsonb) FROM jsonb_array_elements_text(completed_keys->0->'paths') p WHERE NOT (p = ANY($3::text[])))),
      updated_at=now() WHERE op=$1 AND fingerprint=$2` },
  retry_paths_prune: { kind: 'write', sql: "DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND jsonb_array_length(completed_keys->0->'paths')=0" },

  // The page and request reads behind the holds (sync-holds.ts, sync-prescreen.ts, sync-page-fault.ts).
  settled_live_pages: { kind: 'read', sql: 'SELECT id::text AS id, slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND (id = ANY($2::bigint[]) OR slug = ANY($3::text[]))' },
  pages_basis: { kind: 'read', sql: 'SELECT id, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND id=ANY($2::int[])' },
  page_revisions: { kind: 'read', sql: 'SELECT id, knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::bigint[])' },
  file_backed_pages: { kind: 'read', sql: `SELECT p.id FROM pages p JOIN persistence_requests r ON r.id=p.revision_write_request_id
      WHERE p.source_id=$1 AND p.id=ANY($2::bigint[]) AND r.state='committed' AND r.source_id=p.source_id AND (
        r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND r.source_incarnation::text=$3 AND (r.page_id IS NULL OR r.page_id=p.id)
        OR EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='git' AND e.revision=p.knowledge_revision
          AND e.data->>'expected_hash' IS NOT NULL AND (e.data->>'relative_path'=p.source_path OR right(e.data->>'relative_path', length(p.source_path)+1)='/'||p.source_path)))` },
  page_revision_by_slug: { kind: 'read', sql: 'SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2' },
  page_revision_by_id: { kind: 'read', sql: 'SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1 AND source_id=$2' },
  shared_origin_survivor: { kind: 'read', sql: `SELECT 1 FROM pages d JOIN persistence_requests r ON r.source_id=d.source_id AND r.slug=d.slug
    WHERE d.source_id=$1 AND d.deleted_at IS NOT NULL AND d.source_path=$2 AND r.operation='delete_page' AND r.state='committed'
      AND r.outcome->'write_through'->>'skipped'='shared_origin' LIMIT 1` },
  repeated_write_failures: { kind: 'read', sql: `SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND source_incarnation=$2::uuid AND slug=$3
    AND state='failed' AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND error_code=$4 AND COALESCE(error_detail->>'origin','')=$5
    AND COALESCE(error_detail->>'error_class','')=$6 AND COALESCE(error_detail->>'errno',error_detail->>'sqlstate','')=$7` },
  // Session settings (sync-failures.ts, sync-run.ts, sync-group.ts), the worktree row lock and the config snapshot (config-snapshot.ts).
  sync_commit_on: { kind: 'read', sql: "SELECT set_config('synchronous_commit','on',true)" },
  admission_settings: { kind: 'read', sql: "SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)" },
  worktree_lock: { kind: 'read', sql: 'SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE' },
  source_unfinished_request: { kind: 'read', sql: "SELECT id FROM persistence_requests WHERE source_id=$1 AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1" },
  config_all: { kind: 'read', sql: 'SELECT key,value FROM config' },

  // The discovery's page reads (sync-discovery.ts).
  live_origin_pages: { kind: 'read', sql: 'SELECT slug,source_path,id FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL' },
  live_origin_slugs: { kind: 'read', sql: 'SELECT source_path, slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL' },
  source_identities: { kind: 'read', sql: "SELECT q.*,f.frontmatter->>'id' AS fm_id FROM (SELECT id,slug,source_path,knowledge_revision,deleted_at FROM pages WHERE source_id=$1) q JOIN pages f ON f.id=q.id" },
  deleted_page_ids: { kind: 'read', sql: 'SELECT id FROM pages WHERE source_id=$1 AND deleted_at IS NOT NULL' },
  database_only_pages: { kind: 'read', sql: `SELECT p.id FROM pages p WHERE p.id=ANY($1::bigint[]) AND (p.database_only_reason IS NOT DISTINCT FROM 'unbound_source' AND COALESCE(btrim(p.source_path, (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '')='' AND COALESCE(btrim(p.source_uri, (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '')='' OR p.database_only_reason IS NOT DISTINCT FROM 'origin_twin')` },
  source_chunker_stamp: { kind: 'write', sql: 'UPDATE sources SET chunker_version=$2 WHERE id=$1' },
  // The claim's lease read (journal.ts claimNextWrite) and the incarnation reads (soak-counters.ts, sync-run.ts).
  lease_other_holder: { kind: 'read', sql: `SELECT holder_pid, holder_host FROM gbrain_cycle_locks
        WHERE id=$1::text AND ttl_expires_at>now() AND NOT (holder_pid=$2::integer AND holder_host IS NOT DISTINCT FROM $3::text)` },
  source_incarnation_text: { kind: 'read', sql: 'SELECT incarnation::text AS incarnation FROM sources WHERE id=$1' },
  source_incarnation_plain: { kind: 'read', sql: 'SELECT incarnation::text FROM sources WHERE id=$1' },
  source_trust_config: { kind: 'read', sql: 'SELECT config FROM sources WHERE id = $1' },
  // The wait for in-flight requests, the held rename and the legacy markers (sync-pass-run.ts).
  inflight_open_ids: { kind: 'read', sql: `SELECT r.id FROM persistence_requests r WHERE r.source_id=$1 AND r.state IN ('queued','running','recovering') AND (r.page_id=ANY($2::int[]) OR r.intent->>'sourcePath'=ANY($3::text[]) OR r.intent->>'path'=ANY($3::text[]))` },
  inflight_open_work: { kind: 'read', sql: `SELECT 1 FROM persistence_requests r WHERE r.source_id=$1 AND (r.state IN ('queued','running','recovering') AND (r.page_id=ANY($2::int[]) OR r.intent->>'sourcePath'=ANY($3::text[]) OR r.intent->>'path'=ANY($3::text[]))
        OR EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='git' AND e.state IN ('queued','running')
          AND (r.page_id=ANY($2::int[]) OR r.intent->>'sourcePath'=ANY($3::text[]) OR r.intent->>'path'=ANY($3::text[]) OR e.data->>'relative_path'=ANY($3::text[])))) LIMIT 1` },
  inflight_committed: { kind: 'read', sql: `SELECT id::text AS id, intent->>'kind' AS kind, intent->>'sourcePath' AS source_path,
    intent ? 'renameFrom' AS renamed FROM persistence_requests WHERE id=ANY($1::uuid[]) AND state='committed'` },
  open_inflight_request: { kind: 'read', sql: `SELECT r.id FROM persistence_requests r WHERE r.source_id=$1 AND r.state IN ('queued','running','recovering')
    AND (r.page_id=ANY($2::int[]) OR r.intent->>'sourcePath'=ANY($3::text[])) ORDER BY r.sequence LIMIT 1` },
  legacy_markers_insert: { kind: 'write', sql: `INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
      SELECT $1, row->>'fingerprint', jsonb_build_array(row->'value'), now() FROM jsonb_array_elements($2::text::jsonb) AS row ON CONFLICT (op,fingerprint) DO NOTHING` },
  page_origin_by_id: { kind: 'read', sql: "SELECT source_path, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted, frontmatter->>'id' AS fm_id FROM pages WHERE source_id=$1 AND id=$2" },
  request_by_request_id: { kind: 'read', sql: 'SELECT id FROM persistence_requests WHERE source_id=$1 AND request_id=$2' },
  source_local_path_shared: { kind: 'read', sql: 'SELECT local_path FROM sources WHERE id=$1 FOR SHARE' },
  sync_cursor_fence: { kind: 'read', sql: `SELECT completed_keys->0->>'runId' AS run_id,completed_keys->0->'pending'->>'requestId' AS request_id,completed_keys->0->>'index' AS index,
      (SELECT jsonb_agg(m->>'requestId') FROM (SELECT m FROM jsonb_array_elements(COALESCE(completed_keys->0->'group','[]'::jsonb)) m
        UNION ALL SELECT m FROM jsonb_array_elements(COALESCE(completed_keys->0->'window','[]'::jsonb)) g, jsonb_array_elements(g) m) members) AS group
     FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1 FOR KEY SHARE` },
  // The imported page's origin and the deletion tombstone (sync-prepare.ts, sync-streamed.ts, sync-delete-tombstones.ts).
  page_set_type: { kind: 'write', sql: 'UPDATE pages SET type=$3 WHERE source_id=$1 AND slug=$2' },
  page_clear_unbound: { kind: 'write', sql: "UPDATE pages SET database_only_reason=NULL WHERE source_id=$1 AND slug=$2 AND database_only_reason='unbound_source'" },
  delete_tombstone_record: { kind: 'write', sql: `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
    SELECT $1, p.id::text, jsonb_build_array(jsonb_build_object('source_id', p.source_id, 'incarnation', $2::text, 'page_id', p.id, 'slug', p.slug,
      'source_path', p.source_path, 'pass_id', $3::text, 'run_id', $4::text, 'request_id', $5::text, 'deleted_at', p.deleted_at)), now()
    FROM pages p WHERE p.source_id = $6 AND p.slug = $7 AND p.deleted_at = now()
    ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = now()` },
  // The refresh fence a managed sync checks before discovery (worktree-refresh.ts assertManagedSyncAllowed).
  blocking_refresh: { kind: 'read', sql: `SELECT id,state FROM persistence_worktree_refreshes
    WHERE worktree_id=$1::uuid AND state IN ('draining','fenced','merged','recovery_required')` },
  // The managed sync's run, waiver, cursor-key, window, lane, drain and fold statements (sync-run.ts, sync-waivers.ts,
  // sync-cursor-key.ts, sync-window.ts, sync-lanes.ts, sync-drain.ts, sync-pass-fold.ts, noop-kernel.ts). A Rust brain reaches
  // them only through a company or dry-run cursor, a legacy cursor row a pass retires, a failed entry's hold, a waiver, a
  // stall probe or a folded stamp; the bulk-group and lane sites (Postgres-only) stay on `executeRaw` in sync-run.ts.
  cursor_manifest_insert: { kind: 'write', sql: `INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING` },
  cursor_insert: { kind: 'write', sql: `INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING RETURNING fingerprint` },
  cursor_swap: { kind: 'write', sql: `UPDATE op_checkpoints SET completed_keys=$4::text::jsonb,updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb RETURNING fingerprint` },
  checkpoint_touch: { kind: 'write', sql: 'UPDATE op_checkpoints SET updated_at=now() WHERE op=$1 AND fingerprint=$2' },
  cursor_head_locked: { kind: 'read', sql: `SELECT completed_keys->0->>'runId' AS run_id,
    completed_keys->0->'index' AS index,completed_keys->0->'pending'->>'requestId' AS request_id FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1 FOR UPDATE` },
  pending_intent_held: { kind: 'read', sql: `SELECT completed_keys->0->'pending'->>'requestId' AS request_id,
        completed_keys->0->'pending'->'intent' = $3::text::jsonb AS same FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 FOR SHARE` },
  unfinished_page_request: { kind: 'read', sql: UNFINISHED_PAGE_REQUEST_SQL },
  stale_page_requests: { kind: 'read', sql: `SELECT request_id::text AS request_id FROM persistence_requests WHERE worktree_id=$1::uuid AND intent->>'runId'=$2
        AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND intent->>'index'=$3 AND state IN ('failed','cancelled','conflict')` },
  waiver_settings: { kind: 'read', sql: "SELECT set_config('lock_timeout','2s',true),set_config('statement_timeout','10s',true)" },
  waiver_pages: { kind: 'read', sql: 'SELECT id,slug,deleted_at IS NOT NULL AS deleted,knowledge_revision FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])' },
  kernel_pages_by_slug: { kind: 'read', sql: KERNEL_PAGES_BY_SLUG_SQL },
  kernel_pages_by_slug_unmanifested: { kind: 'read', sql: KERNEL_PAGES_BY_SLUG_UNMANIFESTED_SQL },
  kernel_page_by_id: { kind: 'read', sql: KERNEL_PAGE_BY_ID_SQL },
  kernel_page_by_id_unmanifested: { kind: 'read', sql: KERNEL_PAGE_BY_ID_UNMANIFESTED_SQL },
  finished_cursor_delete: { kind: 'write', sql: `DELETE FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1
    AND COALESCE(completed_keys->0->>'done','false')='true' RETURNING completed_keys->0->>'runId' AS run_id` },
  manifest_delete_unshared: { kind: 'write', sql: `DELETE FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1
    AND NOT EXISTS (SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.completed_keys->0->>'runId'=$1)` },
  prefix_delete: { kind: 'write', sql: 'DELETE FROM op_checkpoints WHERE op=$1 AND left(fingerprint, length($2))=$2' },
  cursor_open_requests: { kind: 'read', sql: `SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'cursorKey'=$2
    AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) ORDER BY sequence` },
  request_for_update: { kind: 'read', sql: 'SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE' },
  group_predecessor: { kind: 'read', sql: `SELECT state, request_id::text AS request_id FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2
      AND sequence<$3 AND intent->>'group'=$4 ORDER BY sequence DESC LIMIT 1` },
  request_state_by_principal: { kind: 'read', sql: 'SELECT state FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid' },
  stall_probe: { kind: 'read', sql: `SELECT r.state, r.blocked_reason, r.recovery IS NOT NULL AS recovering, r.worktree_id::text,
         h.id::text AS head_id, h.state AS head_state, h.claim_phase AS head_claim_phase, h.execution_token::text AS head_token,
         (h.claim_expires_at IS NOT NULL AND h.claim_expires_at < now()) AS head_lapsed, h.intent->>'kind' AS head_kind, w.owner_host_id::text
       FROM persistence_requests r
       LEFT JOIN persistence_worktrees w ON w.id = r.worktree_id
       LEFT JOIN LATERAL (SELECT e.id, e.state, e.claim_phase, e.execution_token, e.claim_expires_at, e.intent FROM persistence_requests e WHERE e.worktree_id = r.worktree_id
         AND (e.state IN ('queued','running','recovering') OR e.recovery IS NOT NULL) ORDER BY e.sequence LIMIT 1) h ON r.worktree_id IS NOT NULL
       WHERE r.id = $1::uuid` },
  refused_checkpoint: { kind: 'read', sql: REFUSED_CHECKPOINT_SQL },
} as const satisfies Record<string, SyncStatement>;

export type SyncStatementName = keyof typeof SYNC_STATEMENTS;

/** The bounds `executeRaw` takes beside its parameters. */
export interface SyncStatementOptions { signal?: AbortSignal; timeoutMs?: number; deadlineAt?: number; jitOff?: boolean; prepare?: boolean;
  /** The caller's host fence (a multi-user Rust brain): the cursor statements that take, check or end a sync checkpoint claim run under it. PGLite and Postgres ignore it (`runSyncStatement` passes only the bounds to `executeRaw`). */
  fence?: LeaseToken }

/** `runSyncStatement`: the statement's text on the engine's own `executeRaw`. */
export function runSyncStatement<R>(raw: Pick<BrainEngine, 'executeRaw'>, name: SyncStatementName, params: readonly unknown[] = [], opts?: SyncStatementOptions): Promise<R[]> {
  // The host fence belongs to the Rust store's checkpoint claims; the SQL engines get only the bounds they always got.
  if (opts?.fence === undefined) return raw.executeRaw<R>(SYNC_STATEMENTS[name].sql, [...params], opts);
  const { fence: _fence, ...bounds } = opts;
  return raw.executeRaw<R>(SYNC_STATEMENTS[name].sql, [...params], bounds);
}

/** An engine that serves `runSyncStatement`, or an `executeRaw`-only view of one. */
export type SyncExec = Pick<BrainEngine, 'executeRaw'> & Partial<Pick<BrainEngine, 'kind' | 'runSyncStatement'>>;

/**
 * The rows of the named statement. A Rust brain answers by name from its records; every other engine, and every view of one that
 * overrides `executeRaw` (a statement fault a test injects, the preparation's config view, the import reads' batch), sends the
 * statement's text over `executeRaw`, exactly as the caller sent it before the text moved here.
 */
export function syncRows<R = Record<string, unknown>>(exec: SyncExec, name: SyncStatementName, params: readonly unknown[] = [], opts?: SyncStatementOptions): Promise<R[]> {
  return exec.kind === 'rust' && typeof exec.runSyncStatement === 'function' ? exec.runSyncStatement<R>(name, params, opts) : runSyncStatement<R>(exec, name, params, opts);
}
