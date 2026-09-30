import express, { type Express, type RequestHandler, type Response } from 'express';
import type { BrainEngine } from '../core/engine.ts';
import { grantFromRow, GrantError } from '../core/grants/model.ts';
import { CLIENT_INSPECTION_COLUMNS, inspectOAuthClient, clientSetup, recoverClientSetup } from '../core/harness/client-setup.ts';
import { clientMetadata } from '../core/harness/oauth-setup.ts';
import { mutateClientLifecycle, type ClientLifecycleAction } from '../core/grants/lifecycle.ts';

function failure(res: Response, error: unknown, stage: string, mutation = false): void {
  const message = error instanceof Error ? error.message : 'Administration unavailable';
  const known = error instanceof GrantError || /^(flow_required|invalid_flow|credential_delivery_|client_secret_delivery_unavailable|Unknown harness)/.test(message);
  const code = error instanceof GrantError ? error.code : known ? message.split(':')[0] : 'administration_unavailable';
  const status = code === 'client_not_found' ? 404 : code === 'grant_conflict' || /delivery/.test(code) ? 409 : known ? 400 : 503;
  res.status(status).json({ error: code, code, message: known ? message : 'Administration unavailable. Inspect the running server and retry the read.', stage,
    outcome: known || !mutation ? 'failed' : 'unknown',
    next_action: stage === 'lifecycle' ? 'Inspect this client and review a fresh preview before another mutation.' : 'Inspect the registration and follow the owner administration runbook.' });
}

export function mountAdminClients(app: Express, requireAdmin: RequestHandler, engine: BrainEngine, endpoint: string): void {
  app.get('/admin/api/clients', requireAdmin, async (_req, res) => {
    try {
      const rows = await engine.executeRaw(`SELECT ${CLIENT_INSPECTION_COLUMNS} FROM oauth_clients ORDER BY created_at DESC, client_id`);
      res.json({ clients: rows.map(row => ({ ...clientMetadata(row), grant: grantFromRow(row),
        created_at: row.created_at, status: row.deleted_at ? 'revoked' : 'active' })) });
    } catch (e) { failure(res, e, 'inspect'); }
  });
  app.get('/admin/api/clients/:clientId', requireAdmin, async (req, res) => {
    try { res.json(await inspectOAuthClient(engine, String(req.params.clientId))); }
    catch (e) { failure(res, e, 'inspect'); }
  });
  app.get('/admin/api/clients/:clientId/setup', requireAdmin, async (req, res) => {
    try {
      if (req.query.harness !== undefined && typeof req.query.harness !== 'string') throw new GrantError('invalid_grant', 'harness must be a registered adapter ID');
      res.json(await clientSetup(engine, String(req.params.clientId), endpoint, req.query.harness as string | undefined, req.query.flow));
    } catch (e) { failure(res, e, 'setup'); }
  });
  app.post('/admin/api/recover-client', requireAdmin, express.json(), async (req, res) => {
    try {
      const body = req.body;
      if (typeof body?.clientId !== 'string' || !body.clientId.trim() || (body.harness !== undefined && typeof body.harness !== 'string')) throw new GrantError('invalid_grant', 'clientId and optional harness must be strings');
      res.json(await recoverClientSetup(engine, body.clientId, endpoint, body.harness, body.flow));
    } catch (e) { failure(res, e, 'export'); }
  });
  app.post('/admin/api/clients/:clientId/lifecycle', requireAdmin, express.json(), async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body.action !== 'string' || (body.dryRun !== undefined && typeof body.dryRun !== 'boolean')) throw new GrantError('invalid_grant', 'A lifecycle action and boolean dryRun are required');
      res.json(await mutateClientLifecycle(engine, String(req.params.clientId), body.action as ClientLifecycleAction,
        { actor: 'admin-api', dryRun: body.dryRun, yes: body.yes, expectedRevision: body.expectedRevision }));
    } catch (e) { failure(res, e, 'lifecycle', req.body?.dryRun === false); }
  });
}
