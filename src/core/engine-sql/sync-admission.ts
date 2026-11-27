/**
 * The `sync.admission` statements (persistence/sync-admission.ts), each byte for byte the statement its caller sent
 * before it became a member (pinned by test/engine-sql-caller-raw-sql-pins.test.ts):
 *  - `writeSyncAdmissionStamp`: the `op_checkpoints` row that dates a local `config set sync.admission`
 *    (`writeSyncAdmission`, inside its transaction after the config write);
 *  - `readSyncAdmissionEffects`: `sync status`'s two `effective` probes of a restricted value (`syncAdmissionStatus`).
 * Each runs on the engine's own `executeRaw`, so inside `transaction()` it runs on the transaction's connection. A Rust
 * brain serves both from its store (rust/crates/gbrain-store/src/persistence/sync_run_reads.rs).
 */
import type { BrainEngine } from '../engine.ts';
import { syncAdmissionEffectsSql } from '../persistence/sync-admission-sql.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The binds of `sync status`'s `effective` probes: the drain lease, the pass row, `set_at` (null when unknown) and the source incarnation's destructive kinds. */
export interface SyncAdmissionEffectsInput {
  lockId: string; passOp: string; passKey: string; setAt: string | null; sourceId: string; incarnation: string; kinds: readonly string[];
}

/** The checkpoint parent `(op, fingerprint)` set to `[{value, set_at}]` with `set_at` the database clock; returns `set_at` as stored (jsonb text). */
export async function writeSyncAdmissionStamp(raw: Raw, op: string, fingerprint: string, value: string): Promise<string> {
  const [row] = await raw.executeRaw<{ set_at: string }>(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('value',$3::text,'set_at',clock_timestamp())),now())
      ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()
      RETURNING completed_keys->0->>'set_at' AS set_at`, [op, fingerprint, value]);
  return row!.set_at;
}

/** Whether a pass pinned before `setAt` holds the lease (`pinned`) and whether a destructive request admitted before it is unpublished (`destructive`). */
export async function readSyncAdmissionEffects(raw: Raw, input: SyncAdmissionEffectsInput): Promise<{ pinned: boolean; destructive: boolean }> {
  const [row] = await raw.executeRaw<{ pinned: boolean; destructive: boolean }>(syncAdmissionEffectsSql(),
    [input.lockId, input.passOp, input.passKey, input.setAt, input.sourceId, input.incarnation, [...input.kinds]]);
  return { pinned: row!.pinned, destructive: row!.destructive };
}
