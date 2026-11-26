/**
 * #10288: a fact saved without an event date stores valid_from NULL ("event date unknown").
 *
 * 1. Protects: `recall --since` (an event-time window) leaves out a fact whose event date was never given, while
 *    general recall still returns it with `valid_from: null`; a fact dated before the window stays out; a `## Facts`
 *    fence row with an empty date cell round-trips as unknown; v339 makes the column nullable without rewriting rows.
 * 2. Fails when: remember, a fence row or put_page stamp the save time as the event date, an event window matches an
 *    undated fact, or an entity read drops one.
 * 3. Real seams: remember and recall dispatched as MCP does (remote: false) on a repo-less brain, PGLite and (with
 *    DATABASE_URL) Postgres; the fence parser, renderer and extractor; the v339 migration SQL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { parseFactsFence, renderFactsTable } from '../src/core/facts-fence.ts';
import { extractFactsFromFenceText } from '../src/core/facts/extract-from-fence.ts';
import { fenceRowOf } from '../src/core/facts/unfenced-facts.ts';
import { v339 } from '../src/core/schema-migrations/v339-facts-valid-from-nullable.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const INDICATOR = 'fictional test device';
const UNDATED = 'A fictional test device was calibrated. Its event date was not recorded.';
const OLD = 'A fictional test device passed a bench test.';
const ENTITY = 'things/fictional-test-device';
const ENTITY_UNDATED = 'The fictional test device got a new label.';
const cases: { backend: string; engine: BrainEngine; close: () => Promise<void> }[] = [];
const backends = testBackends();

type RecallFact = { fact: string; valid_from: string | null; created_at: string };
async function call(engine: BrainEngine, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await dispatchToolCall(engine, op, args, { remote: false, sourceId: 'default' });
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}
const recall = async (engine: BrainEngine, args: Record<string, unknown>) =>
  ((await call(engine, 'recall', args)).facts as RecallFact[]).filter(f => f.fact.toLowerCase().includes(INDICATOR));
const storedFrom = async (engine: BrainEngine, fact: string) =>
  (await engine.executeRaw<{ valid_from: Date | string | null }>('SELECT valid_from FROM facts WHERE fact = $1', [fact]))[0]!.valid_from;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    cases.push({ backend: 'pglite', engine, close: () => engine.disconnect() });
  }
  if (backends.includes('postgres')) {
    const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 4);
    cases.push({ backend: 'postgres', engine: fixture.engine, close: fixture.close });
  }
  for (const { engine } of cases) {
    await call(engine, 'remember', { fact: UNDATED, provenance: 'synthetic-repro' });
    await call(engine, 'remember', { fact: OLD, provenance: 'synthetic-repro', valid_from: '2020-01-02T00:00:00Z' });
    await call(engine, 'remember', { fact: ENTITY_UNDATED, provenance: 'synthetic-repro', entity: ENTITY });
  }
}, 180_000);

afterAll(async () => {
  for (const fixture of cases) await fixture.close();
});

for (const backend of backends) {
  describe(`facts with an unknown event date (${backend})`, () => {
    const engine = () => cases.find(c => c.backend === backend)!.engine;

    test('remember with no valid_from stores NULL; a stated date is kept', async () => {
      expect(await storedFrom(engine(), UNDATED)).toBeNull();
      expect(await storedFrom(engine(), ENTITY_UNDATED)).toBeNull();
      expect(new Date((await storedFrom(engine(), OLD))!).toISOString()).toBe('2020-01-02T00:00:00.000Z');
    });

    test('general recall returns the undated fact with valid_from null and its save time', async () => {
      const facts = await recall(engine(), { grep: INDICATOR });
      expect(facts.map(f => f.fact).sort()).toEqual([ENTITY_UNDATED, UNDATED, OLD].sort());
      expect(facts.find(f => f.fact === UNDATED)).toMatchObject({ valid_from: null, created_at: expect.any(String) });
      expect(facts.find(f => f.fact === OLD)!.valid_from).toBe('2020-01-02T00:00:00.000Z');
    });

    test('an entity read keeps the undated fact', async () => {
      const facts = await recall(engine(), { entity: ENTITY });
      expect(facts.map(f => [f.fact, f.valid_from])).toEqual([[ENTITY_UNDATED, null]]);
    });

    test('an event-time window leaves out the undated fact and the fact dated before it', async () => {
      expect(await recall(engine(), { grep: INDICATOR, since: '24 hours ago' })).toEqual([]);
      expect(await recall(engine(), { entity: ENTITY, since: '24 hours ago' })).toEqual([]);
      expect((await recall(engine(), { grep: INDICATOR, since: '2019-12-01T00:00:00Z' })).map(f => f.fact)).toEqual([OLD]);
    });

    test('listFactsSince reads undated rows only when asked to, ordered by their save time', async () => {
      const read = (includeUndated: boolean) => engine().listFactsSince('default', new Date(0), { eventTime: true, includeUndated, grep: INDICATOR });
      expect((await read(false)).map(f => f.fact)).toEqual([OLD]);
      expect((await read(true)).map(f => f.fact)).toEqual([ENTITY_UNDATED, UNDATED, OLD]);
    });

    test('put_page: a fence row with no date cell and no page date stores NULL', async () => {
      const fence = renderFactsTable([{ rowNum: 1, active: true, claim: 'The fictional test device shipped.', kind: 'event', confidence: 1,
        visibility: 'world', notability: 'medium', source: 'synthetic-repro' }]);
      await call(engine(), 'put_page', { slug: 'things/fenced-device', content: `---\ntype: note\ntitle: Fenced device\n---\n# Fenced device\n\n## Facts\n\n${fence}\n` });
      expect(await storedFrom(engine(), 'The fictional test device shipped.')).toBeNull();
    });

    test('v339 makes valid_from nullable, keeps its default and rewrites no row', async () => {
      const column = async () => (await engine().executeRaw<{ is_nullable: string; column_default: string | null }>(
        `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'facts' AND column_name = 'valid_from'`))[0]!;
      expect((await column()).is_nullable).toBe('YES');
      await engine().executeRaw('UPDATE facts SET valid_from = created_at WHERE valid_from IS NULL');
      await engine().executeRaw('ALTER TABLE facts ALTER COLUMN valid_from SET NOT NULL');
      const before = await engine().executeRaw<{ id: number; valid_from: Date | string }>('SELECT id, valid_from FROM facts ORDER BY id');
      await engine().runMigration(339, v339.sql);
      expect(await column()).toMatchObject({ is_nullable: 'YES', column_default: 'now()' });
      expect(await engine().executeRaw('SELECT id, valid_from FROM facts ORDER BY id')).toEqual(before);
    });
  });
}

describe('## Facts fence: an empty date cell is an unknown event date', () => {
  const body = (cell: string) => [
    '## Facts', '', '<!--- gbrain:facts:begin -->',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    '|---|---|---|---|---|---|---|---|---|---|',
    `| 1 | The fictional test device shipped. | event | 1.0 | world | medium | ${cell} |  | synthetic-repro |  |`,
    '<!--- gbrain:facts:end -->', ''].join('\n');

  test('the extractor reads an empty cell as unknown, then the page date, and a stated cell as given', () => {
    const facts = parseFactsFence(body('')).facts;
    expect(facts).toHaveLength(1);
    expect(extractFactsFromFenceText(facts, ENTITY, 'default')[0]!.valid_from).toBeNull();
    const pageDate = new Date('2024-05-06T00:00:00Z');
    expect(extractFactsFromFenceText(facts, ENTITY, 'default', { pageEffectiveDate: pageDate })[0]!.valid_from).toEqual(pageDate);
    expect(extractFactsFromFenceText(parseFactsFence(body('2021-03-04')).facts, ENTITY, 'default')[0]!.valid_from).toEqual(new Date('2021-03-04T00:00:00Z'));
  });

  test('a stored NULL renders an empty cell that reads back as unknown', () => {
    const row = fenceRowOf({ kind: 'event', visibility: 'world', context: null, valid_from: null, valid_until: null, source: 'synthetic-repro',
      claim_metric: null, claim_value: null, claim_unit: null, claim_period: null, attributed_to: null, notability: 'medium', confidence: 1 },
    1, 'The fictional test device shipped.');
    expect(row.validFrom).toBeUndefined();
    const rendered = renderFactsTable([row]);
    expect(rendered).toContain('| world | medium |  |  | synthetic-repro |');
    const reread = parseFactsFence(rendered).facts;
    expect(renderFactsTable(reread)).toBe(rendered);
    expect(extractFactsFromFenceText(reread, ENTITY, 'default')[0]!.valid_from).toBeNull();
  });
});
