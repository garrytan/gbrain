import { assertAllowedScopes, hasScope, parseScopeString } from '../scope.ts';

export const GRANT_PROFILES = ['memory-reader', 'memory-writer', 'coding-agent', 'operator', 'delegating-agent', 'full'] as const;
export type GrantProfileId = typeof GRANT_PROFILES[number];
export type GrantSurface = 'verbs' | 'starter' | 'full';

/** SQL NULL operation snapshots preserve legacy clients; [] grants no operations. */
export interface ClientGrant {
  clientId: string;
  clientName: string;
  scopes: string[];
  sourceId: string | null;
  federatedRead: string[];
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
  if (!grant.sourceId || !ctx.activeSourceIds.has(grant.sourceId)) reasons.push('source_inactive');
  if (grant.federatedRead.length === 0 || grant.federatedRead.some(id => !ctx.activeSourceIds.has(id))) reasons.push('read_source_inactive');
  if (grant.boundSlugPrefixes !== null && !validGrantPrefixes(grant.boundSlugPrefixes)) reasons.push('direct_prefixes_invalid');
  if (grant.allowedOperations?.some(name => !ctx.operationNames.has(name))) reasons.push('operations_unavailable');
  if (grant.profile !== null && grant.allowedOperations === null) reasons.push('operations_snapshot_missing');
  if (grant.budgetUsdPerDay !== null && (!/^\d+(?:\.\d{1,2})?$/.test(grant.budgetUsdPerDay) || Number(grant.budgetUsdPerDay) > 99999999.99)) reasons.push('budget_invalid');
  if (grant.tokenTtlSeconds !== null && (!Number.isSafeInteger(grant.tokenTtlSeconds) || grant.tokenTtlSeconds < 60 || grant.tokenTtlSeconds > 7776000)) reasons.push('token_ttl_invalid');
  if (grant.surface !== null && !['verbs', 'starter', 'full'].includes(grant.surface)) reasons.push('surface_invalid');
  if (grant.profile !== null && !(GRANT_PROFILES as readonly string[]).includes(grant.profile)) reasons.push('profile_invalid');
  if (!Number.isSafeInteger(grant.boundMaxConcurrent) || grant.boundMaxConcurrent < 1) reasons.push('concurrency_invalid');
  if (hasScope(grant.scopes, 'agent')) reasons.push(...delegationReasons(grant, ctx));
  if (reasons.length) throw new GrantError('invalid_grant', `Invalid client grant: ${[...new Set(reasons)].join(', ')}`, [...new Set(reasons)]);
}
