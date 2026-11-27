/**
 * The Git sync hold retry request (persistence/sync-holds.ts requestGitHoldRetry), as an engine member so the Rust engine
 * can serve it. The hold rows and summary counters themselves are the hold store's (engine-sql/sync-hold-store.ts). The
 * Rust store applies the request as one write (rust/crates/gbrain-store/src/persistence/git_holds.rs;
 * rust/docs/store/repair-bookkeeping.md, "Git holds").
 */
import type { BrainEngine } from '../engine.ts';
import { GIT_HOLD_RETRY_OP } from './sync-hold-reads.ts';
import { summaryFingerprint } from './sync-hold-store.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

/**
 * `sources retry-held` on a Git source: adds `paths` to the source's retry request, without duplicates and in byte order,
 * stamped `requestedAt`.
 */
export async function requestGitHoldRetry(tx: Exec, sourceId: string, incarnation: string, paths: readonly string[], requestedAt: string): Promise<void> {
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('version',1,'source_id',$3::text,'incarnation',$5::text,
        'paths',(SELECT COALESCE(jsonb_agg(p ORDER BY p COLLATE "C"),'[]'::jsonb) FROM (SELECT DISTINCT jsonb_array_elements_text($4::text::jsonb) AS p) paths),
        'requested_at',$6::text)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array(jsonb_build_object('version',1,'source_id',$3::text,'incarnation',$5::text,
      'paths',(SELECT COALESCE(jsonb_agg(p ORDER BY p COLLATE "C"),'[]'::jsonb) FROM (
        SELECT jsonb_array_elements_text(COALESCE(op_checkpoints.completed_keys->0->'paths','[]'::jsonb)) AS p
        UNION SELECT jsonb_array_elements_text($4::text::jsonb)) paths),
      'requested_at',$6::text)),updated_at=now()`,
  [GIT_HOLD_RETRY_OP, summaryFingerprint(sourceId, incarnation), sourceId, JSON.stringify(paths), incarnation, requestedAt]);
}
