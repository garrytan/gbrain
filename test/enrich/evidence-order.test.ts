/**
 * #2085 — enrich evidence ordering + hybrid clamp + counter split.
 *
 * renderEvidence packs WHOLE blocks in order into a fixed 12k window, so
 * evidence order is load-bearing: pre-fix, retrieveEvidence appended hybrid
 * chunks FIRST and a few long chunks consumed the window, pushing short,
 * high-signal facts/backlinks out of the prompt — fact-rich stub pages
 * false-SKIPped. The fix: facts → backlinks → hybrid, with each hybrid chunk
 * clamped to HYBRID_CHUNK_CLAMP_CHARS.
 *
 * Layer 1: pure assembleEvidence ordering/clamp pins (no engine).
 * Layer 2: hermetic PGLite runEnrichCore with a prompt-capturing synthesizeFn
 *          (facts + backlinks render; counter split pre_llm/model_skip/empty).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  runEnrichCore,
  assembleEvidence,
  HYBRID_CHUNK_CLAMP_CHARS,
  type SynthesizeFn,
} from '../../src/commands/enrich.ts';
import { MAX_CONTEXT_CHARS, renderEvidence, type EnrichEvidence } from '../../src/core/enrich/thin.ts';

// ---------------------------------------------------------------------------
// Layer 1 — pure ordering + clamp.
// ---------------------------------------------------------------------------

describe('assembleEvidence (#2085)', () => {
  const ev = (slug: string, text: string): EnrichEvidence => ({ source_slug: slug, text });

  test('orders facts before backlinks before hybrid', () => {
    const out = assembleEvidence({
      facts: [ev('e/x', 'fact-1'), ev('e/x', 'fact-2')],
      backlinks: [ev('b/1', 'backlink-ctx')],
      hybrid: [ev('h/1', 'hybrid-chunk')],
    });
    expect(out.map((e) => e.text)).toEqual(['fact-1', 'fact-2', 'backlink-ctx', 'hybrid-chunk']);
  });

  test('clamps each hybrid chunk to HYBRID_CHUNK_CLAMP_CHARS; facts/backlinks untouched', () => {
    const long = 'y'.repeat(HYBRID_CHUNK_CLAMP_CHARS + 3000);
    const out = assembleEvidence({
      facts: [ev('e/x', long)],
      backlinks: [ev('b/1', long)],
      hybrid: [ev('h/1', long), ev('h/2', long)],
    });
    expect(out[0].text.length).toBe(long.length); // fact untouched
    expect(out[1].text.length).toBe(long.length); // backlink untouched
    expect(out[2].text.length).toBe(HYBRID_CHUNK_CLAMP_CHARS);
    expect(out[3].text.length).toBe(HYBRID_CHUNK_CLAMP_CHARS);
  });

  test('long hybrid chunks can no longer evict facts from the render window', () => {
    // The reported shape: hybrid hits big enough to fill 12k, 20 short facts,
    // 12 short backlinks. Facts-first must render every fact and backlink.
    const facts = Array.from({ length: 20 }, (_, i) => ev('e/acme', `fact-marker-${i} acme detail`));
    const backlinks = Array.from({ length: 12 }, (_, i) => ev(`m/${i}`, `backlink-marker-${i} context`));
    const hybrid = Array.from({ length: 8 }, (_, i) => ev(`h/${i}`, 'z'.repeat(6000)));

    const rendered = renderEvidence(assembleEvidence({ facts, backlinks, hybrid }));
    expect(rendered.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    for (let i = 0; i < 20; i++) expect(rendered).toContain(`fact-marker-${i}`);
    for (let i = 0; i < 12; i++) expect(rendered).toContain(`backlink-marker-${i}`);
    // Pre-fix counterfactual: hybrid-first rendered ~2 x 6000-char chunks and
    // zero facts/backlinks. Post-fix at least one clamped hybrid chunk still
    // fits behind the facts.
    expect(rendered).toContain('[Source: h/0]');
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — hermetic PGLite integration.
// ---------------------------------------------------------------------------

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
  await resetPgliteState(engine);
});

const STUB = 'Stub page.';

async function seedStub(slug: string, title: string) {
  await engine.putPage(slug, {
    type: 'person' as never,
    title,
    compiled_truth: STUB,
    timeline: '',
    frontmatter: {},
  });
}

async function seedBacklink(toSlug: string, fromSlug: string, context: string) {
  await engine.putPage(fromSlug, {
    type: 'note' as never,
    title: fromSlug,
    compiled_truth: `Notes referencing ${toSlug}.`,
    timeline: '',
    frontmatter: {},
  });
  await engine.addLink(fromSlug, toSlug, context);
}

async function seedFact(entitySlug: string, fact: string) {
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, source, valid_from)
     VALUES ('default', $1, $2, 'test', now())`,
    [entitySlug, fact],
  );
}

const coreOpts = {
  sourceId: 'default',
  types: ['person'] as never[],
  order: 'inbound-links' as const,
  thinThreshold: 400,
  model: 'test:model',
  workers: 1,
};

describe('runEnrichCore evidence + counters (#2085)', () => {
  test('facts and backlinks reach the prompt (prompt-capturing synth)', async () => {
    await seedStub('people/alice-example', 'Alice Example');
    for (let i = 0; i < 5; i++) {
      await seedFact('people/alice-example', `fact-marker-${i}: Alice founded WidgetCo unit ${i}`);
    }
    await seedBacklink(
      'people/alice-example',
      'meetings/m1',
      'backlink-marker-0: Alice presented the widget design system at the summit.',
    );

    let captured = '';
    const capturingSynth: SynthesizeFn = async ({ user }) => {
      captured = user;
      return '## Overview\nAlice founded WidgetCo. [Source: meetings/m1]';
    };
    const r = await runEnrichCore(engine, { ...coreOpts, minContextChars: 50, synthesizeFn: capturingSynth });
    expect(r.pages_enriched).toBe(1);
    for (let i = 0; i < 5; i++) expect(captured).toContain(`fact-marker-${i}`);
    expect(captured).toContain('backlink-marker-0');
    // Facts render BEFORE the backlink context (priority order).
    expect(captured.indexOf('fact-marker-0')).toBeLessThan(captured.indexOf('backlink-marker-0'));
  }, 30000);

  test('pre-LLM grounding gate → pages_skipped_pre_llm, synth never called', async () => {
    await seedStub('people/lonely', 'Lonely Stub'); // no evidence at all
    let calls = 0;
    const r = await runEnrichCore(engine, {
      ...coreOpts,
      synthesizeFn: async () => { calls++; return 'SKIP'; },
    });
    expect(calls).toBe(0);
    expect(r.pages_skipped_pre_llm).toBe(1);
    expect(r.pages_model_skip).toBe(0);
    expect(r.pages_empty_output).toBe(0);
    // Legacy counter stays the sum.
    expect(r.pages_skipped_insufficient).toBe(1);
  }, 30000);

  test('model SKIP → pages_model_skip; empty output → pages_empty_output', async () => {
    await seedStub('people/alice-example', 'Alice Example');
    await seedBacklink('people/alice-example', 'meetings/m1',
      'Alice Example co-founded WidgetCo in 2025 and leads its product design team across two offices.');

    const rSkip = await runEnrichCore(engine, {
      ...coreOpts, minContextChars: 50, synthesizeFn: async () => 'SKIP\n\n(not enough context)',
    });
    expect(rSkip.pages_model_skip).toBe(1);
    expect(rSkip.pages_empty_output).toBe(0);
    expect(rSkip.pages_skipped_pre_llm).toBe(0);
    expect(rSkip.pages_skipped_insufficient).toBe(1);

    await resetPgliteState(engine);
    await seedStub('people/alice-example', 'Alice Example');
    await seedBacklink('people/alice-example', 'meetings/m1',
      'Alice Example co-founded WidgetCo in 2025 and leads its product design team across two offices.');

    const rEmpty = await runEnrichCore(engine, {
      ...coreOpts, minContextChars: 50, synthesizeFn: async () => '   ',
    });
    expect(rEmpty.pages_empty_output).toBe(1);
    expect(rEmpty.pages_model_skip).toBe(0);
    expect(rEmpty.pages_skipped_insufficient).toBe(1);
  }, 30000);
});
