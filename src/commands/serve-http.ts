/**
 * GBrain HTTP MCP server with OAuth 2.1.
 *
 * Combines:
 * - MCP SDK's mcpAuthRouter (OAuth endpoints: /authorize, /token, /register, /revoke)
 * - Custom client_credentials handler (SDK doesn't support CC grant)
 * - MCP tool calls at /mcp with bearer auth + scope enforcement
 * - Admin dashboard at /admin with cookie auth
 * - SSE live activity feed at /admin/events
 * - Health check at /health
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomBytes, createHash } from 'crypto';
import { safeHexEqual } from '../core/timing-safe.ts';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { OAuthTokenRevocationRequestSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError } from '../core/operations.ts';
import type { OperationContext, AuthInfo } from '../core/operations.ts';
import { GBrainOAuthProvider, validateTokenEndpointAuthMethod } from '../core/oauth-provider.ts';
import type { SqlQuery } from '../core/oauth-provider.ts';
import { hasScope, ALLOWED_SCOPES_LIST, normalizeScopesInput } from '../core/scope.ts';
import { summarizeMcpParams, dispatchToolCall } from '../mcp/dispatch.ts';
import { paramDefToSchema } from '../mcp/tool-defs.ts';
import { getBrainHotMemoryMeta } from '../core/facts/meta-hook.ts';
import { loadConfig } from '../core/config.ts';
import { buildError, serializeError } from '../core/errors.ts';
import { VERSION } from '../version.ts';
import * as db from '../core/db.ts';
import { sqlQueryForEngine, executeRawJsonb } from '../core/sql-query.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { isRetryableError } from '../core/retry-matcher.ts';
import {
  computeContentHash,
  validateIngestionEvent,
  type IngestionContentType,
  type IngestionEvent,
} from '../core/ingestion/types.ts';
import { resolveOwnerHolder } from '../core/owner-holder.ts';

/**
 * /health endpoint timeout. 3s rather than 5s: Fly.io's default
 * health-check timeout is 5s, so returning 503 right at the orchestrator
 * deadline races with the orchestrator recording the request as a timeout.
 * 3s leaves 2s of headroom for TCP, response framing, and clock skew.
 */
export const HEALTH_TIMEOUT_MS = 3000;

/**
 * v0.36.1.x #1024: bootstrap token resolution.
 *
 * Pure helper (no side effects, no process.exit) so the rule is unit-testable.
 * Two outcomes:
 *   - `ok`: caller proceeds with `{token, fromEnv}`. When the env value is
 *     undefined, a fresh 32-byte hex token is generated.
 *   - `error`: caller refuses to start. We require 32+ chars matching
 *     `[A-Za-z0-9_-]+` for env-supplied tokens — fail-closed beats silently
 *     accepting a weak admin secret.
 *
 * `randomBytesHex` is parameterized so tests can inject a deterministic
 * fallback without monkey-patching `crypto.randomBytes`.
 */
export type BootstrapTokenResolution =
  | { kind: 'ok'; token: string; fromEnv: boolean }
  | { kind: 'error'; message: string };

export function resolveBootstrapToken(
  envValue: string | undefined,
  randomBytesHex: () => string = () => randomBytes(32).toString('hex'),
): BootstrapTokenResolution {
  if (envValue === undefined) {
    return { kind: 'ok', token: randomBytesHex(), fromEnv: false };
  }
  const trimmed = envValue.trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(trimmed)) {
    return {
      kind: 'error',
      message:
        'GBRAIN_ADMIN_BOOTSTRAP_TOKEN must be at least 32 chars and match [A-Za-z0-9_-]+.\n' +
        '  Refusing to start with a weak admin bootstrap token. Generate one with:\n' +
        '    head -c 32 /dev/urandom | base64 | tr -d "+/=" | head -c 48',
    };
  }
  return { kind: 'ok', token: trimmed, fromEnv: true };
}

/**
 * #2624: decide whether the generated admin bootstrap token is hidden from
 * the startup banner. Fail-safe default: a generated token is NOT printed
 * unless stderr is an interactive TTY, so containerized (non-TTY) deploys
 * never ship the secret to centralized log storage. Env-sourced tokens are
 * always hidden (operator already holds them). Explicit --suppress hides
 * everything; --print-admin-token forces the raw value even on a non-TTY.
 */
export function shouldSuppressBootstrapPrint(opts: {
  suppress: boolean;
  fromEnv: boolean;
  forcePrint: boolean;
  isTty: boolean;
}): boolean {
  if (opts.suppress) return true;
  if (opts.fromEnv) return true;
  if (opts.forcePrint) return false;
  return !opts.isTty;
}

export type OAuthTokenRateLimitConfig = {
  windowMs: number;
  max: number;
};

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveOAuthTokenRateLimit(env: NodeJS.ProcessEnv = process.env): OAuthTokenRateLimitConfig {
  return {
    windowMs: parsePositiveIntEnv(env.GBRAIN_OAUTH_TOKEN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    max: parsePositiveIntEnv(env.GBRAIN_OAUTH_TOKEN_RATE_LIMIT_MAX, 50),
  };
}

export type ProbeHealthResult =
  | { ok: true; status: 200; body: { status: 'ok'; version: string; engine: string; [k: string]: unknown } }
  | { ok: false; status: 503; body: { error: 'service_unavailable'; error_description: string } };

/**
 * Pure async health probe. Races `engine.getStats()` against a timeout,
 * returns a tagged result. No Express coupling — easy to unit-test with a
 * mock engine. The /health route handler is a thin wrapper around this.
 */
export async function probeHealth(
  engine: BrainEngine,
  engineName: string,
  version: string,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<ProbeHealthResult> {
  // Capture the handle so we can clearTimeout when getStats() wins. Without
  // this, every fast /health request leaves a 3s pending timer in the event
  // loop until it fires — under high probe rates this builds up a rolling
  // backlog of timers and avoidable wakeups. Both adversarial reviewers
  // (Claude + Codex) flagged this independently.
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const stats = await Promise.race([
      engine.getStats(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('health_timeout')), timeoutMs);
      }),
    ]);
    return {
      ok: true,
      status: 200,
      body: { status: 'ok', version, engine: engineName, ...stats },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return {
      ok: false,
      status: 503,
      body: {
        error: 'service_unavailable',
        error_description: msg === 'health_timeout'
          ? 'Health check timed out (database pool may be saturated)'
          : 'Database connection failed',
      },
    };
  } finally {
    // Clear the timer regardless of which branch won the race. No-op when
    // the timer already fired (we're in the timeout-rejection catch block).
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Lightweight liveness probe. Races `SELECT 1` against the same timeout
 * `probeHealth` uses, returns the same tagged-union result type, but the
 * 200 body is intentionally bare: `{status, version, engine}` — no engine
 * stats. Stats moved to `/admin/api/full-stats` (admin auth) in v0.28.10
 * because `getStats()`'s six count(*) queries exceeded HEALTH_TIMEOUT_MS
 * on production brains through PgBouncer, producing false 503s that
 * triggered orchestrator restart cascades and advisory-lock pile-ups.
 */
export async function probeLiveness(
  sql: SqlQuery,
  engineName: string,
  version: string,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<ProbeHealthResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      sql`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('health_timeout')), timeoutMs);
      }),
    ]);
    return {
      ok: true,
      status: 200,
      body: { status: 'ok', version, engine: engineName },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return {
      ok: false,
      status: 503,
      body: {
        error: 'service_unavailable',
        error_description: msg === 'health_timeout'
          ? 'Health check timed out (database pool may be saturated)'
          : 'Database connection failed',
      },
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Resolve `GBRAIN_HTTP_TRUST_PROXY` into a value Express's `app.set('trust
 * proxy', ...)` accepts. Pure function so the test surface is one place,
 * not the whole Express stack.
 *
 * Mapping:
 *   - unset / empty → 'loopback' (pre-v0.41.3 default; trusts only
 *     127.0.0.1, ::1, ::ffff:127.0.0.1, fc00::/7)
 *   - '0' / 'false' → false (trust nothing; req.ip is socket peer regardless
 *     of X-Forwarded-For)
 *   - '1' / 'true' → 1 (trust exactly one hop; safe for Fly.io / Render /
 *     single-layer reverse proxy; matches the legacy transport's '==1' check)
 *   - other numeric → parseInt (trust N hops)
 *   - any other string → pass through verbatim (Express accepts named modes
 *     like 'uniquelocal', 'linklocal', and CIDR/IP lists)
 *
 * SECURITY: only set GBRAIN_HTTP_TRUST_PROXY when BOTH (a) gbrain is
 * reachable only via a trusted reverse proxy, AND (b) the proxy strips
 * client-supplied X-Forwarded-For headers before re-emitting its own.
 * Otherwise clients can spoof their IP and defeat the pre-auth IP rate
 * limit. See SECURITY.md "Reverse-proxy trust" for the full contract.
 */
export function resolveTrustProxy(env: string | undefined): string | number | boolean {
  if (env === undefined || env === '') return 'loopback';
  if (env === '0' || env === 'false') return false;
  if (env === '1' || env === 'true') return 1;
  if (/^\d+$/.test(env)) return parseInt(env, 10);
  return env;
}

/**
 * Parse `GBRAIN_HTTP_CORS_ORIGIN` into a Set of allowed origins for OAuth
 * endpoints. Mirrors `src/mcp/http-transport.ts:parseCorsAllowlist`. Single
 * env var so operators don't need to maintain two allowlists.
 *
 * Returns null when unset, empty, or whitespace-only — caller MUST treat
 * null as "deny all cross-origin" (the same posture the legacy transport
 * already takes).
 */
export function parseCorsAllowlistOAuth(): Set<string> | null {
  const v = process.env.GBRAIN_HTTP_CORS_ORIGIN;
  if (!v) return null;
  const origins = v.split(',').map(s => s.trim()).filter(Boolean);
  return origins.length === 0 ? null : new Set(origins);
}

/**
 * Build a `cors.CorsOptions['origin']` value from the allowlist. The cors
 * package accepts:
 *   - `false` → reject everything (no Allow-Origin header sent)
 *   - `(origin, cb) => cb(null, boolean)` → dynamic per-request check
 * We use the function form when an allowlist is set so the value of the
 * Allow-Origin header echoes the request Origin (RFC 6454) instead of a
 * hardcoded string, and so the same options object covers all listed
 * origins without enumeration in the response.
 *
 * Same-origin requests (no Origin header) get `cb(null, true)` which the
 * cors package translates to "no CORS headers needed" — they're not
 * cross-origin so they don't trigger the gate.
 */
export function resolveCorsOrigin(allowlist: Set<string> | null): cors.CorsOptions['origin'] {
  if (allowlist === null) return false;
  return (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true);
    cb(null, allowlist.has(origin));
  };
}

interface ServeHttpOptions {
  port: number;
  tokenTtl: number;
  enableDcr: boolean;
  /**
   * #1353: allow the consent-bypassing client_credentials grant on the DCR path.
   * Off by default; DCR clients default to authorization_code. Implies enableDcr.
   */
  enableDcrInsecure?: boolean;
  /**
   * Public URL the server is reachable at (e.g., https://brain.example.com).
   * Used as the OAuth issuer in discovery metadata. Defaults to
   * http://localhost:{port} when unset. Required for production deployments
   * behind reverse proxies, ngrok tunnels, or any non-loopback URL — the
   * issuer claim in tokens MUST match the discovery URL clients hit.
   */
  publicUrl?: string;
  /**
   * When true, write raw request payloads to mcp_request_log + the admin SSE
   * feed. Default false: payloads are summarized via dispatch.summarizeMcpParams
   * (declared keys only, no values, no attacker-controlled key names).
   *
   * Operators running gbrain on their own laptop and debugging agent behavior
   * can flip this on with `--log-full-params`. The flag prints a loud warning
   * at startup so the privacy posture change is visible.
   */
  logFullParams?: boolean;
  /**
   * Network interface(s) to bind. Defaults to `127.0.0.1` (loopback only) in
   * v0.34.1+ — gbrain's primary use case is a personal-knowledge brain on a
   * laptop, and the pre-v0.34 default of `0.0.0.0` made it one accidental
   * `--http` invocation away from publishing the brain to a LAN.
   *
   * Server operators who DO want to accept remote connections pass
   * `--bind 0.0.0.0` (or a specific interface IP). When `--public-url` is
   * set but `--bind` is unset, a stderr WARN fires at startup recommending
   * the explicit flag — defaulting to loopback while declaring a public URL
   * is almost always a misconfiguration.
   */
  bind?: string;
  /**
   * v0.36.x #1024: suppress the printed admin bootstrap token line on
   * startup. Combined with `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`, lets long-lived
   * production deployments avoid leaking the token into log aggregators on
   * every supervisor-managed restart. When the env var is NOT set, this
   * flag still suppresses the print — operators take responsibility for
   * tracking the regenerated value through other means.
   */
  suppressBootstrapToken?: boolean;
  /**
   * #2624: force-print the generated admin bootstrap token even on a
   * non-TTY (containerized) start. By default the raw token is only printed
   * when stderr is an interactive TTY, so it never lands in centralized log
   * storage for headless deploys. Set this when you genuinely need the value
   * captured to a non-interactive log and accept the leak.
   */
  printAdminToken?: boolean;
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
           AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
      ), '0') AS spent_cents_today,
      COALESCE((
        SELECT SUM(estimated_cents)::text
          FROM mcp_spend_reservations
         WHERE client_id = c.client_id
           AND status = 'pending'
           AND expires_at > now()
      ), '0') AS pending_cents,
      COALESCE((
        SELECT COUNT(*)::int
          FROM minion_jobs
         WHERE name = 'subagent'
           AND status IN ('waiting', 'active', 'waiting-children')
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
    inflight_count: Number(r.inflight_count ?? 0),
  }));
}

/**
 * Skill-publishing status for the startup banner + operator nudge. When OFF,
 * connected agents (Codex / Claude Code / Perplexity / Cowork) cannot call
 * `list_skills` / `get_skill`, so the host's skill catalog is INVISIBLE to them
 * — the core tools (search / query / get_page / put_page / capture / think /
 * find_experts) still work. Pure so the banner value + nudge copy are
 * unit-tested without standing up a server. See `readMcpPublishSkills`
 * (skill-catalog.ts) for the config resolution this status reflects.
 */
export function skillPublishStatus(publishSkills: boolean): { bannerValue: string; nudge: string | null } {
  if (publishSkills) return { bannerValue: 'published', nudge: null };
  return {
    bannerValue: 'not published',
    nudge:
      "[serve-http] NOTE: skill publishing is OFF — connected agents can't call " +
      'list_skills / get_skill, so this brain’s skill catalog is invisible to them ' +
      '(core tools like search / query / think still work). Enable it with: ' +
      'gbrain config set mcp.publish_skills true',
  };
}

/**
 * #1196: startup embedding-width guard for stateless host deployments.
 *
 * `embedding_model` / `embedding_dimensions` are file/env-plane only, so a
 * container booted WITHOUT a config.json (stateless host) resolves the
 * compiled-in default embedding width. Against an existing brain whose
 * `content_chunks.embedding` is a different `vector(N)`, every write then
 * fails with an opaque dim mismatch. Run doctor's existing
 * embedding_width_consistency check at serve startup and return a loud
 * banner (with the paste-ready recipe) when it isn't ok. Fail-open: a check
 * error never blocks serving read traffic.
 */
export async function embeddingWidthStartupWarning(engine: BrainEngine): Promise<string | null> {
  try {
    const { checkEmbeddingWidthConsistency } = await import('./doctor.ts');
    const check = await checkEmbeddingWidthConsistency(engine);
    if (check.status === 'ok') return null;
    return (
      `[serve-http] WARNING: embedding width check failed — writes that embed will fail until fixed.\n` +
      `${check.message}\n` +
      `Stateless hosts: embedding_model/embedding_dimensions resolve from env/config.json only — ` +
      `set GBRAIN_EMBEDDING_MODEL / GBRAIN_EMBEDDING_DIMENSIONS (or mount config.json) to match the brain's schema.`
    );
  } catch {
    return null;
  }
}

export async function runServeHttp(engine: BrainEngine, options: ServeHttpOptions) {
  const { port, tokenTtl, enableDcr, enableDcrInsecure, publicUrl, logFullParams } = options;
  // v0.34.1 (#864, D11): default bind flipped from 0.0.0.0 to 127.0.0.1.
  // gbrain's primary use case is a personal-knowledge brain on a laptop;
  // the pre-v0.34 default exposed brains on every interface. Server
  // operators who need remote access pass `--bind 0.0.0.0` (or a specific
  // interface). Declaring `--public-url` without `--bind` is almost always
  // a misconfiguration; we WARN to stderr at startup in that case rather
  // than silently binding loopback only.
  const bind = options.bind ?? '127.0.0.1';
  const config = loadConfig() || { engine: 'pglite' as const };

  if (logFullParams) {
    console.error(
      '[serve-http] WARNING: --log-full-params writes raw request payloads to mcp_request_log + SSE feed. Disable for shared dashboards or production.',
    );
  }

  if (publicUrl && options.bind === undefined) {
    console.error(
      '[serve-http] WARNING: --public-url is set but --bind is not. Default bind changed to 127.0.0.1 in v0.34.1; remote clients reaching the public URL will be refused. Pass --bind 0.0.0.0 to accept all interfaces.',
    );
  }

  // #1196: fail-loud at startup when the resolved embedding width diverges
  // from the brain's actual vector(N) column (stateless containers falling
  // through to the compiled-in default). Non-fatal: reads still work.
  {
    const widthWarn = await embeddingWidthStartupWarning(engine);
    if (widthWarn) console.error(widthWarn);
  }

  // Skill-publishing status for the banner + nudge. Mirrors readMcpPublishSkills
  // (skill-catalog.ts): the DB plane (`gbrain config set`) wins over the file
  // plane. When OFF, a connected coding agent can't see the host's skill
  // catalog — surface that to the operator at startup rather than letting them
  // discover it via an empty list_skills on the agent side.
  let publishSkills = false;
  try {
    const dbVal = await engine.getConfig('mcp.publish_skills');
    publishSkills = dbVal != null ? dbVal === 'true' : config?.mcp?.publish_skills === true;
  } catch {
    publishSkills = config?.mcp?.publish_skills === true;
  }
  const skillStatus = skillPublishStatus(publishSkills);
  if (skillStatus.nudge) console.error(skillStatus.nudge);

  // Note when this brain ships a brain-resident pack so the operator knows
  // connecting harnesses will be offered it (only meaningful when publishing
  // is on — list_brain_skillpack is gated by the same flag). Fail-open.
  if (publishSkills) {
    try {
      const { loadAllSources } = await import('../core/sources-load.ts');
      const { loadSkillpackManifest } = await import('../core/skillpack/manifest-v1.ts');
      const { existsSync } = await import('fs');
      const { join } = await import('path');
      const srcs = await loadAllSources(engine);
      let n = 0;
      for (const s of srcs) {
        if (!s.local_path || !existsSync(join(s.local_path, 'skillpack.json'))) continue;
        try {
          if (loadSkillpackManifest(s.local_path).brain_resident === true) n++;
        } catch {
          /* malformed pack → ignore */
        }
      }
      if (n > 0) {
        console.error(
          `[serve-http] NOTE: ${n} source${n === 1 ? '' : 's'} ship a brain-resident skillpack — ` +
            'connecting harnesses can discover it via list_brain_skillpack and will be offered to install it.',
        );
      }
    } catch {
      /* fail-open: banner is cosmetic */
    }
  }

  // Engine-aware SQL adapter. Routes through engine.executeRaw on both
  // Postgres and PGLite — the OAuth/admin/auth surface no longer requires
  // a postgres.js singleton, so `gbrain serve --http` works against PGLite
  // brains too. The narrow SqlQuery contract is scalar-binds-only; JSONB
  // writes use executeRawJsonb (see mcp_request_log INSERT sites below).
  const sql = sqlQueryForEngine(engine);

  // Initialize OAuth provider. F12 cleanup: DCR-disable now flips a
  // constructor option instead of monkey-patching `_clientsStore` after
  // construction. Same outcome (no /register endpoint when --enable-dcr
  // is not passed); cleaner shape for tests and future maintainers.
  const oauthProvider = new GBrainOAuthProvider({
    sql,
    tokenTtl,
    dcrDisabled: !enableDcr,
    allowClientCredentialsDcr: enableDcrInsecure === true,
  });

  // #1353: loud stderr security WARN when DCR is enabled. DCR is an
  // unauthenticated network registration endpoint; surface the posture change
  // (and the extra blast radius of --enable-dcr-insecure) so it's visible in
  // logs, not buried in the neutral "DCR: enabled" banner line.
  if (enableDcr) {
    console.error(
      'SECURITY WARNING: Dynamic Client Registration (--enable-dcr) is ON. ' +
      'Any network caller can self-register an OAuth client. DCR clients default ' +
      'to the authorization_code (consent-bearing) grant. See SECURITY.md.',
    );
    if (enableDcrInsecure) {
      console.error(
        'SECURITY WARNING: --enable-dcr-insecure is ON — self-registered DCR ' +
        'clients may request the client_credentials grant, which BYPASSES the ' +
        '/authorize consent screen. Only use this on a trusted network.',
      );
    }
  }

  // Sweep expired tokens on startup (non-blocking)
  try {
    const swept = await oauthProvider.sweepExpiredTokens();
    if (swept > 0) console.error(`Swept ${swept} expired tokens`);
  } catch (e) {
    console.error('Token sweep failed (non-blocking):', e instanceof Error ? e.message : e);
  }

  // v0.36.x #1024: bootstrap token sourcing.
  //
  // Default: regenerate per process start, print to stderr so the operator
  // can paste into /admin login. Stable across restarts only when env var
  // is set. The env override must be a strong secret — `[A-Za-z0-9_-]{32+}`
  // — otherwise refuse to start. Logging the bootstrap-token value every
  // restart is the original gripe; with `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` set
  // and `--suppress-bootstrap-token`, no value reaches the log.
  const resolved = resolveBootstrapToken(process.env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN);
  if (resolved.kind === 'error') {
    console.error(resolved.message);
    process.exit(1);
  }
  let bootstrapToken: string = resolved.token;
  let bootstrapFromEnv: boolean = resolved.fromEnv;
  const bootstrapHash = createHash('sha256').update(bootstrapToken).digest('hex');
  const suppressBootstrapPrint = shouldSuppressBootstrapPrint({
    suppress: options.suppressBootstrapToken === true,
    fromEnv: bootstrapFromEnv,
    forcePrint: options.printAdminToken === true,
    isTty: process.stderr.isTTY === true,
  });
  const adminSessions = new Map<string, number>(); // sessionId → expiresAt

  // SSE clients for live activity feed
  const sseClients = new Set<express.Response>();

  // Broadcast MCP request event to all SSE clients
  function broadcastEvent(event: Record<string, unknown>) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); } catch { sseClients.delete(client); }
    }
  }

  // Express 5 app
  const app = express();
  // v0.41.3 (T8): configurable trust-proxy via GBRAIN_HTTP_TRUST_PROXY env.
  // Default 'loopback' (trust Caddy/Tailscale on the same host) preserves
  // pre-v0.41.3 behavior. Operators behind Fly.io / Render / Vercel / nginx
  // set GBRAIN_HTTP_TRUST_PROXY=1 (one hop) so X-Forwarded-For lands as the
  // real client IP for rate-limiting and req.secure detection. The legacy
  // transport already reads this env var (src/mcp/http-transport.ts:111)
  // for the same purpose; T8 makes the Express path agree.
  app.set('trust proxy', resolveTrustProxy(process.env.GBRAIN_HTTP_TRUST_PROXY));

  // ---------------------------------------------------------------------------
  // Cookie parsing — required for /admin auth (express 5 has no built-in)
  // ---------------------------------------------------------------------------
  app.use(cookieParser());

  // ---------------------------------------------------------------------------
  // CORS (v0.41.3, T7 — default-deny on every OAuth endpoint)
  // ---------------------------------------------------------------------------
  // Pre-v0.41.3 every OAuth endpoint used bare `cors()` which defaults to
  // `Access-Control-Allow-Origin: *` — any web origin could complete a token
  // exchange from a logged-in operator's browser. The fix parses
  // GBRAIN_HTTP_CORS_ORIGIN the same way the legacy transport already does
  // (src/mcp/http-transport.ts:parseCorsAllowlist) and gates every OAuth
  // surface behind the allowlist. When the env var is unset the OAuth
  // endpoints reject all cross-origin requests (default deny). Same-origin
  // requests are unaffected because browsers send no Origin header for them.
  //
  // The /admin SPA is the one cross-origin caller we expect on a personal
  // laptop install; it ships co-located with the brain and uses
  // same-origin XHR, so the lockdown doesn't break it.
  const corsAllowlistOAuth = parseCorsAllowlistOAuth();
  if (!corsAllowlistOAuth && bind === '0.0.0.0') {
    console.error(
      '[serve-http] WARNING: --bind 0.0.0.0 is set but GBRAIN_HTTP_CORS_ORIGIN is unset. OAuth endpoints will reject ALL cross-origin requests until you set the env var (comma-separated origins).',
    );
  }
  const corsOAuthOptions: cors.CorsOptions = {
    origin: resolveCorsOrigin(corsAllowlistOAuth),
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  };
  app.use('/mcp', cors(corsOAuthOptions));
  app.use('/token', cors(corsOAuthOptions));
  app.use('/authorize', cors(corsOAuthOptions));
  app.use('/register', cors(corsOAuthOptions));
  app.use('/revoke', cors(corsOAuthOptions));

  // ---------------------------------------------------------------------------
  // Custom client_credentials handler (before mcpAuthRouter)
  // SDK's token handler only supports authorization_code and refresh_token
  // ---------------------------------------------------------------------------
  const oauthTokenRateLimit = resolveOAuthTokenRateLimit();
  const ccRateLimiter = rateLimit({
    windowMs: oauthTokenRateLimit.windowMs,
    max: oauthTokenRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests', error_description: 'Rate limit exceeded. Try again later.' },
  });

  // Magic-link rate limiter: 10 requests/min/IP. The bootstrap token is
  // 64-char hex (unguessable) so brute-forcing is computationally
  // infeasible — but a misconfigured client looping on /admin/auth/:bad
  // could DoS the server's CPU on sha256 + the inline HTML response.
  // Defense-in-depth on the highest-privileged URL the server exposes.
  const adminAuthRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many magic-link attempts. Wait a minute before trying again.',
  });

  app.post('/token', ccRateLimiter, express.urlencoded({ extended: false }), async (req, res, next) => {
    if (req.body?.grant_type !== 'client_credentials') {
      return next(); // Fall through to confidential-client handler or SDK
    }

    try {
      const { client_id, client_secret, scope } = req.body;
      if (!client_id || !client_secret) {
        res.status(400).json({ error: 'invalid_request', error_description: 'client_id and client_secret required' });
        return;
      }

      const tokens = await oauthProvider.exchangeClientCredentials(client_id, client_secret, scope);
      res.json(tokens);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      res.status(400).json({ error: 'invalid_grant', error_description: msg });
    }
  });

  // ---------------------------------------------------------------------------
  // v0.37.7.0 #1166: Custom authorization_code + refresh_token handler for
  // CONFIDENTIAL clients. The MCP SDK's clientAuth middleware does plaintext
  // `client.client_secret !== presented_secret` compare; we store
  // SHA-256 hashes, so the SDK's compare always fails for confidential
  // clients. This middleware verifies the secret hash ourselves before
  // calling the provider's exchange methods directly.
  //
  // Public clients (token_endpoint_auth_method='none') fall through to
  // the SDK's handler — the v0.34.1.0 PKCE path stays canonical.
  // ---------------------------------------------------------------------------
  app.post('/token', ccRateLimiter, async (req, res, next) => {
    const grantType = req.body?.grant_type;
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      return next();
    }

    // Detect confidential auth: either client_secret in body
    // (client_secret_post) OR Authorization: Basic header
    // (client_secret_basic). Public PKCE clients omit both.
    const bodySecret: string | undefined = req.body?.client_secret;
    let clientId: string | undefined = req.body?.client_id;
    let presentedSecret: string | undefined = bodySecret;
    const authHeader = (req.headers.authorization ?? '').toString();
    if (!presentedSecret && authHeader.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        if (idx > -1) {
          clientId ||= decodeURIComponent(decoded.slice(0, idx));
          presentedSecret = decodeURIComponent(decoded.slice(idx + 1));
        }
      } catch {
        // Malformed Basic header → falls through; SDK will reject
      }
    }
    if (!clientId || !presentedSecret) {
      return next(); // Public client path; SDK handles.
    }

    try {
      const client = await oauthProvider.verifyConfidentialClientSecret(clientId, presentedSecret);
      let tokens;
      if (grantType === 'authorization_code') {
        const code = req.body.code;
        const redirectUri = req.body.redirect_uri;
        const codeVerifier = req.body.code_verifier;
        if (!code) {
          res.status(400).json({ error: 'invalid_request', error_description: 'code required' });
          return;
        }
        tokens = await oauthProvider.exchangeAuthorizationCode(client, code, codeVerifier, redirectUri);
      } else {
        const refreshToken = req.body.refresh_token;
        const scopeParam = typeof req.body.scope === 'string' ? req.body.scope.split(/\s+/) : undefined;
        if (!refreshToken) {
          res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token required' });
          return;
        }
        tokens = await oauthProvider.exchangeRefreshToken(client, refreshToken, scopeParam);
      }
      res.json(tokens);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      // RFC 6749: invalid_client for auth failures, invalid_grant for
      // code/token problems. "Invalid client" → 401; everything else 400.
      if (msg === 'Invalid client' || msg === 'Client has been revoked') {
        res.status(401).json({ error: 'invalid_client', error_description: msg });
      } else {
        res.status(400).json({ error: 'invalid_grant', error_description: msg });
      }
    }
  });

  // The SDK's /revoke handler compares the presented secret with
  // client.client_secret as plaintext. GBrain stores only a SHA-256 hash, so
  // confidential clients need the same hash-aware validation used above for
  // authorization_code and refresh_token exchanges. Public clients present no
  // secret and continue through to the SDK's PKCE-compatible handler.
  app.post('/revoke', ccRateLimiter, express.urlencoded({ extended: false }), async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');

    const rawClientId: unknown = req.body?.client_id;
    const rawBodySecret: unknown = req.body?.client_secret;
    const authHeader = (req.headers.authorization ?? '').toString();

    // RFC 6749 §2.3: one client-authentication method per request. Reject
    // duplicates/arrays from express.urlencoded rather than letting them reach
    // hashToken() as non-strings and become a misleading invalid_client error.
    const hasBasicAuth = /^Basic\b/i.test(authHeader);
    if (
      (rawClientId !== undefined && typeof rawClientId !== 'string') ||
      (rawBodySecret !== undefined && typeof rawBodySecret !== 'string') ||
      (hasBasicAuth && (rawClientId !== undefined || rawBodySecret !== undefined))
    ) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Malformed or mixed client authentication' });
      return;
    }

    let clientId = typeof rawClientId === 'string' ? rawClientId : undefined;
    let presentedSecret = typeof rawBodySecret === 'string' && rawBodySecret.length > 0
      ? rawBodySecret
      : undefined;
    if (hasBasicAuth) {
      try {
        const match = authHeader.match(/^Basic\s+([^\s]+)$/i);
        if (!match) throw new Error('Malformed Basic authentication');
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        if (idx < 1) throw new Error('Malformed Basic authentication');
        clientId = decodeURIComponent(decoded.slice(0, idx).replace(/\+/g, ' '));
        presentedSecret = decodeURIComponent(decoded.slice(idx + 1).replace(/\+/g, ' '));
        if (!presentedSecret) throw new Error('Malformed Basic authentication');
      } catch {
        res.setHeader('WWW-Authenticate', 'Basic realm="gbrain"');
        res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client' });
        return;
      }
    }
    if (!clientId || !presentedSecret) return next();

    const parsedRequest = OAuthTokenRevocationRequestSchema.safeParse(req.body);
    if (!parsedRequest.success || parsedRequest.data.token.length === 0) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Valid token required' });
      return;
    }

    let client;
    try {
      client = await oauthProvider.verifyConfidentialClientSecret(clientId, presentedSecret);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'Invalid client' || msg === 'Client has been revoked') {
        if (hasBasicAuth) res.setHeader('WWW-Authenticate', 'Basic realm="gbrain"');
        res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client' });
        return;
      }
      console.error('[serve-http] revoke client verification failed:', msg || 'Unknown error');
      const retryable = isRetryableError(e);
      res.status(retryable ? 503 : 500).json({
        error: retryable ? 'temporarily_unavailable' : 'server_error',
        error_description: retryable ? 'Token revocation temporarily unavailable' : 'Token revocation failed',
      });
      return;
    }

    try {
      await oauthProvider.revokeToken(client, parsedRequest.data);
      // RFC 7009 §2.2: successful revocation, including an unknown token, is 200.
      res.status(200).end();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      console.error('[serve-http] token revocation failed:', msg);
      const retryable = isRetryableError(e);
      res.status(retryable ? 503 : 500).json({
        error: retryable ? 'temporarily_unavailable' : 'server_error',
        error_description: retryable ? 'Token revocation temporarily unavailable' : 'Token revocation failed',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // MCP SDK Auth Router (OAuth endpoints)
  // ---------------------------------------------------------------------------
  // The issuer URL goes into discovery metadata + token iss claims. It MUST
  // match the URL clients actually hit, or strict OAuth clients reject tokens
  // (RFC 8414 §3.3). Honor --public-url for production deployments behind
  // reverse proxies / tunnels; default to localhost for dev.
  const issuerUrl = new URL(publicUrl || `http://localhost:${port}`);

  // MCP authorization spec (2025-06-18 draft §5.1) and RFC 9728 require the
  // protected resource server to return its discovery metadata URL in the
  // WWW-Authenticate header on 401 responses:
  //
  //   WWW-Authenticate: Bearer resource_metadata="<URL>"
  //
  // Clients (claude.ai, Cursor, every other MCP-aware OAuth client) use that
  // URL to find the authorization-server discovery doc + token endpoint
  // without the user having to paste those URLs manually. Pre-fix the header
  // shipped `Bearer error="invalid_token", ...` with no resource_metadata
  // parameter, so MCP clients couldn't begin the OAuth flow from a fresh
  // 401 — they would silently fail to connect with a generic "couldn't
  // reach the MCP server" error.
  const resourceMetadataUrl = `${issuerUrl.toString().replace(/\/$/, '')}/.well-known/oauth-protected-resource`;

  // F9: cookie `secure` flag honors both the request's TLS state (req.secure
  // is set when express trust-proxy lands an X-Forwarded-Proto: https) AND
  // the operator's declared issuer protocol (so a Cloudflare-tunnel deploy
  // where the connection inside the tunnel looks like http but the public
  // URL is https still tags cookies Secure). Without this, an attacker on
  // the network path could MITM the admin cookie over plaintext.
  const adminCookie = (req: Request, maxAge: number) => ({
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: req.secure || issuerUrl.protocol === 'https:',
    maxAge,
    path: '/admin',
  });

  const authRouterOptions: any = {
    provider: oauthProvider,
    issuerUrl,
    // v0.28: scopesSupported sourced from ALLOWED_SCOPES_LIST so MCP clients
    // (Claude Desktop, ChatGPT, Perplexity) can discover sources_admin and
    // users_admin via /.well-known/oauth-authorization-server. The legacy
    // ['read','write','admin'] list left those new scopes invisible.
    scopesSupported: [...ALLOWED_SCOPES_LIST],
    resourceName: 'GBrain MCP Server',
  };

  // F12: DCR disable lives on the provider's constructor option above. The
  // SDK's mcpAuthRouter reads provider.clientsStore once and only wires up
  // /register when the store exposes registerClient — so passing dcrDisabled
  // to the constructor is sufficient. No monkey-patching here.

  const authRouter = mcpAuthRouter(authRouterOptions);

  // Patch the SDK's OAuth metadata to include client_credentials grant type.
  // The SDK hardcodes ['authorization_code', 'refresh_token'] — we intercept
  // the response and add client_credentials before it reaches the client.
  app.use((req, res, next) => {
    if (req.path === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      const origJson = res.json.bind(res);
      (res as any).json = (body: any) => {
        if (body?.grant_types_supported && !body.grant_types_supported.includes('client_credentials')) {
          body.grant_types_supported.push('client_credentials');
        }
        if (body?.token_endpoint_auth_methods_supported) {
          for (const method of ['client_secret_basic', 'none']) {
            if (!body.token_endpoint_auth_methods_supported.includes(method)) {
              body.token_endpoint_auth_methods_supported.push(method);
            }
          }
        }
        if (body?.revocation_endpoint_auth_methods_supported && !body.revocation_endpoint_auth_methods_supported.includes('client_secret_basic')) {
          body.revocation_endpoint_auth_methods_supported.push('client_secret_basic');
        }
        return origJson(body);
      };
    }
    next();
  });

  app.use(authRouter);

  // ---------------------------------------------------------------------------
  // Health check — liveness only. Full engine stats live at
  // /admin/api/full-stats (requireAdmin). See probeLiveness above for the why.
  // ---------------------------------------------------------------------------
  app.get('/health', async (_req, res) => {
    const result = await probeLiveness(sql, config.engine || 'pglite', VERSION);
    res.status(result.status).json(result.body);
  });

  // ---------------------------------------------------------------------------
  // Admin authentication (cookie-based)
  // ---------------------------------------------------------------------------
  // v0.40 D15.5: safeHexEqual extracted to src/core/timing-safe.ts so the new
  // /webhooks/github HMAC verifier reuses the same constant-time compare.
  // POST /admin/login — JSON body with token (for programmatic/UI login)
  app.post('/admin/login', express.json(), (req, res) => {
    const token = req.body?.token;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Token required' });
      return;
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    if (!safeHexEqual(tokenHash, bootstrapHash)) {
      res.status(401).json({ error: 'Invalid token. Check your terminal output.' });
      return;
    }

    const sessionId = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    adminSessions.set(sessionId, expiresAt);

    res.cookie('gbrain_admin', sessionId, adminCookie(req, 24 * 60 * 60 * 1000));
    res.json({ status: 'authenticated' });
  });

  // ---------------------------------------------------------------------------
  // Magic-link nonce store (single-use) — D11 + D12
  //
  // Trust model (codex review pushback resolved this):
  //   - Bootstrap token is the long-term server admin secret. Printed to
  //     stderr at startup; lives in operator's terminal scrollback only.
  //   - Magic-link URLs use one-time NONCES (not the bootstrap token).
  //     Agent calls POST /admin/api/issue-magic-link with the bootstrap
  //     token in Authorization: Bearer to mint a nonce. Nonce expires in
  //     5 minutes if unredeemed; consumed on first redemption.
  //   - Bootstrap token never appears in a URL → no leakage via browser
  //     history, proxy access logs, or Referer headers.
  //   - Cookie sessions are HttpOnly + SameSite=Strict, but the bootstrap
  //     token itself is never client-side-readable JS state (no
  //     localStorage/sessionStorage cache — D12).
  //
  // Memory bound: nonces auto-purged on expiry sweep + LRU cap of 1000
  // entries (an attacker minting millions can't OOM the server).
  // ---------------------------------------------------------------------------
  const magicLinkNonces = new Map<string, number>(); // nonce → expiresAt
  const consumedNonces = new Set<string>();
  const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const NONCE_LRU_CAP = 1000;

  // Best-effort GC: remove expired entries on each issue/redeem call.
  function pruneExpiredNonces() {
    const now = Date.now();
    for (const [nonce, expiresAt] of magicLinkNonces) {
      if (expiresAt < now) magicLinkNonces.delete(nonce);
    }
    // F10: bound the live-nonce store too. An attacker with the bootstrap
    // token (or a misbehaving agent) could mint nonces faster than they
    // expire. Map iteration order is insertion order, so dropping from the
    // front gives a simple FIFO eviction matching the consumedNonces pattern.
    if (magicLinkNonces.size > NONCE_LRU_CAP) {
      const drop = magicLinkNonces.size - NONCE_LRU_CAP;
      const it = magicLinkNonces.keys();
      for (let i = 0; i < drop; i++) magicLinkNonces.delete(it.next().value as string);
    }
    // Cap consumedNonces growth — drop oldest entries past the LRU cap.
    if (consumedNonces.size > NONCE_LRU_CAP) {
      const drop = consumedNonces.size - NONCE_LRU_CAP;
      const it = consumedNonces.values();
      for (let i = 0; i < drop; i++) consumedNonces.delete(it.next().value as string);
    }
  }

  // POST /admin/api/issue-magic-link — agent-callable mint endpoint.
  // Auth: Authorization: Bearer <bootstrapToken>. Returns one-time nonce.
  app.post('/admin/api/issue-magic-link', express.json(), (req: Request, res: Response) => {
    const auth = (req.headers.authorization || '') as string;
    const m = auth.match(/^Bearer\s+(\S+)$/i);
    if (!m) {
      res.status(401).json({ error: 'Authorization: Bearer <bootstrap-token> required' });
      return;
    }
    const tokenHash = createHash('sha256').update(m[1]).digest('hex');
    if (!safeHexEqual(tokenHash, bootstrapHash)) {
      res.status(401).json({ error: 'Invalid bootstrap token' });
      return;
    }
    pruneExpiredNonces();
    const nonce = randomBytes(32).toString('hex');
    magicLinkNonces.set(nonce, Date.now() + NONCE_TTL_MS);
    const baseUrl = publicUrl || `http://localhost:${port}`;
    res.json({ url: `${baseUrl}/admin/auth/${nonce}`, expires_in: NONCE_TTL_MS / 1000 });
  });

  // GET /admin/auth/:nonce — single-use magic link redemption.
  // Browser hits it, server validates the nonce (exists + unconsumed +
  // unexpired), marks consumed, sets cookie, redirects to dashboard.
  // Rate-limited at 10/min/IP to harden against DoS via bad-token loops.
  app.get('/admin/auth/:token', adminAuthRateLimiter, (req: Request, res: Response) => {
    const nonce = String(req.params.token ?? '');
    pruneExpiredNonces();

    const expiresAt = magicLinkNonces.get(nonce);
    const isValid = !!nonce && !!expiresAt && expiresAt > Date.now() && !consumedNonces.has(nonce);

    if (!isValid) {
      res.status(401).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GBrain</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{max-width:400px;padding:32px;text-align:left}
.logo{font-size:28px;font-weight:600;margin-bottom:24px}
.msg{color:#888;font-size:14px;line-height:1.6;margin-bottom:20px}
.hint{background:rgba(136,170,255,0.08);border:1px solid rgba(136,170,255,0.2);border-radius:8px;padding:14px 16px;font-size:13px;line-height:1.5;color:#888}
.hint b{color:#e0e0e0}
.prompt{background:rgba(0,0,0,0.3);border-radius:6px;padding:8px 12px;margin-top:8px;font-family:monospace;font-size:12px;color:#88aaff}
</style></head><body><div class="box">
<div class="logo">GBrain</div>
<div class="msg">⚠️ This admin link has expired, was already used, or the server has restarted.</div>
<div class="hint"><b>Get a fresh link from your AI agent:</b>
<div class="prompt">&ldquo;Give me the GBrain admin login link&rdquo;</div>
</div></div></body></html>`);
      return;
    }

    // Consume the nonce — it's single-use, second click will fail.
    magicLinkNonces.delete(nonce);
    consumedNonces.add(nonce);

    const sessionId = randomBytes(32).toString('hex');
    const sessionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days for magic link
    adminSessions.set(sessionId, sessionExpiresAt);

    res.cookie('gbrain_admin', sessionId, adminCookie(req, 7 * 24 * 60 * 60 * 1000));
    res.redirect('/admin/');
  });

  // Admin auth middleware
  function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
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
  }

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
          c.grant_types, c.scope, c.created_at, c.token_ttl,
          CASE WHEN c.deleted_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status,
          (SELECT max(created_at) FROM mcp_request_log WHERE token_name = c.client_id) as last_used_at,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = c.client_id) as total_requests,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = c.client_id AND created_at > now() - interval '24 hours') as requests_today
        FROM oauth_clients c ORDER BY c.created_at DESC
      `;
      const legacyKeys = await sql`
        SELECT a.id, a.name, 'api_key' as auth_type,
          '{"bearer"}' as grant_types, 'read write admin' as scope, a.created_at, null as token_ttl,
          CASE WHEN a.revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status,
          a.last_used_at,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = a.name) as total_requests,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = a.name AND created_at > now() - interval '24 hours') as requests_today
        FROM access_tokens a ORDER BY a.created_at DESC
      `;
      res.json([...oauthClients, ...legacyKeys]);
    } catch (e) {
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
      const [errors] = await sql`SELECT count(*)::int as count FROM mcp_request_log WHERE status != 'success' AND created_at > now() - interval '24 hours'`;
      const [total] = await sql`SELECT count(*)::int as count FROM mcp_request_log WHERE created_at > now() - interval '24 hours'`;
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

  // Register client from admin dashboard
  app.post('/admin/api/register-client', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      // v0.39.3.0 WARN-9 + CV12: accept BOTH `scopes` (admin SPA convention)
      // AND `scope` (OAuth wire-format convention, singular). The pre-fix
      // code destructured only `scopes` and used `scopes || 'read'` which:
      //   - Silently ignored `scope` requests (always defaulted to 'read')
      //   - Threw on array input because registerClientManual's parseScopeString
      //     calls .split(' ') which arrays don't have
      //   - Accepted `['read write']` (space-in-element bug shape codex flagged)
      //     and other malformed inputs
      // normalizeScopesInput handles all four valid shapes (string, string[],
      // missing, empty) and rejects the rest with a structured 400.
      const { name, tokenTtl, grantTypes, redirectUris, tokenEndpointAuthMethod } = req.body;
      const rawScopes = (req.body as Record<string, unknown>).scopes ?? (req.body as Record<string, unknown>).scope;
      if (!name) { res.status(400).json({ error: 'Name required' }); return; }
      let scopeString: string;
      try {
        scopeString = normalizeScopesInput(rawScopes);
      } catch (e) {
        res.status(400).json({
          error: 'invalid_scopes',
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      const grants = Array.isArray(grantTypes) && grantTypes.length > 0 ? grantTypes : ['client_credentials'];
      const uris = Array.isArray(redirectUris) ? redirectUris : [];
      // v0.41.3 (T1+T4): validate token_endpoint_auth_method via shared
      // ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS before reaching the provider.
      // Pre-v0.41.3 this endpoint did INSERT (confidential) → UPDATE (NULL
      // out secret_hash) for the 'none' case, which left a confidential
      // row stranded if the UPDATE failed (codex F4). Atomic now: pass the
      // method to registerClientManual and let it INSERT the correct row
      // in a single statement.
      let validatedAuthMethod: string | undefined;
      try {
        validatedAuthMethod = validateTokenEndpointAuthMethod(tokenEndpointAuthMethod);
      } catch (e) {
        res.status(400).json({
          error: 'invalid_token_endpoint_auth_method',
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      const result = await oauthProvider.registerClientManual(
        name, grants, scopeString, uris, 'default', undefined, validatedAuthMethod,
      );
      // Set per-client TTL if specified
      if (tokenTtl && Number(tokenTtl) > 0) {
        await sql`UPDATE oauth_clients SET token_ttl = ${Number(tokenTtl)} WHERE client_id = ${result.clientId}`;
      }
      res.json({ ...result, tokenTtl: tokenTtl ? Number(tokenTtl) : null });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Registration failed' });
    }
  });

  // Update client TTL
  app.post('/admin/api/update-client-ttl', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { clientId, tokenTtl } = req.body;
      if (!clientId) { res.status(400).json({ error: 'clientId required' }); return; }
      const ttl = tokenTtl === null || tokenTtl === 0 ? null : Number(tokenTtl);
      await sql`UPDATE oauth_clients SET token_ttl = ${ttl} WHERE client_id = ${clientId}`;
      res.json({ updated: true, tokenTtl: ttl });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Update failed' });
    }
  });

  // v0.42.x (#1914): rescope an OAuth client's write source / federated read
  // scope. Admin-gated on purpose — DCR clients must never self-widen their
  // scope (fail-closed trust); only the operator rescopes, here or via
  // `gbrain auth rescope-client`. Source ids are validated by the canonical
  // validator inside rescopeClient.
  app.post('/admin/api/rescope-client', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { clientId, sourceId, federatedRead } = req.body ?? {};
      if (!clientId || typeof clientId !== 'string') {
        res.status(400).json({ error: 'clientId required' });
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
      const result = await oauthProvider.rescopeClient(clientId, { sourceId, federatedRead });
      res.json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Rescope failed';
      const status = /No OAuth client found/.test(message) ? 404
        : /Invalid source_id|requires --source|cannot be empty|does not exist/.test(message) ? 400
        : 500;
      res.status(status).json({ error: message });
    }
  });

  // Revoke OAuth client
  app.post('/admin/api/revoke-client', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { clientId } = req.body;
      if (!clientId) { res.status(400).json({ error: 'clientId required' }); return; }
      // Soft-delete the client
      await sql`UPDATE oauth_clients SET deleted_at = now() WHERE client_id = ${clientId} AND deleted_at IS NULL`;
      // Revoke all active tokens for this client
      await sql`DELETE FROM oauth_tokens WHERE client_id = ${clientId}`;
      res.json({ revoked: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Revoke failed' });
    }
  });

  // ---------------------------------------------------------------------------
  // SSE live activity feed
  // ---------------------------------------------------------------------------
  app.get('/admin/events', requireAdmin, (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // ---------------------------------------------------------------------------
  // Admin SPA static files (v0.36.x #1090)
  // ---------------------------------------------------------------------------
  // Two-tier resolution:
  //   1. Dev path — admin/dist next to cwd. Vite rebuilds land here first,
  //      so devs hacking on the SPA see changes without re-running
  //      build-admin-embedded.
  //   2. Binary path — `src/admin-embedded.ts` exports `ADMIN_ASSETS`, a
  //      manifest of request-path → resolved-path keyed by every file in
  //      admin/dist at generation time. Bun's `with { type: 'file' }` ESM
  //      imports resolve correctly inside the compiled binary, so a
  //      globally-installed `gbrain serve --http` actually serves /admin
  //      instead of 404. Pre-fix the cwd-relative path was the ONLY
  //      resolution path, and every fresh install of the compiled binary
  //      hit 404 on /admin (issue #1090).
  const path = await import('path');
  const fs = await import('fs');
  const adminDistPath = path.join(process.cwd(), 'admin', 'dist');
  const useDevPath = fs.existsSync(adminDistPath);
  if (useDevPath) {
    app.use('/admin', express.static(adminDistPath));
    app.get('/admin/{*path}', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/admin/api/') || req.path === '/admin/events' || req.path === '/admin/login') {
        return next();
      }
      res.sendFile(path.join(adminDistPath, 'index.html'));
    });
  } else {
    // Embedded path. Read assets from the generated manifest. Cache the
    // bytes per asset on first request — these never change for a given
    // binary, so subsequent requests skip the fs read.
    const { ADMIN_ASSETS, ADMIN_INDEX_HTML } = await import('../admin-embedded.ts');
    const cache = new Map<string, Buffer>();
    function loadAsset(asset: { path: string }): Buffer {
      const hit = cache.get(asset.path);
      if (hit) return hit;
      const buf = fs.readFileSync(asset.path);
      cache.set(asset.path, buf);
      return buf;
    }
    app.get('/admin/{*path}', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/admin/api/') || req.path === '/admin/events' || req.path === '/admin/login') {
        return next();
      }
      const hit = ADMIN_ASSETS[req.path];
      if (hit) {
        res.setHeader('Content-Type', hit.mime);
        res.send(loadAsset(hit));
        return;
      }
      // SPA fallback — every unmatched /admin/* route resolves to index.html
      // so client-side routing takes over (login, dashboard, agents, ...).
      if (ADMIN_INDEX_HTML) {
        res.setHeader('Content-Type', ADMIN_INDEX_HTML.mime);
        res.send(loadAsset(ADMIN_INDEX_HTML));
        return;
      }
      res.status(404).send('admin SPA not available');
    });
  }

  // ---------------------------------------------------------------------------
  // MCP tool calls (bearer auth + scope enforcement)
  // ---------------------------------------------------------------------------
  const mcpOperations = operations.filter(op => !op.localOnly);

  // v0.36.x #1076: MCP Streamable HTTP spec — GET /mcp opens an optional SSE
  // backchannel for server-initiated messages. gbrain's transport is stateless
  // and doesn't push server-initiated messages, so per spec we MUST return 405
  // (not 404) so probing clients (claude.ai, etc.) recognize this as an MCP
  // endpoint, not a missing route. Without this, clients display "endpoint not
  // found" instead of "endpoint exists but no SSE channel."
  app.get('/mcp', (_req: Request, res: Response) => {
    res.set('Allow', 'POST, DELETE');
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  app.post('/mcp', requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl }), async (req: Request, res: Response) => {
    const startTime = Date.now();
    const authInfo = (req as any).auth as AuthInfo;

    // Human-readable agent name is now threaded through AuthInfo by
    // verifyAccessToken (which JOINs oauth_clients in its existing token
    // SELECT). No per-request DB roundtrip needed. Falls back to clientId
    // for legacy tokens or when the JOIN row's client_name is NULL.
    const agentName = authInfo.clientName ?? authInfo.clientId;

    // Create a fresh MCP server per request (stateless)
    const server = new Server(
      { name: 'gbrain', version: VERSION },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // v0.28.10: log every JSON-RPC method, not just successful tools/call.
      // Pre-fix, /admin/api/requests showed nothing for clients that only
      // ever called tools/list, and the v0.26.3 persistence regression test
      // asserting >= 2 rows after tools/list + tools/call was unreachable.
      const latency = Date.now() - startTime;
      try {
        await executeRawJsonb(
          engine,
          `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [authInfo.clientId, agentName, 'tools/list', latency, 'success'],
          [null],
        );
      } catch { /* best effort */ }
      broadcastEvent({
        agent: agentName,
        operation: 'tools/list',
        scopes: authInfo.scopes.join(','),
        latency_ms: latency,
        status: 'success',
        timestamp: new Date().toISOString(),
      });
      return {
        tools: mcpOperations.map(op => ({
          name: op.name,
          description: op.description,
          inputSchema: {
            type: 'object' as const,
            properties: Object.fromEntries(
              Object.entries(op.params).map(([k, v]) => [k, paramDefToSchema(v)]),
            ),
            required: Object.entries(op.params).filter(([, v]) => v.required).map(([k]) => k),
          },
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: params } = request.params;
      const op = mcpOperations.find(o => o.name === name);
      if (!op) {
        // v0.28.10: persist unknown-op attempts. Operators investigating
        // misbehaving agents need to see the full attempt log, not just
        // valid-op success/error.
        const latency = Date.now() - startTime;
        try {
          await executeRawJsonb(
            engine,
            `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [authInfo.clientId, agentName, name, latency, 'error', `unknown_operation: ${name}`],
            [null],
          );
        } catch { /* best effort */ }
        broadcastEvent({
          agent: agentName,
          operation: name,
          scopes: authInfo.scopes.join(','),
          latency_ms: latency,
          status: 'error',
          error: { code: 'unknown_operation', message: `Unknown: ${name}` },
          timestamp: new Date().toISOString(),
        });
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_operation', message: `Unknown: ${name}` }) }], isError: true };
      }

      // Scope enforcement (v0.28: hasScope replaces exact-string-match so
      // admin tokens satisfy any scope, write satisfies read, and the new
      // sources_admin / users_admin scopes resolve through the same
      // hierarchy. Plain string includes() at this site would have made
      // sources_admin tokens look like they couldn't even read.)
      const requiredScope = op.scope || 'read';
      if (!hasScope(authInfo.scopes, requiredScope)) {
        // v0.28.10: persist scope-rejected attempts. Same operator-visibility
        // motivation as the unknown-op path — and it makes the v0.26.3
        // persistence regression test reliable across both rejection paths.
        const latency = Date.now() - startTime;
        try {
          await executeRawJsonb(
            engine,
            `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [authInfo.clientId, agentName, name, latency, 'error', `insufficient_scope: requires '${requiredScope}'`],
            [null],
          );
        } catch { /* best effort */ }
        broadcastEvent({
          agent: agentName,
          operation: name,
          scopes: authInfo.scopes.join(','),
          latency_ms: latency,
          status: 'error',
          error: { code: 'insufficient_scope', message: `requires '${requiredScope}'` },
          timestamp: new Date().toISOString(),
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'insufficient_scope',
              message: `Operation ${name} requires '${requiredScope}' scope`,
              your_scopes: authInfo.scopes,
            }),
          }],
          isError: true,
        };
      }

      // F8: redact request payload by default (declared keys only via the
      // op's `params` allow-list; values + attacker-controlled key names
      // never written to mcp_request_log or the SSE feed). --log-full-params
      // bypasses this for operators debugging on their own laptop, with the
      // startup warning printed earlier.
      //
      // D1 (v0.31 wave): mcp_request_log.params is JSONB. Pre-v0.31 wrote
      // a JSON-string into that JSONB column via the postgres.js template
      // tag's loose typing — readable but semantically wrong (params->>'op'
      // would return the encoded string, not the value). Post-v0.31 we
      // pass the OBJECT through executeRawJsonb with an explicit ::jsonb
      // cast, so reads return real objects and `params->>'op'` returns
      // 'tools/list'. Pre-existing string-shaped rows are normalized by
      // migration v41 in src/core/migrate.ts.
      const safeParamsSummary = summarizeMcpParams(name, params);
      const logParamsObj: unknown = logFullParams
        ? (params || null)
        : (safeParamsSummary || null);
      const broadcastParams = logFullParams ? (params || {}) : safeParamsSummary;

      // v0.31 (D12 / eE1): refactor the inlined op.handler call to go through
      // src/mcp/dispatch.ts so HTTP MCP shares the same dispatch path as
      // stdio MCP. The dispatcher does param validation, OperationContext
      // build, error envelope unification, and (new) `_meta.brain_hot_memory`
      // injection via the metaHook. HTTP-specific concerns (mcp_request_log
      // persistence + SSE broadcast) stay here; the dispatcher returns the
      // ToolResult and we read isError + _meta to pick the right branch.
      const tokenAllowList = (authInfo as AuthInfo & { takesHoldersAllowList?: string[] }).takesHoldersAllowList
        ?? ['world'];
      // v0.34.1 (#861, D13): AuthInfo.sourceId is now a real typed field
      // populated from oauth_clients.source_id (migration v60 backfilled
      // NULL → 'default'). Pre-fix this site cast through AuthInfo and
      // fell back to GBRAIN_SOURCE env / 'default' — the silent-fallback
      // path codex flagged in plan review. Post-v60, every OAuth client
      // has source_id set; legacy bearer tokens default to 'default' in
      // verifyAccessToken. The env-fallback is gone.
      const tokenSourceId = authInfo.sourceId ?? 'default';

      let toolResult: Awaited<ReturnType<typeof dispatchToolCall>>;
      try {
        toolResult = await dispatchToolCall(engine, name, params as Record<string, unknown> | undefined, {
          remote: true,
          takesHoldersAllowList: tokenAllowList,
          sourceId: tokenSourceId,
          metaHook: getBrainHotMemoryMeta,
          // v0.31 follow-up fix: thread auth so the whoami op (and any
          // future scope-aware handlers) can introspect the caller. The
          // original D12/eE1 refactor moved dispatch into dispatchToolCall
          // but forgot to pass authInfo; whoami fell through to the
          // unknown_transport throw because ctx.auth was undefined.
          auth: authInfo,
          logger: {
            info: (msg: string) => console.error(`[INFO] ${msg}`),
            warn: (msg: string) => console.error(`[WARN] ${msg}`),
            error: (msg: string) => console.error(`[ERROR] ${msg}`),
          },
        });
      } catch (e) {
        // dispatchToolCall absorbs OperationError + Error and returns
        // isError:true; only an unexpected throw lands here. Treat as the
        // F15 unified envelope. v0.31 wave (D1): mcp_request_log.params is
        // JSONB — write the object via executeRawJsonb so reads return a
        // real object, not a JSON-encoded string.
        const latency = Date.now() - startTime;
        const errorPayload = serializeError(e);
        try {
          await executeRawJsonb(
            engine,
            `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [authInfo.clientId, agentName, name, latency, 'error', errorPayload.message],
            [logParamsObj],
          );
        } catch { /* best effort */ }
        broadcastEvent({
          agent: agentName,
          operation: name,
          params: broadcastParams,
          scopes: authInfo.scopes.join(','),
          latency_ms: latency,
          status: 'error',
          error: errorPayload,
          timestamp: new Date().toISOString(),
        });
        return { content: [{ type: 'text', text: JSON.stringify({ error: errorPayload }) }], isError: true };
      }

      const latency = Date.now() - startTime;
      if (toolResult.isError) {
        // dispatchToolCall serializes the error into the content text;
        // for the audit log we re-extract a message string for the
        // mcp_request_log error_message column. Best-effort parse.
        let errMsg = 'unknown_error';
        try {
          const parsed = JSON.parse(toolResult.content[0]?.text ?? '{}');
          errMsg = parsed.error?.message ?? parsed.message ?? errMsg;
        } catch { /* ignore */ }
        try {
          await executeRawJsonb(
            engine,
            `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [authInfo.clientId, agentName, name, latency, 'error', errMsg],
            [logParamsObj],
          );
        } catch { /* best effort */ }
        broadcastEvent({
          agent: agentName,
          operation: name,
          params: broadcastParams,
          scopes: authInfo.scopes.join(','),
          latency_ms: latency,
          status: 'error',
          error: { code: 'op_error', message: errMsg },
          timestamp: new Date().toISOString(),
        });
        return toolResult;
      }

      try {
        await executeRawJsonb(
          engine,
          `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [authInfo.clientId, agentName, name, latency, 'success'],
          [logParamsObj],
        );
      } catch { /* best effort */ }
      broadcastEvent({
        agent: agentName,
        operation: name,
        params: broadcastParams,
        scopes: authInfo.scopes.join(','),
        latency_ms: latency,
        status: 'success',
        timestamp: new Date().toISOString(),
      });
      return toolResult;
    });

    // F14: wrap transport setup + handleRequest in try/catch. Without this,
    // an SDK-level throw (e.g., schema parse failure on a malformed request)
    // propagates to express's default error handler, which renders an HTML
    // error page — clients expecting JSON-RPC envelopes break. On
    // !res.headersSent we emit a minimal JSON 500 so the client at least
    // gets parseable JSON back.
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as any });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP request handler error:', e instanceof Error ? e.message : e);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'internal_error',
          message: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // v0.38 ingestion substrate — POST /ingest (webhook source)
  //
  // The webhook ingestion source lives INSIDE serve --http (NOT in the
  // ingestion daemon) per the /plan-eng-review E1 decision. This avoids
  // cross-process IPC: the daemon supervises only daemon-side sources
  // (file-watcher, inbox-folder, cron-scheduler) while serve --http hosts
  // the network surface and submits Minion jobs directly.
  //
  // Auth: existing OAuth `write` scope. Rate limit: 100 events / 10s per
  // IP (reuses the IP-keyed pattern from ccRateLimiter; a future tweak
  // could key on authInfo.clientId for fairer per-agent fairness).
  // Payload cap: 1 MB default. Content-type allowlist: markdown, plain,
  // HTML, JSON. Binary content is REJECTED with HTTP 415 in v1 — the
  // binary-upload flow ships as a separate route in a later wave when
  // content-type processors land.
  //
  // Events always carry untrusted_payload: true because the input came
  // over the network from an OAuth-authenticated but otherwise untrusted
  // source (Zapier / IFTTT / Apple Shortcuts). The downstream
  // ingest_capture handler logs the flag; a future v2 wave wires it
  // through the put_page op to skip auto-link.
  // ---------------------------------------------------------------------------
  const ingestRateLimiter = rateLimit({
    windowMs: 10_000, // 10 seconds
    limit: 100, // 100 events per IP per window
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limit_exceeded', message: 'too many /ingest events; backoff and retry' },
  });

  // Maximum payload bytes for POST /ingest. Configurable via env. Default 1 MB.
  const ingestMaxBytes = (() => {
    const fromEnv = process.env.GBRAIN_INGEST_MAX_BYTES;
    if (!fromEnv) return 1_048_576;
    const n = parseInt(fromEnv, 10);
    return Number.isFinite(n) && n > 0 ? n : 1_048_576;
  })();

  // Content-type allowlist: text-shaped types only in v1. The handler
  // routes binary content_types with HTTP 415; a future wave + skillpack
  // processors will accept image/audio/video/pdf via a separate flow.
  const INGEST_ALLOWED_CONTENT_TYPES: ReadonlySet<IngestionContentType> = new Set([
    'text/markdown',
    'text/plain',
    'text/html',
    'application/json',
  ]);

  // Single MinionQueue instance shared across POST /ingest invocations
  // (the queue is stateless beyond the engine handle; reusing avoids
  // per-request construction).
  const ingestQueue = new MinionQueue(engine);

  app.post(
    '/ingest',
    ingestRateLimiter,
    requireBearerAuth({ verifier: oauthProvider, requiredScopes: ['write'], resourceMetadataUrl }),
    express.raw({ type: '*/*', limit: ingestMaxBytes }),
    async (req: Request, res: Response) => {
      const startTime = Date.now();
      const authInfo = (req as Request & { auth?: AuthInfo }).auth as AuthInfo;
      const agentName = authInfo.clientName ?? authInfo.clientId;

      // v0.39.3.0 BUG-2: outer try/catch ensures any unexpected throw
      // returns a JSON envelope instead of leaking express's default HTML
      // error page. Mirrors the MCP handler's F14 pattern (serve-http.ts
      // F14 envelope around transport.handleRequest). The `!res.headersSent`
      // guard (codex F#16) prevents a second-response attempt if the throw
      // happens after the inner queue.add try/catch already responded.
      try {

      // v0.39.3.0 BUG-2: explicit null/undefined guard BEFORE body coercion.
      // When the request has no body at all (no Content-Length header, no
      // body-parser fed us anything), `req.body` is `undefined`. The pre-fix
      // code's `else` branch called `Buffer.from(JSON.stringify(undefined),
      // 'utf8')` — and `JSON.stringify(undefined) === undefined` (the
      // literal, not the string), which makes `Buffer.from(undefined, 'utf8')`
      // throw TypeError. Express's default error handler then served an HTML
      // 500 page. Guard fires first to keep the response shape JSON.
      if (req.body == null) {
        res.status(400).json({
          error: 'empty_body',
          message: 'POST /ingest requires a non-empty body',
        });
        return;
      }

      // Express raw() returns a Buffer. Decode as UTF-8; reject non-UTF-8
      // bytes loudly so callers know their payload was garbled.
      let body: Buffer;
      if (Buffer.isBuffer(req.body)) {
        body = req.body;
      } else if (typeof req.body === 'string') {
        body = Buffer.from(req.body, 'utf8');
      } else {
        // express.json or urlencoded fired earlier in the chain and parsed
        // for us. Re-serialize so we can hash and forward. The null/undefined
        // case is already guarded above so JSON.stringify produces a real
        // string here (objects round-trip, primitives become their JSON form).
        body = Buffer.from(JSON.stringify(req.body), 'utf8');
      }

      if (body.length === 0) {
        res.status(400).json({ error: 'empty_body', message: 'POST /ingest requires a non-empty body' });
        return;
      }

      // Detect content_type. Caller can override via the X-Gbrain-Content-Type
      // header for the JSON case (since the request's Content-Type would say
      // application/json but the user might intend the body to be markdown).
      const declared = (req.header('x-gbrain-content-type') || req.header('content-type') || '').toLowerCase();
      let contentType: IngestionContentType;
      if (declared.startsWith('text/markdown')) {
        contentType = 'text/markdown';
      } else if (declared.startsWith('text/html')) {
        contentType = 'text/html';
      } else if (declared.startsWith('text/plain')) {
        contentType = 'text/plain';
      } else if (declared.startsWith('application/json')) {
        contentType = 'application/json';
      } else if (declared.startsWith('text/')) {
        // Unknown text/* sub-types pass through as text/plain.
        contentType = 'text/plain';
      } else {
        // Binary or unknown — rejected in v1.
        res.status(415).json({
          error: 'unsupported_content_type',
          message: `content_type '${declared}' not supported. Use one of: ${[...INGEST_ALLOWED_CONTENT_TYPES].join(', ')}. ` +
            'Binary content (image/audio/video/pdf) is not yet supported via POST /ingest — install a content-type processor skillpack.',
        });
        return;
      }

      if (!INGEST_ALLOWED_CONTENT_TYPES.has(contentType)) {
        res.status(415).json({
          error: 'unsupported_content_type',
          message: `content_type '${contentType}' is in the taxonomy but not currently accepted by POST /ingest`,
        });
        return;
      }

      const content = body.toString('utf8');
      const contentHash = computeContentHash(content);
      const sourceUri = (req.header('x-gbrain-source-uri') || `mcp-webhook:${authInfo.clientId}:${Date.now()}`).slice(0, 1024);
      const sourceId = (req.header('x-gbrain-source-id') || `webhook-${authInfo.clientId}`).slice(0, 256);
      const callerSlug = req.header('x-gbrain-slug');

      const event: IngestionEvent = {
        source_id: sourceId,
        source_kind: 'webhook',
        source_uri: sourceUri,
        received_at: new Date().toISOString(),
        content_type: contentType,
        content,
        content_hash: contentHash,
        untrusted_payload: true, // ALWAYS true for network input
        metadata: {
          ip: req.ip,
          user_agent: req.header('user-agent') ?? '',
          client_id: authInfo.clientId,
          ...(callerSlug ? { slug: callerSlug } : {}),
        },
      };

      const validationErr = validateIngestionEvent(event);
      if (validationErr) {
        res.status(400).json({
          error: 'invalid_event',
          message: validationErr.message,
          field: validationErr.field,
        });
        return;
      }

      try {
        const job = await ingestQueue.add(
          'ingest_capture',
          {
            event,
            ...(callerSlug ? { slug: callerSlug } : {}),
          },
          {
            // Idempotency: same content from the same client within the
            // queue's lifetime is a single job. Different content gets
            // different jobs. Daemon-side dedup catches the 24h window;
            // the queue-level idempotency catches simultaneous retries.
            idempotency_key: `ingest:webhook:${authInfo.clientId}:${contentHash}`,
            // Cap waiting jobs from a single client so a runaway integration
            // can't fill the queue.
            maxWaiting: 50,
          },
        );

        const latency = Date.now() - startTime;
        try {
          await executeRawJsonb(
            engine,
            `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [authInfo.clientId, agentName, 'webhook_ingest', latency, 'success'],
            [{ content_type: contentType, content_hash: contentHash, bytes: body.length, job_id: job.id }],
          );
        } catch { /* best effort */ }
        broadcastEvent({
          agent: agentName,
          operation: 'webhook_ingest',
          scopes: authInfo.scopes.join(','),
          latency_ms: latency,
          status: 'success',
          timestamp: new Date().toISOString(),
        });

        res.status(202).json({
          job_id: job.id,
          content_hash: contentHash,
          source_id: sourceId,
          message: 'Accepted. Event queued for ingestion.',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('POST /ingest queue submission error:', msg);
        res.status(500).json({
          error: 'queue_submission_failed',
          message: msg,
        });
      }

      // v0.39.3.0 BUG-2: outer try/catch close — anything that throws BEFORE
      // the inner queue.add try/catch lands here. The headersSent guard
      // (codex F#16) skips the second-response attempt if the inner block
      // already wrote a response and then threw on a downstream line (e.g.
      // a logging side-effect after `res.status(202).json(...)`).
      } catch (outerErr) {
        const msg = outerErr instanceof Error ? outerErr.message : String(outerErr);
        console.error('POST /ingest unexpected handler error:', msg);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'internal_error',
            message: msg,
          });
        }
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /webhooks/github — push-triggered sync (v0.40 Federated Sync v2)
  // ---------------------------------------------------------------------------
  // Anonymous endpoint by necessity (GitHub doesn't carry an OAuth token).
  // Auth is via per-source HMAC-SHA256 in the X-Hub-Signature-256 header.
  //
  // D3: 60 req/min/IP rate limit + pre-DB short-circuit on missing
  //     signature, so probe traffic doesn't even touch the source-lookup
  //     query.
  // D5: event=push AND ref-match against sources.config.tracked_branch.
  //     Other event types (ping, pull_request, etc.) return 202 'ignored'
  //     so GitHub doesn't retry.
  // D15.5: HMAC compare uses the shared safeHexEqual helper.
  // D18: submits 'sync' job with extraction + auto_embed_backfill enabled and
  //     priority -10 (above autopilot's 0). This opts normal incremental pushes
  //     into sync's inline extraction while pagesAffected still identifies the
  //     changed pages. The sync core can still defer large (>100) changes.
  // ---------------------------------------------------------------------------
  const githubWebhookLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limit_exceeded', message: 'too many GitHub webhook requests' },
  });

  app.post(
    '/webhooks/github',
    githubWebhookLimiter,
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req: Request, res: Response) => {
      // D3 pre-DB short-circuit: missing signature → 401 without any
      // source lookup. Bot probe traffic ends here.
      const sigHeader = req.header('X-Hub-Signature-256');
      if (!sigHeader) {
        res.status(401).json({ error: 'missing_signature', message: 'X-Hub-Signature-256 header is required' });
        return;
      }

      // D5: filter by event header. GitHub fires webhooks for every event
      // type. Anything other than 'push' is acknowledged with 202 + reason
      // so GitHub doesn't retry — but no source lookup or job submission.
      const event = req.header('X-GitHub-Event') ?? '';
      if (event !== 'push') {
        res.status(202).json({ status: 'ignored', reason: `event=${event || '(missing)'}` });
        return;
      }

      const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body), 'utf8');
      if (payload.length === 0) {
        res.status(400).json({ error: 'empty_body' });
        return;
      }

      let parsed: { repository?: { full_name?: string }; ref?: string };
      try {
        parsed = JSON.parse(payload.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'malformed_json' });
        return;
      }

      const fullName = parsed.repository?.full_name;
      const ref = parsed.ref;
      if (!fullName || !ref) {
        res.status(400).json({ error: 'missing_fields', message: 'repository.full_name and ref are required' });
        return;
      }

      // Source lookup via the v87 partial expression index on
      // config->>'github_repo'. fast even on large brains.
      let source: { id: string; config: Record<string, unknown> | string } | null = null;
      try {
        const rows = await engine.executeRaw<{ id: string; config: Record<string, unknown> | string }>(
          `SELECT id, config FROM sources WHERE config->>'github_repo' = $1 LIMIT 1`,
          [fullName],
        );
        source = rows[0] ?? null;
      } catch (err) {
        console.error('webhook: source lookup error:', err);
        res.status(500).json({ error: 'lookup_failed' });
        return;
      }
      if (!source) {
        res.status(404).json({ error: 'unknown_repo', repo: fullName });
        return;
      }

      const cfg = (typeof source.config === 'string' ? JSON.parse(source.config) : source.config) as {
        webhook_secret?: string;
        tracked_branch?: string;
      };

      // D5: ref must match the configured tracked branch (default 'main').
      const trackedBranch = cfg.tracked_branch ?? 'main';
      const expectedRef = `refs/heads/${trackedBranch}`;
      if (ref !== expectedRef) {
        res.status(202).json({
          status: 'ignored',
          reason: `ref_mismatch`,
          received_ref: ref,
          tracked_branch: trackedBranch,
        });
        return;
      }

      const secret = cfg.webhook_secret;
      if (!secret || typeof secret !== 'string') {
        res.status(401).json({ error: 'webhook_not_configured', message: 'Run: gbrain sources webhook set ' + source.id });
        return;
      }

      // HMAC verify. GitHub sends "sha256=<hex>" — strip the prefix BEFORE
      // safeHexEqual because Buffer.from('sha256=...', 'hex') silently
      // truncates at the first non-hex char (the 's'), leaving both
      // operands as 0-byte buffers and making every signature "match".
      // Pinned by test/sources-webhook.test.ts tamper assertions.
      const { createHmac } = await import('node:crypto');
      const computedHex = createHmac('sha256', secret).update(payload).digest('hex');
      const prefix = 'sha256=';
      if (!sigHeader.startsWith(prefix)) {
        res.status(401).json({ error: 'signature_mismatch', message: 'expected sha256= prefix' });
        return;
      }
      if (!safeHexEqual(sigHeader.slice(prefix.length), computedHex)) {
        res.status(401).json({ error: 'signature_mismatch' });
        return;
      }

      // Submit sync job with priority -10 (above autopilot's 0).
      try {
        const queue = new MinionQueue(engine);
        const job = await queue.add(
          'sync',
          {
            sourceId: source.id,
            noExtract: false,
            auto_embed_backfill: true,
            embed_reason: 'webhook',
          },
          {
            priority: -10,
            idempotency_key: `webhook:sync:${source.id}:${Math.floor(Date.now() / 30_000)}`,
            maxWaiting: 1,
          },
        );
        res.status(202).json({ job_id: job.id, source_id: source.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('webhook: queue submission error:', msg);
        res.status(500).json({ error: 'queue_submission_failed', message: msg });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Start server
  // ---------------------------------------------------------------------------
  const clientCount = await sql`SELECT count(*)::int as count FROM oauth_clients`;

  app.listen(port, bind, () => {
    console.error(`
╔══════════════════════════════════════════════════════╗
║  GBrain MCP Server v${VERSION.padEnd(37)}║
╠══════════════════════════════════════════════════════╣
║  Port:      ${String(port).padEnd(40)}║
║  Bind:      ${bind.padEnd(40)}║
║  Engine:    ${(config.engine || 'pglite').padEnd(40)}║
║  Issuer:    ${issuerUrl.origin.padEnd(40)}║
║  Clients:   ${String((clientCount[0] as any).count).padEnd(40)}║
║  DCR:       ${(enableDcr ? (enableDcrInsecure ? 'enabled (INSECURE: client_credentials)' : 'enabled') : 'disabled').padEnd(40)}║
║  Skills:    ${skillStatus.bannerValue.padEnd(40)}║
║  Token TTL: ${(tokenTtl + 's').padEnd(40)}║
╠══════════════════════════════════════════════════════╣
║  Admin:     http://localhost:${port}/admin${' '.repeat(Math.max(0, 19 - String(port).length))}║
║  MCP:       http://localhost:${port}/mcp${' '.repeat(Math.max(0, 21 - String(port).length))}║
║  Health:    http://localhost:${port}/health${' '.repeat(Math.max(0, 18 - String(port).length))}║
╠══════════════════════════════════════════════════════╣
${bootstrapFromEnv
  ? '║  Admin Token: from $GBRAIN_ADMIN_BOOTSTRAP_TOKEN     ║\n╚══════════════════════════════════════════════════════╝'
  : suppressBootstrapPrint
    ? '║  Admin Token: hidden (non-TTY log-leak guard)        ║\n║  set $GBRAIN_ADMIN_BOOTSTRAP_TOKEN, or pass          ║\n║  --print-admin-token on a trusted terminal.          ║\n╚══════════════════════════════════════════════════════╝'
    : `║  Admin Token (paste into /admin login):              ║\n║  ${bootstrapToken.substring(0, 50)}  ║\n║  ${bootstrapToken.substring(50).padEnd(50)}  ║\n╚══════════════════════════════════════════════════════╝`}
`);
  });
}
