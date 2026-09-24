import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { clientSetup, recoverClientSetup, inspectOAuthClient } from '../src/core/harness/client-setup.ts';
import { writeOAuthClientSetup, type OAuthClientSetup } from '../src/core/harness/oauth-setup.ts';
import { validateCredentials } from '../src/core/harness/credentials.ts';
import { retainCredentialDelivery } from '../src/core/harness/delivery.ts';
import { hashToken } from '../src/core/utils.ts';
import { withEnv } from './helpers/with-env.ts';

test('native setup and secret export follow live method, redaction, journal and mixed-flow policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-oauth-setup-')); const engine = new PGLiteEngine();
  try {
    await engine.connect({}); await engine.initSchema();
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const endpoint = 'https://brain.example/mcp';
      for (const method of ['none', 'client_secret_post', 'client_secret_basic']) {
        const c = await provider.registerClientManual(`setup-${method}`, ['authorization_code', 'refresh_token'], 'read', ['https://client.example/callback'], 'default', undefined, method, undefined, {});
        const inspected = await inspectOAuthClient(engine, c.clientId);
        const ordinary = await clientSetup(engine, c.clientId, endpoint);
        const serialized = JSON.stringify({ inspected, ordinary });
        expect(serialized).not.toContain('client_secret_hash');
        if (c.clientSecret) { expect(serialized).not.toContain(c.clientSecret); expect(serialized).not.toContain(hashToken(c.clientSecret)); }
        expect(ordinary.setup.kind).toBe('oauth-client-setup');
        expect(() => validateCredentials(ordinary.setup)).toThrow();
        if (c.clientSecret) {
          await expect(recoverClientSetup(engine, c.clientId, endpoint)).rejects.toThrow('client_secret_delivery_unavailable');
          retainCredentialDelivery({ version: 1, mcp_url: endpoint, issuer_url: 'https://brain.example', client_id: c.clientId, client_secret: c.clientSecret });
        }
        const recovered = await recoverClientSetup(engine, c.clientId, endpoint);
        expect(recovered.credentials).toBeUndefined();
        expect(recovered.oauthSetup?.client.client_secret).toBe(c.clientSecret);
        const path = join(root, `${method}.json`);
        writeOAuthClientSetup(path, recovered.oauthSetup!);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(path, 'utf8')).kind).toBe('oauth-client-setup');
        expect(() => writeOAuthClientSetup(path, { ...recovered.oauthSetup!, client: { ...recovered.oauthSetup!.client, client_id: 'another-client' } } as OAuthClientSetup)).toThrow('another connection');
        if (c.clientSecret) {
          await engine.executeRaw('UPDATE oauth_clients SET client_secret_hash = $1 WHERE client_id = $2', [hashToken('rotated-example-secret'), c.clientId]);
          await expect(recoverClientSetup(engine, c.clientId, endpoint)).rejects.toThrow('credential_delivery_stale');
        }
      }
      const mixed = await provider.registerClientManual('mixed-example', ['authorization_code', 'refresh_token', 'client_credentials'], 'read', ['https://client.example/callback'], 'default', undefined, 'client_secret_post', undefined, {});
      retainCredentialDelivery({ version: 1, mcp_url: endpoint, issuer_url: 'https://brain.example', client_id: mixed.clientId, client_secret: mixed.clientSecret, access_token: 'gbrain_at_old-token-example' });
      await expect(clientSetup(engine, mixed.clientId, endpoint)).rejects.toThrow('flow_required');
      await expect(recoverClientSetup(engine, mixed.clientId, endpoint)).rejects.toThrow('flow_required');
      const machine = await recoverClientSetup(engine, mixed.clientId, endpoint, 'generic', 'client-credentials');
      expect(machine.credentials?.client_secret).toBe(mixed.clientSecret);
      expect(machine.credentials?.access_token).toBeUndefined();
      expect(machine.oauthSetup).toBeUndefined();
      const native = await recoverClientSetup(engine, mixed.clientId, endpoint, 'generic', 'authorization-code');
      expect(native.oauthSetup?.client.client_secret).toBe(mixed.clientSecret);
      expect(native.credentials).toBeUndefined();
    });
  } finally { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
