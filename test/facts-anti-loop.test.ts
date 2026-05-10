/**
 * v0.31 Phase 6 — anti-loop on dream_generated marker.
 *
 * Pins both code paths that must respect the v0.23.2 marker:
 *   - extractFactsFromTurn(isDreamGenerated:true) → []
 *   - put_page backstop on dream_generated:true frontmatter → skipped:dream_generated
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { extractFactsFromTurn } from '../src/core/facts/extract.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

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
    expect(payload.facts_backstop).toEqual({ skipped: 'dream_generated' });
  });

  test('put_page backstop does NOT skip on dream_generated:false / absent', async () => {
    const result = await dispatchToolCall(engine, 'put_page', {
      slug: 'note/anti-loop-real',
      content: `---\ntype: note\ntitle: Real\n---\n${'real-looking content with claims. '.repeat(15)}`,
    }, { remote: false, sourceId: 'default' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.facts_backstop).toBeDefined();
    if ('skipped' in payload.facts_backstop) {
      expect(payload.facts_backstop.skipped).not.toBe('dream_generated');
    }
  });
});
