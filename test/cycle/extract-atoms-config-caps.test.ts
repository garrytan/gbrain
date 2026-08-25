// #4540 — extract_atoms per-item caps are configurable.
//
// Before the fix the work loop hardcoded `item.content.slice(0, 50_000)` and
// `maxTokens: 4096`. Operators running the phase against small-context or
// thinking models could not shrink/grow either without a code change, and
// the raw .slice() could split a UTF-8 surrogate pair at the boundary.
//
// The fix reads cycle.extract_atoms.max_input_chars /
// cycle.extract_atoms.max_output_tokens at the same engine.getConfig seam as
// cycle.extract_atoms.budget_usd (defaults unchanged), cuts with
// truncateUtf8, and adds an optional cycle.extract_atoms.pacing_ms sleep.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  runPhaseExtractAtoms,
  DEFAULT_EXTRACT_MAX_INPUT_CHARS,
  DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS,
} from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function captureChat(): { calls: ChatOpts[]; chat: (o: ChatOpts) => Promise<ChatResult> } {
  const calls: ChatOpts[] = [];
  return {
    calls,
    chat: async (o: ChatOpts) => {
      calls.push(o);
      return {
        text: '[]',
        blocks: [{ type: 'text', text: '[]' }],
        stopReason: 'end',
        usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      };
    },
  };
}

function userContent(o: ChatOpts): string {
  const m = o.messages[o.messages.length - 1];
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
}

describe('extract_atoms configurable caps (#4540)', () => {
  test('defaults unchanged: 50k input chars, 4096 output tokens', async () => {
    const { calls, chat } = captureChat();
    const big = 'x'.repeat(DEFAULT_EXTRACT_MAX_INPUT_CHARS + 5_000);
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/tmp/t1.txt', content: big, contentHash: 'h1'.repeat(8) }],
      _pages: [],
      _chat: chat,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].maxTokens).toBe(DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS);
    const content = userContent(calls[0]);
    // Body is prefix + truncated content: the 55k payload was cut to 50k.
    expect(content.length).toBeLessThan(DEFAULT_EXTRACT_MAX_INPUT_CHARS + 200);
    expect(content.length).toBeGreaterThanOrEqual(DEFAULT_EXTRACT_MAX_INPUT_CHARS);
  });

  test('cycle.extract_atoms.max_input_chars / .max_output_tokens are honored', async () => {
    await engine.setConfig('cycle.extract_atoms.max_input_chars', '2000');
    await engine.setConfig('cycle.extract_atoms.max_output_tokens', '512');
    const { calls, chat } = captureChat();
    const big = 'y'.repeat(10_000);
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/tmp/t2.txt', content: big, contentHash: 'h2'.repeat(8) }],
      _pages: [],
      _chat: chat,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].maxTokens).toBe(512);
    const content = userContent(calls[0]);
    // 2000 content chars + the small "Source: ..." preamble.
    expect(content.length).toBeLessThan(2_200);
    expect(content).toContain('y'.repeat(2_000));
    expect(content).not.toContain('y'.repeat(2_001));
  });

  test('garbage/too-small values fall back to defaults (floors)', async () => {
    await engine.setConfig('cycle.extract_atoms.max_input_chars', '10'); // below 1000 floor
    await engine.setConfig('cycle.extract_atoms.max_output_tokens', 'not-a-number');
    const { calls, chat } = captureChat();
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/tmp/t3.txt', content: 'z'.repeat(3_000), contentHash: 'h3'.repeat(8) }],
      _pages: [],
      _chat: chat,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].maxTokens).toBe(DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS);
    // Content not truncated to 10 chars — the floor rejected the value.
    expect(userContent(calls[0])).toContain('z'.repeat(3_000));
  });

  test('input cap cuts UTF-8 safely (no lone surrogate at the boundary)', async () => {
    await engine.setConfig('cycle.extract_atoms.max_input_chars', '2001');
    const { calls, chat } = captureChat();
    // Astral chars (2 UTF-16 units each): an odd cap on this content would
    // split a pair if the cut were a bare .slice().
    const astral = '😀'.repeat(2_000);
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/tmp/t4.txt', content: astral, contentHash: 'h4'.repeat(8) }],
      _pages: [],
      _chat: chat,
    });
    expect(calls.length).toBe(1);
    const content = userContent(calls[0]);
    // Round-tripping through UTF-8 replaces lone surrogates with U+FFFD;
    // well-formed content survives unchanged.
    const roundTripped = new TextDecoder().decode(new TextEncoder().encode(content));
    expect(roundTripped).toBe(content);
  });
});
