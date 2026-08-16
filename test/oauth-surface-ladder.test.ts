/**
 * WP4 (amendments 17-19, ENG-9) — oauth_clients.surface threading + the
 * verifyAccessToken degrade ladder's NEW top rung + rescopeClient's surface
 * axis + the amendment-32 audit expectations at the provider layer.
 *
 * OWN PGlite instance (never the shared oauth.test.ts db): these tests DROP
 * OAuth columns to simulate pre-migration brains, which would poison every
 * later test on a shared database.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import type { AuthInfo as CoreAuthInfo } from '../src/core/operations.ts';

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
}, 30_000);

afterAll(async () => {
  if (db) await db.close();
}, 15_000);

async function mintVerifiedClient(name: string): Promise<{ clientId: string; token: string }> {
  const { clientId, clientSecret } = await provider.registerClientManual(
    name, ['client_credentials'], 'read write',
  );
  const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read');
  return { clientId, token: tokens.access_token };
}

describe('verifyAccessToken surface threading (WP4)', () => {
  test('fresh client → surface + surfaceSetBy undefined (column NULL)', async () => {
    const { token } = await mintVerifiedClient('surface-null-client');
    const info = await provider.verifyAccessToken(token) as unknown as CoreAuthInfo;
    expect(info.surface).toBeUndefined();
    expect(info.surfaceSetBy).toBeUndefined();
  });

  test('operator rescope --surface threads surface + surfaceSetBy=operator into AuthInfo', async () => {
    const { clientId, token } = await mintVerifiedClient('surface-rescope-client');
    const result = await provider.rescopeClient(clientId, { surface: 'starter' });
    expect(result.surface).toBe('starter');
    expect(result.surfaceOld).toBe(null);
    const info = await provider.verifyAccessToken(token) as unknown as CoreAuthInfo;
    expect(info.surface).toBe('starter');
    expect(info.surfaceSetBy).toBe('operator');
  });

  test("rescope --surface clear nulls BOTH columns; surfaceOld carries the prior value", async () => {
    const { clientId, token } = await mintVerifiedClient('surface-clear-client');
    await provider.rescopeClient(clientId, { surface: 'verbs' });
    const cleared = await provider.rescopeClient(clientId, { surface: null });
    expect(cleared.surface).toBe(null);
    expect(cleared.surfaceOld).toBe('verbs');
    const info = await provider.verifyAccessToken(token) as unknown as CoreAuthInfo;
    expect(info.surface).toBeUndefined();
    expect(info.surfaceSetBy).toBeUndefined();
  });

  test('rescope rejects an unrecognized surface value loudly', async () => {
    const { clientId } = await mintVerifiedClient('surface-badvalue-client');
    await expect(
      provider.rescopeClient(clientId, { surface: 'everything' as never }),
    ).rejects.toThrow(/--surface must be verbs \| starter \| full \| clear/);
  });

  test('rescope with surface leaves the other axes untouched', async () => {
    const { clientId } = await mintVerifiedClient('surface-axes-client');
    const before = await sql`SELECT source_id, federated_read FROM oauth_clients WHERE client_id = ${clientId}`;
    await provider.rescopeClient(clientId, { surface: 'full' });
    const after = await sql`SELECT source_id, federated_read, surface, surface_set_by FROM oauth_clients WHERE client_id = ${clientId}`;
    expect(after[0].source_id).toEqual(before[0].source_id);
    expect(after[0].federated_read).toEqual(before[0].federated_read);
    expect(after[0].surface).toBe('full');
    expect(after[0].surface_set_by).toBe('operator');
  });
});

describe('degrade ladder: v127 rung (amendment 17 / ENG-9)', () => {
  // Column drops are ordered narrowest-last and NOT restored — each block
  // walks the brain further back in schema history, mirroring how the
  // ladder degrades in production.

  test('pre-v127 brain (surface columns dropped): auth works, surface undefined, fence still threaded', async () => {
    // A bound client proves the v85 fence column survives the v127 rung drop.
    const bound = await provider.registerClientManual(
      'ladder-bound-client', ['client_credentials'], 'read write', [], 'default', undefined, undefined,
      { boundSlugPrefixes: ['chan-eng/'] },
    );
    const boundTokens = await provider.exchangeClientCredentials(bound.clientId, bound.clientSecret!, 'read write');

    await db.exec(`
      ALTER TABLE oauth_clients DROP COLUMN IF EXISTS surface;
      ALTER TABLE oauth_clients DROP COLUMN IF EXISTS surface_set_by;
    `);

    const info = await provider.verifyAccessToken(boundTokens.access_token) as unknown as CoreAuthInfo;
    expect(info.clientId).toBe(bound.clientId);
    expect(info.surface).toBeUndefined();
    expect(info.surfaceSetBy).toBeUndefined();
    // The v85 rung's payload is intact — the new top rung dropped ONLY the
    // surface columns.
    expect(info.boundSlugPrefixes).toEqual(['chan-eng/']);
    expect(info.fenceProjectionDegraded).toBeUndefined();
  });

  test('pre-v127 brain: rescope --surface reports the migration gap, other axes still work', async () => {
    const { clientId } = await mintVerifiedClient('ladder-rescope-client');
    await expect(
      provider.rescopeClient(clientId, { surface: 'starter' }),
    ).rejects.toThrow(/up-to-date OAuth schema/);
    // Axes that predate v127 keep working on the same brain.
    const ok = await provider.rescopeClient(clientId, { sourceId: 'default' });
    expect(ok.clientId).toBe(clientId);
    expect(ok.surface).toBeUndefined();
  });

  test('pre-v85 brain (fence column also dropped): auth still works, fence fails closed', async () => {
    const { clientId, token } = await mintVerifiedClient('ladder-prev85-client');
    await db.exec(`ALTER TABLE oauth_clients DROP COLUMN IF EXISTS bound_slug_prefixes;`);
    const info = await provider.verifyAccessToken(token) as unknown as CoreAuthInfo;
    expect(info.clientId).toBe(clientId);
    expect(info.surface).toBeUndefined();
    expect(info.boundSlugPrefixes).toBeUndefined();
    // The fence axis (v85) keeps its own fail-closed degrade marker.
    expect(info.fenceProjectionDegraded).toBe(true);
  });

  test('pre-v61 brain (federated_read also dropped): auth still works, scalar grant synthesized', async () => {
    const { clientId, token } = await mintVerifiedClient('ladder-prev61-client');
    await db.exec(`ALTER TABLE oauth_clients DROP COLUMN IF EXISTS federated_read;`);
    const info = await provider.verifyAccessToken(token) as unknown as CoreAuthInfo;
    expect(info.clientId).toBe(clientId);
    expect(info.sourceId).toBe('default');
    expect(info.allowedSources).toEqual(['default']);
  });

  test('pre-v60 brain (source_id also dropped): the narrowest projection still authenticates', async () => {
    const { clientId, token } = await mintVerifiedClient('ladder-prev60-client');
    await db.exec(`ALTER TABLE oauth_clients DROP COLUMN IF EXISTS source_id;`);
    const info = await provider.verifyAccessToken(token) as unknown as CoreAuthInfo;
    expect(info.clientId).toBe(clientId);
    expect(info.sourceId).toBeUndefined();
    expect(info.surface).toBeUndefined();
  });
});
