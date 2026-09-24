import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { clientSetup, inspectOAuthClient, recoverClientSetup } from '../src/core/harness/client-setup.ts';
import { retainCredentialDelivery } from '../src/core/harness/delivery.ts';
import { mountAdminClients } from '../src/commands/serve-http-clients.ts';
import { hashToken } from '../src/core/utils.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine?.disconnect(); });

test('post-lock credential lookup outages remain retryable instead of suggesting secret rotation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-recovery-error-'));
  try {
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const endpoint = 'https://brain.example/mcp';
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });
      const client = await provider.registerClientManual('recovery-error-example',
        ['authorization_code', 'refresh_token'], 'read', ['https://client.example/callback'],
        'default', undefined, 'client_secret_post', undefined, {});
      retainCredentialDelivery({ version: 1, mcp_url: endpoint, issuer_url: 'https://brain.example',
        client_id: client.clientId, client_secret: client.clientSecret });

      const transient = Object.assign(new Error('fixture database connection reset'), { code: 'ECONNRESET' });
      let lockedReads = 0;
      let failedSecretReads = 0;
      const failing = new Proxy(engine, {
        get(target, property) {
          if (property === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(new Proxy(tx, {
            get(transaction, key) {
              if (key === 'executeRaw') return async (query: string, params: unknown[]) => {
                if (/FROM oauth_clients.*FOR UPDATE/s.test(query)) lockedReads++;
                if (/SELECT\s+client_id,\s*client_secret_hash/.test(query)) {
                  failedSecretReads++;
                  throw transient;
                }
                return transaction.executeRaw(query, params);
              };
              const value = Reflect.get(transaction, key, transaction);
              return typeof value === 'function' ? value.bind(transaction) : value;
            },
          })));
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await expect(recoverClientSetup(failing, client.clientId, endpoint)).rejects.toBe(transient);
      expect(lockedReads).toBe(1);
      expect(failedSecretReads).toBe(1);

      const app = express();
      mountAdminClients(app, (_req, _res, next) => next(), failing, endpoint);
      const server = app.listen(0, '127.0.0.1');
      try {
        const address = server.address() as { port: number };
        const response = await fetch(`http://127.0.0.1:${address.port}/admin/api/recover-client`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: client.clientId }),
        });
        expect(response.status).toBe(503);
        const result = await response.json();
        expect(result).toMatchObject({ code: 'administration_unavailable', stage: 'export' });
        expect(JSON.stringify(result)).not.toContain('credential_delivery_stale');
        expect(JSON.stringify(result)).not.toContain(transient.message);
      } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }

      const recovered = await recoverClientSetup(engine, client.clientId, endpoint);
      expect(recovered.oauthSetup?.client.client_secret).toBe(client.clientSecret);
      const expiredAt = Math.floor(Date.now() / 1000) - 60;
      await engine.executeRaw('UPDATE oauth_clients SET client_secret_expires_at = $1 WHERE client_id = $2',
        [expiredAt, client.clientId]);
      expect((await inspectOAuthClient(engine, client.clientId)).client.client_secret_expires_at).toBe(expiredAt);
      await expect(clientSetup(engine, client.clientId, endpoint)).rejects.toThrow('Client secret expired');
      await expect(recoverClientSetup(engine, client.clientId, endpoint)).rejects.toThrow('Client secret expired');
      await engine.executeRaw('UPDATE oauth_clients SET client_secret_hash = $1, client_secret_expires_at = NULL WHERE client_id = $2',
        [hashToken('rotated-example-secret'), client.clientId]);
      await expect(recoverClientSetup(engine, client.clientId, endpoint)).rejects.toThrow('credential_delivery_stale');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
