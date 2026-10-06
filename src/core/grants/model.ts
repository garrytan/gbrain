import { assertAllowedScopes, hasScope, parseScopeString } from '../scope.ts';
import { coerceLegacyPermissions, normalizeTokenScopes, parseLegacyOperationGrant, parseLegacyTokenScope, parseTakesHoldersAllowList } from '../legacy-token-scope.ts';
import { NO_SOURCES, isValidSourceId } from '../source-id.ts';
import { pgArray } from './encoding.ts';

export const GRANT_PROFILES = ['memory-reader', 'memory-writer', 'coding-agent', 'operator', 'delegating-agent', 'full'] as const;
export type GrantProfileId = typeof GRANT_PROFILES[number];
export type GrantSurface = 'verbs' | 'starter' | 'full';

/** Access-token lifetime bounds for every per-client override and the server default: 1 minute to 90 days. */
export const TOKEN_TTL_MIN_SECONDS = 60;
export const TOKEN_TTL_MAX_SECONDS = 7_776_000;

/** SQL NULL operation snapshots preserve legacy clients; [] grants no operations. */
export interface ClientGrant {
  clientId: string;
  clientName: string;
  scopes: string[];
  sourceId: string | null;
  federatedRead: string[];
  /** The explicit no-source grant: `sourceId` null, `federatedRead` empty, every read and write refused. */
  sourcesNone: boolean;
  /** Takes-holder allow-list; null = the default ['world'], [] = deny-all. */
  takesHolders: string[] | null;
  boundSlugPrefixes: string[] | null;
  allowedOperations: string[] | null;
  boundTools: string[] | null;
  boundSourceId: string | null;
  boundBrainId: string | null;
  delegatedSlugPrefixes: string[] | null;
  delegatedNamespace: 'prefixes' | 'job';
  boundMaxConcurrent: number;
  budgetUsdPerDay: string | null;
  surface: GrantSurface | null;
  surfaceSetBy: string | null;
  tokenTtlSeconds: number | null;
  profile: GrantProfileId | null;
  revision: number;
  repairReasons: string[];
  revoked: boolean;
}

export type GrantPatch = Partial<Omit<ClientGrant, 'clientId' | 'clientName' | 'revision' | 'revoked'>>;
export interface GrantValidationContext {
  activeSourceIds: ReadonlySet<string>;
  operationNames: ReadonlySet<string>;
  delegateToolNames: ReadonlySet<string>;
  servingBrainId?: string;
}

export class GrantError extends Error {
  constructor(public readonly code: 'invalid_grant' | 'grant_conflict' | 'client_not_found' | 'grant_schema_required', message: string, public readonly reasons: string[] = []) {
    super(message);
    this.name = 'GrantError';
  }
}

export function intersectGrantedScopes(issued: readonly string[], current: readonly string[]): string[] {
  // Intersect capabilities, not spelling: issued admin ∩ current write = write/read.
  const effective = issued.filter(scope => hasScope(current, scope));
  for (const scope of current) {
    if (hasScope(issued, scope) && !hasScope(effective, scope)) effective.push(scope);
  }
  return effective;
}

export function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(v => typeof v === 'string') ? [...value] : null;
}
export function normalizeGrantBrain(value: string | null): string | null {
  return value === 'host' || value === 'current' ? null : value;
}

export function grantFromRow(row: Record<string, unknown>): ClientGrant {
  const nullable = (v: unknown): string | null => typeof v === 'string' ? v : null;
  const legacyPrefixes = stringArray(row.bound_slug_prefixes);
  return {
    clientId: String(row.client_id), clientName: String(row.client_name ?? ''),
    scopes: parseScopeString(nullable(row.scope) ?? ''),
    sourceId: nullable(row.source_id), federatedRead: stringArray(row.federated_read) ?? [],
    sourcesNone: row.source_grant === 'none', takesHolders: stringArray(row.takes_holders),
    boundSlugPrefixes: legacyPrefixes, allowedOperations: stringArray(row.allowed_operations),
    boundTools: stringArray(row.bound_tools), boundSourceId: nullable(row.bound_source_id),
    boundBrainId: normalizeGrantBrain(nullable(row.bound_brain_id)),
    // Only a missing COLUMN denotes the pre-split schema. Explicit NULL never
    // reactivates a direct fence as a delegated grant.
    delegatedSlugPrefixes: 'delegated_slug_prefixes' in row ? stringArray(row.delegated_slug_prefixes) : legacyPrefixes,
    delegatedNamespace: row.delegated_namespace === 'job' || (!('delegated_namespace' in row) && legacyPrefixes === null) ? 'job' : 'prefixes',
    boundMaxConcurrent: Number(row.bound_max_concurrent ?? 1),
    budgetUsdPerDay: row.budget_usd_per_day == null ? null : String(row.budget_usd_per_day),
    surface: nullable(row.surface) as GrantSurface | null, surfaceSetBy: nullable(row.surface_set_by),
    tokenTtlSeconds: row.token_ttl == null ? null : Number(row.token_ttl),
    profile: nullable(row.grant_profile) as GrantProfileId | null,
    revision: Number(row.grant_revision ?? 0), repairReasons: stringArray(row.grant_repair_reasons) ?? [],
    revoked: row.deleted_at != null,
  };
}

export function validGrantPrefixes(prefixes: readonly string[] | null): boolean {
  return prefixes !== null && prefixes.length > 0 && prefixes.every(p =>
    typeof p === 'string' && p.trim() === p && !/\s/.test(p) && p === p.toLowerCase()
    && p !== '/' && p !== '/*' && !p.includes('..')
    && (p.endsWith('/') || p.endsWith('/*')));
}

export function delegationReasons(grant: ClientGrant, ctx: GrantValidationContext): string[] {
  const reasons: string[] = [];
  if (grant.revoked) reasons.push('client_revoked');
  if (!hasScope(grant.scopes, 'agent')) reasons.push('agent_scope_missing');
  if (!grant.boundTools?.length) reasons.push('delegated_tools_missing');
  else if (grant.boundTools.some(name => !ctx.delegateToolNames.has(name))) reasons.push('delegated_tools_unavailable');
  if (!grant.sourceId || !ctx.activeSourceIds.has(grant.sourceId)) reasons.push('source_inactive');
  if (!grant.boundSourceId || grant.boundSourceId !== grant.sourceId) reasons.push('delegated_source_mismatch');
  if (!grant.sourceId || !grant.federatedRead.includes(grant.sourceId)) reasons.push('delegated_read_source_missing');
  if (grant.boundBrainId !== null && grant.boundBrainId !== ctx.servingBrainId) reasons.push('delegated_brain_unavailable');
  if (grant.delegatedNamespace === 'prefixes' && !validGrantPrefixes(grant.delegatedSlugPrefixes)) reasons.push('delegated_prefixes_missing');
  if (grant.delegatedNamespace === 'job' && grant.delegatedSlugPrefixes !== null) reasons.push('delegated_namespace_ambiguous');
  if (!['prefixes', 'job'].includes(grant.delegatedNamespace)) reasons.push('delegated_namespace_invalid');
  if (!Number.isSafeInteger(grant.boundMaxConcurrent) || grant.boundMaxConcurrent < 1) reasons.push('concurrency_invalid');
  return reasons;
}

export function validateClientGrant(grant: ClientGrant, ctx: GrantValidationContext): void {
  assertAllowedScopes(grant.scopes);
  const reasons: string[] = [];
  if (grant.revoked) reasons.push('client_revoked');
  if (grant.sourcesNone === true) {
    if (grant.sourceId !== null || grant.federatedRead.length > 0) reasons.push('sources_none_inconsistent');
  } else {
    if (!grant.sourceId || !ctx.activeSourceIds.has(grant.sourceId)) reasons.push('source_inactive');
    if (grant.federatedRead.length === 0 || grant.federatedRead.some(id => !ctx.activeSourceIds.has(id))) reasons.push('read_source_inactive');
  }
  if (grant.takesHolders != null && grant.takesHolders.some(h => typeof h !== 'string' || !h || /[\s,{}"]/.test(h))) reasons.push('takes_holders_invalid');
  if (grant.boundSlugPrefixes !== null && !validGrantPrefixes(grant.boundSlugPrefixes)) reasons.push('direct_prefixes_invalid');
  if (grant.allowedOperations?.some(name => !ctx.operationNames.has(name))) reasons.push('operations_unavailable');
  if (grant.profile !== null && grant.allowedOperations === null) reasons.push('operations_snapshot_missing');
  if (grant.budgetUsdPerDay !== null && (!/^\d+(?:\.\d{1,2})?$/.test(grant.budgetUsdPerDay) || Number(grant.budgetUsdPerDay) > 99999999.99)) reasons.push('budget_invalid');
  if (grant.tokenTtlSeconds !== null && (!Number.isSafeInteger(grant.tokenTtlSeconds) || grant.tokenTtlSeconds < TOKEN_TTL_MIN_SECONDS || grant.tokenTtlSeconds > TOKEN_TTL_MAX_SECONDS)) reasons.push('token_ttl_invalid');
  if (grant.surface !== null && !['verbs', 'starter', 'full'].includes(grant.surface)) reasons.push('surface_invalid');
  if (grant.profile !== null && !(GRANT_PROFILES as readonly string[]).includes(grant.profile)) reasons.push('profile_invalid');
  if (!Number.isSafeInteger(grant.boundMaxConcurrent) || grant.boundMaxConcurrent < 1) reasons.push('concurrency_invalid');
  if (hasScope(grant.scopes, 'agent')) reasons.push(...delegationReasons(grant, ctx));
  if (reasons.length) throw new GrantError('invalid_grant', `Invalid client grant: ${[...new Set(reasons)].join(', ')}`, [...new Set(reasons)]);
}

// ---------------------------------------------------------------------------
// F3: one grant shape for legacy bearer tokens and OAuth clients.
// ---------------------------------------------------------------------------

export type LegacyGrantAxis = 'sources' | 'takes-holders' | 'operations';
export const LEGACY_GRANT_AXES: readonly LegacyGrantAxis[] = ['sources', 'takes-holders', 'operations'];

/** For tokens `readSources[0] === writeSource`; a client's read set may differ from its write source. */
export type GrantSources =
  | { kind: 'default' }
  | { kind: 'scalar'; writeSource: string }
  | { kind: 'federated'; writeSource: string; readSources: string[] }
  | { kind: 'none' };

export interface PrincipalGrant {
  principal: { kind: 'oauth_client' | 'legacy_token'; id: string };
  /** Tokens: `normalizeTokenScopes`, NULL grandfathered to read/write/admin. */
  scopes: string[];
  sources: GrantSources;
  /** null = every operation the scopes allow; [] = none. */
  allowedOperations: string[] | null;
  /** null = the default ['world']; [] = deny-all. */
  takesHolders: string[] | null;
  revision: number;
  shape: 'unified' | 'legacy_permissions';
  /**
   * Unified rows only: axes whose `permissions` mirror disagrees with the
   * columns (an older gbrain edited the JSONB). Each listed axis is already
   * deny-all in this grant until `auth rescope --adopt-permissions` or
   * `--adopt-columns` resolves it.
   */
  drift: LegacyGrantAxis[];
  /**
   * Legacy rows only: `permissions` is present but not a JSON object. It has
   * no column equivalent, so every axis of the grant is deny-all until an
   * operator gives the token an explicit grant (`auth rescope --id`).
   */
  permissionsMalformed: boolean;
}

/**
 * Tokens keep a `permissions` JSONB mirror of their grant columns so gbrain
 * binaries older than the unified grant shape enforce the same grant. Until
 * this date (30 days after the release that converted every legacy grant in
 * bulk) the mirror is written on every grant write and drift between it and
 * the columns denies the drifted axis; doctor reports the date. Authorization
 * reads the columns; the mirror is only compared, never granted from.
 */
export const GRANT_MIRROR_WINDOW_ENDS = '2026-11-04';

type TokenGrantAxes = Pick<PrincipalGrant, 'sources' | 'allowedOperations' | 'takesHolders'>;

/** The grant a `permissions` JSONB value carries, read with lane F's parsers. */
export function tokenGrantFromPermissions(raw: unknown): TokenGrantAxes & { malformed: boolean } {
  const permissions = coerceLegacyPermissions(raw);
  let sources: GrantSources = { kind: 'default' };
  if (permissions?.source_id != null) {
    // Non-null garbage keeps lane F's `default` floor WITH a source grant
    // (hasSourceGrant=true), which is exactly a scalar 'default' grant.
    const parsed = parseLegacyTokenScope(permissions.source_id);
    sources = parsed.allowedSources?.length === 0 ? { kind: 'none' }
      : parsed.allowedSources ? { kind: 'federated', writeSource: parsed.sourceId, readSources: parsed.allowedSources }
      : { kind: 'scalar', writeSource: parsed.sourceId };
  }
  return {
    sources,
    allowedOperations: parseLegacyOperationGrant(permissions?.allowed_operations) ?? null,
    takesHolders: parseTakesHoldersAllowList(permissions?.takes_holders) ?? null,
    malformed: raw != null && permissions === undefined,
  };
}

/** A TEXT[] column value; anything but NULL or a string array denies (fail-closed). */
function columnList(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.every(v => typeof v === 'string') ? [...value] : [];
  if (typeof value === 'string' && /^\{.*\}$/.test(value.trim())) {
    const inner = value.trim().slice(1, -1);
    return inner === '' ? [] : inner.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
  }
  return [];
}

/** The grant the unified columns carry; an inconsistent source state reads as `none`. */
export function tokenGrantFromColumns(row: Record<string, unknown>): TokenGrantAxes {
  const write = typeof row.source_id === 'string' && row.source_id.length > 0 ? row.source_id : null;
  const reads = columnList(row.federated_read);
  let sources: GrantSources = { kind: 'none' };
  if (row.source_grant === 'default') sources = { kind: 'default' };
  else if (row.source_grant === 'scalar' && write) sources = { kind: 'scalar', writeSource: write };
  else if (row.source_grant === 'federated' && write && reads?.length && reads[0] === write) {
    sources = { kind: 'federated', writeSource: write, readSources: reads };
  }
  return { sources, allowedOperations: columnList(row.allowed_operations), takesHolders: columnList(row.takes_holders) };
}

const sortedSet = (list: readonly string[]): string => JSON.stringify([...new Set(list)].sort());

function sameAxis(axis: LegacyGrantAxis, a: TokenGrantAxes, b: TokenGrantAxes): boolean {
  if (axis === 'sources') return JSON.stringify(a.sources) === JSON.stringify(b.sources);
  if (axis === 'takes-holders') return sortedSet(a.takesHolders ?? ['world']) === sortedSet(b.takesHolders ?? ['world']);
  return a.allowedOperations === null || b.allowedOperations === null
    ? a.allowedOperations === b.allowedOperations
    : sortedSet(a.allowedOperations) === sortedSet(b.allowedOperations);
}

/**
 * The effective grant of an `access_tokens` row (SELECT * keeps this working
 * on brains that predate the columns). Unified rows read the columns, and any
 * axis whose JSONB mirror disagrees evaluates deny-all. A `source_grant IS
 * NULL` row has not been converted yet (the bulk migration converts every
 * active one; an older binary's `auth create` can still add one): it reads as
 * the conversion `migrateLegacyTokens` would write, and a malformed
 * `permissions` value denies every axis.
 */
export function grantFromTokenRow(row: Record<string, unknown>): PrincipalGrant {
  const base = {
    principal: { kind: 'legacy_token' as const, id: String(row.id) },
    scopes: normalizeTokenScopes(row.scopes) ?? ['read', 'write', 'admin'],
    revision: Number(row.grant_revision ?? 0),
  };
  const { malformed, ...legacy } = tokenGrantFromPermissions(row.permissions);
  if (row.source_grant == null) {
    const axes: TokenGrantAxes = malformed ? { sources: { kind: 'none' }, allowedOperations: [], takesHolders: [] } : legacy;
    return { ...base, ...axes, shape: 'legacy_permissions', drift: [], permissionsMalformed: malformed };
  }
  const columns = tokenGrantFromColumns(row);
  const drift = LEGACY_GRANT_AXES.filter(axis => malformed || !sameAxis(axis, columns, legacy));
  return {
    ...base, shape: 'unified', drift, permissionsMalformed: false,
    sources: drift.includes('sources') ? { kind: 'none' } : columns.sources,
    allowedOperations: drift.includes('operations') ? [] : columns.allowedOperations,
    takesHolders: drift.includes('takes-holders') ? [] : columns.takesHolders,
  };
}

export function grantFromClient(grant: ClientGrant): PrincipalGrant {
  const sources: GrantSources = grant.sourcesNone === true ? { kind: 'none' }
    : grant.sourceId === null ? { kind: 'default' }
    : grant.federatedRead.length === 0 ? { kind: 'scalar', writeSource: grant.sourceId }
    : { kind: 'federated', writeSource: grant.sourceId, readSources: [...grant.federatedRead] };
  return {
    principal: { kind: 'oauth_client', id: grant.clientId }, scopes: [...grant.scopes], sources,
    allowedOperations: grant.allowedOperations, takesHolders: grant.takesHolders ?? null, revision: grant.revision,
    shape: 'unified', drift: [], permissionsMalformed: false,
  };
}

/** The AuthInfo source fields, exactly as lane F derived them from `permissions.source_id`. */
export function authSourcesFromGrant(g: PrincipalGrant): { sourceId: string; allowedSources?: string[]; hasSourceGrant: boolean } {
  switch (g.sources.kind) {
    case 'default': return { sourceId: 'default', hasSourceGrant: false };
    case 'scalar': return { sourceId: g.sources.writeSource, hasSourceGrant: true };
    case 'federated': return { sourceId: g.sources.writeSource, allowedSources: [...g.sources.readSources], hasSourceGrant: true };
    case 'none': return { sourceId: NO_SOURCES, allowedSources: [], hasSourceGrant: true };
  }
}

/**
 * Shape rules for a grant about to be written. Whether named sources are
 * active is the caller's database check. Tokens and OAuth clients may both
 * hold the explicit deny-all `none`.
 */
export function validatePrincipalGrant(g: PrincipalGrant, ctx: { operationNames: ReadonlySet<string> }): void {
  const reasons: string[] = [];
  const client = g.principal.kind === 'oauth_client';
  if (g.sources.kind === 'scalar' || g.sources.kind === 'federated') {
    const ids = g.sources.kind === 'scalar' ? [g.sources.writeSource] : [g.sources.writeSource, ...g.sources.readSources];
    if (ids.some(id => !isValidSourceId(id))) reasons.push('source_invalid');
    if (g.sources.kind === 'federated' && (g.sources.readSources.length === 0 || (!client && g.sources.readSources[0] !== g.sources.writeSource))) reasons.push('read_sources_invalid');
  }
  if (g.allowedOperations?.some(name => !ctx.operationNames.has(name))) reasons.push('operations_unavailable');
  if (!reasons.length) return;
  throw new GrantError('invalid_grant', `Invalid ${client ? 'client' : 'token'} grant: ${reasons.join(', ')}.`, reasons);
}

/**
 * The `permissions` JSONB written beside the columns so older binaries, which
 * read only JSONB, enforce the same grant. Unrelated keys are preserved; a
 * malformed value is replaced by an object.
 */
export function permissionsMirror(g: Pick<PrincipalGrant, 'sources' | 'allowedOperations' | 'takesHolders'>, existing: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(coerceLegacyPermissions(existing) ?? {}) };
  if (g.sources.kind === 'default') delete out.source_id;
  else out.source_id = g.sources.kind === 'none' ? [] : g.sources.kind === 'scalar' ? g.sources.writeSource : [...g.sources.readSources];
  if (g.takesHolders === null) delete out.takes_holders;
  else out.takes_holders = [...g.takesHolders];
  if (g.allowedOperations === null) delete out.allowed_operations;
  else out.allowed_operations = [...g.allowedOperations];
  return out;
}

/**
 * Bind values for the unified columns, in order: source_grant, source_id,
 * federated_read, allowed_operations, takes_holders (arrays as text[]
 * literals, NULL as null). Pair with `TOKEN_GRANT_COLUMNS`.
 */
export function tokenGrantColumnValues(g: Pick<PrincipalGrant, 'sources' | 'allowedOperations' | 'takesHolders'>): [string, string | null, string | null, string | null, string | null] {
  const s = g.sources;
  return [
    s.kind,
    s.kind === 'scalar' || s.kind === 'federated' ? s.writeSource : null,
    s.kind === 'federated' ? pgArray(s.readSources) : s.kind === 'none' ? '{}' : null,
    g.allowedOperations === null ? null : pgArray(g.allowedOperations),
    g.takesHolders === null ? null : pgArray(g.takesHolders),
  ];
}
export const TOKEN_GRANT_COLUMNS = ['source_grant', 'source_id', 'federated_read', 'allowed_operations', 'takes_holders'] as const;
