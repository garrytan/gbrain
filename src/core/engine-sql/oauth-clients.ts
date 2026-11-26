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

/** One `oauth_clients` row to insert. Only the id and the name are required; the rest take the table's defaults. */
export interface OauthClientInsert {
  client_id: string;
  client_secret_hash?: string | null;
  client_name: string;
  redirect_uris?: string[] | null;
  grant_types?: string[] | null;
  scope?: string | null;
  token_endpoint_auth_method?: string | null;
  client_id_issued_at?: number | null;
  client_secret_expires_at?: number | null;
  token_ttl?: number | null;
  deleted_at?: Date | null;
  source_id?: string | null;
  federated_read?: string[];
  budget_usd_per_day?: number | null;
  bound_tools?: string[] | null;
  bound_source_id?: string | null;
  bound_brain_id?: string | null;
  bound_slug_prefixes?: string[] | null;
  bound_max_concurrent?: number;
  surface?: string | null;
  surface_set_by?: string | null;
  allowed_operations?: string[] | null;
  delegated_slug_prefixes?: string[] | null;
  delegated_namespace?: string;
  grant_profile?: string | null;
  grant_revision?: number;
  grant_repair_reasons?: string[];
  created_at?: Date | null;
  source_grant?: string | null;
  takes_holders?: string[] | null;
  min_trust?: string | null;
  registered_via?: string | null;
  private_pages?: string;
  member_id?: string | null;
  may_act_for?: string[] | null;
  attest_actor?: string | null;
  attest_ops?: string[] | null;
  attest_sources?: string[] | null;
  attest_read?: string | null;
  reads_unscoped?: Date | null;
  private_facts?: string;
}

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

/** `INSERT` one client row, with the defaults the table gives a column that is left out. */
export async function insertOauthClient(tx: Raw, row: OauthClientInsert): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO oauth_clients (
       client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method,
       client_id_issued_at, client_secret_expires_at, token_ttl, deleted_at, source_id, federated_read,
       budget_usd_per_day, bound_tools, bound_source_id, bound_brain_id, bound_slug_prefixes, bound_max_concurrent,
       surface, surface_set_by, allowed_operations, delegated_slug_prefixes, delegated_namespace, grant_profile,
       grant_revision, grant_repair_reasons, created_at, source_grant, takes_holders, min_trust, registered_via,
       private_pages, member_id, may_act_for, attest_actor, attest_ops, attest_sources, attest_read, reads_unscoped,
       private_facts)
     VALUES (
       $1, $2, $3, $4::text[], $5::text[], $6, $7, $8::bigint, $9::bigint, $10::int, $11::timestamptz, $12,
       $13::text[], $14, $15::text[], $16, $17, $18::text[], $19::int, $20, $21, $22::text[], $23::text[], $24, $25,
       $26::int, $27::text[], COALESCE($28::timestamptz, now()), $29, $30::text[], $31, $32, $33, $34, $35::text[],
       $36, $37::text[], $38::text[], $39, $40::timestamptz, $41)`,
    [
    row.client_id,
    row.client_secret_hash ?? null,
    row.client_name,
    row.redirect_uris ?? null,
    row.grant_types === undefined ? ['client_credentials'] : row.grant_types,
    row.scope ?? null,
    row.token_endpoint_auth_method ?? null,
    row.client_id_issued_at ?? null,
    row.client_secret_expires_at ?? null,
    row.token_ttl ?? null,
    row.deleted_at ?? null,
    row.source_id ?? null,
    row.federated_read ?? [],
    row.budget_usd_per_day ?? null,
    row.bound_tools ?? null,
    row.bound_source_id ?? null,
    row.bound_brain_id ?? null,
    row.bound_slug_prefixes ?? null,
    row.bound_max_concurrent ?? 1,
    row.surface ?? null,
    row.surface_set_by ?? null,
    row.allowed_operations ?? null,
    row.delegated_slug_prefixes ?? null,
    row.delegated_namespace ?? 'prefixes',
    row.grant_profile ?? null,
    row.grant_revision ?? 0,
    row.grant_repair_reasons ?? [],
    row.created_at ?? null,
    row.source_grant ?? null,
    row.takes_holders ?? null,
    row.min_trust ?? null,
    row.registered_via ?? null,
    row.private_pages ?? 'none',
    row.member_id ?? null,
    row.may_act_for ?? null,
    row.attest_actor ?? null,
    row.attest_ops ?? null,
    row.attest_sources ?? null,
    row.attest_read ?? null,
    row.reads_unscoped ?? null,
    row.private_facts ?? 'none',
    ]);
}

const DATES = ['deleted_at', 'created_at', 'reads_unscoped'] as const;
const BIGINTS = ['client_id_issued_at', 'client_secret_expires_at'] as const;

/** A client's whole row, or null for no such client. */
export async function readOauthClient(tx: Raw, clientId: string): Promise<OauthClientRow | null> {
  const rows = await tx.executeRaw<Record<string, unknown>>('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]);
  return rows[0] ? normalizeOauthClientRow(rows[0]) : null;
}

/**
 * Every client's whole row, by name then id in byte order (`COLLATE "C"`, so every engine sorts alike). A brain from
 * before a column returns rows without it, so the caller picks the columns it needs and reads a missing one as the
 * old brains did (`gbrain auth clients`).
 */
export async function listOauthClients(tx: Raw): Promise<OauthClientRow[]> {
  const rows = await tx.executeRaw<Record<string, unknown>>(
    'SELECT * FROM oauth_clients ORDER BY client_name COLLATE "C", client_id COLLATE "C"',
  );
  return rows.map(normalizeOauthClientRow);
}

/** The columns `patchOauthClient` sets: a key left out (or `undefined`) is untouched, `null` clears the column. */
export interface OauthClientPatch {
  client_secret_hash?: string | null;
  token_ttl?: number | null;
  min_trust?: string | null;
  surface?: string | null;
  surface_set_by?: string | null;
}

/**
 * Which client rows a patch may touch: `live` skips a deleted client; `unless_surface_set_by` skips a client whose
 * `surface_set_by` is that value (NULL is not equal to it); `client_secret_hash_is` touches the client only while its
 * secret hash is still that value (a compare-and-set, so a caller that read the hash and lost a race to another writer
 * changes nothing).
 */
export interface OauthClientPatchGuard {
  live?: boolean;
  unless_surface_set_by?: string;
  client_secret_hash_is?: string;
}

/** The five patchable columns, as they were before the patch. */
export type OauthClientPatchBefore = Required<OauthClientPatch>;

/** The patched client: its whole row after the patch, and the patchable columns before it. */
export interface OauthClientPatched {
  row: OauthClientRow;
  before: OauthClientPatchBefore;
}

/**
 * Set the named columns of one client in one statement, under a row lock on the client (the Rust store's single writer
 * is the lock there). Returns the row after and the five columns before, or null when no client matches `client_id`
 * and the guard. A value a CHECK of the table refuses raises that constraint's error (23514).
 */
export async function patchOauthClient(
  tx: Raw, clientId: string, patch: OauthClientPatch, guard: OauthClientPatchGuard = {},
): Promise<OauthClientPatched | null> {
  const has = (k: keyof OauthClientPatch) => patch[k] !== undefined;
  const rows = await tx.executeRaw<Record<string, unknown>>(
    `WITH prior AS (
       SELECT * FROM oauth_clients WHERE client_id = $1 AND ($2::boolean IS NOT TRUE OR deleted_at IS NULL) FOR UPDATE)
     UPDATE oauth_clients c SET
       client_secret_hash = CASE WHEN $3::boolean THEN $4::text ELSE c.client_secret_hash END,
       token_ttl = CASE WHEN $5::boolean THEN $6::int ELSE c.token_ttl END,
       min_trust = CASE WHEN $7::boolean THEN $8::text ELSE c.min_trust END,
       surface = CASE WHEN $9::boolean THEN $10::text ELSE c.surface END,
       surface_set_by = CASE WHEN $11::boolean THEN $12::text ELSE c.surface_set_by END
     FROM prior
     WHERE c.client_id = prior.client_id AND ($13::text IS NULL OR prior.surface_set_by IS DISTINCT FROM $13::text)
       AND ($14::text IS NULL OR prior.client_secret_hash = $14::text)
     RETURNING c.*, prior.client_secret_hash AS prior_client_secret_hash, prior.token_ttl AS prior_token_ttl,
       prior.min_trust AS prior_min_trust, prior.surface AS prior_surface, prior.surface_set_by AS prior_surface_set_by`,
    [clientId, guard.live === true,
      has('client_secret_hash'), patch.client_secret_hash ?? null, has('token_ttl'), patch.token_ttl ?? null,
      has('min_trust'), patch.min_trust ?? null, has('surface'), patch.surface ?? null,
      has('surface_set_by'), patch.surface_set_by ?? null, guard.unless_surface_set_by ?? null, guard.client_secret_hash_is ?? null]);
  const found = rows[0];
  if (!found) return null;
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(found)) if (!k.startsWith('prior_')) row[k] = v;
  return {
    row: normalizeOauthClientRow(row),
    before: {
      client_secret_hash: found.prior_client_secret_hash as string | null, token_ttl: found.prior_token_ttl as number | null,
      min_trust: found.prior_min_trust as string | null, surface: found.prior_surface as string | null,
      surface_set_by: found.prior_surface_set_by as string | null,
    },
  };
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

/** The members of this file a fake engine takes (test/helpers/queue-engine-members.ts). */
export const OAUTH_CLIENT_MEMBER_NAMES = ['insertOauthClient', 'readOauthClient', 'listOauthClients', 'patchOauthClient'] as const;

/** The statement commands/serve-http-clients.ts mountAdminClients ran through executeRaw (its columns are harness/client-setup.ts CLIENT_INSPECTION_COLUMNS). */
export const ADMIN_CLIENT_ROWS_SQL = `SELECT client_id, client_name, redirect_uris, grant_types,
  token_endpoint_auth_method, client_id_issued_at, client_secret_expires_at, created_at, deleted_at,
  scope, source_id, federated_read, bound_slug_prefixes, allowed_operations, bound_tools,
  bound_source_id, bound_brain_id, delegated_slug_prefixes, delegated_namespace,
  bound_max_concurrent, budget_usd_per_day, surface, surface_set_by, token_ttl,
  grant_profile, grant_revision, grant_repair_reasons FROM oauth_clients ORDER BY created_at DESC, client_id COLLATE "C"`;

/** The inspection columns of every client, deleted ones included, newest first and then by byte order of client id. */
export function listAdminClientRows(tx: Raw): Promise<Array<Record<string, unknown>>> {
  return tx.executeRaw<Record<string, unknown>>(ADMIN_CLIENT_ROWS_SQL);
}
