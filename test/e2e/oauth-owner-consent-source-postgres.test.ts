/**
 * #6202 Postgres arm of the first-consent source choice (the PGLite matrix is
 * in test/oauth-owner-consent.test.ts): a chosen source and the consent audit
 * commit with the code in one locked transaction, an unchanged approval still
 * consumes eligibility, and a source archived after review fails closed.
 *
 * Gated by DATABASE_URL; skips without a real Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { TEST_PKCE_CHALLENGE } from '../helpers/oauth.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePg = hasDatabase() ? describe : describe.skip;
const REDIRECT = 'https://dcr-client.example.com/callback';

describePg('first-consent source choice on Postgres (#6202)', () => {
  let engine: BrainEngine;
  let provider: GBrainOAuthProvider;

  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw(`DELETE FROM oauth_clients WHERE client_name = 'pg-consent-example'`);
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('wiki-6202', 'wiki-6202'), ('gone-6202', 'gone-6202') ON CONFLICT (id) DO UPDATE SET archived = false`);
    provider = new GBrainOAuthProvider({
      sql: sqlQueryForEngine(engine),
      transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))),
    });
  }, 60_000);
  afterAll(async () => {
    // setupDB's fixture reset deletes sources; clients pointing at ours would block it.
    await engine.executeRaw(`DELETE FROM oauth_clients WHERE client_name = 'pg-consent-example'`);
    await teardownDB();
  }, 15_000);

  const registerDcr = async () => (await provider.clientsStore.registerClient!({
    client_name: 'pg-consent-example', redirect_uris: [REDIRECT], grant_types: ['authorization_code'], scope: 'read write', token_endpoint_auth_method: 'none',
  } as never)).client_id;
  const beginFor = (clientId: string) => provider.grants.begin(clientId, { codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: REDIRECT, scopes: ['read'] });
  const row = async (clientId: string) => (await engine.executeRaw<Record<string, unknown>>(
    'SELECT source_id, federated_read, grant_revision, registered_via FROM oauth_clients WHERE client_id = $1', [clientId]))[0]!;
  const consentAudits = (clientId: string) => engine.executeRaw(`SELECT 1 FROM oauth_grant_audit WHERE client_id = $1 AND action = 'consent' AND actor = 'owner'`, [clientId]);
  const codes = (clientId: string) => engine.executeRaw('SELECT 1 FROM oauth_codes WHERE client_id = $1', [clientId]);

  test('a chosen source, its consent audit and the code commit together', async () => {
    const clientId = await registerDcr();
    expect((await row(clientId)).registered_via).toBe('dcr');
    const id = await beginFor(clientId);
    expect(provider.grants.details(id).sourceChoice.options.map(o => o.id)).toContain('wiki-6202');
    await provider.grants.decide(id, true, { sourceId: 'wiki-6202' });
    expect(await row(clientId)).toMatchObject({ source_id: 'wiki-6202', federated_read: ['wiki-6202'], grant_revision: 1 });
    expect(await consentAudits(clientId)).toHaveLength(1);
    expect(await codes(clientId)).toHaveLength(1);
  });

  test('an unchanged approval consumes eligibility and a second pending request fails', async () => {
    const clientId = await registerDcr();
    const first = await beginFor(clientId);
    const second = await beginFor(clientId);
    await provider.grants.decide(first, true);
    expect(await row(clientId)).toMatchObject({ source_id: 'default', grant_revision: 1 });
    await expect(provider.grants.decide(second, true)).rejects.toMatchObject({ status: 409 });
    expect(provider.grants.details(await beginFor(clientId)).sourceChoice.editable).toBe(false);
    expect(await codes(clientId)).toHaveLength(1);
  });

  test('a source archived after review fails 409 with nothing committed', async () => {
    const clientId = await registerDcr();
    const id = await beginFor(clientId);
    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'gone-6202'`);
    await expect(provider.grants.decide(id, true, { sourceId: 'gone-6202' })).rejects.toMatchObject({ status: 409, code: 'client_policy_changed' });
    expect(await row(clientId)).toMatchObject({ source_id: 'default', grant_revision: 0 });
    expect(await consentAudits(clientId)).toHaveLength(0);
    expect(await codes(clientId)).toHaveLength(0);
  });
});
