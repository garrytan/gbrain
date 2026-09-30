import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

test('reindex tracing preserves query cancellation and successful transaction results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-reindex-trace-'));
  const originalFetch = globalThis.fetch;
  const originalTransaction = PGLiteEngine.prototype.transaction;
  const engine = new PGLiteEngine();
  try {
    await withEnv({
      REINDEX_FIXTURE_ROOT: root,
      REINDEX_FIXTURE_CHECKOUT: resolve(import.meta.dir, '..'),
      REINDEX_FIXTURE_MODE: 'trace',
      REINDEX_FIXTURE_TRACE: join(root, 'trace.ndjson'),
      REINDEX_FIXTURE_KILL_AT: '0',
    }, async () => {
      await import('./fixtures/reindex-markdown-perf.ts');
      await engine.connect({});
      const aborted = new AbortController();
      aborted.abort();
      await expect(engine.transaction(tx => tx.executeRaw('SELECT 7 AS value', [], {
        signal: aborted.signal,
      }))).rejects.toMatchObject({ name: 'AbortError' });
      const live = new AbortController();
      expect(await engine.transaction(tx => tx.executeRaw('SELECT 7 AS value', [], {
        signal: live.signal,
      }))).toEqual([{ value: 7 }]);
    });
  } finally {
    globalThis.fetch = originalFetch;
    PGLiteEngine.prototype.transaction = originalTransaction;
    await engine.disconnect();
    rmSync(root, { recursive: true, force: true });
  }
});
