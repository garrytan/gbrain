/**
 * creds/relay-client — typed client for the gbrain.io OAuth consent relay.
 *
 * The relay lets a user connect Google WITHOUT creating their own OAuth
 * client: gbrain.io operates one verified (confidential) Google client, the
 * relay brokers consent + token exchange server-side, and the CLI claims the
 * tokens exactly once. Zero retention: the relay deletes tokens on first
 * successful claim (or at the 10-minute session TTL).
 *
 * This module is the CLIENT half only. The server design lives in
 * docs/designs/HOSTED_OAUTH_RELAY.md; its conformance target is this file's
 * test suite (test/creds-relay-client.test.ts) — a server that round-trips
 * those fixtures is compatible.
 *
 * Feature gate: everything here is inert unless GBRAIN_OAUTH_RELAY_URL is
 * set (unset = the BYO flow, which always works). No CLI imports.
 */

import { CredentialError } from './errors.ts';
import type { CredentialEntry } from './vault.ts';
import type { TokenResponse } from './providers/google.ts';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** The relay base URL, or null when the fast path is off. */
export function relayUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.GBRAIN_OAUTH_RELAY_URL?.trim();
  if (!v) return null;
  return v.replace(/\/+$/, '');
}

export interface RelaySession {
  session_id: string;
  claim_secret: string;
  consent_url: string;
  expires_in: number;
}

export interface RelayClaim {
  access_token: string;
  refresh_token: string;
  expiry: string;
  scopes: string[];
  email: string;
}

async function relayFetch(
  url: string,
  init: RequestInit,
  fetchImpl: FetchImpl,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    throw new CredentialError('relay_unreachable', undefined, e);
  }
}

export async function createSession(
  base: string,
  input: { provider: 'google'; scopes: string[]; client_kind: 'cli' },
  fetchImpl: FetchImpl = fetch,
): Promise<RelaySession> {
  const res = await relayFetch(
    `${base}/api/oauth/relay/sessions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
    fetchImpl,
  );
  if (!res.ok) throw new CredentialError('relay_unreachable', undefined, `HTTP ${res.status}`);
  const body = (await res.json()) as Partial<RelaySession>;
  if (!body.session_id || !body.claim_secret || !body.consent_url) {
    throw new CredentialError('relay_unreachable', undefined, 'malformed session response');
  }
  return {
    session_id: body.session_id,
    claim_secret: body.claim_secret,
    consent_url: body.consent_url,
    expires_in: typeof body.expires_in === 'number' ? body.expires_in : 600,
  };
}

export interface PollOpts {
  /** Total budget; default 600s (the relay session TTL). */
  timeoutMs?: number;
  /** First delay; doubles up to maxDelayMs. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Injectable sleeper for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the one-time claim endpoint until the consent completes.
 * 202 = not yet; 200 = tokens (relay deletes them on send); 410 = already
 * claimed; 404 = session expired.
 */
export async function pollClaim(
  base: string,
  session: Pick<RelaySession, 'session_id' | 'claim_secret'>,
  opts: PollOpts = {},
  fetchImpl: FetchImpl = fetch,
): Promise<RelayClaim> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const sleep = opts.sleep ?? defaultSleep;
  let delay = opts.initialDelayMs ?? 2_000;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (opts.signal?.aborted) throw new CredentialError('consent_timeout');
    const res = await relayFetch(
      `${base}/api/oauth/relay/sessions/${encodeURIComponent(session.session_id)}/claim`,
      { headers: { authorization: `Bearer ${session.claim_secret}` } },
      fetchImpl,
    );
    if (res.status === 200) {
      const body = (await res.json()) as Partial<RelayClaim>;
      if (!body.access_token || !body.refresh_token || !body.email) {
        throw new CredentialError('relay_unreachable', undefined, 'malformed claim response');
      }
      return {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expiry: body.expiry ?? new Date(Date.now() + 3_000_000).toISOString(),
        scopes: Array.isArray(body.scopes) ? body.scopes : [],
        email: body.email.toLowerCase(),
      };
    }
    if (res.status === 410) throw new CredentialError('claim_already_used');
    if (res.status === 404) throw new CredentialError('relay_session_expired');
    if (res.status !== 202) {
      throw new CredentialError('relay_unreachable', undefined, `claim HTTP ${res.status}`);
    }
    if (Date.now() + delay > deadline) throw new CredentialError('relay_session_expired');
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  }
}

/**
 * Refresh an access token for a relay-minted credential. The confidential
 * client's secret lives only on the relay, so byo-style local refresh is
 * impossible by design; the relay performs the upstream refresh and returns
 * the result without storing either token.
 */
export async function refreshViaRelay(
  base: string,
  entry: CredentialEntry,
  fetchImpl: FetchImpl = fetch,
): Promise<TokenResponse> {
  if (!entry.secret.refresh_token) {
    throw new CredentialError('not_connected', ` for ${entry.id}`);
  }
  const res = await relayFetch(
    `${base}/api/oauth/relay/refresh`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', refresh_token: entry.secret.refresh_token }),
    },
    fetchImpl,
  );
  if (res.status === 401 || res.status === 403) {
    throw new CredentialError('invalid_grant_revoked');
  }
  if (!res.ok) {
    throw new CredentialError('relay_unreachable', undefined, `refresh HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!body.access_token || typeof body.expires_in !== 'number') {
    throw new CredentialError('relay_unreachable', undefined, 'malformed refresh response');
  }
  return {
    access_token: body.access_token,
    expires_in: body.expires_in,
    ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
  };
}
