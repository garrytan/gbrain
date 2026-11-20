/**
 * Reads and writes of the decision, OAuth, feedback, question and credential tables that callers once ran through
 * `executeRaw`, as typed members: SQL once for both SQL engines, so a store that is not SQL serves the same members
 * (rust/docs/store). Each statement keeps the text its caller ran, and each listing breaks ties by byte
 * (`COLLATE "C"`), as the Rust store does.
 */
import type { BrainEngine } from '../engine.ts';
import { isMissingSchemaObject } from '../utils.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One OAuth client that references a source through `oauth_clients.source_id`; `deleted` marks a soft-deleted row. */
export interface SourceClientReferentRow {
  clientId: string;
  clientName: string;
  deleted: boolean;
}

/** The statements destructive-guard.ts clientsReferencingSource ran through executeRaw: the whole read, then the read of a brain without `deleted_at`. */
export const CLIENTS_REFERENCING_SOURCE_SQL = {
  primary: `SELECT client_id, client_name, (deleted_at IS NOT NULL) AS deleted
       FROM oauth_clients
       WHERE source_id = $1
       ORDER BY client_id COLLATE "C"`,
  without_deleted_at: `SELECT client_id, client_name FROM oauth_clients
         WHERE source_id = $1
         ORDER BY client_id COLLATE "C"`,
} as const;

/**
 * Every OAuth client that references `sourceId`, by client id in byte order. The reference is PHYSICAL (ON DELETE
 * RESTRICT), so soft-deleted rows are returned too, tagged `deleted`. A brain without the `oauth_clients` table, or
 * without its `source_id` column, has no referents (no column, no foreign key); a brain without `deleted_at` reads every
 * referent as live. Any other failure is thrown unchanged.
 */
export async function listClientsReferencingSource(tx: Raw, sourceId: string): Promise<SourceClientReferentRow[]> {
  try {
    const rows = await tx.executeRaw<{ client_id: string; client_name: string; deleted: boolean }>(CLIENTS_REFERENCING_SOURCE_SQL.primary, [sourceId]);
    return rows.map((r) => ({ clientId: r.client_id, clientName: r.client_name, deleted: r.deleted === true }));
  } catch (e) {
    if (isMissingSchemaObject(e, 'table', 'oauth_clients')) return [];
    // The primary query references BOTH optional columns; the strict predicate tells them apart by the column the error names.
    if (isMissingSchemaObject(e, 'column', 'source_id')) return [];
    if (!isMissingSchemaObject(e, 'column', 'deleted_at')) throw e;
    try {
      const rows = await tx.executeRaw<{ client_id: string; client_name: string }>(CLIENTS_REFERENCING_SOURCE_SQL.without_deleted_at, [sourceId]);
      return rows.map((r) => ({ clientId: r.client_id, clientName: r.client_name, deleted: false }));
    } catch (e2) {
      // The fallback's only optional column is source_id: no column, no foreign key.
      if (isMissingSchemaObject(e2, 'column', 'source_id')) return [];
      throw e2;
    }
  }
}
