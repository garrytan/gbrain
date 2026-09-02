/**
 * v0.48.2 — doctor `reranker_health` resolves enablement + model through the
 * mode plane and reports readiness (key present / sunset / skip rows).
 *
 * Stub engine: `getConfig` from a Map (loadSearchModeConfig reads per key);
 * env via withEnv (the check folds `loadConfig()` + process.env). Audit rows
 * land in a fresh GBRAIN_AUDIT_DIR per test.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkRerankerHealth } from '../src/commands/doctor.ts';
import { logRerankFailure } from '../src/core/rerank-audit.ts';
import { DEFAULT_RERANKER_MODEL, LEGACY_DEFAULT_RERANKER_MODEL, NEW_INSTALL_DEFAULT_RERANKER_MODEL, ZEROENTROPY_SUNSET_DATE } from '../src/core/ai/defaults.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

function engineWith(rows: Record<string, string>): any {
  return {
    async getConfig(key: string): Promise<string | null> {
      return rows[key] ?? null;
    },
  };
}

async function inFreshAudit(env: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-doctor-rr-'));
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir, ...env }, body);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Readiness reads the LIVE gateway plane (exactly what rerank() consults). The
// CLI builds that plane from env > file > DB-plane keys, so every scenario is
// modeled by configuring the gateway with the keys the CLI would have folded.
function gw(env: Record<string, string>, extra: Record<string, unknown> = {}): void {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test', ...env }, ...extra });
}
beforeEach(() => resetGateway());
afterAll(() => resetGateway());

describe('reranker_health (v0.48.2 readiness-aware)', () => {
  test('balanced default (no rows), VOYAGE_API_KEY absent → warn naming the key and the disable command', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      gw({});
      const c = await checkRerankerHealth(engineWith({}));
      expect(c.name).toBe('reranker_health');
      expect(c.status).toBe('warn');
      expect(c.message).toContain(DEFAULT_RERANKER_MODEL);
      expect(c.message).toContain('not running');
      expect(c.message).toContain('VOYAGE_API_KEY');
      expect(c.message).toContain('gbrain config set search.reranker.enabled false');
    });
  });

  test('balanced default, key present, no audit rows → ok and says ready', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: 'pa-test' }, async () => {
      gw({ VOYAGE_API_KEY: 'pa-test' });
      const c = await checkRerankerHealth(engineWith({}));
      expect(c.status).toBe('ok');
      expect(c.message).toContain(DEFAULT_RERANKER_MODEL);
      expect(c.message).toContain('ready');
      expect(c.message).toContain('VOYAGE_API_KEY present');
      expect(c.message).toContain('No rerank failures in last 7 days');
    });
  });

  test('reranker disabled by config row → ok "disabled", with an enable hint when the key is present', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: 'pa-test' }, async () => {
      gw({ VOYAGE_API_KEY: 'pa-test' });
      const c = await checkRerankerHealth(engineWith({ 'search.reranker.enabled': 'false' }));
      expect(c.status).toBe('ok');
      expect(c.message).toContain('Reranker disabled');
      expect(c.message).toContain('gbrain config set search.reranker.enabled true');
    });
    await inFreshAudit({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      gw({});
      const c = await checkRerankerHealth(engineWith({ 'search.reranker.enabled': 'false' }));
      expect(c.status).toBe('ok');
      expect(c.message).toContain('Reranker disabled');
      expect(c.message).not.toContain('enabled true');
    });
  });

  test('conservative mode (bundle reranker off) → ok "disabled" even with no rows', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      gw({});
      const c = await checkRerankerHealth(engineWith({ 'search.mode': 'conservative' }));
      expect(c.status).toBe('ok');
      expect(c.message).toContain('Reranker disabled');
    });
  });

  test('key present now but a no_key skip row exists → ok, informational (never outlives the fix as a warn)', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: 'pa-test' }, async () => {
      logRerankFailure({
        model: DEFAULT_RERANKER_MODEL,
        reason: 'no_key',
        query_hash: 'abcd1234',
        doc_count: 25,
        error_summary: 'VOYAGE_API_KEY not set — rerank calls skipped this process',
      });
      gw({ VOYAGE_API_KEY: 'pa-test' });
      const c = await checkRerankerHealth(engineWith({}));
      expect(c.status).toBe('ok');
      expect(c.message).toContain('ready');
      expect(c.message).toContain('skip row');
      expect(c.message).toContain('no_key');
      expect(c.message).toContain('reloads its env');
      expect(c.message).toContain('cache.ttl_seconds');
    });
  });

  test('a VOYAGE key the CLI folded from the DB config plane into the gateway counts as present', async () => {
    // The CLI merges DB-plane provider keys into the gateway env before doctor
    // runs (loadConfigWithEngine → buildGatewayConfig); process.env has no key.
    await inFreshAudit({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      gw({ VOYAGE_API_KEY: 'pa-db-plane' });
      const c = await checkRerankerHealth(engineWith({ voyage_api_key: 'pa-db-plane' }));
      expect(c.status).toBe('ok');
      expect(c.message).toContain('VOYAGE_API_KEY present');
    });
  });

  test('with NO gateway configured, readiness falls back to env > file > DB-plane keys', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const { rerankerReadinessForEngine } = await import('../src/core/ai/reranker-readiness-engine.ts');
      const { _clearGatewayForTests } = await import('../src/core/ai/gateway.ts');
      _clearGatewayForTests();
      const r = await rerankerReadinessForEngine(engineWith({ voyage_api_key: 'pa-db-plane' }) as any, DEFAULT_RERANKER_MODEL);
      expect(r.plane).toBe('config');
      expect(r.readiness.keyPresent).toBe(true);
    });
  });

  test('explicit unknown reranker model → warn with the model fix', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: 'pa-test' }, async () => {
      gw({ VOYAGE_API_KEY: 'pa-test' });
      const c = await checkRerankerHealth(engineWith({ 'search.reranker.model': 'nope:model' }));
      expect(c.status).toBe('warn');
      expect(c.message).toContain('not a known reranker');
    });
  });

  test('auth rows with the key present → the legacy auth warn (key present but rejected)', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: 'pa-test' }, async () => {
      logRerankFailure({
        model: DEFAULT_RERANKER_MODEL,
        reason: 'auth',
        query_hash: 'deadbeef',
        doc_count: 25,
        error_summary: 'rerank HTTP 401',
      });
      gw({ VOYAGE_API_KEY: 'pa-test' });
      const c = await checkRerankerHealth(engineWith({}));
      expect(c.status).toBe('warn');
      expect(c.message).toContain('auth failure');
      expect(c.message).toContain('key present but rejected');
    });
  });

  test('explicit ZE reranker on/after the sunset → warn with the switch command (injected clock)', async () => {
    const AFTER = new Date(Date.parse(`${ZEROENTROPY_SUNSET_DATE}T00:00:00Z`) + 86_400_000);
    const BEFORE = new Date(Date.parse(`${ZEROENTROPY_SUNSET_DATE}T00:00:00Z`) - 1000);
    await inFreshAudit({ ZEROENTROPY_API_KEY: 'zk', VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      gw({ ZEROENTROPY_API_KEY: 'zk' });
      const engine = engineWith({ 'search.reranker.model': LEGACY_DEFAULT_RERANKER_MODEL });
      const after = await checkRerankerHealth(engine, AFTER);
      expect(after.status).toBe('warn');
      expect(after.message).toContain('provider sunset');
      expect(after.message).toContain(`gbrain config set search.reranker.model ${NEW_INSTALL_DEFAULT_RERANKER_MODEL}`);
      const before = await checkRerankerHealth(engine, BEFORE);
      expect(before.status).toBe('ok');
      expect(before.message).toContain('ready');
    });
  });

  test('a provider_base_urls self-host override keeps an explicit ZE reranker ready past the sunset', async () => {
    const AFTER = new Date(Date.parse(`${ZEROENTROPY_SUNSET_DATE}T00:00:00Z`) + 86_400_000);
    await inFreshAudit({ ZEROENTROPY_API_KEY: 'zk', VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      // The gateway carries the base-URL override the CLI folded from config.
      gw({ ZEROENTROPY_API_KEY: 'zk' }, { base_urls: { zeroentropyai: 'http://127.0.0.1:8080/v1' } });
      const c = await checkRerankerHealth(engineWith({ 'search.reranker.model': LEGACY_DEFAULT_RERANKER_MODEL }), AFTER);
      expect(c.status).toBe('ok');
      expect(c.message).toContain('ready');
    });
  });

  test('when the gateway is configured, readiness follows the GATEWAY plane (what rerank() uses)', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: 'pa-in-process-env-only', GBRAIN_HOME: emptyHome() }, async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
      const c = await checkRerankerHealth(engineWith({}));
      expect(c.status).toBe('warn');
      expect(c.message).toContain('not running');
    });
  });

  test('a brain with NO embedding provider never reaches the reranker → ok, nothing to fix', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      configureGateway({ env: {} });
      const c = await checkRerankerHealth(engineWith({}));
      expect(c.status).toBe('ok');
      expect(c.message).toContain('no embedding provider');
      expect(c.message).toContain('keyword-only');
    });
  });

  test('audit rows for a RETIRED model do not warn on the live default (rows are filtered to the resolved model)', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: 'pa-test' }, async () => {
      gw({ VOYAGE_API_KEY: 'pa-test' });
      logRerankFailure({ model: LEGACY_DEFAULT_RERANKER_MODEL, reason: 'auth', query_hash: 'old00001', doc_count: 25, error_summary: 'rerank HTTP 401' });
      logRerankFailure({ model: LEGACY_DEFAULT_RERANKER_MODEL, reason: 'no_key', query_hash: 'old00002', doc_count: 25, error_summary: 'ZEROENTROPY_API_KEY not set' });
      const c = await checkRerankerHealth(engineWith({}));
      expect(c.status).toBe('ok');
      expect(c.message).toContain('No rerank failures in last 7 days');
    });
  });

  test('disabled reranker returns ok before reading the audit (historical rows never warn)', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      gw({});
      logRerankFailure({ model: DEFAULT_RERANKER_MODEL, reason: 'auth', query_hash: 'x1', doc_count: 1, error_summary: 'rerank HTTP 401' });
      const c = await checkRerankerHealth(engineWith({ 'search.reranker.enabled': 'false' }));
      expect(c.status).toBe('ok');
      expect(c.message).toContain('Reranker disabled');
    });
  });
});
