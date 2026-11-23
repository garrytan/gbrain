/**
 * `gbrain auth clients`'s client listing, split out of commands/auth.ts (which re-exports it) to keep that file under
 * its size ceiling: the listOauthClients member (one read of whole rows, on PGLite, Postgres and a Rust brain), narrowed
 * to the columns the listing shows.
 */
import type { BrainEngine } from '../core/engine.ts';
import { readSharedFromColumns } from '../core/grants/model.ts';
import type { ClientRow } from './auth.ts';

/** The columns a brain from before them leaves out of the row rather than reading as null. */
const OPTIONAL_COLUMNS = ['allowed_operations', 'deleted_at', 'private_pages', 'private_facts'] as const;

/**
 * The listing's rows: the columns of `ClientRow` out of each client's whole row. A brain from before a column returns
 * rows without it, so the surface and source-scoping columns read as null there and the optional ones (operation
 * snapshot, soft-revoke stamp, private pages, private facts) stay absent, which is what each caller already reads as
 * "the brain predates this" (`unavailable` operations, no private axis). The secret hash and the other columns of the
 * whole row go no further. Exported for the unit suite.
 */
export async function listClientRows(engine: BrainEngine): Promise<ClientRow[]> {
  const rows = await engine.listOauthClients();
  return rows.map((full) => {
    const r = full as unknown as Record<string, unknown>;
    const row: ClientRow = {
      client_id: full.client_id,
      client_name: full.client_name,
      scope: full.scope,
      surface: full.surface ?? null,
      surface_set_by: full.surface_set_by ?? null,
      source_id: full.source_id ?? null,
      federated_read: full.federated_read ?? null,
    };
    for (const column of OPTIONAL_COLUMNS) if (column in r) (row as unknown as Record<string, unknown>)[column] = r[column];
    // The shared-source read grant stands only while its stamp is the client's current grant revision.
    row.read_shared = readSharedFromColumns(r.read_shared_revision, r.grant_revision);
    return row;
  });
}
