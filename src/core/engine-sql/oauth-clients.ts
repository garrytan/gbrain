/**
 * The `oauth_clients` table, every column of it, as typed members (rust/docs/store/oauth-clients.md): the insert of a
 * client row, the read of one whole row, and the constraint errors both of them raise. SQL once for both engines, so a
 * store that is not SQL serves the same members.
 *
 * A column left out of an insert takes the table's default; `null` is NULL where the column allows it. A row that breaks
 * a CHECK of the table (`oauth_clients_complete_agent_grant` in src/core/grants/schema.ts first among them) is refused
 * with SQLSTATE 23514 and the constraint name on `constraint` (PGLite) and `constraint_name` (postgres.js); a repeated
 * client id is 23505 (`oauth_clients_pkey`); a `source_id` no source has is 23503 (`oauth_clients_source_id_fkey`). The
 * Rust engine raises the same (store-members/jobs-oauth-clients.ts), so a caller branches on one error shape.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One `oauth_clients` row, as `SELECT *` returns it (times as `Date`, `bigint` columns as numbers, the cap as `NUMERIC` text). */
export interface OauthClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[] | null;
  grant_types: string[] | null;
  scope: string | null;
  token_endpoint_auth_method: string | null;
  client_id_issued_at: number | null;
  client_secret_expires_at: number | null;
  token_ttl: number | null;
  deleted_at: Date | null;
  source_id: string | null;
  federated_read: string[];
  budget_usd_per_day: string | null;
  bound_tools: string[] | null;
  bound_source_id: string | null;
  bound_brain_id: string | null;
  bound_slug_prefixes: string[] | null;
  bound_max_concurrent: number;
  surface: string | null;
  surface_set_by: string | null;
  allowed_operations: string[] | null;
  delegated_slug_prefixes: string[] | null;
  delegated_namespace: string;
  grant_profile: string | null;
  grant_revision: number;
  grant_repair_reasons: string[];
  created_at: Date;
  source_grant: string | null;
  takes_holders: string[] | null;
  min_trust: string | null;
  registered_via: string | null;
  private_pages: string;
  member_id: string | null;
  may_act_for: string[] | null;
  attest_actor: string | null;
  attest_ops: string[] | null;
  attest_sources: string[] | null;
  attest_read: string | null;
  reads_unscoped: Date | null;
  private_facts: string;
}

const DATES = ['deleted_at', 'created_at', 'reads_unscoped'] as const;
const BIGINTS = ['client_id_issued_at', 'client_secret_expires_at'] as const;

/** A client's whole row, or null for no such client. */
export async function readOauthClient(tx: Raw, clientId: string): Promise<OauthClientRow | null> {
  const rows = await tx.executeRaw<Record<string, unknown>>('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]);
  return rows[0] ? normalizeOauthClientRow(rows[0]) : null;
}

/** The row with each engine's `timestamptz` and `bigint` spelling brought to one: a `Date` and a number. */
export function normalizeOauthClientRow(raw: Record<string, unknown>): OauthClientRow {
  const row = { ...raw };
  for (const c of DATES) if (row[c] != null && !(row[c] instanceof Date)) row[c] = new Date(String(row[c]));
  for (const c of BIGINTS) if (row[c] != null) row[c] = Number(row[c]);
  return row as unknown as OauthClientRow;
}

/**
 * A caller that names columns in a SELECT gets Postgres's undefined-column error (42703) from a brain that lacks one;
 * `readOauthClient` returns the whole row, so that caller checks the columns it relies on here and gets the same error.
 */
export function requireOauthClientColumns<T extends object>(row: T, columns: readonly string[]): T {
  for (const column of columns) {
    if (column in row) continue;
    throw Object.assign(new Error(`column "${column}" does not exist`), { code: '42703', column_name: column, column: column });
  }
  return row;
}
