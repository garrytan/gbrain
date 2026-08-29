/**
 * creds-relay-client — tests for the gbrain.io OAuth consent relay CLIENT
 * (src/core/creds/relay-client.ts).
 *
 * ★ CONFORMANCE SPEC ★
 * The fake relay below is the executable contract for the future gbrain.io
 * relay server (docs/designs/HOSTED_OAUTH_RELAY.md points here). A real
 * server that behaves exactly like `startFakeRelay` is compatible with this
 * client. The load-bearing behaviors, spelled out:
 *
 *   POST /api/oauth/relay/sessions
 *     body: { provider: 'google', scopes: string[], client_kind: 'cli' }
 *     → 201 { session_id, claim_secret, consent_url, expires_in }
 *       (claim_secret is the ONLY credential for the claim endpoint; it is
 *        never embedded in consent_url).
 *
 *   GET /api/oauth/relay/sessions/:id/claim
 *     auth: `Authorization: Bearer <claim_secret>` — REQUIRED. A missing or
 *       wrong secret must NOT reveal whether the session exists (any non-202/
 *       200/410/404 status makes the client fail closed as relay_unreachable).
 *     → 202 (empty)  while the user has not completed consent yet
 *     → 200 ONCE     { access_token, refresh_token, expiry, scopes, email }
 *                    — the relay deletes the tokens on send (zero retention)
 *     → 410          on every claim AFTER the successful one (one-time claim)
 *     → 404          for an unknown/expired session id
 *
 *   POST /api/oauth/relay/refresh
 *     body: { provider: 'google', refresh_token }
 *     → 200 { access_token, expires_in }  on success
 *     → 401 (or 403)                      when the grant is revoked/unknown
 *
 * Client-side mappings pinned here:
 *   202 → keep polling (backoff, injectable sleep)     410 → claim_already_used
 *   404 → relay_session_expired      network error / malformed → relay_unreachable
 *   refresh 401/403 → invalid_grant_revoked
 */

import { describe, it, expect, afterAll } from 'bun:test';

import {
  createSession,
  pollClaim,
  refreshViaRelay,
  relayUrl,
  type FetchImpl,
} from '../src/core/creds/relay-client.ts';
import { CredentialError } from '../src/core/creds/errors.ts';
import type { CredentialEntry } from '../src/core/creds/vault.ts';

// ── Synthetic fixtures (never real tokens/emails) ────────────────────────────

const RELAY_ACCESS_TOKEN = 'ya29.relay-access-test';
const RELAY_REFRESH_TOKEN = '1//relay-refresh-test';
const RELAY_EXPIRY = '2026-08-25T12:00:00.000Z';
const RELAY_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'];

function relayEntry(refreshToken: string): CredentialEntry {
  return {
    id: 'google:a@example.com',
    provider: 'google',
    kind: 'oauth2',
    client_ref: 'hosted-relay',
    secret: { access_token: 'ya29.stale', refresh_token: refreshToken, expiry: '2026-08-25T00:00:00.000Z' },
    meta: { account: 'a@example.com', connected_at: '2026-08-01T00:00:00.000Z' },
  };
}

async function expectCode(p: Promise<unknown>, code: CredentialError['code']): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (e) {
    threw = true;
    expect(e).toBeInstanceOf(CredentialError);
    expect((e as CredentialError).code).toBe(code);
  }
  expect(threw).toBe(true);
}

// ── The fake relay server (the conformance target) ───────────────────────────

interface FakeSession {
  claim_secret: string;
  /** How many 202 "not yet" responses to serve before consent "completes". */
  pollsUntilConsent: number;
  polls: number;
  claimed: boolean;
}

interface FakeRelay {
  base: string;
  sessions: Map<string, FakeSession>;
  stop: () => void;
}

function startFakeRelay(opts: { pollsUntilConsent?: number } = {}): FakeRelay {
  const sessions = new Map<string, FakeSession>();
  let nextId = 1;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0, // ephemeral
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // ── POST /api/oauth/relay/sessions — create a consent session ────────
      if (req.method === 'POST' && url.pathname === '/api/oauth/relay/sessions') {
        const body = (await req.json()) as { provider?: string; client_kind?: string };
        // A conforming server validates the shape; anything else is a 400.
        if (body.provider !== 'google' || body.client_kind !== 'cli') {
          return new Response('bad request', { status: 400 });
        }
        const id = `sess-${nextId++}`;
        const secret = `claim-secret-${id}`;
        sessions.set(id, {
          claim_secret: secret,
          pollsUntilConsent: opts.pollsUntilConsent ?? 0,
          polls: 0,
          claimed: false,
        });
        return Response.json(
          {
            session_id: id,
            claim_secret: secret,
            consent_url: `https://relay.invalid/consent/${id}`, // secret NOT embedded
            expires_in: 600, // 10-minute session TTL
          },
          { status: 201 },
        );
      }

      // ── GET /api/oauth/relay/sessions/:id/claim — one-time token claim ───
      const claimMatch = url.pathname.match(/^\/api\/oauth\/relay\/sessions\/([^/]+)\/claim$/);
      if (req.method === 'GET' && claimMatch) {
        const sess = sessions.get(claimMatch[1]);
        // Unknown or TTL-expired session: 404 (client maps → relay_session_expired).
        if (!sess) return new Response('', { status: 404 });
        // The claim_secret is the sole credential. Wrong/missing → 401.
        if (req.headers.get('authorization') !== `Bearer ${sess.claim_secret}`) {
          return new Response('', { status: 401 });
        }
        // One-time handover: every claim after the first success is 410.
        if (sess.claimed) return new Response('', { status: 410 });
        sess.polls += 1;
        // Consent not completed yet: 202 with no body (client keeps polling).
        if (sess.polls <= sess.pollsUntilConsent) return new Response('', { status: 202 });
        // Consent complete: hand over the tokens EXACTLY ONCE, then forget them.
        sess.claimed = true;
        return Response.json(
          {
            access_token: RELAY_ACCESS_TOKEN,
            refresh_token: RELAY_REFRESH_TOKEN,
            expiry: RELAY_EXPIRY,
            scopes: RELAY_SCOPES,
            // Mixed case on purpose: the CLIENT normalizes to lowercase.
            email: 'A@Example.com',
          },
          { status: 200 },
        );
      }

      // ── POST /api/oauth/relay/refresh — server-side token refresh ────────
      if (req.method === 'POST' && url.pathname === '/api/oauth/relay/refresh') {
        const body = (await req.json()) as { provider?: string; refresh_token?: string };
        // Revoked/unknown grant → 401 (client maps → invalid_grant_revoked).
        if (body.provider !== 'google' || body.refresh_token !== RELAY_REFRESH_TOKEN) {
          return new Response('', { status: 401 });
        }
        return Response.json({ access_token: 'ya29.relay-refreshed-test', expires_in: 3600 });
      }

      return new Response('not found', { status: 404 });
    },
  });

  return {
    base: `http://127.0.0.1:${server.port}`,
    sessions,
    stop: () => server.stop(true),
  };
}

const relays: FakeRelay[] = [];
function relay(opts: { pollsUntilConsent?: number } = {}): FakeRelay {
  const r = startFakeRelay(opts);
  relays.push(r);
  return r;
}
afterAll(() => {
  for (const r of relays) r.stop();
});

/** Skip real waiting between polls; record the requested backoff delays. */
function instantSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

// ── relayUrl ─────────────────────────────────────────────────────────────────

describe('relayUrl', () => {
  it('returns null when the env var is unset or blank (fast path off)', () => {
    expect(relayUrl({})).toBeNull();
    expect(relayUrl({ GBRAIN_OAUTH_RELAY_URL: '' })).toBeNull();
    expect(relayUrl({ GBRAIN_OAUTH_RELAY_URL: '   ' })).toBeNull();
  });

  it('strips trailing slashes', () => {
    expect(relayUrl({ GBRAIN_OAUTH_RELAY_URL: 'https://relay.example.com///' })).toBe(
      'https://relay.example.com',
    );
    expect(relayUrl({ GBRAIN_OAUTH_RELAY_URL: ' https://relay.example.com/ ' })).toBe(
      'https://relay.example.com',
    );
  });
});

// ── createSession ────────────────────────────────────────────────────────────

describe('createSession', () => {
  it('happy path: 201 with session_id/claim_secret/consent_url/expires_in', async () => {
    const r = relay();
    const session = await createSession(r.base, {
      provider: 'google',
      scopes: RELAY_SCOPES,
      client_kind: 'cli',
    });
    expect(session.session_id).toMatch(/^sess-/);
    expect(session.claim_secret).toBe(`claim-secret-${session.session_id}`);
    expect(session.consent_url).toContain(session.session_id);
    // The claim secret must never travel inside the consent URL.
    expect(session.consent_url).not.toContain(session.claim_secret);
    expect(session.expires_in).toBe(600);
  });

  it('a malformed (non-conformant) response → relay_unreachable', async () => {
    // Simulates a broken server: 200 but missing the required fields.
    const brokenServer: FetchImpl = async () => Response.json({ hello: 'world' });
    await expectCode(
      createSession('http://relay.invalid', { provider: 'google', scopes: [], client_kind: 'cli' }, brokenServer),
      'relay_unreachable',
    );
  });
});

// ── pollClaim ────────────────────────────────────────────────────────────────

describe('pollClaim', () => {
  it('polls through 202,202 then claims on 200 (injected sleep, no real waiting)', async () => {
    const r = relay({ pollsUntilConsent: 2 });
    const session = await createSession(r.base, {
      provider: 'google',
      scopes: RELAY_SCOPES,
      client_kind: 'cli',
    });
    const { sleep, delays } = instantSleep();
    const claim = await pollClaim(r.base, session, { sleep });
    expect(claim.access_token).toBe(RELAY_ACCESS_TOKEN);
    expect(claim.refresh_token).toBe(RELAY_REFRESH_TOKEN);
    expect(claim.expiry).toBe(RELAY_EXPIRY);
    expect(claim.scopes).toEqual(RELAY_SCOPES);
    // The client lowercases the email the relay reports.
    expect(claim.email).toBe('a@example.com');
    // Two 202s → two backoff sleeps, doubling from the initial delay.
    expect(delays).toHaveLength(2);
    expect(delays[1]).toBe(delays[0] * 2);
  });

  it('a second poll after a successful claim → claim_already_used (410)', async () => {
    const r = relay({ pollsUntilConsent: 0 });
    const session = await createSession(r.base, {
      provider: 'google',
      scopes: RELAY_SCOPES,
      client_kind: 'cli',
    });
    const { sleep } = instantSleep();
    const first = await pollClaim(r.base, session, { sleep });
    expect(first.access_token).toBe(RELAY_ACCESS_TOKEN);
    // Tokens are handed over exactly once; the relay refuses replays.
    await expectCode(pollClaim(r.base, session, { sleep }), 'claim_already_used');
  });

  it('an expired/unknown session → relay_session_expired (404)', async () => {
    const r = relay();
    const { sleep } = instantSleep();
    await expectCode(
      pollClaim(r.base, { session_id: 'sess-expired', claim_secret: 'claim-secret-sess-expired' }, { sleep }),
      'relay_session_expired',
    );
  });

  it('a network-refused base URL → relay_unreachable', async () => {
    // Grab a genuinely free port by binding and immediately releasing it.
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const deadPort = probe.port;
    probe.stop(true);
    const { sleep } = instantSleep();
    await expectCode(
      pollClaim(
        `http://127.0.0.1:${deadPort}`,
        { session_id: 'sess-x', claim_secret: 'claim-secret-sess-x' },
        { sleep },
      ),
      'relay_unreachable',
    );
  });
});

describe('pollClaim hardening', () => {
  it('a wrong claim_secret (401) fails closed as relay_unreachable — existence is not revealed', async () => {
    const r = relay({ pollsUntilConsent: 0 });
    const session = await createSession(r.base, {
      provider: 'google',
      scopes: RELAY_SCOPES,
      client_kind: 'cli',
    });
    const { sleep } = instantSleep();
    await expectCode(
      pollClaim(
        r.base,
        { session_id: session.session_id, claim_secret: 'claim-secret-wrong' },
        { sleep },
      ),
      'relay_unreachable',
    );
    // The tokens were never handed over: the right secret can still claim.
    const claim = await pollClaim(r.base, session, { sleep });
    expect(claim.access_token).toBe(RELAY_ACCESS_TOKEN);
  });

  it('deadline expiry while the relay keeps 202ing → relay_session_expired (before sleeping past it)', async () => {
    const always202: FetchImpl = async () => new Response('', { status: 202 });
    const { sleep, delays } = instantSleep();
    await expectCode(
      pollClaim(
        'http://relay.invalid',
        { session_id: 'sess-slow', claim_secret: 'claim-secret-sess-slow' },
        { timeoutMs: 1, sleep },
        always202,
      ),
      'relay_session_expired',
    );
    // The client gives up when the NEXT sleep would cross the deadline —
    // it never burns a sleep it can't afford.
    expect(delays).toHaveLength(0);
  });

  it('an aborted signal → consent_timeout, checked before any request fires', async () => {
    const ac = new AbortController();
    ac.abort();
    let fetched = false;
    const neverFetch: FetchImpl = async () => {
      fetched = true;
      throw new Error('must not fetch after abort');
    };
    const { sleep } = instantSleep();
    await expectCode(
      pollClaim(
        'http://relay.invalid',
        { session_id: 'sess-abort', claim_secret: 'claim-secret-sess-abort' },
        { signal: ac.signal, sleep },
        neverFetch,
      ),
      'consent_timeout',
    );
    expect(fetched).toBe(false);
  });

  it('200 with a malformed claim body → relay_unreachable (fail closed, no partial claim)', async () => {
    // Missing refresh_token and email — a non-conformant server.
    const malformed: FetchImpl = async () => Response.json({ access_token: 'ya29.only' });
    const { sleep } = instantSleep();
    await expectCode(
      pollClaim(
        'http://relay.invalid',
        { session_id: 'sess-bad', claim_secret: 'claim-secret-sess-bad' },
        { sleep },
        malformed,
      ),
      'relay_unreachable',
    );
  });

  it('backoff doubles from initialDelayMs and plateaus at maxDelayMs', async () => {
    let polls = 0;
    const fiveThenClaim: FetchImpl = async () => {
      polls++;
      if (polls <= 5) return new Response('', { status: 202 });
      return Response.json({
        access_token: RELAY_ACCESS_TOKEN,
        refresh_token: RELAY_REFRESH_TOKEN,
        expiry: RELAY_EXPIRY,
        scopes: RELAY_SCOPES,
        email: 'a@example.com',
      });
    };
    const { sleep, delays } = instantSleep();
    const claim = await pollClaim(
      'http://relay.invalid',
      { session_id: 'sess-plateau', claim_secret: 'claim-secret-sess-plateau' },
      { initialDelayMs: 1_000, maxDelayMs: 5_000, sleep },
      fiveThenClaim,
    );
    expect(claim.email).toBe('a@example.com');
    // 1s → 2s → 4s → capped at 5s, 5s (never past maxDelayMs).
    expect(delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
  });
});

// ── refreshViaRelay ──────────────────────────────────────────────────────────

describe('refreshViaRelay', () => {
  it('happy path: returns the refreshed access token + expires_in', async () => {
    const r = relay();
    const token = await refreshViaRelay(r.base, relayEntry(RELAY_REFRESH_TOKEN));
    expect(token.access_token).toBe('ya29.relay-refreshed-test');
    expect(token.expires_in).toBe(3600);
  });

  it('401 from the relay → invalid_grant_revoked', async () => {
    const r = relay();
    await expectCode(refreshViaRelay(r.base, relayEntry('1//revoked-refresh-test')), 'invalid_grant_revoked');
  });
});
