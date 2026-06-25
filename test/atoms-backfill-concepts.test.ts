import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  backfillAtomConcepts,
  deriveAtomConceptLabels,
} from '../src/commands/atoms.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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

async function seedAtom(slug: string, frontmatter: Record<string, unknown>, body = 'body') {
  await engine.putPage(slug, {
    title: slug,
    type: 'atom' as never,
    compiled_truth: body,
    timeline: '',
    frontmatter: { type: 'atom', ...frontmatter },
  });
}

describe('deriveAtomConceptLabels', () => {
  test('derives capped normalized labels from legacy frontmatter and concept links', () => {
    const labels = deriveAtomConceptLabels(
      {
        concept_refs: ['concepts/AI Agents', 'Founder_Psychology'],
        tags: ['#Hardware', 'AI Agents'],
        topics: ['too long '.repeat(10)],
      },
      'Mentions [[concepts/Enterprise Sales|enterprise]] and [[wiki:concepts/Physical Proof]].',
    );
    expect(labels).toEqual([
      'ai-agents',
      'founder-psychology',
      'hardware',
      'enterprise-sales',
      'physical-proof',
    ]);
  });
});

describe('backfillAtomConcepts', () => {
  test('dry-run reports deterministic candidates without mutating pages', async () => {
    await seedAtom(
      'atoms/old',
      { concept_refs: ['concepts/AI Agents'] },
      'See [[concepts/Founder Psychology]].',
    );

    const result = await backfillAtomConcepts(engine, { limit: 10 });
    expect(result.dry_run).toBe(true);
    expect(result.updated).toBe(0);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        slug: 'atoms/old',
        concepts: ['ai-agents', 'founder-psychology'],
      }),
    ]);

    const rows = await engine.executeRaw<{ frontmatter: { concepts?: string[] } }>(
      `SELECT frontmatter FROM pages WHERE slug = 'atoms/old'`,
    );
    expect(rows[0].frontmatter.concepts).toBeUndefined();
  });

  test('apply requires explicit yes and updates only capped candidates', async () => {
    await seedAtom('atoms/a', { tags: ['AI Agents'] });
    await seedAtom('atoms/b', { tags: ['Founder Psychology'] });
    await seedAtom('atoms/has-concepts', { concepts: ['already-set'], tags: ['Ignored'] });

    await expect(backfillAtomConcepts(engine, { apply: true, limit: 1 })).rejects.toThrow(/without --yes/);

    const result = await backfillAtomConcepts(engine, { apply: true, yes: true, limit: 1 });
    expect(result.updated).toBe(1);
    expect(result.candidates.length).toBe(1);

    const rows = await engine.executeRaw<{ slug: string; frontmatter: { concepts?: string[] } }>(
      `SELECT slug, frontmatter FROM pages WHERE type = 'atom' ORDER BY slug`,
    );
    const bySlug = new Map(rows.map((row) => [row.slug, row.frontmatter.concepts]));
    expect(bySlug.get('atoms/a')).toEqual(['ai-agents']);
    expect(bySlug.get('atoms/b')).toBeUndefined();
    expect(bySlug.get('atoms/has-concepts')).toEqual(['already-set']);
  });
});
