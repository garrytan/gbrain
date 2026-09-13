import type { BrainEngine } from '../core/engine.ts';
import express, { type Express, type RequestHandler } from 'express';
import { normalizeScopesInput } from '../core/scope.ts';
import { GRANT_PROFILES, GrantError, grantFromRow, normalizeGrantBrain, type ClientGrant, type GrantPatch } from '../core/grants/model.ts';
import { grantValidationContext, validateClientGrant, resolveGrantProfile, grantCatalog, readClientGrant, delegationReasons } from '../core/grants/service.ts';
import { publicHarnessMetadata } from '../core/harness/registry.ts';
import { provisionHarnessGrant } from './mcp-provision.ts';

export const GRANT_TOKEN_IMPLICATIONS = 'Client credentials stay unchanged. Source, path, operation, and delegation restrictions apply immediately. Existing tokens keep their original scope ceiling and expiration; newly added scopes require a new token. Refresh cannot add scopes. TTL changes apply to future tokens.';

/** HTTP input validation is deliberately separate from canonical grant validation:
 * malformed JSON must produce a 400 before any transaction or credential exists. */
export function parseAdminGrantRequest(body: Record<string, unknown>, existing?: ClientGrant) {
  const patch: GrantPatch = {};
  const invalid = (field: string, expected: string): never => { throw new GrantError('invalid_grant', `${field} must be ${expected}`); };
  const arrays = ['federatedRead', 'boundSlugPrefixes', 'allowedOperations', 'boundTools', 'delegatedSlugPrefixes'] as const;
  for (const field of arrays) {
    const value = body[field];
    if (value === undefined) continue;
    if (value === null && field !== 'federatedRead') { patch[field] = null; continue; }
    if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) invalid(field, 'an array of strings');
    patch[field] = value as string[];
  }
  const source = body.sourceId ?? body.source;
  if (source !== undefined) {
    if (typeof source !== 'string' || !source.trim()) invalid('sourceId', 'a non-empty source ID');
    patch.sourceId = source as string;
  }
  for (const field of ['boundSourceId', 'boundBrainId'] as const) {
    const value = body[field];
    if (value !== undefined) {
      if (value !== null && (typeof value !== 'string' || !value.trim())) invalid(field, 'a non-empty string or null');
      patch[field] = value as string | null;
    }
  }
  if (body.scopes !== undefined || body.scope !== undefined) {
    try { patch.scopes = normalizeScopesInput(body.scopes ?? body.scope).split(' '); }
    catch (e) { throw new GrantError('invalid_grant', e instanceof Error ? e.message : 'Invalid scopes'); }
  }
  if (body.surface !== undefined) {
    if (body.surface !== null && !['verbs', 'starter', 'full'].includes(String(body.surface))) invalid('surface', 'verbs, starter, full, or null');
    patch.surface = body.surface as GrantPatch['surface'];
    patch.surfaceSetBy = body.surface === null ? null : 'operator';
  }
  if (body.delegatedNamespace !== undefined) {
    if (!['job', 'prefixes'].includes(String(body.delegatedNamespace))) invalid('delegatedNamespace', 'job or prefixes');
    patch.delegatedNamespace = body.delegatedNamespace as 'job' | 'prefixes';
  }
  if (body.boundMaxConcurrent !== undefined) {
    if (typeof body.boundMaxConcurrent !== 'number' || !Number.isSafeInteger(body.boundMaxConcurrent) || body.boundMaxConcurrent < 1) invalid('boundMaxConcurrent', 'a positive integer');
    patch.boundMaxConcurrent = body.boundMaxConcurrent as number;
  }
  if (body.budgetUsdPerDay !== undefined) {
    const value = body.budgetUsdPerDay;
    if (value === null || value === 'unlimited') patch.budgetUsdPerDay = null;
    else if ((typeof value === 'string' || typeof value === 'number') && /^\d+(?:\.\d{1,2})?$/.test(String(value))) patch.budgetUsdPerDay = String(value);
    else invalid('budgetUsdPerDay', 'unlimited, null, or a nonnegative USD amount with at most two decimal places');
  }
  const ttl = body.tokenTtlSeconds !== undefined ? body.tokenTtlSeconds : body.tokenTtl;
  if (ttl !== undefined) {
    if (ttl === null || ttl === 0) patch.tokenTtlSeconds = null;
    else if ((typeof ttl === 'number' || typeof ttl === 'string') && Number.isSafeInteger(Number(ttl)) && Number(ttl) >= 60 && Number(ttl) <= 7776000) patch.tokenTtlSeconds = Number(ttl);
    else invalid('tokenTtl', 'an integer from 60 to 7776000 seconds, or null for the server default');
  }
  for (const field of ['dryRun', 'repair'] as const) if (body[field] !== undefined && typeof body[field] !== 'boolean') invalid(field, 'a boolean');
  if (body.expectedRevision !== undefined && (typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)) invalid('expectedRevision', 'a nonnegative integer');
  let resolved: GrantPatch = {};
  if (body.profile !== undefined) {
    if (!(GRANT_PROFILES as readonly unknown[]).includes(body.profile)) invalid('profile', GRANT_PROFILES.join(', '));
    resolved = resolveGrantProfile({
      profile: body.profile as typeof GRANT_PROFILES[number], sourceId: patch.sourceId ?? existing?.sourceId ?? 'default',
      existing, federatedRead: patch.federatedRead, boundSlugPrefixes: patch.boundSlugPrefixes,
      boundTools: patch.boundTools ?? undefined, delegatedSlugPrefixes: patch.delegatedSlugPrefixes,
      delegatedNamespace: patch.delegatedNamespace,
    });
  }
  return { patch: { ...resolved, ...patch }, expectedRevision: body.expectedRevision as number | undefined, dryRun: body.dryRun === true, repair: body.repair === true };
}

export async function previewNewAdminGrant(engine: BrainEngine, name: string, patch: GrantPatch, legacy: { sourceId: string; federatedRead?: string[]; scopes: string }): Promise<ClientGrant> {
  const grant = { ...grantFromRow({ client_id: '(assigned on registration)', client_name: name, source_id: legacy.sourceId,
    federated_read: legacy.federatedRead ?? [legacy.sourceId], scope: legacy.scopes, delegated_namespace: 'job', delegated_slug_prefixes: null }), ...patch };
  grant.boundBrainId = normalizeGrantBrain(grant.boundBrainId);
  validateClientGrant(grant, await grantValidationContext(engine));
  return grant;
}

export function grantHttpStatus(error: unknown): number {
  if (error instanceof GrantError) return error.code === 'grant_conflict' ? 409 : error.code === 'client_not_found' ? 404 : 400;
  return 500;
}

export function mountAdminGrantDiscovery(app: Express, requireAdmin: RequestHandler, engine: BrainEngine, endpoint: string): void {
  app.get('/admin/api/grant-catalog', requireAdmin, (_req, res) => {
    const catalog = grantCatalog();
    res.json({ profiles: GRANT_PROFILES, operations: [...catalog.operationNames].sort(), delegatedTools: [...catalog.delegateToolNames].sort(), harnesses: publicHarnessMetadata() });
  });
  app.get('/admin/api/grants/:clientId', requireAdmin, async (req, res) => {
    try {
      const grant = await readClientGrant(engine, String(req.params.clientId));
      const context = await grantValidationContext(engine);
      res.json({ grant, delegationReasons: delegationReasons(grant, context), tokenImplications: GRANT_TOKEN_IMPLICATIONS });
    } catch (e) {
      res.status(grantHttpStatus(e)).json({ error: e instanceof Error ? e.message : 'Grant unavailable' });
    }
  });
  app.post('/admin/api/recover-client', requireAdmin, express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const clientId = req.body?.clientId;
    if (typeof clientId !== 'string' || !clientId.trim()) { res.status(400).json({ error: 'clientId required' }); return; }
    try {
      const grant = await readClientGrant(engine, clientId);
      if (grant.revoked) { res.status(404).json({ error: 'Client is revoked' }); return; }
      // Reuse host delivery resume and its live-secret validation. Recovery
      // never issues a new grant, token, or client secret.
      const result = await provisionHarnessGrant(engine, { name: 'admin-recovery', harness: 'generic',
        clientId, url: endpoint, resume: true }, 'admin-api');
      res.json({ clientId, clientSecret: result.credentials!.client_secret, name: grant.clientName,
        credentials: result.credentials });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Credential delivery unavailable';
      const recoveryConflict = /^credential_delivery_|^client_secret_delivery_unavailable:/.test(message);
      res.status(recoveryConflict ? 409 : grantHttpStatus(e)).json({ error: message });
    }
  });
}
