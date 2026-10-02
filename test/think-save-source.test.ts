/**
 * #5426: `think --save` wrote every synthesis to source `default` and bound
 * its citations by bare slug, so on a multi-source brain the synthesis landed
 * in the wrong source and its evidence could point at a same-slug page in
 * another source. persistSynthesis now takes the think's scope from all three
 * callers (CLI think, the think op, auto-think).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { persistSynthesis, type ThinkResult } from '../src/core/think/index.ts';

let engine: PGLiteEngine;
let defaultAliceId: number;
let alphaAliceId: number;

function synthesis(question: string): ThinkResult {
  return {
    question,
    answer: 'Alice leads Acme [people/alice-example#1].',
    gaps: [],
    citations: [{ page_slug: 'people/alice-example', row_num: 1, citation_index: 1 }],
    modelUsed: 'stub',
    pagesGathered: 1,
    takesGathered: 1,
    warnings: [],
    synthesisOk: true,
  } as unknown as ThinkResult;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alpha', 'Alpha'), ('beta', 'Beta') ON CONFLICT (id) DO NOTHING`);
  defaultAliceId = (await engine.putPage('people/alice-example', { title: 'Alice', type: 'person', compiled_truth: 'Default Alice.' })).id;
  alphaAliceId = (await engine.putPage('people/alice-example', { title: 'Alice', type: 'person', compiled_truth: 'Alpha Alice.' }, { sourceId: 'alpha' })).id;
  expect(alphaAliceId).not.toBe(defaultAliceId);
  await engine.addTakesBatch([
    { page_id: defaultAliceId, row_num: 1, claim: 'Default claim', kind: 'fact', holder: 'world', weight: 1 },
    { page_id: alphaAliceId, row_num: 1, claim: 'Alpha claim', kind: 'fact', holder: 'world', weight: 1 },
  ]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

async function evidenceFor(slug: string, sourceId: string): Promise<number[]> {
  const rows = await engine.executeRaw<{ take_page_id: number }>(
    `SELECT e.take_page_id FROM synthesis_evidence e JOIN pages p ON p.id = e.synthesis_page_id WHERE p.slug = $1 AND p.source_id = $2`,
    [slug, sourceId],
  );
  return rows.map(r => Number(r.take_page_id));
}

describe('#5426 think --save persists into the think source', () => {
  test('the synthesis lands in the requested source and cites that source\'s page', async () => {
    const saved = await persistSynthesis(engine, synthesis('alpha question'), { sourceId: 'alpha' });
    const rows = await engine.executeRaw<{ source_id: string }>(`SELECT source_id FROM pages WHERE slug = $1`, [saved.slug]);
    expect(rows.map(r => r.source_id)).toEqual(['alpha']);
    expect(await evidenceFor(saved.slug, 'alpha')).toEqual([alphaAliceId]);
  });

  test('a citation outside the gathered sources is not bound to a same-slug page elsewhere', async () => {
    const saved = await persistSynthesis(engine, synthesis('beta question'), { sourceId: 'beta' });
    expect(saved.warnings).toContain('CITATION_PAGE_NOT_IN_BRAIN: people/alice-example#1');
    expect(await evidenceFor(saved.slug, 'beta')).toEqual([]);
  });

  test('a federated think binds to a gathered source, preferring its own', async () => {
    const saved = await persistSynthesis(engine, synthesis('federated question'), { sourceId: 'beta', allowedSources: ['beta', 'alpha'] });
    expect(await evidenceFor(saved.slug, 'beta')).toEqual([alphaAliceId]);
  });

  test('an unscoped think keeps the default source', async () => {
    const saved = await persistSynthesis(engine, synthesis('unscoped question'));
    const rows = await engine.executeRaw<{ source_id: string }>(`SELECT source_id FROM pages WHERE slug = $1`, [saved.slug]);
    expect(rows.map(r => r.source_id)).toEqual(['default']);
  });

  test('all three callers pass their scope', () => {
    // test-reads-source-ok[structural]: the three callers need a live LLM synthesis to observe end to end; persistSynthesis itself is tested above.
    const read = (p: string) => readFileSync(resolve(import.meta.dir, '..', p), 'utf-8');
    expect(read('src/commands/think.ts')).toContain('persistSynthesis(engine, result, { sourceId, allowedSources })');
    expect(read('src/core/ops/takes.ts')).toMatch(/persistSynthesis\(ctx\.engine, result, \{[\s\S]*?sourceId: ctx\.sourceId === ALL_SOURCES \? undefined : ctx\.sourceId/);
    expect(read('src/core/cycle/auto-think.ts')).toContain('persistSynthesis(engine, result, opts.sourceId ? { sourceId: opts.sourceId } : {})');
  });
});
