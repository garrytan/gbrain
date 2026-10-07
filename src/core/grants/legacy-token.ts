/**
 * Legacy bearer-token grants (`gbrain auth rescope --token`, alias
 * `auth rescope-token`), the token twin of `auth rescope --client`. Three axes:
 *
 *   - sources       (`--sources a,b|none`): element 0 = write source
 *   - takes holders (`--takes-holders a,b|none`)
 *   - operations    (`--operations a,b|none`, `--refresh-operations`)
 *
 * `none` stores the explicit empty list (deny-all). An omitted flag preserves
 * the stored value. `--reset-default <axes>` restores the `auth create`
 * default for the named axes (no source grant → the historical `default`
 * floor; takes holders `['world']`; no operation snapshot).
 * `--refresh-operations` only previews unless `--add <op,...>` or `--all-new`
 * names the operations to widen by. With no grant flag the command only prints
 * the stored grants.
 *
 * F3 storage: every write lands in the unified columns (`source_grant`,
 * `source_id`, `federated_read`, `allowed_operations`, `takes_holders`), bumps
 * `grant_revision`, and rewrites `permissions` as a mirror with every other key
 * preserved, so older binaries enforce the same grant. Rows still on the
 * JSONB-only shape convert in bulk (migration v202, `--migrate-legacy`), on
 * their first HTTP read (`resolveTokenGrant`) or on their first write. A
 * drifted row (JSONB edited by an older binary) refuses grant edits until
 * `--adopt-permissions` or `--adopt-columns` resolves it.
 */
import type { BrainEngine } from '../engine.ts';
import { assertAllowedScopes, operationScopesAllowed } from '../scope.ts';
import { isValidSourceId } from '../source-id.ts';
import { executeRawJsonb, type SqlQuery } from '../sql-query.ts';
import { TOKEN_ID_RE } from '../token-mint.ts';
import { isUndefinedColumnError } from '../utils.ts';
import {
  GrantError, LEGACY_GRANT_AXES, grantFromTokenRow, permissionsMirror, tokenGrantColumnValues, tokenGrantFromColumns,
  tokenGrantFromPermissions, validatePrincipalGrant, TOKEN_GRANT_COLUMNS, type LegacyGrantAxis, type PrincipalGrant,
} from './model.ts';

export type { LegacyGrantAxis } from './model.ts';

type TokenGrantAxes = Pick<PrincipalGrant, 'sources' | 'allowedOperations' | 'takesHolders'>;

export interface RescopeTokenArgs {
  target: { name: string } | { id: string };
  sources?: string[];
  takesHolders?: string[];
  operations?: string[];
  scopes?: string[];
  reset: LegacyGrantAxis[];
  refreshOperations: boolean;
  add?: string[];
  allNew: boolean;
  adopt?: 'permissions' | 'columns';
  expectedRevision?: number;
  dryRun: boolean;
  json: boolean;
}

export interface LegacyTokenGrantView {
  sources: string[] | 'default';
  takesHolders: string[];
  operations: string[] | 'unrestricted';
}

export interface RescopeTokenResult {
  id: string;
  name: string;
  dryRun: boolean;
  changed: boolean;
  before: LegacyTokenGrantView;
  after: LegacyTokenGrantView;
  /** Grant shape before this call; `migrated` is true when this call wrote the unified columns for the first time. */
  shape: PrincipalGrant['shape'];
  migrated: boolean;
  written: boolean;
  revision: { before: number; after: number };
  /** Axes that were drifted (deny-all) before this call. */
  drift: LegacyGrantAxis[];
  refresh?: { available: string[]; added: string[]; unregistered: string[] };
}

const csvOrNone = (value: string): string[] =>
  value === 'none' ? [] : [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];

export function parseRescopeTokenArgs(args: string[]): RescopeTokenArgs {
  let target: RescopeTokenArgs['target'] | undefined;
  const out: Omit<RescopeTokenArgs, 'target'> = { reset: [], refreshOperations: false, allNew: false, dryRun: false, json: false };
  const adopt = (mode: 'permissions' | 'columns') => {
    if (out.adopt && out.adopt !== mode) throw new GrantError('invalid_grant', 'Pass either --adopt-permissions or --adopt-columns, not both');
    out.adopt = mode;
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--dry-run') { out.dryRun = true; continue; }
    if (flag === '--json') { out.json = true; continue; }
    if (flag === '--refresh-operations') { out.refreshOperations = true; continue; }
    if (flag === '--all-new') { out.allNew = true; continue; }
    if (flag === '--adopt-permissions') { adopt('permissions'); continue; }
    if (flag === '--adopt-columns') { adopt('columns'); continue; }
    if (!flag.startsWith('--')) {
      if (target) throw new GrantError('invalid_grant', `Unexpected argument: ${flag}`);
      target = { name: flag };
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new GrantError('invalid_grant', `${flag} requires a value`);
    switch (flag) {
      case '--id':
        if (target) throw new GrantError('invalid_grant', 'Pass either a token name or --id, not both');
        if (!TOKEN_ID_RE.test(value)) throw new GrantError('invalid_grant', '--id must be a token id from `gbrain auth list`');
        target = { id: value };
        break;
      case '--sources': out.sources = csvOrNone(value); break;
      case '--takes-holders': out.takesHolders = csvOrNone(value); break;
      case '--operations':
        if (value === 'all') throw new GrantError('invalid_grant', '--operations all applies to OAuth clients; to give a token every operation again, use --reset-default operations');
        out.operations = csvOrNone(value);
        break;
      case '--add': out.add = csvOrNone(value); break;
      case '--scopes':
        out.scopes = csvOrNone(value.replaceAll(' ', ','));
        if (out.scopes.length === 0) throw new GrantError('invalid_grant', '--scopes needs at least one scope (to cut a token off, use --sources none or gbrain auth revoke)');
        assertAllowedScopes(out.scopes);
        break;
      case '--if-version':
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new GrantError('invalid_grant', '--if-version must be a non-negative integer');
        out.expectedRevision = Number(value);
        break;
      case '--reset-default':
        for (const axis of csvOrNone(value)) {
          if (!(LEGACY_GRANT_AXES as readonly string[]).includes(axis)) throw new GrantError('invalid_grant', `--reset-default takes ${LEGACY_GRANT_AXES.join(', ')}`);
          out.reset.push(axis as LegacyGrantAxis);
        }
        break;
      default: throw new GrantError('invalid_grant', `Unknown flag: ${flag}`);
    }
  }
  if (!target) throw new GrantError('invalid_grant', 'Name the token to rescope (or pass --id <uuid>)');
  const set = { sources: out.sources, 'takes-holders': out.takesHolders, operations: out.operations };
  for (const axis of out.reset) {
    if (set[axis] !== undefined) throw new GrantError('invalid_grant', `--reset-default ${axis} conflicts with --${axis}`);
  }
  if ((out.add || out.allNew) && !out.refreshOperations) throw new GrantError('invalid_grant', '--add and --all-new require --refresh-operations');
  if (out.add && out.allNew) throw new GrantError('invalid_grant', 'Pass either --add or --all-new, not both');
  if (out.refreshOperations && (out.operations !== undefined || out.reset.includes('operations'))) {
    throw new GrantError('invalid_grant', '--refresh-operations cannot be combined with --operations or --reset-default operations');
  }
  return { target, ...out };
}

function grantView(g: TokenGrantAxes): LegacyTokenGrantView {
  const s = g.sources;
  return {
    sources: s.kind === 'default' ? 'default' : s.kind === 'none' ? [] : s.kind === 'scalar' ? [s.writeSource] : [...s.readSources],
    takesHolders: g.takesHolders ?? ['world'],
    operations: g.allowedOperations ?? 'unrestricted',
  };
}

/** Remote operations a token with these scopes could call: the refresh candidate set. */
async function grantableOperations(scopes: string[]): Promise<{ all: Set<string>; grantable: string[] }> {
  const { operations } = await import('../operations.ts');
  const remote = operations.filter(op => !op.localOnly);
  return {
    all: new Set(remote.map(op => op.name)),
    grantable: remote.filter(op => operationScopesAllowed(scopes, op)).map(op => op.name).sort(),
  };
}

async function assertActiveSources(engine: BrainEngine, ids: string[]): Promise<void> {
  for (const id of ids) {
    if (!isValidSourceId(id)) throw new GrantError('invalid_grant', `Invalid source id: ${id}`);
  }
  if (ids.length === 0) return;
  const rows = await engine.executeRaw<{ id: string }>(
    'SELECT id FROM sources WHERE id = ANY($1::text[]) AND archived IS NOT TRUE', [ids]);
  const active = new Set(rows.map(r => r.id));
  const missing = ids.filter(id => !active.has(id));
  if (missing.length) throw new GrantError('invalid_grant', `Unknown or archived source: ${missing.join(', ')} (see gbrain sources list)`);
}

const SCHEMA_HINT = 'this brain predates the unified token grant columns (access_tokens.source_grant); run `gbrain apply-migrations --yes` (no user decision needed), then retry';

function schemaError(error: unknown): unknown {
  return ['source_grant', 'grant_revision', ...TOKEN_GRANT_COLUMNS].some(c => isUndefinedColumnError(error, c)) ? new GrantError('grant_schema_required', SCHEMA_HINT) : error;
}

/** Write the unified columns and the `permissions` mirror in one UPDATE; returns the new revision. */
async function writeTokenGrant(tx: BrainEngine, row: Record<string, unknown>, grant: TokenGrantAxes, scopes?: string[]): Promise<number> {
  const [written] = await executeRawJsonb<{ grant_revision: number }>(
    tx,
    `UPDATE access_tokens SET source_grant = $2, source_id = $3, federated_read = $4::text[], allowed_operations = $5::text[],
       takes_holders = $6::text[], scopes = COALESCE($7::text[], scopes), grant_revision = grant_revision + 1, permissions = $8::jsonb
     WHERE id = $1::uuid RETURNING grant_revision`,
    [String(row.id), ...tokenGrantColumnValues(grant), scopes === undefined ? null : `{${scopes.join(',')}}`],
    [permissionsMirror(grant, row.permissions)],
  );
  return Number(written.grant_revision);
}

function driftRefusal(name: string, id: string, axes: readonly LegacyGrantAxis[]): GrantError {
  return new GrantError('invalid_grant',
    `Token "${name}" (${id}) has grant drift on ${axes.join(', ')}: its permissions JSON disagrees with the grant columns `
    + '(an older gbrain edited the JSON after migration), so those axes deny every request. Ask the user which grant is intended, then run '
    + `gbrain auth rescope --token ${name} --adopt-permissions (keep the JSON edit) or gbrain auth rescope --token ${name} --adopt-columns `
    + '(restore the columns), and retry.', ['legacy_token_grant_drift']);
}

export async function rescopeLegacyToken(engine: BrainEngine, args: RescopeTokenArgs): Promise<RescopeTokenResult> {
  try {
    return await engine.transaction(tx => rescopeInTransaction(tx, args));
  } catch (error) {
    throw schemaError(error);
  }
}

async function rescopeInTransaction(tx: BrainEngine, args: RescopeTokenArgs): Promise<RescopeTokenResult> {
  const rows = 'id' in args.target
    ? await tx.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL FOR UPDATE', [args.target.id])
    : await tx.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE name = $1 AND revoked_at IS NULL FOR UPDATE', [args.target.name]);
  const label = 'id' in args.target ? `id ${args.target.id}` : `"${args.target.name}"`;
  if (rows.length === 0) throw new GrantError('invalid_grant', `No active token ${label} (see gbrain auth list)`);
  if (rows.length > 1) throw new GrantError('invalid_grant', `${rows.length} active tokens are named ${label}; pass --id <uuid> from gbrain auth list`);
  const row = rows[0];
  const id = String(row.id);
  const name = String(row.name);
  const current = grantFromTokenRow(row);
  if (args.expectedRevision !== undefined && current.revision !== args.expectedRevision) {
    throw new GrantError('grant_conflict', `Token "${name}" is at grant revision ${current.revision}, not ${args.expectedRevision}: someone changed it since you read it. `
      + `Re-read it with gbrain auth rescope --token ${name} --json, then retry with --if-version ${current.revision}.`);
  }
  if (args.adopt === 'columns' && current.shape !== 'unified') {
    throw new GrantError('invalid_grant', `Token "${name}" has no grant columns yet, so there is nothing to adopt; its permissions JSON is the grant. Migrate it with gbrain auth rescope --migrate-legacy.`);
  }
  let base: TokenGrantAxes = current;
  if (args.adopt === 'permissions') {
    const { malformed: _, ...parsed } = tokenGrantFromPermissions(row.permissions);
    base = parsed;
  } else if (args.adopt === 'columns') {
    base = tokenGrantFromColumns(row);
  }

  const next: TokenGrantAxes = { ...base };
  if (args.sources !== undefined) {
    await assertActiveSources(tx, args.sources);
    next.sources = args.sources.length === 0 ? { kind: 'none' } : { kind: 'federated', writeSource: args.sources[0], readSources: args.sources };
  }
  if (args.takesHolders !== undefined) next.takesHolders = args.takesHolders;
  const { all, grantable } = await grantableOperations(args.scopes ?? current.scopes);
  if (args.operations !== undefined) {
    const unknown = args.operations.filter(op => !all.has(op));
    if (unknown.length) throw new GrantError('invalid_grant', `Unknown remote operation: ${unknown.join(', ')}`);
    next.allowedOperations = args.operations;
  }
  for (const axis of args.reset) {
    if (axis === 'sources') next.sources = { kind: 'default' };
    if (axis === 'takes-holders') next.takesHolders = ['world'];
    if (axis === 'operations') next.allowedOperations = null;
  }
  let refresh: RescopeTokenResult['refresh'];
  if (args.refreshOperations) {
    const granted = base.allowedOperations;
    if (granted === null) {
      throw new GrantError('invalid_grant', `Token ${label} has no operation snapshot, so it already reaches every operation its scopes allow; nothing to refresh`);
    }
    const available = grantable.filter(op => !granted.includes(op));
    const added = args.allNew ? available : args.add ?? [];
    const notAvailable = added.filter(op => !available.includes(op));
    if (notAvailable.length) throw new GrantError('invalid_grant', `Not a new operation for this token: ${notAvailable.join(', ')} (run --refresh-operations alone to preview)`);
    if (added.length) next.allowedOperations = [...granted, ...added];
    refresh = { available, added, unregistered: granted.filter(op => !all.has(op)) };
  }
  const opsEdited = args.operations !== undefined || Boolean(refresh?.added.length);
  validatePrincipalGrant({
    ...current, ...next,
    sources: args.sources !== undefined ? next.sources : { kind: 'default' },
    allowedOperations: opsEdited ? next.allowedOperations : null,
  }, { operationNames: all });

  const edits = args.sources !== undefined || args.takesHolders !== undefined || opsEdited || args.reset.length > 0 || args.scopes !== undefined;
  if (edits && !args.adopt && current.drift.length) throw driftRefusal(name, id, current.drift);
  const before = grantView(current);
  const after = grantView(next);
  const changed = JSON.stringify(before) !== JSON.stringify(after)
    || (args.scopes !== undefined && JSON.stringify(args.scopes) !== JSON.stringify(current.scopes));
  const write = !args.dryRun && (edits || Boolean(args.adopt));
  const revision = write ? await writeTokenGrant(tx, row, next, args.scopes) : current.revision;
  return {
    id, name, dryRun: args.dryRun, changed, before, after,
    shape: current.shape, migrated: write && current.shape === 'legacy_permissions', written: write,
    revision: { before: current.revision, after: revision }, drift: current.drift,
    ...(refresh ? { refresh } : {}),
  };
}

export interface MigrateLegacyResult {
  dryRun: boolean;
  migrated: Array<{ id: string; name: string; grant: LegacyTokenGrantView }>;
  skipped: Array<{ id: string; name: string; reason: 'permissions_malformed'; fix: string }>;
}

/**
 * `auth rescope --migrate-legacy`: write the unified columns for every active
 * token still on the JSONB-only shape, without changing any effective grant.
 * A malformed `permissions` value has no column equivalent (the HTTP paths
 * read it as no grant while publication denies it), so it is skipped and
 * reported with the command that gives it an explicit grant.
 */
export async function migrateLegacyTokens(engine: BrainEngine, opts: { dryRun: boolean }): Promise<MigrateLegacyResult> {
  try {
    return await engine.transaction(async tx => {
      const rows = await tx.executeRaw<Record<string, unknown>>(
        'SELECT * FROM access_tokens WHERE revoked_at IS NULL AND source_grant IS NULL ORDER BY created_at, id FOR UPDATE');
      const result: MigrateLegacyResult = { dryRun: opts.dryRun, migrated: [], skipped: [] };
      for (const row of rows) {
        const grant = grantFromTokenRow(row);
        const entry = { id: String(row.id), name: String(row.name) };
        if (grant.permissionsMalformed) {
          result.skipped.push({ ...entry, reason: 'permissions_malformed',
            fix: `ask the user which grant this token should hold, then run gbrain auth rescope --id ${entry.id} --reset-default sources,takes-holders,operations (or pass explicit --sources/--takes-holders/--operations)` });
          continue;
        }
        if (!opts.dryRun) await writeTokenGrant(tx, row, grant);
        result.migrated.push({ ...entry, grant: grantView(grant) });
      }
      return result;
    });
  } catch (error) {
    throw schemaError(error);
  }
}

/**
 * The authorization read of an active token row on the HTTP auth paths. A
 * unified row is read from its columns. A row still on the legacy shape
 * (created by an older binary after the bulk migration, or on a brain whose
 * migration has not run) is converted on this read: one guarded UPDATE writes
 * the columns `migrateLegacyTokens` would write and leaves `permissions` as
 * the mirror it already is. The guard (`source_grant IS NULL`) makes
 * concurrent first reads a no-op for the loser, SKIP LOCKED keeps a row lock
 * held elsewhere from parking the request (#5730), and a skipped or failed
 * write (a locked row, a read-only role, a schema without the columns) falls
 * back to the same grant computed in memory. A malformed row is never converted; it
 * stays deny-all.
 */
export async function resolveTokenGrant(sql: SqlQuery, row: Record<string, unknown>): Promise<PrincipalGrant> {
  const grant = grantFromTokenRow(row);
  if (grant.shape !== 'legacy_permissions' || grant.permissionsMalformed || !('source_grant' in row)) return grant;
  const [kind, write, reads, ops, holders] = tokenGrantColumnValues(grant);
  try {
    const [converted] = await sql`
      UPDATE access_tokens SET source_grant = ${kind}, source_id = ${write}, federated_read = ${reads}::text[],
        allowed_operations = ${ops}::text[], takes_holders = ${holders}::text[], grant_revision = grant_revision + 1,
        last_used_at = now()
      WHERE id IN (SELECT id FROM access_tokens WHERE id = ${String(row.id)}::uuid AND source_grant IS NULL FOR UPDATE SKIP LOCKED)
      RETURNING *
    `;
    if (converted) return grantFromTokenRow(converted);
  } catch {
    // Read-only role or transient failure: authorize with the identical in-memory conversion.
  }
  return grant;
}

/**
 * Debounced, fire-and-forget `last_used_at` write for a token row the auth
 * paths just read (once per token per 60 s; SKIP LOCKED so a lock held
 * elsewhere never parks a pool slot, #5730). A row still on the legacy shape
 * is left to `resolveTokenGrant`, whose conversion records first use itself:
 * a touch holding that row's lock made every concurrent conversion skip it
 * (SKIP LOCKED), so a burst of first reads could leave it unconverted (#6230).
 */
export function touchTokenLastUsed(sql: SqlQuery, row: Record<string, unknown>): Promise<unknown> {
  const id = String(row.id);
  const touch = 'source_grant' in row
    ? sql`UPDATE access_tokens SET last_used_at = now()
        WHERE id IN (SELECT id FROM access_tokens WHERE id = ${id}::uuid AND source_grant IS NOT NULL
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED)`
    : sql`UPDATE access_tokens SET last_used_at = now()
        WHERE id IN (SELECT id FROM access_tokens WHERE id = ${id}::uuid
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED)`;
  return Promise.resolve(touch).catch(() => { /* fire-and-forget */ });
}

/** A bare `auth rescope <name>`: a token name, an OAuth client id, or a client name. Both kinds matching refuses. */
export async function resolveRescopeTarget(engine: BrainEngine, name: string): Promise<{ kind: 'token' } | { kind: 'client'; clientId: string }> {
  const tokens = await engine.executeRaw<{ id: string }>('SELECT id FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [name]);
  const clients = await engine.executeRaw<{ client_id: string }>(
    'SELECT client_id FROM oauth_clients WHERE (client_id = $1 OR client_name = $1) AND deleted_at IS NULL', [name]);
  if (tokens.length && clients.length) {
    throw new GrantError('invalid_grant', `"${name}" names both a legacy token and an OAuth client; pass --token ${name} or --client ${clients[0].client_id}`, ['rescope_target_ambiguous']);
  }
  if (clients.length > 1) {
    throw new GrantError('invalid_grant', `"${name}" names ${clients.length} OAuth clients (${clients.map(c => c.client_id).join(', ')}); pass --client <client-id> from gbrain auth clients`, ['rescope_target_ambiguous']);
  }
  if (clients.length === 1) return { kind: 'client', clientId: clients[0].client_id };
  if (tokens.length) return { kind: 'token' };
  throw new GrantError('invalid_grant', `No active token or OAuth client named "${name}" (see gbrain auth list and gbrain auth clients)`);
}

export function renderLegacyGrantAxis(value: string[] | 'default' | 'unrestricted'): string {
  if (value === 'default') return 'default (no source grant)';
  if (value === 'unrestricted') return 'unrestricted (every operation the scopes allow)';
  return value.length === 0 ? 'none (deny-all)' : value.join(', ');
}
