#!/usr/bin/env bun
/**
 * Scale tier harness (F4c; gate shape and cadence: O-CEO-16 / O-ENG-16, see
 * docs/TESTING.md "Scale tier").
 *
 *   bun run test:scale -- --pages 10000 [--engine pglite|postgres] [--seed 1]
 *     [--corpus-dir <dir>] [--import-mode cli|content] [--enforce] [--out <file.json>]
 *     [--calibrate]
 *
 * Generates the deterministic fixture (scripts/scale/fixture.ts) and imports
 * it into a fresh brain under a temporary GBRAIN_HOME (never ~/.gbrain):
 * PGLite in a fresh data dir, or Postgres in a fresh database created from
 * DATABASE_URL and dropped afterwards. `--import-mode cli` (default) writes the
 * Markdown corpus once into --corpus-dir and runs the real `gbrain import`
 * per source, timing each file from its progress events; `--import-mode
 * content` keeps the per-page `importFromContent` loop. Then it extracts
 * links, timeline, facts and takes, writes deterministic vectors onto every
 * chunk, and measures: import rate, planner health (pg_stats on hot tables
 * above 500 rows, read after the first timed op; Nested Loop inner loops in the captured plans of the key ops), p50 over
 * five runs after a warmup for each op with a known-answer check, a
 * cold-process first query, two concurrent receipt-bearing writers, a no-op
 * re-import and cross-source duplicates. scripts/scale/gates.ts decides.
 *
 * The harness runs as a child of an out-of-process phase watchdog
 * (scripts/scale/watchdog.ts) that kills a phase stalled past 1.5x its gate
 * ceiling and names it; the vectors phase prints one progress line per batch.
 *
 * Exit codes: 0 all enforced gates pass, or a report-only run (no --enforce);
 * 1 an enforced gate failed (each failure names the gate, the op and its
 * EXPLAIN) or the watchdog killed a stalled phase (diagnostic in
 * <out>.watchdog.txt); 2 usage error; 3 the harness itself crashed (not a verdict).
 * The JSON report (and a .explain.txt for failures) lands in --out.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { corpusMarkdownFiles, generateScaleFixture, SCALE_SOURCES, scaleVector, writeScaleCorpus, type ScaleFixture } from './fixture.ts';
import { runF4dChecks } from './f4d.ts';
import {
  BUDGET_MULTIPLIER, evaluateScaleGates, FIND_ORPHANS_PARAMS, HEADLINE_OP, HOT_TABLES, importProgressPerFile, importRateBasis, PLANNER_HEALTH_ENFORCED, PLANNER_STATS_MIN_ROWS,
  orphansProblem, RATE_RATIO_MAX, rateMeasure, reproduceCommand, resultHits, TOTAL_VS_HALF_MAX, verdictLines,
  type DataCheck, type GatePolicy, type OpPlan, type OpResult, type PlanStatement, type ScaleReport,
} from './gates.ts';

const REPO = resolve(import.meta.dir, '../..');
const BUDGETS_FILE = join(import.meta.dir, 'budgets.json');
const USAGE = 'Usage: bun run test:scale -- --pages <N >= 20> [--engine pglite|postgres] [--seed <int>] [--corpus-dir <dir>] '
  + '[--import-mode cli|content] [--enforce] [--calibrate] [--out <file.json>]';

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
function usage(problem: string): never {
  console.log(`[scale] ${problem}\n${USAGE}`);
  process.exit(2);
}

const pagesArg = Number(flag('--pages', '2000'));
const seed = Number(flag('--seed', '1'));
const engineKind = flag('--engine', 'pglite') as 'pglite' | 'postgres';
const importMode = flag('--import-mode', 'cli') as 'cli' | 'content';
const enforce = process.argv.includes('--enforce');
const calibrate = process.argv.includes('--calibrate');
if (!Number.isInteger(pagesArg) || pagesArg < 20 || !Number.isInteger(seed)) usage('--pages must be an integer >= 20 and --seed an integer.');
if (!['pglite', 'postgres'].includes(engineKind)) usage(`--engine must be pglite or postgres, got ${engineKind}.`);
if (!['cli', 'content'].includes(importMode)) usage(`--import-mode must be cli or content, got ${importMode}.`);
const adminUrl = process.env.DATABASE_URL ?? process.env.GBRAIN_DATABASE_URL;
if (engineKind === 'postgres' && !adminUrl) {
  usage('--engine postgres needs DATABASE_URL pointing at a Postgres with pgvector (the harness creates and drops a fresh database there), '
    + 'e.g. DATABASE_URL=postgresql://<user>:<password>@localhost:5432/gbrain_test.');
}
const out = resolve(flag('--out', join('.context', 'scale', `report-${engineKind}-${pagesArg}-seed${seed}.json`)));

// The harness runs as a child of an out-of-process phase watchdog (scripts/scale/watchdog.ts).
if (process.env.GBRAIN_SCALE_SUPERVISED !== '1') {
  const { superviseScaleRun, watchdogLimitsMs } = await import('./watchdog.ts');
  let limits;
  try { limits = watchdogLimitsMs(pagesArg); } catch (e) { usage(e instanceof Error ? e.message : String(e)); }
  const dropDatabase = async (name: string) => {
    const { default: postgres } = await import('#postgres');
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
  };
  process.exit(await superviseScaleRun({
    command: [process.execPath, ...process.argv.slice(1)],
    pages: pagesArg,
    limits,
    reproduce: `bun run test:scale -- ${process.argv.slice(2).join(' ')}`,
    dropDatabase: engineKind === 'postgres' ? dropDatabase : undefined,
    onDiagnostic: text => {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out.replace(/\.json$/, '') + '.watchdog.txt', text + '\n');
    },
  }));
}

const home = mkdtempSync(join(tmpdir(), 'gbrain-scale-'));
console.log(`[scale] brain home: ${home}`);
const corpusDir = resolve(flag('--corpus-dir', join(home, 'corpus')));
const policy: GatePolicy = { enforce, enforcePlanner: PLANNER_HEALTH_ENFORCED, enforceCeilings: process.env.GBRAIN_SCALE_ENFORCE_CEILINGS === '1' };

// Hermetic: a temp brain home, no database URL leaking into children, no provider keys (keyless run, no paid calls).
process.env.GBRAIN_HOME = home;
delete process.env.DATABASE_URL;
delete process.env.GBRAIN_DATABASE_URL;
for (const key of Object.keys(process.env)) if (/_API_KEY$|_API_TOKEN$/.test(key)) delete process.env[key];
// Time get_health's computation, not its in-process memo: a repeat call within the TTL returns the memoized counters in well under 1 ms.
process.env.GBRAIN_HEALTH_CACHE_TTL_MS = '0';

const { createEngine } = await import('../../src/core/engine-factory.ts');
const { importFromContent } = await import('../../src/core/import-file.ts');
const { operations } = await import('../../src/core/operations.ts');
const { runExtract } = await import('../../src/commands/extract.ts');
const { runExtractFacts } = await import('../../src/core/cycle/extract-facts.ts');
const { extractTakes } = await import('../../src/core/cycle/extract-takes.ts');
const { hybridSearch } = await import('../../src/core/search/hybrid.ts');
const { disposePersistenceConsumer } = await import('../../src/core/persistence/service.ts');
type Engine = Awaited<ReturnType<typeof createEngine>>;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const round1 = (n: number) => Math.round(n * 10) / 10;
const silent = { info() {}, warn() {}, error() {} };

let databaseUrl: string | undefined;
let dropDatabase: (() => Promise<void>) | undefined;
const engineConfig = () => engineKind === 'postgres'
  ? { engine: 'postgres' as const, database_url: databaseUrl! }
  : { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };

async function openEngine(): Promise<Engine> {
  const engine = await createEngine(engineConfig());
  await engine.connect(engineConfig());
  return engine;
}
async function closeEngine(engine: Engine): Promise<void> {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
}

async function freshPostgresDatabase(suffix = ''): Promise<{ url: string; drop: () => Promise<void> }> {
  const { default: postgres } = await import('#postgres');
  const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
  const name = `gbrain_scale_${process.pid}_${Date.now()}${suffix}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  console.log(`[scale] scale database: ${name}`);
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: async () => {
    const drop = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    try { await drop.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await drop.end(); }
  } };
}
async function createFreshPostgres(): Promise<void> {
  const fresh = await freshPostgresDatabase();
  databaseUrl = fresh.url;
  dropDatabase = fresh.drop;
}

/** Record every statement the engine sends while `fn` runs (postgres.js debug hook; PGLite query wrapper). */
async function captureStatements<T>(engine: Engine, fn: () => Promise<T>): Promise<{ value: T; statements: Array<{ sql: string; params: unknown[] }> }> {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  if (engine.kind === 'postgres') {
    const options = (engine as unknown as { sql: { options: { debug?: unknown } } }).sql.options;
    const previous = options.debug;
    options.debug = (_id: number, sql: string, params: unknown[]) => { statements.push({ sql, params: params ?? [] }); };
    try { return { value: await fn(), statements }; } finally { options.debug = previous; }
  }
  const db = (engine as unknown as { db: { query: (sql: string, params?: unknown[], opts?: unknown) => Promise<unknown> } }).db;
  const original = db.query;
  db.query = (sql, params, opts) => { statements.push({ sql, params: params ?? [] }); return original.call(db, sql, params, opts); };
  try { return { value: await fn(), statements }; } finally { delete (db as { query?: unknown }).query; if (db.query !== original) db.query = original; }
}

/** Worst inner-side loop count under any Nested Loop: how many times a nested loop rescans one of its children. */
function nestedLoopInnerLoops(node: Record<string, unknown>): number {
  const children = (node.Plans as Array<Record<string, unknown>> | undefined) ?? [];
  let worst = node['Node Type'] === 'Nested Loop' ? Math.max(0, ...children.map(c => Number(c['Actual Loops'] ?? 0))) : 0;
  for (const child of children) worst = Math.max(worst, nestedLoopInnerLoops(child));
  return worst;
}

async function explainText(engine: Engine, sql: string, params: unknown[]): Promise<string> {
  const rows = await engine.executeRaw<Record<string, string>>(`EXPLAIN (ANALYZE, FORMAT TEXT) ${sql}`, params);
  return rows.map(r => r['QUERY PLAN']).join('\n');
}

/** Replay each captured read statement under EXPLAIN ANALYZE; keep the slowest and the worst Nested Loop with their plan text. */
async function planOf(engine: Engine, statements: Array<{ sql: string; params: unknown[] }>): Promise<OpPlan> {
  const reads = statements.filter(s => /^\s*(select|with)\b/i.test(s.sql) && !/^\s*select b\.oid/i.test(s.sql)
    && !/\b(insert|update|delete)\b/i.test(s.sql) && !/\b(set_config|nextval|setval|pg_notify|pg_(try_)?advisory\w*)\b/i.test(s.sql));
  const measured: Array<PlanStatement & { params: unknown[] }> = [];
  for (const s of reads) {
    try {
      const [row] = await engine.executeRaw<Record<string, unknown>>(`EXPLAIN (ANALYZE, FORMAT JSON) ${s.sql}`, s.params);
      const raw = row!['QUERY PLAN'];
      const [plan] = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: Record<string, unknown>; 'Execution Time': number }>;
      measured.push({ sql: s.sql, params: s.params, execution_ms: round1(plan!['Execution Time']), inner_loops: nestedLoopInnerLoops(plan!.Plan) });
    } catch { /* a statement that cannot be replayed standalone (session-bound parameters) is skipped */ }
  }
  const pickText = async (p: (PlanStatement & { params: unknown[] }) | undefined): Promise<PlanStatement | undefined> =>
    p && { sql: p.sql.replace(/\s+/g, ' ').trim(), execution_ms: p.execution_ms, inner_loops: p.inner_loops, text: await explainText(engine, p.sql, p.params).catch(e => `EXPLAIN failed: ${e instanceof Error ? e.message : String(e)}`) };
  const slowest = [...measured].sort((a, b) => b.execution_ms - a.execution_ms)[0];
  const worstLoops = [...measured].sort((a, b) => b.inner_loops - a.inner_loops)[0];
  const slowestPlan = await pickText(slowest);
  return { statements: measured.length, slowest: slowestPlan, worst_loops: worstLoops === slowest ? slowestPlan : await pickText(worstLoops) };
}

async function writeConfig(): Promise<void> {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ ...engineConfig(), embedding_disabled: true }, null, 2) + '\n');
}

interface CliImport { perFileMs: number[]; perFileCpuMs: number[]; result: Record<string, unknown>; wallMs: number }
/** Run the real `gbrain import` for one source; per-file cost comes from its JSON progress ticks (one per file at interval 0). */
async function cliImport(sourceId: string): Promise<CliImport> {
  const sourceDir = join(corpusDir, sourceId);
  const onDisk = corpusMarkdownFiles(sourceDir).length;
  if (onDisk === 0) {
    throw new Error(`code=scale_corpus_empty: no Markdown files under ${sourceDir}, so there is nothing to import. `
      + `Fix: delete ${corpusDir} (or pass a fresh --corpus-dir) and rerun; the harness regenerates the corpus from the seed.`);
  }
  const started = performance.now();
  const child = Bun.spawn([process.execPath, join(REPO, 'src/cli.ts'), '--progress-json', '--progress-interval', '0',
    'import', join(corpusDir, sourceId), '--no-embed', '--source', sourceId, '--json'], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const wallMs = performance.now() - started;
  const lastJson = stdout.trim().split('\n').reverse().find(l => l.startsWith('{'));
  if (code !== 0 || !lastJson) {
    throw new Error(`gbrain import of source ${sourceId} exited ${code}. stdout: ${stdout.slice(-2000)} stderr: ${stderr.slice(-2000)}`);
  }
  const totalFiles = Number(JSON.parse(lastJson).total_files);
  if (totalFiles !== onDisk) {
    throw new Error(`code=scale_import_file_count: gbrain import saw ${totalFiles} of the ${onDisk} Markdown files under ${sourceDir}. `
      + 'Its file listing skipped the rest (a .gitignore or hidden-path rule of an enclosing repository is the usual cause). '
      + `Fix: check \`git -C ${sourceDir} check-ignore -v .\`, or pass a --corpus-dir outside any repository.`);
  }
  const { wallMs: perFileMs, cpuMs: perFileCpuMs } = importProgressPerFile(stderr);
  const usable = perFileMs.filter((ms, i) => Number.isFinite(ms) && Number.isFinite(perFileCpuMs[i])).length;
  if (perFileMs.length !== totalFiles || usable !== totalFiles) {
    throw new Error(`gbrain import of source ${sourceId} emitted ${usable} usable per-file progress ticks for `
      + `${totalFiles} files; the rate gate needs one tick per file with elapsed_ms and cpu_ms (--progress-json --progress-interval 0).`);
  }
  return { perFileMs, perFileCpuMs, result: JSON.parse(lastJson) as Record<string, unknown>, wallMs };
}

async function brainSnapshot(engine: Engine): Promise<Record<string, string>> {
  const [row] = await engine.executeRaw<Record<string, unknown>>(`SELECT
    (SELECT last_value FROM page_generation_clock_seq)::text AS generation_clock,
    (SELECT count(*) FROM pages)::text AS pages, (SELECT max(updated_at) FROM pages)::text AS pages_updated_at,
    (SELECT count(*) FROM content_chunks)::text AS content_chunks, (SELECT count(*) FROM links)::text AS links,
    (SELECT count(*) FROM timeline_entries)::text AS timeline_entries, (SELECT count(*) FROM facts)::text AS facts,
    (SELECT count(*) FROM takes)::text AS takes, (SELECT count(*) FROM page_versions)::text AS page_versions,
    (SELECT count(*) FROM ingest_log)::text AS ingest_log`);
  return row as Record<string, string>;
}

interface FullReport extends ScaleReport {
  headline: { metric: string; p50_ms: number };
  planner: ScaleReport['planner'] & { tables_without_stats: string[] };
  [key: string]: unknown;
}

async function main(): Promise<FullReport> {
  const phases: Record<string, number> = {};
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    console.log(`[scale] phase ${name} start`);
    try { return await fn(); } finally { phases[name] = Math.round(performance.now() - t); console.log(`[scale] phase ${name} done in ${phases[name]} ms`); }
  };
  console.log(`[scale] engine=${engineKind} pages=${pagesArg} seed=${seed} import-mode=${importMode} ${enforce ? 'enforce' : 'report-only'}`);
  const fixture: ScaleFixture = generateScaleFixture({ pages: pagesArg, seed });
  const importStart = performance.now();
  if (importMode === 'cli') {
    const rewritten = await timed('corpus', async () => writeScaleCorpus(fixture, corpusDir));
    console.log(`[scale] corpus ${rewritten ? 'written' : 'reused'}: ${corpusDir}`);
  }
  if (engineKind === 'postgres') await createFreshPostgres();
  let engine = await timed('schema', async () => {
    const e = await openEngine();
    await e.initSchema();
    for (const sourceId of SCALE_SOURCES) {
      if (sourceId !== 'default') await e.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [sourceId]);
    }
    return e;
  });
  await writeConfig();

  // Import.
  let perPage: number[] = [];
  let perPageCpu: number[] = [];
  await timed('import_files', async () => {
    if (importMode === 'cli') {
      await closeEngine(engine);
      for (const sourceId of SCALE_SOURCES) {
        const run = await cliImport(sourceId);
        const expected = fixture.pages.filter(p => p.sourceId === sourceId).length;
        if (run.result.imported !== expected || Number(run.result.errors) !== 0) {
          throw new Error(`gbrain import of source ${sourceId} imported ${String(run.result.imported)}/${expected} with ${String(run.result.errors)} errors: ${JSON.stringify(run.result).slice(0, 2000)}`);
        }
        perPage = perPage.concat(run.perFileMs);
        perPageCpu = perPageCpu.concat(run.perFileCpuMs);
        console.log(`[scale] gbrain import --source ${sourceId}: ${expected} files in ${Math.round(run.wallMs)} ms wall`);
      }
      engine = await openEngine();
    } else {
      for (const page of fixture.pages) {
        const t = performance.now();
        const cpu = process.threadCpuUsage();
        const result = await importFromContent(engine, page.slug, page.content, { sourceId: page.sourceId, noEmbed: true });
        if (result.status === 'error') throw new Error(`import failed for ${page.sourceId}:${page.slug}: ${result.error}`);
        perPage.push(performance.now() - t);
        const used = process.threadCpuUsage(cpu);
        perPageCpu.push((used.user + used.system) / 1000);
      }
    }
  });
  const importRate = { wall: rateMeasure(perPage), cpu: rateMeasure(perPageCpu) };

  // Derived data, as a cycle would: links + timeline, facts and takes fences.
  const extract = await timed('extract', async () => {
    await runExtract(engine, ['all', '--source', 'db']);
    let factsInserted = 0;
    for (const sourceId of SCALE_SOURCES) factsInserted += (await runExtractFacts(engine, { sourceId })).factsInserted;
    const takes = await extractTakes(engine, { source: 'db' });
    return { factsInserted, takesUpserted: takes.takesUpserted };
  });

  console.log(`[scale] extracted links/timeline, ${extract.factsInserted} facts, ${extract.takesUpserted} takes in ${phases.extract} ms`);

  // Deterministic vectors on every chunk, so the vector arm runs keylessly through queryEmbedFn.
  const dim = await timed('vectors', async () => {
    const [col] = await engine.executeRaw<{ t: string }>(
      "SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'");
    const d = Number(/vector\((\d+)\)/.exec(col?.t ?? '')?.[1]);
    if (!Number.isInteger(d)) throw new Error(`content_chunks.embedding is ${col?.t ?? 'missing'}; expected vector(N)`);
    const ids = new Map((await engine.executeRaw<{ id: number; source_id: string; slug: string }>('SELECT id, source_id, slug FROM pages'))
      .map(r => [`${r.source_id}:${r.slug}`, r.id]));
    const batches = Math.ceil(fixture.pages.length / 500);
    const vectorsStart = performance.now();
    for (let i = 0; i < fixture.pages.length; i += 500) {
      const batch = fixture.pages.slice(i, i + 500);
      const t = performance.now();
      await engine.executeRaw(
        'UPDATE content_chunks c SET embedding = u.vec::vector FROM unnest($1::int[], $2::text[]) AS u(page_id, vec) WHERE c.page_id = u.page_id',
        [batch.map(p => ids.get(`${p.sourceId}:${p.slug}`)!), batch.map(p => `[${Array.from(scaleVector(p.index, d)).join(',')}]`)]);
      const rss = Math.round(process.memoryUsage.rss() / 1048576);
      console.log(`[scale] vectors batch ${i / 500 + 1}/${batches}: ${batch.length} pages in ${Math.round(performance.now() - t)} ms `
        + `(${i + batch.length}/${fixture.pages.length} pages, ${Math.round(performance.now() - vectorsStart)} ms total, dim ${d}, rss ${rss} MiB)`);
    }
    return d;
  });
  phases.import = Math.round(performance.now() - importStart);

  // Budgets: timed ops with known answers, then the data checks.
  const budgetsStart = performance.now();
  const ctxBase = { engine, config: { engine: engineKind, embedding_disabled: true }, logger: silent, dryRun: false, sourceId: 'default' };
  const local = { ...ctxBase, remote: false } as never;
  const remoteCtx = (allowedSources: string[]) => ({ ...ctxBase, remote: true,
    auth: { token: 'scale', clientId: 'scale', scopes: ['read'], allowedSources } }) as never;
  const op = (name: string) => operations.find(o => o.name === name)!;
  const probe = fixture.pages[Math.floor(fixture.pages.length / 3)]!;
  const hub = fixture.pages.find(p => p.slug === fixture.hub && p.sourceId === 'default')!;
  const has = (r: unknown, sourceId: string, slug: string) => resultHits(r).some(h => h.slug === slug && (h.source_id ?? sourceId) === sourceId);
  const duplicateHits: string[] = [];
  const [{ receipts }] = await engine.executeRaw<{ receipts: number }>(
    "SELECT count(*)::int AS receipts FROM pages WHERE deleted_at IS NULL AND type = 'extract_receipt'");
  const expectedPages = fixture.pages.length + receipts;
  const listLimit = Math.min(50, Math.floor(fixture.pages.length / 2));
  const queryEmbedFn = (text: string) => scaleVector(text === fixture.vectorProbe.query ? fixture.vectorProbe.index : fixture.pages.length + text.length, dim);
  const checks: Array<{ op: string; run: () => Promise<unknown>; verify: (result: unknown) => string | null }> = [
    { op: 'get_health', run: () => op('get_health').handler(local, {}),
      verify: r => Number((r as { page_count?: number }).page_count) === expectedPages ? null
        : `page_count ${(r as { page_count?: number }).page_count} != ${expectedPages} (${fixture.pages.length} fixture pages + ${expectedPages - fixture.pages.length} extract receipts)` },
    { op: 'list_pages', run: () => op('list_pages').handler(local, { limit: listLimit }),
      verify: r => (r as unknown[]).length === listLimit ? null : `${(r as unknown[]).length} rows, expected ${listLimit}` },
    { op: 'search (keyword, local)', run: () => op('search').handler(local, { query: probe.token, limit: 10, source_id: probe.sourceId }),
      verify: r => has(r, probe.sourceId, probe.slug) ? null : `${probe.sourceId}:${probe.slug} not returned for ${probe.token}` },
    { op: HEADLINE_OP, run: () => op('search').handler(remoteCtx([...SCALE_SOURCES]), { query: probe.token, limit: 10 }),
      verify: r => {
        const top = Array.isArray(r) ? (r as Array<{ slug?: string; source_id?: string }>).map(h => `${h.source_id}:${h.slug}`) : [];
        const dup = top.filter((k, i) => top.indexOf(k) !== i);
        if (dup.length) duplicateHits.push(...dup);
        return has(r, probe.sourceId, probe.slug) ? null : `${probe.sourceId}:${probe.slug} not returned for ${probe.token}`;
      } },
    { op: 'search (MCP path, source-scoped grant)',
      run: async () => [await op('search').handler(remoteCtx([fixture.grant.allowed]), { query: fixture.grant.visible.token, limit: 10 }),
        await op('search').handler(remoteCtx([fixture.grant.allowed]), { query: fixture.grant.hidden.token, limit: 10 })],
      verify: r => {
        const [visible, hidden] = r as [unknown, unknown];
        if (!has(visible, fixture.grant.visible.sourceId, fixture.grant.visible.slug)) return `${fixture.grant.visible.slug} not returned to a ${fixture.grant.allowed}-only grant`;
        const leaked = resultHits([visible, hidden]).filter(h => h.source_id !== undefined && h.source_id !== fixture.grant.allowed);
        return leaked.length ? `a ${fixture.grant.allowed}-only grant saw ${leaked.map(h => `${h.source_id}:${h.slug}`).join(', ')}` : null;
      } },
    { op: 'query (hybrid, injected vector)', run: () => hybridSearch(engine, fixture.vectorProbe.query, { limit: 10, queryEmbedFn }),
      verify: r => {
        const top = (r as Array<{ slug: string; source_id?: string }>)[0];
        return top?.slug === fixture.vectorProbe.slug && (top.source_id ?? fixture.vectorProbe.sourceId) === fixture.vectorProbe.sourceId ? null
          : `top hit ${top ? `${top.source_id}:${top.slug}` : '(none)'}, expected ${fixture.vectorProbe.sourceId}:${fixture.vectorProbe.slug} from its injected vector`;
      } },
    { op: 'traverse_graph depth 3', run: () => op('traverse_graph').handler(local, { slug: fixture.hub, depth: 3 }),
      verify: r => hub.links.every(target => resultHits(r).some(h => h.slug === target)) ? null : 'a direct link target of the hub is missing' },
    { op: 'get_backlinks', run: () => op('get_backlinks').handler(local, { slug: hub.links[0] }),
      verify: r => JSON.stringify(r).includes(`"${fixture.hub}"`) ? null : `${fixture.hub} missing from backlinks of ${hub.links[0]}` },
    { op: 'find_orphans', run: () => op('find_orphans').handler(local, { ...FIND_ORPHANS_PARAMS }),
      verify: r => orphansProblem(r, fixture.islands) },
  ];
  const ops: OpResult[] = [];
  const statRows: Record<string, number> = {};
  const tableRows: Record<string, number> = {};
  let probedAfter = '';
  await timed('ops', async () => {
    for (const check of checks) {
      let result: unknown;
      let error: string | undefined;
      let plan: OpPlan | undefined;
      const runs: number[] = [];
      for (let i = 0; i < 6; i++) {
        const t = performance.now();
        try {
          if (i === 0) {
            const captured = await captureStatements(engine, check.run);
            result = captured.value;
            plan = await planOf(engine, captured.statements);
          } else {
            result = await check.run();
          }
        } catch (e) { error = e instanceof Error ? e.message : String(e); }
        if (i > 0) runs.push(performance.now() - t);
      }
      const detail = error ?? check.verify(result) ?? undefined;
      ops.push({ op: check.op, p50_ms: round1(median(runs)), runs_ms: runs.map(r => Math.round(r)), known_answer: detail ? 'fail' : 'pass', ...(detail ? { detail } : {}), ...(plan ? { plan } : {}) });
      // Planner health is read after the first timed op, not right after import: F4b analyzes on the first planner-sensitive read by design.
      if (!probedAfter) {
        probedAfter = check.op;
        for (const table of HOT_TABLES) {
          const [row] = await engine.executeRaw<{ stats: number; n: number }>(
            `SELECT (SELECT count(*) FROM pg_stats WHERE tablename = $1)::int AS stats, (SELECT count(*) FROM ${table})::int AS n`, [table]);
          statRows[table] = Number(row?.stats ?? 0);
          tableRows[table] = Number(row?.n ?? 0);
        }
      }
    }
  });

  const data: DataCheck[] = [];
  const dataCheck = (check: string, problem: string | null) => data.push({ check, status: problem ? 'fail' : 'pass', ...(problem ? { detail: problem } : {}) });
  const [{ facts, takes }] = await engine.executeRaw<{ facts: number; takes: number }>(
    'SELECT (SELECT count(*) FROM facts)::int AS facts, (SELECT count(*) FROM takes)::int AS takes');
  dataCheck('facts_takes_populated', facts === fixture.expected.facts && takes === fixture.expected.takes ? null
    : `facts ${facts}/${fixture.expected.facts}, takes ${takes}/${fixture.expected.takes} after extraction`);
  const perSource = await engine.executeRaw<{ source_id: string; n: number; foreign: number }>(
    `SELECT source_id, count(*)::int AS n, count(*) FILTER (WHERE slug !~ ('/scale-' || CASE source_id WHEN 'default' THEN '0' ELSE '1' END || '-[0-9]+$'))::int AS foreign
       FROM pages WHERE deleted_at IS NULL AND slug ~ '/scale-[01]-[0-9]+$' GROUP BY source_id ORDER BY source_id`);
  const dupProblems = SCALE_SOURCES.flatMap(s => {
    const row = perSource.find(r => r.source_id === s);
    const want = fixture.pages.filter(p => p.sourceId === s).length;
    return row?.n === want && row.foreign === 0 ? [] : [`${s} holds ${row?.n ?? 0} pages (${row?.foreign ?? 0} from the other source), expected ${want}`];
  });
  if (duplicateHits.length) dupProblems.push(`MCP search returned the same document twice: ${[...new Set(duplicateHits)].join(', ')}`);
  dataCheck('no_duplicate_documents_across_sources', dupProblems.length ? dupProblems.join('; ') : null);

  // No-op re-import: the same corpus again must write nothing.
  await timed('reimport', async () => {
    const before = await brainSnapshot(engine);
    let imported = 0;
    if (importMode === 'cli') {
      await closeEngine(engine);
      for (const sourceId of SCALE_SOURCES) imported += Number((await cliImport(sourceId)).result.imported);
      engine = await openEngine();
    } else {
      for (const page of fixture.pages) {
        if ((await importFromContent(engine, page.slug, page.content, { sourceId: page.sourceId, noEmbed: true })).status === 'imported') imported++;
      }
    }
    const after = await brainSnapshot(engine);
    const changed = Object.keys(before).filter(k => before[k] !== after[k]).map(k => `${k} ${before[k]} -> ${after[k]}`);
    dataCheck('noop_reimport_writes_nothing', imported === 0 && changed.length === 0 ? null
      : `re-importing the unchanged corpus imported ${imported} page(s) and changed ${changed.join(', ') || 'no counters'}`);
  });
  (ctxBase as { engine: Engine }).engine = engine;

  // Cold-process first query: a child process opens the persisted brain and runs one MCP-path search.
  const cold = await timed('cold_query', async () => {
    await closeEngine(engine);
    const t = performance.now();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'cold-query.ts'), probe.token], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const wall = performance.now() - t;
    engine = await openEngine();
    (ctxBase as { engine: Engine }).engine = engine;
    const line = stdout.trim().split('\n').reverse().find(l => l.startsWith('{'));
    const parsed = line ? JSON.parse(line) as { query_ms?: number; connect_ms?: number; results?: unknown; error?: string } : undefined;
    const problem = code !== 0 || !parsed ? `cold query exited ${code}: ${stdout.slice(-1000)} ${stderr.slice(-1000)}`
      : has(parsed.results, probe.sourceId, probe.slug) ? null : `${probe.sourceId}:${probe.slug} not returned for ${probe.token} in a cold process`;
    ops.push({ op: 'cold-process first query (MCP path)', p50_ms: Math.round(wall), runs_ms: [Math.round(wall)],
      known_answer: problem ? 'fail' : 'pass', ...(problem ? { detail: problem } : {}) });
    return { wall_ms: Math.round(wall), connect_ms: parsed?.connect_ms, query_ms: parsed?.query_ms };
  });

  // Two concurrent receipt-bearing writers: distinct request ids, both must commit.
  await timed('writers', async () => {
    const t = performance.now();
    const settled = await Promise.allSettled(fixture.writers.map(w => op('put_page').handler({ ...ctxBase, remote: false } as never,
      { slug: w.slug, content: w.content, request_id: w.requestId })));
    const wall = performance.now() - t;
    const states = settled.map(s => s.status === 'fulfilled' ? String((s.value as { state?: string }).state) : `rejected: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
    const problem = states.every(s => s === 'committed') ? null : `writer states ${states.join(', ')}; both must reach committed`;
    ops.push({ op: 'concurrent put_page x2 (receipts)', p50_ms: Math.round(wall), runs_ms: [Math.round(wall)],
      known_answer: problem ? 'fail' : 'pass', ...(problem ? { detail: problem } : {}) });
  });
  phases.budgets = Math.round(performance.now() - budgetsStart);
  await closeEngine(engine);

  // F4d operational ceilings through the real CLI (the brain is closed: PGLite has one owner).
  const f4d = await timed('f4d', async () => {
    const result = await runF4dChecks({ repo: REPO, home, pages: fixture.pages.length, dim, probeToken: probe.token,
      freshManagedBrain: async () => {
        if (engineKind === 'pglite') return { initArgs: ['--pglite', '--path', join(home, 'f4d-managed', 'brain.pglite')], cleanup: async () => {} };
        const fresh = await freshPostgresDatabase('_f4d');
        return { initArgs: ['--non-interactive', '--url', fresh.url], cleanup: fresh.drop };
      } });
    data.push(...result.checks);
    return result.measured;
  });

  const budgets = existsSync(BUDGETS_FILE) ? (JSON.parse(readFileSync(BUDGETS_FILE, 'utf8')) as { budgets?: Record<string, Record<string, number>> }).budgets ?? {} : {};
  const budgetKey = `${engineKind}:${pagesArg}`;
  const headline = ops.find(o => o.op === HEADLINE_OP)!;
  return {
    headline: { metric: `MCP search p50 at ${fixture.pages.length} brain pages, as shipped (no manual ANALYZE)`, p50_ms: headline.p50_ms },
    harness: 'gbrain-scale', mode: enforce ? 'enforce' : 'report-only', engine: engineKind, seed, pages: fixture.pages.length,
    import_mode: importMode, sources: SCALE_SOURCES,
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, cpus: navigator.hardwareConcurrency },
    policy: { planner_health: policy.enforcePlanner ? 'enforced' : 'report-only (PLANNER_HEALTH_ENFORCED=false)', ceilings: policy.enforceCeilings ? 'enforced' : 'report-only' },
    import: importRate,
    extract,
    planner: { hot_table_stat_rows: statRows, hot_table_rows: tableRows, probed_after: probedAfter,
      tables_without_stats: HOT_TABLES.filter(t => tableRows[t]! > PLANNER_STATS_MIN_ROWS && statRows[t] === 0) },
    ops, data, f4d, cold_query: cold, vector_dim: dim, phases_ms: phases,
    ...(budgets[budgetKey] ? { budgets_ms: budgets[budgetKey] } : {}),
  };
}

let exitCode = 0;
try {
  const report = await main();
  const verdict = evaluateScaleGates(report, policy);
  const explain = [...verdict.failures, ...verdict.reportOnlyBreaches].filter(g => g.explain)
    .map(g => `== ${g.gate} (${g.enforced ? 'enforced' : 'report-only'})\n${g.message}\n${g.explain}`).join('\n\n');
  const full = { ...report, gates: verdict.results, exit_code: verdict.exitCode, reproduce: reproduceCommand(report) };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(full, null, 2) + '\n');
  if (explain) writeFileSync(out.replace(/\.json$/, '') + '.explain.txt', explain + '\n');
  if (calibrate) {
    const file = existsSync(BUDGETS_FILE) ? JSON.parse(readFileSync(BUDGETS_FILE, 'utf8')) : { budgets: {} };
    file.budgets[`${report.engine}:${report.pages}`] = Object.fromEntries(report.ops.map(o => [o.op, Math.ceil(o.p50_ms * BUDGET_MULTIPLIER)]));
    writeFileSync(BUDGETS_FILE, JSON.stringify(file, null, 2) + '\n');
    console.log(`[scale] calibrated budgets (${BUDGET_MULTIPLIER}x p50) for ${report.engine}:${report.pages} written to ${BUDGETS_FILE}`);
  }
  console.log(`[scale] HEADLINE ${report.headline.metric}: ${report.headline.p50_ms} ms`);
  const gatedBasis = importRateBasis(report.engine);
  for (const basis of ['cpu', 'wall'] as const) {
    const imp = report.import[basis];
    console.log(`[scale] import (${report.import_mode}, ${basis} time${basis === gatedBasis ? ', gated' : ', reported'}) files ${imp.total_ms} ms; per-page first10 ${imp.per_page_ms_first10} ms, last10 ${imp.per_page_ms_last10} ms, ratio ${imp.rate_ratio} (gate <= ${RATE_RATIO_MAX}); total/half ${imp.total_vs_half} (gate <= ${TOTAL_VS_HALF_MAX})`);
  }
  console.log(`[scale] planner (after ${report.planner.probed_after}): tables above ${PLANNER_STATS_MIN_ROWS} rows without stats: ${report.planner.tables_without_stats.join(', ') || 'none'}`);
  for (const r of report.ops) {
    console.log(`[scale] ${r.known_answer === 'pass' ? 'PASS' : 'FAIL'} ${r.op}: p50 ${r.p50_ms} ms${r.plan?.worst_loops ? `, worst nested-loop inner loops ${r.plan.worst_loops.inner_loops}` : ''}${r.detail ? ` (${r.detail})` : ''}`);
  }
  for (const d of report.data) console.log(`[scale] ${d.status === 'pass' ? 'PASS' : 'FAIL'} ${d.check}${d.detail ? ` (${d.detail})` : ''}`);
  for (const [name, measured] of Object.entries(report.f4d ?? {})) console.log(`[scale] F4D ${name}: ${JSON.stringify(measured)}`);
  console.log(`[scale] phases (ms): ${Object.entries(report.phases_ms).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  for (const line of verdictLines(report, verdict, policy)) console.log(line);
  console.log(`[scale] report: ${out}${explain ? ` (EXPLAIN for failures: ${out.replace(/\.json$/, '')}.explain.txt)` : ''}; reproduce with: ${full.reproduce}`);
  exitCode = verdict.exitCode;
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.log(`[scale] HARNESS CRASH (exit 3, not a gate verdict): ${message}`);
  console.log(`[scale] Rerun with the same arguments; if it repeats, the crash names the failing step. Reproduce: bun run test:scale -- --engine ${engineKind} --pages ${pagesArg} --seed ${seed}`);
  exitCode = 3;
} finally {
  await dropDatabase?.().catch(e => console.log(`[scale] could not drop the scale database: ${e instanceof Error ? e.message : String(e)}; drop it by hand with DROP DATABASE`));
  rmSync(home, { recursive: true, force: true });
}
process.exit(exitCode);
