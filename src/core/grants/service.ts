import type { BrainEngine } from '../engine.ts';
import { sqlQueryForEngine, type SqlQuery } from '../sql-query.ts';
import { GrantError, grantFromRow, normalizeGrantBrain, validateClientGrant, type ClientGrant, type GrantPatch, type GrantValidationContext } from './model.ts';
import { grantCatalog } from './profiles.ts';

export type GrantDatabase = BrainEngine | SqlQuery;
const query = (db: GrantDatabase): SqlQuery => typeof db === 'function' ? db : sqlQueryForEngine(db);

export async function readClientGrant(db: GrantDatabase, clientId: string): Promise<ClientGrant> {
  const sql = query(db);
  const rows = await sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId}`;
  if (!rows.length) throw new GrantError('client_not_found', `No OAuth client found with id "${clientId}"`);
  return grantFromRow(rows[0]);
}

export async function grantValidationContext(db: GrantDatabase, servingBrainId?: string): Promise<GrantValidationContext> {
  const sql = query(db);
  const sources = await sql`SELECT id FROM sources WHERE archived = false`;
  return { ...grantCatalog(), activeSourceIds: new Set(sources.map(r => String(r.id))), servingBrainId };
}

export interface GrantMutationOptions {
  expectedRevision?: number;
  actor: string;
  repair?: boolean;
  dryRun?: boolean;
  servingBrainId?: string;
}
export interface GrantMutationResult { before: ClientGrant; after: ClientGrant; revision: number; dryRun: boolean }
const PATCH_FIELDS = new Set<keyof GrantPatch>(['scopes', 'sourceId', 'federatedRead', 'boundSlugPrefixes', 'allowedOperations', 'boundTools', 'boundSourceId', 'boundBrainId', 'delegatedSlugPrefixes', 'delegatedNamespace', 'boundMaxConcurrent', 'budgetUsdPerDay', 'surface', 'surfaceSetBy', 'tokenTtlSeconds', 'profile', 'repairReasons']);
export function assertGrantPatch(patch: GrantPatch): void {
  for (const key of Object.keys(patch)) {
    if (!PATCH_FIELDS.has(key as keyof GrantPatch)) throw new GrantError('invalid_grant', `Unknown grant field: ${key}`);
  }
}

export interface GrantClientMetadata {
  secretHash: string | null;
  redirectUris: string[];
  grantTypes: string[];
  authMethod: string;
  issuedAt: number;
}

/** Called after validation. Never exposes the credential in the audit document. */
export async function insertClientGrant(sql: SqlQuery, grant: ClientGrant, metadata: GrantClientMetadata, actor = 'operator'): Promise<void> {
  await sql`
    WITH created AS (
      INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, redirect_uris, grant_types,
        token_endpoint_auth_method, client_id_issued_at, scope, source_id, federated_read,
        bound_slug_prefixes, allowed_operations, bound_tools, bound_source_id, bound_brain_id,
        delegated_slug_prefixes, delegated_namespace, bound_max_concurrent, budget_usd_per_day,
        surface, surface_set_by, token_ttl, grant_profile, grant_revision, grant_repair_reasons)
      VALUES (${grant.clientId}, ${grant.clientName}, ${metadata.secretHash},
        ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(metadata.redirectUris)}::text::jsonb)),
        ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(metadata.grantTypes)}::text::jsonb)),
        ${metadata.authMethod}, ${metadata.issuedAt}, ${grant.scopes.join(' ')}, ${grant.sourceId},
        ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(grant.federatedRead)}::text::jsonb)),
        CASE WHEN ${grant.boundSlugPrefixes === null} THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(grant.boundSlugPrefixes ?? [])}::text::jsonb)) END,
        CASE WHEN ${grant.allowedOperations === null} THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(grant.allowedOperations ?? [])}::text::jsonb)) END,
        CASE WHEN ${grant.boundTools === null} THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(grant.boundTools ?? [])}::text::jsonb)) END,
        ${grant.boundSourceId}, ${grant.boundBrainId},
        CASE WHEN ${grant.delegatedSlugPrefixes === null} THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(grant.delegatedSlugPrefixes ?? [])}::text::jsonb)) END,
        ${grant.delegatedNamespace}, ${grant.boundMaxConcurrent}, ${grant.budgetUsdPerDay}, ${grant.surface}, ${grant.surfaceSetBy},
        ${grant.tokenTtlSeconds}, ${grant.profile}, ${grant.revision},
        ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(grant.repairReasons)}::text::jsonb)))
      RETURNING client_id
    ) INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
      SELECT client_id, ${actor}, 'register', ${grant.revision}, NULL, ${JSON.stringify(grant)}::text::jsonb FROM created
  `;
}

/** Caller may supply a transaction engine; use the InTransaction export there. */
export async function rescopeClientGrant(engine: BrainEngine, clientId: string, patch: GrantPatch, opts: GrantMutationOptions): Promise<GrantMutationResult> {
  return engine.transaction(tx => rescopeClientGrantInTransaction(tx, clientId, patch, opts));
}

export async function rescopeClientGrantInTransaction(db: GrantDatabase, clientId: string, patch: GrantPatch, opts: GrantMutationOptions): Promise<GrantMutationResult> {
  assertGrantPatch(patch);
  const sql = query(db);
  const rows = await sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId} FOR UPDATE`;
  if (!rows.length) throw new GrantError('client_not_found', `No OAuth client found with id "${clientId}"`);
  if (!('grant_revision' in rows[0])) throw new GrantError('grant_schema_required', 'Run gbrain apply-migrations --yes before changing client grants');
  const before = grantFromRow(rows[0]);
  if (opts.expectedRevision !== undefined && before.revision !== opts.expectedRevision) {
    throw new GrantError('grant_conflict', `Grant changed (expected revision ${opts.expectedRevision}, current ${before.revision}); review a fresh preview`);
  }
  // Repair only fills missing pieces; explicitly changing a populated field
  // is a regrant. This prevents a profile default from replacing an old cap.
  const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => {
    if (value === undefined) return false;
    if (!opts.repair || key === 'repairReasons') return true;
    const prior = before[key as keyof ClientGrant];
    // Empty authority ceilings are deliberate deny-all, not missing data.
    // Only incomplete delegated tool/path bindings are fillable empty lists.
    return prior == null || ((key === 'boundTools' || key === 'delegatedSlugPrefixes') && Array.isArray(prior) && prior.length === 0);
  })) as GrantPatch;
  // Restoring delegation explicitly requested by repair may add only agent;
  // it never imports a profile's broader direct scopes or operation catalog.
  if (opts.repair && patch.scopes?.includes('agent') && before.repairReasons.length > 0) {
    changes.scopes = [...new Set([...before.scopes, 'agent'])];
  }
  const after: ClientGrant = { ...before, ...changes, revision: before.revision + 1, repairReasons: [] };
  after.boundBrainId = normalizeGrantBrain(after.boundBrainId);
  validateClientGrant(after, await grantValidationContext(db, opts.servingBrainId));
  if (JSON.stringify({ ...after, revision: before.revision }) === JSON.stringify(before)) {
    return { before, after: before, revision: before.revision, dryRun: opts.dryRun === true };
  }
  if (opts.dryRun) return { before, after, revision: before.revision, dryRun: true };
  await persistGrant(sql, before, after, opts.actor, opts.repair ? 'repair' : 'rescope');
  return { before, after, revision: after.revision, dryRun: false };
}

/** One UPDATE+audit statement: SQL-only provider callers get atomicity too. */
export async function persistGrant(sql: SqlQuery, before: ClientGrant, after: ClientGrant, actor: string, action: string): Promise<void> {
  const result = await sql`
    WITH updated AS (
      UPDATE oauth_clients SET
        scope = ${after.scopes.join(' ')}, source_id = ${after.sourceId},
        federated_read = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(after.federatedRead)}::text::jsonb)),
        bound_slug_prefixes = CASE WHEN ${after.boundSlugPrefixes === null} THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(after.boundSlugPrefixes ?? [])}::text::jsonb)) END,
        allowed_operations = CASE WHEN ${after.allowedOperations === null} THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(after.allowedOperations ?? [])}::text::jsonb)) END,
        bound_tools = CASE WHEN ${after.boundTools === null} THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(after.boundTools ?? [])}::text::jsonb)) END,
        bound_source_id = ${after.boundSourceId}, bound_brain_id = ${after.boundBrainId},
        delegated_slug_prefixes = CASE WHEN ${after.delegatedSlugPrefixes === null} THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(after.delegatedSlugPrefixes ?? [])}::text::jsonb)) END,
        delegated_namespace = ${after.delegatedNamespace}, bound_max_concurrent = ${after.boundMaxConcurrent}, budget_usd_per_day = ${after.budgetUsdPerDay},
        surface = ${after.surface}, surface_set_by = ${after.surfaceSetBy}, token_ttl = ${after.tokenTtlSeconds},
        grant_profile = ${after.profile}, grant_revision = ${after.revision},
        grant_repair_reasons = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(after.repairReasons)}::text::jsonb))
      WHERE client_id = ${before.clientId} AND grant_revision = ${before.revision}
      RETURNING client_id
    ), legacy_jobs AS (
      UPDATE minion_jobs j SET data = jsonb_set(j.data, '{__delegation_grant}', jsonb_build_object(
        'clientId', ${before.clientId}::text, 'sourceId', j.data->>'source_id',
        'brainId', ${before.boundBrainId}::text, 'tools', j.data->'allowed_tools',
        'slugPrefixes', CASE WHEN COALESCE(j.data->'allowed_slug_prefixes', '[]'::jsonb) NOT IN ('[]'::jsonb, 'null'::jsonb)
          THEN j.data->'allowed_slug_prefixes' ELSE '["wiki/agents/{job_id}/*"]'::jsonb END,
        'namespace', CASE WHEN COALESCE(j.data->'allowed_slug_prefixes', '[]'::jsonb) NOT IN ('[]'::jsonb, 'null'::jsonb) THEN 'prefixes' ELSE 'job' END,
        'readSources', CASE WHEN j.data->>'source_id' IN (SELECT jsonb_array_elements_text(${JSON.stringify(before.federatedRead)}::text::jsonb))
          THEN jsonb_build_array(j.data->>'source_id') ELSE '[]'::jsonb END,
        'scopes', ${JSON.stringify(before.scopes)}::text::jsonb,
        'allowedOperations', ${JSON.stringify(before.allowedOperations)}::text::jsonb,
        'maxConcurrent', ${before.boundMaxConcurrent}::integer, 'budgetUsdPerDay', ${before.budgetUsdPerDay}::text
      ))
      WHERE j.name = 'subagent' AND j.status IN ('waiting', 'active', 'waiting-children', 'delayed', 'paused')
        AND j.data->>'__owner_client_id' = ${before.clientId} AND NOT (j.data ? '__delegation_grant')
        AND EXISTS (SELECT 1 FROM updated)
      RETURNING j.id
    ), audited AS (
      INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
      SELECT client_id, ${actor}, ${action}, ${after.revision}, ${JSON.stringify(before)}::text::jsonb, ${JSON.stringify(after)}::text::jsonb FROM updated
      RETURNING client_id
    ) SELECT client_id FROM audited
  `;
  if (!result.length) throw new GrantError('grant_conflict', 'Client grant changed; review a fresh preview');
}

export { GrantError, grantFromRow, validateClientGrant, delegationReasons, intersectGrantedScopes } from './model.ts';
export type { ClientGrant, GrantPatch, GrantProfileId, GrantValidationContext } from './model.ts';
export { resolveGrantProfile, grantCatalog, RENEWABLE_GRANT_TTL_SECONDS, STATIC_GRANT_TTL_SECONDS } from './profiles.ts';
