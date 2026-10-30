// synthesize_concepts spends nothing on a concept it cannot publish.
//
// Protects: an existing concept page whose fences publication would refuse
// (concept_preservation_hold: a duplicated or unbalanced fence) or whose body
// is segmented (page_body_segmented) is held before the model call, with $0
// spent, on every cycle; the phase keeps going for the other concepts; the
// bounded-retry counter for a concept is cleared only after its narrative is
// published, so a publication that is deferred after the call does not reset
// it.
// Fails when: the hold is only discovered by publication after chat() (the
// same narrative is bought every cycle and never stamped with its member
// hash), a segmented concept aborts the phase after a paid call, or
// retries.succeed runs before publication.
// Why new: no test covered a held or segmented existing concept page.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { CONCEPT_FAILED_ATTEMPTS_KEY } from '../../src/core/cycle/concept-retry-bound.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { createSegmentedPage } from '../helpers/segmented-page.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

const MODEL = 'anthropic:claude-sonnet-4-6';
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('models.dream.synthesize', MODEL);
}, 120000);

function chat(calls: { n: number }, opts: { text?: string; stopReason?: ChatResult['stopReason']; during?: () => Promise<void> } = {}): (o: ChatOpts) => Promise<ChatResult> {
  return async (o: ChatOpts) => {
    calls.n++;
    if (opts.during) await opts.during();
    const text = opts.text ?? 'Narrative one.';
    return { text, blocks: [{ type: 'text', text }], stopReason: opts.stopReason ?? 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: o.model ?? 'unset', providerId: 'test' };
  };
}

const atoms = (concept: string, bodies = ['b0', 'b1', 'b2', 'b3', 'b4']) => bodies.map((body, i) => ({
  slug: `atoms/${concept}-a${i}`, title: `A${i}`, body, concept_refs: [concept], visibility: 'world' as const,
}));
const synthesized = { tier: 'T2', synthesis_mode: 'llm', member_hash: 'stale-member-hash', synthesized_at: '2026-01-01T00:00:00.000Z', synthesized_by: 'synthesize_concepts-v0.41', visibility: 'world' };
const fact = '| 1 | Flywheels compound | fact | 0.9 | world | high | 2026-01-01 |  | chat |  |';
const factsHeader = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const duplicatedFences = `Old narrative.\n\n## Facts\n\n${FACTS_FENCE_BEGIN}\n${factsHeader}\n${fact}\n${FACTS_FENCE_END}\n\n${FACTS_FENCE_BEGIN}\n${factsHeader}\n${FACTS_FENCE_END}\n`;
const details = (r: { details?: unknown }) => r.details as Record<string, any>;

describe('synthesize_concepts holds an unpublishable concept before the model call', () => {
  test('a concept_preservation_hold page is held with no model call, every cycle', async () => {
    await importFromContent(engine, 'concepts/flywheel', serializeMarkdown(synthesized, 'Old narrative.', '', { type: 'concept', title: 'flywheel', tags: [] }),
      { noEmbed: true, sourceId: 'default' });
    await engine.executeRaw("UPDATE pages SET compiled_truth = $1 WHERE slug = 'concepts/flywheel' AND source_id = 'default'", [duplicatedFences]);
    const calls = { n: 0 };
    const first = await runPhaseSynthesizeConcepts(engine, { _atoms: [...atoms('flywheel'), ...atoms('moat')], sourceId: 'default', _chat: chat(calls) });
    expect(details(first).publication_held.map((h: { concept: string; reason: string }) => [h.concept, h.reason.split(':')[0]])).toEqual([['flywheel', 'concept_preservation_hold']]);
    const second = await runPhaseSynthesizeConcepts(engine, { _atoms: [...atoms('flywheel'), ...atoms('moat')], sourceId: 'default', _chat: chat(calls) });
    expect(details(second).publication_held.map((h: { concept: string }) => h.concept)).toEqual(['flywheel']);
    expect(calls.n).toBe(1);
    expect((await engine.getPage('concepts/moat', { sourceId: 'default' }))?.compiled_truth.trim()).toBe('Narrative one.');
    expect((await engine.getPage('concepts/flywheel', { sourceId: 'default' }))?.compiled_truth).toContain('Old narrative.');
  }, 120000);

  test('a segmented concept page is held as page_body_segmented with no model call, and the phase goes on', async () => {
    await createSegmentedPage(engine, { slug: 'concepts/flywheel', truth: 'Old narrative.\n', meta: { type: 'concept', title: 'flywheel', frontmatter: synthesized } });
    const calls = { n: 0 };
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: [...atoms('flywheel'), ...atoms('moat')], sourceId: 'default', _chat: chat(calls) });
    expect(details(result).publication_held.map((h: { concept: string; reason: string }) => [h.concept, h.reason.split(':')[0]])).toEqual([['flywheel', 'page_body_segmented']]);
    expect(calls.n).toBe(1);
    expect((await engine.getPage('concepts/moat', { sourceId: 'default' }))?.compiled_truth.trim()).toBe('Narrative one.');
  }, 120000);

  test('the failed-attempt count is cleared only after the narrative is published', async () => {
    const calls = { n: 0 };
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms('flywheel'), sourceId: 'default', _chat: chat(calls, { stopReason: 'length' }) });
    const recorded = JSON.parse((await engine.getConfig(CONCEPT_FAILED_ATTEMPTS_KEY))!);
    expect(recorded['default:concepts/flywheel']).toMatchObject({ attempts: 1 });
    const rewrite = async () => {
      const page = await engine.getPage('concepts/flywheel', { sourceId: 'default' });
      await importFromContent(engine, 'concepts/flywheel', serializeMarkdown(page!.frontmatter, 'Edited elsewhere.', '', { type: 'concept', title: page!.title, tags: [] }),
        { noEmbed: true, sourceId: 'default' });
    };
    const deferred = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms('flywheel'), sourceId: 'default', _chat: chat(calls, { during: rewrite }) });
    expect(details(deferred).publication_deferred.map((d: { concept: string }) => d.concept)).toEqual(['flywheel']);
    expect(JSON.parse((await engine.getConfig(CONCEPT_FAILED_ATTEMPTS_KEY))!)['default:concepts/flywheel']).toMatchObject({ attempts: 1 });
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms('flywheel'), sourceId: 'default', _chat: chat(calls) });
    expect(JSON.parse((await engine.getConfig(CONCEPT_FAILED_ATTEMPTS_KEY))!)['default:concepts/flywheel']).toBeUndefined();
    expect(calls.n).toBe(3);
  }, 120000);
});
