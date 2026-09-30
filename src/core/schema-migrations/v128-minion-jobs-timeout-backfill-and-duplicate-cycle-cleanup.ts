import type { Migration } from './types.ts';

export const v128: Migration = {
  version: 128,
  name: 'minion_jobs_timeout_backfill_and_duplicate_cycle_cleanup',
  // Jobs fix wave (upstream issues #2/#3) — two one-shot repairs for rows
  // that predate the fixes shipping alongside this migration:
  //
  // 1. HANDLER_DEFAULT_TIMEOUT_MS backfill. Submit-time stamping (#1737)
  //    never touched already-queued rows, so their timeout_ms = NULL fell
  //    to the minutes-scale null-default wall-clock sweep and long handlers
  //    were dead-lettered mid-progress. Values are SNAPSHOTTED at authoring
  //    time — deliberately NOT generated from the live map, so every brain
  //    applies identical SQL under this version number; the claim-time
  //    COALESCE in MinionQueue.claim owns all future drift. Do NOT sync
  //    this list when handler-timeouts.ts changes. No timeout_at stamp for
  //    already-active rows: that would arm the tighter 1x handleTimeouts
  //    kill mid-flight; the 2x wall-clock bound (via non-NULL timeout_ms)
  //    is the gentler, sufficient repair, and every future claim stamps
  //    timeout_at correctly.
  //
  // 2. Duplicate autopilot-cycle backlog cleanup. The slot-scoped dispatch
  //    guards accumulated byte-identical waiting cycles when a job stalled
  //    in 'active' (unbounded — one observed brain held ~111). Cancel all
  //    but the newest waiting row per (name, queue, source scope),
  //    restricted to ticker-keyed rows (idempotency-key prefix heuristic:
  //    manually submitted cycles carry no key unless the operator passes
  //    one; mimicking the ticker prefix opts into ticker dedup semantics)
  //    AND to rows without a camelCase data.sourceId — the ticker only
  //    ever writes snake_case source_id, so a sourceId row is by
  //    definition not ticker-provenance and must never be swept
  //    (adversarial-review tightening: prevents distinct sourceId scopes
  //    collapsing into the empty source_id group).
  //    Rows are preserved as 'cancelled' for audit; their idempotency keys
  //    free naturally via the dead/cancelled key-NULLing rule in add().
  //    Leaves <=1 waiting (+ possibly 1 active) per scope — converges to
  //    single-flight within one wall-clock window; the maxPending guard
  //    (shipped with this wave) prevents new accumulation.
  //
  // Non-terminal status set + row-lock race-safety per the v15 precedent
  // (serializes against claim()'s FOR UPDATE SKIP LOCKED). Idempotent:
  // statement 1 re-runs match zero rows (timeout_ms IS NULL guard);
  // statement 2 re-runs keep only survivors.
  idempotent: true,
  sql: `
      UPDATE minion_jobs
         SET timeout_ms = CASE name
               WHEN 'subagent'                     THEN 1800000
               WHEN 'subagent_aggregator'          THEN 1800000
               WHEN 'embed-backfill'               THEN 1800000
               WHEN 'autopilot-cycle'              THEN 1800000
               WHEN 'autopilot-global-maintenance' THEN 1800000
               WHEN 'chronicle_extract'            THEN 600000
               WHEN 'facts-absorb'                 THEN 600000
               WHEN 'contextual_reindex_per_chunk' THEN 3600000
             END,
             updated_at = now()
       WHERE timeout_ms IS NULL
         AND status IN ('waiting','active','delayed','waiting-children','paused')
         AND name IN ('subagent','subagent_aggregator','embed-backfill',
                      'autopilot-cycle','autopilot-global-maintenance',
                      'chronicle_extract','facts-absorb',
                      'contextual_reindex_per_chunk');

      UPDATE minion_jobs
         SET status = 'cancelled',
             finished_at = now(),
             updated_at = now(),
             error_text = 'v128: superseded duplicate autopilot cycle'
       WHERE status = 'waiting' AND parent_job_id IS NULL
         AND name IN ('autopilot-cycle','autopilot-global-maintenance')
         AND (idempotency_key LIKE 'autopilot-cycle:%' OR idempotency_key LIKE 'autopilot-global:%')
         AND data->>'sourceId' IS NULL
         AND id NOT IN (
           SELECT id FROM (
             SELECT DISTINCT ON (name, queue, COALESCE(data->>'source_id','')) id
             FROM minion_jobs
             WHERE status = 'waiting' AND parent_job_id IS NULL
               AND name IN ('autopilot-cycle','autopilot-global-maintenance')
               AND (idempotency_key LIKE 'autopilot-cycle:%' OR idempotency_key LIKE 'autopilot-global:%')
               AND data->>'sourceId' IS NULL
             ORDER BY name, queue, COALESCE(data->>'source_id',''), created_at DESC, id DESC
           ) keep
         );
    `,
};
