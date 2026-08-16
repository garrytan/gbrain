/**
 * token-mint.ts — legacy bearer-token mint/revoke for programmatic callers
 * (#4043 `gbrain bootstrap harness`; extracted from src/commands/auth.ts's
 * private logic, using the canonical hashToken/generateToken from utils.ts).
 *
 * Least-privilege by construction: scopes land in the original-schema
 * `access_tokens.scopes TEXT[]` column (structurally immune to the
 * permissions-object-replacement wipe class), and the federation grant rides
 * `permissions.source_id` as an array (element 0 = write floor — the
 * parseLegacyTokenScope contract).
 *
 * Rotation contract [C7]: mint FIRST, revoke the previous token BY ID only
 * after the new one is wired and smoke-tested. revokeLegacyTokenById never
 * touches same-name siblings — names are not unique and may belong to
 * hand-minted tokens.
 */

import type { BrainEngine } from './engine.ts';
import { ALLOWED_SCOPES_LIST, assertAllowedScopes } from './scope.ts';
import { executeRawJsonb, type SqlQuery } from './sql-query.ts';
import { generateToken, hashToken, isUndefinedColumnError } from './utils.ts';

/** Canonical token-id shape — shared with the `auth revoke --id` CLI gate. */
export const TOKEN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MintLegacyTokenOpts {
  name: string;
  /** Per-token takes-holder allow-list; harness default ['world']. */
  takesHolders: string[];
  /** Scope grant → the scopes TEXT[] column. Must be non-empty known scopes. */
  scopes: string[];
  /**
   * Federation grant → permissions.source_id (array; element 0 = write
   * floor). Omit for the historical default-source floor.
   */
  sourceGrant?: string[];
}

export interface MintedLegacyToken {
  /** Plaintext token — shown/wired once, never stored. */
  token: string;
  /** Row id — the ONLY safe revocation key (names are not unique). */
  id: string;
  name: string;
  scopes: string[];
}

/**
 * Mint a scoped legacy bearer token. Throws on unknown/empty scopes (typos
 * fail loudly at mint time — the verify path treats a filtered-empty array
 * as deny, so a silent bad write would brick the token, not widen it).
 */
export async function mintLegacyToken(
  engine: BrainEngine,
  opts: MintLegacyTokenOpts,
): Promise<MintedLegacyToken> {
  if (!opts.name || !opts.name.trim()) {
    throw new Error('token name is required');
  }
  if (opts.scopes.length === 0) {
    throw new Error(`token scopes must be a non-empty subset of: ${ALLOWED_SCOPES_LIST.join(', ')}`);
  }
  assertAllowedScopes(opts.scopes);
  const takesHolders = opts.takesHolders.length > 0 ? opts.takesHolders : ['world'];

  const token = generateToken('gbrain_');
  const hash = hashToken(token);
  const permissions: Record<string, unknown> = { takes_holders: takesHolders };
  if (opts.sourceGrant && opts.sourceGrant.length > 0) {
    permissions.source_id = opts.sourceGrant;
  }

  // Scopes bind as a Postgres array literal through a TEXT param + ::text[]
  // cast — values are allowlisted ([a-z_]+), so the literal needs no quoting,
  // and the same SQL runs on both engines (a bare JS array param would bind
  // engine-dependently; the JSONB object goes through executeRawJsonb per the
  // repo invariant).
  const scopesLiteral = `{${opts.scopes.join(',')}}`;
  let rows: Array<{ id: string }>;
  try {
    rows = await executeRawJsonb<{ id: string }>(
      engine,
      `INSERT INTO access_tokens (name, token_hash, permissions, scopes)
       VALUES ($1, $2, $4::jsonb, $3::text[])
       RETURNING id`,
      [opts.name, hash, scopesLiteral],
      [permissions],
    );
  } catch (e) {
    // isUndefinedColumnError also matches message-shaped variants — some
    // driver-wrapped errors drop the SQLSTATE code.
    if (isUndefinedColumnError(e, 'scopes') || isUndefinedColumnError(e, 'permissions')) {
      throw new Error(
        'this brain is missing token columns (undefined column on access_tokens) — ' +
          'run `gbrain apply-migrations` and retry.',
      );
    }
    throw e;
  }
  const id = rows[0]?.id;
  if (!id) throw new Error('token insert returned no id');
  return { token, id, name: opts.name, scopes: [...opts.scopes] };
}

/**
 * Revoke exactly one token by row id. Returns false when no ACTIVE row with
 * that id exists (already revoked or never existed) — callers treat that as
 * already-done, not failure.
 */
export async function revokeLegacyTokenById(sql: SqlQuery, id: string): Promise<boolean> {
  if (!TOKEN_ID_RE.test(id)) {
    throw new Error(`not a token id (expected a UUID): ${id}`);
  }
  const rows = await sql`
    UPDATE access_tokens SET revoked_at = now()
    WHERE id = ${id}::uuid AND revoked_at IS NULL
    RETURNING 1 AS ok
  `;
  return rows.length > 0;
}
