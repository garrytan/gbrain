/**
 * `gbrain auth clients`'s client listing, split out of commands/auth.ts (which re-exports it) to keep that file under
 * its size ceiling: one SELECT on a current brain, a ladder of narrower projections on a brain from before each column.
 */
import type { BrainEngine } from '../core/engine.ts';
import { isMissingSchemaObject } from '../core/utils.ts';
import type { ClientRow } from './auth.ts';

/**
 * Projection-widened client listing with a degrade ladder for pre-migration
 * brains: full shape (scope + surface + source-scoping columns) → source
 * columns without surface → the bare original triple. Drops the NEWEST
 * columns first; missing columns render as null. Only schema-shape errors
 * (undefined column/table) degrade — anything else (dropped connection,
 * permission) rethrows instead of silently narrowing the listing. One round
 * trip on a current brain (the widen adds columns, not queries). Exported
 * for the unit suite.
 */
export async function listClientRows(engine: BrainEngine): Promise<ClientRow[]> {
  // The columns each degrade tier drops; any other missing object rethrows.
  const isSchemaShapeError = (e: unknown): boolean =>
    isMissingSchemaObject(e, 'table', 'oauth_clients') ||
    isMissingSchemaObject(e, 'column', ['private_facts', 'private_pages', 'allowed_operations', 'deleted_at', 'surface', 'surface_set_by', 'source_id', 'federated_read']);
  try {
    return await engine.executeRaw<ClientRow>(
      `SELECT client_id, client_name, scope, surface, surface_set_by, source_id, federated_read, allowed_operations, deleted_at, private_pages, private_facts,
              COALESCE((to_jsonb(c)->>'read_shared_revision')::int = c.grant_revision, false) AS read_shared
         FROM oauth_clients c ORDER BY client_name, client_id`,
    );
  } catch (e) {
    // Brain predates the private-facts column: it reads as none.
    if (!isSchemaShapeError(e)) throw e;
  }
  try {
    return await engine.executeRaw<ClientRow>(
      `SELECT client_id, client_name, scope, surface, surface_set_by, source_id, federated_read, allowed_operations, deleted_at, private_pages
         FROM oauth_clients ORDER BY client_name, client_id`,
    );
  } catch (e) {
    // Brain predates the private-pages column: it reads as none.
    if (!isSchemaShapeError(e)) throw e;
  }
  try {
    return await engine.executeRaw<ClientRow>(
      `SELECT client_id, client_name, scope, surface, surface_set_by, source_id, federated_read, allowed_operations, deleted_at
         FROM oauth_clients ORDER BY client_name, client_id`,
    );
  } catch (e) {
    // Brain predates the operation-snapshot columns: operations read `unavailable`.
    if (!isSchemaShapeError(e)) throw e;
  }
  try {
    return await engine.executeRaw<ClientRow>(
      `SELECT client_id, client_name, scope, surface, surface_set_by, source_id, federated_read
         FROM oauth_clients ORDER BY client_name, client_id`,
    );
  } catch (e) {
    // Brain predates the surface columns — fall through. Rethrow non-shape errors.
    if (!isSchemaShapeError(e)) throw e;
  }
  try {
    const mid = await engine.executeRaw<Omit<ClientRow, 'surface' | 'surface_set_by'>>(
      `SELECT client_id, client_name, scope, source_id, federated_read
         FROM oauth_clients ORDER BY client_name, client_id`,
    );
    return mid.map(r => ({ ...r, surface: null, surface_set_by: null }));
  } catch (e) {
    // Brain predates the source-scoping columns — fall through likewise.
    if (!isSchemaShapeError(e)) throw e;
  }
  const bare = await engine.executeRaw<Pick<ClientRow, 'client_id' | 'client_name' | 'scope'>>(
    `SELECT client_id, client_name, scope FROM oauth_clients ORDER BY client_name, client_id`,
  );
  return bare.map(r => ({ ...r, surface: null, surface_set_by: null, source_id: null, federated_read: null }));
}
