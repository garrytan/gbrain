/**
 * The single-source sync routing read src/core/sync-dispatch-read.ts ran through `executeRaw` (Rust engine lane 11).
 * The statement text is the caller's, byte for byte (test/engine-sql-caller-raw-sql-pins.test.ts), with
 * `MANAGED_MODE_SQL` (engine-sql/persistence-state.ts) written out, so PGLite and Postgres answer exactly as before.
 * The Rust engine builds the same row from its source members (src/core/rust-engine/store-members/cli-reads-import.ts).
 */

/** The engine's own executeRaw, so a statement a test counts or fails on the engine reaches the routing read. */
export interface DispatchRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

export interface SyncDispatchRow {
  /** Null when no source has the id. */
  id: string | null; archived: boolean | null; config: unknown; incarnation: string | null; local_path: string | null;
  claimed: boolean; company_receipt: boolean;
  /** `enabled` of every row `MANAGED_MODE_SQL` returns. */
  modes: unknown[];
}

/** $1 the source id. One row always: the source's columns are null when no source has the id. */
export const SYNC_DISPATCH_SQL = `SELECT s.id, s.archived, s.config, s.incarnation::text AS incarnation, s.local_path,
  EXISTS(SELECT 1 FROM persistence_source_bindings b WHERE b.source_id=s.id AND b.source_incarnation=s.incarnation) AS claimed,
  EXISTS(SELECT 1 FROM source_ingestion_receipts r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.profile='company-brain') AS company_receipt,
  (SELECT COALESCE(jsonb_agg(m.enabled), '[]'::jsonb) FROM (SELECT enabled FROM persistence_brain WHERE singleton=1) m) AS modes
  FROM (SELECT $1::text AS want) w LEFT JOIN sources s ON s.id=w.want`;

/** The routing row of `sourceId`: the source row, its claim and company-brain receipt, and the brain's persistence mode. */
export async function readSyncDispatchRow(exec: DispatchRead, sourceId: string): Promise<SyncDispatchRow | undefined> {
  const rows = await exec.executeRaw<SyncDispatchRow>(SYNC_DISPATCH_SQL, [sourceId]);
  return rows[0];
}
