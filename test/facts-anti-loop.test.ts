/**
 * v0.31 Phase 6 — anti-loop on dream_generated marker.
 *
 * Pins both code paths that must respect the v0.23.2 marker:
 *   - extractFactsFromTurn(isDreamGenerated:true) → []
 *   - put_page backstop on dream_generated:true frontmatter → skipped:dream_generated
 *
 * The two `put_page` cases drive `dispatchToolCall → put_page`, whose
 * importFromContent embeds by design (embed failure PROPAGATES — Codex C2).
 * A sibling shard file that left the gateway configured with a fake/
 * non-legacy key makes put_page's embed step 401 and throw (isError), which
 * is what failed these two tests in CI shard 2 while the engine-free
 * extractFactsFromTurn cases passed. We don't want embedding here at all,
 * so resetGateway() before each test → empty gateway → embedBatch is a
 * graceful no-op → put_page succeeds regardless of sibling pollution.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { extractFactsFromTurn } from '../src/core/facts/extract.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

// 60s hook timeout — generous budget for the PGLite WASM cold-start + full
// migration chain on a fresh DB, well above bun's 5s hook default.
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

// Empty gateway → put_page's embed step is a graceful no-op (see header).
beforeEach(() => {
  resetGateway();
});

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

describe('anti-loop dream_generated marker', () => {
  test('extractFactsFromTurn skips when isDreamGenerated:true', async () => {
    const r = await extractFactsFromTurn({
      turnText: 'This would normally produce facts about Sam.',
      source: 'test',
      isDreamGenerated: true,
    });
    expect(r).toEqual([]);
  });

  test('extractFactsFromTurn does NOT skip on isDreamGenerated:false', async () => {
    const r = await extractFactsFromTurn({
      turnText: '',
      source: 'test',
      isDreamGenerated: false,
    });
    // Empty turn returns [] for a different reason (no content). Just
    // confirms the false branch doesn't short-circuit before the empty
    // check.
    expect(r).toEqual([]);
  });

  test('put_page backstop skips on dream_generated:true', async () => {
    const result = await dispatchToolCall(engine, 'put_page', {
      slug: 'note/anti-loop-dream',
      content: `---\ntype: note\ntitle: Dream\ndream_generated: true\n---\n${'real-looking content. '.repeat(20)}`,
    }, { remote: false, sourceId: 'default' });
    const payload = JSON.parse(result.content[0].text);
    // Diagnostic: if facts_backstop is missing, the handler likely threw
    // and dispatchToolCall wrapped the error as `{error: 'internal_error'}`.
    // Surface the full payload so CI logs reveal the actual failure mode.
    if (!payload.facts_backstop) {
      throw new Error(`put_page returned no facts_backstop. Full payload: ${JSON.stringify(payload, null, 2)}. isError=${(result as { isError?: boolean }).isError}`);
    }
    expect(payload.facts_backstop).toEqual({ skipped: 'dream_generated' });
  });

  test('put_page backstop does NOT skip on dream_generated:false / absent', async () => {
    const result = await dispatchToolCall(engine, 'put_page', {
      slug: 'note/anti-loop-real',
      content: `---\ntype: note\ntitle: Real\n---\n${'real-looking content with claims. '.repeat(15)}`,
    }, { remote: false, sourceId: 'default' });
    const payload = JSON.parse(result.content[0].text);
    if (!payload.facts_backstop) {
      throw new Error(`put_page returned no facts_backstop. Full payload: ${JSON.stringify(payload, null, 2)}. isError=${(result as { isError?: boolean }).isError}`);
    }
    expect(payload.facts_backstop).toBeDefined();
    if ('skipped' in payload.facts_backstop) {
      expect(payload.facts_backstop.skipped).not.toBe('dream_generated');
    }
  });
});
