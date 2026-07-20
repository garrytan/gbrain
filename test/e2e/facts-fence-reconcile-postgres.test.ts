import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../../src/core/facts-fence.ts';

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;

if (skip) test.skip('facts-fence Postgres reconciliation skipped (DATABASE_URL unset)', () => {});

describe.skipIf(skip)('facts-fence escaped-pipe reconciliation on Postgres', () => {
  const slug = 'people/facts-pipe-roundtrip-example';
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
  });

  afterAll(async () => {
    if (engine) {
      await engine.executeRaw('DELETE FROM pages WHERE slug = $1', [slug]);
      await engine.disconnect();
    }
  });

  test('render → parse → reconcile preserves pipes, backslashes, empty cells, and adjacent rows', async () => {
    const facts: ParsedFact[] = [
      {
        rowNum: 1,
        claim: 'scores correct|incorrect|partial',
        kind: 'fact',
        confidence: 1,
        visibility: 'world',
        notability: 'high',
        validFrom: '2026-07-10',
        source: String.raw`consumer\facts|review`,
        context: String.raw`left|right\tail`,
        active: true,
      },
      {
        rowNum: 2,
        claim: 'ordinary adjacent fact',
        kind: 'fact',
        confidence: 0.8,
        visibility: 'private',
        notability: 'medium',
        active: true,
      },
    ];
    const rendered = renderFactsTable(facts);
    expect(parseFactsFence(rendered)).toMatchObject({ warnings: [], facts });

    await engine.putPage(slug, {
      title: 'Facts Pipe Roundtrip Example',
      type: 'person',
      compiled_truth: rendered,
      frontmatter: {},
      timeline: '',
    });
    const result = await runExtractFacts(engine, { slugs: [slug] });
    const rows = await engine.executeRaw<{ fact: string; row_num: number; source: string; context: string | null }>(
      'SELECT fact, row_num, source, context FROM facts WHERE source_markdown_slug = $1 ORDER BY row_num',
      [slug],
    );

    expect(result.warnings.some(w => w.includes('FACTS_TABLE_MALFORMED'))).toBe(false);
    expect(result.factsInserted).toBe(2);
    expect(Array.from(rows)).toEqual([
      { fact: facts[0].claim, row_num: 1, source: facts[0].source!, context: facts[0].context! },
      { fact: facts[1].claim, row_num: 2, source: 'fence:reconcile', context: null },
    ]);
  }, 30_000);
});
