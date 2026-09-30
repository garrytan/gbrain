import type { BrainEngine } from '../core/engine.ts';
import express, { type Express, type Request, type Response, type RequestHandler } from 'express';
import { normalizeScopesInput } from '../core/scope.ts';
import { GRANT_PROFILES, GrantError, grantFromRow, normalizeGrantBrain, type ClientGrant, type GrantPatch } from '../core/grants/model.ts';
import { grantValidationContext, validateClientGrant, resolveGrantProfile, grantCatalog, readClientGrant, rescopeClientGrant, delegationReasons } from '../core/grants/service.ts';
import { provisionHarnessGrant } from './mcp-provision.ts';
import { publicHarnessMetadata } from '../core/harness/registry.ts';
import type { GBrainOAuthProvider } from '../core/oauth-provider.ts';
import { writeSurfaceChangeAudit } from '../core/surface-audit.ts';

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

/** Preserve the legacy error field while keeping operational details private.
 * Entering a transaction does not prove COMMIT was acknowledged by the caller. */
export function sendAdminMutationError(res: Response, error: unknown, details: {
  stage: 'register' | 'rescope'; mutationStarted: boolean; clientId?: string; legacyStatus?: number;
}): void {
  const known = error instanceof GrantError || details.legacyStatus !== undefined;
  const unknown = !known && details.mutationStarted;
  const code = error instanceof GrantError ? error.code : details.legacyStatus === 404 ? 'client_not_found'
    : known ? 'invalid_grant' : 'administration_unavailable';
  const message = known && error instanceof Error ? error.message : unknown
    ? 'The mutation outcome is unknown. Inspect the current registration before another mutation.'
    : 'Administration is temporarily unavailable. Retry this read or preview after checking the running server.';
  const status = error instanceof GrantError ? grantHttpStatus(error) : details.legacyStatus ?? 503;
  res.status(status).json({ error: known ? message : code, code, message, stage: details.stage,
    outcome: unknown ? 'unknown' : 'failed', ...(details.clientId ? { client_id: details.clientId } : {}),
    next_action: unknown ? details.clientId
      ? `Inspect client ${details.clientId} with gbrain mcp admin client before another mutation; reload its current grant and review a fresh preview.`
      : 'Use gbrain mcp admin clients to inspect existing registrations before retrying; recover setup for an existing client instead of registering it again.'
      : known ? 'Review the error, inspect the current registration, and obtain a fresh preview before applying changes.'
        : 'Check the running server and retry the read or preview. No mutation was attempted.',
  });
}

export function mountAdminGrantDiscovery(app: Express, requireAdmin: RequestHandler, engine: BrainEngine, endpoint: string): void {
  app.post('/admin/api/grants', requireAdmin, express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await provisionHarnessGrant(engine, req.body, 'admin-api');
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const known = error instanceof GrantError || /^(flow_required|invalid_flow|credential_delivery_|client_secret_delivery_unavailable)/.test(message);
      const code = error instanceof GrantError ? error.code : known ? message.split(':')[0] : 'administration_unavailable';
      res.status(code === 'grant_conflict' ? 409 : code === 'client_not_found' ? 404 : known ? 400 : 503).json({
        error: code, message: known ? message : 'The grant response could not be confirmed. Inspect the current registration before another mutation.',
        stage: 'grant', outcome: known || req.body?.dryRun || req.body?.resume ? 'failed' : 'unknown',
        next_action: 'Use gbrain mcp admin clients or client ID to inspect the existing registration. Do not automatically repeat a mutation.',
      });
    }
  });

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
}

export function mountAdminGrantEdits(app: Express, requireAdmin: RequestHandler, engine: BrainEngine, oauthProvider: Pick<GBrainOAuthProvider, 'rescopeClient'>): void {
  // v0.42.x (#1914): rescope an OAuth client's write source / federated read
  // scope. Admin-gated on purpose — DCR clients must never self-widen their
  // scope (fail-closed trust); only the operator rescopes, here or via
  // `gbrain auth rescope-client`. Source ids are validated by the canonical
  // validator inside rescopeClient.
  app.post('/admin/api/rescope-client', requireAdmin, express.json(), async (req: Request, res: Response) => {
    let mutationStarted = false;
    try {
      const { clientId, sourceId, federatedRead, boundSlugPrefixes, surface } = req.body ?? {};
      if (!clientId || typeof clientId !== 'string') {
        res.status(400).json({ error: 'clientId required' });
        return;
      }
      const extended = Object.keys(req.body).some(key => !['clientId', 'sourceId', 'federatedRead', 'boundSlugPrefixes', 'surface'].includes(key));
      if (extended) {
        const before = await readClientGrant(engine, clientId);
        const request = parseAdminGrantRequest(req.body, before);
        mutationStarted = !request.dryRun;
        const result = await rescopeClientGrant(engine, clientId, request.patch, {
          actor: 'admin-api', expectedRevision: request.expectedRevision ?? before.revision, dryRun: request.dryRun, repair: request.repair,
        });
        res.json({ ...result, tokenImplications: GRANT_TOKEN_IMPLICATIONS });
        return;
      }
      if (federatedRead !== undefined &&
          !(Array.isArray(federatedRead) && federatedRead.every((s: unknown) => typeof s === 'string'))) {
        res.status(400).json({ error: 'federatedRead must be an array of source id strings' });
        return;
      }
      if (sourceId !== undefined && typeof sourceId !== 'string') {
        res.status(400).json({ error: 'sourceId must be a string' });
        return;
      }
      // v0.42.72.0: tri-state write-fence rescope — omitted = untouched,
      // null = clear, array of strings = replace (mirrors the CLI's
      // --bound-slug-prefixes p1,p2|none).
      if (boundSlugPrefixes !== undefined && boundSlugPrefixes !== null &&
          !(Array.isArray(boundSlugPrefixes) && boundSlugPrefixes.every((s: unknown) => typeof s === 'string'))) {
        res.status(400).json({ error: 'boundSlugPrefixes must be null or an array of slug-prefix strings' });
        return;
      }
      // WP4: tri-state surface rescope — omitted = untouched, null = clear
      // (surface + surface_set_by both NULL), value = set + operator lock
      // (mirrors the CLI's --surface verbs|starter|full|clear).
      if (surface !== undefined && surface !== null &&
          surface !== 'verbs' && surface !== 'starter' && surface !== 'full') {
        res.status(400).json({ error: 'surface must be null or one of: verbs, starter, full' });
        return;
      }
      mutationStarted = true;
      const result = await oauthProvider.rescopeClient(clientId, { sourceId, federatedRead, boundSlugPrefixes, surface });
      // WP4 (amendment 32 / ENG-8): every surface mutation writes an audit
      // row — this endpoint, the rescope CLI, and the request_tools persist.
      if (surface !== undefined) {
        await writeSurfaceChangeAudit(engine, {
          actor: 'admin-api',
          client_id: clientId,
          old: result.surfaceOld ?? null,
          new: result.surface ?? null,
          via: 'admin_api',
        });
      }
      res.json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      const legacyStatus = /^No OAuth client found with id "/.test(message) ? 404
        : /^(?:Invalid source_id:|rescope-client requires (?:--source|an up-to-date OAuth schema)|Client grant changes require an up-to-date OAuth schema|--federated-read cannot be empty|--bound-slug-prefixes cannot be an empty list|bound_slug_prefixes entr|--surface must be|Source "[^"]*" does not exist\. Create it first:)/.test(message) ? 400 : undefined;
      sendAdminMutationError(res, e, { stage: 'rescope', mutationStarted,
        clientId: typeof req.body?.clientId === 'string' ? req.body.clientId : undefined, legacyStatus });
    }
  });
}
