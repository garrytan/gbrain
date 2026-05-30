import { randomBytes } from 'crypto';
import { createServer } from 'http';
import { buildAuthorizationUrl, createPkcePair, exchangeAuthorizationCode, parseOAuthCallback } from './oauth.ts';
import { redactTokenLike, type OpenAICodexTokenRecord, type TokenStore } from './token-store.ts';

export interface LoopbackRedirectOptions {
  host: '127.0.0.1' | 'localhost';
  port: number;
  path: string;
}

export interface BrowserLoginCallbackWaitOptions {
  state: string;
  redirectUri: string;
}

export interface BrowserLoginCallbackResult {
  callbackUrl: string;
}

export type BrowserLoginCallbackWaiter = (opts: BrowserLoginCallbackWaitOptions) => Promise<BrowserLoginCallbackResult>;
export type BrowserOpener = (url: URL) => Promise<void> | void;

export interface OpenAICodexBrowserLoginOptions {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: string[];
  redirect: LoopbackRedirectOptions;
  tokenStore: TokenStore;
  openBrowser: BrowserOpener;
  waitForCallback: BrowserLoginCallbackWaiter;
  extraAuthParams?: Record<string, string>;
  randomState?: () => string;
  randomPkceBytes?: () => Uint8Array;
  now?: () => Date;
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

export interface OpenAICodexBrowserLoginResult {
  token: OpenAICodexTokenRecord;
  redirectUri: string;
}

export interface LoopbackOAuthCallbackWaiterOptions {
  timeoutMs?: number;
  successHtml?: string;
}

export function waitForLoopbackOAuthCallback(opts: LoopbackOAuthCallbackWaiterOptions = {}): BrowserLoginCallbackWaiter {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const successHtml = opts.successHtml ?? '<!doctype html><title>GBrain OpenAI Codex login complete</title><h1>GBrain OpenAI Codex login complete</h1><p>You can close this window.</p>';
  return ({ redirectUri }) => new Promise<BrowserLoginCallbackResult>((resolve, reject) => {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'http:' || (redirect.hostname !== '127.0.0.1' && redirect.hostname !== 'localhost')) {
      reject(new Error('openai-codex OAuth callback listener only supports http loopback redirect URIs'));
      return;
    }
    const port = Number(redirect.port);
    const path = redirect.pathname;
    let settled = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== path) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      settled = true;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(successHtml);
      server.close();
      resolve({ callbackUrl: url.toString() });
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error('Timed out waiting for openai-codex OAuth callback'));
    }, timeoutMs);
    server.once('close', () => clearTimeout(timer));
    server.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    server.listen(port, redirect.hostname);
  });
}

export function createLoopbackRedirectUri(opts: LoopbackRedirectOptions): string {
  if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
    throw new Error('openai-codex OAuth redirect host must be localhost or 127.0.0.1');
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
    throw new Error('openai-codex OAuth redirect port must be in 1..65535');
  }
  const path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
  return `http://${opts.host}:${opts.port}${path}`;
}

function defaultRandomState(): string {
  return randomBytes(24).toString('base64url');
}

export async function loginWithBrowserOpenAICodex(opts: OpenAICodexBrowserLoginOptions): Promise<OpenAICodexBrowserLoginResult> {
  const state = opts.randomState?.() ?? defaultRandomState();
  const pkce = await createPkcePair(opts.randomPkceBytes);
  const redirectUri = createLoopbackRedirectUri(opts.redirect);
  const authorizationUrl = buildAuthorizationUrl({
    authorizationEndpoint: opts.authorizationEndpoint,
    clientId: opts.clientId,
    redirectUri,
    state,
    codeChallenge: pkce.challenge,
    scopes: opts.scopes,
    extraParams: opts.extraAuthParams,
  });

  try {
    const callbackPromise = opts.waitForCallback({ state, redirectUri });
    await opts.openBrowser(authorizationUrl);
    const callback = await callbackPromise;
    const parsed = parseOAuthCallback(callback.callbackUrl, state);
    const token = await exchangeAuthorizationCode({
      tokenEndpoint: opts.tokenEndpoint,
      clientId: opts.clientId,
      code: parsed.code,
      codeVerifier: pkce.verifier,
      redirectUri,
      now: opts.now,
      fetch: opts.fetch,
    });
    await opts.tokenStore.set(token);
    return { token, redirectUri };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`openai-codex browser login failed: ${redactTokenLike(msg)}`);
  }
}
