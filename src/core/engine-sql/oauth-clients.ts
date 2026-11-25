

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

/** The row with each engine's `timestamptz` and `bigint` spelling brought to one: a `Date` and a number. */
export function normalizeOauthClientRow(raw: Record<string, unknown>): OauthClientRow {
  const row = { ...raw };
  for (const c of DATES) if (row[c] != null && !(row[c] instanceof Date)) row[c] = new Date(String(row[c]));
  for (const c of BIGINTS) if (row[c] != null) row[c] = Number(row[c]);
  return row as unknown as OauthClientRow;
}
