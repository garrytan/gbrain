import { createHash } from 'node:crypto';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { sourceScopeOpts } from '../ops/context.ts';
import { currentVerifiedLocalWriter, readLocalWriter, verifyLocalWriter, type LocalGrant } from '../persistence/identity.ts';
import type { Principal } from '../persistence/model.ts';
import { coerceLegacyPermissions, normalizeTokenScopes, parseLegacyTokenScope } from '../legacy-token-scope.ts';
import { hasScope } from '../scope.ts';

const deny = (): never => { throw new OperationError('permission_denied', 'An intact, current skills_member_self grant and explicit operation approval are required. Membership grants no other authority.'); };

export async function memberAuthority(ctx: OperationContext, operation: string): Promise<{ principal: Principal; digest: string; ctx: OperationContext }> {
  const auth = ctx.auth;
  if (auth?.grantProjectionDegraded || auth?.fenceProjectionDegraded || auth?.sourceActive === false || ctx.viaSubagent) deny();
  let principal: Principal;
  let sources: string[];
  let grant: unknown;
  if (auth?.principal) {
    if (!hasScope(auth.scopes, 'read') || !hasScope(auth.scopes, 'skills_member_self') ||
      (auth.issuedScopes && !auth.issuedScopes.includes('skills_member_self')) || !auth.allowedOperations?.includes(operation)) deny();
    principal = auth.principal;
    if (principal.kind === 'oauth_client') {
      const [row] = await ctx.engine.executeRaw<{ scope: string; source_id: string; federated_read: string[] | null; allowed_operations: string[] | null; grant_revision: number }>(
        'SELECT scope,source_id,federated_read,allowed_operations,grant_revision FROM oauth_clients WHERE client_id=$1 AND deleted_at IS NULL FOR SHARE', [principal.id]);
      const scopes = row?.scope?.split(/\s+/) ?? [];
      if (!row || !hasScope(scopes, 'read') || !hasScope(scopes, 'skills_member_self') || !row.allowed_operations?.includes(operation)) deny();
      sources = [...new Set([row.source_id, ...(row.federated_read ?? [])])].filter(Boolean);
      grant = row;
    } else {
      const [row] = await ctx.engine.executeRaw<{ scopes: unknown; permissions: unknown }>('SELECT scopes,permissions FROM access_tokens WHERE id=$1 AND revoked_at IS NULL FOR SHARE', [principal.id]);
      const scopes = normalizeTokenScopes(row?.scopes) ?? [];
      const permissions = coerceLegacyPermissions(row?.permissions);
      const operations = permissions?.allowed_operations;
      if (!row || !hasScope(scopes, 'read') || !hasScope(scopes, 'skills_member_self') || !Array.isArray(operations) || !operations.includes(operation)) deny();
      const parsed = parseLegacyTokenScope(permissions?.source_id);
      sources = parsed.allowedSources ?? [parsed.sourceId];
      grant = row;
    }
    const scope = sourceScopeOpts(ctx);
    const original = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : []);
    sources = sources.filter(source => original.includes(source)).sort();
    ctx = { ...ctx, sourceId: sources[0] ?? '__denied__', auth: { ...auth, allowedSources: sources } };
  } else {
    const verified = currentVerifiedLocalWriter() ?? await verifyLocalWriter(ctx.engine, await readLocalWriter(ctx.engine, ctx.remote === false ? 'cli' : 'stdio'));
    principal = verified.principal;
    if (verified.remote !== (ctx.remote !== false)) deny();
    const [row] = await ctx.engine.executeRaw<{ grant_ceiling: LocalGrant; revoked_at: unknown }>('SELECT grant_ceiling,revoked_at FROM persistence_local_writers WHERE id=$1::uuid FOR SHARE', [principal.id]);
    if (!row || row.revoked_at != null) deny();
    if (ctx.remote !== false && [row.grant_ceiling, verified.grant].some(g => !hasScope(g.scopes, 'read') || !hasScope(g.scopes, 'skills_member_self') || !g.operations?.includes(operation))) deny();
    const original = verified.grant.sourceIds;
    sources = row.grant_ceiling.sourceIds.filter(s => original.includes('*') || original.includes(s));
    if (ctx.remote !== false && !sources.includes('*')) {
      const scope = sourceScopeOpts(ctx);
      const selected = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : sources);
      const allowed = selected.filter(s => sources.includes(s));
      ctx = { ...ctx, sourceId: allowed[0] ?? '__denied__' };
      if (allowed.length > 1) deny();
    }
    grant = { current: row.grant_ceiling, original: verified.grant };
  }
  const [state] = await ctx.engine.executeRaw<{ serving_epoch: string }>('SELECT serving_epoch FROM shared_skill_state WHERE singleton=1');
  if (!state) deny();
  const digest = createHash('sha256').update(JSON.stringify({ principal, grant, sources, issued: auth?.issuedScopes, original: auth?.allowedOperations,
    scopes: auth?.scopes, revision: auth?.grantRevision, serving_epoch: state.serving_epoch })).digest('hex');
  return { principal, digest, ctx };
}
