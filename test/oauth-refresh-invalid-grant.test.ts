// #4532 — exchangeRefreshToken failures must be InvalidGrantError, not bare
// Error.
//
// The MCP SDK's token handler maps OAuthError subclasses to their RFC 6749
// wire shape (HTTP 400 + {"error":"invalid_grant"}) and any non-OAuthError to
// a 500 Internal Server Error. Pre-fix, a refresh with a rotated or expired
// token (a routine client condition — RFC 6749 §5.2 invalid_grant) threw bare
// Error and surfaced as a 500, so well-behaved MCP clients treated it as a
// server outage instead of re-running the authorization flow.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { InvalidGrantError, ServerError, OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

let db: PGlite;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;
let provider: GBrainOAuthProvider;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows;
  };
  provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
}, 120_000);

afterAll(async () => {
  if (db) await db.close();
}, 15_000);

async function mintTokens() {
  const { clientId } = await provider.registerClientManual(
    'invalid-grant-test', ['authorization_code'], 'read write',
    ['http://localhost:3000/callback'],
  );
  const client = (await provider.clientsStore.getClient(clientId))!;
  let redirectUrl = '';
  const mockRes = { redirect: (url: string) => { redirectUrl = url; } } as any;
  await provider.authorize(client, {
    codeChallenge: 'challenge',
    redirectUri: 'http://localhost:3000/callback',
    scopes: ['read', 'write'],
  }, mockRes);
  const code = new URL(redirectUrl).searchParams.get('code')!;
  const tokens = await provider.exchangeAuthorizationCode(client, code);
  return { client, tokens };
}

describe('exchangeRefreshToken error typing (#4532)', () => {
  test('unknown/rotated refresh token throws InvalidGrantError (400 invalid_grant on the wire)', async () => {
    const { client } = await mintTokens();
    let caught: unknown;
    try {
      await provider.exchangeRefreshToken(client, 'gbr_definitely-not-a-real-token');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidGrantError);
    // The SDK token handler's mapping: OAuthError-but-not-ServerError → 400.
    expect(caught).toBeInstanceOf(OAuthError);
    expect(caught).not.toBeInstanceOf(ServerError);
    expect((caught as InvalidGrantError).toResponseObject().error).toBe('invalid_grant');
  });

  test('expired refresh token throws InvalidGrantError', async () => {
    const { client, tokens } = await mintTokens();
    // Age the refresh row past expiry (fail-closed NULL also counts, but the
    // routine path is a real timestamp in the past).
    await db.query(
      `UPDATE oauth_tokens SET expires_at = 1 WHERE token_type = 'refresh' AND client_id = $1`,
      [client.client_id],
    );
    let caught: unknown;
    try {
      await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidGrantError);
    expect((caught as InvalidGrantError).toResponseObject().error).toBe('invalid_grant');
  });
});
