/**
 * The connector sync attempt stamp (src/core/persistence/connector-state.ts `recordConnectorSyncAttempt`): the
 * source's incarnation read and the upsert that stamps `first_attempt_at` on its managed connector state row once.
 * The statements are the caller's, byte for byte, and both SQL engines run them through their own `executeRaw`. The
 * Rust store applies the same write in one store transaction (rust/crates/gbrain-store/src/persistence/connector_attempts.rs).
 */
import type { BrainEngine } from '../engine.ts';
import { digest } from '../persistence/digest.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The op_checkpoints op of a source incarnation's managed connector state row (connector-state.ts re-exports it). */
export const CONNECTOR_STATE_OP = 'managed-connector-state';

/** The state row's fingerprint: `digest({ sourceId, incarnation })` (connector-state.ts re-exports it). */
export function connectorStateKey(sourceId: string, incarnation: string): string {
  return digest({ sourceId, incarnation });
}

/**
 * Stamps the source's first sync attempt once: a new row holds `seed`, and an existing row whose first record has no
 * `first_attempt_at` gets `at` there, every other field kept. False when the source does not exist.
 */
export async function recordConnectorSyncAttempt(raw: Raw, sourceId: string, at: string, seed: readonly unknown[]): Promise<boolean> {
  const [source] = await raw.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  if (!source) return false;
  await raw.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_set(op_checkpoints.completed_keys, ARRAY['0','first_attempt_at'], to_jsonb($4::text), true), updated_at=now()
    WHERE op_checkpoints.completed_keys->0->>'first_attempt_at' IS NULL`,
  [CONNECTOR_STATE_OP, connectorStateKey(sourceId, source.incarnation), JSON.stringify(seed), at]);
  return true;
}
