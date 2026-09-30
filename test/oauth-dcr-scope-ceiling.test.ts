/**
 * DCR scope ceiling — anonymous Dynamic Client Registration (RFC 7591) may
 * register at most `read write`; a `client_credentials` registration (only
 * reachable under --enable-dcr-insecure, where no owner approval happens)
 * is capped at `read`. Privileged scopes are REJECTED with
 * invalid_client_metadata (HTTP 400), never silently dropped, so a client
 * that asked for more learns why and gets pointed at the operator path.
 *
 * Operator-trusted registration (`registerClientManual`, the CLI, the admin
 * API) is unaffected and still accepts every canonical scope.
 *
 * Setup mirrors test/oauth-dcr-ttl.test.ts (in-memory PGLite).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { DCR_REGISTRABLE_SCOPES, dcrScopeViolation } from '../src/core/scope.ts';
import { pgliteOAuthTransaction } from './helpers/oauth.ts';

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

function makeProvider(opts: { allowClientCredentialsDcr?: boolean } = {}) {
  return new GBrainOAuthProvider({
    transaction: pgliteOAuthTransaction(db), sql,
    tokenTtl: 60,
    ...opts,
  });
}

/** authorization_code public client — the shape a browser MCP connector sends. */
function authCodeMetadata(scope: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    client_name: 'dcr-ceiling-test',
    redirect_uris: ['https://client.example/cb'],
    grant_types: ['authorization_code'],
    token_endpoint_auth_method: 'none',
    ...(scope === undefined ? {} : { scope }),
    ...extra,
  } as any;
}

/** client_credentials confidential client — only registrable under --enable-dcr-insecure. */
function machineMetadata(scope: string) {
  return {
    client_name: 'dcr-ceiling-m2m',
    redirect_uris: [],
    grant_types: ['client_credentials'],
    token_endpoint_auth_method: 'client_secret_post',
    scope,
  } as any;
}

// registerClient is typed `T | Promise<T>` by the SDK store interface.
async function expectRejected(pending: unknown, naming: RegExp): Promise<InvalidClientMetadataError> {
  try {
    await pending;
  } catch (e) {
    // The MCP SDK maps InvalidClientMetadataError to HTTP 400
    // invalid_client_metadata; a plain Error would surface as an opaque 500.
    expect(e).toBeInstanceOf(InvalidClientMetadataError);
    expect((e as Error).message).toMatch(naming);
    return e as InvalidClientMetadataError;
  }
  throw new Error('expected registration to be rejected');
}

describe('dcrScopeViolation (pure policy)', () => {
  test('ceiling constant is exactly read + write', () => {
    expect([...DCR_REGISTRABLE_SCOPES].sort()).toEqual(['read', 'write']);
  });

  test('read / write / empty under authorization_code → ok', () => {
    expect(dcrScopeViolation(['read'], ['authorization_code'])).toBeNull();
    expect(dcrScopeViolation(['read', 'write'], ['authorization_code'])).toBeNull();
    expect(dcrScopeViolation([], ['authorization_code'])).toBeNull();
  });

  test('unknown scopes are not the ceiling check\'s business (filter handles them)', () => {
    expect(dcrScopeViolation(['read', 'offline_access', 'openid'], ['authorization_code'])).toBeNull();
  });

  test('each privileged scope violates and is named', () => {
    for (const s of ['admin', 'sources_admin', 'users_admin']) {
      const v = dcrScopeViolation(['read', s], ['authorization_code']);
      expect(v).not.toBeNull();
      expect(v!).toContain(s);
      expect(v!).toMatch(/rescope-client|register-client/);
    }
  });

  test('agent keeps its specific operator-approved wording', () => {
    expect(dcrScopeViolation(['read', 'agent'], ['authorization_code'])).toMatch(/operator-approved/);
  });

  test('client_credentials ceiling is read only — write violates', () => {
    expect(dcrScopeViolation(['read'], ['client_credentials'])).toBeNull();
    const v = dcrScopeViolation(['read', 'write'], ['client_credentials']);
    expect(v).not.toBeNull();
    expect(v!).toContain('write');
    // Mixed grant lists take the stricter ceiling.
    expect(dcrScopeViolation(['write'], ['authorization_code', 'client_credentials'])).not.toBeNull();
  });
});

describe('registerClient (DCR) enforces the scope ceiling', () => {
  test.each([
    ['admin', /admin/],
    ['sources_admin', /sources_admin/],
    ['users_admin', /users_admin/],
    ['read admin', /admin/],
    ['write users_admin', /users_admin/],
  ])('scope "%s" → 400 invalid_client_metadata naming the scope', async (scope, naming) => {
    const provider = makeProvider();
    await expectRejected(provider.clientsStore.registerClient!(authCodeMetadata(scope)), naming);
    const rows = await sql`SELECT client_id FROM oauth_clients WHERE client_name = 'dcr-ceiling-test'`;
    expect(rows.length).toBe(0);
  });

  test('rejection names the operator remedy (register-client / rescope-client)', async () => {
    const provider = makeProvider();
    const err = await expectRejected(provider.clientsStore.registerClient!(authCodeMetadata('admin')), /admin/);
    expect(err.message).toMatch(/rescope-client/);
    expect(err.message).toMatch(/register-client|admin API/);
  });

  test('"read write" → stored verbatim', async () => {
    const provider = makeProvider();
    const info = await provider.clientsStore.registerClient!(authCodeMetadata('read write'));
    expect(info.scope).toBe('read write');
    const stored = await provider.clientsStore.getClient(info.client_id);
    expect(stored!.scope).toBe('read write');
  });

  test('"read offline_access" → "read" (unknown-scope filter unchanged)', async () => {
    const provider = makeProvider();
    const info = await provider.clientsStore.registerClient!(authCodeMetadata('read offline_access'));
    expect(info.scope).toBe('read');
  });

  test('scope omitted → "" (documented zero-scope shape; rescope later)', async () => {
    const provider = makeProvider();
    const info = await provider.clientsStore.registerClient!(authCodeMetadata(undefined));
    expect(info.scope ?? '').toBe('');
    const stored = await provider.clientsStore.getClient(info.client_id);
    expect(stored!.scope ?? '').toBe('');
  });

  test('grant_types omitted still defaults to authorization_code and gets the read write ceiling', async () => {
    const provider = makeProvider();
    const md = authCodeMetadata('read write');
    delete md.grant_types;
    const info = await provider.clientsStore.registerClient!(md);
    expect(info.scope).toBe('read write');
    const stored = await provider.clientsStore.getClient(info.client_id);
    expect(stored!.grant_types).toEqual(['authorization_code']);
    // and the privileged request is still rejected when grant_types is omitted
    const bad = authCodeMetadata('admin');
    delete bad.grant_types;
    await expectRejected(provider.clientsStore.registerClient!(bad), /admin/);
  });

  test('agent scope keeps the specific operator-approved wording', async () => {
    const provider = makeProvider();
    await expectRejected(provider.clientsStore.registerClient!(authCodeMetadata('read agent')), /operator-approved/);
  });
});

describe('registerClient (DCR) under --enable-dcr-insecure: client_credentials is read-only', () => {
  test('client_credentials + "read write" → rejected naming write', async () => {
    const provider = makeProvider({ allowClientCredentialsDcr: true });
    await expectRejected(provider.clientsStore.registerClient!(machineMetadata('read write')), /write/);
  });

  test('client_credentials + "read" → stored and usable', async () => {
    const provider = makeProvider({ allowClientCredentialsDcr: true });
    const info = await provider.clientsStore.registerClient!(machineMetadata('read'));
    expect(info.scope).toBe('read');
    const tokens = await provider.exchangeClientCredentials(info.client_id, info.client_secret!, 'read');
    expect(tokens.scope).toBe('read');
  });

  test('client_credentials + "admin" → rejected naming admin', async () => {
    const provider = makeProvider({ allowClientCredentialsDcr: true });
    await expectRejected(provider.clientsStore.registerClient!(machineMetadata('admin')), /admin/);
  });
});

describe('registerClient (DCR) WITHOUT --enable-dcr-insecure: the grant gate answers before the ceiling', () => {
  // A client_credentials request is not available at all here, so the reply
  // must say so — not "limited to read because issued without owner
  // approval", which implies the grant is on offer at a narrower scope.
  test('client_credentials + "read write" → the not-permitted message, never the machine ceiling', async () => {
    const provider = makeProvider();
    const before = (await sql`SELECT client_id FROM oauth_clients WHERE client_name = 'dcr-ceiling-m2m'`).length;
    const err = await expectRejected(
      provider.clientsStore.registerClient!(machineMetadata('read write')),
      /not permitted via dynamic client registration/,
    );
    expect(err.message).toMatch(/--enable-dcr-insecure/);
    expect(err.message).not.toMatch(/limited to/);
    const after = (await sql`SELECT client_id FROM oauth_clients WHERE client_name = 'dcr-ceiling-m2m'`).length;
    expect(after).toBe(before); // nothing stored
  });

  test('client_credentials + "read" (inside the machine ceiling) is still refused for the same reason', async () => {
    const provider = makeProvider();
    await expectRejected(
      provider.clientsStore.registerClient!(machineMetadata('read')),
      /not permitted via dynamic client registration/,
    );
  });
});

describe('operator-trusted registration is unaffected', () => {
  test('registerClientManual still accepts admin', async () => {
    const provider = makeProvider();
    const { clientId } = await provider.registerClientManual('operator-admin', ['client_credentials'], 'admin');
    const stored = await provider.clientsStore.getClient(clientId);
    expect(stored!.scope).toBe('admin');
  });

  test('registerClientManual still accepts client_credentials + read write', async () => {
    const provider = makeProvider();
    const { clientId } = await provider.registerClientManual('operator-m2m', ['client_credentials'], 'read write');
    const stored = await provider.clientsStore.getClient(clientId);
    expect(stored!.scope).toBe('read write');
  });
});
