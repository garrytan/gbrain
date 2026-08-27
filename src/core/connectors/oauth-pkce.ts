/**
 * oauth-pkce.ts — dependency-free OAuth 2.0 Authorization-Code + PKCE.
 *
 * Best-effort/forward-compat ChatGPT lane, offered ONLY behind `--try-oauth`
 * (tokens are likely codex-scoped, so the cookie lane is primary). Lives in core
 * (not the command layer) because the handler and tests need it and it is
 * generic across future providers. Uses `Bun.serve` for the one-shot loopback
 * listener and `node:crypto` for S256 — no third-party deps.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OAuthPkceConfig } from './types.ts';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 S256 PKCE pair: a 64-byte verifier and its SHA-256 challenge. */
export function generatePkcePair(): PkcePair {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(randomBytes(32));
}

export function buildAuthorizeUrl(cfg: OAuthPkceConfig, challenge: string, state: string): string {
  const u = new URL(cfg.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', `http://127.0.0.1:${cfg.redirectPort}/callback`);
  u.searchParams.set('scope', cfg.scopes.join(' '));
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return u.toString();
}

/** Constant-time state comparison (avoids a timing oracle on the CSRF token). */
function stateMatches(expected: string, got: string | null): boolean {
  if (got === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface LoopbackOpts {
  /** Print the URL instead of opening a browser (SSH/headless). */
  openBrowser?: boolean;
  /** Override the redirect port (tests use an ephemeral port). */
  portOverride?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injected opener (tests). Default: no-op (the URL is printed regardless). */
  openUrl?: (url: string) => void;
  log?: (msg: string) => void;
}

/**
 * One-shot loopback authorization: bind 127.0.0.1, print/open the authorize
 * URL, and resolve with the authorization code once the browser redirects back.
 * Validates `state` (timing-safe). Server is always stopped in `finally`.
 * Throws on timeout, state mismatch, or an `error` param.
 */
export async function runLoopbackFlow(
  cfg: OAuthPkceConfig,
  authorizeUrl: string,
  expectedState: string,
  opts: LoopbackOpts = {},
): Promise<{ code: string }> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const log = opts.log ?? (() => {});
  const port = opts.portOverride ?? cfg.redirectPort;

  let server: { stop: (closeActive?: boolean) => void; port: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const codePromise = new Promise<{ code: string }>((resolve, reject) => {
      // Bun.serve is provided by the Bun runtime.
      const bun = (globalThis as unknown as { Bun?: { serve: (o: unknown) => typeof server } }).Bun;
      if (!bun) {
        reject(new Error('oauth loopback requires the Bun runtime (Bun.serve)'));
        return;
      }
      try {
        server = bun.serve({
          hostname: '127.0.0.1',
          port,
          fetch(req: Request) {
            const url = new URL(req.url);
            if (url.pathname !== '/callback') {
              return new Response('not found', { status: 404 });
            }
            const err = url.searchParams.get('error');
            if (err) {
              reject(new Error(`oauth authorization failed: ${err}`));
              return new Response('Authorization failed. You can close this window.', { status: 400 });
            }
            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            if (!stateMatches(expectedState, state)) {
              reject(new Error('oauth state mismatch (possible CSRF); aborting'));
              return new Response('State mismatch. You can close this window.', { status: 400 });
            }
            if (!code) {
              reject(new Error('oauth callback missing code'));
              return new Response('Missing code. You can close this window.', { status: 400 });
            }
            resolve({ code });
            return new Response(
              '<html><body><h3>gbrain: authorization complete.</h3>You can close this window.</body></html>',
              { headers: { 'content-type': 'text/html' } },
            );
          },
        });
      } catch (e) {
        reject(
          new Error(
            `oauth loopback could not bind 127.0.0.1:${port} (${e instanceof Error ? e.message : String(e)}) — ` +
              'another flow may be using it; close it or use the cookie lane',
          ),
        );
      }
    });

    if (opts.openBrowser && opts.openUrl) opts.openUrl(authorizeUrl);
    log(`Open this URL to authorize:\n  ${authorizeUrl}`);

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`oauth loopback timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => reject(new Error('oauth loopback aborted')), { once: true });
      }
    });

    return await Promise.race([codePromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    // Graceful stop: let the in-flight callback response flush so the browser
    // sees the success page (and the test's triggering fetch isn't reset).
    if (server) server.stop();
  }
}

async function postToken(cfg: OAuthPkceConfig, body: Record<string, string>): Promise<OAuthTokens> {
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new Error(`oauth token endpoint HTTP ${res.status}`);
  }
  const j = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!j.access_token) throw new Error('oauth token response missing access_token');
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: typeof j.expires_in === 'number' ? Date.now() + j.expires_in * 1000 : undefined,
  };
}

export async function exchangeCode(cfg: OAuthPkceConfig, code: string, verifier: string): Promise<OAuthTokens> {
  return postToken(cfg, {
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: `http://127.0.0.1:${cfg.redirectPort}/callback`,
  });
}

export async function refreshAccessToken(cfg: OAuthPkceConfig, refreshToken: string): Promise<OAuthTokens> {
  return postToken(cfg, {
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    refresh_token: refreshToken,
  });
}
