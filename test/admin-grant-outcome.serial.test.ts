import { expect, test } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { mountAdminGrantDiscovery, mountAdminGrantEdits } from '../src/commands/serve-http-grants.ts';
import { mountAdminRegistration } from '../src/commands/serve-http-registration.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { readClientGrant } from '../src/core/grants/service.ts';
import { provisionHarnessGrant } from '../src/commands/mcp-provision.ts';
import { recoverClientSetup } from '../src/core/harness/client-setup.ts';
import { withEnv } from './helpers/with-env.ts';

test('committed grant with lost acknowledgement reports unknown and recovers the original registration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-admin-outcome-'));
  const engine = new PGLiteEngine();
  try {
    await engine.connect({}); await engine.initSchema();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const uncertain = new Proxy(engine, { get(target, key) {
        if (key === 'transaction') return async (fn: Parameters<BrainEngine['transaction']>[0]) => {
          await target.transaction(fn); throw new Error('synthetic commit acknowledgement lost');
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const app = express();
      mountAdminGrantDiscovery(app, (_req, _res, next) => next(), uncertain, 'https://brain.example/mcp');
      const server = app.listen(0, '127.0.0.1');
      try {
        const { port } = server.address() as { port: number };
        const response = await fetch(`http://127.0.0.1:${port}/admin/api/grants`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'uncertain-example', harness: 'generic', url: 'https://brain.example/mcp', profile: 'memory-reader' }) });
        expect(response.status).toBe(503);
        const receipt = await response.json() as any;
        expect(receipt.outcome).toBe('unknown'); expect(receipt.stage).toBe('grant');
        expect(receipt.next_action).toContain('inspect');
        expect(JSON.stringify(receipt)).not.toContain('synthetic commit');
        const rows = await engine.executeRaw<{ client_id: string }>("SELECT client_id FROM oauth_clients WHERE client_name='uncertain-example'");
        expect(rows).toHaveLength(1);
        const recovered = await recoverClientSetup(engine, rows[0].client_id, 'https://brain.example/mcp');
        expect(recovered.credentials?.client_id).toBe(rows[0].client_id);
        expect(recovered.credentials?.client_secret).toStartWith('gbrain_cs_');
      } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    });
  } finally { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test('native registration distinguishes refused input and preflight failure from a lost commit acknowledgement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-register-outcome-'));
  const engine = new PGLiteEngine();
  try {
    await engine.connect({}); await engine.initSchema();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      let transactions = 0;
      let failPreflight = false;
      const uncertain = new Proxy(engine, { get(target, key) {
        if (key === 'transaction') return async (fn: Parameters<BrainEngine['transaction']>[0]) => {
          transactions++;
          await target.transaction(fn); throw new Error('synthetic private database acknowledgement lost');
        };
        if (key === 'executeRaw') return (...args: Parameters<BrainEngine['executeRaw']>) => {
          if (failPreflight) throw new Error('synthetic private database preflight failure');
          return target.executeRaw(...args);
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const app = express();
      mountAdminRegistration(app, (_req, _res, next) => next(), uncertain, new URL('https://brain.example/mcp'), new URL('https://brain.example'));
      const server = app.listen(0, '127.0.0.1');
      try {
        const { port } = server.address() as { port: number };
        const post = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/admin/api/register-client`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const registration = { name: 'native-uncertain-example', harness: 'generic', tokenEndpointAuthMethod: 'client_secret_post', grantTypes: ['authorization_code', 'refresh_token'], redirectUris: ['https://client.example/callback'] };
        const invalid = await post({ ...registration, harness: 'unknown-example' });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ code: 'invalid_grant', stage: 'register', outcome: 'failed' });
        expect(transactions).toBe(0);
        failPreflight = true;
        const preflight = await post(registration);
        expect(preflight.status).toBe(503);
        const preflightReceipt = await preflight.json() as any;
        expect(preflightReceipt).toMatchObject({ code: 'administration_unavailable', stage: 'register', outcome: 'failed' });
        expect(JSON.stringify(preflightReceipt)).not.toContain('synthetic private');
        expect(transactions).toBe(0);
        failPreflight = false;
        const response = await post(registration);
        expect(response.status).toBe(503);
        const receipt = await response.json() as any;
        expect(receipt).toMatchObject({ code: 'administration_unavailable', stage: 'register', outcome: 'unknown' });
        expect(receipt.next_action).toContain('inspect existing registrations');
        expect(JSON.stringify(receipt)).not.toContain('synthetic private');
        expect(transactions).toBe(1);
        const rows = await engine.executeRaw<{ client_id: string }>("SELECT client_id FROM oauth_clients WHERE client_name='native-uncertain-example'");
        expect(rows).toHaveLength(1);
        const recovered = await recoverClientSetup(engine, rows[0].client_id, 'https://brain.example/mcp');
        expect(recovered.oauthSetup?.client.client_id).toBe(rows[0].client_id);
        expect(recovered.oauthSetup?.client.client_secret).toStartWith('gbrain_cs_');
      } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    });
  } finally { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test('permission edits report unknown after lost commit acknowledgement and preserve refused preview revisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-rescope-outcome-'));
  const engine = new PGLiteEngine();
  try {
    await engine.connect({}); await engine.initSchema();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const created = await provisionHarnessGrant(engine, { name: 'rescope-uncertain-example', harness: 'generic', url: 'https://brain.example/mcp', profile: 'memory-reader' }, 'test');
      const clientId = created.grant.clientId;
      const uncertain = new Proxy(engine, { get(target, key) {
        if (key === 'transaction') return async (fn: Parameters<BrainEngine['transaction']>[0]) => {
          await target.transaction(fn); throw new Error('synthetic column "private_operational_detail" does not exist');
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });
      const app = express();
      mountAdminGrantEdits(app, (_req, _res, next) => next(), uncertain, provider);
      const server = app.listen(0, '127.0.0.1');
      try {
        const { port } = server.address() as { port: number };
        const post = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/admin/api/rescope-client`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, ...body }) });
        const change = { surface: 'full', expectedRevision: created.grant.revision };
        const preview = await post({ ...change, dryRun: true });
        expect(preview.status).toBe(503);
        const previewReceipt = await preview.json() as any;
        expect(previewReceipt).toMatchObject({ stage: 'rescope', outcome: 'failed', client_id: clientId });
        expect(JSON.stringify(previewReceipt)).not.toContain('private_operational_detail');
        expect((await readClientGrant(engine, clientId)).revision).toBe(created.grant.revision);
        const response = await post(change);
        expect(response.status).toBe(503);
        const receipt = await response.json() as any;
        expect(receipt).toMatchObject({ code: 'administration_unavailable', stage: 'rescope', outcome: 'unknown', client_id: clientId });
        expect(receipt.next_action).toContain('reload its current grant');
        expect(JSON.stringify(receipt)).not.toContain('private_operational_detail');
        const current = await readClientGrant(engine, clientId);
        expect(current.surface).toBe('full');
        expect(current.revision).toBe(created.grant.revision + 1);
        const stale = await post({ ...change, surface: 'verbs', dryRun: true });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({ code: 'grant_conflict', stage: 'rescope', outcome: 'failed' });
        expect((await readClientGrant(engine, clientId)).surface).toBe('full');
        const legacy = await post({ federatedRead: [] });
        expect(legacy.status).toBe(400);
        expect(await legacy.json()).toMatchObject({ code: 'invalid_grant', stage: 'rescope', outcome: 'failed' });
      } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    });
  } finally { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
