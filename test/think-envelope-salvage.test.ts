/**
 * #4509 — think must never ship a raw JSON envelope as the user-facing
 * answer. Valid fenced JSON already parses (tryParseJSON strips fences); the
 * leak needed MALFORMED JSON — typically max-token truncation cutting the
 * envelope mid-string. Pinned here:
 *   - salvageThinkEnvelope recovers answer/citations/gaps tolerantly
 *     (dangling escapes trimmed, arrays only when whole);
 *   - runThink surfaces the salvaged answer (never the raw envelope);
 *   - JSON-shaped but unsalvageable output → empty answer, not raw JSON;
 *   - prose (refusals / the graceful sentinel) keeps its raw text.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  runThink,
  salvageThinkEnvelope,
  looksLikeJsonEnvelope,
  type ThinkLLMClient,
} from '../src/core/think/index.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

describe('salvageThinkEnvelope (pure)', () => {
  test('recovers the answer from an envelope truncated mid-string', () => {
    const truncated = '{"answer": "The tools you need are a wrench, a bucket and a debur';
    const r = salvageThinkEnvelope(truncated);
    expect(r).not.toBeNull();
    expect(r!.answer).toBe('The tools you need are a wrench, a bucket and a debur');
    expect(r!.citations).toEqual([]);
    expect(r!.gaps).toEqual([]);
  });

  test('trims a dangling escape and an incomplete \\u sequence at the cut', () => {
    expect(salvageThinkEnvelope('{"answer": "line one\\nline two\\')!.answer).toBe('line one\nline two');
    expect(salvageThinkEnvelope('{"answer": "smile \\u26')!.answer).toBe('smile ');
  });

  test('recovers whole citations/gaps arrays when they survived the cut', () => {
    const t = '{"answer": "cited", "citations": [{"page_slug": "a/b", "row_num": 3}], "gaps": ["missing x"], "extra": "cut he';
    const r = salvageThinkEnvelope(t)!;
    expect(r.citations).toEqual([{ page_slug: 'a/b', row_num: 3 }]);
    expect(r.gaps).toEqual(['missing x']);
  });

  test('drops a citations array cut mid-way instead of guessing', () => {
    const t = '{"answer": "ok so far", "citations": [{"page_slug": "a/b", "row_';
    const r = salvageThinkEnvelope(t)!;
    expect(r.answer).toBe('ok so far');
    expect(r.citations).toEqual([]);
  });

  test('fenced malformed JSON salvages the same way', () => {
    const t = '```json\n{"answer": "fenced but cut mid';
    expect(salvageThinkEnvelope(t)!.answer).toBe('fenced but cut mid');
  });

  test('returns null for prose, for envelopes without an answer, and for empty answers', () => {
    expect(salvageThinkEnvelope('I cannot help with that request.')).toBeNull();
    expect(salvageThinkEnvelope('{"citations": [], "gap')).toBeNull();
    expect(salvageThinkEnvelope('{"answer": "   ')).toBeNull();
  });

  test('looksLikeJsonEnvelope: fenced/bare objects yes, prose no', () => {
    expect(looksLikeJsonEnvelope('{"answer": "x')).toBe(true);
    expect(looksLikeJsonEnvelope('```json\n{"answer"')).toBe(true);
    expect(looksLikeJsonEnvelope('plain prose, not JSON')).toBe(false);
  });
});

describe('runThink — malformed envelope never reaches the answer (#4509)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await resetPgliteState(engine);
  }, 300_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  function clientReturning(text: string): ThinkLLMClient {
    return {
      create: async () => ({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }) as never,
    };
  }

  test('truncated envelope → salvaged answer, not the raw JSON', async () => {
    const truncated = '{"answer": "Salv買geable answer text that was cut mid-str';
    const r = await runThink(engine, {
      question: 'q?',
      client: clientReturning(truncated),
      withTrajectory: false,
    });
    expect(r.synthesis_status).toBe('not_json');
    expect(r.warnings).toContain('LLM_OUTPUT_NOT_JSON');
    expect(r.warnings).toContain('SALVAGED_ANSWER_FROM_MALFORMED_JSON');
    expect(r.answer).toBe('Salv買geable answer text that was cut mid-str');
    expect(r.answer).not.toContain('{"answer"');
    expect(r.synthesisOk).toBe(false); // salvage never persists as a synthesis page
  }, 60_000);

  test('JSON-shaped but unsalvageable → empty answer, never raw JSON', async () => {
    const r = await runThink(engine, {
      question: 'q?',
      client: clientReturning('{"citations": [], "ga'),
      withTrajectory: false,
    });
    expect(r.synthesis_status).toBe('not_json');
    expect(r.warnings).toContain('MALFORMED_JSON_ANSWER_SUPPRESSED');
    expect(r.answer).toBe('');
  }, 60_000);

  test('refusal prose keeps its raw text (meaningful to consumers)', async () => {
    const r = await runThink(engine, {
      question: 'q?',
      client: clientReturning('I cannot help with that request.'),
      withTrajectory: false,
    });
    expect(r.synthesis_status).toBe('not_json');
    expect(r.answer).toBe('I cannot help with that request.');
  }, 60_000);
});
