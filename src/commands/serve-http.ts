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
 *
 * buildServeHttpApp builds the shared ServeHttpContext and mounts the
 * serve-http-<area>.ts modules in registration order; runServeHttp listens.
 * This file stays the import surface: every symbol the modules took with them
 * is re-exported below.
 */

import express from 'express';
import type { Socket } from 'net';
import type { Request, RequestHandler, CookieOptions } from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { randomBytes, createHash } from 'crypto';
import { createMetricsCounters, metricsTrackingMiddleware, mountHealth, mountMetrics, type MetricsCounters } from './serve-http-metrics.ts';
import { ADMIN_TOKEN_SHAPE } from '../core/serve-service.ts';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { createAdminLimiters } from './serve-http-admin-limits.ts';
import { mountOAuth, mountOAuthConsent, mountOwnerLoginLinks } from './serve-http-oauth.ts';
import { createRequireAdmin, mountAdminApi, mountAdminLogin } from './serve-http-admin-api.ts';
import { mountSpa } from './serve-http-spa.ts';
import { mountMcp } from './serve-http-mcp.ts';
import { createWebhookLimiters, mountWebhooks } from './serve-http-webhooks.ts';
import type { BrainEngine } from '../core/engine.ts';
import { operations, type Operation } from '../core/operations.ts';
import {
  GBrainOAuthProvider,
  DEFAULT_DCR_TTL_MIN_SECONDS,
} from '../core/oauth-provider.ts';
import { canonicalOAuthResource } from '../core/oauth-grants.ts';
import type { McpSurface } from '../mcp/surface.ts';
import { bindResolveIpcForServe } from '../mcp/resolve-ipc-binding.ts';
import { createPersistenceIpcProvider, residentPersistenceConfig } from '../core/persistence/provider.ts';
import { resolveMcpStdioSourceScope } from '../mcp/server.ts';
import { loadConfig, type GBrainConfig } from '../core/config.ts';
import { buildError } from '../core/errors.ts';
import * as db from '../core/db.ts';
import { sqlQueryForEngine, type SqlQuery } from '../core/sql-query.ts';
import { isUndefinedColumnError } from '../core/utils.ts';
import { registerCleanup } from '../core/process-cleanup.ts';
import { VERSION } from '../version.ts';

export { extractGitHubItemRef, githubKindCoversRepo, selectGitHubItemSources } from './serve-http-webhooks.ts';
export { HEALTH_TIMEOUT_MS, probeHealth, probeLiveness, type ProbeHealthResult } from './serve-http-metrics.ts';
export { openAdminSseStream, queryAgentClientSpend, type AgentClientSpend } from './serve-http-admin-api.ts';
export { parseCorsAllowlistOAuth, resolveCorsOrigin, mountOAuthCorsGate } from './serve-http-oauth.ts';

/**
 * The narrowest contract this module actually consumes: subscribe, unsubscribe.
 * Every return value is discarded, so it is `unknown` rather than `this` — a
 * `Pick<>` of the full Node types would demand a fidelity no caller needs and
 * no test double can honestly provide.
 */
type EventSubscriber = {
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
};
/**
 * Only what socket teardown needs. This one IS a `Pick` of the real type, on
 * purpose: no typechecked test double has to satisfy it (fakes reach it through
 * `emit`, which is untyped), so binding it to `net.Socket` costs nothing and
 * buys drift detection. A hand-written structural shape here would be an
 * unchecked assertion — method parameters are bivariant, so annotating the
 * listener param would match our own declaration whatever a real socket does.
 */
type TrackedSocket = Pick<Socket, 'destroy' | 'once'>;
type HttpServerLifecycle = EventSubscriber & {
  readonly listening: boolean;
  close(callback?: (error?: Error) => void): unknown;
  // Narrowed to the one event this module subscribes with `on`, so the listener
  // parameter is genuinely checked against TrackedSocket. A `(...args: any[])`
  // signature here would make the annotation at the call site an unchecked
  // assertion — the same defect this file was just cleaned of.
  on(event: 'connection', listener: (socket: TrackedSocket) => void): unknown;
};
type SignalSource = EventSubscriber;
type CleanupRegistrar = typeof registerCleanup;
/** How long `server.close()` may hold shutdown before the lifecycle gives up on it. */
const CLOSE_TIMEOUT_MS = 5_000;

/** Live-connection bookkeeping for `waitForHttpServerLifecycle`'s teardown. */
export interface SocketTracker {
  /** Sockets currently tracked (live or not yet observed as gone). */
  size(): number;
  /** Sever every tracked connection so `server.close()` cannot block on them. */
  destroyAll(): void;
}

/**
 * Track accepted connections so shutdown can sever them.
 *
 * `close()` stops the listener and then waits for every open connection to
 * drain. One attached admin-SSE EventSource — or any keep-alive socket —
 * holds it open forever, so shutdown has to sever them itself. Bun 1.3.x
 * ships `closeAllConnections()`/`closeIdleConnections()` as no-op stubs, so
 * tracking is the only portable teardown.
 */
export function trackServerSockets(server: Pick<HttpServerLifecycle, 'on'>): SocketTracker {
  // Hold sockets WEAKLY. Bun's node:http never emits 'close' (nor 'end'/'error')
  // on server-side sockets and keeps reporting them open after the peer is
  // gone, so no event or state flag can evict a dead connection — a strong Set
  // grew by one socket per request forever (each health probe is a fresh TCP
  // connection). A dead socket does become unreachable once the runtime drops
  // it, so a WeakRef lets it go; a live one stays reachable from the server
  // and keeps being tracked. Node does emit 'close' — honor it so the
  // bookkeeping stays exact there, and prune collected refs as we go so the
  // ref set itself stays bounded by live connections.
  const refs = new Set<WeakRef<TrackedSocket>>();
  const live = (): TrackedSocket[] => {
    const out: TrackedSocket[] = [];
    for (const ref of refs) {
      const socket = ref.deref();
      if (socket === undefined) refs.delete(ref);
      else out.push(socket);
    }
    return out;
  };
  server.on('connection', (socket: TrackedSocket) => {
    live();
    const ref = new WeakRef(socket);
    refs.add(ref);
    socket.once('close', () => refs.delete(ref));
  });
  return {
    size: () => live().length,
    destroyAll: () => { for (const socket of live()) socket.destroy(); },
  };
}

/**
 * Keep the HTTP server strongly referenced and make the daemon lifetime
 * explicit instead of relying on runtime-specific event-loop behavior for an
 * unobserved `app.listen()` return value. The shared abnormal-termination
 * cleanup pass closes it before process exit.
 */
export function waitForHttpServerLifecycle(
  server: HttpServerLifecycle,
  options: {
    signals?: SignalSource;
    register?: CleanupRegistrar;
    /** Upper bound on how long `close()` may keep shutdown waiting. */
    closeTimeoutMs?: number;
    log?: (msg: string) => void;
  } = {},
): Promise<void> {
  const signals = options.signals ?? process;
  const register = options.register ?? registerCleanup;
  const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  const log = options.log ?? ((msg: string) => console.error(msg));

  const sockets = trackServerSockets(server);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let closePromise: Promise<void> | null = null;

    const closeServer = (): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = new Promise<void>((closeResolve, closeReject) => {
        if (!server.listening) {
          closeResolve();
          return;
        }
        // Backstop for what the tracker cannot reach: sockets are held weakly,
        // so an idle keep-alive wrapper the runtime already collected leaves a
        // native handle that close() still waits on. Bound the wait instead
        // of hanging the daemon; process exit releases the handle.
        // The process still exits: the serve lane's own finishHttpServe
        // (serve.ts) disconnects the engine and calls process.exit once the
        // lifecycle resolves, so a leaked handle cannot outlive teardown.
        let timedOut = false;
        const deadline = setTimeout(() => {
          timedOut = true;
          log(`GBrain HTTP server: close() still waiting after ${closeTimeoutMs}ms — shutting down anyway`);
          closeResolve();
        }, closeTimeoutMs);
        deadline.unref?.();
        server.close((error?: Error) => {
          clearTimeout(deadline);
          if (timedOut) {
            // Settled already — a late failure must be seen, not swallowed.
            if (error) log(`GBrain HTTP server: close() failed after the deadline: ${error.message}`);
            return;
          }
          if (error) closeReject(error);
          else closeResolve();
        });
        // After close() so the listener stops accepting first, then in-flight
        // connections are severed rather than waited on.
        sockets.destroyAll();
      });
      return closePromise;
    };

    const deregister = register('http-server', closeServer);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      server.off('close', onClose);
      server.off('error', onError);
      signals.off('SIGINT', onSigint);
      deregister();
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish();
    const onError = (error: Error) => finish(error);
    const onSigint = () => {
      // A close() that reports done — or that the deadline gave up on — ends
      // the lifecycle even when the server never emits 'close'.
      void closeServer().then(() => finish(), onError);
    };

    server.once('close', onClose);
    server.once('error', onError);
    signals.once('SIGINT', onSigint);
  });
}

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
  if (!ADMIN_TOKEN_SHAPE.test(trimmed)) {
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
   * MEMORY_VERBS v1 + WP4: tool-surface mode. 'verbs' = exactly the seven
   * protocol verbs; 'starter' = the STARTER_OPS daily-driver set; 'full'
   * (default) = every non-localOnly operation. Enforced on the tool list AND
   * in dispatch (fail-closed). WP4/D2: this is the server CEILING — each
   * request resolves min(ceiling, client row surface ?? config default),
   * so per-client rows can narrow below it but never widen past it.
   */
  surface?: McpSurface;
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

/**
 * Per-server state shared by every `mount<Area>(app, ctx)` module. Built once
 * by buildServeHttpApp; modules destructure what they use and never construct
 * their own limiter, session map, nonce store or event fan-out (a second
 * instance would silently split a rate limit or a session).
 */
export interface ServeHttpContext {
  engine: BrainEngine;
  config: GBrainConfig | (Partial<GBrainConfig> & { engine: 'pglite' });
  sql: SqlQuery;
  bind: string;
  enableDcr: boolean;
  logFullParams: boolean | undefined;
  /** --surface: the server tool-surface ceiling. */
  surface: McpSurface | undefined;
  /** Every non-localOnly operation: the only op list the network surface sees. */
  mcpOperationsBase: Operation[];
  issuerUrl: URL;
  mcpResourceUrl: URL;
  resourceMetadataUrl: string;
  oauthProvider: GBrainOAuthProvider;
  /** Access-token verifier that also rejects tokens bound to a different resource. */
  resourceVerifier: OAuthTokenVerifier;
  bootstrapHash: string;
  /** Admin cookie sessions: sessionId -> expiresAt. */
  adminSessions: Map<string, number>;
  adminCookie: (req: Request, maxAge: number) => CookieOptions;
  /** Magic-link nonces: nonce -> expiresAt. */
  magicLinkNonces: Map<string, number>;
  consumedNonces: Set<string>;
  requireAdmin: RequestHandler;
  adminLimits: ReturnType<typeof createAdminLimiters>;
  ccRateLimiter: RequestHandler;
  ingestRateLimiter: RequestHandler;
  githubWebhookLimiter: RequestHandler;
  metricsCounters: MetricsCounters;
  sseClients: Set<express.Response>;
  broadcastEvent: (event: Record<string, unknown>) => void;
}

/**
 * Startup stderr notices, in order: --log-full-params, --public-url without
 * --bind, embedding width, skill publishing, brain-resident skillpacks.
 * Returns the banner's skill-publishing status.
 */
async function logServeHttpStartup(engine: BrainEngine, options: ServeHttpOptions, config: ServeHttpContext['config']) {
  const { publicUrl, logFullParams } = options;
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
  return skillStatus;
}

async function resolveDcrTtlWindow(engine: BrainEngine, tokenTtl: number): Promise<{ dcrTtlMinSeconds: number; dcrTtlMaxSeconds: number }> {
  const parseDcrTtlBound = (raw: unknown, fallback: number): number => {
    const n = Number(raw);
    return raw != null && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
  };
  let dcrTtlMinSeconds = DEFAULT_DCR_TTL_MIN_SECONDS;
  let dcrTtlMaxSeconds = Math.max(tokenTtl, dcrTtlMinSeconds);
  try {
    dcrTtlMinSeconds = parseDcrTtlBound(await engine.getConfig('oauth.dcr_ttl_min_seconds'), DEFAULT_DCR_TTL_MIN_SECONDS);
    dcrTtlMaxSeconds = parseDcrTtlBound(await engine.getConfig('oauth.dcr_ttl_max_seconds'), Math.max(tokenTtl, dcrTtlMinSeconds));
  } catch {
    // Config read is best-effort; the fail-closed defaults stand.
    dcrTtlMaxSeconds = Math.max(tokenTtl, dcrTtlMinSeconds);
  }
  if (dcrTtlMinSeconds > dcrTtlMaxSeconds) {
    console.error(
      `[serve-http] WARNING: oauth.dcr_ttl_min_seconds (${dcrTtlMinSeconds}) exceeds ` +
      `oauth.dcr_ttl_max_seconds (${dcrTtlMaxSeconds}); collapsing the window to ` +
      `the min bound (${dcrTtlMinSeconds}).`,
    );
    dcrTtlMaxSeconds = dcrTtlMinSeconds;
  }
  return { dcrTtlMinSeconds, dcrTtlMaxSeconds };
}

/**
 * Builds the complete Express app for `gbrain serve --http`: startup checks,
 * OAuth provider, admin auth, every route and middleware in registration
 * order. `runServeHttp` is the production caller; it owns listen, the banner,
 * the resolve-IPC binding and shutdown.
 */
export async function buildServeHttpApp(app: express.Express, engine: BrainEngine, options: ServeHttpOptions) {
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

  const skillStatus = await logServeHttpStartup(engine, options, config);

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
  // #2179: admin-configured clamp window for DCR-requested token TTLs.
  // DB-plane config keys (`gbrain config set oauth.dcr_ttl_min_seconds ...`).
  // FAIL-CLOSED defaults: an unset/invalid max is bounded by the operator's
  // own --token-ttl (never a fixed permissive ceiling), and an inverted
  // window collapses to the min bound — the same direction clampDcrTokenTtl
  // itself resolves. A bad config narrows the window; it never widens it.
  const { dcrTtlMinSeconds, dcrTtlMaxSeconds } = await resolveDcrTtlWindow(engine, tokenTtl);

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
  // RFC 9728 / MCP auth spec: the protected-resource metadata describes the
  // resource the client connects to (/mcp), not the authorization-server root.
  // Without resourceServerUrl the SDK falls back to issuerUrl, advertising
  // `resource: "https://host/"` and 404ing the path-based PRM URL
  // (/.well-known/oauth-protected-resource/mcp) that clients derive from the
  // connector URL (#4893). The 401 challenge's resource_metadata URL is
  // derived from the same value so the two can never drift apart.
  const mcpResourceUrl = new URL('/mcp', issuerUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpResourceUrl);
  const oauthProvider = new GBrainOAuthProvider({
    sql,
    transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))),
    tokenTtl,
    dcrDisabled: !enableDcr,
    allowClientCredentialsDcr: enableDcrInsecure === true,
    dcrTtlMinSeconds,
    dcrTtlMaxSeconds,
    resourceUrl: mcpResourceUrl,
  });

  // #1353: loud stderr security WARN when DCR is enabled. DCR is an
  // unauthenticated network registration endpoint; surface the posture change
  // (and the extra blast radius of --enable-dcr-insecure) so it's visible in
  // logs, not buried in the neutral "DCR: enabled" banner line.
  if (enableDcr) {
    console.error(
      'SECURITY WARNING: Dynamic Client Registration (--enable-dcr) is ON. Any network caller ' +
      'can self-register an OAuth client, limited to read/write (read-only for client_credentials ' +
      'under --enable-dcr-insecure); every authorization_code connection needs owner approval in the admin UI. See SECURITY.md.',
    );
    if (enableDcrInsecure) {
      console.error(
        'SECURITY WARNING: --enable-dcr-insecure is ON — self-registered DCR clients may ' +
        'request the client_credentials grant, which BYPASSES owner approval (they are capped ' +
        'at read-only scope). Only use this on a trusted network.',
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
  // Installed before every admin login, nonce and API handler.
  app.use((req, res, next) => {
    if (req.path === '/admin' || req.path.startsWith('/admin/')) {
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    }
    next();
  });

  // #3893 (reimplemented from @y2688): request metrics. Mounted here, BEFORE
  // every route — Express only applies `app.use` middleware to routes
  // registered after it, and the original PR mounted the tracker after most
  // routes, so they were never counted. The /metrics route itself lives
  // below requireAdmin's definition.
  const metricsCounters = createMetricsCounters();
  app.use(metricsTrackingMiddleware(metricsCounters));

  const oauthTokenRateLimit = resolveOAuthTokenRateLimit();
  const ccRateLimiter = rateLimit({
    windowMs: oauthTokenRateLimit.windowMs,
    max: oauthTokenRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests', error_description: 'Rate limit exceeded. Try again later.' },
  });

  const adminLimits = createAdminLimiters();

  // The SDK validates expiry/scopes but leaves audience enforcement to us.
  // Legacy grants without a resource retain their existing compatibility; an
  // origin-bound token minted before #5222 passes the same canonicalizer.
  const resourceVerifier = {
    async verifyAccessToken(token: string) {
      const auth = await oauthProvider.verifyAccessToken(token);
      if (auth.resource) {
        try {
          canonicalOAuthResource(auth.resource, mcpResourceUrl);
        } catch {
          throw new InvalidTokenError('Token is bound to a different resource');
        }
      }
      return auth;
    },
  };

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

  // The HTTP MCP surface never sees localOnly operations; serve-http-mcp.ts
  // narrows this list further per request (surface, grants, scope).
  const mcpOperationsBase = operations.filter(op => !op.localOnly);
  const requireAdmin = createRequireAdmin(adminSessions);
  const { ingestRateLimiter, githubWebhookLimiter } = createWebhookLimiters();
  const ctx: ServeHttpContext = {
    engine, config, sql, bind, enableDcr, logFullParams, surface: options.surface, mcpOperationsBase,
    issuerUrl, mcpResourceUrl, resourceMetadataUrl, oauthProvider, resourceVerifier,
    bootstrapHash, adminSessions, adminCookie,
    magicLinkNonces: new Map<string, number>(),
    consumedNonces: new Set<string>(),
    requireAdmin, adminLimits, ccRateLimiter, ingestRateLimiter, githubWebhookLimiter,
    metricsCounters, sseClients, broadcastEvent,
  };

  mountOAuth(app, ctx);
  mountHealth(app, ctx);
  mountAdminLogin(app, ctx);
  mountOwnerLoginLinks(app, ctx);
  mountOAuthConsent(app, oauthProvider, requireAdmin, adminLimits.consent);
  mountMetrics(app, ctx);
  mountAdminApi(app, ctx);
  await mountSpa(app, ctx);
  mountMcp(app, ctx);
  mountWebhooks(app, ctx);

  return { bind, config, sql, issuerUrl, skillStatus, bootstrapToken, bootstrapFromEnv, suppressBootstrapPrint };
}

export async function runServeHttp(engine: BrainEngine, options: ServeHttpOptions) {
  const { port, tokenTtl, enableDcr, enableDcrInsecure } = options;
  // Express 5 app
  const app = express();
  const { bind, config, sql, issuerUrl, skillStatus, bootstrapToken, bootstrapFromEnv, suppressBootstrapPrint } =
    await buildServeHttpApp(app, engine, options);

  // ---------------------------------------------------------------------------
  // Start server
  // ---------------------------------------------------------------------------
  const clientCount = await sql`SELECT count(*)::int as count FROM oauth_clients`;

  const httpServer = app.listen(port, bind, () => {
    console.error(`
╔══════════════════════════════════════════════════════╗
║  GBrain MCP Server v${VERSION.padEnd(37)}║
╠══════════════════════════════════════════════════════╣
║  Port:      ${String(port).padEnd(40)}║
║  Bind:      ${bind.padEnd(40)}║
║  Engine:    ${(config.engine || 'pglite').padEnd(40)}║
║  Issuer:    ${issuerUrl.origin.padEnd(40)}║
║  Clients:   ${String((clientCount[0] as any).count).padEnd(40)}║
║  DCR:       ${(enableDcr ? (enableDcrInsecure ? 'enabled (INSECURE: read-only M2M)' : 'enabled (consent; DCR max read write)') : 'disabled').padEnd(40)}║
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

  // #4474: bind the resolve-IPC unix socket under --http too. This is the
  // exact posture `gbrain bootstrap harness` targets — without the listener
  // every wired lifecycle hook (SessionStart / UserPromptSubmit / PreCompact)
  // degrades to `no_serve` forever, and on a PGLite brain there is no local
  // recovery (the http serve owns the single-writer lock, so a second stdio
  // serve can't provide the socket). Shares the stdio path's wiring via
  // bindResolveIpcForServe; best-effort — failure to bind never blocks the
  // HTTP server.
  const ipcBinding = await bindResolveIpcForServe(
    engine,
    (await resolveMcpStdioSourceScope(engine)).sourceId,
    await createPersistenceIpcProvider(engine, residentPersistenceConfig(config) ?? config),
  );
  if (ipcBinding.socketPath) {
    console.error(`  Resolve IPC: ${ipcBinding.socketPath}`);
  }

  // SIGTERM/SIGHUP route through process-cleanup's pass and then
  // `process.exit`, which skips cli.ts's finally-teardown — so on those
  // signals the PGLite write handle was never closed. An unclosed PGLite
  // can leave the control file pointing at a checkpoint record whose WAL
  // page never reached disk; every later start then dies with
  // `PANIC: could not locate a valid checkpoint record` (surfaced as the
  // misleading WASM-init hint) and the daemon crash-loops until a human
  // intervenes. Registering the engine here gives abnormal termination
  // the same clean close the SIGINT path already gets via the cli
  // teardown. Deregistered on normal return so the cli finally remains
  // the single owner of orderly shutdown.
  const deregisterIpcCleanup = registerCleanup('resolve-ipc-close', async () => {
    ipcBinding.close();
  });
  const deregisterEngineCleanup = registerCleanup('pglite-engine-disconnect', () =>
    engine.disconnect(),
  );
  try {
    await waitForHttpServerLifecycle(httpServer);
  } finally {
    // Close the IPC listener + reap the socket file on orderly shutdown
    // (abnormal termination goes through the registered cleanup above).
    ipcBinding.close();
    deregisterIpcCleanup();
    deregisterEngineCleanup();
  }
}
