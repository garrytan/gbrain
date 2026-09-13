import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { provisionHarnessGrant } from '../src/commands/mcp-provision.ts';
import { hashToken } from '../src/core/utils.ts';
import { withEnv } from './helpers/with-env.ts';

test('live client secret gates journal recovery after rotation; resumed credentials renew instead of replaying access tokens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-delivery-recovery-'));
  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite' }); await engine.initSchema();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const input = { name: 'recovery-example', harness: 'muse', url: 'https://brain.example.com/mcp' };
      const created = await provisionHarnessGrant(engine, input, 'test');
      const resumed = await provisionHarnessGrant(engine, { ...input, clientId: created.grant.clientId, resume: true }, 'test');
      expect(resumed.credentials?.client_secret).toBe(created.credentials?.client_secret);
      expect(resumed.credentials?.access_token).toBeUndefined();
      const rotatedHash = hashToken('explicitly-rotated-fixture-secret');
      await engine.executeRaw('UPDATE oauth_clients SET client_secret_hash = $1 WHERE client_id = $2', [rotatedHash, created.grant.clientId]);
      await expect(provisionHarnessGrant(engine, { ...input, clientId: created.grant.clientId, resume: true }, 'test')).rejects.toThrow('credential_delivery_stale');
      expect(await engine.executeRaw('SELECT client_secret_hash FROM oauth_clients WHERE client_id = $1', [created.grant.clientId])).toEqual([{ client_secret_hash: rotatedHash }]);
      expect(await engine.executeRaw('SELECT count(*)::int AS n FROM oauth_clients WHERE client_name = $1', [input.name])).toEqual([{ n: 1 }]);
    });
  } finally { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
