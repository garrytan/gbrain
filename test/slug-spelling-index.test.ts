/**
 * The lookup for the other spellings of a missing slug (a page stored with capitals, or in decomposed Unicode, before
 * writes composed every slug) reads a bounded number of rows, even when the slug is made only of non-ASCII letters.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Contract: a read of a missing all-CJK slug in a source that holds hundreds of all-CJK pages reads a handful of
 *     rows and its statement is answered by the `idx_pages_spelling_key` index (PGLite and Postgres); a page stored
 *     with capital Greek, Cyrillic, Turkish dotted I, Kelvin sign, Angstrom sign or decomposed capitals is still found
 *     by its normal slug; a slug with more capital variants than the cap (32) is still answered, by the older scan.
 *  2. Regression: N1 in the review of PR 9944 (the fallback scan of every page whose ASCII-only key is empty, 200 rows a
 *     page on an unindexed expression).
 *  3. Existing coverage: test/slug-legacy-rows.test.ts, test/slug-normalize-reads.test.ts and
 *     test/engine-parity/slug-normalize.test.ts keep the result of the lookup pinned; this file pins its cost.
 *  4. Seam: none. Real engines and the registry's `get_page`; the statements the lookup sends are recorded by wrapping
 *     `executeRaw`, then explained as sent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { normalizeSlug } from '../src/core/utils.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [];

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    engines.push({ engine, close: () => engine.disconnect() });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push({ engine: pg.engine, close: pg.close });
  }
}, 180_000);
afterAll(async () => { for (const { close } of engines) await close(); }, 60_000);

/** The most capital spellings of one slug the lookup probes by index; a slug with more is answered by the scan. */
const VARIANT_CAP = 32;

interface Recorded { sql: string; args: unknown[]; rows: number }

/** `get_page` of `slug` in `sourceId`, with every raw statement the read sent. */
async function read(engine: BrainEngine, sourceId: string, slug: string): Promise<{ page?: { slug: string }; error?: { code?: string; detail?: string }; sent: Recorded[] }> {
  const sent: Recorded[] = [];
  const recording = new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') {
        return async (sql: string, args?: unknown[]) => {
          const rows = await target.executeRaw(sql, args);
          sent.push({ sql, args: args ?? [], rows: rows.length });
          return rows;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const ctx = { engine: recording, config: { engine: engine.kind, embedding_disabled: true } as never, remote: false, sourceId,
    dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  try { return { page: await operationsByName.get_page!.handler(ctx, { slug }) as { slug: string }, sent }; }
  catch (error) { return { error: error as { code?: string; detail?: string }, sent }; }
}

async function addSource(engine: BrainEngine, id: string): Promise<void> {
  await engine.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [id]);
}
/** A page stored under exactly `slug`, as a writer from before slugs were composed left it. */
async function store(engine: BrainEngine, sourceId: string, slug: string): Promise<void> {
  await engine.executeRaw('INSERT INTO pages(source_id, slug, type, title) VALUES ($1, $2, \'note\', $2)', [sourceId, slug]);
}
/** The lookup's own statement among those a read sent (the one that pages through stored slugs). */
const lookupOf = (sent: Recorded[]): Recorded | undefined => sent.find(s => /FROM pages/.test(s.sql) && /LIMIT 200/.test(s.sql));
const usesScan = (statement: Recorded): boolean => statement.sql.includes('[^a-z0-9]');

interface PlanNode { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; Plans?: PlanNode[] }
async function explain(engine: BrainEngine, statement: Recorded): Promise<PlanNode[]> {
  const [row] = await engine.executeRaw<{ 'QUERY PLAN': PlanNode[] | string }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, statement.args);
  const raw = row!['QUERY PLAN'];
  const plan = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
  const nodes: PlanNode[] = [];
  const walk = (node: PlanNode) => { nodes.push(node); node.Plans?.forEach(walk); };
  walk(plan[0]!.Plan);
  return nodes;
}

for (const kind of backends) {
  describe(`${kind}: the stored-spelling lookup`, () => {
    const brain = () => engines.find(e => e.engine.kind === kind)!.engine;
    const A = `spell-a-${kind}`;
    const B = `spell-b-${kind}`;
    const cjk = (n: number) => String.fromCodePoint(0x4e00 + n) + String.fromCodePoint(0x4e00 + n + 1) + String.fromCodePoint(0x4e00 + n + 2);

    beforeAll(async () => {
      const engine = brain();
      await addSource(engine, A); await addSource(engine, B);
      // 450 pages whose slug is only CJK letters: every one has an empty ASCII-only key.
      await engine.executeRaw(
        `INSERT INTO pages(source_id, slug, type, title)
         SELECT $1, chr(19968 + n) || chr(19969 + n) || chr(19970 + n), 'note', 'p' FROM generate_series(100, 549) AS n`, [A]);
      await engine.executeRaw(
        `INSERT INTO pages(source_id, slug, type, title)
         SELECT $1, chr(19968 + n) || chr(19969 + n) || chr(19970 + n), 'note', 'p' FROM generate_series(100, 149) AS n`, [B]);
      await engine.executeRaw('ANALYZE pages');
    }, 120_000);

    test('a missing all-CJK slug reads a bounded number of rows, and its statement is answered by the spelling index', async () => {
      const engine = brain();
      const { error, sent } = await read(engine, A, cjk(700));
      expect(error?.code).toBe('page_not_found');
      expect(sent.reduce((total, s) => total + s.rows, 0)).toBeLessThanOrEqual(10);
      const statement = lookupOf(sent);
      expect(statement).toBeDefined();
      const plan = await explain(engine, statement!);
      expect(plan.filter(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'pages')).toEqual([]);
      expect(plan.map(n => n['Index Name'])).toContain('idx_pages_spelling_key');
      const touched = plan.filter(n => n['Relation Name'] === 'pages').reduce((total, n) => total + (n['Actual Rows'] ?? 0) * (n['Actual Loops'] ?? 1), 0);
      expect(touched).toBeLessThanOrEqual(5);
    });

    test('an all-CJK slug that is stored is read directly, and one stored only in another source is not found', async () => {
      const engine = brain();
      expect((await read(engine, A, cjk(100))).page?.slug).toBe(cjk(100));
      await store(engine, B, 'ΖΕΥΣ');
      expect((await read(engine, A, 'ζευς')).error?.code).toBe('page_not_found');
      expect((await read(engine, B, 'ζευς')).page?.slug).toBe('ΖΕΥΣ');
    });

    const spellings: Array<[string, string, string]> = [
      ['Greek capitals', 'ΑΘΗΝΑ', 'αθηνα'],
      ['Greek capitals with a final sigma', 'ΟΔΟΣ', 'οδος'],
      ['Cyrillic capitals', 'МОСКВА', 'москва'],
      ['a capitalised first letter', 'Москва-центр', 'москва-центр'],
      ['accented capitals mixed with ASCII', 'Place/ÉCOLE-Nord', 'place/école-nord'],
      ['a decomposed capital', 'E\u0301cole-nfd', 'école-nfd'],
      ['the Turkish dotted capital I (U+0130)', 'İstanbul', 'i\u0307stanbul'],
      ['the Kelvin sign (U+212A)', '\u212Aelvin', 'kelvin'],
      ['the Angstrom sign (U+212B)', '\u212Bngstrom', 'ångstrom'],
      ['CJK between capital Greek letters', 'ΣΟΦΙΑ-中文', 'σοφια-中文'],
    ];
    for (const [what, stored, wanted] of spellings) {
      test(`a page stored with ${what} is found by its normal slug`, async () => {
        const engine = brain();
        expect(normalizeSlug(stored)).toBe(wanted);
        await store(engine, A, stored);
        const { page, sent } = await read(engine, A, normalizeSlug(stored));
        expect(page?.slug).toBe(stored);
        expect(usesScan(lookupOf(sent)!)).toBe(false);
      });
    }

    test('a slug with the most capital variants the cap allows is probed by the index, one with more by the scan; both find their pages', async () => {
      const engine = brain();
      const five = 'αβγδε';  // two spellings for each of five letters: 2^5 variants
      const six = 'αβγδεζ';  // 2^6 variants: past the cap
      expect(2 ** 5).toBe(VARIANT_CAP);
      expect(2 ** 6).toBeGreaterThan(VARIANT_CAP);
      await store(engine, A, 'ΑβΓδΕ'); await store(engine, A, 'ΑΒΓΔΕΖ');
      const atCap = await read(engine, A, five);
      expect(atCap.page?.slug).toBe('ΑβΓδΕ');
      expect(usesScan(lookupOf(atCap.sent)!)).toBe(false);
      const pastCap = await read(engine, A, six);
      expect(pastCap.page?.slug).toBe('ΑΒΓΔΕΖ');
      expect(usesScan(lookupOf(pastCap.sent)!)).toBe(true);
    });

    test('every capital letter of Unicode that lowercases to something else finds its page by the normal slug', async () => {
      const engine = brain();
      const stored: string[] = [];
      for (let cp = 0x80; cp < 0x20000; cp++) {
        if (cp >= 0xd800 && cp < 0xe000) continue;
        const ch = String.fromCodePoint(cp);
        if (ch.toLowerCase() === ch) continue;
        stored.push(`sweep${cp.toString(16)}${ch}z`);
      }
      expect(stored.length).toBeGreaterThan(1000);
      await engine.executeRaw(`INSERT INTO pages(source_id, slug, type, title) SELECT $1, s, 'note', 'p' FROM unnest($2::text[]) AS s`, [A, stored]);
      const missed: string[] = [];
      for (const slug of stored) {
        const { page } = await read(engine, A, normalizeSlug(slug));
        if (page?.slug !== slug) missed.push(slug);
      }
      expect(missed).toEqual([]);
    }, 240_000);
  });
}
