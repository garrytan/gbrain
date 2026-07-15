/**
 * v0.32.7 CJK wave — post-upgrade chunker-bump cost prompt tests.
 *
 * Asserts the prompt fires with real-data estimates, honors the non-TTY
 * skip-wait + GBRAIN_NO_REEMBED env overrides, and falls back to an
 * "estimate unavailable" message for unknown embedding providers.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  computeReembedEstimate,
  formatReembedPrompt,
  runPostUpgradeReembedPrompt,
} from '../src/core/post-upgrade-reembed.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await (engine as any).db.exec('DELETE FROM content_chunks');
  await (engine as any).db.exec('DELETE FROM pages');
});

async function seedPage(slug: string, body: string, version = 1) {
  await engine.executeRaw(
    `INSERT INTO pages (slug, type, title, compiled_truth, timeline, page_kind, chunker_version)
     VALUES ($1, 'note', $2, $3, '', 'markdown', $4)`,
    [slug, slug, body, version],
  );
}

describe('computeReembedEstimate (v0.32.7)', () => {
  test('returns real SQL counts + chars', async () => {
    await seedPage('a', 'x'.repeat(1000));
    await seedPage('b', 'y'.repeat(2000));
    const est = await computeReembedEstimate(engine, 'openai:text-embedding-3-large');
    expect(est.pendingCount).toBe(2);
    expect(est.pendingChars).toBe(3000);
    expect(est.pricingKnown).toBe(true);
    expect(est.estimatedCostUsd).toBeGreaterThan(0);
  });

  test('already-bumped pages excluded', async () => {
    await seedPage('a', 'old body', 1);
    await seedPage('b', 'new body', MARKDOWN_CHUNKER_VERSION);
    const est = await computeReembedEstimate(engine, 'openai:text-embedding-3-large');
    expect(est.pendingCount).toBe(1);
  });

  test('unknown provider → pricingKnown=false, estimatedCostUsd=null', async () => {
    await seedPage('a', 'body');
    const est = await computeReembedEstimate(engine, 'hunyuan:hunyuan-embedding-v1');
    expect(est.pricingKnown).toBe(false);
    expect(est.estimatedCostUsd).toBeNull();
  });
});

describe('formatReembedPrompt (v0.32.7)', () => {
  test('known provider includes dollar figure', () => {
    const line = formatReembedPrompt(
      { pendingCount: 100, pendingChars: 100000, estimatedTokens: 28571, estimatedCostUsd: 0.034, modelString: 'openai:text-embedding-3-large', pricingKnown: true },
      10,
    );
    expect(line).toContain('100 markdown pages');
    expect(line).toContain('openai:text-embedding-3-large');
    expect(line).toContain('$0.03');
    expect(line).toContain('Ctrl-C within 10s');
  });

  test('unknown provider says "estimate unavailable"', () => {
    const line = formatReembedPrompt(
      { pendingCount: 50, pendingChars: 50000, estimatedTokens: 14286, estimatedCostUsd: null, modelString: 'hunyuan:hunyuan-embedding-v1', pricingKnown: false },
      10,
    );
    expect(line).toContain('estimate unavailable');
    expect(line).toContain('hunyuan:hunyuan-embedding-v1');
  });

  test('no pending → "Skipping re-embed"', () => {
    const line = formatReembedPrompt(
      { pendingCount: 0, pendingChars: 0, estimatedTokens: 0, estimatedCostUsd: 0, modelString: 'openai:text-embedding-3-large', pricingKnown: true },
      10,
    );
    expect(line).toContain('No pending markdown pages');
  });
});

describe('runPostUpgradeReembedPrompt (v0.32.7)', () => {
  test('no pending → does NOT prompt, returns proceeded=false', async () => {
    await seedPage('a', 'body', MARKDOWN_CHUNKER_VERSION);
    const writes: string[] = [];
    const result = await runPostUpgradeReembedPrompt(engine, 'openai:text-embedding-3-large', {
      isTTY: false,
      env: {},
      write: (l) => writes.push(l),
    });
    expect(result.proceeded).toBe(false);
    expect(result.reason).toBe('no_pending');
    expect(writes.length).toBe(0);
  });

  test('non-TTY proceeds without wait', async () => {
    await seedPage('a', 'body');
    const writes: string[] = [];
    const result = await runPostUpgradeReembedPrompt(engine, 'openai:text-embedding-3-large', {
      isTTY: false,
      env: {},
      write: (l) => writes.push(l),
      graceSeconds: 99, // would block forever if respected
    });
    expect(result.proceeded).toBe(true);
    expect(result.reason).toBe('non_tty_proceeded');
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('Ctrl-C');
  });

  test('GBRAIN_NO_REEMBED=1 bails out with doctor-warning marker', async () => {
    await seedPage('a', 'body');
    const writes: string[] = [];
    const result = await runPostUpgradeReembedPrompt(engine, 'openai:text-embedding-3-large', {
      isTTY: true,
      env: { GBRAIN_NO_REEMBED: '1' },
      write: (l) => writes.push(l),
      graceSeconds: 99,
    });
    expect(result.proceeded).toBe(false);
    expect(result.reason).toBe('bypassed_no_reembed');
    expect(writes.some(w => w.includes('GBRAIN_NO_REEMBED=1'))).toBe(true);
  });

  test('GBRAIN_REEMBED_GRACE_SECONDS=0 skips wait on TTY', async () => {
    await seedPage('a', 'body');
    const writes: string[] = [];
    const t0 = Date.now();
    const result = await runPostUpgradeReembedPrompt(engine, 'openai:text-embedding-3-large', {
      isTTY: true,
      env: { GBRAIN_REEMBED_GRACE_SECONDS: '0' },
      write: (l) => writes.push(l),
    });
    expect(result.proceeded).toBe(true);
    expect(result.reason).toBe('tty_proceeded');
    expect(Date.now() - t0).toBeLessThan(1000); // didn't actually wait
  });

  test('unknown provider still prompts + proceeds (degrades to "estimate unavailable")', async () => {
    await seedPage('a', 'body');
    const writes: string[] = [];
    const result = await runPostUpgradeReembedPrompt(engine, 'hunyuan:hunyuan-embedding-v1', {
      isTTY: false,
      env: {},
      write: (l) => writes.push(l),
    });
    expect(result.proceeded).toBe(true);
    expect(writes[0]).toContain('estimate unavailable');
  });
});
