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

const bodyOf = (o: ChatOpts): string => /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(userContent(o))?.[1] ?? '';

describe('extract_atoms configurable caps (#4540)', () => {
  test('defaults unchanged: 50k input chars per call, 4096 output tokens', async () => {
    const { calls, chat } = captureChat();
    const big = 'x'.repeat(DEFAULT_EXTRACT_MAX_INPUT_CHARS + 5_000);
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/tmp/t1.txt', content: big, contentHash: 'h1'.repeat(8) }],
      _pages: [],
      _chat: chat,
    });
    // #6503: the 55k payload is read as two overlapping windows, never cut.
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.maxTokens).toBe(DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS);
      // Each body stays within the 50k cap; the preamble adds the source, window and observation-date lines.
      expect(bodyOf(call).length).toBeLessThanOrEqual(DEFAULT_EXTRACT_MAX_INPUT_CHARS);
      expect(userContent(call).length).toBeLessThan(DEFAULT_EXTRACT_MAX_INPUT_CHARS + 600);
    }
    expect(bodyOf(calls[0]).length).toBe(DEFAULT_EXTRACT_MAX_INPUT_CHARS);
  });

  test('cycle.extract_atoms.max_input_chars / .max_output_tokens are honored on every call', async () => {
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
    // #6503: 10k chars at a 2k cap with a 500-char overlap is seven windows.
    expect(calls.length).toBe(7);
    for (const call of calls) {
      expect(call.maxTokens).toBe(512);
      expect(userContent(call)).not.toContain('y'.repeat(2_001));
    }
    expect(bodyOf(calls[0])).toBe('y'.repeat(2_000));
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

  test('input cap windows UTF-8 safely (no lone surrogate at any boundary)', async () => {
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
    // #6503: 4,000 UTF-16 units at a 2001 cap is several windows; no window
    // boundary (end or overlap start) splits a pair.
    expect(calls.length).toBe(3);
    for (const call of calls) {
      const content = userContent(call);
      // Round-tripping through UTF-8 replaces lone surrogates with U+FFFD;
      // well-formed content survives unchanged.
      const roundTripped = new TextDecoder().decode(new TextEncoder().encode(content));
      expect(roundTripped).toBe(content);
    }
  });
});
