import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runThink, type ThinkLLMClient } from '../src/core/think/index.ts';
import { resolveCitations } from '../src/core/think/cite-render.ts';

// #4376 — think accepted mismatched inline and structured citations as
// successful: once ANY structured citation existed, resolveCitations never
// parsed the inline markers, so a visible fabricated/near-match citation in
// the answer body surfaced with zero warnings, and nothing closed the
// resolved citations against the gathered evidence set. These tests pin the
// closure warnings (warning layer only — the never-fail trust contract in
// cite-render.ts stays intact: structured citations remain the source of
// truth and synthesis is not failed over a mismatch).

function stubClientFromResponse(payload: unknown): ThinkLLMClient {
  return {
    create: async () => ({
      id: 'msg_closure',
      type: 'message',
      role: 'assistant',
      model: 'stub',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    }),
  };
}

describe('resolveCitations — inline/structured closure warnings', () => {
  test('inline marker differing from the structured citation warns both ways', () => {
    // The issue's exact repro shape: visible [records/example-a], structured
    // records/example-b. Red at HEAD: warnings === [].
    const r = resolveCitations(
      [{ page_slug: 'records/example-b', row_num: null }],
      'The answer cites [records/example-a] visibly.',
    );
    expect(r.usedFallback).toBe(false);
    // Structured stays the source of truth — no repair, no fallback swap.
    expect(r.citations).toHaveLength(1);
    expect(r.citations[0].page_slug).toBe('records/example-b');
    expect(r.warnings).toContain('CITATIONS_INLINE_NOT_IN_STRUCTURED:records/example-a');
    expect(r.warnings).toContain('CITATIONS_STRUCTURED_NOT_INLINE:records/example-b');
  });

  test('near-match slugs (the reported UUID drift) are warned, not repaired', () => {
    const r = resolveCitations(
      [{ page_slug: 'experiences/0000-bbbb', row_num: null }],
      'One visible near-match [experiences/0000-aaaa].',
    );
    expect(r.citations.map(c => c.page_slug)).toEqual(['experiences/0000-bbbb']);
    expect(r.warnings).toContain('CITATIONS_INLINE_NOT_IN_STRUCTURED:experiences/0000-aaaa');
    expect(r.warnings).toContain('CITATIONS_STRUCTURED_NOT_INLINE:experiences/0000-bbbb');
  });

  test('matching inline and structured sets emit no mismatch warnings', () => {
    const r = resolveCitations(
      [
        { page_slug: 'people/alice-example', row_num: 2 },
        { page_slug: 'records/example-a', row_num: null },
      ],
      'Alice [people/alice-example#2] and the record [records/example-a].',
    );
    expect(r.warnings.filter(w => w.startsWith('CITATIONS_INLINE_NOT_IN_STRUCTURED'))).toEqual([]);
    expect(r.warnings.filter(w => w.startsWith('CITATIONS_STRUCTURED_NOT_INLINE'))).toEqual([]);
  });

  test('row_num is part of the closure key (slug#row)', () => {
    const r = resolveCitations(
      [{ page_slug: 'people/alice-example', row_num: 3 }],
      'Take cite [people/alice-example#2].',
    );
    expect(r.warnings).toContain('CITATIONS_INLINE_NOT_IN_STRUCTURED:people/alice-example#2');
    expect(r.warnings).toContain('CITATIONS_STRUCTURED_NOT_INLINE:people/alice-example#3');
  });

  test('inline-only extra beyond a matching structured set warns one way only', () => {
    const r = resolveCitations(
      [{ page_slug: 'records/example-a', row_num: null }],
      'Cited [records/example-a] plus a fabricated [records/example-c].',
    );
    expect(r.warnings).toContain('CITATIONS_INLINE_NOT_IN_STRUCTURED:records/example-c');
    expect(r.warnings.filter(w => w.startsWith('CITATIONS_STRUCTURED_NOT_INLINE'))).toEqual([]);
  });

  test('structured-only citations with no visible markers warn one way only', () => {
    const r = resolveCitations(
      [{ page_slug: 'records/example-a', row_num: null }],
      'Prose with no visible markers at all.',
    );
    expect(r.warnings).toContain('CITATIONS_STRUCTURED_NOT_INLINE:records/example-a');
    expect(r.warnings.filter(w => w.startsWith('CITATIONS_INLINE_NOT_IN_STRUCTURED'))).toEqual([]);
  });

  test('the structured-empty regex fallback path is unchanged', () => {
    const r = resolveCitations([], 'Body text [people/alice-example#2]');
    expect(r.usedFallback).toBe(true);
    expect(r.citations).toHaveLength(1);
    expect(r.warnings).toContain('CITATIONS_REGEX_FALLBACK');
    expect(r.warnings.filter(w => w.startsWith('CITATIONS_INLINE_NOT_IN_STRUCTURED'))).toEqual([]);
    expect(r.warnings.filter(w => w.startsWith('CITATIONS_STRUCTURED_NOT_INLINE'))).toEqual([]);
  });
});

describe('runThink — resolved citations close against the gather set', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const alice = await engine.putPage('people/alice-example', {
      title: 'Alice', type: 'person', compiled_truth: 'Alice founded Acme.',
    });
    await engine.addTakesBatch([
      { page_id: alice.id, row_num: 1, claim: 'CEO of Acme', kind: 'fact', holder: 'world', weight: 1.0 },
      { page_id: alice.id, row_num: 2, claim: 'Strong technical founder', kind: 'take', holder: 'garry', weight: 0.85 },
    ]);
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('a structured citation outside the gathered evidence warns CITATION_NOT_IN_GATHER', async () => {
    const result = await runThink(engine, {
      question: 'technical founder',
      withTrajectory: false,
      client: stubClientFromResponse({
        answer: 'The answer cites [records/example-a] visibly.',
        citations: [{ page_slug: 'records/example-b', row_num: null }],
        gaps: [],
      }),
    });
    // Warning layer only — the synthesis itself still succeeds.
    expect(result.synthesis_status).toBe('ok');
    expect(result.warnings).toContain('CITATIONS_INLINE_NOT_IN_STRUCTURED:records/example-a');
    expect(result.warnings).toContain('CITATIONS_STRUCTURED_NOT_INLINE:records/example-b');
    expect(result.warnings).toContain('CITATION_NOT_IN_GATHER:records/example-b');
  });

  test('citations covered by the gathered evidence emit no closure warnings', async () => {
    const result = await runThink(engine, {
      question: 'technical founder',
      withTrajectory: false,
      client: stubClientFromResponse({
        answer: 'Strong founder [people/alice-example#2].',
        citations: [{ page_slug: 'people/alice-example', row_num: 2 }],
        gaps: [],
      }),
    });
    expect(result.synthesis_status).toBe('ok');
    expect(result.warnings.filter(w => w.startsWith('CITATIONS_INLINE_NOT_IN_STRUCTURED'))).toEqual([]);
    expect(result.warnings.filter(w => w.startsWith('CITATIONS_STRUCTURED_NOT_INLINE'))).toEqual([]);
    expect(result.warnings.filter(w => w.startsWith('CITATION_NOT_IN_GATHER'))).toEqual([]);
  });
});
