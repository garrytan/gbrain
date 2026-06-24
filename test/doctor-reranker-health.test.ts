import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { logRerankFailure } from '../src/core/rerank-audit.ts';
import { checkRerankerHealth } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

function engineWithRerankerSetting(value: string | null, model: string | null = null): BrainEngine {
  return {
    async getConfig(key: string): Promise<string | null> {
      if (key === 'search.reranker.enabled') return value;
      if (key === 'search.reranker.model') return model;
      return null;
    },
  } as BrainEngine;
}

async function withFreshAuditDir(body: () => void | Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-doctor-reranker-'));
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, body);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function writeAuthFailure(model = 'zeroentropyai:zerank-2'): void {
  logRerankFailure({
    model,
    reason: 'auth',
    query_hash: 'deadbeef',
    doc_count: 10,
    error_summary: 'invalid api key',
  });
}

describe('checkRerankerHealth', () => {
  test('explicitly disabled reranker ignores historical audit failures', async () => {
    await withFreshAuditDir(async () => {
      writeAuthFailure();

      const check = await checkRerankerHealth(engineWithRerankerSetting('false'));

      expect(check).toMatchObject({
        name: 'reranker_health',
        status: 'ok',
      });
      expect(check.message).toContain('Reranker disabled');
    });
  });

  test('disabled reranker config is normalized before audit failures are read', async () => {
    await withFreshAuditDir(async () => {
      writeAuthFailure();

      const check = await checkRerankerHealth(engineWithRerankerSetting(' FALSE '));

      expect(check.status).toBe('ok');
      expect(check.message).toContain('Reranker disabled');
    });
  });

  test('enabled reranker still warns on auth failures', async () => {
    await withFreshAuditDir(async () => {
      writeAuthFailure();

      const check = await checkRerankerHealth(engineWithRerankerSetting('true'));

      expect(check).toMatchObject({
        name: 'reranker_health',
        status: 'warn',
      });
      expect(check.message).toContain('reranker auth failure');
    });
  });

  test('enabled reranker ignores stale failures from a different configured model', async () => {
    await withFreshAuditDir(async () => {
      writeAuthFailure('zeroentropyai:zerank-2');

      const check = await checkRerankerHealth(
        engineWithRerankerSetting('true', 'llama-server-reranker:bge-reranker-v2-m3'),
      );

      expect(check).toMatchObject({
        name: 'reranker_health',
        status: 'ok',
      });
      expect(check.message).toContain('No rerank failures for llama-server-reranker:bge-reranker-v2-m3');
    });
  });
});
