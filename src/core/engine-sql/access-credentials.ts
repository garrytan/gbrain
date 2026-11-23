/**
 * Credentials over `access_tokens` and `oauth_clients`: the token list, the revokes, the client delete, the active-token
 * grant reads, the liveness checks the wake drain runs, the client column probes, the scoped-client insert, its
 * lifetime write and the lifetime-clamp audit read. SQL once for both engines. Each text is its caller's statement byte
 * for byte (auth.ts and token-mint.ts at 2156121155 and 837c389e52, grants/service.ts insertClientGrant, oauth-provider.ts
 * registerClientManual, wakeshift/drain.ts principalLive); a template statement became the positional text the
 * scalar-only SqlQuery sent. The Rust store keeps access tokens and OAuth clients (rust/docs/store/access-tokens.md,
 * oauth-clients.md) but no grant audit, so it reads no lifetime clamp and writes no register audit row. The
 * scope-source read (access/attest-sources.ts markedScopeSources) reads `sources` for the grant checks. The bearer
 * reads (BEARER_SQL) authenticate a request's token. No member returns a token hash, except the bearer read's
 * `SELECT *` row on PGLite and Postgres, which holds the hash the caller passed.
 */
import type { BrainEngine } from '../engine.ts';
import { pgArray } from '../grants/encoding.ts';
import { executeRawJsonb } from '../sql-query.ts';
import { normalizeOauthClientRow, type OauthClientRow } from './oauth-clients.ts';

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
  // The order never reaches output: it fixes the lock order, plain id like lockAllSourceRows, so every locker of these rows takes them the same way.
  scope_sources_update: 'SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR UPDATE',
  // The order never reaches output: it fixes the lock order (plain id, as in scope_sources_update), not a listing.
  scope_sources_share: 'SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR SHARE',
  scope_sources: 'SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))',
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
  /** GST-2898: the write source grant and read-shared switch, present when the column exists (`gbrain auth list` shows a switched key). */
  source_grant?: unknown;
  source_id?: unknown;
  federated_read?: unknown;
  grant_revision?: unknown;
  read_shared_revision?: unknown;
};

const dateOrNull = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)));

/** Normalize one access_tokens row (Postgres, PGLite or the store) to the listed shape. The hash never crosses. */
export function normalizeAccessTokenListRow(r: Record<string, unknown>): AccessTokenListRow {
  return {
    id: String(r.id), name: String(r.name), scopes: r.scopes, created_at: dateOrNull(r.created_at) as Date,
    last_used_at: dateOrNull(r.last_used_at), revoked_at: dateOrNull(r.revoked_at),
    ...('private_pages' in r ? { private_pages: r.private_pages } : {}),
    ...('private_facts' in r ? { private_facts: r.private_facts } : {}),
    ...Object.fromEntries(['source_grant', 'source_id', 'federated_read', 'grant_revision', 'read_shared_revision'].filter(key => key in r).map(key => [key, r[key]])),
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

/** How `readScopeSourceConfigs` locks the rows it reads: FOR SHARE, FOR UPDATE, or no lock. */
export type ScopeSourceLock = 'share' | 'update';

/**
 * The id and config of each source among `ids` (a JSON list of distinct ids), for the scope-source check
 * (access/attest-sources.ts markedScopeSources). A lock takes the rows in id order inside the caller's transaction.
 */
export function readScopeSourceConfigs(tx: Raw, ids: readonly string[], lock?: ScopeSourceLock): Promise<{ id: string; config: unknown }[]> {
  const text = lock === 'update' ? CREDENTIAL_SQL.scope_sources_update : lock === 'share' ? CREDENTIAL_SQL.scope_sources_share : CREDENTIAL_SQL.scope_sources;
  return tx.executeRaw<{ id: string; config: unknown }>(text, [JSON.stringify([...new Set(ids)])]);
}

/**
 * The bearer checks (oauth-provider.ts verifyAccessToken, mcp/http-transport.ts validateToken, grants/legacy-token.ts
 * touchTokenLastUsed), byte for byte as the SqlQuery tag sent them at d51679a5fd. `oauth_rungs` is the OAuth token read
 * and its degrade ladder for brains missing newer `oauth_clients` columns, widest first; the caller walks it.
 */
export const BEARER_SQL = {
  oauth_rungs: [
    `
        SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes, to_jsonb(t)->>'grant_type' AS token_grant,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
               c.source_id, c.federated_read, c.bound_slug_prefixes,
               c.surface, c.surface_set_by
        FROM oauth_tokens t
        LEFT JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
      `,
    `
          SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
                 c.source_id, c.federated_read, c.bound_slug_prefixes
          FROM oauth_tokens t
          LEFT JOIN oauth_clients c ON c.client_id = t.client_id
          WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
        `,
    `
            SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
                   c.source_id, c.federated_read
            FROM oauth_tokens t
            LEFT JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
          `,
    `
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources, c.source_id
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
            `,
    `
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
            `
  ],
  token_by_hash_provider: `
      SELECT * FROM access_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL
    `,
  token_by_hash_transport: `
        SELECT * FROM access_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL
      `,
  touch_unified: `UPDATE access_tokens SET last_used_at = now()
        WHERE id IN (SELECT id FROM access_tokens WHERE id = $1::uuid AND source_grant IS NOT NULL
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED)`,
  touch_legacy: `UPDATE access_tokens SET last_used_at = now()
        WHERE id IN (SELECT id FROM access_tokens WHERE id = $1::uuid
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED)`,
} as const;

/** Which rung of the OAuth token read's degrade ladder (0 is the full projection). */
export type OauthTokenRung = 0 | 1 | 2 | 3 | 4;
/** Which bearer check reads the token by hash (the two texts differ only in whitespace). */
export type TokenByHashCaller = 'provider' | 'transport';

/** The OAuth access token with this hash joined to its live client, at one rung of the degrade ladder. */
export async function readOauthAccessTokenRows(tx: Raw, hash: string, rung: OauthTokenRung): Promise<Record<string, unknown>[]> {
  return (await tx.executeRaw<Record<string, unknown>>(BEARER_SQL.oauth_rungs[rung], [hash])).map(utcCurrentGrant);
}

/** The `oauth_clients` timestamp columns `current_grant` (to_jsonb of the client row) carries. */
const GRANT_TIME_KEYS = ['created_at', 'deleted_at', 'reads_unscoped'] as const;
const JSONB_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?$/;

/**
 * A to_jsonb timestamptz text as the same instant on UTC (`2026-01-02T03:04:05.5+00:00`): to_jsonb prints it in the
 * session TimeZone, so one row reads differently per server or session; the fraction digits are kept as stored.
 * Text of another shape (a year past 9999, BC, infinity) is returned unchanged.
 */
export function utcJsonbTime(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const m = JSONB_TIME.exec(value);
  if (!m) return value;
  const offset = (Number(m[9]) * 3600 + Number(m[10] ?? 0) * 60 + Number(m[11] ?? 0)) * (m[8] === '-' ? -1 : 1);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 1000;
  const utc = new Date(ms).toISOString();
  return /^\d{4}-/.test(utc) ? `${utc.slice(0, 19)}${m[7] ?? ''}+00:00` : value;
}

/** A bearer OAuth token row with its `current_grant` timestamps on UTC (utcJsonbTime), the text the Rust store returns. */
export function utcCurrentGrant(row: Record<string, unknown>): Record<string, unknown> {
  const grant = row.current_grant;
  if (grant == null || typeof grant !== 'object' || Array.isArray(grant)) return row;
  const g = grant as Record<string, unknown>;
  if (!GRANT_TIME_KEYS.some((k) => typeof g[k] === 'string')) return row;
  const next: Record<string, unknown> = { ...g };
  for (const k of GRANT_TIME_KEYS) if (k in next) next[k] = utcJsonbTime(next[k]);
  return { ...row, current_grant: next };
}

/** The statements `auth rescope` ran through executeRaw to lock the active tokens it names, by id or by exact name. */
export const ACTIVE_TOKEN_LOCK_SQL = {
  by_id: 'SELECT * FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL FOR UPDATE',
  by_name: 'SELECT * FROM access_tokens WHERE name = $1 AND revoked_at IS NULL FOR UPDATE',
} as const;

/** The active tokens a rescope names: one id (a UUID) or every token with an exact name. */
export type ActiveTokenTarget = { id: string } | { name: string };

/** The whole rows (`SELECT *`) of the active tokens `target` names, locked FOR UPDATE until the transaction ends. */
export function lockActiveAccessTokens(tx: Raw, target: ActiveTokenTarget): Promise<Record<string, unknown>[]> {
  return 'id' in target
    ? tx.executeRaw<Record<string, unknown>>(ACTIVE_TOKEN_LOCK_SQL.by_id, [target.id])
    : tx.executeRaw<Record<string, unknown>>(ACTIVE_TOKEN_LOCK_SQL.by_name, [target.name]);
}

/** The whole row (`SELECT *`, every schema generation) of the token not revoked with this hash, or null. */
export async function readActiveAccessTokenByHash(tx: Raw, hash: string, caller: TokenByHashCaller): Promise<Record<string, unknown> | null> {
  const [row] = await tx.executeRaw<Record<string, unknown>>(caller === 'transport' ? BEARER_SQL.token_by_hash_transport : BEARER_SQL.token_by_hash_provider, [hash]);
  return row ?? null;
}

/**
 * The debounced `last_used_at` stamp (once per token per 60 s, SKIP LOCKED). `unified` is whether the row the caller read
 * has the `source_grant` column: then a row still on the legacy shape is left to its first-read conversion.
 */
export async function touchAccessTokenLastUsed(tx: Raw, id: string, unified: boolean): Promise<void> {
  await tx.executeRaw(unified ? BEARER_SQL.touch_unified : BEARER_SQL.touch_legacy, [id]);
}

/**
 * The expired-credential sweep serve --http runs at startup (oauth-provider.ts sweepExpiredTokens), byte for byte as the
 * SqlQuery tag sent it at afc2094edd. `RETURNING 1` counts the deleted rows the same way on both engines.
 */
export const OAUTH_SWEEP_SQL = {
  tokens: `
      DELETE FROM oauth_tokens WHERE expires_at < $1 RETURNING 1
    `,
  codes: `
      DELETE FROM oauth_codes WHERE expires_at < $1 RETURNING 1
    `,
} as const;

/** The restore quarantine's expiry of every OAuth token and code (shared-skills/restore.ts), byte for byte as it sent them. */
export const OAUTH_EXPIRE_ALL_SQL = {
  tokens: 'UPDATE oauth_tokens SET expires_at=0',
  codes: 'UPDATE oauth_codes SET expires_at=0',
} as const;

/** Expire every OAuth token and code (`expires_at = 0`), so a restored brain honors no grant the archive carried. */
export async function expireAllOauthCredentials(tx: Raw): Promise<void> {
  await tx.executeRaw(OAUTH_EXPIRE_ALL_SQL.tokens);
  await tx.executeRaw(OAUTH_EXPIRE_ALL_SQL.codes);
}

/** Delete the OAuth tokens and codes that expired before `nowEpochSeconds`; the count of both. */
export async function deleteExpiredOauthCredentials(tx: Raw, nowEpochSeconds: number): Promise<number> {
  const tokens = await tx.executeRaw(OAUTH_SWEEP_SQL.tokens, [nowEpochSeconds]);
  const codes = await tx.executeRaw(OAUTH_SWEEP_SQL.codes, [nowEpochSeconds]);
  return tokens.length + codes.length;
}

/** A TEXT[] literal of the values, as `OAuthGrants.issue` binds `scopes` (a text parameter the column's type reads as an array). */
export function oauthPgArray(values: readonly string[]): string {
  return `{${values.map(s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

/**
 * The two INSERTs of `OAuthGrants.issue` (oauth-grants.ts), byte for byte as the SqlQuery tag sent them at afc2094edd:
 * `grant` writes `grant_type` (a schema with the v286 column), `plain` does not. `created_at` is `to_timestamp($7)` of epoch seconds.
 */
export const OAUTH_TOKEN_SQL = {
  insert_grant: `INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource, created_at, grant_type)
          VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), $8)`,
  insert_plain: `INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))`,
} as const;

const OAUTH_TOKEN_COUNT_SQL = {
  between: "SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at BETWEEN $1 AND $2",
  after: "SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at > $1",
} as const;

/**
 * How many OAuth access tokens expire from `from` (epoch seconds, inclusive) to `to` (inclusive), or with no `to` any time
 * after `from` (exclusive): the admin dashboard's "expiring soon" and "active tokens" counts. A refresh token and a token
 * with no expiry never count.
 */
export async function countOauthAccessTokens(tx: Raw, from: number, to: number | null): Promise<number> {
  const rows = await tx.executeRaw<{ count: number | string }>(to === null ? OAUTH_TOKEN_COUNT_SQL.after : OAUTH_TOKEN_COUNT_SQL.between, to === null ? [from] : [from, to]);
  return Number(rows[0]?.count ?? 0);
}

/** One `oauth_tokens` row as `OAuthGrants.issue` writes it. `grant_type` left out is the INSERT for a schema without that column. */
export interface OauthTokenInsert {
  token_hash: string;
  token_type: 'access' | 'refresh';
  client_id: string;
  scopes: readonly string[];
  /** Epoch seconds. */
  expires_at: number;
  resource: string | null;
  /** Epoch seconds (the issue time, `to_timestamp`). */
  created_at: number;
  grant_type?: 'authorization_code' | 'refresh_token' | 'client_credentials';
}

/**
 * The refresh-token read and delete of `OAuthGrants.refresh` (oauth-grants.ts), byte for byte as the SqlQuery tag sends
 * them: only a `refresh` row of the named client matches, so an access token or another client's token reads null.
 */
export const OAUTH_REFRESH_SQL = {
  for_update: "SELECT * FROM oauth_tokens WHERE token_hash = $1 AND token_type = 'refresh' AND client_id = $2 FOR UPDATE",
  delete: "DELETE FROM oauth_tokens WHERE token_hash = $1 AND token_type = 'refresh' AND client_id = $2",
} as const;

/** An `oauth_tokens` row as `SELECT *` returns it, `expires_at` a number (or null) and `created_at` a Date on every engine. */
export interface OauthTokenRow {
  token_hash: string;
  token_type: string;
  client_id: string;
  scopes: string[] | null;
  expires_at: number | null;
  resource: string | null;
  created_at: Date;
  grant_type?: string | null;
}

/** The row with each engine's `timestamptz` and `bigint` spelling brought to one: a `Date` and a number. */
export function normalizeOauthTokenRow(raw: Record<string, unknown>): OauthTokenRow {
  const row = { ...raw };
  if (row.created_at != null && !(row.created_at instanceof Date)) row.created_at = new Date(String(row.created_at));
  if (row.expires_at != null) row.expires_at = Number(row.expires_at);
  return row as unknown as OauthTokenRow;
}

/** The refresh token of this hash and client, taken FOR UPDATE (a single-writer store takes no lock), or null. Expiry is the caller's check. */
export async function readOauthRefreshTokenForUpdate(tx: Raw, tokenHash: string, clientId: string): Promise<OauthTokenRow | null> {
  const [row] = await tx.executeRaw<Record<string, unknown>>(OAUTH_REFRESH_SQL.for_update, [tokenHash, clientId]);
  return row ? normalizeOauthTokenRow(row) : null;
}

/** Delete the refresh token of this hash and client (a refresh token is single use: the refresh deletes it before it issues). */
export async function deleteOauthRefreshToken(tx: Raw, tokenHash: string, clientId: string): Promise<void> {
  await tx.executeRaw(OAUTH_REFRESH_SQL.delete, [tokenHash, clientId]);
}

/** Insert one OAuth token. A repeated hash is 23505 (`oauth_tokens_pkey`), a client with no row 23503 (`oauth_tokens_client_id_fkey`). */
export async function insertOauthToken(tx: Raw, row: OauthTokenInsert): Promise<void> {
  const common = [row.token_hash, row.token_type, row.client_id, oauthPgArray(row.scopes), row.expires_at, row.resource, row.created_at];
  if (row.grant_type === undefined) await tx.executeRaw(OAUTH_TOKEN_SQL.insert_plain, common);
  else await tx.executeRaw(OAUTH_TOKEN_SQL.insert_grant, [...common, row.grant_type]);
}

/**
 * The first-read conversion of an access token still on the legacy shape (grants/legacy-token.ts resolveTokenGrant),
 * byte for byte as the SqlQuery tag sent it at afc2094edd. The guard (`source_grant IS NULL`) makes concurrent first
 * reads a no-op for the loser, and SKIP LOCKED keeps a row lock held elsewhere from parking the request (#5730).
 */
export const LEGACY_TOKEN_CONVERT_SQL = `
      UPDATE access_tokens SET source_grant = $1, source_id = $2, federated_read = $3::text[],
        allowed_operations = $4::text[], takes_holders = $5::text[], grant_revision = grant_revision + 1,
        last_used_at = now()
      WHERE id IN (SELECT id FROM access_tokens WHERE id = $6::uuid AND source_grant IS NULL FOR UPDATE SKIP LOCKED)
      RETURNING *
    `;

/** The grant columns a legacy token converts to (grants/model.ts tokenGrantColumnArrays); null is NULL. */
export interface LegacyTokenGrantColumns {
  source_grant: string;
  source_id: string | null;
  federated_read: string[] | null;
  allowed_operations: string[] | null;
  takes_holders: string[] | null;
}

/**
 * Write the grant columns of the legacy-shape token `id` and stamp its first use; the converted row, or null when none
 * converted. The arrays bind as the TEXT[] literals the template bound (grants/model.ts tokenGrantColumnValues).
 */
export async function convertLegacyAccessTokenGrant(tx: Raw, id: string, columns: LegacyTokenGrantColumns): Promise<Record<string, unknown> | null> {
  const lit = (v: string[] | null) => (v === null ? null : pgArray(v));
  const [row] = await tx.executeRaw<Record<string, unknown>>(LEGACY_TOKEN_CONVERT_SQL,
    [columns.source_grant, columns.source_id, lit(columns.federated_read), lit(columns.allowed_operations), lit(columns.takes_holders), id]);
  return row ?? null;
}

/**
 * The statements `auth rescope` ran through executeRaw to write a token's grant (grants/legacy-token.ts writeTokenGrant,
 * rescopeInTransaction and migrateLegacyTokens at 5a32485552), byte for byte.
 */
export const TOKEN_GRANT_WRITE_SQL = {
  grant: `UPDATE access_tokens SET source_grant = $2, source_id = $3, federated_read = $4::text[], allowed_operations = $5::text[],
       takes_holders = $6::text[], scopes = COALESCE($7::text[], scopes), grant_revision = grant_revision + 1, permissions = $8::jsonb
     WHERE id = $1::uuid RETURNING grant_revision`,
  private_pages: 'UPDATE access_tokens SET private_pages = $2 WHERE id = $1::uuid',
  private_facts: 'UPDATE access_tokens SET private_facts = $2 WHERE id = $1::uuid',
  read_shared: 'UPDATE access_tokens SET read_shared_revision = $2 WHERE id = $1::uuid',
  lock_legacy: 'SELECT * FROM access_tokens WHERE revoked_at IS NULL AND source_grant IS NULL ORDER BY created_at, id FOR UPDATE',
} as const;

/** One grant write: the five grant columns, the scopes (null keeps them) and the `permissions` mirror. */
export interface AccessTokenGrantWrite {
  columns: LegacyTokenGrantColumns;
  scopes: string[] | null;
  permissions: Record<string, unknown>;
}

/** The private grant columns of a token: what `--private-pages` and `--private-facts` set. */
export type AccessTokenPrivateAxis = 'private_pages' | 'private_facts';

/**
 * Write the grant columns, the scopes when given and the `permissions` mirror of token `id` (a UUID), one more grant
 * revision; the new revision, or null when no token has the id. The arrays bind as the TEXT[] literals the caller bound.
 */
export async function writeAccessTokenGrant(tx: Raw, id: string, write: AccessTokenGrantWrite): Promise<number | null> {
  const lit = (v: string[] | null) => (v === null ? null : pgArray(v));
  const c = write.columns;
  const [row] = await executeRawJsonb<{ grant_revision: number }>(tx, TOKEN_GRANT_WRITE_SQL.grant,
    [id, c.source_grant, c.source_id, lit(c.federated_read), lit(c.allowed_operations), lit(c.takes_holders), write.scopes === null ? null : `{${write.scopes.join(',')}}`],
    [write.permissions]);
  return row ? Number(row.grant_revision) : null;
}

/** GST-2898: stamp token `id`'s (a UUID) read-shared switch at `revision`, or clear it with null (grants/legacy-token.ts rescope). */
export async function setAccessTokenReadSharedRevision(tx: Raw, id: string, revision: number | null): Promise<void> {
  await tx.executeRaw(TOKEN_GRANT_WRITE_SQL.read_shared, [id, revision]);
}

/** Set one private grant column of token `id` (a UUID) to `value` ('none' or 'granted_sources'; the table refuses others). */
export async function writeAccessTokenPrivateGrant(tx: Raw, id: string, axis: AccessTokenPrivateAxis, value: string): Promise<void> {
  await tx.executeRaw(axis === 'private_pages' ? TOKEN_GRANT_WRITE_SQL.private_pages : TOKEN_GRANT_WRITE_SQL.private_facts, [id, value]);
}

/** The whole rows of the active tokens still on the legacy shape (no `source_grant`), oldest first, locked FOR UPDATE. */
export function lockLegacyAccessTokens(tx: Raw): Promise<Record<string, unknown>[]> {
  return tx.executeRaw<Record<string, unknown>>(TOKEN_GRANT_WRITE_SQL.lock_legacy);
}

/**
 * The `oauth_codes` and grant-transaction statements of `OAuthGrants` (oauth-grants.ts) and the provider's code lookup
 * (oauth-provider.ts challengeForAuthorizationCode), byte for byte as the SqlQuery tag sent them at d8d9956871: each `${}`
 * is the next `$n`. The grant transaction's client lock is `readOauthClientForUpdate`
 * (client-grants.ts `CLIENT_GRANT_SQL.client_for_update`); `issueOauthTokens` runs after it on the same transaction.
 */
export const OAUTH_CODE_SQL = {
  insert: `
          INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
            code_challenge_method, redirect_uri, state, resource, expires_at)
          VALUES ($1, $2, $3,
            $4, $5, $6,
            $7, $8, $9)
        `,
  for_update: 'SELECT * FROM oauth_codes WHERE code_hash = $1 AND client_id = $2 FOR UPDATE',
  delete: 'DELETE FROM oauth_codes WHERE code_hash = $1 AND client_id = $2',
  challenge: `
      SELECT code_challenge FROM oauth_codes
      JOIN oauth_clients ON oauth_clients.client_id = oauth_codes.client_id
      WHERE (to_jsonb(oauth_clients)->>'deleted_at') IS NULL
        AND code_hash = $1
        AND oauth_codes.client_id = $2
        AND oauth_codes.expires_at > $3
    `,
} as const;

/** One `oauth_codes` row as `OAuthGrants.decide` writes it (`expires_at` is epoch seconds; `scopes` is the TEXT[] value). */
export interface OauthCodeInsert {
  code_hash: string;
  client_id: string;
  scopes: readonly string[];
  code_challenge: string;
  code_challenge_method: 'S256';
  redirect_uri: string;
  state: string | null;
  resource: string | null;
  expires_at: number;
}

/** An `oauth_codes` row as `SELECT *` returns it, `expires_at` a number and `created_at` a Date on every engine. */
export interface OauthCodeRow {
  code_hash: string;
  client_id: string;
  scopes: string[] | null;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  state: string | null;
  resource: string | null;
  expires_at: number;
  created_at: Date;
}

/** The row with each engine's `timestamptz` and `bigint` spelling brought to one: a `Date` and a number. */
export function normalizeOauthCodeRow(raw: Record<string, unknown>): OauthCodeRow {
  const row = { ...raw };
  if (row.created_at != null && !(row.created_at instanceof Date)) row.created_at = new Date(String(row.created_at));
  if (row.expires_at != null) row.expires_at = Number(row.expires_at);
  return row as unknown as OauthCodeRow;
}

/** Insert one authorization code. A repeated hash is 23505 (`oauth_codes_pkey`), a client with no row 23503 (`oauth_codes_client_id_fkey`). */
export async function insertOauthCode(tx: Raw, row: OauthCodeInsert): Promise<void> {
  await tx.executeRaw(OAUTH_CODE_SQL.insert, [row.code_hash, row.client_id, oauthPgArray(row.scopes), row.code_challenge,
    row.code_challenge_method, row.redirect_uri, row.state, row.resource, row.expires_at]);
}

/** The code row of this hash and client, taken FOR UPDATE (a single-writer store takes no lock), or null. Expiry is the caller's check. */
export async function readOauthCodeForUpdate(tx: Raw, codeHash: string, clientId: string): Promise<OauthCodeRow | null> {
  const [row] = await tx.executeRaw<Record<string, unknown>>(OAUTH_CODE_SQL.for_update, [codeHash, clientId]);
  return row ? normalizeOauthCodeRow(row) : null;
}

/** Delete the code of this hash and client (a code is single use: the exchange deletes it before it issues). */
export async function deleteOauthCode(tx: Raw, codeHash: string, clientId: string): Promise<void> {
  await tx.executeRaw(OAUTH_CODE_SQL.delete, [codeHash, clientId]);
}

/** The PKCE challenge of an unexpired code of this client whose client is not soft-deleted, or null (any other client's code reads null). */
export async function readOauthCodeChallenge(tx: Raw, codeHash: string, clientId: string, nowEpochSeconds: number): Promise<string | null> {
  const [row] = await tx.executeRaw<{ code_challenge: string }>(OAUTH_CODE_SQL.challenge, [codeHash, clientId, nowEpochSeconds]);
  return row ? row.code_challenge : null;
}

/**
 * Insert the tokens of one grant (the access token and, for a code or refresh exchange, its refresh token) on the grant
 * transaction's executor, after `readOauthClientForUpdate` took the client row: the same INSERTs `insertOauthToken` runs, in
 * order, and all or none. Pass the transaction, never the pool: a second connection would wait on the client row lock
 * through the foreign key while the transaction waits for it.
 */
export async function issueOauthTokens(tx: Raw, rows: readonly OauthTokenInsert[]): Promise<void> {
  for (const row of rows) await insertOauthToken(tx, row);
}
