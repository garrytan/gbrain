// synthesize_concepts must never overwrite a concept page it did not write.
// A hand-written `concepts/<x>` page that atoms happen to reference keeps its
// body; the phase records the skip and spends nothing on it.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

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
}, 120000);

const atoms = [
  { slug: 'atoms/a1', title: 'A1', body: 'b1', concept_refs: ['flywheel', 'theme'] },
  { slug: 'atoms/a2', title: 'A2', body: 'b2', concept_refs: ['flywheel', 'theme'] },
];

async function persistAtoms(): Promise<void> {
  for (const a of atoms) {
    await engine.putPage(a.slug, { type: 'atom', title: a.title, compiled_truth: a.body, timeline: '' });
  }
}

describe('synthesize_concepts human-owned pages', () => {
  test('a hand-written concept page is left untouched; synthesized pages still refresh', async () => {
    await persistAtoms();
    const human = 'HUMAN-AUTHORED: a long hand-written essay on the flywheel.';
    await importFromContent(engine, 'concepts/flywheel',
      `---\ntype: concept\ntitle: Flywheel\n---\n\n${human}\n`, { noEmbed: true, sourceId: 'default' });

    const first = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'default' });

    const flywheel = await engine.getPage('concepts/flywheel', { sourceId: 'default' });
    expect(flywheel?.compiled_truth.trim()).toBe(human);
    expect(flywheel?.frontmatter.synthesized_by).toBeUndefined();
    expect((first.details as Record<string, unknown>).skipped_human_owned).toEqual(['concepts/flywheel']);

    const theme = await engine.getPage('concepts/theme', { sourceId: 'default' });
    expect(String(theme?.frontmatter.synthesized_by)).toMatch(/^synthesize_concepts/);

    // The phase's own page is still eligible for a refresh on the next run
    // (a changed member set; an unchanged one is skipped as unchanged).
    const grown = [...atoms, { slug: 'atoms/a3', title: 'A3', body: 'b3', concept_refs: ['flywheel', 'theme'] }];
    await engine.putPage('atoms/a3', { type: 'atom', title: 'A3', compiled_truth: 'b3', timeline: '' });
    const second = await runPhaseSynthesizeConcepts(engine, { _atoms: grown, sourceId: 'default' });
    expect((second.details as Record<string, unknown>).skipped_human_owned).toEqual(['concepts/flywheel']);
    expect((second.details as Record<string, unknown>).concepts_written).toBe(1);
    const third = await runPhaseSynthesizeConcepts(engine, { _atoms: grown, sourceId: 'default' });
    expect((third.details as Record<string, unknown>).skipped_unchanged).toEqual(['concepts/theme']);
  }, 120000);

  test('the ownership check runs before any LLM spend', async () => {
    await persistAtoms();
    await importFromContent(engine, 'concepts/flywheel',
      `---\ntype: concept\ntitle: Flywheel\n---\n\nHand-written.\n`, { noEmbed: true, sourceId: 'default' });
    await importFromContent(engine, 'concepts/theme',
      `---\ntype: concept\ntitle: Theme\n---\n\nHand-written too.\n`, { noEmbed: true, sourceId: 'default' });
    const many = Array.from({ length: 12 }, (_, i) => ({ slug: `atoms/m${i}`, title: `M${i}`, body: `m${i}`, concept_refs: ['flywheel', 'theme'] }));
    let calls = 0;
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: many,
      sourceId: 'default',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _chat: (async () => { calls++; throw new Error('must not be called'); }) as any,
    });
    expect(calls).toBe(0);
    expect((result.details as Record<string, unknown>).concepts_written).toBe(0);
  }, 120000);
});
