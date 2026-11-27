/**
 * BrainEngine parity: the error a facts writer raises when a row would duplicate a unique key of the facts table.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: rehomeEntityFacts (the ontology stint key, idx_facts_ontology_stint_dedup)
 *    and placeRelinkedFact and adoptFactIntoFence (the fence key, idx_facts_fence_key) raise, on every engine arm, an error with SQLSTATE 23505
 *    in `code`, the same message and the same schema and table, and write nothing.
 *  - Regression: an engine that raises its own code (`constraint_violation`) leaves every caller that branches on
 *    23505 (an email race, a rename collision, the origin guard) on its fall-through path, and shows a different
 *    error code to the user.
 *  - Why existing coverage misses it: the cases that exist compare the message text only.
 *  - Seam: rows come from mergeOntologyFact, insertFact and putPage. Ids differ between arms, so each case names the
 *    row it seeded. The Postgres `detail` line (the key values) and the constraint name field are not compared: PGLite
 *    does not return the constraint name, and the Rust store does not carry the key values.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string, type = 'note') => ({ type: type as 'note', title, compiled_truth: 'body', frontmatter: {} });

/** What the arms share of a database error: its SQLSTATE, text and where it came from. */
async function raised(run: () => Promise<unknown>): Promise<{ code: unknown; message: string; schema: unknown; table: unknown } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const e = error as Record<string, unknown>;
    return { code: e.code, message: String(e.message), schema: e.schema_name ?? e.schema, table: e.table_name ?? e.table };
  }
}

async function observe(engine: BrainEngine, entity: string, source: string): Promise<number> {
  const out = await engine.mergeOntologyFact({
    entitySlug: entity, dimension: 'location', value: 'Lisbon', source, validFrom: '2026-01-01T00:00:00.000Z',
  } as never);
  return Number(out.factId);
}

const entities = async (engine: BrainEngine, ...slugs: string[]) =>
  Object.fromEntries(await Promise.all(slugs.map(async (slug) =>
    [slug, (await engine.listFactsByEntity('default', slug, { activeOnly: false })).length] as const)));

describe('engine parity: unique violations of the facts table', () => {
  parityTest('rehomeEntityFacts raises the unique violation of the ontology stint key and moves nothing', {
    methods: ['putPage', 'mergeOntologyFact', 'listFactsByEntity', 'rehomeEntityFacts'],
  }, async (engine) => {
    await engine.putPage('people/new', note('New'));
    await observe(engine, 'people/new', 'meetings/a');
    await observe(engine, 'people/old', 'meetings/a');
    const error = await raised(() => engine.rehomeEntityFacts('default', 'people/old', 'people/new'));
    expect(error?.message).toContain('idx_facts_ontology_stint_dedup');
    return { error, left: await entities(engine, 'people/old', 'people/new') };
  });

  parityTest('adoptFactIntoFence raises the unique violation of the fence key and adopts nothing', {
    methods: ['putPage', 'insertFact', 'adoptFactIntoFence', 'listFactsForPage'],
  }, async (engine) => {
    await engine.putPage('people/a-example', note('A', 'person'));
    const loose = async (text: string) => String((await engine.insertFact({ fact: text, source: 'chat' }, { source_id: 'default' })).id);
    const first = await loose('first claim');
    const second = await loose('second claim');
    await engine.adoptFactIntoFence('default', first, 3, 'people/a-example', 'first claim');
    const error = await raised(() => engine.adoptFactIntoFence('default', second, 3, 'people/a-example', 'second claim'));
    expect(error?.message).toContain('idx_facts_fence_key');
    const fence = (await engine.listFactsForPage('default', 'people/a-example')).map((r) => ({ fact: r.fact, row_num: r.row_num }));
    return { error, fence };
  });

  parityTest('placeRelinkedFact raises the unique violation of the fence key and places nothing', {
    methods: ['putPage', 'insertFact', 'placeRelinkedFact', 'listFactsForPage'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', note('Alice', 'person'));
    const loose = async (text: string) => Number((await engine.insertFact({ fact: text, source: 'chat' }, { source_id: 'default' })).id);
    const first = await loose('a likes tea');
    const second = await loose('b likes coffee');
    const place = (factId: number) => engine.placeRelinkedFact('default', { factId, action: 'link', slug: 'people/alice-example', rowNum: 1, context: 'c' });
    expect(await place(first)).toBe(true);
    const error = await raised(() => place(second));
    expect(error?.message).toContain('idx_facts_fence_key');
    const fence = (await engine.listFactsForPage('default', 'people/alice-example')).map((r) => ({ fact: r.fact, row_num: r.row_num }));
    return { error, fence };
  });
});
