import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../../src/core/facts-fence.ts';
import type { NewFact } from '../../src/core/engine.ts';

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

// v0.42 (#3014) — fence-authored supersession transport end to end.
describe.skipIf(skip)('facts-fence supersession transport on Postgres (#3014)', () => {
  const slug = 'people/zz-supersession-e2e-3014';
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

  // Row 1 struck + "superseded by #2"; row 2 the live superseding fact.
  const buildFence = (): string => renderFactsTable([
    {
      rowNum: 1,
      claim: 'Will close the deal by Q2',
      kind: 'commitment',
      confidence: 0.6,
      visibility: 'world',
      notability: 'medium',
      validFrom: '2026-01-01',
      source: 'call',
      context: 'superseded by #2',
      active: false,
      supersededBy: 2,
    },
    {
      rowNum: 2,
      claim: 'Deal closed in Q3',
      kind: 'fact',
      confidence: 1,
      visibility: 'world',
      notability: 'high',
      validFrom: '2026-07-01',
      source: 'call',
      active: true,
    },
  ]);

  interface SupRow { id: number | string; row_num: number | string; superseded_by: number | string | null; expired_at: Date | string | null }
  const readRows = async (): Promise<SupRow[]> =>
    Array.from(await engine.executeRaw<SupRow>(
      'SELECT id, row_num, superseded_by, expired_at FROM facts WHERE source_markdown_slug = $1 ORDER BY row_num',
      [slug],
    ));

  const readIds = async (): Promise<number[]> =>
    (await readRows()).map(r => Number(r.id));

  // Row 1 struck with an unresolvable `superseded by #N`; no target row.
  const buildDanglingFence = (ref: number): string => renderFactsTable([
    {
      rowNum: 1,
      claim: 'Retired claim with a bad reference',
      kind: 'commitment',
      confidence: 0.6,
      visibility: 'world',
      notability: 'medium',
      validFrom: '2026-01-01',
      source: 'call',
      context: `superseded by #${ref}`,
      active: false,
      supersededBy: ref,
    },
  ]);

  test('struck row lands with superseded_by + expired_at and surfaces in listSupersessions', async () => {
    await engine.putPage(slug, {
      title: 'Supersession E2E Example',
      type: 'person',
      compiled_truth: buildFence(),
      frontmatter: {},
      timeline: '',
    });
    const result = await runExtractFacts(engine, { slugs: [slug] });
    expect(result.factsInserted).toBe(2);

    const rows = await readRows();
    expect(rows).toHaveLength(2);
    const [row1, row2] = rows;
    // The struck row's page-local "#2" reference resolved to row 2's fact id.
    expect(Number(row1.superseded_by)).toBe(Number(row2.id));
    expect(row1.expired_at).not.toBeNull();
    // The live superseding row is untouched.
    expect(row2.superseded_by).toBeNull();
    expect(row2.expired_at).toBeNull();

    const sup = await engine.listSupersessions('default');
    expect(sup.some(s => s.id === Number(row1.id) && s.superseded_by === Number(row2.id))).toBe(true);
  }, 30_000);

  test('idempotent heal: a struck row with NULL columns re-populates on re-reconcile (#2932)', async () => {
    await engine.putPage(slug, {
      title: 'Supersession E2E Example',
      type: 'person',
      compiled_truth: buildFence(),
      frontmatter: {},
      timeline: '',
    });
    await runExtractFacts(engine, { slugs: [slug] });

    // Simulate the pre-#3014 mis-transport: the struck row was inserted with
    // both columns NULL. The fence is unchanged, so only the drift check on
    // the supersession columns can trigger a re-heal.
    await engine.executeRaw(
      'UPDATE facts SET superseded_by = NULL, expired_at = NULL WHERE source_markdown_slug = $1 AND row_num = 1',
      [slug],
    );
    const before = await readRows();
    expect(before.find(r => Number(r.row_num) === 1)!.superseded_by).toBeNull();

    // Re-reconcile: hasSupersessionDrift fires → wipe+reinsert heals the row.
    await runExtractFacts(engine, { slugs: [slug] });

    const after = await readRows();
    const healed = after.find(r => Number(r.row_num) === 1)!;
    const target = after.find(r => Number(r.row_num) === 2)!;
    expect(Number(healed.superseded_by)).toBe(Number(target.id));
    expect(healed.expired_at).not.toBeNull();
  }, 30_000);

  // Finding A (#3014) — a dangling reference resolves to NULL every cycle
  // and matches the DB's NULL, so it must not re-drift (pre-fix it wiped +
  // reinserted the page every cycle, advancing the fact ids).
  test('idempotent: a dangling reference does not churn on re-reconcile', async () => {
    await engine.putPage(slug, {
      title: 'Supersession E2E Example',
      type: 'person',
      compiled_truth: buildDanglingFence(9),
      frontmatter: {},
      timeline: '',
    });
    const first = await runExtractFacts(engine, { slugs: [slug] });
    expect(first.warnings.some(w => w.includes('absent from the fence'))).toBe(true);
    const idsAfterFirst = await readIds();

    const second = await runExtractFacts(engine, { slugs: [slug] });
    expect(second.factsInserted).toBe(0);
    expect(second.factsDeleted).toBe(0);
    expect(second.warnings).toEqual([]);
    expect(await readIds()).toEqual(idsAfterFirst);
  }, 30_000);

  // Finding C (#3014) — an int4-overflowing #N would raise `integer out of
  // range` in the resolution SELECT and abort the cycle; the guard treats it
  // as a dangling reference instead.
  test('int4-overflow reference (11-digit #N) resolves as dangling — cycle completes', async () => {
    await engine.putPage(slug, {
      title: 'Supersession E2E Example',
      type: 'person',
      compiled_truth: buildDanglingFence(99999999999),
      frontmatter: {},
      timeline: '',
    });
    const r = await runExtractFacts(engine, { slugs: [slug] });
    expect(r.warnings.some(w => w.includes('absent from the fence'))).toBe(true);
    const row1 = (await readRows()).find(x => Number(x.row_num) === 1)!;
    expect(row1.superseded_by).toBeNull();
    expect(row1.expired_at).not.toBeNull();
  }, 30_000);

  // Finding B (#3014) — the wipe now runs inside insertFacts' transaction, so
  // a failing insert rolls it back and the page is never left emptied.
  test('deleteForPageFirst rolls the wipe back when the insert fails — the page survives', async () => {
    type Row = NewFact & { row_num: number; source_markdown_slug: string };
    const fixture = (rowNum: number, fact: string): Row => ({
      fact,
      kind: 'fact',
      entity_slug: 'people/zz-supersession-e2e-3014',
      visibility: 'world',
      notability: 'medium',
      source: 'fence:reconcile',
      confidence: 1.0,
      row_num: rowNum,
      source_markdown_slug: slug,
    });

    await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug = $1', [slug]);
    await engine.insertFacts([fixture(1, 'keeper one'), fixture(2, 'keeper two')], { source_id: 'default' });

    let threw = false;
    try {
      // Two row_num=1 rows collide on the v51 UNIQUE index AFTER the delete
      // has run inside the same transaction.
      await engine.insertFacts(
        [fixture(1, 'replacement a'), fixture(1, 'dup collides')],
        { source_id: 'default' },
        { deleteForPageFirst: { slug, excludeSourcePrefixes: ['cli:'] } },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const facts = await engine.executeRaw<{ fact: string }>(
      'SELECT fact FROM facts WHERE source_markdown_slug = $1 ORDER BY row_num',
      [slug],
    );
    expect(Array.from(facts).map(f => f.fact)).toEqual(['keeper one', 'keeper two']);
  }, 30_000);
});
