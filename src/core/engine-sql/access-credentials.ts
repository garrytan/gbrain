/**
 * Credentials over `access_tokens` and `oauth_clients`: the token list, the revokes, the client delete, the active-token
 * grant reads, the liveness checks the wake drain runs, the client column probes, the scoped-client insert, its
 * lifetime write and the lifetime-clamp audit read. SQL once for both engines. Each text is its caller's statement byte
 * for byte (auth.ts and token-mint.ts at 2156121155 and 837c389e52, grants/service.ts insertClientGrant, oauth-provider.ts
 * registerClientManual, wakeshift/drain.ts principalLive); a template statement became the positional text the
 * scalar-only SqlQuery sent. The Rust store keeps access tokens and OAuth clients (rust/docs/store/access-tokens.md,
 * oauth-clients.md) but no grant audit, so it reads no lifetime clamp and writes no register audit row.
 * No member returns a token hash.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

export const CREDENTIAL_REVOKE_SQL = {
  tokens_by_name: `
      UPDATE access_tokens SET revoked_at = now()
      WHERE name = $1 AND revoked_at IS NULL
      RETURNING id
    `,
  token_by_id: `
      UPDATE access_tokens SET revoked_at = now()
      WHERE id = $1::uuid AND revoked_at IS NULL
      RETURNING name
    `,
  client: `
        DELETE FROM oauth_clients WHERE client_id = $1
        RETURNING client_id, client_name
      `,
} as const;

/** Revoke every active access token named `name` (names are not unique); the ids of the tokens it revoked. */
export async function revokeAccessTokensNamed(tx: Raw, name: string): Promise<string[]> {
  const rows = await tx.executeRaw<{ id: string }>(CREDENTIAL_REVOKE_SQL.tokens_by_name, [name]);
  return rows.map(r => String(r.id));
}

/** Revoke the active access token with this id (a UUID); its name, or null when no active token has that id. */
export async function revokeAccessToken(tx: Raw, id: string): Promise<string | null> {
  const [row] = await tx.executeRaw<{ name: string }>(CREDENTIAL_REVOKE_SQL.token_by_id, [id]);
  return row ? String(row.name) : null;
}

/** A deleted OAuth client. */
export interface DeletedOAuthClient { client_id: string; client_name: string }

/**
 * Delete the OAuth client with this id; its tokens and codes go with it (ON DELETE CASCADE). The deleted client, or
 * null when no client has that id.
 */
export async function deleteOAuthClient(tx: Raw, clientId: string): Promise<DeletedOAuthClient | null> {
  const [row] = await tx.executeRaw<DeletedOAuthClient>(CREDENTIAL_REVOKE_SQL.client, [clientId]);
  return row ? { client_id: String(row.client_id), client_name: String(row.client_name) } : null;
}

/** The other credential statements, each its caller's text byte for byte. */
export const CREDENTIAL_SQL = {
  token_list: `
      SELECT * FROM access_tokens
      ORDER BY created_at DESC
    `,
  token_private_pages: 'SELECT private_pages FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL',
  token_permissions: 'SELECT permissions FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL',
  token_live: 'SELECT 1 FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL',
  client_live: 'SELECT 1 FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL',
  client_columns_preflight: `
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'oauth_clients'
      AND table_schema = current_schema()
      AND column_name IN ('token_ttl', 'surface', 'federated_read', 'source_id', 'deleted_at')
  `,
  client_columns_grant: `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'oauth_clients'
        AND column_name IN ('grant_revision', 'allowed_operations', 'delegated_slug_prefixes', 'delegated_namespace', 'grant_profile', 'grant_repair_reasons', 'surface', 'surface_set_by', 'token_ttl', 'source_id', 'federated_read', 'bound_slug_prefixes', 'bound_tools', 'bound_source_id', 'bound_brain_id', 'bound_max_concurrent', 'budget_usd_per_day')`,
  client_token_ttl: `
        UPDATE oauth_clients SET token_ttl = $1
        WHERE client_id = $2
        RETURNING client_id
      `,
  client_grant_insert: `
    WITH created AS (
      INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, redirect_uris, grant_types,
        token_endpoint_auth_method, client_id_issued_at, scope, source_id, federated_read,
        bound_slug_prefixes, allowed_operations, bound_tools, bound_source_id, bound_brain_id,
        delegated_slug_prefixes, delegated_namespace, bound_max_concurrent, budget_usd_per_day,
        surface, surface_set_by, token_ttl, grant_profile, grant_revision, grant_repair_reasons)
      VALUES ($1, $2, $3,
        ARRAY(SELECT jsonb_array_elements_text($4::text::jsonb)),
        ARRAY(SELECT jsonb_array_elements_text($5::text::jsonb)),
        $6, $7, $8, $9,
        ARRAY(SELECT jsonb_array_elements_text($10::text::jsonb)),
        CASE WHEN $11 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($12::text::jsonb)) END,
        CASE WHEN $13 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($14::text::jsonb)) END,
        CASE WHEN $15 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($16::text::jsonb)) END,
        $17, $18,
        CASE WHEN $19 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($20::text::jsonb)) END,
        $21, $22, $23, $24, $25,
        $26, $27, $28,
        ARRAY(SELECT jsonb_array_elements_text($29::text::jsonb)))
      RETURNING client_id
    ) INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
      SELECT client_id, $30, 'register', $31, NULL, $32::text::jsonb FROM created
  `,
  clamped_clients: `SELECT DISTINCT client_id FROM oauth_grant_audit WHERE actor = 'migration' AND action IN ('clamp_token_ttl', 'shorten_access_tokens')`,
} as const;

/** The optional `oauth_clients` columns each probe asks about. */
export const OAUTH_CLIENT_PROBE_COLUMNS = {
  preflight: ['token_ttl', 'surface', 'federated_read', 'source_id', 'deleted_at'],
  grant: ['grant_revision', 'allowed_operations', 'delegated_slug_prefixes', 'delegated_namespace', 'grant_profile', 'grant_repair_reasons', 'surface', 'surface_set_by', 'token_ttl', 'source_id', 'federated_read', 'bound_slug_prefixes', 'bound_tools', 'bound_source_id', 'bound_brain_id', 'bound_max_concurrent', 'budget_usd_per_day'],
} as const;
export type OauthClientProbe = keyof typeof OAUTH_CLIENT_PROBE_COLUMNS;

/**
 * One listed access token, without its hash. `private_pages` and `private_facts` are the stored text (undefined on a
 * brain that predates the column); `member_id` is null for a token bound to no member.
 */
export type AccessTokenListRow = {
  id: string;
  name: string;
  scopes: unknown;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  private_pages?: unknown;
  private_facts?: unknown;
  member_id: string | null;
};

const dateOrNull = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)));

/** Normalize one access_tokens row (Postgres, PGLite or the store) to the listed shape. The hash never crosses. */
export function normalizeAccessTokenListRow(r: Record<string, unknown>): AccessTokenListRow {
  return {
    id: String(r.id), name: String(r.name), scopes: r.scopes, created_at: dateOrNull(r.created_at) as Date,
    last_used_at: dateOrNull(r.last_used_at), revoked_at: dateOrNull(r.revoked_at),
    ...('private_pages' in r ? { private_pages: r.private_pages } : {}),
    ...('private_facts' in r ? { private_facts: r.private_facts } : {}),
    member_id: r.member_id == null ? null : String(r.member_id),
  };
}

/** Every access token, newest first (`SELECT *` reads every schema generation). */
export async function listAccessTokens(tx: Raw): Promise<AccessTokenListRow[]> {
  const rows = await tx.executeRaw<Record<string, unknown>>(CREDENTIAL_SQL.token_list);
  return rows.map(normalizeAccessTokenListRow);
}

/** Which grant column of an active token a caller reads. */
export type ActiveTokenGrantField = 'private_pages' | 'permissions';

/**
 * One grant column of the active token with this id (a UUID): `{ value }`, or null when no active token has it. A brain
 * that predates `private_pages` raises the undefined-column error; the caller decides what that means.
 */
export async function readActiveAccessTokenGrant(tx: Raw, id: string, field: ActiveTokenGrantField): Promise<{ value: unknown } | null> {
  const [row] = await tx.executeRaw<Record<string, unknown>>(field === 'private_pages' ? CREDENTIAL_SQL.token_private_pages : CREDENTIAL_SQL.token_permissions, [id]);
  return row ? { value: row[field] } : null;
}

/** Whether an active (not revoked) token has this id, compared as text. */
export async function accessTokenLive(tx: Raw, id: string): Promise<boolean> {
  return (await tx.executeRaw(CREDENTIAL_SQL.token_live, [id])).length > 0;
}

/** Whether a client not deleted has this id. */
export async function oauthClientLive(tx: Raw, clientId: string): Promise<boolean> {
  return (await tx.executeRaw(CREDENTIAL_SQL.client_live, [clientId])).length > 0;
}

/** Which of the probe's optional `oauth_clients` columns this brain has. */
export async function readOauthClientColumns(tx: Raw, probe: OauthClientProbe): Promise<string[]> {
  const rows = await tx.executeRaw<{ column_name: string }>(probe === 'preflight' ? CREDENTIAL_SQL.client_columns_preflight : CREDENTIAL_SQL.client_columns_grant);
  return rows.map(r => String(r.column_name));
}

/** Set one client's access-token lifetime (seconds); false when no client has this id. */
export async function setOauthClientTokenTtl(tx: Raw, clientId: string, ttlSeconds: number): Promise<boolean> {
  return (await tx.executeRaw(CREDENTIAL_SQL.client_token_ttl, [ttlSeconds, clientId])).length > 0;
}

/**
 * A scoped client to register, with its grant columns and the audit row the register writes beside it (`actor`,
 * the grant revision, and `after_grant`, the grant document as JSON text). Built by grants/service.ts clientGrantInsert.
 */
export interface OauthClientGrantInsert {
  client_id: string;
  client_name: string;
  client_secret_hash: string | null;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  client_id_issued_at: number;
  scope: string;
  source_id: string | null;
  federated_read: string[];
  bound_slug_prefixes: string[] | null;
  allowed_operations: string[] | null;
  bound_tools: string[] | null;
  bound_source_id: string | null;
  bound_brain_id: string | null;
  delegated_slug_prefixes: string[] | null;
  delegated_namespace: string;
  bound_max_concurrent: number;
  budget_usd_per_day: string | null;
  surface: string | null;
  surface_set_by: string | null;
  token_ttl: number | null;
  grant_profile: string | null;
  grant_revision: number;
  grant_repair_reasons: string[];
  audit: { actor: string; after_grant: string };
}

/** Insert a scoped client and its register audit row in one statement. */
export async function insertOauthClientGrant(tx: Raw, row: OauthClientGrantInsert): Promise<void> {
  const list = (v: string[] | null) => [v === null, JSON.stringify(v ?? [])] as const;
  await tx.executeRaw(CREDENTIAL_SQL.client_grant_insert, [
    row.client_id, row.client_name, row.client_secret_hash,
    JSON.stringify(row.redirect_uris), JSON.stringify(row.grant_types),
    row.token_endpoint_auth_method, row.client_id_issued_at, row.scope, row.source_id,
    JSON.stringify(row.federated_read),
    ...list(row.bound_slug_prefixes), ...list(row.allowed_operations), ...list(row.bound_tools),
    row.bound_source_id, row.bound_brain_id,
    ...list(row.delegated_slug_prefixes),
    row.delegated_namespace, row.bound_max_concurrent, row.budget_usd_per_day, row.surface, row.surface_set_by,
    row.token_ttl, row.grant_profile, row.grant_revision,
    JSON.stringify(row.grant_repair_reasons),
    row.audit.actor, row.grant_revision, row.audit.after_grant,
  ]);
}

/** The clients whose stored or outstanding token lifetime an upgrade migration clamped (the raw audit error passes through). */
export async function readTokenLifetimeClampedClients(tx: Raw): Promise<string[]> {
  const rows = await tx.executeRaw<{ client_id: string }>(CREDENTIAL_SQL.clamped_clients);
  return rows.map(r => r.client_id);
}
