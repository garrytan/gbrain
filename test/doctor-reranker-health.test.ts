/**
 * v0.47.10 — doctor `reranker_health` resolves enablement + model through the
 * mode plane and reports readiness (key present / sunset / skip rows).
 *
 * Stub engine: `getConfig` from a Map (loadSearchModeConfig reads per key);
 * env via withEnv (the check folds `loadConfig()` + process.env). Audit rows
 * land in a fresh GBRAIN_AUDIT_DIR per test.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkRerankerHealth } from '../src/commands/doctor.ts';
import { logRerankFailure } from '../src/core/rerank-audit.ts';
import { DEFAULT_RERANKER_MODEL } from '../src/core/ai/defaults.ts';
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

describe('reranker_health (v0.47.10 readiness-aware)', () => {
  test('balanced default (no rows), VOYAGE_API_KEY absent → warn naming the key and the disable command', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
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
      const c = await checkRerankerHealth(engineWith({ 'search.reranker.enabled': 'false' }));
      expect(c.status).toBe('ok');
      expect(c.message).toContain('Reranker disabled');
      expect(c.message).toContain('gbrain config set search.reranker.enabled true');
    });
    await inFreshAudit({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const c = await checkRerankerHealth(engineWith({ 'search.reranker.enabled': 'false' }));
      expect(c.status).toBe('ok');
      expect(c.message).toContain('Reranker disabled');
      expect(c.message).not.toContain('enabled true');
    });
  });

  test('conservative mode (bundle reranker off) → ok "disabled" even with no rows', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
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
      const c = await checkRerankerHealth(engineWith({}));
      expect(c.status).toBe('ok');
      expect(c.message).toContain('ready');
      expect(c.message).toContain('skip row');
      expect(c.message).toContain('no_key');
      expect(c.message).toContain('restarted');
    });
  });

  test('a VOYAGE key that lives only in the DB config plane counts as present (same plane as the gateway)', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const c = await checkRerankerHealth(engineWith({ voyage_api_key: 'pa-db-plane' }));
      expect(c.status).toBe('ok');
      expect(c.message).toContain('VOYAGE_API_KEY present');
    });
  });

  test('explicit unknown reranker model → warn with the model fix', async () => {
    await inFreshAudit({ VOYAGE_API_KEY: 'pa-test' }, async () => {
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
      const c = await checkRerankerHealth(engineWith({}));
      expect(c.status).toBe('warn');
      expect(c.message).toContain('auth failure');
      expect(c.message).toContain('key present but rejected');
    });
  });
});
