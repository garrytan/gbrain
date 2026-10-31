/**
 * token-mint.ts — legacy bearer-token mint/revoke for programmatic callers
 * (#4043 `gbrain bootstrap harness`; extracted from src/commands/auth.ts's
 * private logic, using the canonical hashToken/generateToken from utils.ts).
 *
 * Least-privilege by construction: scopes land in the original-schema
 * `access_tokens.scopes TEXT[]` column (structurally immune to the
 * permissions-object-replacement wipe class). F3: the grant lands in the
 * unified columns (source_grant, source_id, federated_read,
 * allowed_operations, takes_holders) with a `permissions` JSONB mirror for
 * older binaries; the federation grant is an array, element 0 = write floor.
 *
 * Rotation contract [C7]: mint FIRST, revoke the previous token BY ID only
 * after the new one is wired and smoke-tested. revokeLegacyTokenById never
 * touches same-name siblings — names are not unique and may belong to
 * hand-minted tokens.
 */

import type { BrainEngine } from './engine.ts';
import { ALLOWED_SCOPES_LIST, assertAllowedScopes } from './scope.ts';
import type { SqlQuery } from './sql-query.ts';
import { opError } from './ops/contract.ts';
import { generateToken, hashToken, isUndefinedColumnError } from './utils.ts';
import { permissionsMirror, privatePagesFromColumn, tokenGrantColumnValues, tokenGrantFromPermissions, TOKEN_GRANT_COLUMNS, type GrantSources, type PrincipalGrant, type PrivatePagesGrant } from './grants/model.ts';

/** Canonical token-id shape — shared with the `auth revoke --id` CLI gate. */
export const TOKEN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MintLegacyTokenOpts {
  name: string;
  /** Per-token takes-holder allow-list; harness default ['world']. `[]` is stored as deny-all. */
  takesHolders: string[];
  /** Scope grant → the scopes TEXT[] column. Must be non-empty known scopes. */
  scopes: string[];
  /**
   * Federation grant → permissions.source_id (array; element 0 = write
   * floor). Omit for the historical default-source floor; `[]` is stored as
   * the explicit no-source grant.
   */
  sourceGrant?: string[];
  allowedOperations?: string[];
}

export interface MintedLegacyToken {
  /** Plaintext token — shown/wired once, never stored. */
  token: string;
  /** Row id — the ONLY safe revocation key (names are not unique). */
  id: string;
  name: string;
  scopes: string[];
  /** Rotation only: operations this run would grant that the carried snapshot withheld. */
  withheldOperations?: string[];
  /** Rotation only (#8104): the replaced token's private-pages grant, which a rotation never carries. */
  uncarriedPrivatePages?: Exclude<PrivatePagesGrant, 'none'>;
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
  if (opts.allowedOperations !== undefined) {
    const { operations } = await import('./operations.ts');
    const names = new Set(operations.filter(op => !op.localOnly).map(op => op.name));
    if (!Array.isArray(opts.allowedOperations) || opts.allowedOperations.some(name => !names.has(name))) {
      throw new Error('allowedOperations must contain only registered remote operation names');
    }
  }
  const token = generateToken('gbrain_');
  const sources: GrantSources = opts.sourceGrant === undefined ? { kind: 'default' }
    : opts.sourceGrant.length === 0 ? { kind: 'none' }
    : { kind: 'federated', writeSource: opts.sourceGrant[0], readSources: [...opts.sourceGrant] };
  const rows = await insertUnifiedToken(engine, {
    name: opts.name, tokenHash: hashToken(token), scopes: opts.scopes,
    grant: { sources, takesHolders: opts.takesHolders, allowedOperations: opts.allowedOperations === undefined ? null : [...new Set(opts.allowedOperations)] },
  });
  const id = rows[0]?.id;
  if (!id) throw new Error('token insert returned no id');
  return { token, id, name: opts.name, scopes: [...opts.scopes] };
}

/**
 * Insert a token born on the unified grant shape: the grant columns at
 * revision 1 plus the `permissions` JSONB mirror older binaries read
 * (`GRANT_MIRROR_WINDOW_ENDS`). A brain whose schema predates the columns
 * refuses with `migrations_pending` instead of writing a JSONB-only grant.
 * Scopes bind as a Postgres array literal through a TEXT param + ::text[]
 * (values are allowlisted); omitted scopes stay NULL (grandfathered full
 * access). The JSONB object binds as a raw object, exactly as executeRawJsonb
 * binds it (no double-encode).
 */
export async function insertUnifiedToken(engine: BrainEngine, opts: {
  name: string; tokenHash: string; scopes?: string[];
  grant: Pick<PrincipalGrant, 'sources' | 'allowedOperations' | 'takesHolders'>;
}): Promise<Array<{ id: string }>> {
  const scopes = opts.scopes === undefined ? null : `{${opts.scopes.join(',')}}`;
  try {
    return await engine.executeRaw<{ id: string }>(
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions, ${TOKEN_GRANT_COLUMNS.join(', ')}, grant_revision)
       VALUES ($1, $2, $3::text[], $4::jsonb, $5, $6, $7::text[], $8::text[], $9::text[], 1)
       RETURNING id`,
      [opts.name, opts.tokenHash, scopes, permissionsMirror(opts.grant, {}), ...tokenGrantColumnValues(opts.grant)],
    );
  } catch (e) {
    // isUndefinedColumnError also matches message-shaped variants: some
    // driver-wrapped errors drop the SQLSTATE code.
    if (['scopes', 'permissions', 'grant_revision', ...TOKEN_GRANT_COLUMNS].some(column => isUndefinedColumnError(e, column))) {
      throw opError('migrations_pending',
        'This brain is missing the access-token grant columns, so it cannot mint a token.',
        'Apply the pending schema migrations on the brain host, then mint the token again.',
        { why: 'Tokens are born on the unified grant columns; a brain whose schema predates them has not run its migrations.',
          fix: { argv: ['gbrain', 'apply-migrations', '--yes'], consent: [], actor: 'agent', requires_exclusive: true,
            why: 'Applies the pending schema migrations, including the token grant columns; no user decision needed.', verify: { argv: ['gbrain', 'doctor', '--json'] } } });
    }
    throw e;
  }
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

/**
 * #5893 rotation carry-over: the grants a rotated harness token inherits from
 * the token it replaces. Takes holders and the source grant are carried as
 * stored, explicit empty lists included (an explicit `--source` on this run
 * wins over the stored source grant). A stored operation snapshot is carried
 * as stored, narrowed to the operations this run would grant, plus only the
 * operations a skills-policy change adds; `[]` stays `[]`. Operations new
 * since the snapshot are withheld (reported, never silently granted): widen
 * with `gbrain auth rescope --token <name> --refresh-operations`.
 *
 * F3: the prior grant is read from its `permissions` JSONB through the shared
 * parser. On a unified row that JSONB mirrors the columns. On a drifted row
 * (an older gbrain edited the JSONB after migration) the edit is the newest
 * operator intent, so rotation carries it, the same resolution as
 * `auth rescope --adopt-permissions`; the replacement is born unified and the
 * drifted row is revoked after the swap.
 */
export function carryLegacyGrant(priorRaw: unknown, fresh: {
  sourceGrant?: string[]; explicitSource: boolean; allowedOperations: string[]; policyAdded: string[];
}): { takesHolders: string[]; sourceGrant?: string[]; allowedOperations: string[]; withheldOperations: string[] } {
  const prior = tokenGrantFromPermissions(priorRaw);
  const takesHolders = prior.takesHolders ?? ['world'];
  const stored = prior.sources;
  const storedSource = stored.kind === 'default' ? undefined : stored.kind === 'none' ? []
    : stored.kind === 'scalar' ? [stored.writeSource] : stored.readSources;
  const sourceGrant = fresh.explicitSource || storedSource === undefined ? fresh.sourceGrant : storedSource;
  const priorOps = prior.allowedOperations ?? undefined;
  if (priorOps === undefined) return { takesHolders, sourceGrant, allowedOperations: fresh.allowedOperations, withheldOperations: [] };
  const allowedOperations = priorOps.length === 0 ? [] : [...new Set([
    ...priorOps.filter(op => fresh.allowedOperations.includes(op)), ...fresh.policyAdded,
  ])].sort();
  return { takesHolders, sourceGrant, allowedOperations,
    withheldOperations: fresh.allowedOperations.filter(op => !allowedOperations.includes(op)) };
}

/**
 * #8104: an active token's private-pages grant. Rotation does not carry it (the replacement starts at `none`), so the
 * harness names the rescope that grants it again. `none` when the token is gone or the brain predates the column.
 */
export async function readActiveTokenPrivatePages(engine: BrainEngine, id: string): Promise<PrivatePagesGrant> {
  if (!TOKEN_ID_RE.test(id)) return 'none';
  try {
    const [row] = await engine.executeRaw<{ private_pages: unknown }>(
      'SELECT private_pages FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL', [id]);
    return privatePagesFromColumn(row?.private_pages);
  } catch (e) {
    if (isUndefinedColumnError(e, 'private_pages')) return 'none';
    throw e;
  }
}

/** #8104: the note a rotation prints beside the withheld-operations note when the replaced token had a private-pages grant. */
export function uncarriedPrivatePagesNote(name: string, mode: Exclude<PrivatePagesGrant, 'none'>): string {
  return `token ${name}: private-pages grant not carried; run \`gbrain auth rescope --token ${name} --private-pages ${mode.replace('_', '-')}\` to grant it again.`;
}

/** The stored grant of an active token, or undefined when it is gone or revoked. */
export async function readActiveTokenPermissions(engine: BrainEngine, id: string): Promise<unknown> {
  if (!TOKEN_ID_RE.test(id)) return undefined;
  const [row] = await engine.executeRaw<{ permissions: unknown }>(
    'SELECT permissions FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL', [id]);
  return row ? row.permissions ?? {} : undefined;
}
