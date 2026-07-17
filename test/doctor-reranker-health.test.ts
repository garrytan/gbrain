/**
 * Leaf coverage for `checkRerankerHealth` — the null-engine (`--fast` /
 * DB-down) path added for issue #2059 item 3. The check reads only the
 * rerank-failure audit JSONL, so a null engine must still surface failure
 * counts; only the zero-failure message loses the enabled/disabled nuance.
 *
 * Env-mutating (GBRAIN_AUDIT_DIR) — kept out of doctor-behavioral.test.ts so
 * that file stays eligible for the concurrent-test codemod.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { checkRerankerHealth } from '../src/commands/doctor.ts';
import { logRerankFailure } from '../src/core/rerank-audit.ts';

describe('checkRerankerHealth — null engine (--fast / DB-down)', () => {
  test('zero failures → ok, without claiming "disabled" from an unread config', async () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'gbrain-rerank-null-empty-'));
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const check = await checkRerankerHealth(null);
      expect(check.name).toBe('reranker_health');
      expect(check.status).toBe('ok');
      expect(check.message).toBe('No rerank failures in last 7 days');
    });
  });

  test('auth failures surface with a null engine', async () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'gbrain-rerank-null-auth-'));
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      logRerankFailure({
        model: 'zeroentropyai:zerank-2',
        reason: 'auth',
        query_hash: 'deadbeef',
        doc_count: 30,
        error_summary: 'rerank HTTP 401: Unauthorized',
      });
      const check = await checkRerankerHealth(null);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('auth failure');
    });
  });

  test('explicit search.reranker.enabled=false override still reads as disabled', async () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'gbrain-rerank-engine-empty-'));
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const stubEngine = {
        async getConfig(key: string): Promise<string | null> {
          return key === 'search.reranker.enabled' ? 'false' : null;
        },
      } as any;
      const check = await checkRerankerHealth(stubEngine);
      expect(check.status).toBe('ok');
      expect(check.message).toBe('Reranker disabled — no failures expected');
    });
  });

  test('default brain (no keys set) resolves through the balanced bundle → enabled', async () => {
    // With search.mode AND search.reranker.enabled both unset, the balanced
    // bundle governs and the reranker IS on. Pre-fix the check read the raw
    // config key, treated unset as disabled, and told a default brain
    // "Reranker disabled — no failures expected" while hybridSearch was
    // reranking (or failing open) on every query.
    const auditDir = mkdtempSync(join(tmpdir(), 'gbrain-rerank-default-brain-'));
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const stubEngine = {
        async getConfig(_key: string): Promise<string | null> {
          return null;
        },
      } as any;
      const check = await checkRerankerHealth(stubEngine);
      expect(check.status).toBe('ok');
      expect(check.message).toBe('No rerank failures in last 7 days');
    });
  });

  test('search.mode=conservative (no per-key override) resolves as disabled', async () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'gbrain-rerank-conservative-'));
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const stubEngine = {
        async getConfig(key: string): Promise<string | null> {
          return key === 'search.mode' ? 'conservative' : null;
        },
      } as any;
      const check = await checkRerankerHealth(stubEngine);
      expect(check.status).toBe('ok');
      expect(check.message).toBe('Reranker disabled — no failures expected');
    });
  });

  test('throwing getConfig fails open to audit data (never warns, never claims disabled)', async () => {
    // loadSearchModeConfig swallows getConfig errors by contract, so a broken
    // config table falls back to bundle defaults. The audit file is the core
    // signal: with zero events the check stays ok with the neutral message
    // (pre-mode-resolution this warned "Could not check reranker audit" even
    // though the audit file was perfectly readable), and with real failure
    // events the counts still surface.
    const auditDir = mkdtempSync(join(tmpdir(), 'gbrain-rerank-throwing-cfg-'));
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const throwingEngine = {
        async getConfig(_key: string): Promise<string | null> {
          throw new Error('config table unavailable');
        },
      } as any;
      const empty = await checkRerankerHealth(throwingEngine);
      expect(empty.status).toBe('ok');
      expect(empty.message).toBe('No rerank failures in last 7 days');

      logRerankFailure({
        model: 'zeroentropyai:zerank-2',
        reason: 'auth',
        query_hash: 'cafebabe',
        doc_count: 30,
        error_summary: 'rerank HTTP 401: Unauthorized',
      });
      const withFailure = await checkRerankerHealth(throwingEngine);
      expect(withFailure.status).toBe('warn');
      expect(withFailure.message).toContain('auth failure');
    });
  });
});
