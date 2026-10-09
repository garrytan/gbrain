#!/usr/bin/env bun
/**
 * #5984 managed-sync catch-up bench. Opt-in, never run in CI. Record and
 * schema: docs/eval/managed-sync-catchup.md.
 *
 *   bun scripts/bench/managed-sync-catchup.ts [--files 500] [--deletes 34] [--history 0]
 *     [--rtt 57,0] [--rows cli,reentry,unmanaged,serve,effects,foreground,foreground-open,all,newcomer]
 *     [--max-minutes 20] [--stall-iterations 8] [--pad-words 0] [--receipt-history 0] [--seed 1] [--label <name>] [--out <file.json>]
 *     [--fg-interval 5] [--pool-size N] [--pooler pgbouncer]
 *     [--database-url <admin url>] [--pg-port 55432] [--proxy-port 55433] [--api-port 58474] [--pooler-port 55434] [--keep]
 *   bun scripts/bench/managed-sync-catchup.ts --analyze <sql-trace.jsonl> [--out <file.json>]
 *
 * `--analyze` re-runs the critical-path, group publication, counter-hold,
 * feeder, lane, describe and steady-state analysis (managed-sync-catchup-phases.ts)
 * on a kept trace, without Docker; `foreground-{idle,busy,open}.json` beside the
 * trace add per-put_page round trips and span timelines.
 *
 * Starts (or reuses) a pgvector Postgres with pg_stat_statements in Docker and
 * a toxiproxy in front of it with `--rtt` milliseconds of round trip split
 * across both directions (every helper binds 127.0.0.1). Per row and RTT it
 * clones a fresh database from a template initialized by this checkout, builds
 * a git source in classic mode (history pages plus `--deletes` pages that are
 * imported, then soft-deleted), commits the backlog (`--files` new pages and
 * the deletion of the soft-deleted files), activates managed persistence
 * through the real `gbrain sources writer claim/activate` CLI, and points the
 * brain at the proxy. Then it drives the catch-up:
 *
 *   cli        the reporter's workaround: `gbrain sync --source <id> --no-pull --no-embed --json` re-run until synced
 *   reentry    one long-lived process re-entering performSync until synced (250 ms pause, like the PGLite delegate)
 *   unmanaged  classic sync of the same corpus (no activation), one CLI run
 *   serve      `cli` with a resident `gbrain serve --http` on the same brain
 *   effects    `cli` without --no-embed against a loopback stub /v1/embeddings (200 ms, 4 concurrent, 429 beyond),
 *              plus time to retrieval-ready
 *   foreground `cli` while a second process submits put_page every second (p95, lock_timeout count),
 *              after an idle foreground baseline
 *   foreground-open
 *              `cli` while a second process submits one put_page every --fg-interval seconds whether or
 *              not earlier ones finished (open loop: arrival rate, p50/p95, failures by code)
 *   all        `gbrain sync --all --no-pull --no-embed --json` re-run until synced, two sources
 *   newcomer   cold start to first progress line, and a 5-page managed source to a search hit
 *
 * Every gbrain process runs with GBRAIN_SQL_TRACE (src/core/sql-trace.ts), so
 * each database round trip is attributed to its process; pg_stat_statements
 * gives the server-side totals; pg_locks/pg_stat_activity are sampled every
 * 100 ms for lock waits and their holders. Rows stop at --max-minutes and
 * report a labelled extrapolation. `--pool-size N` sets GBRAIN_POOL_SIZE for
 * every gbrain process (unset: the product default of 10); `--pooler pgbouncer`
 * puts a transaction-mode PgBouncer between toxiproxy and Postgres and runs
 * gbrain with GBRAIN_PREPARE=false (report-only). Each row records its pool,
 * lane and pooler settings. Works against any branch: it only drives the CLI,
 * performSync and submitPageMutation.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import postgres from '#postgres';
import { generateScaleFixture } from '../scale/fixture.ts';
import { DEFAULT_JOURNAL_LIMITS } from '../../src/core/persistence/model.ts';
import {
  BENCH_SQL, classify, family, flatSql, isTxnControl, groupStatements, measureRtt, pct, readEffects, readPgStatStatements, readTrace, round1, startEffectsSampler, startEmbeddingStub,
  startHarness, startLockSampler, sum, normalizeSql, type Harness, type LockSample, type TraceRecord,
} from './managed-sync-catchup-lib.ts';
import { commitTimes, criticalPath, describeRoundTrips, feederBreakdown, foregroundRoundTrips, foregroundSpans, laneApply, publicationBreakdown, publishedPages, renderAnalysis,
  renderPhase0, steadyRate, syncStart } from './managed-sync-catchup-phases.ts';

const REPO = resolve(import.meta.dir, '../..');
const CLI = join(REPO, 'src/cli.ts');
function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const worker = flag('worker', '');
if (worker) await runWorker(worker);
const analyze = flag('analyze', '');
if (analyze) analyzeTrace(resolve(analyze), flag('out', ''));

/** `--analyze`: the trace analysis of a kept row, printed as markdown (and written as JSON with --out). */
function analyzeTrace(file: string, out: string): never {
  if (!existsSync(file)) { console.error(`trace not found: ${file}`); process.exit(2); }
  const records = readTrace(file, r => r.label !== 'setup');
  const pages = publishedPages(records) || null;
  const cp = criticalPath(records, pages);
  const pub = publicationBreakdown(records);
  const phase0 = { feeder: feederBreakdown(records, pages), lanes: laneApply(records), describes: describeRoundTrips(records), steady: steadyRate(commitTimes(records), syncStart(records)) };
  const foreground: Record<string, unknown> = {};
  const spans: Record<string, Record<string, unknown>> = {};
  for (const tag of ['idle', 'busy', 'open']) {
    const results = join(dirname(file), `foreground-${tag}.json`);
    if (!existsSync(results)) continue;
    const writes = JSON.parse(readFileSync(results, 'utf8'));
    foreground[tag] = foregroundRoundTrips(records, writes);
    spans[tag] = foregroundSpans(records, writes);
  }
  console.log(renderAnalysis(cp, pub));
  console.log(renderPhase0({ ...phase0, spans }));
  for (const [tag, rt] of Object.entries(foreground)) console.log(`\nForeground ${tag} per put_page: ${JSON.stringify(rt)}`);
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), JSON.stringify({ trace: file, critical_path: cp, publication: pub, feeder: phase0.feeder, lanes: phase0.lanes, describes: phase0.describes,
      steady_state: phase0.steady, foreground, foreground_spans: spans }, null, 2) + '\n');
  }
  process.exit(0);
}

const FILES = Number(flag('files', '500'));
const DELETES = Number(flag('deletes', '34'));
const HISTORY = Number(flag('history', '0'));
const RECEIPT_HISTORY = Number(flag('receipt-history', '0'));
const PAD_WORDS = Number(flag('pad-words', '0'));
const SEED = Number(flag('seed', '1'));
const RTTS = flag('rtt', '57,0').split(',').map(Number);
const ROWS = flag('rows', 'cli,reentry,unmanaged,serve,effects,foreground,all,newcomer').split(',');
const MAX_MS = Number(flag('max-minutes', '20')) * 60_000;
const STALL_ITERATIONS = Number(flag('stall-iterations', '8'));
const LABEL = flag('label', gitDescribe());
const OUT = resolve(flag('out', join(REPO, '.context', 'bench', `managed-sync-catchup-${LABEL.replace(/[^\w.-]/g, '_')}-${Date.now()}.json`)));
const KEEP = process.argv.includes('--keep');
const FG_INTERVAL_S = Number(flag('fg-interval', '5'));
const POOL_SIZE = flag('pool-size', '');
const POOLER = flag('pooler', '');
if (POOLER && POOLER !== 'pgbouncer') { console.error(`--pooler takes pgbouncer; got ${POOLER}`); process.exit(2); }
if (POOL_SIZE && !(Number.isInteger(Number(POOL_SIZE)) && Number(POOL_SIZE) > 0)) { console.error(`--pool-size takes a whole number above 0; got ${POOL_SIZE}`); process.exit(2); }
if (!(FG_INTERVAL_S > 0)) { console.error(`--fg-interval takes seconds above 0; got ${FG_INTERVAL_S}`); process.exit(2); }
/** Pool, lane and pooler settings every measured gbrain process runs with, recorded on each row. */
const SETTINGS = {
  pool_size: Number(POOL_SIZE || process.env.GBRAIN_POOL_SIZE || 10),
  pool_size_source: POOL_SIZE ? '--pool-size' : process.env.GBRAIN_POOL_SIZE ? 'GBRAIN_POOL_SIZE' : 'product default',
  sync_lanes_env: process.env.GBRAIN_SYNC_LANES ?? null,
  sync_bulk_env: process.env.GBRAIN_SYNC_BULK ?? null,
  pooler: POOLER || null,
  prepare_env: POOLER ? 'false' : process.env.GBRAIN_PREPARE ?? null,
};
const DEFAULT_SETTINGS = !POOL_SIZE && !process.env.GBRAIN_POOL_SIZE && SETTINGS.sync_lanes_env === null && SETTINGS.sync_bulk_env === null && !POOLER && SETTINGS.prepare_env === null;
const SOURCE = 'bench';
const SOURCE_B = 'bench-b';
const work = mkdtempSync(join(tmpdir(), 'gbrain-catchup-'));

function gitDescribe(): string {
  try { return execFileSync('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim() + '@' + execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commitAll(root: string, message: string): string {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Bench Example', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}
const log = (msg: string) => console.error(`[catchup ${new Date().toISOString().slice(11, 19)}] ${msg}`);

/** Child environment: hermetic home, no ambient database URL or provider keys. */
function childEnv(home: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (/_API_KEY$|_API_TOKEN$|^DATABASE_URL$|^GBRAIN_DATABASE_URL$|^OPENAI_BASE_URL$/.test(key)) delete env[key];
  return { ...env, GBRAIN_HOME: home, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SKILLS_DIR: join(home, 'skills'), NO_COLOR: '1',
    ...(POOL_SIZE ? { GBRAIN_POOL_SIZE: POOL_SIZE } : {}), ...(POOLER ? { GBRAIN_PREPARE: 'false' } : {}), ...extra };
}

interface CliRun { killed: boolean; code: number; stdout: string; stderr: string; wallMs: number; firstStderrMs: number | null; firstProgressMs: number | null; json: Record<string, unknown> | null }
async function runCli(home: string, args: string[], env: Record<string, string | undefined> = {}, timeoutMs = 30 * 60_000): Promise<CliRun> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: home, env: childEnv(home, env), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let killed = false;
  const timer = setTimeout(() => { killed = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 30_000).unref(); }, timeoutMs);
  let firstStderrMs: number | null = null;
  let firstProgressMs: number | null = null;
  let stderr = '';
  const errReader = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
      const at = performance.now() - started;
      if (firstStderrMs === null) firstStderrMs = at;
      stderr += decoder.decode(chunk);
      if (firstProgressMs === null && stderr.split('\n').some(l => /^\{.*"(event|phase)"/.test(l) || /\b\d+\/\d+\b.*(pages?|files?|entries)/i.test(l))) firstProgressMs = at;
    }
  })();
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited, errReader]);
  clearTimeout(timer);
  const lastJson = stdout.trim().split('\n').reverse().find(l => l.startsWith('{'));
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(stdout); } catch { try { json = lastJson ? JSON.parse(lastJson) : null; } catch { json = null; } }
  return { killed, code, stdout, stderr, wallMs: performance.now() - started, firstStderrMs, firstProgressMs, json };
}
async function mustCli(home: string, args: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> {
  const r = await runCli(home, args, env);
  if (r.code !== 0) throw new Error(`gbrain ${args.join(' ')} exited ${r.code}\nstdout: ${r.stdout.slice(-1500)}\nstderr: ${r.stderr.slice(-1500)}`);
  return r;
}

const fixture = generateScaleFixture({ pages: Math.max(20, 2 * (FILES + DELETES + HISTORY + RECEIPT_HISTORY) + 4), seed: SEED });
const padding = (i: number) => PAD_WORDS > 0
  ? '\n\n' + Array.from({ length: Math.ceil(PAD_WORDS / 24) }, (_, p) => `Paragraph ${p} of bench page ${i} carries ordinary note prose about meetings, plans, follow-ups and decisions that a real brain keeps.`).join('\n\n') + '\n'
  : '';
function writeFiles(root: string, files: Array<{ path: string; content: string }>): void {
  for (const p of files) { mkdirSync(dirname(join(root, p.path)), { recursive: true }); writeFileSync(join(root, p.path), p.content); }
}
function pagesFor(sourceIndex: number): Array<{ path: string; content: string }> {
  const sourceId = sourceIndex === 0 ? 'default' : 'scale-b';
  return fixture.pages.filter(p => p.sourceId === sourceId).map((p, i) => ({ path: `${p.slug}.md`, content: p.content + padding(i) }));
}

interface RowContext { name: string; rtt: number; db: string; home: string; roots: Record<string, string>; managed: boolean; trace: string; proxyUrl: string; directUrl: string; backlog: number }

let harness: Harness;
let template = '';
const created: string[] = [];

async function admin<T>(fn: (sql: ReturnType<typeof postgres>) => Promise<T>, db = 'postgres'): Promise<T> {
  const sql = postgres(harness.directUrl(db), { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}

async function buildTemplate(): Promise<void> {
  template = `gbrain_bench_tmpl_${randomBytes(4).toString('hex')}`;
  await admin(sql => sql.unsafe(`CREATE DATABASE ${template}`));
  created.push(template);
  await admin(sql => sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements'));
  const home = mkdtempSync(join(work, 'tmpl-'));
  writeConfig(home, harness.directUrl(template));
  const started = performance.now();
  process.env.GBRAIN_HOME = home;
  const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
  const engine = new PostgresEngine();
  await engine.connect({ database_url: harness.directUrl(template), poolSize: 2 });
  await engine.initSchema();
  await engine.disconnect();
  log(`template ${template} initialized in ${round1((performance.now() - started) / 1000)} s`);
}

function writeConfig(home: string, url: string, embeddings = false): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(join(home, 'skills'), { recursive: true });
  if (!existsSync(join(home, 'skills', 'RESOLVER.md'))) writeFileSync(join(home, 'skills', 'RESOLVER.md'), '# Bench fixture skills\n');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: url, self_upgrade: { mode: 'off' },
    ...(embeddings ? { embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1024 } : { embedding_disabled: true }) }, null, 2) + '\n');
}

/** Fresh database, classic-mode history and soft-deleted pages, then the backlog commit; activation when managed. */
async function setupRow(name: string, rtt: number, opts: { managed: boolean; sources: number; files: number; deletes: number }): Promise<RowContext> {
  const db = `gbrain_bench_${name.replace(/\W/g, '_')}_${rtt}_${randomBytes(3).toString('hex')}`;
  await admin(sql => sql.unsafe(`CREATE DATABASE ${db} TEMPLATE ${template}`));
  created.push(db);
  const home = mkdtempSync(join(work, `${name}-${rtt}-`));
  writeConfig(home, harness.directUrl(db));
  const roots: Record<string, string> = {};
  const ids = opts.sources === 2 ? [SOURCE, SOURCE_B] : [SOURCE];
  const perSource = Math.ceil(opts.files / ids.length);
  const deletesPer = Math.ceil(opts.deletes / ids.length);
  const doomedBySource: Record<string, string[]> = {};
  const later: Record<string, { doomed: Array<{ path: string }>; backlog: Array<{ path: string; content: string }>; receipts: Array<{ path: string; content: string }> }> = {};
  for (const [s, id] of ids.entries()) {
    const root = join(home, `repo-${id}`);
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q');
    const pages = pagesFor(s);
    const history = pages.slice(0, HISTORY);
    const doomed = pages.slice(HISTORY, HISTORY + deletesPer);
    const backlog = pages.slice(HISTORY + deletesPer, HISTORY + deletesPer + perSource);
    const receipts = opts.managed ? pages.slice(HISTORY + deletesPer + perSource, HISTORY + deletesPer + perSource + RECEIPT_HISTORY) : [];
    writeFiles(root, [...history, ...doomed]);
    writeFileSync(join(root, 'README.md'), '# Bench source\n');
    commitAll(root, 'history');
    await mustCli(home, ['sources', 'add', id, '--path', root, '--no-federated']);
    await mustCli(home, ['sync', '--source', id, '--no-pull', '--no-embed', '--json'], { GBRAIN_SQL_TRACE_LABEL: 'setup' });
    doomedBySource[id] = doomed.map(p => p.path.replace(/\.md$/, ''));
    later[id] = { doomed, backlog, receipts };
    roots[id] = root;
  }
  await softDelete(home, harness.directUrl(db), doomedBySource);
  if (opts.managed) {
    for (const [id, root] of Object.entries(roots)) {
      const state = (await mustCli(home, ['sources', 'writer', 'status', '--json'])).json!.admin_state as string;
      await mustCli(home, ['sources', 'writer', 'claim', id, '--path', root, '--admin-intent', 'writer_claim', '--expected-state', state, '--json']);
    }
    const state = (await mustCli(home, ['sources', 'writer', 'status', '--json'])).json!.admin_state as string;
    const activated = await mustCli(home, ['sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', state, '--json']);
    if (activated.json?.enabled !== true) throw new Error(`activation did not enable managed persistence: ${activated.stdout}`);
    for (const [id, root] of Object.entries(roots)) {
      if (!later[id]!.receipts.length) continue;
      writeFiles(root, later[id]!.receipts);
      commitAll(root, 'receipt history');
      for (let i = 0; ; i++) {
        const r = await runCli(home, ['sync', '--source', id, '--no-pull', '--no-embed', '--json'], { GBRAIN_SQL_TRACE_LABEL: 'setup' });
        if (r.json?.sync_status !== 'partial') { if (r.code !== 0) throw new Error(`receipt-history sync failed: ${r.stdout.slice(-1500)}`); break; }
        if (i > 50) throw new Error('receipt-history sync did not converge');
      }
    }
  }
  for (const [id, root] of Object.entries(roots)) {
    for (const p of later[id]!.doomed) rmSync(join(root, p.path));
    writeFiles(root, later[id]!.backlog);
    commitAll(root, 'backlog');
  }
  writeConfig(home, harness.proxyUrl(db));
  return { name, rtt, db, home, roots, managed: opts.managed, trace: join(home, 'sql-trace.jsonl'), proxyUrl: harness.proxyUrl(db), directUrl: harness.directUrl(db),
    backlog: ids.length * (perSource + deletesPer) };
}

/** Soft-deletes the given pages in classic mode, before activation (the reporter's already-soft-deleted manifest deletes). */
async function softDelete(home: string, url: string, slugs: Record<string, string[]>): Promise<void> {
  process.env.GBRAIN_HOME = home;
  const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url, poolSize: 2 });
  try {
    for (const [sourceId, list] of Object.entries(slugs)) for (const slug of list) {
      if (!(await engine.softDeletePage(slug, { sourceId }))) throw new Error(`soft delete of ${sourceId}/${slug} found no page`);
    }
  } finally { await engine.disconnect(); }
}

interface Driven { failures?: string[]; iterations: Array<{ wallMs: number; code: number; status: string | null; reason: string | null; firstStderrMs: number | null; firstProgressMs: number | null }>; done: boolean; timedOut: boolean; wallMs: number; error?: string; passes?: unknown[] }

/** Re-runs the CLI until the source reports synced, a failure stops it, or the time box ends. */
async function driveCli(row: RowContext, args: string[], extraEnv: Record<string, string> = {}): Promise<Driven> {
  const started = performance.now();
  const iterations: Driven['iterations'] = [];
  const failures: string[] = [];
  let stalled = 0;
  let before = await committedCount(row);
  while (performance.now() - started < MAX_MS) {
    const r = await runCli(row.home, args, { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'cli-sync', ...extraEnv }, Math.max(1000, MAX_MS - (performance.now() - started)));
    const found: Array<{ status: string; reason: string }> = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (!v || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      const st = o.sync_status ?? (typeof o.status === 'string' && o.source_id ? o.status : undefined);
      if (typeof st === 'string') found.push({ status: st, reason: String(o.reason ?? '') });
      else Object.values(o).forEach(walk);
    };
    walk(r.json);
    const status = found.length ? found.map(x => x.status).join(',') : null;
    const reason = found.length ? found.map(x => x.reason).join(',') : null;
    iterations.push({ wallMs: round1(r.wallMs), code: r.code, status, reason, firstStderrMs: r.firstStderrMs === null ? null : round1(r.firstStderrMs), firstProgressMs: r.firstProgressMs === null ? null : round1(r.firstProgressMs) });
    if (iterations.length % 10 === 1) log(`${row.name}@${row.rtt}: iteration ${iterations.length} ${status}/${reason} ${round1(r.wallMs / 1000)} s`);
    const statuses = (status ?? '').split(',');
    if (status && statuses.every(s => ['synced', 'first_sync', 'up_to_date'].includes(s))) return { iterations, failures, done: true, timedOut: false, wallMs: performance.now() - started };
    if (r.code !== 0 && !r.killed && !statuses.includes('partial')) failures.push((r.stdout + r.stderr).match(/code=(\w+)|"(?:error|code)":"(\w+)"/)?.slice(1).find(Boolean) ?? `exit_${r.code}`);
    const after = await committedCount(row);
    stalled = after === before ? stalled + 1 : 0;
    before = after;
    if (stalled >= STALL_ITERATIONS) return { iterations, failures, done: false, timedOut: false, wallMs: performance.now() - started, error: `no progress in ${STALL_ITERATIONS} iterations: ${(r.stdout + r.stderr).slice(-800)}` };
  }
  return { iterations, failures, done: false, timedOut: true, wallMs: performance.now() - started };
}

async function committedCount(row: RowContext): Promise<number> {
  return admin(async sql => Number((await sql.unsafe(`${BENCH_SQL} SELECT count(*)::int AS n FROM persistence_requests WHERE state='committed' AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete')`))[0]!.n), row.db);
}

async function driveReentry(row: RowContext): Promise<Driven> {
  const markers = join(row.home, 'reentry-passes.jsonl');
  const started = performance.now();
  const child = Bun.spawn([process.execPath, import.meta.path, '--worker', 'reentry'], { cwd: row.home, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: childEnv(row.home, { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'reentry', BENCH_SOURCE: SOURCE, BENCH_MARKERS: markers, BENCH_MAX_MS: String(MAX_MS) }) });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const passes = existsSync(markers) ? readFileSync(markers, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const last = passes.at(-1) as { status?: string } | undefined;
  const done = code === 0 && ['synced', 'first_sync', 'up_to_date'].includes(last?.status ?? '');
  return { iterations: [], passes, done, timedOut: code === 0 && !done, wallMs: performance.now() - started, ...(code !== 0 ? { error: `reentry worker exit ${code}: ${(stdout + stderr).slice(-1500)}` } : {}) };
}

async function runWorker(kind: string): Promise<never> {
  const { loadConfig, toEngineConfig } = await import('../../src/core/config.ts');
  const { createEngine } = await import('../../src/core/engine-factory.ts');
  const config = loadConfig()!;
  const engine = await createEngine(toEngineConfig(config));
  await engine.connect(toEngineConfig(config));
  const { disposePersistenceConsumer } = await import('../../src/core/persistence/service.ts');
  const sourceId = process.env.BENCH_SOURCE!;
  if (kind === 'reentry') {
    const { performSync } = await import('../../src/commands/sync/perform.ts');
    const deadline = performance.now() + Number(process.env.BENCH_MAX_MS);
    for (let pass = 0; performance.now() < deadline; pass++) {
      const t = performance.timeOrigin + performance.now();
      const result = await performSync(engine, { sourceId, noPull: true, noEmbed: true } as Parameters<typeof performSync>[1]);
      const end = performance.timeOrigin + performance.now();
      appendFileSync(process.env.BENCH_MARKERS!, JSON.stringify({ pass, t, end, status: result.status, reason: (result as { reason?: string }).reason ?? null, banked: (result as { bankedFiles?: number }).bankedFiles ?? null }) + '\n');
      if (result.status !== 'partial') break;
      await Bun.sleep(250);
    }
  } else if (kind === 'foreground' || kind === 'foreground-open') {
    const { submitPageMutation } = await import('../../src/core/persistence/page-mutations.ts');
    const stopFile = process.env.BENCH_STOP!;
    const results: ForegroundWrite[] = [];
    const logger = { info() {}, warn() {}, error() {} };
    const open = kind === 'foreground-open';
    const submit = async (i: number): Promise<void> => {
      const t = performance.now();
      const start = Date.now();
      const slug = `notes/bench-${open ? 'open' : 'foreground'}-${process.pid}-${i}`;
      try {
        const out = await submitPageMutation({ engine, config, remote: false, dryRun: false, sourceId, logger } as unknown as Parameters<typeof submitPageMutation>[0],
          { operation: 'put_page', params: { slug, content: `---\ntitle: Foreground ${i}\n---\nForeground write ${i} during catch-up.\n` }, waitMs: 30_000 });
        const state = String((out as { state?: string; status?: string }).state ?? (out as { status?: string }).status ?? '');
        results.push({ start, t: Date.now(), ms: round1(performance.now() - t), ok: !['failed', 'conflict', 'cancelled'].includes(state), state });
      } catch (error) {
        const e = error as { code?: string; message?: string };
        results.push({ start, t: Date.now(), ms: round1(performance.now() - t), ok: false, code: e.code ?? (/lock timeout/i.test(e.message ?? '') ? '55P03' : 'error'), state: (e.message ?? '').slice(0, 200) });
      }
    };
    const intervalMs = open ? Number(process.env.BENCH_INTERVAL_MS) : 1000;
    const inflight = new Set<Promise<void>>();
    const began = performance.now();
    for (let i = 0; !existsSync(stopFile); i++) {
      const t = performance.now();
      if (!open) { await submit(i); await Bun.sleep(Math.max(0, 1000 - (performance.now() - t))); continue; }
      const write: Promise<void> = submit(i).finally(() => inflight.delete(write));
      inflight.add(write);
      while (!existsSync(stopFile) && performance.now() < began + (i + 1) * intervalMs) await Bun.sleep(Math.min(250, Math.max(1, began + (i + 1) * intervalMs - performance.now())));
    }
    await Promise.all(inflight);
    writeFileSync(process.env.BENCH_RESULTS!, JSON.stringify(results));
  }
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  process.exit(0);
}

interface ForegroundWrite { start?: number; t: number; ms: number; ok: boolean; code?: string; state?: string }

async function foregroundWriter(row: RowContext, tag: string, kind: 'foreground' | 'foreground-open' = 'foreground'): Promise<{ stop: () => Promise<ForegroundWrite[]> }> {
  const stopFile = join(row.home, `foreground-${tag}.stop`);
  const results = join(row.home, `foreground-${tag}.json`);
  const child = Bun.spawn([process.execPath, import.meta.path, '--worker', kind], { cwd: row.home, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: childEnv(row.home, { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'foreground', BENCH_SOURCE: SOURCE, BENCH_STOP: stopFile, BENCH_RESULTS: results,
      BENCH_INTERVAL_MS: String(FG_INTERVAL_S * 1000) }) });
  return {
    async stop() {
      writeFileSync(stopFile, '');
      const [stderr] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      if (!existsSync(results)) throw new Error(`foreground worker wrote no results: ${stderr.slice(-1500)}`);
      return JSON.parse(readFileSync(results, 'utf8'));
    },
  };
}

/** Latency, failures by code and per-put_page round trips and spans of one foreground writer's results. */
function summarizeWrites(rs: ForegroundWrite[], fgRecords: TraceRecord[]): Record<string, unknown> {
  const code = (r: ForegroundWrite) => r.code ?? r.state ?? '?';
  return { writes: rs.length, round_trips: foregroundRoundTrips(fgRecords, rs), spans: foregroundSpans(fgRecords, rs), p50_ms: pct(rs.map(r => r.ms), 50), p95_ms: pct(rs.map(r => r.ms), 95),
    failures: rs.filter(r => !r.ok).length,
    lock_timeouts: rs.filter(r => r.code === '55P03' || /lock_timeout|lock timeout/i.test(r.state ?? '')).length,
    failure_codes: Object.fromEntries([...new Set(rs.filter(r => !r.ok).map(code))].map(c => [c, rs.filter(r => !r.ok && code(r) === c).length])) };
}

function startServe(row: RowContext, env: Record<string, string> = {}): { stop: () => Promise<string> } {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = Bun.spawn([process.execPath, CLI, 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port)], { cwd: row.home, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: childEnv(row.home, { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'serve', ...env }) });
  return { async stop() { child.kill('SIGTERM'); const t = setTimeout(() => child.kill('SIGKILL'), 15_000); const err = await new Response(child.stderr).text(); await child.exited; clearTimeout(t); return err.slice(-2000); } };
}

/** Most writes of one writer in flight at once. */
function maxInFlight(rs: ForegroundWrite[]): number {
  const events = rs.flatMap(r => [{ t: r.t - r.ms, d: 1 }, { t: r.t, d: -1 }]).sort((a, b) => a.t - b.t || a.d - b.d);
  let open = 0, max = 0;
  for (const e of events) { open += e.d; max = Math.max(max, open); }
  return max;
}

/** Statements a CLI process issues before its first admission, and what fraction of a process's statements that is. */
function processBreakdown(records: TraceRecord[]): Record<string, unknown> {
  const byPid = new Map<number, TraceRecord[]>();
  for (const r of records) {
    if (family(r.label) !== 'cli-sync' && family(r.label) !== 'reentry') continue;
    const list = byPid.get(r.pid) ?? [];
    if (!list.length) byPid.set(r.pid, list);
    list.push(r);
  }
  const prologue: number[] = []; const prologueMs: number[] = []; const perProcess: number[] = [];
  for (const rs of byPid.values()) {
    rs.sort((a, b) => a.t - b.t);
    const first = rs.findIndex(r => /INSERT INTO persistence_requests/i.test(r.sql));
    perProcess.push(rs.length);
    if (first >= 0) { prologue.push(first); prologueMs.push(rs[first]!.t - rs[0]!.t); }
  }
  return { processes: byPid.size, statements_per_process_p50: pct(perProcess, 50), statements_before_first_admission_p50: pct(prologue, 50),
    ms_from_first_statement_to_first_admission_p50: pct(prologueMs, 50) };
}

async function collect(row: RowContext, driven: Driven, locks: LockSample[], measureStart: Date, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const records = readTrace(row.trace, r => r.label !== 'setup' && r.t >= measureStart.getTime());
  const stats = await admin(async sql => {
    const reqs = await sql.unsafe(`${BENCH_SQL} SELECT intent->>'kind' AS kind, state, (outcome->>'noop')::boolean AS noop,
        extract(epoch FROM created_at)*1000 AS created, extract(epoch FROM completed_at)*1000 AS completed, operation
      FROM persistence_requests WHERE created_at >= $1 ORDER BY sequence`, [measureStart]) as unknown as Array<{ kind: string | null; state: string; noop: boolean | null; created: number; completed: number | null; operation: string }>;
    const counters = await sql.unsafe(BENCH_SQL + ' SELECT key, outstanding_count::float8 AS outstanding, lifetime_ids::float8 AS lifetime_ids, intent_bytes::float8 AS intent_bytes, terminal_bytes::float8 AS terminal_bytes FROM persistence_counters ORDER BY key');
    const size = Number((await sql.unsafe(BENCH_SQL + ' SELECT pg_database_size(current_database())::float8 AS b'))[0]!.b);
    const pages = Number((await sql.unsafe(`${BENCH_SQL} SELECT count(*)::int AS n FROM pages WHERE source_id IN ('${SOURCE}','${SOURCE_B}') AND deleted_at IS NULL`))[0]!.n);
    return { reqs, counters, size, pages };
  }, row.db);
  const pss = await admin(sql => readPgStatStatements(sql, row.db));
  const syncReqs = stats.reqs.filter(r => r.kind === 'managed_sync_import' || r.kind === 'managed_sync_delete');
  const committed = syncReqs.filter(r => r.state === 'committed' && r.completed);
  const completions = committed.map(r => r.completed!).sort((a, b) => a - b);
  const gaps = completions.slice(1).map((c, i) => c - completions[i]!);
  const ordered = [...committed].sort((a, b) => a.completed! - b.completed!);
  const gapOf = (kind: string) => ordered.slice(1).flatMap((r, i) => r.kind === kind ? [r.completed! - ordered[i]!.completed!] : []);
  const pages = committed.length || (row.managed ? 0 : Math.max(0, stats.pages - HISTORY * Object.keys(row.roots).length));
  const minutes = driven.wallMs / 60_000;
  const guard = records.filter(r => /page_write_guards/i.test(r.sql) && /for update/i.test(r.sql));
  const syncProc = records.filter(r => ['cli-sync', 'reentry'].includes(family(r.label)) && r.kind !== 'describe');
  const byClass: Record<string, number> = {};
  for (const r of syncProc) byClass[classify(r.sql)] = (byClass[classify(r.sql)] ?? 0) + 1;
  const holder = new Map<string, { samples: number; waiting: string; blocker_app: string; blocker_query: string; blocker_state: string }>();
  for (const s of locks) {
    const key = `${normalizeSql(s.waiting_query)}|${family(s.blocker_app.replace(/^gbrain:/, ''))}|${normalizeSql(s.blocker_query)}`;
    const h = holder.get(key) ?? { samples: 0, waiting: normalizeSql(s.waiting_query), blocker_app: family(s.blocker_app.replace(/^gbrain:/, '')), blocker_query: normalizeSql(s.blocker_query), blocker_state: s.blocker_state };
    h.samples++; holder.set(key, h);
  }
  const byFamily = (re: RegExp) => {
    const matches = new Map<string, boolean>();
    const counts: Record<string, number> = {};
    for (const r of records) {
      if (r.kind === 'describe') continue;
      let hit = matches.get(r.sql);
      if (hit === undefined) { hit = re.test(flatSql(r.sql)); matches.set(r.sql, hit); }
      if (hit) counts[family(r.label)] = (counts[family(r.label)] ?? 0) + 1;
    }
    return counts;
  };
  const claims = byFamily(/^UPDATE persistence_requests SET state='running', ?execution_token/);
  const publications = byFamily(/^UPDATE persistence_requests SET state=\$2,outcome=/);
  const releases = byFamily(/^UPDATE persistence_requests SET state='queued',execution_token=NULL/);
  const traced = records.filter(r => (r.kind === 'execute' || r.kind === 'simple') && !isTxnControl(r.sql)).length;
  const lanes = laneApply(records);
  return {
    row: row.name, rtt_target_ms: row.rtt, managed: row.managed, backlog_entries: row.backlog, home: row.home, database: row.db,
    settings: { ...SETTINGS, default_settings: DEFAULT_SETTINGS, pooler_detail: harness.pooler, lanes_busy_max_observed: (lanes.lanes_busy as { max: number }).max },
    done: driven.done, timed_out: driven.timedOut, error: driven.error ?? null,
    wall_s: round1(driven.wallMs / 1000),
    entries_committed: committed.length,
    entries_noop: committed.filter(r => r.noop).length,
    entries_waived: null,
    pages_per_min: minutes > 0 ? round1(pages / minutes) : null,
    extrapolated_full_backlog_h: !driven.done && pages > 0 ? round1((row.backlog / (pages / minutes)) / 60) : null,
    steady_state: { ...steadyRate(commitTimes(records), syncStart(records)), source: 'trace',
      db: { ...steadyRate(completions, measureStart.getTime()), source: 'persistence_requests.completed_at; first commit from the row start' } },
    per_page_wall_ms: { p50: pct(gaps, 50), p90: pct(gaps, 90), import_p50: pct(gapOf('managed_sync_import'), 50), delete_p50: pct(gapOf('managed_sync_delete'), 50) },
    admission_to_commit_ms: { p50: pct(committed.map(r => r.completed! - r.created), 50), p90: pct(committed.map(r => r.completed! - r.created), 90), p99: pct(committed.map(r => r.completed! - r.created), 99) },
    requests_by_state: Object.fromEntries([...new Set(stats.reqs.map(r => `${r.kind ?? r.operation}:${r.state}`))].map(k => [k, stats.reqs.filter(r => `${r.kind ?? r.operation}:${r.state}` === k).length])),
    cli: driven.iterations.length ? {
      invocations: driven.iterations.length, wall_ms_p50: pct(driven.iterations.map(i => i.wallMs), 50), wall_ms_p90: pct(driven.iterations.map(i => i.wallMs), 90),
      pages_per_invocation: round1(pages / driven.iterations.length),
      writer_pending_exits: driven.iterations.filter(i => i.reason === 'writer_pending').length,
      first_stderr_ms_p50: pct(driven.iterations.flatMap(i => i.firstStderrMs === null ? [] : [i.firstStderrMs]), 50),
      e1_first_progress_ms: driven.iterations[0]?.firstProgressMs ?? null,
      failed_runs: Object.fromEntries([...new Set(driven.failures ?? [])].map(k => [k, (driven.failures ?? []).filter(x => x === k).length])),
      statuses: Object.fromEntries([...new Set(driven.iterations.map(i => `${i.status}/${i.reason}`))].map(k => [k, driven.iterations.filter(i => `${i.status}/${i.reason}` === k).length])),
    } : null,
    reentry: driven.passes ? { passes: driven.passes.length, statuses: driven.passes.map(p => `${(p as { status: string }).status}/${(p as { reason: string }).reason}`).slice(-3) } : null,
    trace: {
      round_trips: records.length, round_trips_per_page: pages ? round1(records.length / pages) : null,
      describe_round_trips: records.filter(r => r.kind === 'describe').length,
      connections_opened: records.filter(r => r.kind === 'connect').length,
      connect_ms_p50: pct(records.filter(r => r.kind === 'connect').map(r => r.ms), 50),
      db_ms_per_page: pages ? round1(sum(records.map(r => r.ms)) / pages) : null,
      by_process: Object.fromEntries([...new Set(records.map(r => family(r.label)))].map(f => {
        const rs = records.filter(r => family(r.label) === f);
        return [f, { round_trips: rs.length, per_page: pages ? round1(rs.length / pages) : null, ms: round1(sum(rs.map(r => r.ms))), processes: new Set(rs.map(r => r.pid)).size }];
      })),
      round_trips_by_class: Object.fromEntries(Object.entries(records.reduce<Record<string, number>>((acc, r) => { acc[classify(r.sql)] = (acc[classify(r.sql)] ?? 0) + 1; return acc; }, {})).map(([k, n]) => [k, pages ? round1(n / pages) : null])),
      sync_process_by_class: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, { round_trips: v, per_page: pages ? round1(v / pages) : null, share: round1(100 * v / Math.max(1, syncProc.length)) }])),
      errors: Object.fromEntries([...new Set(records.flatMap(r => r.err ? [`${family(r.label)}:${r.err}`] : []))].map(e => [e, records.filter(r => r.err && `${family(r.label)}:${r.err}` === e).length])),
      top_statements: groupStatements(records, pages, 40),
      re_entry: processBreakdown(records),
      critical_path: criticalPath(records, pages || null),
      publication: publicationBreakdown(records),
      feeder: feederBreakdown(records, pages || null),
      lanes,
      describes: describeRoundTrips(records),
      pg_stat_statements_calls_ex_txn: pss.calls_ex_txn, traced_executions_ex_txn: traced,
      reconciliation_pct: pss.available && pss.calls_ex_txn ? round1(100 * (traced - pss.calls_ex_txn) / pss.calls_ex_txn) : null,
    },
    pg_stat_statements: pss,
    guard_wait: {
      statements: guard.length, total_ms: round1(sum(guard.map(r => r.ms))), per_page_ms: pages ? round1(sum(guard.map(r => r.ms)) / pages) : null,
      p50_ms: pct(guard.map(r => r.ms), 50), max_ms: pct(guard.map(r => r.ms), 100),
    },
    claims: { claims_by_process: claims, publications_by_process: publications, released_unpublished_by_process: releases },
    lock_waits: { samples: locks.length, sample_every_ms: 100, by_holder: [...holder.values()].sort((a, b) => b.samples - a.samples).slice(0, 12) },
    db_growth_bytes_per_page: null as number | null,
    db_size_bytes: stats.size,
    persistence_counters: stats.counters,
    capacity_headroom: capacityHeadroom(stats.counters as unknown as Array<{ key: string; lifetime_ids: number; terminal_bytes: number }>, row.backlog),
    ...extra,
  };
}

/** CEO-A25: lifetime IDs and terminal bytes used vs the default journal limits, and what the whole backlog would reserve at the observed bytes per request. */
function capacityHeadroom(counters: Array<{ key: string; lifetime_ids: number; terminal_bytes: number }>, backlog: number): Record<string, unknown> {
  const brain = counters.find(c => c.key === 'brain');
  const principal = counters.filter(c => c.key.startsWith('principal:')).sort((a, b) => b.terminal_bytes - a.terminal_bytes)[0];
  if (!brain || !principal || !brain.lifetime_ids) return { available: false };
  const perRequest = principal.terminal_bytes / Math.max(1, principal.lifetime_ids);
  const limits = DEFAULT_JOURNAL_LIMITS;
  return { terminal_bytes_per_request: Math.round(perRequest),
    brain_lifetime_ids_used_pct: round1(100 * brain.lifetime_ids / limits.brainLifetimeIds),
    principal_terminal_bytes_used_pct: round1(100 * principal.terminal_bytes / limits.principalTerminalBytes),
    full_backlog_principal_terminal_bytes_pct: round1(100 * (principal.terminal_bytes + perRequest * backlog) / limits.principalTerminalBytes),
    full_backlog_principal_lifetime_ids_pct: round1(100 * (principal.lifetime_ids + backlog) / limits.principalLifetimeIds) };
}

async function measure(row: RowContext, drive: () => Promise<Driven>, extra: () => Promise<Record<string, unknown>> = async () => ({})): Promise<Record<string, unknown>> {
  await harness.setRtt(row.rtt);
  const sizeBefore = await admin(async sql => Number((await sql.unsafe(BENCH_SQL + ' SELECT pg_database_size(current_database())::float8 AS b'))[0]!.b), row.db);
  await admin(sql => sql.unsafe(BENCH_SQL + ' SELECT pg_stat_statements_reset(0, (SELECT oid FROM pg_database WHERE datname=$1), 0)', [row.db]).catch(() => undefined));
  const measuredRtt = await measureRtt(row.proxyUrl, !POOLER);
  const sampler = startLockSampler(harness.adminUrl, row.db);
  const effectsSampler = startEffectsSampler(row.directUrl);
  const start = new Date();
  log(`${row.name}@${row.rtt}: measuring (proxy RTT ${measuredRtt} ms, backlog ${row.backlog})`);
  const driven = await drive();
  const more = await extra();
  const locks = await sampler.stop();
  const backlog = await effectsSampler.stop();
  const effects = await admin(async sql => ({ ...await readEffects(sql, start),
    final_backlog: Number((await sql.unsafe(`${BENCH_SQL} SELECT count(*) FILTER (WHERE state IN ('queued','running'))::int AS n FROM persistence_effects`))[0]!.n) }), row.db);
  const result = await collect(row, driven, locks, start, { rtt_measured_ms: measuredRtt, ...more, effects,
    effects_backlog: { samples: backlog.length, sample_every_ms: 2000, max: pct(backlog, 100), p50: pct(backlog, 50), final: effects.final_backlog } });
  const trace = result.trace as Record<string, Record<string, unknown>>;
  console.error(renderAnalysis(trace.critical_path!, trace.publication!));
  const spans: Record<string, Record<string, unknown>> = {};
  for (const key of ['foreground_idle', 'foreground_during_catchup', 'foreground_open']) {
    const fg = result[key] as { round_trips?: unknown; spans?: Record<string, unknown> } | undefined;
    if (fg?.round_trips) console.error(`${key} per put_page: ${JSON.stringify(fg.round_trips)}`);
    if (fg?.spans) spans[key] = fg.spans;
  }
  console.error(renderPhase0({ feeder: trace.feeder, lanes: trace.lanes, describes: trace.describes, steady: result.steady_state as Record<string, unknown>, spans }));
  const open = result.foreground_open as Record<string, unknown> | undefined;
  if (open) {
    Object.assign(open, { catchup_pages_per_min: result.pages_per_min, catchup_steady_pages_per_min: (result.steady_state as Record<string, unknown>).pages_per_min_10_90 });
    console.error(`foreground_open: ${open.submitted} submitted at ${open.arrival_per_min}/min, p50 ${open.p50_ms} ms, p95 ${open.p95_ms} ms, failures ${JSON.stringify(open.failure_codes)}, catch-up ${open.catchup_pages_per_min} pages/min`);
  }
  console.error(`effects: ${JSON.stringify(effects)}; backlog ${JSON.stringify(result.effects_backlog)}`);
  const committed = result.entries_committed as number;
  result.db_growth_bytes_per_page = committed ? Math.round(((result.db_size_bytes as number) - sizeBefore) / committed) : null;
  result.cli_is_owner_host = await ownerHost(row);
  log(`${row.name}@${row.rtt}: ${result.pages_per_min} pages/min, done=${result.done}, ${committed} committed, ${(result.trace as { round_trips_per_page: number }).round_trips_per_page} round trips/page`);
  return result;
}

/** ENG-A9: whether this home's host identity is the worktree owner host. */
async function ownerHost(row: RowContext): Promise<boolean | null> {
  const file = join(row.home, '.gbrain', 'persistence', 'host.json');
  const candidates = [file, join(row.home, 'persistence', 'host.json'), join(row.home, '.gbrain', 'host.json')];
  const found = candidates.find(existsSync);
  if (!found) return null;
  const hostId = (JSON.parse(readFileSync(found, 'utf8')) as { host_id?: string; id?: string }).host_id ?? (JSON.parse(readFileSync(found, 'utf8')) as { id?: string }).id;
  const owners = await admin(sql => sql.unsafe(BENCH_SQL + ' SELECT DISTINCT owner_host_id::text AS h FROM persistence_worktrees WHERE owner_host_id IS NOT NULL'), row.db) as unknown as Array<{ h: string }>;
  return owners.length ? owners.every(o => o.h === hostId) : null;
}

async function retrievalReadiness(row: RowContext, budgetMs: number): Promise<Record<string, unknown>> {
  const started = performance.now();
  let last: Record<string, number> = {};
  for (let first = true; first || performance.now() - started < budgetMs; first = false) {
    last = await admin(async sql => {
      const [c] = await sql.unsafe(`${BENCH_SQL} SELECT count(*) FILTER (WHERE cc.embedding IS NULL)::int AS unembedded, count(*)::int AS chunks
        FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.source_id = $1 AND p.deleted_at IS NULL`, [SOURCE]);
      const [e] = await sql.unsafe(`${BENCH_SQL} SELECT count(*) FILTER (WHERE e.state IN ('queued','running'))::int AS pending, count(*) FILTER (WHERE e.state = 'failed')::int AS failed
        FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id WHERE r.source_id = $1`, [SOURCE]);
      const [j] = await sql.unsafe(`${BENCH_SQL} SELECT count(*) FILTER (WHERE status IN ('waiting','active','delayed'))::int AS jobs FROM minion_jobs`).catch(() => [{ jobs: -1 }]);
      const [l] = await sql.unsafe(`${BENCH_SQL} SELECT count(*)::int AS stale FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND (links_extracted_at IS NULL OR links_extracted_at < updated_at)`, [SOURCE]);
      return { unembedded: c!.unembedded, chunks: c!.chunks, effects_pending: e!.pending, effects_failed: e!.failed, jobs_pending: j!.jobs, links_stale: l!.stale };
    }, row.db);
    if (last.unembedded === 0 && last.effects_pending === 0 && last.jobs_pending <= 0 && last.links_stale === 0) return { retrieval_ready: true, retrieval_ready_after_sync_s: round1((performance.now() - started) / 1000), readiness: last };
    if (budgetMs > 0) await Bun.sleep(2000);
  }
  return { retrieval_ready: false, retrieval_ready_after_sync_s: null, readiness: last };
}

async function runRow(name: string, rtt: number): Promise<Record<string, unknown>> {
  const syncArgs = ['sync', '--source', SOURCE, '--no-pull', '--no-embed', '--json'];
  if (name === 'cli') { const row = await setupRow(name, rtt, { managed: true, sources: 1, files: FILES, deletes: DELETES }); return measure(row, () => driveCli(row, syncArgs)); }
  if (name === 'reentry') { const row = await setupRow(name, rtt, { managed: true, sources: 1, files: FILES, deletes: DELETES }); return measure(row, () => driveReentry(row)); }
  if (name === 'unmanaged') { const row = await setupRow(name, rtt, { managed: false, sources: 1, files: FILES, deletes: DELETES }); return measure(row, () => driveCli(row, syncArgs)); }
  if (name === 'serve') {
    const row = await setupRow(name, rtt, { managed: true, sources: 1, files: FILES, deletes: DELETES });
    await harness.setRtt(rtt);
    const serve = startServe(row);
    await Bun.sleep(8000);
    return measure(row, () => driveCli(row, syncArgs), async () => ({ serve_stderr_tail: (await serve.stop()).slice(-400) }));
  }
  if (name === 'effects') {
    const stub = await startEmbeddingStub({ latencyMs: 200, maxConcurrent: 4, dims: 1024 });
    try {
      const row = await setupRow(name, rtt, { managed: true, sources: 1, files: FILES, deletes: DELETES });
      writeConfig(row.home, row.proxyUrl, true);
      const env = { OPENAI_API_KEY: 'bench-stub-key', OPENAI_BASE_URL: stub.url };
      await harness.setRtt(rtt);
      const serve = startServe(row, env);
      await Bun.sleep(8000);
      return await measure(row, () => driveCli(row, ['sync', '--source', SOURCE, '--no-pull', '--json'], env), async () => {
        const atExit = await retrievalReadiness(row, 0);
        const ready = await retrievalReadiness(row, MAX_MS);
        return { effects_backlog_at_cli_exit: atExit.readiness, ...ready, embedding_stub: { ...stub.stats }, serve_stderr_tail: (await serve.stop()).slice(-400) };
      });
    } finally { stub.close(); }
  }
  if (name === 'foreground') {
    const row = await setupRow(name, rtt, { managed: true, sources: 1, files: FILES, deletes: DELETES });
    await harness.setRtt(rtt);
    const idle = await foregroundWriter(row, 'idle');
    await Bun.sleep(60_000);
    const idleResults = await idle.stop();
    let busy: Awaited<ReturnType<typeof foregroundWriter>> | undefined;
    return measure(row, async () => { busy = await foregroundWriter(row, 'busy'); return driveCli(row, syncArgs); }, async () => {
      const busyResults = await busy!.stop();
      const fgRecords = readTrace(row.trace, r => family(r.label) === 'foreground');
      return { foreground_idle: summarizeWrites(idleResults, fgRecords), foreground_during_catchup: summarizeWrites(busyResults, fgRecords) };
    });
  }
  if (name === 'foreground-open') {
    const row = await setupRow(name, rtt, { managed: true, sources: 1, files: FILES, deletes: DELETES });
    let open: Awaited<ReturnType<typeof foregroundWriter>> | undefined;
    return measure(row, async () => { open = await foregroundWriter(row, 'open', 'foreground-open'); return driveCli(row, syncArgs); }, async () => {
      const results = await open!.stop();
      const fgRecords = readTrace(row.trace, r => family(r.label) === 'foreground');
      const starts = results.flatMap(r => r.start === undefined ? [] : [r.start]).sort((a, b) => a - b);
      const spanMin = starts.length > 1 ? (starts.at(-1)! - starts[0]!) / 60_000 : 0;
      return { foreground_open: { interval_s: FG_INTERVAL_S, submitted: results.length, arrival_per_min: spanMin > 0 ? round1((starts.length - 1) / spanMin) : null,
        max_in_flight: maxInFlight(results), ...summarizeWrites(results, fgRecords) } };
    });
  }
  if (name === 'all') {
    const row = await setupRow(name, rtt, { managed: true, sources: 2, files: FILES, deletes: DELETES });
    return measure(row, () => driveCli(row, ['sync', '--all', '--no-pull', '--no-embed', '--json']));
  }
  if (name === 'newcomer') return newcomer(rtt);
  throw new Error(`unknown row ${name}`);
}

/** DX-A12: cold CLI start to first progress line on a managed backlog, and a 5-page managed source to a search hit. */
async function newcomer(rtt: number): Promise<Record<string, unknown>> {
  const row = await setupRow('newcomer', rtt, { managed: true, sources: 1, files: 5, deletes: 0 });
  await harness.setRtt(rtt);
  const started = performance.now();
  const first = await runCli(row.home, ['--progress-json', '--progress-interval', '0', 'sync', '--source', SOURCE, '--no-pull', '--no-embed'], { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'cli-sync' });
  const firstProgressMs = first.firstProgressMs;
  let runs = 1;
  let status = first.stdout;
  for (; runs < 30 && !/synced|up to date|up_to_date|first_sync/i.test(status); runs++) {
    status = (await runCli(row.home, ['sync', '--source', SOURCE, '--no-pull', '--no-embed', '--json'])).stdout;
  }
  const token = pagesFor(0)[HISTORY]!.content.match(/Marker (\w+)\./)?.[1] ?? 'scaletok';
  const search = await runCli(row.home, ['search', token, '--json']);
  return { row: 'newcomer', rtt_target_ms: rtt, e1_cold_start_to_first_progress_ms: firstProgressMs === null ? null : round1(firstProgressMs),
    e1_cold_start_to_first_stderr_ms: first.firstStderrMs === null ? null : round1(first.firstStderrMs), e1_wall_ms: round1(first.wallMs),
    newcomer_sync_runs: runs, newcomer_to_search_hit_s: round1((performance.now() - started) / 1000), search_hit: search.stdout.includes(token) || search.stdout.includes('scale-0-'),
    first_stderr_sample: first.stderr.split('\n').slice(0, 3) };
}

harness = await startHarness({ pgPort: Number(flag('pg-port', '55432')), proxyPort: Number(flag('proxy-port', '55433')), apiPort: Number(flag('api-port', '58474')),
  adminUrl: process.argv.includes('--database-url') ? flag('database-url', '') : undefined, keep: KEEP, poolerPort: POOLER ? Number(flag('pooler-port', '55434')) : undefined });
const report: Record<string, unknown> = {
  schema: 'gbrain.bench.managed-sync-catchup/v1', label: LABEL, commit: gitDescribe(), started_at: new Date().toISOString(),
  params: { files: FILES, deletes: DELETES, history: HISTORY, receipt_history: RECEIPT_HISTORY, pad_words: PAD_WORDS, seed: SEED, rtt_ms: RTTS, rows: ROWS, max_minutes: MAX_MS / 60_000,
    fg_interval_s: FG_INTERVAL_S, pool_size: POOL_SIZE ? Number(POOL_SIZE) : null, pooler: POOLER || null },
  settings: { ...SETTINGS, default_settings: DEFAULT_SETTINGS }, pooler: harness.pooler,
  host: { cpus: navigator.hardwareConcurrency, platform: process.platform, bun: Bun.version },
  rerun: `bun scripts/bench/managed-sync-catchup.ts ${process.argv.slice(2).join(' ')}`,
  rows: [] as Array<Record<string, unknown>>,
};
const save = () => { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n'); };
try {
  await buildTemplate();
  for (const rtt of RTTS) for (const name of ROWS) {
    try { (report.rows as unknown[]).push(await runRow(name, rtt)); }
    catch (error) { log(`${name}@${rtt} failed: ${error instanceof Error ? error.stack : String(error)}`); (report.rows as unknown[]).push({ row: name, rtt_target_ms: rtt, error: String(error instanceof Error ? error.message : error).slice(0, 3000) }); }
    save();
  }
} finally {
  report.finished_at = new Date().toISOString();
  save();
  log(`report: ${OUT}`);
  if (!KEEP) {
    for (const datname of created) await admin(sql => sql.unsafe(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`)).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  }
  harness.stop();
}
process.exit(0);
