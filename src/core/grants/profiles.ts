import { operations } from '../operations.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../minions/tools/brain-allowlist.ts';
import { hasScope } from '../scope.ts';
import { opAllowedForBoundClient } from '../ops/context.ts';
import { GrantError, type ClientGrant, type GrantPatch, type GrantProfileId, type GrantValidationContext } from './model.ts';

export const RENEWABLE_GRANT_TTL_SECONDS = 3600;
export const STATIC_GRANT_TTL_SECONDS = 30 * 24 * 3600;

export function grantCatalog(): Pick<GrantValidationContext, 'operationNames' | 'delegateToolNames'> {
  return {
    operationNames: new Set(operations.filter(op => !op.localOnly).map(op => op.name)),
    // The local worker allowlist includes files helpers that are not confined
    // by a remote source grant. Local-only operations never enter remote grants.
    delegateToolNames: new Set(operations.filter(op => !op.localOnly && BRAIN_TOOL_ALLOWLIST.has(op.name)).map(op => op.name)),
  };
}

/** Explicit profile application is a regrant; ordinary repair does not call this. */
export function resolveGrantProfile(opts: {
  profile: GrantProfileId;
  sourceId: string;
  federatedRead?: string[];
  boundSlugPrefixes?: string[] | null;
  delegatedSlugPrefixes?: string[] | null;
  boundTools?: string[];
  delegatedNamespace?: 'prefixes' | 'job';
  staticToken?: boolean;
  existing?: ClientGrant;
}): GrantPatch {
  const scopes = {
    'memory-reader': ['read'], 'memory-writer': ['read', 'write'],
    'coding-agent': ['read', 'write'], operator: ['admin'],
    'delegating-agent': ['read', 'write', 'agent'], full: ['admin', 'agent'],
  }[opts.profile];
  if (!scopes) throw new GrantError('invalid_grant', `Unknown profile: ${opts.profile}`);
  const delegated = scopes.includes('agent');
  if (delegated && !(opts.boundTools ?? opts.existing?.boundTools)?.length) throw new GrantError('invalid_grant', 'Delegating profiles require explicit non-empty --bound-tools');
  const directPrefixes = opts.boundSlugPrefixes !== undefined ? opts.boundSlugPrefixes : opts.existing?.boundSlugPrefixes ?? null;
  if (opts.profile === 'coding-agent' && !directPrefixes?.length) throw new GrantError('invalid_grant', 'coding-agent requires an explicit isolated write namespace');
  const allowedOperations = operations.filter(op => !op.localOnly
    && (hasScope(scopes, op.scope ?? 'read') || (op.agentCallable === true && hasScope(scopes, 'agent')))
    && opAllowedForBoundClient({ boundSlugPrefixes: directPrefixes ?? undefined }, op)).map(op => op.name).sort();
  return {
    profile: opts.profile, scopes, sourceId: opts.sourceId,
    federatedRead: opts.federatedRead ?? opts.existing?.federatedRead ?? [opts.sourceId],
    boundSlugPrefixes: directPrefixes, allowedOperations,
    surface: opts.profile === 'full' || opts.profile === 'operator' ? 'full' : 'starter', surfaceSetBy: 'operator',
    boundTools: delegated ? opts.boundTools ?? opts.existing?.boundTools ?? null : null,
    boundSourceId: delegated ? opts.sourceId : null,
    boundBrainId: null,
    delegatedSlugPrefixes: delegated ? (opts.delegatedSlugPrefixes !== undefined ? opts.delegatedSlugPrefixes : opts.existing?.delegatedSlugPrefixes ?? null) : null,
    delegatedNamespace: opts.delegatedNamespace ?? (opts.delegatedSlugPrefixes ? 'prefixes' : opts.existing?.delegatedNamespace ?? 'job'),
    boundMaxConcurrent: opts.existing?.boundMaxConcurrent ?? 1,
    budgetUsdPerDay: opts.existing?.budgetUsdPerDay ?? null,
    tokenTtlSeconds: opts.existing?.tokenTtlSeconds ?? (opts.staticToken ? STATIC_GRANT_TTL_SECONDS : RENEWABLE_GRANT_TTL_SECONDS),
    repairReasons: [],
  };
}
