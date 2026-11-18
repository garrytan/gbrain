/**
 * The decide store (src/core/ai/decide/store.ts): `decide_state` (internal key/value state), `decide_spend` (the
 * third-party spend ledger), `decision_receipts` (one row per decision, aggregate-only reads) and `decide_calibrations`
 * (the qualification runs). SQL once for both engines, so a store that is not SQL serves the same members
 * (rust/docs/store/decide-store.md).
 *
 * Every function takes the engine (or transaction) it runs on. Rows come back typed: counts and sums as numbers,
 * timestamps as `Date`s. The 60 s daily-spend cache, the buffered writers and the salt cache stay in store.ts.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

// ---------------------------------------------------------------- state

/** The value kept under `key`, or null when there is none. */
export async function readDecideState(tx: Raw, key: string): Promise<string | null> {
  const rows = await tx.executeRaw<{ value: string }>('SELECT value FROM decide_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

/** Keep `value` under `key`, replacing an earlier value and stamping the write. */
export async function upsertDecideState(tx: Raw, key: string, value: string): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO decide_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

/** Forget `key` (nothing happens when it is absent). */
export async function deleteDecideState(tx: Raw, key: string): Promise<void> {
  await tx.executeRaw('DELETE FROM decide_state WHERE key = $1', [key]);
}

/**
 * Keep `value` under `key` only when nothing is there yet, then answer what is stored (so concurrent callers agree on
 * one value). Null only when the stored value cannot be read back.
 */
export async function ensureDecideState(tx: Raw, key: string, value: string): Promise<string | null> {
  await tx.executeRaw('INSERT INTO decide_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
  return readDecideState(tx, key);
}
