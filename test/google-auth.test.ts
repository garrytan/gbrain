/**
 * google-auth — unit tests for the Google OAuth2 provider client
 * (src/core/creds/providers/google.ts).
 *
 * Everything network-shaped goes through an injected fetchImpl fake (house
 * style: github-source-materialize.test.ts). No real Google endpoints, no
 * real tokens — every fixture value is synthetic.
 */

import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  GOOGLE_PROVIDER,
  GOOGLE_TOKEN_URL,
  GoogleTokenProvider,
  apiEnableLink,
  buildAuthUrl,
  exchangeCode,
  fetchSendAsAliases,
  generatePkce,
  looksLikeClientId,
  looksLikeClientSecret,
  parseClientJson,
  projectNumberFromClientId,
  refreshAccessToken,
  sanitizePastedValue,
  validateClientPair,
  type FetchImpl,
} from '../src/core/creds/providers/google.ts';
import { CredentialError } from '../src/core/creds/errors.ts';
import {
  redactEntry,
  type CredentialEntry,
  type CredentialMeta,
  type CredentialVault,
  type ProviderClientRecord,
} from '../src/core/creds/vault.ts';
import { withEnv } from './helpers/with-env.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function expectCodeSync(fn: () => unknown, code: CredentialError['code']): void {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    expect(e).toBeInstanceOf(CredentialError);
    expect((e as CredentialError).code).toBe(code);
  }
  expect(threw).toBe(true);
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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A fetch fake that serves a queue of canned responses and records calls. */
function fakeFetch(responses: Response[]): FetchImpl & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`fakeFetch: no canned response left for ${url}`);
    return next;
  };
  return Object.assign(impl, { calls });
}

const CLIENT_ID = '12345-abc.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test1234567890';

const EXCHANGE_INPUT = {
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  code: '4/test-auth-code',
  redirectUri: 'http://127.0.0.1:41999/',
  codeVerifier: 'test-verifier-value',
};

function makeEntry(overrides: Partial<CredentialEntry> = {}): CredentialEntry {
  return {
    id: 'google:a@example.com',
    provider: 'google',
    kind: 'oauth2',
    client_ref: 'byo',
    secret: {
      access_token: 'ya29.test-access',
      refresh_token: '1//test-refresh',
      expiry: '2026-08-25T12:00:00.000Z',
    },
    meta: {
      account: 'a@example.com',
      scopes: ['openid', 'email'],
      connected_at: '2026-08-01T00:00:00.000Z',
      consent_publish_state: 'unknown',
    },
    ...overrides,
  };
}

const CLIENT_RECORD: ProviderClientRecord = {
  provider: 'google',
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  created_at: '2026-08-01T00:00:00.000Z',
};

/** In-memory CredentialVault for GoogleTokenProvider tests. */
class MemoryVault implements CredentialVault {
  entries = new Map<string, CredentialEntry>();
  clients = new Map<string, ProviderClientRecord>();

  async get(id: string): Promise<CredentialEntry | null> {
    return this.entries.get(id) ?? null;
  }
  async put(entry: CredentialEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }
  async list(filter?: { provider?: string }): Promise<CredentialMeta[]> {
    return [...this.entries.values()]
      .filter((e) => !filter?.provider || e.provider === filter.provider)
      .map(redactEntry);
  }
  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }
  async getClient(provider: string): Promise<ProviderClientRecord | null> {
    return this.clients.get(provider) ?? null;
  }
  async putClient(rec: ProviderClientRecord): Promise<void> {
    this.clients.set(rec.provider, rec);
  }
  async deleteClient(provider: string): Promise<boolean> {
    return this.clients.delete(provider);
  }
}

// ── Client-credential intake ─────────────────────────────────────────────────

describe('parseClientJson', () => {
  it('parses a valid {"installed":{...}} client JSON', () => {
    const parsed = parseClientJson(
      JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } }),
    );
    expect(parsed).toEqual({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  });

  it('rejects a Web-application client with client_json_wrong_type', () => {
    expectCodeSync(
      () =>
        parseClientJson(
          JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } }),
        ),
      'client_json_wrong_type',
    );
  });

  it('rejects garbage with client_json_unreadable', () => {
    expectCodeSync(() => parseClientJson('this is not json at all'), 'client_json_unreadable');
  });

  it('rejects a missing client_id with client_json_unreadable', () => {
    expectCodeSync(
      () => parseClientJson(JSON.stringify({ installed: { client_secret: CLIENT_SECRET } })),
      'client_json_unreadable',
    );
  });
});

describe('validateClientPair + sanitizePastedValue', () => {
  it('strips smart quotes and whitespace picked up by a chat paste', () => {
    const parsed = validateClientPair(`“${CLIENT_ID}” `, ` ‘GOCSPX-abc123’\n`);
    expect(parsed).toEqual({ client_id: CLIENT_ID, client_secret: 'GOCSPX-abc123' });
  });

  it('sanitizePastedValue strips quotes, zero-width chars, whitespace', () => {
    expect(sanitizePastedValue(' "GOCSPX-abc' + '\u200b' + '" ')).toBe('GOCSPX-abc');
    expect(sanitizePastedValue('“value”')).toBe('value');
  });

  it('rejects bad shapes with client_shape_invalid', () => {
    expectCodeSync(() => validateClientPair('not-a-client-id', 'GOCSPX-abc123'), 'client_shape_invalid');
    expectCodeSync(() => validateClientPair(CLIENT_ID, 'short'), 'client_shape_invalid');
    expectCodeSync(() => validateClientPair('', ''), 'client_shape_invalid');
  });

  it('looksLike* helpers accept the canonical shapes', () => {
    expect(looksLikeClientId(CLIENT_ID)).toBe(true);
    expect(looksLikeClientId('nope.example.com')).toBe(false);
    expect(looksLikeClientSecret('GOCSPX-abc123')).toBe(true);
    expect(looksLikeClientSecret('x')).toBe(false);
  });
});

describe('project number + API enable links', () => {
  it('extracts the project number from the client id', () => {
    expect(projectNumberFromClientId('12345-abc.apps.googleusercontent.com')).toBe('12345');
    expect(projectNumberFromClientId('no-digits.example.com')).toBeNull();
  });

  it('apiEnableLink deep-links with ?project=<number> when the client id is known', () => {
    const link = apiEnableLink('gmail', '12345-abc.apps.googleusercontent.com');
    expect(link).toContain('gmail.googleapis.com');
    expect(link).toContain('?project=12345');
    // Without a client id: no project qualifier.
    expect(apiEnableLink('people')).not.toContain('?project=');
  });
});

// ── PKCE + auth URL ──────────────────────────────────────────────────────────

describe('generatePkce', () => {
  it('produces a 43-char base64url verifier and a matching S256 challenge', () => {
    const pkce = generatePkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = createHash('sha256')
      .update(pkce.verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(pkce.challenge).toBe(expected);
    // Fresh randomness on every call.
    expect(generatePkce().verifier).not.toBe(pkce.verifier);
  });
});

describe('buildAuthUrl', () => {
  const scopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'];

  it('carries the offline+consent+PKCE+incremental parameters', () => {
    const url = buildAuthUrl({
      clientId: CLIENT_ID,
      redirectUri: 'http://127.0.0.1:41999/',
      scopes,
      state: 'state-test',
      codeChallenge: 'challenge-test',
      loginHint: 'a@example.com',
    });
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('include_granted_scopes=true');

    const params = new URL(url).searchParams;
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('redirect_uri')).toBe('http://127.0.0.1:41999/');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('scope')).toBe(scopes.join(' '));
    expect(params.get('state')).toBe('state-test');
    expect(params.get('code_challenge')).toBe('challenge-test');
    expect(params.get('login_hint')).toBe('a@example.com');
  });

  it('omits login_hint when not given', () => {
    const url = buildAuthUrl({
      clientId: CLIENT_ID,
      redirectUri: 'http://127.0.0.1:41999/',
      scopes,
      state: 'state-test',
      codeChallenge: 'challenge-test',
    });
    expect(new URL(url).searchParams.get('login_hint')).toBeNull();
  });
});

// ── Token exchange ───────────────────────────────────────────────────────────

describe('exchangeCode', () => {
  it('returns the token body on 200 with a refresh_token', async () => {
    const body = {
      access_token: 'ya29.new-access',
      refresh_token: '1//new-refresh',
      expires_in: 3599,
      scope: 'openid email',
    };
    const impl = fakeFetch([jsonResponse(body)]);
    const token = await exchangeCode(EXCHANGE_INPUT, impl);
    expect(token).toEqual(body);
    expect(impl.calls).toHaveLength(1);
    expect(impl.calls[0].url).toBe(GOOGLE_TOKEN_URL);
    // The exchange posts form-encoded grant_type=authorization_code.
    expect(String(impl.calls[0].init?.body)).toContain('grant_type=authorization_code');
  });

  it('200 WITHOUT a refresh_token → no_refresh_token', async () => {
    const impl = fakeFetch([jsonResponse({ access_token: 'ya29.new-access', expires_in: 3599 })]);
    await expectCode(exchangeCode(EXCHANGE_INPUT, impl), 'no_refresh_token');
  });

  it('400 invalid_grant with a Date header skewed >60s → invalid_grant_clock_skew', async () => {
    const skewedDate = new Date(Date.now() - 120_000).toUTCString();
    const impl = fakeFetch([jsonResponse({ error: 'invalid_grant' }, 400, { date: skewedDate })]);
    await expectCode(exchangeCode(EXCHANGE_INPUT, impl), 'invalid_grant_clock_skew');
  });

  it('400 invalid_grant with an accurate Date header → code_reused', async () => {
    const accurateDate = new Date().toUTCString();
    const impl = fakeFetch([jsonResponse({ error: 'invalid_grant' }, 400, { date: accurateDate })]);
    await expectCode(exchangeCode(EXCHANGE_INPUT, impl), 'code_reused');
  });

  it('401 invalid_client → invalid_client', async () => {
    const impl = fakeFetch([jsonResponse({ error: 'invalid_client' }, 401)]);
    await expectCode(exchangeCode(EXCHANGE_INPUT, impl), 'invalid_client');
  });
});

// ── Refresh sub-classification ───────────────────────────────────────────────

describe('refreshAccessToken invalid_grant sub-classification', () => {
  const NOW = new Date('2026-08-25T00:00:00.000Z');
  const DAYS_7_AGO = new Date(NOW.getTime() - 7 * 86_400_000).toISOString();
  const DAYS_1_AGO = new Date(NOW.getTime() - 1 * 86_400_000).toISOString();

  function invalidGrant(): FetchImpl {
    // No Date header → the clock-skew check is skipped (null skew).
    return fakeFetch([jsonResponse({ error: 'invalid_grant' }, 400)]);
  }

  it('7 days stale + consent_publish_state unknown → invalid_grant_testing_expiry', async () => {
    const entry = makeEntry({
      meta: { ...makeEntry().meta, last_refresh_ok_at: DAYS_7_AGO, consent_publish_state: 'unknown' },
    });
    await expectCode(
      refreshAccessToken(entry, CLIENT_RECORD, invalidGrant(), NOW),
      'invalid_grant_testing_expiry',
    );
  });

  it('7 days stale but consent_publish_state production → invalid_grant_revoked', async () => {
    const entry = makeEntry({
      meta: {
        ...makeEntry().meta,
        last_refresh_ok_at: DAYS_7_AGO,
        consent_publish_state: 'production',
      },
    });
    await expectCode(
      refreshAccessToken(entry, CLIENT_RECORD, invalidGrant(), NOW),
      'invalid_grant_revoked',
    );
  });

  it('fresh proof-of-life (1 day ago) → invalid_grant_revoked even in unknown state', async () => {
    const entry = makeEntry({
      meta: { ...makeEntry().meta, last_refresh_ok_at: DAYS_1_AGO, consent_publish_state: 'unknown' },
    });
    await expectCode(
      refreshAccessToken(entry, CLIENT_RECORD, invalidGrant(), NOW),
      'invalid_grant_revoked',
    );
  });
});

// ── GoogleTokenProvider ──────────────────────────────────────────────────────

describe('GoogleTokenProvider', () => {
  it('returns an unexpired access token without touching the network', async () => {
    const vault = new MemoryVault();
    const entry = makeEntry({
      secret: {
        access_token: 'ya29.still-fresh',
        refresh_token: '1//test-refresh',
        expiry: new Date(Date.now() + 10 * 60_000).toISOString(), // now + 10min, outside the 5-min margin
      },
    });
    await vault.put(entry);
    const impl = fakeFetch([]); // any call would throw "no canned response left"
    const provider = new GoogleTokenProvider(vault, entry.id, impl);

    expect(await provider.getAccessToken()).toBe('ya29.still-fresh');
    expect(impl.calls).toHaveLength(0);
  });

  it('refreshes inside the 5-min margin, persisting the rotated refresh token', async () => {
    const vault = new MemoryVault();
    await vault.putClient(CLIENT_RECORD);
    const entry = makeEntry({
      secret: {
        access_token: 'ya29.nearly-expired',
        refresh_token: '1//old-refresh',
        expiry: new Date(Date.now() + 2 * 60_000).toISOString(), // now + 2min → inside the margin
      },
    });
    await vault.put(entry);
    const impl = fakeFetch([
      jsonResponse({
        access_token: 'ya29.refreshed-access',
        refresh_token: '1//rotated-refresh',
        expires_in: 3600,
      }),
    ]);
    const provider = new GoogleTokenProvider(vault, entry.id, impl);

    const before = Date.now();
    expect(await provider.getAccessToken()).toBe('ya29.refreshed-access');

    // Exactly one refresh call, to the Google token endpoint.
    expect(impl.calls).toHaveLength(1);
    expect(impl.calls[0].url).toBe(GOOGLE_TOKEN_URL);
    expect(String(impl.calls[0].init?.body)).toContain('grant_type=refresh_token');

    // Rotation + proof-of-life persisted back to the vault.
    const stored = await vault.get(entry.id);
    expect(stored?.secret.access_token).toBe('ya29.refreshed-access');
    expect(stored?.secret.refresh_token).toBe('1//rotated-refresh');
    expect(stored?.meta.last_refresh_ok_at).toBeDefined();
    expect(Date.parse(stored?.meta.last_refresh_ok_at ?? '')).toBeGreaterThanOrEqual(before);
    // New expiry lands ~an hour out.
    expect(Date.parse(stored?.secret.expiry ?? '')).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it('hosted-relay entry with no GBRAIN_OAUTH_RELAY_URL → relay_disabled', async () => {
    await withEnv({ GBRAIN_OAUTH_RELAY_URL: undefined }, async () => {
      const vault = new MemoryVault();
      const entry = makeEntry({
        client_ref: 'hosted-relay',
        secret: {
          access_token: 'ya29.nearly-expired',
          refresh_token: '1//relay-refresh',
          expiry: new Date(Date.now() - 1000).toISOString(), // already expired → forces refresh
        },
      });
      await vault.put(entry);
      const impl = fakeFetch([]);
      const provider = new GoogleTokenProvider(vault, entry.id, impl);
      await expectCode(provider.getAccessToken(), 'relay_disabled');
      expect(impl.calls).toHaveLength(0);
    });
  });

  it('unknown credential id → not_connected', async () => {
    const provider = new GoogleTokenProvider(new MemoryVault(), 'google:missing@example.com', fakeFetch([]));
    await expectCode(provider.getAccessToken(), 'not_connected');
  });
});

// ── Identity fetches ─────────────────────────────────────────────────────────

describe('fetchSendAsAliases', () => {
  it('returns [] on a non-ok response (never throws)', async () => {
    const impl = fakeFetch([jsonResponse({ error: { code: 403 } }, 403)]);
    expect(await fetchSendAsAliases('ya29.test-access', impl)).toEqual([]);
  });

  it('returns [] when the fetch itself throws', async () => {
    const impl: FetchImpl = async () => {
      throw new Error('network down');
    };
    expect(await fetchSendAsAliases('ya29.test-access', impl)).toEqual([]);
  });

  it('lowercases and filters the aliases on success', async () => {
    const impl = fakeFetch([
      jsonResponse({ sendAs: [{ sendAsEmail: 'A@Example.com' }, { sendAsEmail: '' }, {}] }),
    ]);
    expect(await fetchSendAsAliases('ya29.test-access', impl)).toEqual(['a@example.com']);
  });
});

// Sanity: the provider constant is what vault ids key on.
describe('constants', () => {
  it('GOOGLE_PROVIDER is "google"', () => {
    expect(GOOGLE_PROVIDER).toBe('google');
  });
});
