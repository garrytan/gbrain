/**
 * The statements `gbrain trust scan` (eligibility/scan.ts) ran through `executeRaw`: SQL once for both engines, so a
 * store that is not SQL serves the same members (rust/docs/store/trust.md, "Trust scan state").
 *
 * - `readTrustScanCursor` / `writeTrustScanCursor`: the scan's resumable cursor, the `op_checkpoints` row
 *   (`trust_scan`, `v1`). The texts are the ones scan.ts ran. They are not lane 9's `readOpCheckpointKeys` /
 *   `writeOpCheckpointKeys` (engine-sql/write-misc.ts, op-checkpoint.ts): those read the child paths too, return
 *   strings, and stamp `updated_at` in the insert. A Rust brain keeps the row under the same store key as those
 *   members (rust/crates/gbrain-store/src/persistence/trust_scan_cursor.rs).
 * - `listClaimPendingSourceIds`: the claimed sources whose lift has not finished (trust/claim-state.ts), which the
 *   scan refuses to run past. Ordered by `s.id COLLATE "C"` (bytes): scan.ts ran a bare `ORDER BY s.id`,
 *   which a database with a linguistic collation (en_US) ordered past hyphens, unlike PGLite and the Rust store.
 * - `readTrustScanCeilings`: each scanned table's max id, the ceiling a first run records when the write gate has no
 *   baseline for the current detector.
 *
 * Every function takes the engine (or transaction) it runs on.
 */
import type { BrainEngine } from '../engine.ts';
import { claimPendingSql } from '../trust/claim-state.ts';
import type { TrustScanTable } from './trust-tier-reads.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The `op_checkpoints` key of the trust scan's cursor. */
export const TRUST_SCAN_CHECKPOINT = { op: 'trust_scan', fingerprint: 'v1' } as const;

/** The tables the trust scan reads, in scan order. */
export const TRUST_SCAN_TABLES: readonly TrustScanTable[] = ['pages', 'facts', 'takes', 'timeline_entries'];

export const READ_TRUST_SCAN_CURSOR_SQL = 'SELECT completed_keys AS keys FROM op_checkpoints WHERE op = $1 AND fingerprint = $2';

export const WRITE_TRUST_SCAN_CURSOR_SQL = `INSERT INTO op_checkpoints(op, fingerprint, completed_keys) VALUES ($1, $2, $3::text::jsonb)
    ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = now()`;

export const LIST_CLAIM_PENDING_SOURCE_IDS_SQL = `SELECT s.id FROM sources s WHERE ${claimPendingSql('s')} ORDER BY s.id COLLATE "C"`;

/** `SELECT max(id) AS n FROM <table>` for one scanned table. */
export function trustScanCeilingSql(table: TrustScanTable): string {
  if (!TRUST_SCAN_TABLES.includes(table)) throw new Error(`trust scan: unknown table ${String(table)}`);
  return `SELECT max(id) AS n FROM ${table}`;
}

/** The cursor row's `completed_keys` (parsed when the driver returns text), or null when the scan has no cursor. */
export async function readTrustScanCursor(tx: Raw): Promise<unknown> {
  const [row] = await tx.executeRaw<{ keys: unknown }>(READ_TRUST_SCAN_CURSOR_SQL, [TRUST_SCAN_CHECKPOINT.op, TRUST_SCAN_CHECKPOINT.fingerprint]);
  if (!row) return null;
  return typeof row.keys === 'string' ? JSON.parse(row.keys) as unknown : row.keys ?? null;
}

/**
 * Replaces the cursor row's `completed_keys` with `completedKeys` and stamps it now. Binds through
 * `$3::text::jsonb`, never `$3::jsonb` (the CLAUDE.md double-encode rule).
 */
export async function writeTrustScanCursor(tx: Raw, completedKeys: readonly unknown[]): Promise<void> {
  await tx.executeRaw(WRITE_TRUST_SCAN_CURSOR_SQL, [TRUST_SCAN_CHECKPOINT.op, TRUST_SCAN_CHECKPOINT.fingerprint, JSON.stringify(completedKeys)]);
}

/** The ids of the claimed sources whose lift has not finished, by id. */
export async function listClaimPendingSourceIds(tx: Raw): Promise<string[]> {
  const rows = await tx.executeRaw<{ id: string }>(LIST_CLAIM_PENDING_SOURCE_IDS_SQL);
  return rows.map(r => r.id);
}

/** Each scanned table's max id; 0 for an empty table. */
export async function readTrustScanCeilings(tx: Raw): Promise<Record<TrustScanTable, number>> {
  const out = {} as Record<TrustScanTable, number>;
  for (const table of TRUST_SCAN_TABLES) {
    const [row] = await tx.executeRaw<{ n: number | string | null }>(trustScanCeilingSql(table));
    out[table] = Number(row?.n ?? 0);
  }
  return out;
}
