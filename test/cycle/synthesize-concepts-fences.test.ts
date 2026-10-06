// D-N3: synthesize_concepts reads atoms and concept pages without their
// `## Facts` / `## Takes` sections.
//
// Protects: a fence-only edit to a member atom costs no model call; a real
// narrative, model or visibility change still re-synthesizes; a page hashed by
// the pre-fix formula is rehashed without a model call only while its inputs
// are unchanged; on an unmanaged brain a take added to the concept page while
// the model runs survives the rewrite, and a narrative changed during
// synthesis defers the concept instead of being overwritten.
// Fails when: the member hash covers full atom bodies (a take on an atom
// re-buys the concept), or the classic rewrite drops the page's fences.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { parseTakesFence, upsertTakeRow } from '../../src/core/takes-fence.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
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

function chat(text: string, calls: { n: number }, during?: () => Promise<void>): (o: ChatOpts) => Promise<ChatResult> {
  return async (o: ChatOpts) => {
    calls.n++;
    if (during) await during();
    return {
      text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: o.model ?? 'unset', providerId: 'test',
    };
  };
}

type Atom = { slug: string; title: string; body: string; concept_refs: string[]; visibility?: 'world' | 'private' };
const atoms = (bodies: string[] = ['b0', 'b1', 'b2', 'b3', 'b4']): Atom[] => bodies.map((body, i) => ({
  slug: `atoms/a${i}`, title: `A${i}`, body, concept_refs: ['flywheel'], visibility: 'world',
}));
const withTake = (body: string) => upsertTakeRow(body, { claim: 'Flywheels compound', kind: 'take', holder: 'brain', weight: 0.7, active: true }).body;
const run = (input: Atom[], calls: { n: number }, text = 'Narrative one.', during?: () => Promise<void>) =>
  runPhaseSynthesizeConcepts(engine, { _atoms: input, sourceId: 'default', _chat: chat(text, calls, during) });
const concept = () => engine.getPage('concepts/flywheel', { sourceId: 'default' });

describe('member hash ignores fence sections (D-N3)', () => {
  test('a fence-only edit to a member atom costs no model call', async () => {
    const calls = { n: 0 };
    await run(atoms(), calls);
    const fenced = atoms().map((a, i) => (i === 0 ? { ...a, body: withTake(a.body) } : a));
    const r = await run(fenced, calls);
    expect(calls.n).toBe(1);
    expect((r.details as Record<string, unknown>).skipped_unchanged).toEqual(['concepts/flywheel']);
  }, 120000);

  test('a narrative edit, a model change or a visibility change re-synthesizes', async () => {
    const calls = { n: 0 };
    await run(atoms(), calls);
    await run(atoms(['b0 edited', 'b1', 'b2', 'b3', 'b4']), calls);
    expect(calls.n).toBe(2);
    await engine.setConfig('models.dream.synthesize', 'anthropic:claude-opus-4-7');
    await run(atoms(['b0 edited', 'b1', 'b2', 'b3', 'b4']), calls);
    expect(calls.n).toBe(3);
    await run(atoms(['b0 edited', 'b1', 'b2', 'b3', 'b4']).map((a, i) => (i === 1 ? { ...a, visibility: 'private' as const } : a)), calls);
    expect(calls.n).toBe(4);
  }, 120000);
});

describe('pre-fix member hashes (D-N3 grandfathering)', () => {
  const legacyHash = (input: Atom[]) => createHash('sha256')
    .update(JSON.stringify([MODEL, 'world', input.map((a) => [a.slug, a.title, a.body]).sort((x, y) => x[0].localeCompare(y[0]))]))
    .digest('hex').slice(0, 16);
  const seedLegacy = async (hash: string, body = 'Legacy narrative.') => {
    await importFromContent(engine, 'concepts/flywheel', serializeMarkdown({
      tier: 'T2', synthesis_mode: 'llm', member_hash: hash, synthesized_at: '2026-01-01T00:00:00.000Z',
      synthesized_by: 'synthesize_concepts-v0.41', visibility: 'world',
    }, body, '', { type: 'concept', title: 'flywheel', tags: [] }), { noEmbed: true, sourceId: 'default' });
  };

  test('unchanged inputs are rehashed without a model call and keep the narrative', async () => {
    const fenced = atoms().map((a, i) => (i === 0 ? { ...a, body: withTake(a.body) } : a));
    await seedLegacy(legacyHash(fenced));
    const calls = { n: 0 };
    const r = await run(fenced, calls);
    expect(calls.n).toBe(0);
    expect((r.details as Record<string, unknown>).rehashed).toEqual(['concepts/flywheel']);
    const page = await concept();
    expect(page!.compiled_truth.trim()).toBe('Legacy narrative.');
    expect(page!.frontmatter.member_hash).not.toBe(legacyHash(fenced));
    await run(fenced, calls);
    expect(calls.n).toBe(0);
  }, 120000);

  test('a rehashed concept with a takes fence keeps one Takes section', async () => {
    const fenced = atoms().map((a, i) => (i === 0 ? { ...a, body: withTake(a.body) } : a));
    await seedLegacy(legacyHash(fenced), withTake('Legacy narrative.'));
    const calls = { n: 0 };
    const r = await run(fenced, calls);
    expect(calls.n).toBe(0);
    expect((r.details as Record<string, unknown>).rehashed).toEqual(['concepts/flywheel']);
    const page = await concept();
    expect(page!.compiled_truth.match(/^## Takes\s*$/gm)).toHaveLength(1);
    expect(parseTakesFence(page!.compiled_truth).takes.map((t) => t.claim)).toEqual(['Flywheels compound']);
    expect(page!.compiled_truth).toContain('Legacy narrative.');
  }, 120000);

  test('changed inputs under a legacy hash re-synthesize', async () => {
    await seedLegacy(legacyHash(atoms()));
    const calls = { n: 0 };
    await run(atoms(['b0 edited', 'b1', 'b2', 'b3', 'b4']), calls);
    expect(calls.n).toBe(1);
  }, 120000);
});

describe('classic rewrite keeps the page fences (D-N3)', () => {
  test('a take appended to the concept page during synthesis survives the rewrite', async () => {
    const calls = { n: 0 };
    await run(atoms(), calls);
    const appendTake = async () => {
      const page = await concept();
      await importFromContent(engine, 'concepts/flywheel', serializeMarkdown(page!.frontmatter, withTake(page!.compiled_truth), '',
        { type: 'concept', title: page!.title, tags: [] }), { noEmbed: true, sourceId: 'default' });
    };
    await run(atoms(['b0 edited', 'b1', 'b2', 'b3', 'b4']), calls, 'Narrative two.', appendTake);
    const page = await concept();
    expect(page!.compiled_truth).toContain('Narrative two.');
    expect(parseTakesFence(page!.compiled_truth).takes.map((t) => t.claim)).toEqual(['Flywheels compound']);
  }, 120000);

  test('a narrative rewritten during synthesis defers the concept and is kept', async () => {
    const calls = { n: 0 };
    await run(atoms(), calls);
    const rewrite = async () => {
      const page = await concept();
      await importFromContent(engine, 'concepts/flywheel', serializeMarkdown(page!.frontmatter, 'Edited elsewhere.', '',
        { type: 'concept', title: page!.title, tags: [] }), { noEmbed: true, sourceId: 'default' });
    };
    const r = await run(atoms(['b0 edited', 'b1', 'b2', 'b3', 'b4']), calls, 'Narrative two.', rewrite);
    expect((r.details as { publication_deferred: Array<{ concept: string }> }).publication_deferred.map((d) => d.concept)).toEqual(['flywheel']);
    expect((await concept())!.compiled_truth.trim()).toBe('Edited elsewhere.');
  }, 120000);
});
