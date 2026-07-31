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

describe.skipIf(skip)('deleteFactsForPage preserveExpiredLegacy on Postgres (#2646)', () => {
  // The PGLite side of this contract is pinned by
  // test/extract-facts-phase.test.ts; this pins the postgres.js
  // tagged-fragment SQL (the two branches interpolate `expiredLegacyFilter`
  // differently) AND the returned delete count on a real Postgres.
  const slug = 'people/expired-legacy-preserve-example';
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
  });

  afterAll(async () => {
    if (engine) {
      await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug = $1', [slug]);
      await engine.executeRaw('DELETE FROM pages WHERE slug = $1', [slug]);
      await engine.disconnect();
    }
  });

  async function seedRows(): Promise<void> {
    await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug = $1', [slug]);
    // One fence-owned active row (deletable) + one soft-expired legacy row
    // (row_num NULL, expired_at set — forget_fact's record, must survive).
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, expired_at, source_markdown_slug)
       VALUES
         ('default', $1, 'fence-owned active fact', 'fact', 'world', 'high',
          now(), 'fence:reconcile', 1.0, 1, NULL, $1),
         ('default', $1, 'forgotten legacy claim', 'fact', 'private', 'medium',
          now(), 'mcp:put_page', 1.0, NULL, now(), $1)`,
      [slug],
    );
  }

  test('no-prefix branch: expired legacy row survives, count reflects only real deletions', async () => {
    await seedRows();
    const { deleted } = await engine.deleteFactsForPage(slug, 'default', {
      preserveExpiredLegacy: true,
    });
    expect(deleted).toBe(1); // only the fence-owned row

    const rows = await engine.executeRaw<{ fact: string }>(
      'SELECT fact FROM facts WHERE source_markdown_slug = $1', [slug],
    );
    expect(Array.from(rows).map(r => r.fact)).toEqual(['forgotten legacy claim']);
  }, 30_000);

  test('prefix branch: excludeSourcePrefixes and preserveExpiredLegacy compose', async () => {
    await seedRows();
    // Add a cli:-origin row that the prefix exclusion must protect.
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, expired_at, source_markdown_slug)
       VALUES ('default', $1, 'conversation fact', 'fact', 'private', 'medium',
               now(), 'cli:extract-conversation-facts', 1.0, NULL, NULL, $1)`,
      [slug],
    );
    const { deleted } = await engine.deleteFactsForPage(slug, 'default', {
      excludeSourcePrefixes: ['cli:'],
      preserveExpiredLegacy: true,
    });
    expect(deleted).toBe(1); // only the fence-owned row

    const rows = await engine.executeRaw<{ fact: string }>(
      'SELECT fact FROM facts WHERE source_markdown_slug = $1 ORDER BY id', [slug],
    );
    expect(Array.from(rows).map(r => r.fact)).toEqual([
      'forgotten legacy claim',
      'conversation fact',
    ]);
  }, 30_000);

  test('omitted option keeps legacy wipe behavior (expired row IS deleted)', async () => {
    await seedRows();
    const { deleted } = await engine.deleteFactsForPage(slug, 'default');
    expect(deleted).toBe(2);
    const rows = await engine.executeRaw<{ fact: string }>(
      'SELECT fact FROM facts WHERE source_markdown_slug = $1', [slug],
    );
    expect(Array.from(rows)).toHaveLength(0);
  }, 30_000);
});
