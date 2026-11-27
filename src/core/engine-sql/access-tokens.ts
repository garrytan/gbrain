/**
 * The `access_tokens` columns the legacy-token mint and the read-floor command touch, as typed members
 * (rust/docs/store/access-tokens.md): insert one token row, find the active tokens a target names, set one token's
 * `min_trust`, and read whether a live token reads unscoped and when it was created (access/requester-scope.ts
 * `credentialScopeFor`). SQL once for both engines, so a store that is not SQL serves the same members.
 *
 * Not here: the list, the revokes and the bearer reads (engine-sql/access-credentials.ts), the member binding writes
 * (engine-sql/access-members.ts); the grant rewrites (grants/legacy-token.ts) stay raw SQL.
 * A column a brain's migrations have not added raises Postgres's undefined-column error (42703) on the SQL engines;
 * the callers (token-mint.ts, trust/min-trust.ts) turn that into `migrations_pending`.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * One token row to insert. The grant columns come from `tokenGrantColumnArrays` (grants/model.ts); `scopes` null is a
 * grandfathered full-access token. The row is born at grant revision 1. `min_trust` and `revoked_at` are left out
 * by the mint: the read-floor command sets the first after the mint, and a token is revoked after it exists.
 * `member_id`, `may_act_for` and `created_at` (null: `now()`) are left out by the mint too: a member insert or the
 * credential binding write binds a token after it exists; a caller that seeds a bound token gives them.
 * A caller that gives any of these gets a brain with the column (the statement names it); one that does not never names it.
 */
export interface AccessTokenInsert {
  name: string;
  token_hash: string;
  scopes: string[] | null;
  permissions: Record<string, unknown>;
  source_grant: string | null;
  source_id: string | null;
  federated_read: string[] | null;
  allowed_operations: string[] | null;
  takes_holders: string[] | null;
  /** GST-2898: born with the read-shared switch on (read_shared_revision = 1, the birth revision). */
  read_shared?: boolean;
  min_trust?: string | null;
  revoked_at?: Date | null;
  member_id?: string | null;
  may_act_for?: string[] | null;
  created_at?: Date | null;
}

/** An active token a target names: the id, the name, and the read floor before a change. */
export interface ActiveAccessTokenRow {
  id: string;
  name: string;
  min_trust: string | null;
}

/**
 * `INSERT` one token row and return its generated id. A repeated token hash is 23505 (`access_tokens_token_hash_key`);
 * a `source_grant` outside default|scalar|federated|none is 23514 (`access_tokens_source_grant_check`).
 */
export async function insertAccessToken(tx: Raw, row: AccessTokenInsert): Promise<{ id: string }> {
  const base = [row.name, row.token_hash, row.scopes, row.permissions, row.source_grant, row.source_id, row.federated_read, row.allowed_operations, row.takes_holders];
  const withBinding = row.member_id !== undefined || row.may_act_for !== undefined || row.created_at !== undefined;
  const withFloor = row.min_trust !== undefined || row.revoked_at !== undefined;
  const rows = row.read_shared && withBinding
    ? await tx.executeRaw<{ id: string }>(
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions, source_grant, source_id, federated_read, allowed_operations, takes_holders, grant_revision, read_shared_revision, min_trust, revoked_at, member_id, may_act_for, created_at)
       VALUES ($1, $2, $3::text[], $4::jsonb, $5, $6, $7::text[], $8::text[], $9::text[], 1, 1, $10, $11::timestamptz, $12, $13::text[], COALESCE($14::timestamptz, now()))
       RETURNING id::text AS id`,
      [...base, row.min_trust ?? null, row.revoked_at ?? null, row.member_id ?? null, row.may_act_for ?? null, row.created_at ?? null])
    : row.read_shared
    ? await tx.executeRaw<{ id: string }>(
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions, source_grant, source_id, federated_read, allowed_operations, takes_holders, grant_revision, read_shared_revision, min_trust, revoked_at)
       VALUES ($1, $2, $3::text[], $4::jsonb, $5, $6, $7::text[], $8::text[], $9::text[], 1, 1, $10, $11::timestamptz)
       RETURNING id::text AS id`,
      [...base, row.min_trust ?? null, row.revoked_at ?? null])
    : withBinding
    ? await tx.executeRaw<{ id: string }>(
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions, source_grant, source_id, federated_read, allowed_operations, takes_holders, grant_revision, min_trust, revoked_at, member_id, may_act_for, created_at)
       VALUES ($1, $2, $3::text[], $4::jsonb, $5, $6, $7::text[], $8::text[], $9::text[], 1, $10, $11::timestamptz, $12, $13::text[], COALESCE($14::timestamptz, now()))
       RETURNING id::text AS id`,
      [...base, row.min_trust ?? null, row.revoked_at ?? null, row.member_id ?? null, row.may_act_for ?? null, row.created_at ?? null])
    : withFloor
    ? await tx.executeRaw<{ id: string }>(
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions, source_grant, source_id, federated_read, allowed_operations, takes_holders, grant_revision, min_trust, revoked_at)
       VALUES ($1, $2, $3::text[], $4::jsonb, $5, $6, $7::text[], $8::text[], $9::text[], 1, $10, $11::timestamptz)
       RETURNING id::text AS id`,
      [...base, row.min_trust ?? null, row.revoked_at ?? null])
    : await tx.executeRaw<{ id: string }>(
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions, source_grant, source_id, federated_read, allowed_operations, takes_holders, grant_revision)
       VALUES ($1, $2, $3::text[], $4::jsonb, $5, $6, $7::text[], $8::text[], $9::text[], 1)
       RETURNING id::text AS id`,
      base);
  const id = rows[0]?.id;
  if (!id) throw new Error('token insert returned no id');
  return { id };
}

/** The tokens not yet revoked whose id or name is `target`, by id (names are not unique, so there may be several). */
export async function findActiveAccessTokens(tx: Raw, target: string): Promise<ActiveAccessTokenRow[]> {
  return tx.executeRaw<ActiveAccessTokenRow>(
    `SELECT id::text AS id, name, min_trust FROM access_tokens
      WHERE revoked_at IS NULL AND (id::text = $1 OR name = $1)
      ORDER BY id::text`, [target]);
}

/** A live token's requester-scope fields: its `--reads-unscoped` opt-out and its creation time. */
export interface AccessTokenScopeRow {
  reads_unscoped: unknown;
  created_at: unknown;
}

/** `reads_unscoped` and `created_at` of the token `id` names when it is not revoked, or null. */
export async function readLiveAccessTokenScope(tx: Raw, id: string): Promise<AccessTokenScopeRow | null> {
  const [row] = await tx.executeRaw<AccessTokenScopeRow>(
    'SELECT reads_unscoped, created_at FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL', [id]);
  return row ?? null;
}

/** Set (or clear, with null) one token's read floor by row id. A tier outside the six is 23514 (`access_tokens_min_trust_check`). */
export async function setAccessTokenMinTrust(tx: Raw, id: string, tier: string | null): Promise<void> {
  await tx.executeRaw('UPDATE access_tokens SET min_trust = $1 WHERE id = $2::uuid', [tier, id]);
}
