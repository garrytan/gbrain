/**
 * BrainEngine parity — OAuth dynamic client registration (DCR, RFC 7591) and the registration paths beside it.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a client that registers itself (GBrainOAuthProvider's clients store, `POST /register` on
 *    `gbrain serve --http --enable-dcr`) is stored through BrainEngine.insertOauthClient with the same row on every
 *    engine: its name, redirect URIs, grant types, filtered scope, token auth method, the default source, the
 *    `registered_via = 'dcr'` mark, a secret hash only for a confidential client, and the clamped token TTL when the
 *    request asked for one. A remote client then gets a token and calls a tool over HTTP. `gbrain auth register-client`
 *    stores the planned row through the same engine on every arm. Every engine arm returns the same rows (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: DCR wrote its row through the provider's raw `this.sql` statements, which a Rust brain refuses, so no
 *    HTTP client could register on a Rust brain.
 *  - Why existing coverage misses it: test/oauth-dcr-ttl.test.ts and test/oauth-consent-security.test.ts register on
 *    PGLite through a provider with no engine; oauth-clients.test.ts covers the CLI path only.
 *  - Seam: none. Real engines and the real HTTP app on a loopback port. Client ids, secrets and times differ between
 *    arms and are compared by shape.
 */
import { describe, expect } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import type { BrainEngine } from '../../src/core/engine.ts';
import { GBrainOAuthProvider, dcrRegistrationContext } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { hashToken } from '../../src/core/utils.ts';
import { buildServeHttpApp } from '../../src/commands/serve-http.ts';
import { parseRegisterClientArgs, preflightOauthClientColumns, registerScopedClient } from '../../src/commands/auth.ts';
import { OWNER_ONLY_STOP, parityArms, stopOnOwnerOnlyRefusal } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const ID = /^gbrain_cl_[0-9a-f]{64}$/;
const SECRET = /^gbrain_cs_[0-9a-f]{64}$/;

/** The stored row as a caller sees it, with the run-specific id, secret and times by shape. */
async function stored(engine: BrainEngine, clientId: string, secret: string | undefined) {
  const row = await engine.readOauthClient(clientId);
  return row && {
    client_name: row.client_name, redirect_uris: row.redirect_uris, grant_types: row.grant_types, scope: row.scope,
    token_endpoint_auth_method: row.token_endpoint_auth_method, source_id: row.source_id, federated_read: row.federated_read,
    registered_via: row.registered_via, token_ttl: row.token_ttl, grant_revision: row.grant_revision,
    secret: row.client_secret_hash === null ? 'none' : row.client_secret_hash === hashToken(secret ?? '') ? 'matches' : 'differs',
    issuedAt: typeof row.client_id_issued_at === 'number', deleted: row.deleted_at != null,
  };
}

describe('engine parity: OAuth client registration', () => {
  parityTest('dynamic registration stores a public and a confidential client, with the default source, the dcr mark and a clamped token ttl',
    { methods: ['insertOauthClient', 'readOauthClient'] }, async (engine) => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine, allowClientCredentialsDcr: true, tokenTtl: 3600 });
      const store = provider.clientsStore;
      const pub = await store.registerClient!({
        client_name: 'Public example', redirect_uris: ['http://127.0.0.1:7777/callback'], grant_types: ['authorization_code', 'refresh_token'],
        scope: 'read write offline_access', token_endpoint_auth_method: 'none',
      } as never);
      const conf = await dcrRegistrationContext.run({ tokenTtlSeconds: 999_999 }, () => store.registerClient!({
        client_name: 'Machine example', redirect_uris: [], grant_types: ['client_credentials'], scope: 'read',
        token_endpoint_auth_method: 'client_secret_post',
      } as never));
      const view = (r: Record<string, unknown>) => ({ idShape: ID.test(String(r.client_id)), secret: r.client_secret === undefined ? 'none' : SECRET.test(String(r.client_secret)) ? 'shape' : 'bad',
        scope: r.scope, ttl: r.token_ttl_seconds ?? null });
      const out = {
        response: { public: view(pub as never), confidential: view(conf as never) },
        rows: { public: await stored(engine, pub.client_id, undefined), confidential: await stored(engine, conf.client_id, conf.client_secret) },
        read: { public: (await store.getClient(pub.client_id))?.client_name ?? null },
      };
      // Not vacuous: the public client holds no secret, the confidential one holds the hash of the secret it was given,
      // both carry the dcr mark, and the asked ttl is clamped to the server's token ttl.
      expect(out.rows.public?.secret).toBe('none');
      expect(out.rows.confidential?.secret).toBe('matches');
      expect(out.rows.public?.registered_via).toBe('dcr');
      expect(out.rows.confidential?.token_ttl).toBe(3600);
      return out;
    });

  parityTest('gbrain auth register-client, from its argv, stores the planned client on the configured engine',
    { methods: ['readOauthClientColumns', 'readOauthClient', 'transaction'] }, async (engine) => {
      const argv = ['--grant-types', 'client_credentials', '--scopes', 'read write', '--token-ttl', '900'];
      const columns = await preflightOauthClientColumns(engine);
      const registered = await registerScopedClient(sqlQueryForEngine(engine), 'cli-example', parseRegisterClientArgs(argv),
        { columns, engine, transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      const out = { idShape: ID.test(registered.clientId), row: await stored(engine, registered.clientId, registered.clientSecret) };
      expect(out.row?.secret).toBe('matches');
      return out;
    });

  parityTest('serve --http --enable-dcr: a remote client registers, takes a client_credentials token and calls a tool',
    { methods: ['putPage', 'insertOauthClient', 'readOauthClient'], timeout: 120_000,
      // While the Rust store is multi-user the owner-only session gate refuses the client-credentials token (L4 opens it); nothing is read.
      rustMultiuserStop: OWNER_ONLY_STOP() }, async (engine) => {
      await engine.putPage('notes/dcr-example', { type: 'note', title: 'DCR example', compiled_truth: 'A page read after a dynamic registration.', timeline: '' });
      const app = express();
      const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('expected a TCP address');
        const base = `http://127.0.0.1:${address.port}`;
        await buildServeHttpApp(app, engine, { port: address.port, tokenTtl: 3600, enableDcr: true, enableDcrInsecure: true, publicUrl: base });
        const reg = await fetch(`${base}/register`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_name: 'Remote example', grant_types: ['client_credentials'], scope: 'read', token_endpoint_auth_method: 'client_secret_post', redirect_uris: [] }),
        });
        const registered = await reg.json() as Record<string, string>;
        if (reg.status !== 201 && reg.status !== 200) return { register: { status: reg.status, body: registered } };
        const tok = await fetch(`${base}/token`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: registered.client_id!, client_secret: registered.client_secret!, scope: 'read' }),
        });
        const token = await tok.json() as Record<string, unknown>;
        const res = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${String(token.access_token)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page', arguments: { slug: 'notes/dcr-example' } } }),
        });
        const text = await res.text();
        const dataLine = text.split('\n').find(l => l.startsWith('data:'));
        const result = res.status === 200 ? JSON.parse(dataLine ? dataLine.slice('data:'.length) : text).result as { isError?: boolean; content: Array<{ text: string }> } : null;
        const page = result && !result.isError ? JSON.parse(result.content[0]!.text) as Record<string, unknown> : null;
        const out = {
          register: { status: reg.status, idShape: ID.test(registered.client_id ?? ''), row: await stored(engine, registered.client_id!, registered.client_secret) },
          token: { status: tok.status, type: token.token_type ?? null, scope: token.scope ?? null },
          call: { status: res.status, isError: result?.isError ?? null, slug: page?.slug ?? null, title: page?.title ?? null, error: result?.isError ? result.content[0]?.text : null },
        };
        stopOnOwnerOnlyRefusal(out.call.error, ['A page read after a dynamic registration.']);
        // Not vacuous: the registration, the token and the tool call all succeed, on every arm.
        expect(out.call.slug).toBe('notes/dcr-example');
        return out;
      } finally {
        await new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
      }
    });
});
