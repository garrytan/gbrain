/**
 * Owner administration for `gbrain serve --http`: the cookie-session guard
 * (`requireAdmin`), password login, the /admin/api/* dashboard endpoints and
 * the /admin/events SSE feed. Every /admin/api route here carries requireAdmin
 * first (test/serve-http-admin-route-guard.test.ts).
 */
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import type { BrainEngine } from '../core/engine.ts';
import { safeHexEqual } from '../core/timing-safe.ts';
import { normalizeTokenScopes } from '../core/legacy-token-scope.ts';
import { rescopeClientGrant } from '../core/grants/service.ts';
import { resolveOwnerHolder } from '../core/owner-holder.ts';
import { lifetimeUsage, readMcpLogRetentionDays } from '../core/mcp-request-log-retention.ts';
import { readMcpUsageCoverage } from '../core/mcp-usage.ts';
import { VERSION } from '../version.ts';
import { mountAdminApiKeys } from './serve-http-api-keys.ts';
import { mountAdminClients } from './serve-http-clients.ts';
import { mountAdminRegistration } from './serve-http-registration.ts';
import { parseAdminGrantRequest, grantHttpStatus, GRANT_TOKEN_IMPLICATIONS, mountAdminGrantDiscovery, mountAdminGrantEdits } from './serve-http-grants.ts';
import { mountAdminAccess, mountAdminMemoryProposals, mountAdminPolicy } from './serve-http-access.ts';
import { probeHealth } from './serve-http-metrics.ts';
import type { ServeHttpContext } from './serve-http.ts';

/** Narrowest contract the handshake consumes. */
type AdminSseResponse = {
  setHeader(name: string, value: string): unknown;
  flushHeaders(): void;
  write(chunk: string): unknown;
};

/**
 * Complete the admin EventSource handshake immediately.
 *
 * `flushHeaders()` alone can leave reverse proxies and browsers waiting for
 * the first response body bytes. An SSE comment is protocol-valid, ignored by
 * EventSource consumers, and makes the stream observable end-to-end without
 * fabricating an application event.
 */
export function openAdminSseStream(res: AdminSseResponse): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');
}

/**
 * v0.38 Slice 4 — per-OAuth-client agent spend snapshot. Exported so the
 * admin endpoint and `test/admin-agents-spend.test.ts` share the same SQL
 * (single source of truth for the spend query shape).
 *
 * Returns one row per OAuth client that EITHER has the `agent` scope OR
 * has at least one `bound_*` column set (the legacy admin client could
 * also have bindings without scope='agent' on a partially-migrated brain;
 * we want it visible in the viewer).
 *
 * Fields:
 *   - client_id, client_name
 *   - cap_usd_per_day: number | null  (daily budget cap; NULL = no cap)
 *   - spent_cents_today: number  (sum from mcp_spend_log, UTC-day-aligned)
 *   - pending_cents: number  (sum of in-flight reservations, non-expired)
 *   - inflight_count: number  (active subagent jobs owned by this client)
 *
 * Falls back to `[]` on any SQL error (pre-v0.38 brains where the v82-v84
 * tables/columns don't yet exist).
 */
/** The `/admin/api/health-indicators` body; SQL lives here so tests pin the served query. */
export async function queryHealthIndicators(engine: BrainEngine): Promise<{
  expiring_soon: number; error_rate: string; pending_writes: number;
  oldest_pending_write_age_seconds: number; pending_writes_later_failed: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const expiring = await engine.countOauthAccessTokens(now, now + 86400);
  // Excluded from the error numerator: success, success_with_warnings
  // (a warn-mode success) and accepted_pending (#5249: an admitted write
  // still in flight; its eventual failure is counted separately below);
  // denied_after_list stays counted — a denied call IS a failure signal.
  // surface_change is an OPERATION value (audit rows carry
  // status='success'), so audit rows are excluded from BOTH counts —
  // they are records of operator/self actions, not traffic.
  const errors = await engine.countMcpRequestsLastDay('errors');
  const total = await engine.countMcpRequestsLastDay('traffic');
  const errorRate = total > 0 ? (errors / total * 100).toFixed(1) : '0';
  // #5249/O-CEO-14: pending writes are tracked apart from the error rate —
  // how many are still in flight, how old the oldest is, and how many
  // reported as pending in the last 24 hours later ended without committing.
  const writes = await engine.readPendingWriteHealth();
  return {
    expiring_soon: expiring,
    error_rate: `${errorRate}%`,
    ...writes,
  };
}

export interface AgentClientSpend {
  client_id: string;
  client_name: string;
  cap_usd_per_day: number | null;
  spent_cents_today: number;
  pending_cents: number;
  unknown_count: number;
  inflight_count: number;
}

export async function queryAgentClientSpend(engine: BrainEngine): Promise<AgentClientSpend[]> {
  return engine.readAgentClientSpend();
}

/** Admin auth middleware over the server's cookie-session map (sessionId -> expiresAt). */
export function createRequireAdmin(adminSessions: Map<string, number>): RequestHandler {
  return function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
      const sessionId = (req.cookies as Record<string, string>)?.gbrain_admin;
      if (!sessionId || !adminSessions.has(sessionId)) {
        res.status(401).json({ error: 'Admin authentication required' });
        return;
      }
      const expiresAt = adminSessions.get(sessionId)!;
      if (Date.now() > expiresAt) {
        adminSessions.delete(sessionId);
        res.status(401).json({ error: 'Session expired' });
        return;
      }
      next();
  };
}

/** POST /admin/login: bootstrap-credential login that opens a cookie session. */
export function mountAdminLogin(app: Express, ctx: ServeHttpContext): void {
  const { adminLimits, bootstrapHash, adminSessions, adminCookie } = ctx;
  // ---------------------------------------------------------------------------
  // Admin authentication (cookie-based)
  // ---------------------------------------------------------------------------
  // v0.40 D15.5: safeHexEqual extracted to src/core/timing-safe.ts so the new
  // /webhooks/github HMAC verifier reuses the same constant-time compare.
  // POST /admin/login — JSON body with token (for programmatic/UI login).
  // Independent limits: 60 total requests and 10 failed authentications/min/IP.
  app.post('/admin/login', adminLimits.total, adminLimits.failures, express.json(), (req, res) => {
    const token = req.body?.token;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Token required' });
      return;
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    if (!safeHexEqual(tokenHash, bootstrapHash)) {
      res.status(401).json({ error: 'Owner credential rejected. Use the protected bootstrap credential configured for this running server; an OAuth token cannot administer it.' });
      return;
    }

    res.locals.ownerAuthenticated = true;
    const sessionId = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    adminSessions.set(sessionId, expiresAt);

    res.cookie('gbrain_admin', sessionId, adminCookie(req, 24 * 60 * 60 * 1000));
    res.json({ status: 'authenticated' });
  });
}

/** The /admin/api/* dashboard endpoints and the /admin/events SSE feed, in registration order. */
export function mountAdminApi(app: Express, ctx: ServeHttpContext): void {
  const { requireAdmin, sseClients } = ctx;
  mountAdminOverviewApi(app, ctx);
  mountAdminCalibrationApi(app, ctx);
  mountAdminKeyApi(app, ctx);
  mountAdminClientApi(app, ctx);

  // ---------------------------------------------------------------------------
  // SSE live activity feed
  // ---------------------------------------------------------------------------
  app.get('/admin/events', requireAdmin, (req: Request, res: Response) => {
    openAdminSseStream(res);

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });
}

function mountAdminOverviewApi(app: Express, ctx: ServeHttpContext): void {
  const { engine, config, sql, requireAdmin, adminSessions } = ctx;
  // ---------------------------------------------------------------------------
  // Admin API endpoints
  // ---------------------------------------------------------------------------

  // Sign-out-everywhere: nuke ALL active admin sessions in-memory. Every
  // browser/tab fails its next request, gets 401, redirects to login.
  // The bootstrap token itself is unaffected (still valid for new
  // magic-link mints) — this only revokes existing cookie sessions.
  app.post('/admin/api/sign-out-everywhere', requireAdmin, (_req: Request, res: Response) => {
    const count = adminSessions.size;
    adminSessions.clear();
    res.json({ revoked_sessions: count });
  });

  app.get('/admin/api/agents', requireAdmin, async (_req: Request, res: Response) => {
    try {
      // Unified view: OAuth clients + legacy API keys
      // Engine members, so a Rust brain answers too; the request counts of the last day are one read over both lists.
      const clients = (await engine.listOauthClients()).sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      const apiKeys = await engine.listAccessTokens();
      const today = new Map((await engine.countMcpRequestsLastDayByToken([...clients.map(c => c.client_id), ...apiKeys.map(k => k.name)])).map(r => [r.token_name, r.requests]));
      const oauthClients = clients.map(c => ({
        id: c.client_id, name: c.client_name, auth_type: 'oauth', grant_types: c.grant_types, scope: c.scope, source_id: c.source_id,
        federated_read: c.federated_read, created_at: c.created_at, token_ttl: c.token_ttl,
        status: c.deleted_at != null ? 'revoked' : 'active', requests_today: today.get(c.client_id) ?? 0,
      }));
      const legacyKeys = apiKeys.map(k => ({
        id: k.id, name: k.name, auth_type: 'api_key', grant_types: '{"bearer"}', scopes: k.scopes, created_at: k.created_at, token_ttl: null,
        status: k.revoked_at != null ? 'revoked' : 'active', last_used_at: k.last_used_at, requests_today: today.get(k.name) ?? 0,
      }));
      // #6770: lifetime totals = rows still in the log + the pruned tally (mcp-request-log-retention.ts).
      const lifetime = await lifetimeUsage(engine, [...oauthClients.map(c => String(c.id)), ...legacyKeys.map(k => String(k.name))]);
      res.json([
        ...oauthClients.map(c => ({ ...c, last_used_at: lifetime.get(String(c.id))?.last_used_at ?? null, total_requests: lifetime.get(String(c.id))?.requests ?? 0 })),
        ...legacyKeys.map(({ scopes, ...key }) => ({
          ...key,
          total_requests: lifetime.get(String(key.name))?.requests ?? 0,
          // The SAME normalizer the verify path uses — the dashboard must
          // never display a grant the serve doesn't enforce (NULL =
          // grandfathered full access; damaged/deny rows show empty).
          scope: normalizeTokenScopes(scopes)?.join(' ') ?? 'read write admin',
          source_id: null,
          federated_read: [],
        })),
      ]);
    } catch (e) {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  app.get('/admin/api/sources', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { listSources } = await import('../core/sources-ops.ts');
      const sources = await listSources(engine);
      res.json(sources.map(({ id, name, federated }) => ({ id, name, federated })));
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  // v0.38 Slice 4 — per-OAuth-client agent spend viewer. Pre-computes today's
  // spend (committed + pending reservations) per client so the Agents tab
  // can render a "$X / $Y today" cell. Read-side endpoint only — no mutation.
  // Falls back to an empty array on pre-v0.38 brains where mcp_spend_log
  // exists but agent dispatch hasn't recorded anything.
  app.get('/admin/api/agents/spend', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await queryAgentClientSpend(engine);
      res.json(rows);
    } catch (e) {
      // Pre-v0.38 brains: tables may not exist yet. Return empty so the UI
      // renders gracefully instead of erroring.
      res.json([]);
    }
  });

  app.get('/admin/api/stats', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const clients = await engine.listOauthClients();
      const tokens = await engine.countOauthAccessTokens(Math.floor(Date.now() / 1000), null);
      const requests = await engine.countMcpRequestsLastDay('all');
      const apiKeys = (await engine.listAccessTokens()).filter(k => k.revoked_at == null);
      res.json({
        connected_agents: clients.length,
        active_tokens: tokens,
        active_api_keys: apiKeys.length,
        requests_today: requests,
      });
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  app.get('/admin/api/health-indicators', requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(await queryHealthIndicators(engine));
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  // #6696 B2: the full ops snapshot (doctor ops tier + capacity view), cached 60 s per engine (doctor/ops-snapshot.ts).
  app.get('/admin/api/ops', requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(await (await import('./doctor/ops-snapshot.ts')).cachedOpsSnapshot(engine));
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  // Full engine stats. v0.28.10 moved this off /health (which is now liveness
  // only — see probeLiveness) so dashboards needing page_count / chunk_count
  // / etc. authenticate as admin and call this endpoint. probeHealth races
  // engine.getStats() against HEALTH_TIMEOUT_MS so a saturated pool returns
  // 503 rather than hanging.
  app.get('/admin/api/full-stats', requireAdmin, async (_req: Request, res: Response) => {
    const result = await probeHealth(engine, config.engine || 'pglite', VERSION);
    res.status(result.status).json(result.body);
  });

  // v0.41 D2 — live jobs dashboard data. Shares readSnapshot() with the
  // TTY `gbrain jobs watch` command so the two surfaces stay 1:1.
  app.get('/admin/api/jobs/watch', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { readSnapshot } = await import('./jobs-watch.ts');
      const snap = await readSnapshot(engine);
      res.json(snap);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });
}

function mountAdminCalibrationApi(app: Express, ctx: ServeHttpContext): void {
  const { engine, requireAdmin } = ctx;
  // v0.36.1.0 (T15 / E6 / D23) — Calibration tab data endpoints.
  // Server-rendered SVG charts; admin SPA renders via TrustedSVG wrapper.
  // v0.36.1.0 (TD3) — pattern drill-down. Returns the source takes that
  // produced the pattern statement at index `id` of the active profile.
  // v0.36.1.0 ship state: returns the top N takes in the holder's overall
  // takes table, sorted by weight desc. v0.37+ will store per-pattern
  // source_take_ids on calibration_profiles_patterns so the drill-down
  // shows the EXACT takes that drove the pattern.
  app.get('/admin/api/calibration/pattern/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { getLatestProfile } = await import('./calibration.ts');
      const holder = resolveOwnerHolder({ override: (req.query.holder as string) || undefined, configValue: await engine.getConfig('emotional_weight.user_holder') });
      const profile = await getLatestProfile(engine, { holder });
      if (!profile) {
        res.status(404).json({ error: 'no_profile' });
        return;
      }
      const rawId = req.params.id;
      const idStr = Array.isArray(rawId) ? rawId[0] : rawId;
      const idx = Number.parseInt(idStr ?? '', 10) - 1;
      if (!Number.isFinite(idx) || idx < 0 || idx >= profile.pattern_statements.length) {
        res.status(400).json({ error: 'invalid_pattern_index', max: profile.pattern_statements.length });
        return;
      }
      const statement = profile.pattern_statements[idx];
      // v0.36.1.0 ship state: surface the top resolved takes for the
      // holder as drill-down evidence. Per-pattern provenance is v0.37.
      // The holder's top 25 resolved takes (engine-sql/takes-reads.ts); `id` is the bigint id as text for res.json().
      const takes = await engine.listTopResolvedTakesForHolder(holder);
      res.json({
        pattern_statement: statement,
        pattern_index: idx + 1,
        holder,
        provenance_note: 'v0.36.1.0 ship state shows top-25 resolved takes for this holder; per-pattern source_take_ids land in v0.37.',
        takes,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
    }
  });

  app.get('/admin/api/calibration/profile', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { getLatestProfile } = await import('./calibration.ts');
      const holder = resolveOwnerHolder({ override: (req.query.holder as string) || undefined, configValue: await engine.getConfig('emotional_weight.user_holder') });
      const profile = await getLatestProfile(engine, { holder });
      res.json(profile);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
    }
  });

  app.get('/admin/api/calibration/charts/:type', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { getLatestProfile } = await import('./calibration.ts');
      const {
        renderBrierTrend,
        renderDomainBars,
        renderAbandonedThreadsCard,
        renderPatternStatementsCard,
      } = await import('../core/calibration/svg-renderer.ts');
      const holder = resolveOwnerHolder({ override: (req.query.holder as string) || undefined, configValue: await engine.getConfig('emotional_weight.user_holder') });
      const type = req.params.type;
      const profile = await getLatestProfile(engine, { holder });

      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=60');

      if (type === 'brier-trend') {
        // v0.36.1.0 ship state: 1-point series from the active profile. A
        // proper 90-day time series will read from calibration_profiles
        // generated_at history in v0.37 once we have multiple snapshots.
        const series = profile?.brier !== null && profile?.brier !== undefined
          // generated_at comes back from the engine as a Date (TIMESTAMPTZ), not
          // a string — `.slice` would throw. Normalize to a YYYY-MM-DD string.
          ? [{ date: new Date(profile.generated_at).toISOString().slice(0, 10), brier: profile.brier }]
          : [];
        return res.send(renderBrierTrend({ series }));
      }
      if (type === 'domain-bars') {
        // v0.36.1.0 ship state: domain_scorecards JSONB is a placeholder
        // (per-domain rendering comes when batchGetTakesScorecards lands in
        // a follow-up). Render empty for now.
        return res.send(renderDomainBars({ bars: [] }));
      }
      if (type === 'pattern-statements') {
        return res.send(
          renderPatternStatementsCard(
            (profile?.pattern_statements ?? []).map((text: string) => ({ text })),
          ),
        );
      }
      if (type === 'abandoned-threads') {
        // v0.36.1.0 ship state: pull abandoned threads inline via a small
        // SQL query (the doctor check counts them; this surfaces details).
        // The five oldest abandoned high-conviction takes (engine-sql/takes-reads.ts; month-precision dates read as the 1st).
        const rows = await engine.listAbandonedTakes();
        const now = new Date();
        const threads = rows.map(r => {
          const since = new Date((r.since_date.length === 7 ? r.since_date + '-15' : r.since_date));
          const monthsSilent = Math.max(0, Math.floor((now.getTime() - since.getTime()) / (1000 * 60 * 60 * 24 * 30)));
          return {
            takeId: r.id,
            pageSlug: r.page_slug,
            claim: r.claim,
            monthsSilent,
            conviction: r.weight,
          };
        });
        return res.send(renderAbandonedThreadsCard(threads));
      }
      res.status(400).json({ error: 'unknown_chart_type', supported: ['brier-trend', 'domain-bars', 'pattern-statements', 'abandoned-threads'] });
      return;
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
      return;
    }
  });
}

function mountAdminKeyApi(app: Express, ctx: ServeHttpContext): void {
  const { engine, requireAdmin } = ctx;
  app.get('/admin/api/requests', requireAdmin, async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = 50;
      const offset = (page - 1) * limit;
      const agent = req.query.agent as string;
      const operation = req.query.operation as string;
      const status = req.query.status as string;

      // The page and the filtered total (engine-sql/telemetry.ts); 'all' or no value reads every row.
      const filter = (value: string | undefined) => (value && value !== 'all' ? value : null);
      const { rows, total } = await engine.readMcpRequestLogPage({
        tokenName: filter(agent), operation: filter(operation), status: filter(status), limit, offset,
      });
      const [retention_days, pruned_before] = await Promise.all([readMcpLogRetentionDays(engine), readMcpUsageCoverage(engine, 1).then(c => c.pruned_before)]);
      res.json({ rows, total, page, pages: Math.ceil(total / limit), retention_days, pruned_before });
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  mountAdminApiKeys(app, requireAdmin, engine);
}

function mountAdminClientApi(app: Express, ctx: ServeHttpContext): void {
  const { engine, requireAdmin, oauthProvider, issuerUrl, mcpResourceUrl } = ctx;
  mountAdminGrantDiscovery(app, requireAdmin, engine, mcpResourceUrl.toString());
  mountAdminClients(app, requireAdmin, engine, mcpResourceUrl.toString());

  mountAdminRegistration(app, requireAdmin, engine, mcpResourceUrl, issuerUrl);

  // Update client TTL
  app.post('/admin/api/update-client-ttl', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { clientId, tokenTtl } = req.body;
      if (!clientId) { res.status(400).json({ error: 'clientId required' }); return; }
      if (tokenTtl === undefined) { res.status(400).json({ error: 'tokenTtl required' }); return; }
      const request = parseAdminGrantRequest(req.body);
      const result = await rescopeClientGrant(engine, clientId, { tokenTtlSeconds: request.patch.tokenTtlSeconds }, { actor: 'admin-api', expectedRevision: request.expectedRevision, dryRun: request.dryRun });
      res.json(request.dryRun ? { ...result, tokenImplications: GRANT_TOKEN_IMPLICATIONS } : { updated: true, tokenTtl: result.after.tokenTtlSeconds, ...(request.expectedRevision !== undefined ? { revision: result.revision } : {}) });
    } catch (e) {
      res.status(grantHttpStatus(e)).json({ error: e instanceof Error ? e.message : 'Update failed' });
    }
  });

  mountAdminGrantEdits(app, requireAdmin, engine, oauthProvider);
  mountAdminAccess(app, requireAdmin, engine);
  mountAdminMemoryProposals(app, requireAdmin, engine);
  mountAdminPolicy(app, requireAdmin, engine);

  // Revoke OAuth client
  app.post('/admin/api/revoke-client', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { clientId } = req.body;
      if (!clientId) { res.status(400).json({ error: 'clientId required' }); return; }
      await oauthProvider.revokeClient(clientId);
      res.json({ revoked: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Revoke failed' });
    }
  });
}
