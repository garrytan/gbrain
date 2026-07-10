/**
 * PMBrain HTTP MCP server with OAuth 2.1.
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
import type { Server as HttpServer } from 'node:http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomBytes, createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { safeHexEqual } from '../core/timing-safe.ts';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError } from '../core/operations.ts';
import type { OperationContext, AuthInfo } from '../core/operations.ts';
import { GBrainOAuthProvider, legacyAccessTokenScopes, legacyAccessTokenSourceScope, validateTokenEndpointAuthMethod } from '../core/oauth-provider.ts';
import type { SqlQuery } from '../core/oauth-provider.ts';
import { hasScope, ALLOWED_SCOPES_LIST, normalizeScopesInput } from '../core/scope.ts';
import { summarizeMcpParams, dispatchToolCall } from '../mcp/dispatch.ts';
import { paramDefToSchema } from '../mcp/tool-defs.ts';
import { getBrainHotMemoryMeta } from '../core/facts/meta-hook.ts';
import { loadConfig, toEngineConfig, type GBrainConfig } from '../core/config.ts';
import { buildError, serializeError } from '../core/errors.ts';
import { assessDestructiveImpact, softDeleteSource, restoreSource } from '../core/destructive-guard.ts';
import { deleteLockRow } from '../core/db-lock.ts';
import { VERSION } from '../version.ts';
import * as db from '../core/db.ts';
import { sqlQueryForEngine, executeRawJsonb } from '../core/sql-query.ts';
import { resolveMainSourceId } from '../core/source-resolver.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import {
  computeContentHash,
  validateIngestionEvent,
  type IngestionContentType,
  type IngestionEvent,
} from '../core/ingestion/types.ts';
import {
  executePreview,
  getAdminBrainOverview,
  getAdminBrainPageChunks,
  getAdminDreamOverview,
  getAdminLlmStatus,
  getRun,
  cancelRun,
  listAdminBrainPages,
  listRuns,
  previewIntent,
  resolveCliEntry,
  startActionRun,
  startDreamRun,
  startImportRun,
  startSourceAddRun,
} from './admin-console.ts';
import {
  buildChatGptTunnelProfile,
  CHATGPT_TUNNEL_TOKEN_NAME,
  chatGptTunnelPaths,
  defaultTunnelClientBinary,
  detectTunnelHttpProxy,
  getChatGptTunnelStatus,
  runTunnelDoctor,
  startTunnelClient,
  stopTunnelClient,
  writeChatGptTunnelProfile,
  writePrivateFile,
} from '../core/chatgpt-tunnel.ts';

const ADMIN_README_CANDIDATES = [
  new URL('../../README.md', import.meta.url),
  new URL('../README.md', import.meta.url),
  new URL('./README.md', import.meta.url),
];

const ADMIN_DOCS_EMPTY_MARKDOWN = '暂无';

export async function loadAdminReadmeMarkdown(
  candidates: URL[] = ADMIN_README_CANDIDATES,
): Promise<{ markdown: string; source: 'file' | 'missing'; path?: string }> {
  for (const candidate of candidates) {
    try {
      return {
        markdown: await readFile(candidate, 'utf8'),
        source: 'file',
        path: candidate.toString(),
      };
    } catch {
      // Packaged desktop runtimes may not include repository README.md.
    }
  }
  return { markdown: ADMIN_DOCS_EMPTY_MARKDOWN, source: 'missing' };
}

function envCompat(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

function pgTextArray(arr: string[]): string {
  if (!arr || arr.length === 0) return '{}';
  return `{${arr.map(s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

async function authInfoWithMainSource(engine: BrainEngine, authInfo: AuthInfo): Promise<{ auth: AuthInfo; sourceId: string }> {
  const mainSourceId = await resolveMainSourceId(engine);
  const rawSourceId = authInfo.sourceId;
  const sourceId = !rawSourceId || rawSourceId === 'default' ? mainSourceId : rawSourceId;
  const allowed = authInfo.allowedSources;
  const nextAllowed = allowed && allowed.length > 0
    ? allowed.map(id => id === 'default' ? mainSourceId : id)
    : allowed;
  const nextAuth = nextAllowed !== allowed || sourceId !== rawSourceId
    ? { ...authInfo, sourceId, allowedSources: nextAllowed }
    : authInfo;
  return { auth: nextAuth, sourceId };
}

async function normalizeAdminAgentSourceScope(
  engine: BrainEngine,
  sourceIdInput: unknown,
  federatedReadInput: unknown,
): Promise<{ sourceId: string; federatedRead: string[] }> {
  const mainSourceId = await resolveMainSourceId(engine);
  const sourceId = typeof sourceIdInput === 'string' && sourceIdInput.trim()
    ? sourceIdInput.trim()
    : mainSourceId;
  const requestedRead = Array.isArray(federatedReadInput)
    ? federatedReadInput.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim())
    : [];
  const federatedRead = Array.from(new Set(requestedRead.length > 0 ? requestedRead : [sourceId]));
  const ids = Array.from(new Set([sourceId, ...federatedRead]));
  const rows = await engine.executeRaw<{ id: string; archived: boolean }>(
    `SELECT id, archived FROM sources`,
    [],
  );
  const found = new Map(rows.map(row => [row.id, row.archived]));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length > 0) {
    const err = new Error(`source_not_found: ${missing.join(', ')}`);
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  const archived = ids.filter(id => found.get(id));
  if (archived.length > 0) {
    const err = new Error(`archived_source_not_allowed: ${archived.join(', ')}`);
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
  return { sourceId, federatedRead };
}

async function adminWorkerPidFile(): Promise<string> {
  const { join } = await import('path');
  return join(process.cwd(), '.gbrain', 'admin-worker.pid');
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
        'PMBRAIN_ADMIN_BOOTSTRAP_TOKEN must be at least 32 chars and match [A-Za-z0-9_-]+.\n' +
        '  Refusing to start with a weak admin bootstrap token. Generate one with:\n' +
        '    head -c 32 /dev/urandom | base64 | tr -d "+/=" | head -c 48',
    };
  }
  return { kind: 'ok', token: trimmed, fromEnv: true };
}

export function renderAdminTokenFooter(opts: {
  suppressBootstrapPrint: boolean;
  bootstrapFromEnv: boolean;
  bootstrapToken: string;
}): string {
  if (opts.suppressBootstrapPrint) {
    return '║  Admin Token: suppressed (--suppress-bootstrap-token) ║\n╚══════════════════════════════════════════════════════╝';
  }
  const source = opts.bootstrapFromEnv ? 'env/config' : 'generated';
  return `║  Admin Token (${source}; copy next line into /admin login) ║\n${opts.bootstrapToken}\n╚══════════════════════════════════════════════════════╝`;
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

function waitForHttpServerClose(server: HttpServer, engine: BrainEngine): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      server.off('error', onError);
      server.off('close', onClose);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };

    const finish = async (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        await engine.disconnect();
      } catch (disconnectErr) {
        if (!err) {
          reject(disconnectErr);
          return;
        }
      }
      if (err) reject(err);
      else resolve();
    };

    const shutdown = (signal: string) => {
      console.error(`PMBrain HTTP server: graceful shutdown (${signal})`);
      server.close((err) => {
        if (err) void finish(err);
        else void finish();
      });
    };

    const onError = (err: Error) => { void finish(err); };
    const onClose = () => { void finish(); };
    const onSigint = () => shutdown('SIGINT');
    const onSigterm = () => shutdown('SIGTERM');

    server.on('error', onError);
    server.on('close', onClose);
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}

function listenHttpServer(
  app: express.Express,
  port: number,
  bind: string,
  onListening: () => void,
): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = app.listen(port, bind);

    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListeningEvent);
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onListeningEvent = () => {
      if (settled) return;
      settled = true;
      cleanup();
      onListening();
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListeningEvent);
  });
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
  const v = envCompat('PMBRAIN_HTTP_CORS_ORIGIN', 'GBRAIN_HTTP_CORS_ORIGIN');
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

export function filterMcpOperationsByScopes<T extends { scope?: string }>(
  list: readonly T[],
  scopes: readonly string[],
): T[] {
  return list.filter(op => hasScope(scopes, op.scope || 'read'));
}

export const CHATGPT_TUNNEL_READ_ONLY_TOOLS = Object.freeze([
  'get_brain_identity',
  'search',
  'query',
  'list_pages',
  'get_page',
  'get_chunks',
  'recall',
] as const);

const CHATGPT_TUNNEL_READ_ONLY_TOOL_SET = new Set<string>(CHATGPT_TUNNEL_READ_ONLY_TOOLS);

export function isChatGptTunnelClient(authInfo: Pick<AuthInfo, 'clientId' | 'clientName'>): boolean {
  return authInfo.clientId === CHATGPT_TUNNEL_TOKEN_NAME || authInfo.clientName === CHATGPT_TUNNEL_TOKEN_NAME;
}

export function filterMcpOperationsForAuth<T extends { name: string; scope?: string }>(
  list: readonly T[],
  authInfo: Pick<AuthInfo, 'clientId' | 'clientName' | 'scopes'>,
): T[] {
  const scoped = filterMcpOperationsByScopes(list, authInfo.scopes);
  if (!isChatGptTunnelClient(authInfo)) return scoped;
  return scoped.filter(op => CHATGPT_TUNNEL_READ_ONLY_TOOL_SET.has(op.name));
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function buildMcpProtectedResourceMetadata(issuerUrl: URL) {
  return {
    resource: new URL('/mcp', issuerUrl).toString(),
    authorization_servers: [issuerUrl.toString()],
    scopes_supported: [...ALLOWED_SCOPES_LIST],
    resource_name: 'PMBrain MCP Server',
  };
}

interface ServeHttpOptions {
  port: number;
  tokenTtl: number;
  enableDcr: boolean;
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

export interface AdminTakeProposalRow {
  id: number;
  source_id: string;
  page_slug: string;
  status: string;
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string | null;
  model_id: string;
  proposed_at: string;
  acted_at: string | null;
  acted_by: string | null;
  promoted_row_num: number | null;
  existing_take_count: number;
}

const TAKE_PROPOSAL_STATUSES = new Set(['pending', 'accepted', 'rejected', 'superseded', 'all']);

function normalizeTakeProposalStatus(status: unknown): string {
  const raw = typeof status === 'string' && status.trim() ? status.trim() : 'pending';
  return TAKE_PROPOSAL_STATUSES.has(raw) ? raw : 'pending';
}

export async function listAdminTakeProposals(
  engine: BrainEngine,
  opts: { status?: string; limit?: number } = {},
): Promise<AdminTakeProposalRow[]> {
  const status = normalizeTakeProposalStatus(opts.status);
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  return await engine.executeRaw<AdminTakeProposalRow>(
    `SELECT tp.id::int AS id, tp.source_id, tp.page_slug, tp.status, tp.claim_text, tp.kind, tp.holder,
            tp.weight, tp.domain, tp.model_id, tp.proposed_at, tp.acted_at, tp.acted_by,
            tp.promoted_row_num::int AS promoted_row_num,
            COALESCE(tc.n, 0)::int AS existing_take_count
       FROM take_proposals tp
       LEFT JOIN pages p ON p.source_id = tp.source_id AND p.slug = tp.page_slug
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS n FROM takes t WHERE t.page_id = p.id
       ) tc ON true
      WHERE ($1 = 'all' OR tp.status = $1)
      ORDER BY tp.proposed_at DESC, tp.id DESC
      LIMIT $2`,
    [status, limit],
  );
}

export async function acceptAdminTakeProposal(
  engine: BrainEngine,
  id: number,
  actedBy = 'admin',
): Promise<AdminTakeProposalRow> {
  return await engine.transaction(async tx => {
    const rows = await tx.executeRaw<AdminTakeProposalRow & { page_id: number; next_row_num: number }>(
      `SELECT tp.id::int AS id, tp.source_id, tp.page_slug, tp.status, tp.claim_text, tp.kind, tp.holder,
              tp.weight, tp.domain, tp.model_id, tp.proposed_at, tp.acted_at, tp.acted_by,
              tp.promoted_row_num::int AS promoted_row_num, p.id::int AS page_id,
              (COALESCE((SELECT MAX(row_num) FROM takes WHERE page_id = p.id), 0) + 1)::int AS next_row_num,
              COALESCE((SELECT COUNT(*) FROM takes WHERE page_id = p.id), 0)::int AS existing_take_count
         FROM take_proposals tp
         JOIN pages p ON p.source_id = tp.source_id AND p.slug = tp.page_slug
        WHERE tp.id = $1
        FOR UPDATE OF tp`,
      [id],
    );
    const proposal = rows[0];
    if (!proposal) throw new Error('take proposal not found');
    if (proposal.status !== 'pending') throw new Error(`take proposal is already ${proposal.status}`);

    await tx.addTakesBatch([{
      page_id: proposal.page_id,
      row_num: proposal.next_row_num,
      claim: proposal.claim_text,
      kind: proposal.kind,
      holder: proposal.holder,
      weight: proposal.weight,
      source: `take_proposal:${proposal.id}`,
      active: true,
    }]);

    const updated = await tx.executeRaw<AdminTakeProposalRow>(
      `UPDATE take_proposals
          SET status = 'accepted',
              acted_at = now(),
              acted_by = $2,
              promoted_row_num = $3
        WHERE id = $1
        RETURNING id::int AS id, source_id, page_slug, status, claim_text, kind, holder, weight,
                  domain, model_id, proposed_at, acted_at, acted_by, promoted_row_num::int AS promoted_row_num,
                  $4::int AS existing_take_count`,
      [id, actedBy, proposal.next_row_num, proposal.existing_take_count + 1],
    );
    return updated[0]!;
  });
}

export async function rejectAdminTakeProposal(
  engine: BrainEngine,
  id: number,
  actedBy = 'admin',
): Promise<AdminTakeProposalRow> {
  return await engine.transaction(async tx => {
    const updated = await tx.executeRaw<AdminTakeProposalRow>(
      `UPDATE take_proposals
          SET status = 'rejected',
              acted_at = now(),
              acted_by = $2
        WHERE id = $1 AND status = 'pending'
        RETURNING id::int AS id, source_id, page_slug, status, claim_text, kind, holder, weight,
                  domain, model_id, proposed_at, acted_at, acted_by, promoted_row_num::int AS promoted_row_num,
                  0::int AS existing_take_count`,
      [id, actedBy],
    );
    if (!updated[0]) throw new Error('take proposal not found or already acted');
    return updated[0];
  });
}

export async function runServeHttp(engine: BrainEngine, options: ServeHttpOptions) {
  const { port, tokenTtl, enableDcr, publicUrl, logFullParams } = options;
  // v0.34.1 (#864, D11): default bind flipped from 0.0.0.0 to 127.0.0.1.
  // gbrain's primary use case is a personal-knowledge brain on a laptop;
  // the pre-v0.34 default exposed brains on every interface. Server
  // operators who need remote access pass `--bind 0.0.0.0` (or a specific
  // interface). Declaring `--public-url` without `--bind` is almost always
  // a misconfiguration; we WARN to stderr at startup in that case rather
  // than silently binding loopback only.
  const bind = options.bind ?? '127.0.0.1';
  const config = loadConfig() || { engine: 'pglite' as const };

  // PGLite lock coordination: release the engine lock before spawning a child
  // process (import/sync/etc.) so the child can acquire it; reconnect after.
  const runHooks = engine.kind === 'pglite' && config
    ? {
        beforeSpawn: () => engine.disconnect(),
        afterComplete: () => engine.connect(toEngineConfig(config as GBrainConfig)),
      }
    : undefined;

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
  });

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
  const resolved = resolveBootstrapToken(
    envCompat('PMBRAIN_ADMIN_BOOTSTRAP_TOKEN', 'GBRAIN_ADMIN_BOOTSTRAP_TOKEN')
      ?? config.admin_bootstrap_token,
  );
  if (resolved.kind === 'error') {
    console.error(resolved.message);
    process.exit(1);
  }
  let bootstrapToken: string = resolved.token;
  let bootstrapFromEnv: boolean = resolved.fromEnv;
  const bootstrapHash = createHash('sha256').update(bootstrapToken).digest('hex');
  const suppressBootstrapPrint = options.suppressBootstrapToken === true;
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
  app.set('trust proxy', resolveTrustProxy(envCompat('PMBRAIN_HTTP_TRUST_PROXY', 'GBRAIN_HTTP_TRUST_PROXY')));

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
      '[serve-http] WARNING: --bind 0.0.0.0 is set but PMBRAIN_HTTP_CORS_ORIGIN is unset. OAuth endpoints will reject ALL cross-origin requests until you set the env var (comma-separated origins).',
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
  const ccRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests', error_description: 'Rate limit exceeded. Try again in 15 minutes.' },
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

  // ---------------------------------------------------------------------------
  // MCP SDK Auth Router (OAuth endpoints)
  // ---------------------------------------------------------------------------
  // The issuer URL goes into discovery metadata + token iss claims. It MUST
  // match the URL clients actually hit, or strict OAuth clients reject tokens
  // (RFC 8414 §3.3). Honor --public-url for production deployments behind
  // reverse proxies / tunnels; default to localhost for dev.
  const issuerUrl = new URL(publicUrl || `http://localhost:${port}`);

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
    resourceName: 'PMBrain MCP Server',
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
        return origJson(body);
      };
    }
    next();
  });

  // RFC 9728 path-aware PRMD endpoint. The SDK exposes the root metadata
  // route, while tunnel-client probes the MCP resource-specific variant.
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    res.json(buildMcpProtectedResourceMetadata(issuerUrl));
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

    res.cookie('pmbrain_admin', sessionId, adminCookie(req, 24 * 60 * 60 * 1000));
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
<title>PMBrain</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{max-width:400px;padding:32px;text-align:left}
.logo{font-size:28px;font-weight:600;margin-bottom:24px}
.msg{color:#888;font-size:14px;line-height:1.6;margin-bottom:20px}
.hint{background:rgba(136,170,255,0.08);border:1px solid rgba(136,170,255,0.2);border-radius:8px;padding:14px 16px;font-size:13px;line-height:1.5;color:#888}
.hint b{color:#e0e0e0}
.prompt{background:rgba(0,0,0,0.3);border-radius:6px;padding:8px 12px;margin-top:8px;font-family:monospace;font-size:12px;color:#88aaff}
</style></head><body><div class="box">
<div class="logo">PMBrain</div>
<div class="msg">⚠️ This admin link has expired, was already used, or the server has restarted.</div>
<div class="hint"><b>Get a fresh link from your AI agent, then open the returned URL in your browser:</b>
<div class="prompt">&ldquo;Give me the PMBrain admin login link&rdquo;</div>
</div></div></body></html>`);
      return;
    }

    // Consume the nonce — it's single-use, second click will fail.
    magicLinkNonces.delete(nonce);
    consumedNonces.add(nonce);

    const sessionId = randomBytes(32).toString('hex');
    const sessionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days for magic link
    adminSessions.set(sessionId, sessionExpiresAt);

    res.cookie('pmbrain_admin', sessionId, adminCookie(req, 7 * 24 * 60 * 60 * 1000));
    res.redirect('/admin/');
  });

  // Admin auth middleware
  function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
    const cookies = req.cookies as Record<string, string>;
    const sessionId = cookies?.pmbrain_admin || cookies?.gbrain_admin;
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
          c.grant_types, c.scope, c.created_at, c.token_ttl, c.source_id, c.federated_read,
          CASE WHEN c.deleted_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status,
          (SELECT max(created_at) FROM mcp_request_log WHERE token_name = c.client_id) as last_used_at,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = c.client_id) as total_requests,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = c.client_id AND created_at > now() - interval '24 hours') as requests_today
        FROM oauth_clients c ORDER BY c.created_at DESC
      `;
      const legacyKeys = await sql`
        SELECT a.id, a.name, 'api_key' as auth_type,
          '{"bearer"}' as grant_types, a.permissions, a.created_at, null as token_ttl,
          CASE WHEN a.revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status,
          a.last_used_at,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = a.name) as total_requests,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = a.name AND created_at > now() - interval '24 hours') as requests_today
        FROM access_tokens a ORDER BY a.created_at DESC
      `;
      const scopedLegacyKeys = legacyKeys.map(({ permissions, ...key }) => ({
        ...key,
        scope: legacyAccessTokenScopes(permissions).join(' '),
        source_id: legacyAccessTokenSourceScope(permissions).sourceId,
        federated_read: legacyAccessTokenSourceScope(permissions).federatedRead,
      }));
      res.json([...oauthClients, ...scopedLegacyKeys]);
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

  app.get('/admin/api/brain/overview', requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(await getAdminBrainOverview(engine, config, VERSION));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'overview_failed' });
    }
  });

  app.post('/admin/api/sources/default', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : '';
    if (!sourceId) {
      res.status(400).json({ error: 'source_id_required' });
      return;
    }
    try {
      const rows = await engine.executeRaw<{ id: string; archived: boolean }>(
        `SELECT id, archived FROM sources WHERE id = $1 LIMIT 1`,
        [sourceId],
      );
      const source = rows[0];
      if (!source) {
        res.status(404).json({ error: 'source_not_found' });
        return;
      }
      if (source.archived) {
        res.status(400).json({ error: 'archived_source_cannot_be_main' });
        return;
      }
      await engine.setConfig('sources.default', sourceId);
      res.json({ sourceId });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'set_default_source_failed' });
    }
  });

  app.get('/admin/api/dream/overview', requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(await getAdminDreamOverview(engine, config, VERSION));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'dream_overview_failed' });
    }
  });

  app.post('/admin/api/dream/locks/:id/break', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const holderPid = Number(req.body?.holderPid);
    if (!id || !Number.isFinite(holderPid) || holderPid <= 0) {
      res.status(400).json({ error: 'lock_id_and_holder_pid_required' });
      return;
    }
    try {
      res.json(await deleteLockRow(engine, id, holderPid));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'break_lock_failed' });
    }
  });

  app.post('/admin/api/jobs/:id/cancel', requireAdmin, async (req: Request, res: Response) => {
    const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'job_id_required' });
      return;
    }
    try {
      const queue = new MinionQueue(engine);
      await queue.ensureSchema();
      const job = await queue.cancelJob(id);
      if (!job) {
        res.status(409).json({ error: 'job_not_cancellable' });
        return;
      }
      res.json({ cancelled: true, job });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'job_cancel_failed' });
    }
  });

  app.post('/admin/api/jobs/supervisor/start', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { spawn } = await import('child_process');
      const { mkdirSync, readFileSync, writeFileSync } = await import('fs');
      const { dirname } = await import('path');
      const pidFile = await adminWorkerPidFile();
      try {
        const existingPid = parseInt(readFileSync(pidFile, 'utf8').trim().split('\n')[0] ?? '', 10);
        if (isPidAlive(existingPid)) {
          res.json({ event: 'already_running', worker_pid: existingPid, pid_file: pidFile, mode: 'direct-worker' });
          return;
        }
      } catch {
        // no usable direct worker pid file
      }
      const command = [...resolveCliEntry(), 'jobs', 'work', '--concurrency', '2'];
      const child = spawn(command[0], command.slice(1), {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
      mkdirSync(dirname(pidFile), { recursive: true });
      writeFileSync(pidFile, `${child.pid ?? 0}\n`, 'utf8');
      res.json({ event: 'started', worker_pid: child.pid, pid_file: pidFile, mode: 'direct-worker' });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'supervisor_start_failed' });
    }
  });

  app.post('/admin/api/jobs/supervisor/stop', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { existsSync, readFileSync, unlinkSync } = await import('fs');
      const { spawn } = await import('child_process');
      const pidFile = await adminWorkerPidFile();
      if (!existsSync(pidFile)) {
        res.json({ stopped: false, reason: 'pid_file_missing', pid_file: pidFile });
        return;
      }
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim().split('\n')[0] ?? '', 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        unlinkSync(pidFile);
        res.json({ stopped: false, reason: 'pid_file_corrupt', pid_file: pidFile });
        return;
      }
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        await new Promise(resolve => killer.on('close', resolve));
      } else {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      try { unlinkSync(pidFile); } catch { /* best-effort */ }
      res.json({ stopped: true, worker_pid: pid, mode: 'direct-worker' });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'supervisor_stop_failed' });
    }
  });

  app.get('/admin/api/docs', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const readme = await loadAdminReadmeMarkdown();
      res.json({
        readme_source: readme.source,
        readme_path: readme.path ?? null,
        articles: [
          {
            id: 'readme',
            title: 'README.md',
            category: '使用文档',
            markdown: readme.markdown,
          },
          {
            id: 'faq',
            title: '常见问题',
            category: '常见问题',
            markdown: ADMIN_DOCS_EMPTY_MARKDOWN,
          },
        ],
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'docs_failed' });
    }
  });

  app.get('/admin/api/brain/pages', requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await listAdminBrainPages(engine, {
        source: req.query.source as string | undefined,
        type: req.query.type as string | undefined,
        q: req.query.q as string | undefined,
        embedded: req.query.embedded as string | undefined,
        page: req.query.page as string | undefined,
        limit: req.query.limit as string | undefined,
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'pages_failed' });
    }
  });

  app.get('/admin/api/brain/pages/:sourceId/:slug/chunks', requireAdmin, async (req: Request, res: Response) => {
    try {
      const sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] : req.params.sourceId;
      const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
      if (!sourceId || !slug) {
        res.status(400).json({ error: 'missing_page_identity' });
        return;
      }
      res.json(await getAdminBrainPageChunks(engine, sourceId, slug));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'chunks_failed' });
    }
  });

  app.get('/admin/api/llm/status', requireAdmin, (_req: Request, res: Response) => {
    res.json(getAdminLlmStatus(config));
  });

  app.post('/admin/api/intent/preview', requireAdmin, express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      const preview = await previewIntent(text, config);
      res.json(preview);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'intent_preview_failed' });
    }
  });

  app.post('/admin/api/intent/execute', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const previewId = typeof req.body?.previewId === 'string' ? req.body.previewId : '';
      const confirmed = req.body?.confirmed === true;
      const run = await executePreview(engine, previewId, confirmed, process.cwd(), runHooks);
      res.json({ runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'intent_execute_failed' });
    }
  });

  app.get('/admin/api/runs', requireAdmin, (_req: Request, res: Response) => {
    res.json({ rows: listRuns() });
  });

  app.get('/admin/api/runs/:id', requireAdmin, (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = id ? getRun(id) : null;
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    res.json(run);
  });

  app.post('/admin/api/runs/:id/cancel', requireAdmin, async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = id ? await cancelRun(id) : null;
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    res.json(run);
  });

  app.post('/admin/api/runs/action', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const action = req.body?.action;
      if (!['doctor_check', 'show_sources', 'show_stats', 'embed_stale', 'sync_all'].includes(action)) {
        res.status(400).json({ error: 'unsupported_action' });
        return;
      }
      const run = await startActionRun(action, process.cwd(), runHooks);
      res.json({ runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'action_run_failed' });
    }
  });

  app.post('/admin/api/import-runs', requireAdmin, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const run = await startImportRun(engine, {
        path: typeof req.body?.path === 'string' ? req.body.path : '',
        sourceId: typeof req.body?.sourceId === 'string' ? req.body.sourceId : undefined,
        includeOffice: req.body?.includeOffice === true,
        includeImages: req.body?.includeImages === true,
        noEmbed: req.body?.autoEmbed === false,
        workers: Number(req.body?.workers ?? 1),
      }, process.cwd(), runHooks);
      res.json({ runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'import_run_failed' });
    }
  });

  app.post('/admin/api/dream-runs', requireAdmin, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const rawMaxPages = req.body?.maxPages;
      const maxPages = rawMaxPages === undefined || rawMaxPages === null || rawMaxPages === ''
        ? undefined
        : Number(rawMaxPages);
      const run = await startDreamRun({
        phase: typeof req.body?.phase === 'string' ? req.body.phase : undefined,
        preset: ['full', 'meeting', 'quick'].includes(req.body?.preset) ? req.body.preset : undefined,
        sourceId: typeof req.body?.sourceId === 'string' ? req.body.sourceId : undefined,
        maxPages,
        dryRun: req.body?.dryRun === true,
        input: typeof req.body?.input === 'string' ? req.body.input : undefined,
        date: typeof req.body?.date === 'string' ? req.body.date : undefined,
        from: typeof req.body?.from === 'string' ? req.body.from : undefined,
        to: typeof req.body?.to === 'string' ? req.body.to : undefined,
        timeoutMs: typeof req.body?.timeoutMs === 'number' ? req.body.timeoutMs : undefined,
      }, process.cwd(), runHooks);
      res.json({ runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'dream_run_failed' });
    }
  });

  app.post('/admin/api/sources', requireAdmin, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const run = await startSourceAddRun({
        id: typeof req.body?.id === 'string' ? req.body.id : '',
        path: typeof req.body?.path === 'string' ? req.body.path : '',
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
        federated: req.body?.federated !== false,
      }, process.cwd(), runHooks);
      res.json({ runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'source_add_failed' });
    }
  });

  app.post('/admin/api/sources/:id/archive', requireAdmin, async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      res.status(400).json({ error: 'source_id_required' });
      return;
    }
    if (id === 'default') {
      res.status(400).json({ error: 'default_source_cannot_be_archived' });
      return;
    }
    try {
      const impact = await assessDestructiveImpact(engine, id);
      if (!impact) {
        res.status(404).json({ error: 'source_not_found' });
        return;
      }
      const archived = await softDeleteSource(engine, id);
      if (!archived) {
        res.status(409).json({ error: 'source_already_archived_or_missing' });
        return;
      }
      res.json({ archived, impact });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'source_archive_failed' });
    }
  });

  app.post('/admin/api/sources/:id/restore', requireAdmin, async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      res.status(400).json({ error: 'source_id_required' });
      return;
    }
    try {
      const restored = await restoreSource(engine, id);
      if (!restored) {
        res.status(404).json({ error: 'source_not_found_or_not_archived' });
        return;
      }
      res.json({ id, restored: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'source_restore_failed' });
    }
  });

  app.get('/admin/api/import-runs/:id', requireAdmin, (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = id ? getRun(id) : null;
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    res.json(run);
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
      const holder = (req.query.holder as string) || 'garry';
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
        id: number;
        page_slug: string;
        row_num: number;
        claim: string;
        weight: number;
        resolved_quality: string | null;
        since_date: string | null;
      }>(
        `SELECT id, page_slug, row_num, claim, weight, resolved_quality, since_date
           FROM takes
           WHERE holder = $1 AND active = true AND resolved_at IS NOT NULL
           ORDER BY weight DESC, since_date DESC
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
      const holder = (req.query.holder as string) || 'garry';
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
      const holder = (req.query.holder as string) || 'garry';
      const type = req.params.type;
      const profile = await getLatestProfile(engine, { holder });

      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=60');

      if (type === 'brier-trend') {
        // v0.36.1.0 ship state: 1-point series from the active profile. A
        // proper 90-day time series will read from calibration_profiles
        // generated_at history in v0.37 once we have multiple snapshots.
        const series = profile?.brier !== null && profile?.brier !== undefined
          ? [{ date: profile.generated_at.slice(0, 10), brier: profile.brier }]
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
          `SELECT id, page_slug, claim, weight, since_date
             FROM takes
             WHERE active = true AND resolved_at IS NULL AND superseded_by IS NULL
               AND weight >= 0.7
               AND since_date::date < (now() - INTERVAL '12 months')
             ORDER BY since_date ASC
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

  app.get('/admin/api/take-proposals', requireAdmin, async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const proposals = await listAdminTakeProposals(engine, {
        status: typeof req.query.status === 'string' ? req.query.status : 'pending',
        limit,
      });
      res.json({ proposals });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
    }
  });

  app.post('/admin/api/take-proposals/:id/accept', requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'invalid proposal id' });
        return;
      }
      const proposal = await acceptAdminTakeProposal(engine, id, 'admin');
      res.json({ proposal });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'unknown' });
    }
  });

  app.post('/admin/api/take-proposals/:id/reject', requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'invalid proposal id' });
        return;
      }
      const proposal = await rejectAdminTakeProposal(engine, id, 'admin');
      res.json({ proposal });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'unknown' });
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
      const { name, scopes: rawScopes } = req.body;
      if (!name) { res.status(400).json({ error: 'Name required' }); return; }
      const scopeString = rawScopes == null
        ? 'admin read write'
        : normalizeScopesInput(rawScopes);
      const scopes = scopeString.split(' ');
      const sourceScope = await normalizeAdminAgentSourceScope(engine, req.body?.sourceId, req.body?.federatedRead);
      const { generateToken, hashToken } = await import('../core/utils.ts');
      const token = generateToken('pmbrain_');
      const hash = hashToken(token);
      const id = (await import('crypto')).randomUUID();
      await executeRawJsonb(
        engine,
        `INSERT INTO access_tokens (id, name, token_hash, permissions)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [id, name, hash],
        [{
          takes_holders: ['world'],
          scopes,
          source_id: sourceScope.sourceId,
          federated_read: sourceScope.federatedRead,
        }],
      );
      res.json({ name, token, id, scopes, sourceId: sourceScope.sourceId, federatedRead: sourceScope.federatedRead });
    } catch (e) {
      res.status((e as Error & { status?: number }).status ?? 500).json({ error: e instanceof Error ? e.message : 'Failed to create API key' });
    }
  });

  app.post('/admin/api/agents/source-scope', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
      const authType = req.body?.authType === 'oauth' || req.body?.authType === 'api_key' ? req.body.authType : '';
      if (!id) { res.status(400).json({ error: 'id_required' }); return; }
      if (!authType) { res.status(400).json({ error: 'auth_type_required' }); return; }
      const sourceScope = await normalizeAdminAgentSourceScope(engine, req.body?.sourceId, req.body?.federatedRead);
      if (authType === 'oauth') {
        const result = await sql`
          UPDATE oauth_clients
          SET source_id = ${sourceScope.sourceId}, federated_read = ${pgTextArray(sourceScope.federatedRead)}
          WHERE client_id = ${id} AND deleted_at IS NULL
          RETURNING client_id
        `;
        if (result.length === 0) { res.status(404).json({ error: 'agent_not_found' }); return; }
      } else {
        const rows = await sql`
          SELECT permissions FROM access_tokens
          WHERE id = ${id} AND revoked_at IS NULL
          LIMIT 1
        `;
        if (rows.length === 0) { res.status(404).json({ error: 'agent_not_found' }); return; }
        const current = rows[0].permissions && typeof rows[0].permissions === 'object'
          ? rows[0].permissions as Record<string, unknown>
          : {};
        await executeRawJsonb(
          engine,
          `UPDATE access_tokens SET permissions = $2::jsonb WHERE id = $1 AND revoked_at IS NULL`,
          [id],
          [{ ...current, source_id: sourceScope.sourceId, federated_read: sourceScope.federatedRead }],
        );
      }
      res.json({ updated: true, sourceId: sourceScope.sourceId, federatedRead: sourceScope.federatedRead });
    } catch (e) {
      res.status((e as Error & { status?: number }).status ?? 500).json({ error: e instanceof Error ? e.message : 'update_agent_source_scope_failed' });
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

  const readTunnelHealth = async () => {
    const probe = async (path: '/healthz' | '/readyz') => {
      try {
        const response = await fetch(`http://127.0.0.1:8080${path}`, {
          signal: AbortSignal.timeout(1500),
        });
        return { ok: response.ok, status: response.status };
      } catch {
        return { ok: false, status: null };
      }
    };
    const [health, ready] = await Promise.all([probe('/healthz'), probe('/readyz')]);
    return { health, ready };
  };

  const requireLocalAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: 'local_admin_required' });
      return;
    }
    next();
  };

  app.get('/admin/api/chatgpt-tunnel/status', requireAdmin, requireLocalAdmin, async (req: Request, res: Response) => {
    try {
      const binaryPath = typeof req.query.binaryPath === 'string'
        ? req.query.binaryPath
        : defaultTunnelClientBinary();
      const status = getChatGptTunnelStatus(binaryPath);
      res.json({ ...status, ...(await readTunnelHealth()), localMcpUrl: `http://127.0.0.1:${port}/mcp` });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to read tunnel status' });
    }
  });

  app.post('/admin/api/chatgpt-tunnel/setup', requireAdmin, requireLocalAdmin, express.json(), async (req: Request, res: Response) => {
    const tunnelId = typeof req.body?.tunnelId === 'string' ? req.body.tunnelId.trim() : '';
    const runtimeApiKey = typeof req.body?.runtimeApiKey === 'string' ? req.body.runtimeApiKey.trim() : '';
    const binaryPath = typeof req.body?.binaryPath === 'string' && req.body.binaryPath.trim()
      ? req.body.binaryPath.trim()
      : defaultTunnelClientBinary();
    if (!/^tunnel_[A-Za-z0-9_-]+$/.test(tunnelId)) {
      res.status(400).json({ error: 'A valid OpenAI tunnel_id is required' });
      return;
    }
    const status = getChatGptTunnelStatus(binaryPath);
    if (!status.binaryFound) {
      res.status(400).json({ error: `tunnel-client was not found at ${binaryPath}` });
      return;
    }
    const paths = chatGptTunnelPaths();
    if (!runtimeApiKey && !status.runtimeKeyConfigured) {
      res.status(400).json({ error: 'OpenAI Runtime API Key is required for first-time setup' });
      return;
    }

    const { generateToken, hashToken } = await import('../core/utils.ts');
    const token = generateToken('pmbrain_');
    const hash = hashToken(token);
    const id = (await import('crypto')).randomUUID();
    let inserted = false;
    try {
      if (runtimeApiKey) writePrivateFile(paths.runtimeKeyFile, runtimeApiKey);
      writePrivateFile(paths.authorizationHeaderFile, `Bearer ${token}`);
      await sql`UPDATE access_tokens SET revoked_at = now() WHERE name = ${CHATGPT_TUNNEL_TOKEN_NAME} AND revoked_at IS NULL`;
      await executeRawJsonb(
        engine,
        `INSERT INTO access_tokens (id, name, token_hash, permissions)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [id, CHATGPT_TUNNEL_TOKEN_NAME, hash],
        [{ takes_holders: ['world'], scopes: ['read'] }],
      );
      inserted = true;
      const profile = buildChatGptTunnelProfile({
        tunnelId,
        mcpUrl: `http://127.0.0.1:${port}/mcp`,
        runtimeKeyFile: paths.runtimeKeyFile,
        authorizationHeaderFile: paths.authorizationHeaderFile,
        httpProxy: detectTunnelHttpProxy(),
      });
      writeChatGptTunnelProfile(paths.profileFile, profile);
      res.json({
        configured: true,
        profileFile: paths.profileFile,
        tunnelId,
        localMcpUrl: `http://127.0.0.1:${port}/mcp`,
        scopes: ['read'],
        allowedTools: [...CHATGPT_TUNNEL_READ_ONLY_TOOLS],
      });
    } catch (e) {
      if (inserted) {
        try { await sql`UPDATE access_tokens SET revoked_at = now() WHERE token_hash = ${hash}`; } catch { /* best effort */ }
      }
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to configure tunnel' });
    }
  });

  app.post('/admin/api/chatgpt-tunnel/doctor', requireAdmin, requireLocalAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const binaryPath = typeof req.body?.binaryPath === 'string' && req.body.binaryPath.trim()
        ? req.body.binaryPath.trim()
        : defaultTunnelClientBinary();
      res.json(await runTunnelDoctor(binaryPath));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Tunnel doctor failed' });
    }
  });

  app.post('/admin/api/chatgpt-tunnel/start', requireAdmin, requireLocalAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const binaryPath = typeof req.body?.binaryPath === 'string' && req.body.binaryPath.trim()
        ? req.body.binaryPath.trim()
        : defaultTunnelClientBinary();
      const doctor = await runTunnelDoctor(binaryPath);
      if (!doctor.ok) {
        res.status(409).json({ error: 'Tunnel doctor must pass before start', doctor });
        return;
      }
      const pid = startTunnelClient(binaryPath);
      await new Promise(resolve => setTimeout(resolve, 750));
      res.json({ started: true, pid, ...(await readTunnelHealth()) });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to start tunnel-client' });
    }
  });

  app.post('/admin/api/chatgpt-tunnel/stop', requireAdmin, requireLocalAdmin, (_req: Request, res: Response) => {
    try {
      res.json({ stopped: stopTunnelClient() });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to stop tunnel-client' });
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
      const sourceScope = await normalizeAdminAgentSourceScope(engine, req.body?.sourceId, req.body?.federatedRead);
      const result = await oauthProvider.registerClientManual(
        name, grants, scopeString, uris, sourceScope.sourceId, sourceScope.federatedRead, validatedAuthMethod,
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
  app.get('/admin', (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/admin') {
      res.redirect('/admin/');
      return;
    }
    next();
  });
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

  app.post('/mcp', requireBearerAuth({ verifier: oauthProvider }), async (req: Request, res: Response) => {
    const startTime = Date.now();
    const authInfo = (req as any).auth as AuthInfo;

    // Human-readable agent name is now threaded through AuthInfo by
    // verifyAccessToken (which JOINs oauth_clients in its existing token
    // SELECT). No per-request DB roundtrip needed. Falls back to clientId
    // for legacy tokens or when the JOIN row's client_name is NULL.
    const agentName = authInfo.clientName ?? authInfo.clientId;

    // Create a fresh MCP server per request (stateless)
    const server = new Server(
      { name: 'pmbrain', version: VERSION },
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
        tools: filterMcpOperationsForAuth(mcpOperations, authInfo)
          .map(op => ({
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

      if (isChatGptTunnelClient(authInfo) && !CHATGPT_TUNNEL_READ_ONLY_TOOL_SET.has(name)) {
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
      const { auth: effectiveAuthInfo, sourceId: tokenSourceId } = await authInfoWithMainSource(engine, authInfo);

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
          auth: effectiveAuthInfo,
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
    const fromEnv = envCompat('PMBRAIN_INGEST_MAX_BYTES', 'GBRAIN_INGEST_MAX_BYTES');
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
    requireBearerAuth({ verifier: oauthProvider, requiredScopes: ['write'] }),
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

      // Detect content_type. Caller can override via the X-PMBrain-Content-Type
      // header for the JSON case (since the request's Content-Type would say
      // application/json but the user might intend the body to be markdown).
      const declared = (req.header('x-pmbrain-content-type') || req.header('x-gbrain-content-type') || req.header('content-type') || '').toLowerCase();
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
      const sourceUri = (req.header('x-pmbrain-source-uri') || req.header('x-gbrain-source-uri') || `mcp-webhook:${authInfo.clientId}:${Date.now()}`).slice(0, 1024);
      const sourceId = (req.header('x-pmbrain-source-id') || req.header('x-gbrain-source-id') || `webhook-${authInfo.clientId}`).slice(0, 256);
      const callerSlug = req.header('x-pmbrain-slug') || req.header('x-gbrain-slug');

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
  // D18: submits 'sync' job with auto_embed_backfill=true and priority -10
  //     (above autopilot's 0).
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
        res.status(401).json({ error: 'webhook_not_configured', message: 'Run: pmbrain sources webhook set ' + source.id });
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

  const httpServer = await listenHttpServer(app, port, bind, () => {
    console.error(`
╔══════════════════════════════════════════════════════╗
║  PMBrain MCP Server v${VERSION.padEnd(36)}║
╠══════════════════════════════════════════════════════╣
║  Port:      ${String(port).padEnd(40)}║
║  Bind:      ${bind.padEnd(40)}║
║  Engine:    ${(config.engine || 'pglite').padEnd(40)}║
║  Issuer:    ${issuerUrl.origin.padEnd(40)}║
║  Clients:   ${String((clientCount[0] as any).count).padEnd(40)}║
║  DCR:       ${(enableDcr ? 'enabled' : 'disabled').padEnd(40)}║
║  Token TTL: ${(tokenTtl + 's').padEnd(40)}║
╠══════════════════════════════════════════════════════╣
║  Admin:     http://localhost:${port}/admin${' '.repeat(Math.max(0, 19 - String(port).length))}║
║  MCP:       http://localhost:${port}/mcp${' '.repeat(Math.max(0, 21 - String(port).length))}║
║  Health:    http://localhost:${port}/health${' '.repeat(Math.max(0, 18 - String(port).length))}║
╠══════════════════════════════════════════════════════╣
${renderAdminTokenFooter({ suppressBootstrapPrint, bootstrapFromEnv, bootstrapToken })}
`);

    // Auto-sync tunnel profile so it always matches the actual port
    try {
      const tunnelPaths = chatGptTunnelPaths();
      if (existsSync(tunnelPaths.profileFile)) {
        const existing = readFileSync(tunnelPaths.profileFile, 'utf8');
        // Import parseTunnelId locally since it's not exported from chatgpt-tunnel
        const tunnelId = existing.match(/^\s*tunnel_id:\s*["']?(tunnel_[A-Za-z0-9_-]+)["']?\s*$/m)?.[1];
        if (tunnelId) {
          writeChatGptTunnelProfile(
            tunnelPaths.profileFile,
            buildChatGptTunnelProfile({
              tunnelId,
              mcpUrl: `http://127.0.0.1:${port}/mcp`,
              runtimeKeyFile: tunnelPaths.runtimeKeyFile,
              authorizationHeaderFile: tunnelPaths.authorizationHeaderFile,
              httpProxy: detectTunnelHttpProxy(),
            }),
          );
        }
      }
    } catch (e) {
      // non-blocking, swallow error
    }
  });

  await waitForHttpServerClose(httpServer, engine);
}
