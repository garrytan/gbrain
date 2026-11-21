/**
 * The statements of src/core/engine-sql/doctor-sync.ts keep the exact text the sync readers built inline.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the five orphan statements spliced the fragments `managed-sync-orphans.ts` still composes for its
 *    retirement re-check (`checkpointMovedSql`, `slugModeRefusedSql`, `passSlugModeRefusedSql`, `passStampSql`); each
 *    inlined text equals the text those fragments compose, so the classification and the retirement read one rule.
 *    The cursor-failure statement equals the one `readManagedSyncFailures` ran. No member lists a name the engine lacks.
 *  - Regression: a drifted inlined predicate changes which cursors and failure rows doctor reports as orphans on PGLite and Postgres.
 *  - Why existing coverage misses it: the parity cases compare engines on an empty brain, not the text against the old builder.
 *  - Seam: none (pure).
 */
import { describe, expect, test } from 'bun:test';
import { DOCTOR_SYNC_MEMBERS, DOCTOR_SYNC_STATEMENTS } from '../src/core/engine-sql/doctor-sync.ts';
import { checkpointMovedSql, passSlugModeRefusedSql, passStampSql, slugModeRefusedSql } from '../src/core/persistence/managed-sync-orphans.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';

/** Widened so `toBe` compares with the composed text, not the literal type of the constant. */
const STATEMENTS: Record<string, string> = DOCTOR_SYNC_STATEMENTS;

describe('doctor sync SQL text', () => {
  test('cursorFailureRows: the statement its reader composed', () => {
    expect(STATEMENTS.cursorFailureRows).toBe(`
    SELECT c.fingerprint AS cursor_key,jsonb_build_object('sourceId',s.id,'incarnation',s.incarnation,'runId',c.completed_keys->0->>'runId',
      'index',c.completed_keys->0->'index','target',c.completed_keys->0->>'target',
      'syncOptions',c.completed_keys->0->'syncOptions','processingOptions',c.completed_keys->0->'processingOptions',
      'pending',jsonb_build_object('requestId',c.completed_keys->0->'pending'->>'requestId')) AS value,
      CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('state',r.state,'request_id',r.request_id,'error_code',r.error_code,'error_message',r.error_message,'error_detail',r.error_detail) END AS receipt,
      f.completed_keys->0 AS failure,m.completed_keys->((c.completed_keys->0->>'index')::int)->>'path' AS path,c.updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text=c.completed_keys->0->>'incarnation'
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
      AND r.principal_id=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
      AND r.principal_kind=c.completed_keys->0->'authority'->'writer'->'principal'->>'kind'
    LEFT JOIN op_checkpoints f ON f.op='managed-sync-failure' AND f.fingerprint=c.fingerprint
    LEFT JOIN op_checkpoints m ON m.op='managed-sync-manifest' AND m.fingerprint=c.completed_keys->0->>'runId'
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))`);
  });

  test('orphanCursors: the statement its reader composed', () => {
    expect(STATEMENTS.orphanCursors).toBe(`
    SELECT c.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,c.completed_keys->0->>'runId' AS run_id,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' AS principal_kind,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AS principal_id,
      (c.completed_keys->0 ? 'syncOptions') AS has_sync_options,
      c.completed_keys->0->'pending'->>'requestId' AS pending_request_id,r.state AS pending_state,
      EXISTS(SELECT 1 FROM persistence_local_writers w WHERE w.revoked_at IS NULL
        AND w.id::text=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
        AND c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' IN ('local_cli','local_stdio')) AS principal_live,
      EXISTS(SELECT 1 FROM op_checkpoints n WHERE n.op='managed-sync' AND n.fingerprint<>c.fingerprint
        AND n.completed_keys->0->>'sourceId'=s.id AND n.completed_keys->0->>'incarnation'=s.incarnation::text
        AND COALESCE(n.completed_keys->0->>'done','false')='true' AND n.updated_at>c.updated_at) AS superseded,
      ${checkpointMovedSql('$2')} AS checkpoint_moved,
      ${slugModeRefusedSql} AS slug_mode_refused,
      to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text=c.completed_keys->0->>'incarnation' AND NOT COALESCE(s.archived,false)
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.source_incarnation=s.incarnation
      AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
      AND r.principal_id=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
      AND r.principal_kind=c.completed_keys->0->'authority'->'writer'->'principal'->>'kind'
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
    ORDER BY s.id COLLATE "C",c.updated_at,c.fingerprint COLLATE "C"`);
  });

  test('orphanFailures: the statement its reader composed', () => {
    expect(STATEMENTS.orphanFailures).toBe(`
    SELECT f.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,f.completed_keys->0->>'run_id' AS run_id,
      f.completed_keys->0->>'request_id' AS request_id,to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text=f.completed_keys->0->>'source_incarnation' AND NOT COALESCE(s.archived,false)
    WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op IN ('managed-sync','managed-sync-pass') AND c.fingerprint=f.fingerprint)
    ORDER BY s.id COLLATE "C",f.fingerprint COLLATE "C"`);
  });

  test('orphanPasses: the statement its reader composed', () => {
    expect(STATEMENTS.orphanPasses).toBe(`
    SELECT p.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,p.completed_keys->0->'telemetry'->>'pass_id' AS run_id,
      ${passStampSql}::text AS request_id,(SELECT m.state FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=${passStampSql}) AS state,
      to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints p
    JOIN sources s ON p.fingerprint=s.id||':'||s.incarnation::text AND NOT COALESCE(s.archived,false)
    WHERE p.op='managed-sync-pass' AND ($1::text[] IS NULL OR s.id=ANY($1::text[])) AND ${passSlugModeRefusedSql(passStampSql)}
    ORDER BY s.id COLLATE "C"`);
  });

  test('orphanRetiredCursors: the statement its reader composed', () => {
    expect(STATEMENTS.orphanRetiredCursors).toBe(`
    SELECT c.fingerprint AS cursor_key,s.id AS source_id,c.completed_keys->0->>'incarnation' AS source_incarnation,c.completed_keys->0->>'runId' AS run_id,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' AS principal_kind,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AS principal_id,
      c.completed_keys->0->'pending'->>'requestId' AS pending_request_id,r.state AS pending_state,
      to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text<>c.completed_keys->0->>'incarnation' AND NOT COALESCE(s.archived,false)
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
    ORDER BY s.id COLLATE "C",c.updated_at,c.fingerprint COLLATE "C"`);
  });

  test('orphanRetiredFailures: the statement its reader composed', () => {
    expect(STATEMENTS.orphanRetiredFailures).toBe(`
    SELECT f.fingerprint AS cursor_key,s.id AS source_id,f.completed_keys->0->>'source_incarnation' AS source_incarnation,f.completed_keys->0->>'run_id' AS run_id,
      f.completed_keys->0->>'request_id' AS request_id,to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text<>f.completed_keys->0->>'source_incarnation' AND NOT COALESCE(s.archived,false)
    WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint AND COALESCE(c.completed_keys->0->>'done','false')<>'true')
    ORDER BY s.id COLLATE "C",f.fingerprint COLLATE "C"`);
  });

  test('every listed member is a classified engine member, once', () => {
    expect(new Set(DOCTOR_SYNC_MEMBERS).size).toBe(DOCTOR_SYNC_MEMBERS.length);
    for (const member of DOCTOR_SYNC_MEMBERS) expect(Object.keys(RUST_ENGINE_MEMBERS)).toContain(member);
  });
});
