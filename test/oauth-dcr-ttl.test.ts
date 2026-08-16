/**
 * #2179 — DCR `token_ttl_seconds`: clamp boundaries, persistence, response
 * echo, and per-client TTL enforcement across grant paths.
 *
 * The wire path (serve-http /register middleware → SDK handler → store) is
 * exercised at the store boundary here: the middleware's only job is to put
 * the parsed number into `dcrRegistrationContext`, which these tests do
 * directly. Setup mirrors test/oauth.test.ts (in-memory PGLite).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import {
  GBrainOAuthProvider,
  clampDcrTokenTtl,
  dcrRegistrationContext,
  DEFAULT_DCR_TTL_MIN_SECONDS,
} from '../src/core/oauth-provider.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';

let db: PGlite;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows;
  };
}, 30_000);

afterAll(async () => {
  if (db) await db.close();
}, 15_000);

// ---------------------------------------------------------------------------
// clampDcrTokenTtl — pure clamp boundaries
// ---------------------------------------------------------------------------

describe('clampDcrTokenTtl', () => {
  test('below min clamps up to min', () => {
    expect(clampDcrTokenTtl(10, 300, 600)).toBe(300);
  });

  test('exactly min passes through', () => {
    expect(clampDcrTokenTtl(300, 300, 600)).toBe(300);
  });

  test('in-range passes through', () => {
    expect(clampDcrTokenTtl(450, 300, 600)).toBe(450);
  });

  test('exactly max passes through', () => {
    expect(clampDcrTokenTtl(600, 300, 600)).toBe(600);
  });

  test('above max clamps down to max', () => {
    expect(clampDcrTokenTtl(999_999, 300, 600)).toBe(600);
  });

  test('zero and negative clamp up to min (never reject)', () => {
    expect(clampDcrTokenTtl(0, 300, 600)).toBe(300);
    expect(clampDcrTokenTtl(-5, 300, 600)).toBe(300);
  });

  test('non-integer request floors before clamping', () => {
    expect(clampDcrTokenTtl(450.9, 300, 600)).toBe(450);
  });

  test('inverted window collapses to min bound', () => {
    expect(clampDcrTokenTtl(500, 600, 300)).toBe(600);
  });

  test('non-positive min is floored to 1', () => {
    expect(clampDcrTokenTtl(0, 0, 600)).toBe(1);
  });

  test('default min is 300s; bounds are otherwise explicit (no permissive default max)', () => {
    expect(DEFAULT_DCR_TTL_MIN_SECONDS).toBe(300);
    expect(clampDcrTokenTtl(1, DEFAULT_DCR_TTL_MIN_SECONDS, 3600)).toBe(300);
    expect(clampDcrTokenTtl(Number.MAX_SAFE_INTEGER, DEFAULT_DCR_TTL_MIN_SECONDS, 3600)).toBe(3600);
  });
});

// ---------------------------------------------------------------------------
// registerClient — persistence + response echo through dcrRegistrationContext
// ---------------------------------------------------------------------------

function makeProvider(bounds?: { min?: number; max?: number }) {
  return new GBrainOAuthProvider({
    sql,
    tokenTtl: 60,
    allowClientCredentialsDcr: true,
    dcrTtlMinSeconds: bounds?.min,
    dcrTtlMaxSeconds: bounds?.max,
  });
}

const DCR_METADATA = {
  client_name: 'dcr-ttl-test',
  redirect_uris: [],
  grant_types: ['client_credentials'],
  scope: 'read',
  token_endpoint_auth_method: 'client_secret_post',
} as any;

function registerWithTtl(provider: GBrainOAuthProvider, tokenTtlSeconds?: number) {
  return dcrRegistrationContext.run({ tokenTtlSeconds }, () =>
    provider.clientsStore.registerClient!({ ...DCR_METADATA }),
  );
}

describe('DCR registration with token_ttl_seconds (#2179)', () => {
  test('in-range request persists and echoes verbatim; /token honors it', async () => {
    const provider = makeProvider({ min: 120, max: 600 });
    const info = await registerWithTtl(provider, 300);
    expect((info as any).token_ttl_seconds).toBe(300);

    const [row] = await sql`SELECT token_ttl FROM oauth_clients WHERE client_id = ${info.client_id}`;
    expect(Number(row.token_ttl)).toBe(300);

    const tokens = await provider.exchangeClientCredentials(info.client_id, info.client_secret!, 'read');
    expect(tokens.expires_in).toBe(300);
  });

  test('below-min request clamps up, is echoed clamped, never rejected', async () => {
    const provider = makeProvider({ min: 120, max: 600 });
    const info = await registerWithTtl(provider, 10);
    expect((info as any).token_ttl_seconds).toBe(120);

    const [row] = await sql`SELECT token_ttl FROM oauth_clients WHERE client_id = ${info.client_id}`;
    expect(Number(row.token_ttl)).toBe(120);
  });

  test('above-max request clamps down, is echoed clamped, never rejected', async () => {
    const provider = makeProvider({ min: 120, max: 600 });
    const info = await registerWithTtl(provider, 86_400);
    expect((info as any).token_ttl_seconds).toBe(600);

    const tokens = await provider.exchangeClientCredentials(info.client_id, info.client_secret!, 'read');
    expect(tokens.expires_in).toBe(600);
  });

  test('absent request → no echo, server default TTL applies', async () => {
    const provider = makeProvider({ min: 120, max: 600 });
    const info = await registerWithTtl(provider, undefined);
    expect((info as any).token_ttl_seconds).toBeUndefined();

    const [row] = await sql`SELECT token_ttl FROM oauth_clients WHERE client_id = ${info.client_id}`;
    expect(row.token_ttl).toBeNull();

    const tokens = await provider.exchangeClientCredentials(info.client_id, info.client_secret!, 'read');
    expect(tokens.expires_in).toBe(60); // provider default
  });

  test('registration outside any DCR context behaves exactly as before', async () => {
    const provider = makeProvider({ min: 120, max: 600 });
    const info = await provider.clientsStore.registerClient!({ ...DCR_METADATA });
    expect((info as any).token_ttl_seconds).toBeUndefined();
    const [row] = await sql`SELECT token_ttl FROM oauth_clients WHERE client_id = ${info.client_id}`;
    expect(row.token_ttl).toBeNull();
  });

  test('unset bounds: min defaults to 300s', async () => {
    const provider = makeProvider();
    const info = await registerWithTtl(provider, 1);
    expect((info as any).token_ttl_seconds).toBe(DEFAULT_DCR_TTL_MIN_SECONDS);
  });

  // #2179 fail-closed pin: with oauth.dcr_ttl_max_seconds UNSET, a DCR
  // registrant can never elect a token that out-lives the operator's own
  // --token-ttl. This is the security property that keeps a default
  // --enable-dcr server from handing anonymous registrants 7-day tokens.
  test('unset max cannot exceed the server --token-ttl (fail-closed)', async () => {
    const provider = new GBrainOAuthProvider({
      sql,
      tokenTtl: 3600,
      allowClientCredentialsDcr: true,
    });
    const info = await registerWithTtl(provider, 7 * 24 * 3600);
    expect((info as any).token_ttl_seconds).toBe(3600);

    const tokens = await provider.exchangeClientCredentials(info.client_id, info.client_secret!, 'read');
    expect(tokens.expires_in).toBe(3600);
  });

  test('explicitly configured max above --token-ttl is honored (admin opt-in)', async () => {
    const provider = new GBrainOAuthProvider({
      sql,
      tokenTtl: 3600,
      allowClientCredentialsDcr: true,
      dcrTtlMaxSeconds: 86_400,
    });
    const info = await registerWithTtl(provider, 999_999);
    expect((info as any).token_ttl_seconds).toBe(86_400);
  });
});

// ---------------------------------------------------------------------------
// issueTokens — per-client token_ttl honored on the authorization_code path
// (DCR clients default to authorization_code, so the override must not be
// client_credentials-only)
// ---------------------------------------------------------------------------

describe('per-client token_ttl across grant paths (#2179)', () => {
  test('authorization_code exchange honors oauth_clients.token_ttl', async () => {
    const provider = makeProvider();
    const { clientId } = await provider.registerClientManual(
      'dcr-ttl-authcode', ['authorization_code'], 'read',
      ['http://localhost:3000/callback'],
    );
    await sql`UPDATE oauth_clients SET token_ttl = ${222} WHERE client_id = ${clientId}`;
    const client = (await provider.clientsStore.getClient(clientId))!;

    let redirectUrl = '';
    const mockRes = { redirect: (url: string) => { redirectUrl = url; } } as any;
    await provider.authorize(client, {
      codeChallenge: 'test-challenge-hash',
      redirectUri: 'http://localhost:3000/callback',
      scopes: ['read'],
      state: 'ttl-state',
    }, mockRes);
    const code = new URL(redirectUrl).searchParams.get('code')!;

    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect(tokens.expires_in).toBe(222);

    // Refresh issuance honors it too.
    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(refreshed.expires_in).toBe(222);
  });
});
