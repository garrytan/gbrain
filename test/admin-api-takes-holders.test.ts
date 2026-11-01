import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { registerScopedClient, type RegisterClientArgs } from '../src/commands/auth.ts';
import { parseAdminGrantRequest, previewNewAdminGrant } from '../src/commands/serve-http-grants.ts';
import { readClientGrant, rescopeClientGrant } from '../src/core/grants/service.ts';

let engine: PGLiteEngine;
let oauth: GBrainOAuthProvider;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const sql = sqlQueryForEngine(engine);
  oauth = new GBrainOAuthProvider({ sql, transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
});

const registrationArgs = (): RegisterClientArgs => ({
  grantTypes: ['client_credentials'], scopes: 'read', sourceId: 'default', federatedRead: undefined,
  redirectUris: [], tokenEndpointAuthMethod: undefined, boundTools: undefined,
  boundSourceId: undefined, boundBrainId: undefined, boundSlugPrefixes: undefined,
  boundMaxConcurrent: undefined, budgetUsdPerDay: undefined, tokenTtlSeconds: undefined,
});

function capture<T>(fn: () => T): { threw: false; value: T } | { threw: true; error: unknown } {
  try { return { threw: false, value: fn() }; }
  catch (error) { return { threw: true, error }; }
}

async function captureAsync<T>(fn: () => Promise<T>): Promise<{ threw: false; value: T } | { threw: true; error: unknown }> {
  try { return { threw: false, value: await fn() }; }
  catch (error) { return { threw: true, error }; }
}

test('owner API grant parsing, registration, and rescoping carry takes-holder limits', async () => {
  const defaults = await registerScopedClient(sqlQueryForEngine(engine), 'owner-api-default-holder-example', registrationArgs());
  expect((await readClientGrant(engine, defaults.clientId)).takesHolders).toBeNull();

  const holders = ['world', 'brain'];
  const request = parseAdminGrantRequest({ takesHolders: holders });
  expect(request.patch.takesHolders).toEqual(holders);

  const invalidShape = capture(() => parseAdminGrantRequest({ takesHolders: ['world', 7] }));
  expect(invalidShape.threw).toBe(true);

  const invalidHolder = await captureAsync(() => previewNewAdminGrant(engine, 'owner-api-invalid-holder-example',
    parseAdminGrantRequest({ takesHolders: ['bad holder'] }).patch,
    { sourceId: 'default', scopes: 'read' }));
  expect(invalidHolder.threw).toBe(true);

  const preview = await previewNewAdminGrant(engine, 'owner-api-holder-example', request.patch,
    { sourceId: 'default', scopes: 'read' });
  expect(preview.takesHolders).toEqual(holders);
  const created = await registerScopedClient(sqlQueryForEngine(engine), 'owner-api-holder-example', registrationArgs(), { grant: request.patch });
  expect((await readClientGrant(engine, created.clientId)).takesHolders).toEqual(holders);

  const token = await oauth.exchangeClientCredentials(created.clientId, created.clientSecret!);
  expect(await oauth.verifyAccessToken(token.access_token)).toMatchObject({ takesHoldersAllowList: holders });

  const before = await readClientGrant(engine, created.clientId);
  const narrowed = parseAdminGrantRequest({ takesHolders: ['world'] }, before);
  const changed = await rescopeClientGrant(engine, created.clientId, narrowed.patch, {
    actor: 'admin-api', expectedRevision: before.revision,
  });
  expect(changed.after.takesHolders).toEqual(['world']);
  expect(await oauth.verifyAccessToken(token.access_token)).toMatchObject({ takesHoldersAllowList: ['world'] });

  const current = await readClientGrant(engine, created.clientId);
  const restored = parseAdminGrantRequest({ takesHolders: null }, current);
  const cleared = await rescopeClientGrant(engine, created.clientId, restored.patch, {
    actor: 'admin-api', expectedRevision: current.revision,
  });
  expect(cleared.after.takesHolders).toBeNull();
  expect(await oauth.verifyAccessToken(token.access_token)).not.toHaveProperty('takesHoldersAllowList');
});
