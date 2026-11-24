import { createHash } from 'node:crypto';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { sourceScopeOpts } from '../ops/context.ts';
import { currentVerifiedLocalWriter, readLocalWriter, verifyLocalWriter } from '../persistence/identity.ts';
import type { Principal } from '../persistence/model.ts';
import { normalizeTokenScopes } from '../legacy-token-scope.ts';
import { authSourcesFromGrant, grantFromTokenRow } from '../grants/model.ts';
import { hasScope } from '../scope.ts';

const deny = (): never => {
  throw new OperationError('permission_denied', 'An intact, current skills_member_self grant and explicit operation approval are required. Membership grants no other authority.',
    'Ask the brain host\'s operator to grant this connection the skills_member_self scope and the membership operation it calls, then reconnect; nothing was enrolled or changed.');
};

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
      // A live (not deleted) client's grant row, FOR SHARE (engine-sql/access-grants.ts).
      const row = await ctx.engine.readOAuthClientMemberGrant(principal.id);
      const scopes = row?.scope?.split(/\s+/) ?? [];
      if (!row || !hasScope(scopes, 'read') || !hasScope(scopes, 'skills_member_self') || !row.allowed_operations?.includes(operation)) return deny();
      sources = [...new Set([row.source_id, ...(row.federated_read ?? [])])].filter(Boolean);
      grant = row;
    } else {
      // GST-2314: named columns, not SELECT *: inside this transaction a plan cached before a migration added a column
      // fails 0A000. The member reads a live (not revoked) token's grant columns FOR SHARE (engine-sql/access-grants.ts).
      const row = await ctx.engine.readAccessTokenMemberGrant(principal.id);
      if (!row) return deny();
      const scopes = normalizeTokenScopes(row.scopes) ?? [];
      const tokenGrant = grantFromTokenRow(row);
      if (!hasScope(scopes, 'read') || !hasScope(scopes, 'skills_member_self') || !tokenGrant.allowedOperations?.includes(operation)) deny();
      const parsed = authSourcesFromGrant(tokenGrant);
      sources = parsed.allowedSources ?? [parsed.sourceId];
      grant = { scopes: row.scopes, permissions: row.permissions };
    }
    const scope = sourceScopeOpts(ctx);
    const original = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : []);
    sources = sources.filter(source => original.includes(source)).sort();
    ctx = { ...ctx, sourceId: sources[0] ?? '__denied__', auth: { ...auth, allowedSources: sources } };
  } else {
    const verified = currentVerifiedLocalWriter() ?? await verifyLocalWriter(ctx.engine, await readLocalWriter(ctx.engine, ctx.remote === false ? 'cli' : 'stdio'));
    principal = verified.principal;
    if (verified.remote !== (ctx.remote !== false)) deny();
    const row = await ctx.engine.readLocalWriterMemberGrant(principal.id);
    if (!row || row.revoked_at != null) return deny();
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
  const servingEpoch = await ctx.engine.readSharedSkillServingEpoch();
  if (servingEpoch === null) deny();
  const digest = createHash('sha256').update(JSON.stringify({ principal, grant, sources, issued: auth?.issuedScopes, original: auth?.allowedOperations,
    scopes: auth?.scopes, revision: auth?.grantRevision, serving_epoch: servingEpoch })).digest('hex');
  return { principal, digest, ctx };
}
