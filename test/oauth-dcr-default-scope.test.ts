/**
 * A DCR registration with no `scope` field (ChatGPT's custom
 * connector does this) must land with the operator default, not '' — an
 * empty registered scope makes every later tools/list empty.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

let engine: PGLiteEngine;
let sql: ReturnType<typeof sqlQueryForEngine>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sql = sqlQueryForEngine(engine);
});
afterAll(async () => { await engine.disconnect(); });

const NO_SCOPE = {
  client_name: 'ChatGPT',
  redirect_uris: ['https://chatgpt.com/connector/oauth/x'],
  grant_types: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_method: 'none',
} as any;

describe('DCR default scope', () => {
  test('scope-less registration gets read by default', async () => {
    const p = new GBrainOAuthProvider({ sql, tokenTtl: 60 });
    const info = await p.clientsStore.registerClient!({ ...NO_SCOPE });
    expect(info.scope).toBe('read');
  });
  test('operator default applies', async () => {
    const p = new GBrainOAuthProvider({ sql, tokenTtl: 60, dcrDefaultScope: ['read', 'write'] });
    const info = await p.clientsStore.registerClient!({ ...NO_SCOPE });
    expect(info.scope).toBe('read write');
  });
  test('operator default cannot exceed the client_credentials read-only ceiling', async () => {
    const p = new GBrainOAuthProvider({
      sql,
      tokenTtl: 60,
      allowClientCredentialsDcr: true,
      dcrDefaultScope: ['read', 'write'],
    });
    await expect(p.clientsStore.registerClient!({
      client_name: 'machine-client',
      redirect_uris: [],
      grant_types: ['client_credentials'],
      token_endpoint_auth_method: 'client_secret_post',
    } as any)).rejects.toThrow('client_credentials registration is limited to `read`');
  });
  test('operator default cannot grant agent through DCR', async () => {
    const p = new GBrainOAuthProvider({ sql, tokenTtl: 60, dcrDefaultScope: ['agent'] });
    await expect(p.clientsStore.registerClient!({ ...NO_SCOPE }))
      .rejects.toThrow('agent scope requires an operator-approved grant');
  });
  test('explicit scope still wins over the default', async () => {
    const p = new GBrainOAuthProvider({ sql, tokenTtl: 60, dcrDefaultScope: ['agent'] });
    const info = await p.clientsStore.registerClient!({ ...NO_SCOPE, scope: 'read' });
    expect(info.scope).toBe('read');
  });
});
