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
import { sqlQueryForEngine } from '../core/sql-query.ts';
import { VERSION } from '../version.ts';
import { mountAdminClients } from './serve-http-clients.ts';
import { mountAdminRegistration } from './serve-http-registration.ts';
import { parseAdminGrantRequest, grantHttpStatus, GRANT_TOKEN_IMPLICATIONS, mountAdminGrantDiscovery, mountAdminGrantEdits } from './serve-http-grants.ts';
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
  const sql = sqlQueryForEngine(engine);
  const rows = await sql`
    SELECT
      c.client_id,
      c.client_name,
      COALESCE(c.budget_usd_per_day, NULL) AS cap_usd_per_day,
      COALESCE((
        SELECT SUM(spend_cents)::text
          FROM mcp_spend_log
         WHERE client_id = c.client_id
           -- Double AT TIME ZONE: the inner one yields NAIVE UTC-midnight;
           -- the outer one converts it back to a timestamptz INSTANT. Without
           -- it, the naive value is reinterpreted in the SESSION timezone, so
           -- any non-UTC session (host-tz PGLite, a tz-configured Postgres
           -- role) shifts the day boundary by the offset and today's spend
           -- underreports every evening.
           AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      ), '0') AS spent_cents_today,
      COALESCE((
        SELECT SUM(estimated_cents)::text
          FROM mcp_spend_reservations
         WHERE client_id = c.client_id
           AND status IN ('pending', 'expired')
      ), '0') AS pending_cents,
      (SELECT COUNT(*)::int FROM mcp_spend_reservations
        WHERE client_id = c.client_id AND status IN ('pending', 'expired')
          AND estimate_known = false) AS unknown_count,
      COALESCE((
        SELECT COUNT(*)::int
          FROM minion_jobs
         WHERE name = 'subagent'
           AND status IN ('waiting', 'active', 'waiting-children', 'delayed', 'paused')
           AND data->>'__owner_client_id' = c.client_id
      ), 0) AS inflight_count
    FROM oauth_clients c
    WHERE c.deleted_at IS NULL
      AND ('agent' = ANY (string_to_array(c.scope, ' ')) OR c.bound_tools IS NOT NULL)
    ORDER BY c.client_name ASC
  `;
  return rows.map(r => ({
    client_id: String(r.client_id),
    client_name: String(r.client_name ?? r.client_id),
    cap_usd_per_day: r.cap_usd_per_day !== null && r.cap_usd_per_day !== undefined
      ? parseFloat(String(r.cap_usd_per_day))
      : null,
    spent_cents_today: parseFloat(String(r.spent_cents_today ?? '0')),
    pending_cents: parseFloat(String(r.pending_cents ?? '0')),
    unknown_count: Number(r.unknown_count ?? 0),
    inflight_count: Number(r.inflight_count ?? 0),
  }));
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
      const oauthClients = await sql`
        SELECT c.client_id as id, c.client_name as name, 'oauth' as auth_type,
          c.grant_types, c.scope, c.source_id, c.federated_read,
          c.created_at, c.token_ttl,
          CASE WHEN c.deleted_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status,
          (SELECT max(created_at) FROM mcp_request_log WHERE token_name = c.client_id) as last_used_at,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = c.client_id) as total_requests,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = c.client_id AND created_at > now() - interval '24 hours') as requests_today
        FROM oauth_clients c ORDER BY c.created_at DESC
      `;
      const legacyKeys = await sql`
        SELECT a.id, a.name, 'api_key' as auth_type,
          '{"bearer"}' as grant_types,
          a.scopes,
          a.created_at, null as token_ttl,
          CASE WHEN a.revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status,
          a.last_used_at,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = a.name) as total_requests,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = a.name AND created_at > now() - interval '24 hours') as requests_today
        FROM access_tokens a ORDER BY a.created_at DESC
      `;
      res.json([
        ...oauthClients,
        ...legacyKeys.map(({ scopes, ...key }) => ({
          ...key,
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
      const [clients] = await sql`SELECT count(*)::int as count FROM oauth_clients`;
      const [tokens] = await sql`SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at > ${Math.floor(Date.now() / 1000)}`;
      const [requests] = await sql`SELECT count(*)::int as count FROM mcp_request_log WHERE created_at > now() - interval '24 hours'`;
      const [apiKeys] = await sql`SELECT count(*)::int as count FROM access_tokens WHERE revoked_at IS NULL`;
      res.json({
        connected_agents: (clients as any).count,
        active_tokens: (tokens as any).count,
        active_api_keys: (apiKeys as any).count,
        requests_today: (requests as any).count,
      });
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  app.get('/admin/api/health-indicators', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const [expiring] = await sql`SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at BETWEEN ${now} AND ${now + 86400}`;
      // Excluded from the error numerator: success and success_with_warnings
      // (a warn-mode success); denied_after_list stays counted — a denied
      // call IS a failure signal. surface_change is an OPERATION value (audit
      // rows carry status='success'), so audit rows are excluded from BOTH
      // counts — they are records of operator/self actions, not traffic.
      const [errors] = await sql`SELECT count(*)::int as count FROM mcp_request_log WHERE status NOT IN ('success', 'success_with_warnings') AND operation != 'surface_change' AND created_at > now() - interval '24 hours'`;
      const [total] = await sql`SELECT count(*)::int as count FROM mcp_request_log WHERE operation != 'surface_change' AND created_at > now() - interval '24 hours'`;
      const errorRate = (total as any).count > 0 ? ((errors as any).count / (total as any).count * 100).toFixed(1) : '0';
      res.json({
        expiring_soon: (expiring as any).count,
        error_rate: `${errorRate}%`,
      });
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
      const takes = await engine.executeRaw<{
        id: string;
        page_slug: string;
        row_num: number;
        claim: string;
        weight: number;
        resolved_quality: string | null;
        since_date: string | null;
      }>(
        // `takes` has no page_slug column — it comes from the joined page.
        // id::text — it's a BIGSERIAL (bigint); res.json() below can't serialize a
        // raw bigint ("cannot serialize BigInt"), so project it as a string.
        `SELECT t.id::text AS id, p.slug AS page_slug, t.row_num, t.claim, t.weight, t.resolved_quality, t.since_date
           FROM takes t JOIN pages p ON p.id = t.page_id
           WHERE t.holder = $1 AND t.active = true AND t.resolved_at IS NOT NULL
           ORDER BY t.weight DESC, t.since_date DESC
           LIMIT 25`,
        [holder],
      );
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
        const rows = await engine.executeRaw<{
          id: number;
          page_slug: string;
          claim: string;
          weight: number;
          since_date: string;
        }>(
          // `takes` has no page_slug column — it comes from the joined page.
          // since_date is TEXT and may be month-precision ('YYYY-MM'); '2026-06'::date
          // throws "invalid input syntax for type date", so normalize to the 1st
          // before casting.
          `SELECT t.id, p.slug AS page_slug, t.claim, t.weight, t.since_date
             FROM takes t JOIN pages p ON p.id = t.page_id
             WHERE t.active = true AND t.resolved_at IS NULL AND t.superseded_by IS NULL
               AND t.weight >= 0.7
               AND (t.since_date || CASE WHEN length(t.since_date) = 7 THEN '-01' ELSE '' END)::date
                   < (now() - INTERVAL '12 months')
             ORDER BY t.since_date ASC
             LIMIT 5`,
        );
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
  const { engine, sql, requireAdmin } = ctx;
  app.get('/admin/api/requests', requireAdmin, async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = 50;
      const offset = (page - 1) * limit;
      const agent = req.query.agent as string;
      const operation = req.query.operation as string;
      const status = req.query.status as string;

      // Dynamic filtering: SqlQuery is deliberately scalar-only and does not
      // support fragment composition (the prior `sql\`AND ... = ${v}\`` shape).
      // Build the WHERE clause with positional placeholders + a params array.
      // `WHERE 1=1` lets us always have a WHERE clause and conditionally
      // append `AND col = $N` fragments — still parameterized, still escaped
      // by the driver, no sql.unsafe.
      const filters: string[] = [];
      const params: (string | number)[] = [];
      if (agent && agent !== 'all') {
        filters.push(`AND token_name = $${params.length + 1}`);
        params.push(agent);
      }
      if (operation && operation !== 'all') {
        filters.push(`AND operation = $${params.length + 1}`);
        params.push(operation);
      }
      if (status && status !== 'all') {
        filters.push(`AND status = $${params.length + 1}`);
        params.push(status);
      }
      const filterSql = filters.join(' ');
      const limitParam = `$${params.length + 1}`;
      const offsetParam = `$${params.length + 2}`;

      const rows = await engine.executeRaw(
        `SELECT id, token_name, COALESCE(agent_name, token_name) as agent_name,
                operation, latency_ms, status, params, error_message, created_at
         FROM mcp_request_log
         WHERE 1=1 ${filterSql}
         ORDER BY created_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
        [...params, limit, offset],
      );
      const [countResult] = await engine.executeRaw<{ total: number }>(
        `SELECT count(*)::int as total FROM mcp_request_log
         WHERE 1=1 ${filterSql}`,
        params,
      );
      res.json({ rows, total: countResult.total, page, pages: Math.ceil(countResult.total / limit) });
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  // Legacy API keys (access_tokens table)
  app.get('/admin/api/api-keys', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const keys = await sql`
        SELECT id, name, created_at, last_used_at,
          CASE WHEN revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status
        FROM access_tokens ORDER BY created_at DESC
      `;
      res.json(keys);
    } catch (e) {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  app.post('/admin/api/api-keys', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      if (!name) { res.status(400).json({ error: 'Name required' }); return; }
      const { generateToken, hashToken } = await import('../core/utils.ts');
      const token = generateToken('gbrain_');
      const hash = hashToken(token);
      const id = (await import('crypto')).randomUUID();
      await sql`INSERT INTO access_tokens (id, name, token_hash) VALUES (${id}, ${name}, ${hash})`;
      res.json({ name, token, id });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to create API key' });
    }
  });

  app.post('/admin/api/api-keys/revoke', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      if (!name) { res.status(400).json({ error: 'Name required' }); return; }
      await sql`UPDATE access_tokens SET revoked_at = now() WHERE name = ${name} AND revoked_at IS NULL`;
      res.json({ revoked: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Revoke failed' });
    }
  });
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
