/**
 * Legacy bearer-token grants (`gbrain auth rescope --token`, alias
 * `auth rescope-token`), the token twin of `auth rescope --client`. Three axes:
 *
 *   - sources       (`--sources a,b|none`): element 0 = write source
 *   - takes holders (`--takes-holders a,b|none`)
 *   - operations    (`--operations a,b|none`, `--refresh-operations`)
 *   - private pages (`--private-pages granted-sources|none`): stored in
 *     `private_pages` only, never in the `permissions` mirror
 *   - private facts (`--private-facts granted-sources|none`, GBRA-575): stored
 *     in `private_facts` only, likewise
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
import { assertAllowedScopes, hasScope, operationScopesAllowed } from '../scope.ts';
import { isValidSourceId } from '../source-id.ts';
import type { SqlQuery } from '../sql-query.ts';
import { sharedReadSources } from './read-shared.ts';
import { TOKEN_ID_RE } from '../token-mint.ts';
import { isUndefinedColumnError } from '../utils.ts';
import { addedOnlyByName, requiresExplicitApproval } from '../ops/execution-prerequisites.ts';
import {
  GrantError, LEGACY_GRANT_AXES, grantFromTokenRow, permissionsMirror, tokenGrantColumnArrays, tokenGrantColumnValues, tokenGrantFromColumns,
  tokenGrantFromPermissions, validatePrincipalGrant, TOKEN_GRANT_COLUMNS, type LegacyGrantAxis, type PrincipalGrant, type PrivateFactsGrant, type PrivatePagesGrant,
} from './model.ts';
import { parsePrivateFactsFlag, parsePrivatePagesFlag, parseReadSharedFlag } from './cli.ts';

export type { LegacyGrantAxis } from './model.ts';

type TokenGrantAxes = Pick<PrincipalGrant, 'sources' | 'allowedOperations' | 'takesHolders'>;

export interface RescopeTokenArgs {
  target: { name: string } | { id: string };
  sources?: string[];
  takesHolders?: string[];
  operations?: string[];
  scopes?: string[];
  privatePages?: PrivatePagesGrant;
  privateFacts?: PrivateFactsGrant;
  /** GST-2898: `--read-shared on|off`, also read every shared source, now and later. */
  readShared?: boolean;
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
  /** Present only when granted, so a 'none' token's view is unchanged. */
  privatePages?: 'granted_sources';
  /** GST-2898: present only when the read-shared switch is on, so every other token's view is unchanged. */
  readShared?: true;
  /** GBRA-575: likewise. */
  privateFacts?: 'granted_sources';
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
  /**
   * `materialized`: the token had no operation snapshot (#6663). Adding writes one: every operation its scopes
   * allow today plus the added ones, so operations later upgrades add need their own refresh.
   */
  refresh?: { available: string[]; added: string[]; unregistered: string[]; materialized?: true };
  /**
   * GST-2898: the resolved read set before and after (stored list plus, with the switch on, every shared source now),
   * the sources the call stops reading, and the shared set it reads now when the switch is on after the call.
   */
  reads: { before: string[]; after: string[]; stops_reading: string[]; shared_now?: string[] };
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
      case '--private-pages': out.privatePages = parsePrivatePagesFlag(value); break;
      case '--read-shared': out.readShared = parseReadSharedFlag(value); break;
      case '--private-facts': out.privateFacts = parsePrivateFactsFlag(value); break;
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

function grantView(g: TokenGrantAxes & Pick<PrincipalGrant, 'privatePages' | 'privateFacts' | 'readShared'>): LegacyTokenGrantView {
  const s = g.sources;
  return {
    sources: s.kind === 'default' ? 'default' : s.kind === 'none' ? [] : s.kind === 'scalar' ? [s.writeSource] : [...s.readSources],
    takesHolders: g.takesHolders ?? ['world'],
    operations: g.allowedOperations ?? 'unrestricted',
    ...(g.privatePages === 'granted_sources' ? { privatePages: g.privatePages } : {}),
    ...(g.privateFacts === 'granted_sources' ? { privateFacts: g.privateFacts } : {}),
    ...(g.readShared === true ? { readShared: true as const } : {}),
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
  const active = new Set(await engine.filterUnarchivedSourceIds(ids));
  const missing = ids.filter(id => !active.has(id));
  if (missing.length) throw new GrantError('invalid_grant', `Unknown or archived source: ${missing.join(', ')} (see gbrain sources list)`);
}

const SCHEMA_HINT = 'this brain predates the unified token grant columns (access_tokens.source_grant); run `gbrain apply-migrations --yes` (no user decision needed), then retry';

function schemaError(error: unknown): unknown {
  return ['source_grant', 'grant_revision', 'private_pages', 'private_facts', 'read_shared_revision', ...TOKEN_GRANT_COLUMNS].some(c => isUndefinedColumnError(error, c)) ? new GrantError('grant_schema_required', SCHEMA_HINT) : error;
}

/** Write the unified columns and the `permissions` mirror in one UPDATE; returns the new revision. */
async function writeTokenGrant(tx: BrainEngine, row: Record<string, unknown>, grant: TokenGrantAxes, scopes?: string[], readShared = false): Promise<number> {
  const { assertScopeSourceGrant, sourcesOf } = await import('../access/attest-sources.ts');
  const before = sourcesOf(grantFromTokenRow(row).sources).reads;
  await assertScopeSourceGrant(tx, { kind: 'token', id: String(row.id) }, sourcesOf(grant.sources).reads.filter(s => !before.includes(s)), { writeSource: sourcesOf(grant.sources).write });
  const written = await tx.writeAccessTokenGrant(String(row.id), { columns: tokenGrantColumnArrays(grant), scopes: scopes ?? null, permissions: permissionsMirror(grant, row.permissions) });
  // No row updated: refuse with the text the raw RETURNING read threw, never a silent revision 0.
  if (written === null) throw new TypeError("undefined is not an object (evaluating 'written.grant_revision')");
  // GST-2898: re-stamp the read-shared switch at the new revision (or clear it) in the same transaction. A brain
  // without the column (migration pending) can only be cleared, which it already is.
  if (readShared || row.read_shared_revision != null) {
    await tx.setAccessTokenReadSharedRevision(String(row.id), readShared ? Number(written) : null);
  }
  return Number(written);
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
  const rows = await tx.lockActiveAccessTokens('id' in args.target ? { id: args.target.id } : { name: args.target.name });
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
    // #6663 (D17): a token with no snapshot reaches every operation its scopes allow except the membership
    // operations, which need explicit approval. Refreshing it materializes exactly that reachable set and
    // adds only the operations --add names, so nothing narrows today and no other membership op is approved.
    const materialized = base.allowedOperations === null;
    const granted = base.allowedOperations ?? grantable.filter(op => !requiresExplicitApproval(op));
    if (materialized && args.allNew) {
      throw new GrantError('invalid_grant', `Token ${label} has no operation snapshot; --all-new would approve every membership operation at once. `
        + `Preview with gbrain auth rescope ${'id' in args.target ? `--id ${args.target.id}` : `--token ${args.target.name}`} --refresh-operations, then name each one with --add`);
    }
    const available = grantable.filter(op => !granted.includes(op));
    const added = args.allNew ? available.filter(op => !addedOnlyByName(op)) : args.add ?? [];
    const notAvailable = added.filter(op => !available.includes(op));
    if (notAvailable.length) throw new GrantError('invalid_grant', `Not a new operation for this token: ${notAvailable.join(', ')} (run --refresh-operations alone to preview)`);
    if (added.length) next.allowedOperations = [...granted, ...added];
    refresh = { available, added, unregistered: granted.filter(op => !all.has(op)), ...(materialized ? { materialized: true } : {}) };
  }
  const opsEdited = args.operations !== undefined || Boolean(refresh?.added.length);
  validatePrincipalGrant({
    ...current, ...next,
    sources: args.sources !== undefined ? next.sources : { kind: 'default' },
    allowedOperations: opsEdited ? next.allowedOperations : null,
  }, { operationNames: all });

  const privatePages = args.privatePages ?? current.privatePages;
  const privateFacts = args.privateFacts ?? current.privateFacts;
  if (args.readShared === true && next.sources.kind === 'default') {
    throw new GrantError('invalid_grant', `Token "${name}" has no source list, so it already reads every shared source and --read-shared on has no write source to add shared reads to. `
      + `Ask the user which source the key writes to, then run gbrain auth rescope --token ${name} --sources <write-source> --read-shared on.`, ['read_shared_needs_source']);
  }
  const readShared = (args.readShared ?? current.readShared === true) && next.sources.kind !== 'default';
  if (readShared && next.sources.kind === 'none') {
    if (args.readShared !== true) throw (await import('./read-shared.ts')).readSharedNoSourceRefusal('token', name);
    throw new GrantError('invalid_grant', `Token "${name}" has no source (--sources none), so --read-shared on has no write source to add shared reads to. `
      + `Ask the user which source the key writes to, then run gbrain auth rescope --token ${name} --sources <write-source> --read-shared on.`, ['read_shared_needs_source']);
  }
  if (args.readShared !== undefined && !('read_shared_revision' in row)) {
    throw new GrantError('grant_schema_required', 'this brain predates the read-shared switch (access_tokens.read_shared_revision); run `gbrain apply-migrations --yes` (no user decision needed), then retry');
  }
  const edits = args.sources !== undefined || args.takesHolders !== undefined || opsEdited || args.reset.length > 0 || args.scopes !== undefined
    || args.privatePages !== undefined || args.privateFacts !== undefined || args.readShared !== undefined;
  if (edits && !args.adopt && current.drift.length) throw driftRefusal(name, id, current.drift);
  const before = grantView(current);
  const after = grantView({ ...next, privatePages, privateFacts, readShared });
  const changed = JSON.stringify(before) !== JSON.stringify(after)
    || (args.scopes !== undefined && JSON.stringify(args.scopes) !== JSON.stringify(current.scopes));
  const write = !args.dryRun && (edits || Boolean(args.adopt));
  const revision = write ? await writeTokenGrant(tx, row, next, args.scopes, readShared) : current.revision;
  if (write && privatePages !== current.privatePages) {
    await (await import('../access/attest-sources.ts')).assertScopeSourceGrant(tx, { kind: 'token', id }, [], { privatePages: privatePages === 'granted_sources' });
    await tx.writeAccessTokenPrivateGrant(id, 'private_pages', privatePages);
  }
  if (write && privateFacts !== current.privateFacts) {
    await (await import('../access/attest-sources.ts')).assertScopeSourceGrant(tx, { kind: 'token', id }, [], { privateFacts: privateFacts === 'granted_sources' });
    await tx.writeAccessTokenPrivateGrant(id, 'private_facts', privateFacts);
  }
  return {
    id, name, dryRun: args.dryRun, changed, before, after,
    shape: current.shape, migrated: write && current.shape === 'legacy_permissions', written: write,
    revision: { before: current.revision, after: revision }, drift: current.drift,
    ...(refresh ? { refresh } : {}),
    reads: await readsChange(tx, row, current, { ...current, ...next, scopes: args.scopes ?? current.scopes, readShared }),
  };
}

/** GST-2898: the token's resolved read set before and after a rescope, through the one resolver (credentialReadSources). */
async function readsChange(tx: BrainEngine, row: Record<string, unknown>, before: PrincipalGrant, after: PrincipalGrant): Promise<RescopeTokenResult['reads']> {
  const { credentialReadSources } = await import('./shared-exposure.ts');
  const member = typeof row.member_id === 'string' ? row.member_id : null;
  const [was, now] = [await credentialReadSources(tx, before, member), await credentialReadSources(tx, after, member)];
  const shared = after.readShared === true && after.sources.kind !== 'none' && hasScope(after.scopes, 'read')
    ? await sharedReadSources(tx, member).catch(() => undefined) : undefined;
  return { before: was, after: now, stops_reading: was.filter(s => !now.includes(s)), ...(shared ? { shared_now: shared } : {}) };
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
      const rows = await tx.lockLegacyAccessTokens();
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
export async function resolveTokenGrant(sql: SqlQuery, row: Record<string, unknown>, engine?: Pick<BrainEngine, 'convertLegacyAccessTokenGrant'>): Promise<PrincipalGrant> {
  const grant = grantFromTokenRow(row);
  if (grant.shape !== 'legacy_permissions' || grant.permissionsMalformed || !('source_grant' in row)) return grant;
  // With an engine the conversion is its member (engine-sql/access-credentials.ts LEGACY_TOKEN_CONVERT_SQL, the same
  // statement), so a store with no raw SQL (the Rust engine) converts too.
  if (engine) {
    try {
      const converted = await engine.convertLegacyAccessTokenGrant(String(row.id), tokenGrantColumnArrays(grant));
      if (converted) return grantFromTokenRow(converted);
    } catch {
      // As below: authorize with the identical in-memory conversion.
    }
    return grant;
  }
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
 * Given an engine it writes through the engine member (BEARER_SQL keeps the two texts equal).
 */
export function touchTokenLastUsed(sql: SqlQuery | BrainEngine, row: Record<string, unknown>): Promise<unknown> {
  const id = String(row.id);
  if (typeof sql !== 'function') return sql.touchAccessTokenLastUsed(id, 'source_grant' in row).catch(() => { /* fire-and-forget */ });
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
