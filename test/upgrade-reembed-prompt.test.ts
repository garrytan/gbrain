/**
 * v0.32.7 CJK wave — post-upgrade chunker-bump cost prompt tests.
 *
 * Asserts the prompt fires with real-data estimates, re-embeds only on an
 * explicit TTY yes (security wave ENG-3: non-TTY and declined runs never
 * call the provider), honors GBRAIN_NO_REEMBED, and falls back to an
 * "estimate unavailable" message for unknown embedding providers.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  computeReembedEstimate,
  formatReembedPrompt,
  runPostUpgradeReembedPrompt,
  REEMBED_DEFERRED_HINT,
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
    );
    expect(line).toContain('100 markdown pages');
    expect(line).toContain('openai:text-embedding-3-large');
    expect(line).toContain('$0.03');
    expect(line).not.toContain('Ctrl-C');
  });

  test('unknown provider says "estimate unavailable"', () => {
    const line = formatReembedPrompt(
      { pendingCount: 50, pendingChars: 50000, estimatedTokens: 14286, estimatedCostUsd: null, modelString: 'hunyuan:hunyuan-embedding-v1', pricingKnown: false },
    );
    expect(line).toContain('estimate unavailable');
    expect(line).toContain('hunyuan:hunyuan-embedding-v1');
  });

  test('no pending → "Skipping re-embed"', () => {
    const line = formatReembedPrompt(
      { pendingCount: 0, pendingChars: 0, estimatedTokens: 0, estimatedCostUsd: 0, modelString: 'openai:text-embedding-3-large', pricingKnown: true },
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

  test('non-TTY never proceeds and prints the deferred commands', async () => {
    await seedPage('a', 'body');
    const writes: string[] = [];
    const asked: string[] = [];
    const result = await runPostUpgradeReembedPrompt(engine, 'openai:text-embedding-3-large', {
      isTTY: false,
      env: {},
      write: (l) => writes.push(l),
      confirm: async (q) => { asked.push(q); return true; },
    });
    expect(result.proceeded).toBe(false);
    expect(result.reason).toBe('consent_required');
    expect(asked).toEqual([]);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(REEMBED_DEFERRED_HINT);
  });

  test('GBRAIN_NO_REEMBED=1 bails out with doctor-warning marker', async () => {
    await seedPage('a', 'body');
    const writes: string[] = [];
    const result = await runPostUpgradeReembedPrompt(engine, 'openai:text-embedding-3-large', {
      isTTY: true,
      env: { GBRAIN_NO_REEMBED: '1' },
      write: (l) => writes.push(l),
      confirm: async () => { throw new Error('must not ask'); },
    });
    expect(result.proceeded).toBe(false);
    expect(result.reason).toBe('bypassed_no_reembed');
    expect(writes.some(w => w.includes('GBRAIN_NO_REEMBED=1'))).toBe(true);
  });

  test('TTY proceeds only on an explicit yes', async () => {
    await seedPage('a', 'body');
    const asked: string[] = [];
    const result = await runPostUpgradeReembedPrompt(engine, 'openai:text-embedding-3-large', {
      isTTY: true,
      env: {},
      write: () => {},
      confirm: async (q) => { asked.push(q); return true; },
    });
    expect(asked).toEqual(['[chunker-bump] Re-embed now? [y/N] ']);
    expect(result.proceeded).toBe(true);
    expect(result.reason).toBe('tty_consented');
  });

  test('TTY default answer (Enter, EOF, no) declines', async () => {
    await seedPage('a', 'body');
    const writes: string[] = [];
    const result = await runPostUpgradeReembedPrompt(engine, 'openai:text-embedding-3-large', {
      isTTY: true,
      env: {},
      write: (l) => writes.push(l),
      confirm: async () => false,
    });
    expect(result.proceeded).toBe(false);
    expect(result.reason).toBe('tty_declined');
    expect(writes.at(-1)).toBe(REEMBED_DEFERRED_HINT);
  });

  test('unknown provider still prints the estimate line (degrades to "estimate unavailable")', async () => {
    await seedPage('a', 'body');
    const writes: string[] = [];
    const result = await runPostUpgradeReembedPrompt(engine, 'hunyuan:hunyuan-embedding-v1', {
      isTTY: false,
      env: {},
      write: (l) => writes.push(l),
    });
    expect(result.proceeded).toBe(false);
    expect(writes[0]).toContain('estimate unavailable');
  });
});
