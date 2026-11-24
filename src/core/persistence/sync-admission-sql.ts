/**
 * The text of `sync status`'s two `effective` probes of a restricted `sync.admission` (persistence/sync-admission.ts):
 * a pass pinned before `set_at` still holding the lease, and a destructive request admitted before `set_at` still
 * unpublished. `effectProbes` names the expressions they read, binds or columns of an enclosing read; sync-admission.ts
 * folds them into the status read (`syncAdmissionEffectSql`), and `syncAdmissionEffectsSql` is the standalone statement
 * engine-sql/sync-admission.ts `readSyncAdmissionEffects` sends, byte for byte the one syncAdmissionStatus sent before
 * it became a member (test/engine-sql-caller-raw-sql-pins.test.ts). This leaf imports nothing, so the engines bind it
 * without loading the persistence graph. Registered as a vetted builder in scripts/check-engine-sql-dynamic.ts.
 */

/** `effective`'s two probes as SQL: `e` names the expressions they read (binds, or columns of an enclosing read). */
export function effectProbes(e: { lock: string; passOp: string; passKey: string; setAt: string; sourceId: string; incarnation: string; kinds: string }) {
  return {
    pinned: `EXISTS (SELECT 1 FROM op_checkpoints p JOIN gbrain_cycle_locks l ON l.id=${e.lock} AND l.ttl_expires_at > now()
          AND l.acquisition_token::text = p.completed_keys->0->>'lease_token'
        WHERE p.op=${e.passOp} AND p.fingerprint=${e.passKey} AND p.completed_keys->0->'telemetry'->>'outcome'='open'
          AND (${e.setAt} IS NULL OR (p.completed_keys->0->'telemetry'->>'started_at')::timestamptz < ${e.setAt}))`,
    destructive: `EXISTS (SELECT 1 FROM persistence_requests r WHERE r.source_id=${e.sourceId} AND r.source_incarnation=${e.incarnation}
          AND r.state IN ('queued','running','recovering') AND r.intent->>'kind' = ANY(${e.kinds})
          AND (${e.setAt} IS NULL OR r.created_at < ${e.setAt}))`,
  };
}

/**
 * The standalone probe statement: `$1` lock id, `$2` pass op, `$3` pass fingerprint, `$4` set_at (timestamptz or
 * NULL), `$5` source id, `$6` incarnation (uuid), `$7` the destructive kinds (text[]), all bound by the caller.
 */
export function syncAdmissionEffectsSql(): string {
  const probes = effectProbes({ lock: '$1', passOp: '$2', passKey: '$3', setAt: '$4::timestamptz', sourceId: '$5', incarnation: '$6::uuid', kinds: '$7::text[]' });
  return `SELECT ${probes.pinned} AS pinned, ${probes.destructive} AS destructive`;
}
