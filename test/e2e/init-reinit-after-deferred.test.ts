/**
 * #2301 — re-init with an explicit --embedding-model must recover a brain
 * that was initialized with --no-embedding (deferred setup).
 *
 * Pre-fix: resolveAIOptions honored the persisted `embedding_disabled: true`
 * sentinel BEFORE the explicit flag and never cleared noEmbedding, and the
 * persistence merge carried the sentinel forward via ...existingFile. Result:
 * every re-init (including the recovery command the deferred-setup error
 * itself recommends) silently re-deferred embedding, forever.
 *
 * Hermetic: in-process runInit, GBRAIN_HOME pinned to a tmpdir (same pattern
 * as test/e2e/fresh-install-pglite.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';

describe('E2E: re-init with --embedding-model after --no-embedding init (#2301)', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origZeKey: string | undefined;
  let origOpenaiKey: string | undefined;
  let origVoyageKey: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-e2e-reinit-'));
    origHome = process.env.GBRAIN_HOME;
    origZeKey = process.env.ZEROENTROPY_API_KEY;
    origOpenaiKey = process.env.OPENAI_API_KEY;
    origVoyageKey = process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    process.env.GBRAIN_HOME = tmpHome;
    process.env.ZEROENTROPY_API_KEY = 'sk-test-ze';
    resetGateway();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = origHome;
    if (origZeKey === undefined) delete process.env.ZEROENTROPY_API_KEY;
    else process.env.ZEROENTROPY_API_KEY = origZeKey;
    if (origOpenaiKey !== undefined) process.env.OPENAI_API_KEY = origOpenaiKey;
    if (origVoyageKey !== undefined) process.env.VOYAGE_API_KEY = origVoyageKey;
    // Restore legacy-preload gateway state (mirrors fresh-install-pglite.test.ts).
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env },
    });
  });

  async function runInitCapturing(args: string[]): Promise<string> {
    const { runInit } = await import('../../src/commands/init.ts');
    const origLog = console.log;
    const origWarn = console.warn;
    const stdoutBuf: string[] = [];
    console.log = (...a: unknown[]) => {
      stdoutBuf.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    };
    console.warn = () => {};
    try {
      await runInit(args);
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    return stdoutBuf.join('\n');
  }

  const cfgPath = () => join(tmpHome, '.gbrain', 'config.json');
  const readCfg = () => JSON.parse(readFileSync(cfgPath(), 'utf-8'));

  test('explicit --embedding-model clears the persisted embedding_disabled sentinel', async () => {
    // Step 1: deferred-setup init writes the sentinel.
    const out1 = await runInitCapturing(['--pglite', '--non-interactive', '--no-embedding']);
    expect(out1).toContain('deferred setup');
    const cfg1 = readCfg();
    expect(cfg1.embedding_disabled).toBe(true);
    expect(cfg1.embedding_model).toBeUndefined();

    // Step 2: re-init with an explicit embedding model — the recovery path.
    // Pre-fix this printed the deferred-setup line again and re-persisted
    // embedding_disabled: true.
    const out2 = await runInitCapturing([
      '--pglite', '--non-interactive', '--skip-embed-check',
      '--embedding-model', 'zeroentropyai:zembed-1',
      '--embedding-dimensions', '1280',
    ]);
    expect(out2).not.toContain('deferred setup');
    expect(out2).toContain('zeroentropyai:zembed-1');

    const cfg2 = readCfg();
    expect(cfg2.embedding_model).toBe('zeroentropyai:zembed-1');
    expect(cfg2.embedding_dimensions).toBe(1280);
    expect(cfg2.embedding_disabled).toBeUndefined();
  }, 60000);

  test('re-init WITHOUT flags still honors the deferred-setup sentinel (no regression)', async () => {
    await runInitCapturing(['--pglite', '--non-interactive', '--no-embedding']);
    const out = await runInitCapturing(['--pglite', '--non-interactive']);
    expect(out).toContain('deferred setup');
    const cfg = readCfg();
    expect(cfg.embedding_disabled).toBe(true);
    expect(cfg.embedding_model).toBeUndefined();
  }, 60000);
});
