/**
 * #6712 PR 3 (L6): the statement budget of one whole managed import of a
 * YC-shaped page (about 337 KB at 1x: 1,012 facts, 4,100 timeline rows, 50
 * code references) on PGLite, at 0.5x, 1x and 2x.
 *
 * Protects: the import writes tables and bounded chunks, never one statement
 * per row. In the page's publication transaction (preparation's writes, the
 * page, its projections and the queued effects) every statement runs the same
 * number of times at every size except the chunked set-based inserts, which
 * stay within one statement per 500 rows; the transaction stays within its
 * budget; and across the whole sync no statement text runs per row (the code
 * references used to cost one addLink per edge, 100 at 1x).
 * Fails when: a per-row (or per-reference) statement enters the import, a
 * chunked insert loses its batching, or the publication transaction grows
 * past its budget.
 * Seams: the PGLite statement counter (test/helpers/statement-counter.ts).
 * Postgres twin: test/e2e/managed-import-statement-budget.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { publicationStepTotals } from '../src/core/persistence/publication-timing.ts';
import { countPgliteStatements, type StatementRecord } from './helpers/statement-counter.ts';
import { byText, chunkOf, CHUNKED, PAGE_SLUG, prepareManagedImport, publicationOf } from './helpers/managed-import-budget.ts';
import type { YcShapedPage } from './helpers/yc-shaped-page.ts';
import { withEnv } from './helpers/with-env.ts';

/** About 10% over the measured publication transaction at 1x (#6712 L6 measured 69 on PGLite; 416 before code references were batched). */
const PUBLICATION_BUDGET = 76;
/** No statement text may run this often in one import: far above any fixed statement, far below one per row or reference. */
const PER_ROW_CEILING = 40;
const SIZES = [0.5, 1, 2] as const;

const home = mkdtempSync(join(tmpdir(), 'gbrain-import-budget-'));
/** One brain per page size, so each measured import is the first sync of its page. */
const engines = new Map<number, PGLiteEngine>();
beforeAll(async () => {
  for (const scale of SIZES) {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    engines.set(scale, engine);
  }
});
afterAll(async () => {
  for (const engine of engines.values()) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  rmSync(home, { recursive: true, force: true });
});

type Measured = { page: YcShapedPage; records: StatementRecord[]; publication: StatementRecord[] };
const runs = new Map<number, Promise<Measured>>();
function measured(scale: number): Promise<Measured> {
  const cached = runs.get(scale);
  if (cached) return cached;
  const run = measure(scale);
  runs.set(scale, run);
  return run;
}
async function measure(scale: number): Promise<Measured> {
  return withEnv({ GBRAIN_HOME: join(home, `home-${scale}`) }, async () => {
    const engine = engines.get(scale)!;
    try {
      const { page, run } = await prepareManagedImport(engine, home, `budget-${String(scale).replace('.', '-')}`, scale);
      const counter = countPgliteStatements(engine);
      const timed = publicationStepTotals();
      let result;
      try { result = await run(); } finally { counter.stop(); }
      expect(result.status).toBe('synced');
      // The publication timed its member's apply and effect queueing.
      expect(publicationStepTotals().apply.count).toBeGreaterThan(timed.apply.count);
      expect(publicationStepTotals().effects.count).toBeGreaterThan(timed.effects.count);
      expect((await engine.getPage(PAGE_SLUG, { sourceId: `budget-${String(scale).replace('.', '-')}` }))?.slug).toBe(PAGE_SLUG);
      return { page, records: counter.records, publication: publicationOf(counter.records) };
    } finally {
      await disposePersistenceConsumer(engine);
    }
  });
}

describe('managed import statement budget (PGLite)', () => {
  test('the publication transaction runs every statement the same number of times at every size, except bounded chunks', async () => {
    const [small, large] = [await measured(0.5), await measured(2)];
    const smallCounts = byText(small.publication), largeCounts = byText(large.publication);
    for (const text of new Set([...smallCounts.keys(), ...largeCounts.keys()])) {
      const chunk = chunkOf(text);
      if (chunk) {
        for (const run of [small, large]) expect(byText(run.publication).get(text) ?? 0).toBeLessThanOrEqual(Math.ceil(chunk.rows(run.page) / chunk.rowsPerChunk));
        continue;
      }
      expect({ text, count: largeCounts.get(text) ?? 0 }).toEqual({ text, count: smallCounts.get(text) ?? 0 });
    }
    for (const chunk of CHUNKED) expect([...largeCounts.keys()].some(text => chunk.pattern.test(text))).toBe(true);
  }, 240_000);

  test('the publication transaction stays within its budget at 1x', async () => {
    const { publication } = await measured(1);
    expect(publication.length).toBeLessThanOrEqual(PUBLICATION_BUDGET);
  }, 240_000);

  test('no statement runs per row or per code reference anywhere in the import', async () => {
    for (const scale of SIZES) {
      const { records, page } = await measured(scale);
      expect(page.codeRefs.length * 2).toBeGreaterThan(PER_ROW_CEILING);
      const hot = [...byText(records)].filter(([text, count]) => !chunkOf(text) && count >= PER_ROW_CEILING);
      expect(hot).toEqual([]);
    }
  }, 240_000);
});
