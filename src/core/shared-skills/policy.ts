import { randomUUID } from 'node:crypto';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { sourceScopeOpts } from '../ops/context.ts';
import { hasScope } from '../scope.ts';
import { currentVerifiedLocalWriter, type LocalGrant } from '../persistence/identity.ts';
import { coerceLegacyPermissions, normalizeTokenScopes, parseLegacyOperationGrant, parseLegacyTokenScope } from '../legacy-token-scope.ts';
import type { SqlEngine, WriteAuthority } from '../persistence/model.ts';
import { stringList } from './manifest.ts';
import type { SharedSkillPolicy, SkillFileClass, StoredSkillFile } from './model.ts';

export function skillPrincipal(ctx: OperationContext): string {
  const p = ctx.auth?.principal ?? currentVerifiedLocalWriter()?.principal;
  if (p) return `${p.kind}:${p.id}`;
  if (ctx.remote === false) return 'local_cli';
  throw new OperationError('permission_denied', 'A verified principal is required for shared skills.');
}
function intersect(original: string[], live: string[]): string[] { return original.filter(v => live.includes(v)); }
export async function authorizeSkillRead(ctx: OperationContext, operation: string): Promise<OperationContext> {
  if (ctx.remote === false) return ctx;
  const auth = ctx.auth;
  const verified = currentVerifiedLocalWriter();
  if (!auth?.principal && verified) {
    const [row] = await ctx.engine.executeRaw<{ revoked_at: unknown; grant_ceiling: LocalGrant }>(
      'SELECT revoked_at,grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid', [verified.principal.id]);
    if (!verified.remote || !row || row.revoked_at != null || auth && (auth.clientId !== verified.principal.id ||
      auth.grantProjectionDegraded || auth.fenceProjectionDegraded || auth.sourceActive === false ||
      auth.effectiveSurface === 'verbs' || !hasScope(auth.scopes, 'read') ||
      auth.allowedOperations != null && !auth.allowedOperations.includes(operation)) ||
      [verified.grant, row.grant_ceiling].some(grant => !hasScope(grant.scopes, 'read') ||
        grant.operations !== null && !grant.operations.includes(operation))) {
      throw new OperationError('permission_denied', 'The local reader grant excludes this operation.');
    }
    const scope = sourceScopeOpts(ctx);
    let ids = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : null);
    let operations = auth?.allowedOperations ?? null;
    for (const grant of [verified.grant, row.grant_ceiling]) {
      if (!grant.sourceIds.includes('*')) ids = ids === null ? grant.sourceIds : intersect(ids, grant.sourceIds);
      if (grant.operations !== null) operations = operations === null ? grant.operations : intersect(operations, grant.operations);
    }
    const scopes = (auth?.scopes ?? verified.grant.scopes).filter(value =>
      hasScope(verified.grant.scopes, value) && hasScope(row.grant_ceiling.scopes, value));
    return { ...ctx, ...(ids === null ? {} : { sourceId: ids[0] ?? '__denied__' }), auth: {
      token: '', clientId: verified.principal.id, ...auth, scopes, allowedOperations: operations,
      ...(ids === null ? {} : { allowedSources: ids }),
    } };
  }
  if (!auth || !auth.principal || auth.grantProjectionDegraded || auth.fenceProjectionDegraded || !hasScope(auth.scopes, 'read') ||
    auth.allowedOperations != null && !auth.allowedOperations.includes(operation) || auth.effectiveSurface === 'verbs') {
    throw new OperationError('permission_denied', 'The current grant does not permit shared skill discovery.');
  }
  let liveSources: string[];
  let liveScopes = auth.scopes;
  let liveOperations = auth.allowedOperations;
  let grantRevision = auth.grantRevision;
  if (auth.principal.kind === 'oauth_client') {
    const [row] = await ctx.engine.executeRaw<{ scope: string; source_id: string; federated_read: string[] | null; allowed_operations: string[] | null; grant_revision: number }>(
      'SELECT scope,source_id,federated_read,allowed_operations,grant_revision FROM oauth_clients WHERE client_id=$1 AND deleted_at IS NULL', [auth.principal.id]);
    if (!row || !hasScope(row.scope.split(/\s+/), 'read') || row.allowed_operations != null && !row.allowed_operations.includes(operation)) {
      throw new OperationError('permission_denied', 'The shared skill reader grant was revoked or narrowed.');
    }
    liveSources = [...new Set([row.source_id, ...(row.federated_read ?? [])])].filter(Boolean);
    liveScopes = auth.scopes.filter(scope => hasScope(row.scope.split(/\s+/), scope));
    liveOperations = auth.allowedOperations == null ? row.allowed_operations : row.allowed_operations == null ? auth.allowedOperations : intersect(auth.allowedOperations, row.allowed_operations);
    grantRevision = row.grant_revision;
  } else {
    const [row] = await ctx.engine.executeRaw<{ scopes: unknown; permissions: unknown }>(
      'SELECT scopes,permissions FROM access_tokens WHERE id=$1 AND revoked_at IS NULL', [auth.principal.id]);
    if (!row || !hasScope(normalizeTokenScopes(row.scopes) ?? ['read', 'write', 'admin'], 'read')) throw new OperationError('permission_denied', 'The shared skill reader token was revoked.');
    const permissions = coerceLegacyPermissions(row.permissions);
    if (row.permissions != null && !permissions) throw new OperationError('permission_denied', 'Invalid reader projection.');
    const parsed = parseLegacyTokenScope(permissions?.source_id);
    const currentOperations = parseLegacyOperationGrant(permissions?.allowed_operations);
    if (currentOperations != null && !currentOperations.includes(operation)) throw new OperationError('permission_denied', 'The current legacy operation grant excludes this read.');
    liveScopes = auth.scopes.filter(scope => hasScope(normalizeTokenScopes(row.scopes) ?? ['read', 'write', 'admin'], scope));
    liveOperations = auth.allowedOperations == null ? currentOperations : currentOperations == null ? auth.allowedOperations : intersect(auth.allowedOperations, currentOperations);
    liveSources = parsed.allowedSources ?? [parsed.sourceId];
  }
  const scope = sourceScopeOpts(ctx);
  const allowed = intersect(scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : []), liveSources);
  return { ...ctx, sourceId: allowed[0] ?? '__denied__', auth: { ...auth, allowedSources: allowed, scopes: liveScopes, allowedOperations: liveOperations, grantRevision } };
}
export function assertSkillCapability(ctx: OperationContext, capability: 'skill_editor' | 'skill_publisher', operation: string): void {
  if (ctx.remote === false) return;
  const auth = ctx.auth;
  const local = currentVerifiedLocalWriter()?.grant;
  const scopes = auth?.scopes ?? local?.scopes ?? [];
  const operations = auth?.allowedOperations ?? local?.operations;
  if (auth?.grantProjectionDegraded || auth?.fenceProjectionDegraded || !scopes.includes(capability) ||
    !hasScope(scopes, capability === 'skill_publisher' ? 'admin' : 'write') || !operations?.includes(operation)) {
    throw new OperationError('permission_denied', `This operation requires explicit ${capability} authority and an operation grant.`);
  }
}
export async function assertStoredSkillCapability(engine: SqlEngine, authority: WriteAuthority, capability: 'skill_editor' | 'skill_publisher', lock = false): Promise<void> {
  if (!authority.remote && authority.principal.kind === 'local_cli') return;
  if (!authority.scopes.includes(capability)) throw new OperationError('permission_denied', `The accepted request lacks ${capability}.`);
  const suffix = lock ? ' FOR SHARE' : '';
  let scopes: string[] = [];
  if (authority.principal.kind === 'oauth_client') {
    const [row] = await engine.executeRaw<{ scope: string }>(`SELECT scope FROM oauth_clients WHERE client_id=$1 AND deleted_at IS NULL${suffix}`, [authority.principal.id]);
    scopes = row?.scope?.split(/\s+/) ?? [];
  } else if (authority.principal.kind === 'legacy_token') {
    const [row] = await engine.executeRaw<{ scopes: unknown }>(`SELECT scopes FROM access_tokens WHERE id=$1 AND revoked_at IS NULL${suffix}`, [authority.principal.id]);
    scopes = normalizeTokenScopes(row?.scopes) ?? [];
  } else if (authority.principal.kind === 'local_stdio') {
    const [row] = await engine.executeRaw<{ grant_ceiling: { scopes: string[] } }>(`SELECT grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid AND revoked_at IS NULL${suffix}`, [authority.principal.id]);
    scopes = row?.grant_ceiling?.scopes ?? [];
  }
  if (!scopes.includes(capability) || !hasScope(scopes, capability === 'skill_publisher' ? 'admin' : 'write')) throw new OperationError('permission_denied', `The current grant lacks ${capability} or its base scope.`);
}
export async function publicationEnabled(ctx: OperationContext): Promise<boolean> {
  const value = await ctx.engine.getConfig('mcp.publish_skills');
  return value == null ? ctx.config?.mcp?.publish_skills === true : value === 'true';
}
export function normalizePolicy(value: unknown): SharedSkillPolicy {
  const p = value as SharedSkillPolicy;
  const classes = stringList(p?.classes, 'classes');
  if (!p || p.version !== 1 || typeof p.enabled !== 'boolean' || typeof p.allow_follow !== 'boolean' ||
    classes.some(c => !['prose', 'reference', 'asset', 'script'].includes(c)) || p.enabled && !classes.includes('prose')) {
    throw new OperationError('invalid_params', 'A version 1 publication policy with explicit consent is required.');
  }
  return { version: 1, enabled: p.enabled, allow_follow: p.allow_follow, classes: classes as SkillFileClass[],
    audiences: stringList(p.audiences, 'audiences'), requirements: stringList(p.requirements, 'requirements') };
}
export async function readSharedSkillPolicy(engine: SqlEngine, sourceId: string, incarnation: string, legacyEnabled: boolean, lock = false): Promise<{ epoch: string; policy: SharedSkillPolicy }> {
  const [row] = await engine.executeRaw<{ epoch: string; policy: SharedSkillPolicy }>(
    `SELECT epoch,policy FROM shared_skill_policies WHERE source_id=$1 AND source_incarnation=$2::uuid${lock ? ' FOR SHARE' : ''}`, [sourceId, incarnation]);
  if (row) return { epoch: row.epoch, policy: normalizePolicy(row.policy) };
  return legacySharedSkillPolicy(legacyEnabled);
}
export function legacySharedSkillPolicy(legacyEnabled: boolean): { epoch: string; policy: SharedSkillPolicy } {
  return { epoch: legacyEnabled ? 'legacy-prose' : 'consent-required', policy: { version: 1, enabled: legacyEnabled,
    classes: ['prose'], audiences: ['readers'], requirements: [], allow_follow: false } };
}
export function approvedFiles(files: StoredSkillFile[], policy: SharedSkillPolicy, principal: string): StoredSkillFile[] {
  if (!policy.enabled) return [];
  const audience = (value: string) => (value === 'readers' || value === principal) && policy.audiences.includes(value);
  return files.filter(f => policy.classes.includes(f.file_class) && f.audience.some(audience));
}
export async function setSharedSkillPolicy(ctx: OperationContext, sourceId: string, input: SharedSkillPolicy, expectedEpoch?: string | null): Promise<{ policy_epoch: string }> {
  assertSkillCapability(ctx, 'skill_publisher', 'set_skill_policy');
  const policy = normalizePolicy(input);
  const { submissionAuthority } = await import('../persistence/authority.ts');
  const { initializeLocalPersistence } = await import('../persistence/page-mutations.ts');
  await initializeLocalPersistence(ctx);
  return ctx.engine.transaction(async tx => {
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    if (!source || source.archived) throw new OperationError('source_changed', 'Publication requires an active source.');
    const authority = await submissionAuthority({ ...ctx, engine: tx }, 'set_skill_policy', sourceId, source.incarnation, 'skills');
    await assertStoredSkillCapability(tx, authority, 'skill_publisher', true);
    const existing = await readSharedSkillPolicy(tx, sourceId, source.incarnation, await publicationEnabled({ ...ctx, engine: tx }), true);
    if (!['legacy-prose', 'consent-required'].includes(existing.epoch) && expectedEpoch === undefined) {
      throw new OperationError('revision_required', 'Review the current policy and supply its expected_policy_epoch before changing disclosure.');
    }
    if (expectedEpoch !== undefined && expectedEpoch !== existing.epoch && !(expectedEpoch === null && existing.epoch.startsWith('legacy-')) && !(expectedEpoch === null && existing.epoch === 'consent-required')) {
      throw new OperationError('revision_conflict', 'Publication policy changed; review its current disclosure before approving.');
    }
    const epoch = randomUUID();
    await tx.executeRaw(`INSERT INTO shared_skill_policies(source_id,source_incarnation,epoch,policy) VALUES($1,$2::uuid,$3::uuid,$4::text::jsonb)
      ON CONFLICT(source_id,source_incarnation) DO UPDATE SET epoch=excluded.epoch,policy=excluded.policy,updated_at=now()`,
    [sourceId, source.incarnation, epoch, JSON.stringify(policy)]);
    await tx.executeRaw(`INSERT INTO shared_skill_policy_audit(source_id,source_incarnation,principal_kind,principal_id,previous_epoch,epoch,policy)
      VALUES($1,$2::uuid,$3,$4,$5,$6::uuid,$7::text::jsonb)`,
    [sourceId, source.incarnation, authority.principal.kind, authority.principal.id, existing.epoch, epoch, JSON.stringify(policy)]);
    return { policy_epoch: epoch };
  });
}

export async function getSharedSkillPolicy(ctx: OperationContext, sourceId: string) {
  assertSkillCapability(ctx, 'skill_publisher', 'get_skill_policy');
  const active = await authorizeSkillRead(ctx, 'get_skill_policy');
  const scope = sourceScopeOpts(active);
  if (scope.sourceIds ? !scope.sourceIds.includes(sourceId) : scope.sourceId && scope.sourceId !== sourceId) {
    throw new OperationError('permission_denied', 'The publication policy source is outside this grant.');
  }
  const [source] = await ctx.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
  if (!source) throw new OperationError('source_changed', 'The publication policy source is not active.');
  if (ctx.remote !== false) {
    const { submissionAuthority } = await import('../persistence/authority.ts');
    const authority = await submissionAuthority(ctx, 'get_skill_policy', sourceId, source.incarnation, 'skills');
    await assertStoredSkillCapability(ctx.engine, authority, 'skill_publisher');
  }
  const enabled = await publicationEnabled(ctx);
  const current = await readSharedSkillPolicy(ctx.engine, sourceId, source.incarnation, enabled);
  return { schema_version: 2 as const, source_id: sourceId, source_incarnation: source.incarnation,
    publication_enabled: enabled, policy_epoch: current.epoch, policy: current.policy };
}
