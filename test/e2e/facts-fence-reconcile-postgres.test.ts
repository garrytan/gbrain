import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../../src/core/facts-fence.ts';
import type { NewFact } from '../../src/core/engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;

if (skip) test.skip('facts-fence Postgres reconciliation skipped (DATABASE_URL unset)', () => {});

describe.skipIf(skip)('facts-fence escaped-pipe reconciliation on Postgres', () => {
  const slug = 'people/facts-pipe-roundtrip-example';
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    assertSafeE2eDatabaseUrl(databaseUrl!);
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

// v0.46 (#3014) — fence-authored supersession transport end to end on real
// Postgres (parity with the PGLite coverage in extract-facts-phase.test.ts +
// insert-facts-batch.test.ts).
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

  // Each test putPages its own fence and expects a fresh reconcile, so wipe
  // the page's DB rows first. Without this, two consecutive tests whose
  // struck rows both resolve to NULL (e.g. dangling #9 then int4-overflow
  // #99999999999) share a claim + slug, so the second reconcile sees no
  // drift and skips — correct no-churn behavior, but it would starve a test
  // that asserts a fresh warning.
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug = $1', [slug]);
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

  test('idempotent heal: a struck row with NULL columns re-populates on re-reconcile', async () => {
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

  // A dangling reference resolves to NULL every cycle and matches the DB's
  // NULL, so it must not re-drift (a naive drift term would wipe + reinsert
  // the page every cycle, advancing the fact ids).
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
    expect(second.warnings.filter(w => w.includes('superseded'))).toEqual([]);
    expect(await readIds()).toEqual(idsAfterFirst);
  }, 30_000);

  // An int4-overflowing #N would raise `integer out of range` in the
  // resolution SELECT and abort the cycle; the guard treats it as a
  // dangling reference instead.
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

  // The wipe now runs inside insertFacts' transaction, so a failing insert
  // rolls it back and the page is never left emptied.
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
      // A NULL fact violates the NOT NULL constraint AFTER the delete has
      // run inside the same transaction (the v51 index can't be used as the
      // failure trigger here — ON CONFLICT DO NOTHING absorbs collisions).
      await engine.insertFacts(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [fixture(1, 'replacement a'), fixture(2, null as any)],
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

// v0.46 (#3014) option B — the ontology-dimension writer closes a superseded
// row via valid_until + superseded_by (NOT expired_at, so getOntology's
// --asof time-travel still sees it). listSupersessions must surface it anyway
// (filter on superseded_by alone) and order/since via COALESCE(expired_at,
// valid_until). Both verified here on real Postgres.
describe.skipIf(skip)('facts supersession visibility on Postgres — ontology + since (#3014)', () => {
  const SARAH = 'people/zz-sarah-ontology-3014';
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
  });

  afterAll(async () => {
    if (engine) {
      await engine.executeRaw('DELETE FROM facts WHERE entity_slug = $1', [SARAH]);
      await engine.disconnect();
    }
  });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM facts WHERE entity_slug = $1', [SARAH]);
  });

  // founder (2024) → advisor (2026-05-01): the prior 'founder' row is closed
  // via valid_until = 2026-05-01, superseded_by set, expired_at left NULL.
  const supersede = async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a', validFrom: '2024-01-01' });
    const r = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'advisor', source: 'meetings/b', validFrom: '2026-05-01' });
    expect(r.action).toBe('superseded_prior');
  };

  test('a forward ontology supersession surfaces in listSupersessions while --asof still time-travels', async () => {
    await supersede();

    const sup = await engine.listSupersessions('default');
    const founder = sup.find(s => s.fact.includes('founder') && s.entity_slug === SARAH);
    expect(founder).toBeDefined();
    expect(founder!.superseded_by).not.toBeNull();
    // Option A ("writers set both columns") would have set expired_at here and
    // broken the --asof read below; option B leaves it NULL and surfaces anyway.
    expect(founder!.expired_at).toBeNull();

    const past = await engine.getOntology(SARAH, { asof: '2025-01-01' });
    expect(past[0].value).toBe('founder');
  }, 30_000);

  test('listSupersessions({since}) filters a NULL-expired_at row by COALESCE(expired_at, valid_until)', async () => {
    await supersede(); // founder row: valid_until = 2026-05-01, expired_at NULL

    // since before the close date → COALESCE falls back to valid_until, included.
    const included = await engine.listSupersessions('default', { since: new Date('2026-01-01T00:00:00Z') });
    expect(included.some(s => s.fact.includes('founder') && s.entity_slug === SARAH)).toBe(true);

    // since after the close date → excluded (a pre-fix `expired_at >= since`
    // would have dropped it unconditionally since expired_at is NULL).
    const excluded = await engine.listSupersessions('default', { since: new Date('2026-09-01T00:00:00Z') });
    expect(excluded.some(s => s.fact.includes('founder') && s.entity_slug === SARAH)).toBe(false);
  }, 30_000);
});
