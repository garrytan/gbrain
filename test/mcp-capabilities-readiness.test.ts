/**
 * F2 (agent operator contract v1): `gbrain://capabilities` carries readiness
 * and the real worker status on stdio; whoami returns config-plane readiness
 * and the verified stdio scopes; the HTTP view drops host posture and paths.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { stdioCapabilityReadiness } from '../src/mcp/initialize-context.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const whoami = operations.find(o => o.name === 'whoami')!;
const config = { engine: 'pglite', database_path: '/home/someone/.gbrain/brain.pglite' } as unknown as GBrainConfig;
const NO_KEYS = { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined };

function ctx(over: Partial<OperationContext>): OperationContext {
  return { engine: engine as any, config, logger: console as any, dryRun: false, remote: true, sourceId: 'default', ...over };
}

describe('F2 readiness on capabilities and whoami', () => {
  test('stdio capabilities: readiness entries + a probed worker status (no pending jobs)', async () => {
    await withEnv(NO_KEYS, async () => {
      const out = await stdioCapabilityReadiness(engine as any, config);
      expect(out.readiness.some(e => e.capability === 'embeddings')).toBe(true);
      expect(out.readiness.some(e => e.capability === 'worker' && e.tier === 'probed')).toBe(true);
      expect(out.worker).toMatchObject({ status: 'ok', reason: 'no_pending_jobs' });
    });
  });

  test('whoami on stdio: verified scopes (none without a registration) + config-plane readiness', async () => {
    await withEnv(NO_KEYS, async () => {
      const r = await whoami.handler(ctx({ transport: 'stdio' }), {}) as { transport: string; scopes: string[]; readiness: Array<{ capability: string; tier: string }> };
      expect(r.transport).toBe('stdio');
      expect(r.scopes).toEqual([]);
      expect(r.readiness.length).toBeGreaterThan(0);
      expect(r.readiness.every(e => e.tier === 'config')).toBe(true);
    });
  });

  test('whoami over HTTP: the redacted view (no http-invisible entries, no local paths)', async () => {
    await withEnv(NO_KEYS, async () => {
      const auth = { token: 't', clientId: 'legacy-token', clientName: 'legacy-token', scopes: ['read'], principalKind: 'legacy' } as any;
      const r = await whoami.handler(ctx({ transport: 'http' as any, auth }), {}) as { readiness: Array<{ capability: string; http_visible: boolean }> };
      expect(r.readiness.length).toBeGreaterThan(0);
      expect(r.readiness.every(e => e.http_visible)).toBe(true);
      expect(r.readiness.some(e => e.capability === 'writeback')).toBe(false);
      expect(JSON.stringify(r.readiness)).not.toContain('/home/someone');
    });
  });
});
