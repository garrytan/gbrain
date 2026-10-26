/** Real PGLite reconciliation, with page-read latency/failure injection only.
 * Guards facts/counter parity, draining before return, prefix cursors and speed.
 * Env and console spies are process-global, so this file runs serially.
 */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { runExtractFacts, type ExtractFactsOpts } from '../src/core/cycle/extract-facts.ts';
import { runCycle } from '../src/core/cycle.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const slugs = Array.from({ length: 40 }, (_, i) => `people/example-${String(i).padStart(2, '0')}`);
const cursorKey = 'dream.extract_facts.cursor.default';
const completedKey = 'dream.extract_facts.completed_at.default';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function seed() {
  for (const [i, slug] of slugs.entries()) {
    await engine.putPage(slug, { title: slug, type: 'person', frontmatter: {}, timeline: '', compiled_truth: `# Example ${i}

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Example ${i} prefers tea | preference | 0.9 | world | high | 2024-01-01 | | notes | Example ${i} |
<!--- gbrain:facts:end -->
` });
  }
}

const walk = (n: number, opts: ExtractFactsOpts = {}) => withEnv({ GBRAIN_EXTRACT_FACTS_CONCURRENCY: String(n) },
  () => runExtractFacts(engine, { maxMs: 120_000, ...opts }));

async function facts() {
  return engine.executeRaw(`SELECT source_id, entity_slug, source_markdown_slug, row_num, fact, kind, confidence,
    visibility, notability, valid_from, valid_until, source, context, expired_at, superseded_by,
    claim_metric, claim_value, claim_unit, claim_period, embedding IS NULL AS no_embedding
    FROM facts ORDER BY source_id, source_markdown_slug, row_num`);
}

/** Root-engine reads only; transaction reads/writes and watermarks stay real. */
async function withReads<T>(beforeRead: (slug: string) => Promise<void>, run: () => Promise<T>): Promise<T> {
  const read = engine.getPage;
  const spy = spyOn(engine, 'getPage').mockImplementation(async function (this: PGLiteEngine, slug, opts) {
    if (this === engine && slugs.includes(slug)) await beforeRead(slug);
    return read.call(this, slug, opts);
  });
  try { return await run(); } finally { spy.mockRestore(); }
}

test('forty pages have identical facts and all result counters at concurrency 1 and 6', async () => {
  await seed();
  const single = await walk(1, { slugs: [...slugs] });
  const expected = await facts();
  expect(expected).toHaveLength(40);
  expect(single).toMatchObject({ concurrency: 1, pagesScanned: 40, pagesWithFacts: 40, factsInserted: 40, pagesFailed: 0 });
  await resetPgliteState(engine);
  await seed();
  const log = spyOn(console, 'error').mockImplementation(() => {});
  let parallel;
  try {
    parallel = await walk(6, { slugs: [...slugs] });
    expect(log.mock.calls.filter(([line]) => line === '[extract_facts] source default: concurrency 6')).toHaveLength(1);
  } finally { log.mockRestore(); }
  expect(await facts()).toEqual(expected);
  expect({ ...parallel, concurrency: 1, warnings: parallel.warnings.toSorted() })
    .toEqual({ ...single, warnings: single.warnings.toSorted() });
  // All no-op pages settle their OWN revision, even when reads overlap.
  await engine.executeRaw('DELETE FROM page_facts_reconcile');
  const noop = await walk(6, { slugs: [...slugs] });
  expect(noop).toMatchObject({ pagesScanned: 40, factsInserted: 0, factsUpdated: 0, factsDeleted: 0 });
  const [watermarks] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p
    JOIN page_facts_reconcile r ON r.page_id = p.id WHERE p.slug LIKE 'people/example-%'
    AND r.outcome = 'complete' AND r.reconciled_revision = p.knowledge_revision`);
  expect(watermarks.n).toBe(40);
});

test('duplicate explicit slugs admit a page only once', async () => {
  await seed();
  const result = await walk(6, { slugs: [slugs[0], slugs[0]] });
  expect(result).toMatchObject({ pages_total: 1, pagesScanned: 1, factsInserted: 1, pages_remaining: 0 });
  expect(await facts()).toHaveLength(1);
});

test('budget stops mid-walk, drains started pages, saves the first unfinished slug and resumes to completion', async () => {
  await seed();
  let now = 0;
  const starts: string[] = [];
  const partial = await withReads(async slug => {
    starts.push(slug);
    await Promise.resolve(); // let the first batch start before expiring its budget
    now = 1;
  }, () => walk(6, { maxMs: 1, now: () => now }));
  expect(starts).toEqual(slugs.slice(0, 6));
  expect(partial).toMatchObject({ pagesScanned: 6, factsInserted: 6, pages_remaining: 34, budget_exhausted: true });
  expect(await facts()).toHaveLength(6); // no in-flight page was abandoned
  expect(await engine.getConfig(cursorKey)).toBe(slugs[6]);
  expect(await engine.getConfig(completedKey)).toBeNull();
  const resumedStarts: string[] = [];
  const rest = await withReads(async slug => { resumedStarts.push(slug); }, () => walk(6));
  expect(resumedStarts[0]).toBe(slugs[6]);
  expect(resumedStarts).toEqual(slugs.slice(6));
  expect(rest).toMatchObject({ resumed_from: slugs[6], factsInserted: 34, pages_remaining: 0, budget_exhausted: false });
  expect(await facts()).toHaveLength(40);
  expect(await engine.getConfig(cursorKey)).toBe('');
  expect(await engine.getConfig(completedKey)).toBeTruthy();
});

test('a throwing page does not stop the others and the cursor moves past it like the sequential walk', async () => {
  await seed();
  const poison = slugs[7];
  // A real transaction failure, after its page revision was read.
  await engine.executeRaw(`CREATE FUNCTION test_concurrency_poison() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN IF NEW.source_markdown_slug = '${poison}' THEN RAISE EXCEPTION 'injected page failure'; END IF;
    RETURN NEW; END $fn$`);
  await engine.executeRaw('CREATE TRIGGER test_concurrency_poison BEFORE INSERT ON facts FOR EACH ROW EXECUTE FUNCTION test_concurrency_poison()');
  try {
    const result = await walk(6, { slugs: [...slugs] });
    expect(await engine.getConfig(cursorKey)).toBe('');
    expect(result).toMatchObject({ pagesScanned: 40, factsInserted: 39, pagesFailed: 1, pages_remaining: 0, budget_exhausted: false });
    expect(result.warnings).toContainEqual(expect.stringContaining(`${poison}: FACTS_RECONCILE_FAILED: injected page failure`));
    expect(await facts()).toHaveLength(39);
    expect(await engine.getConfig(completedKey)).toBeNull();
    const [watermark] = await engine.executeRaw<{ outcome: string }>(`SELECT r.outcome FROM page_facts_reconcile r
      JOIN pages p ON p.id = r.page_id WHERE p.slug = $1`, [poison]);
    expect(watermark.outcome).toBe('deferred');
  } finally {
    await engine.executeRaw('DROP TRIGGER test_concurrency_poison ON facts');
    await engine.executeRaw('DROP FUNCTION test_concurrency_poison()');
  }
  const retry = await walk(6, { slugs: [...slugs] });
  expect(retry).toMatchObject({ resumed_from: null, pagesScanned: 40, factsInserted: 1, pagesFailed: 0, pages_remaining: 0 });
  expect(await facts()).toHaveLength(40);
  expect(await engine.getConfig(cursorKey)).toBe('');
});

test('concurrency 6 is at least 3x faster on 36 pages with 50ms page-read latency', async () => {
  await seed();
  const targets = slugs.slice(0, 36);
  // Warm the index so both timed runs do identical no-op work, including watermark settlement.
  await walk(1, { slugs: targets });
  const timed = (n: number) => withReads(async () => { await new Promise(resolve => setTimeout(resolve, 50)); }, async () => {
    const start = performance.now();
    const result = await walk(n, { slugs: targets });
    return { ms: performance.now() - start, result };
  });
  const single = await timed(1);
  const parallel = await timed(6);
  expect(single.result.pagesScanned).toBe(36);
  expect(parallel.result.pagesScanned).toBe(36);
  console.info(`36 pages at 50ms/read: sequential=${single.ms.toFixed(0)}ms parallel=${parallel.ms.toFixed(0)}ms speedup=${(single.ms / parallel.ms).toFixed(2)}x`);
  expect(single.ms / parallel.ms).toBeGreaterThanOrEqual(3);
});

test('dry runs and unbounded walks retain sequential admission despite the knob', async () => {
  await seed();
  for (const opts of [{ dryRun: true }, { maxMs: undefined }]) {
    let active = 0;
    let peak = 0;
    const result = await withReads(async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
    }, () => walk(6, { slugs: slugs.slice(0, 6), ...opts }));
    expect(peak).toBe(1);
    expect(result.concurrency).toBe(1);
  }
});

test('abort stops admission and awaits the started batch before returning its cursor', async () => {
  await seed();
  const controller = new AbortController();
  const starts: string[] = [];
  const result = await withReads(async slug => {
    starts.push(slug);
    await Promise.resolve();
    controller.abort();
  }, () => walk(6, { slugs: [...slugs], signal: controller.signal }));
  expect(starts).toEqual(slugs.slice(0, 6));
  expect(result).toMatchObject({ pagesScanned: 6, factsInserted: 0, pagesFailed: 0, pages_remaining: 40 });
  expect(await engine.getConfig(cursorKey)).toBe(slugs[0]);
  const outcomes = await engine.executeRaw<{ outcome: string }>('SELECT outcome FROM page_facts_reconcile');
  expect(outcomes).toHaveLength(6);
  expect(outcomes.every(r => r.outcome === 'cancelled')).toBe(true);
});

test('managed pages publish and settle their own revisions before the pool finishes', async () => {
  await seed();
  await engine.setConfig('sync.write_through', 'false');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const result = await walk(6, { slugs: [...slugs] });
  expect(result).toMatchObject({ concurrency: 6, pagesScanned: 40, factsInserted: 40, pagesFailed: 0, pages_remaining: 0 });
  expect(await facts()).toHaveLength(40);
  const [published] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests
    WHERE state = 'committed' AND intent->>'kind' = 'managed_maintenance_fence_facts'`);
  expect(published.n).toBe(40);
  await engine.executeRaw('DELETE FROM page_facts_reconcile');
  expect((await walk(6, { slugs: [...slugs] })).factsInserted).toBe(0);
  const [settled] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p
    JOIN page_facts_reconcile r ON r.page_id = p.id WHERE p.slug LIKE 'people/example-%'
    AND r.outcome = 'complete' AND r.reconciled_revision = p.knowledge_revision`);
  expect(settled.n).toBe(40);
});

test('the dream cycle JSON details report the concurrency used', async () => {
  await seed();
  await withEnv({ GBRAIN_EXTRACT_FACTS_CONCURRENCY: '6' }, async () => {
    const report = await runCycle(engine, { brainDir: null, phases: ['extract_facts'], phaseBudgetSeconds: 120 });
    const phase = JSON.parse(JSON.stringify(report)).phases.find((p: { phase: string }) => p.phase === 'extract_facts');
    expect(phase.status).not.toBe('fail');
    expect(phase.details).toMatchObject({ concurrency: 6, pagesScanned: 40, factsInserted: 40, pagesFailed: 0 });
  });
});
