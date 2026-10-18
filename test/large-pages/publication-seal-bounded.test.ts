/**
 * The seal decision of a segmented write's publication reads no more than the write's own delta (flip lane C).
 *
 * 1. Protects: applySegmentedBody decides whether the publication seals the page (every occurrence chunked, no stale
 *    chunk row stored) without reading the page: the stale-row probe (projection.ts STALE_CHUNKS_SQL, one index walk
 *    over every occurrence of the page plus every row of each live one) and the live manifest read run in preparation.
 *    The publication transaction reads content_chunks and page_body_manifest only through the generation flip
 *    (flipBodyGeneration), the segmented version retention prune (page-state/versions.ts pruneSegmentedVersions: the
 *    page's closed manifest rows a kept version pins) and the delta DELETE of chunk rows a dead preparation staged under
 *    the new generation. A small
 *    edit near the end of a 2 MiB and an 8 MiB page still seals in its publication, and its new text is a keyword hit at
 *    once.
 * 2. Fails when: any other statement reading either table runs inside the publication transaction (the probe moved
 *    back in, where its cost grows with the page and declareDurablePersistence's 5 s statement_timeout can end it on a
 *    loaded host, 57014); when the publication stops sealing (the post-commit projection is lost here, so only the
 *    publication can seal); when the delta DELETE examines more than the staged rows on fresh statistics; or when, on
 *    statistics taken before the page existed, it examines more than the page's chunk rows or reaches them through a
 *    sequential scan or a per-row subplan. That last state is a known gap: every content_chunks index leads with
 *    page_id, a page_id outside the statistics is estimated at one row on each of them, and the planner can take
 *    idx_chunks_page and filter the page's rows by generation.
 * 3. Existing coverage: second-write-deferred-retire.test.ts keeps a page whose earlier write deferred its retirement
 *    unsealed; chunk-retirement-plan.test.ts bounds the probe itself.
 * 4. Statements are captured on both paths a transaction runs SQL (executeRaw and the engine-sql executor the engine
 *    methods use) and matched by shape. Work is EXPLAIN (ANALYZE, FORMAT JSON) of each executeRaw statement on either
 *    table (inside a savepoint rolled back before the real statement runs): rows produced plus rows removed by filters,
 *    times loops, summed over plan nodes. Counts, never time. Statistics are set by an explicit ANALYZE before or after
 *    the page's first write, with PGLite's row-delta ANALYZE and Postgres autovacuum off for the table. Runs on PGLite,
 *    and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import type { SqlExecutor } from '../../src/core/engine-sql/executor.ts';
import { renderFragment, type SqlFragment } from '../../src/core/engine-sql/fragment.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-publication-seal-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GBRAIN_PLANNER_AUTO_ANALYZE: '0' };
afterAll(() => { rmSync(home, { recursive: true, force: true }); });
const PROJECTION_PAGE_READ = "FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL AND body_storage='segmented'";

interface PlanNode { 'Node Type'?: string; 'Index Name'?: string; 'Parent Relationship'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number;
  'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number; Plans?: PlanNode[] }
interface Statement { sql: string; rows?: number; nodes?: string[]; subplan?: boolean }

const TABLES = /content_chunks|page_body_manifest/;
const DELTA_DELETE = /^DELETE FROM content_chunks WHERE page_id=\$1 AND body_generation=\$2 AND NOT \(chunk_index = ANY\(\$3::int\[\]\)\)$/;
/** The generation flip's statements on the two tables (engine-sql/page-body.ts flipBodyGeneration). */
const FLIP = [
  /^SELECT count\(\*\)::bigint AS n FROM content_chunks c WHERE c\.page_id = \$1 AND \(/,
  /^UPDATE page_body_manifest SET gen_to = \$1::bigint WHERE page_id = \$2 AND gen_to IS NULL AND staging_id IS NULL AND occurrence_id = ANY\(/,
  /^DELETE FROM content_chunks c WHERE c\.page_id = \$1 AND \(/,
  /^UPDATE page_body_manifest SET staging_id = NULL WHERE page_id = \$1 AND staging_id = \$2::uuid$/,
];
/** Segmented version retention (page-state/versions.ts pruneSegmentedVersions), run when the write snapshots the prior version. */
const VERSION_PRUNE = /^WITH v AS \( SELECT id, body_generation AS g, row_number\(\) OVER \(ORDER BY id DESC\) AS rk FROM page_versions WHERE page_id = \$1 AND body_storage = 'segmented'\), pinned AS \(/;
const shape = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function examined(node: PlanNode): number {
  const loops = node['Actual Loops'] ?? 1;
  const own = ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * loops;
  return own + (node.Plans ?? []).reduce((n, child) => n + examined(child), 0);
}
const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];

/** An engine-sql executor that records each statement it runs on either table. */
function recordingExecutor(exec: SqlExecutor, log: Statement[]): SqlExecutor {
  const note = (sql: string) => { if (TABLES.test(sql)) log.push({ sql: shape(sql) }); };
  return new Proxy(exec, { get(target, prop) {
    if (prop === 'query' || prop === 'executeRaw' || prop === 'unsafe') return (sql: string, ...rest: unknown[]) => { note(sql); return (target[prop] as Function)(sql, ...rest); };
    if (prop === 'run') return (fragment: SqlFragment, opts?: unknown) => { note(renderFragment(fragment).text); return target.run(fragment, opts as never); };
    if (prop === 'transaction') return <T>(fn: (tx: SqlExecutor) => Promise<T>) => target.transaction(tx => fn(recordingExecutor(tx, log)));
    return Reflect.get(target, prop, target);
  } });
}

/** Whether `prop` is a method of `target`'s class chain (a function value on a prototype, not an own property or a getter). */
function isMethod(target: object, prop: PropertyKey): boolean {
  if (Object.prototype.hasOwnProperty.call(target, prop)) return false;
  for (let proto = Object.getPrototypeOf(target); proto; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    if (descriptor) return typeof descriptor.value === 'function';
  }
  return false;
}

/**
 * `tx` with every statement on either table recorded: engine methods run on the proxy, so their engine-sql executor
 * records too; each executeRaw statement is also measured first, in a savepoint rolled back before it runs.
 */
function measuredTx(tx: BrainEngine, log: Statement[]): BrainEngine {
  const proxy: BrainEngine = new Proxy(tx, { get(target, prop) {
    if (prop === 'engineSql') return recordingExecutor(Reflect.get(target, prop, target) as SqlExecutor, log);
    if (prop === 'executeRaw') return async (sql: string, params?: unknown[], opts?: unknown) => {
      if (TABLES.test(sql)) {
        await target.executeRaw('SAVEPOINT plan_probe');
        const [row] = await target.executeRaw<Record<string, unknown>>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
        await target.executeRaw('ROLLBACK TO SAVEPOINT plan_probe');
        const raw = Object.values(row!)[0];
        const plan = ((typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>)[0]!.Plan;
        const nodes = planNodes(plan);
        log.push({ sql: shape(sql), rows: examined(plan), nodes: nodes.map(n => `${n['Node Type'] ?? ''}${n['Index Name'] ? ` on ${n['Index Name']}` : ''}`), subplan: nodes.some(n => n['Parent Relationship'] === 'SubPlan' || n['Parent Relationship'] === 'InitPlan') });
      }
      return target.executeRaw(sql, params, opts as never);
    };
    // A class method runs on the proxy, so its \`this.engineSql\` records; own properties (a driver handle) pass through untouched.
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' && isMethod(target, prop) ? value.bind(proxy) : value;
  } });
  return proxy;
}

/**
 * The engine whose publication transaction (the one the generation flip runs in, `segmented:flipped`) has its statements
 * recorded into `publication`, and whose post-commit projection is lost (its page read throws), so only the publication seals.
 */
function measuredWrite(engine: BrainEngine, publication: Statement[]): BrainEngine {
  return new Proxy(engine, { get(target, prop) {
    if (prop === 'executeRaw') return (sql: string, params?: unknown[], opts?: unknown) => sql.includes(PROJECTION_PAGE_READ)
      ? Promise.reject(new Error('projection lost (probe)')) : target.executeRaw(sql, params, opts as never);
    if (prop === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) => target.transaction(async tx => {
      const log: Statement[] = [];
      let flipped = false;
      installFaultHook(point => { if (point === 'segmented:flipped') flipped = true; });
      try {
        const out = await fn(measuredTx(tx, log));
        if (flipped) publication.push(...log);
        return out;
      } finally { installFaultHook(undefined); }
    }, opts as never);
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

for (const kind of testBackends()) describe(`a segmented write's publication reads its delta, not the page (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => withEnv(env, async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    await registerLocalWriter(engine, 'cli');
    await engine.setConfig('pages.segmented_storage', 'on');
    if (kind === 'postgres') await engine.executeRaw('ALTER TABLE content_chunks SET (autovacuum_enabled = false)');
  }), 120_000);
  afterAll(async () => withEnv(env, async () => { await disposePersistenceConsumer(engine); await close?.(); }));

  const found = async (slug: string, word: string) => (await engine.searchKeyword(word, { limit: 10 })).filter(r => r.slug === slug).length;

  for (const mib of [2, 8]) for (const stats of ['taken after its first write', 'taken before the page'] as const) test(`an edit near the end of a ${mib} MiB page seals in its publication, reading only its delta (statistics ${stats})`, async () => withEnv(env, async () => {
    const before = stats === 'taken before the page';
    const v0 = conversationPage(mib * 1024 * 1024, { seed: 61, needles: [{ at: 0.95, word: 'tailmarkerquokka' }] });
    const file = join(home, `page-${mib}-${before ? 'before' : 'after'}.md`);
    const slug = `notes/publication-seal-${mib}-${before ? 'before' : 'after'}`;
    const write = async (on: BrainEngine) => expect(await importFromFile(on, file, `${slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) }))
      .toMatchObject({ status: 'imported' });
    if (before) await engine.executeRaw('ANALYZE content_chunks');
    writeFileSync(file, v0);
    await write(engine);
    if (!before) await engine.executeRaw('ANALYZE content_chunks');
    const first = await segmentedPageRow(engine, slug);
    expect(first.text_projection_revision).toBe(first.knowledge_revision);

    writeFileSync(file, v0.replace('tailmarkerquokka', 'tailmarkerwalrus'));
    const publication: Statement[] = [];
    await write(measuredWrite(engine, publication));

    const page = await segmentedPageRow(engine, slug);
    expect(page.text_projection_revision).toBe(page.knowledge_revision);
    expect(await found(slug, 'tailmarkerwalrus')).toBeGreaterThan(0);
    expect(await found(slug, 'tailmarkerquokka')).toBe(0);
    const generation = Number(page.body_generation);
    const [{ staged }] = await engine.executeRaw<{ staged: number }>(`SELECT
      (SELECT count(*)::int FROM content_chunks WHERE page_id=$1 AND body_generation=$2) + (SELECT count(*)::int FROM page_body_manifest WHERE page_id=$1 AND gen_from=$2) AS staged`,
      [page.id, generation]);
    const [{ pageRows }] = await engine.executeRaw<{ pageRows: number }>('SELECT count(*)::int AS "pageRows" FROM content_chunks WHERE page_id=$1', [page.id]);
    expect(pageRows).toBeGreaterThan(4 * staged);

    // (a) Only the flip, the version prune and the delta DELETE touch the two tables inside the publication transaction.
    const report = JSON.stringify(publication);
    expect(publication.filter(statement => !DELTA_DELETE.test(statement.sql) && !VERSION_PRUNE.test(statement.sql) && !FLIP.some(flip => flip.test(statement.sql))).map(statement => statement.sql), report).toEqual([]);
    const deletes = publication.filter(statement => DELTA_DELETE.test(statement.sql));
    expect(deletes.length, report).toBe(1);
    const [deleted] = deletes;
    // (b) On fresh statistics the delta DELETE examines at most the rows the write staged.
    if (!before) expect(deleted!.rows!, report).toBeLessThanOrEqual(staged);
    // (c) On statistics from before the page existed, at most the page's chunk rows, through an index and no per-row subplan.
    else {
      expect(deleted!.rows!, report).toBeLessThanOrEqual(pageRows);
      expect(deleted!.nodes!.filter(node => /Seq Scan/.test(node)), report).toEqual([]);
      expect(deleted!.nodes!.some(node => /Index/.test(node)), report).toBe(true);
      expect(deleted!.subplan, report).toBe(false);
    }
    console.log(`[publication-seal] ${kind} ${mib} MiB statistics ${before ? 'before' : 'after'}: delta DELETE examined ${deleted!.rows} rows via ${deleted!.nodes!.join(' > ')}; staged ${staged}, page chunk rows ${pageRows}; `
      + `statements: ${publication.map(statement => `${statement.sql.slice(0, 48)}${statement.rows === undefined ? '' : ` (${statement.rows} rows)`}`).join(' | ')}`);
  }), 600_000);
});
