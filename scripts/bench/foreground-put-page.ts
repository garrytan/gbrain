#!/usr/bin/env bun
/**
 * Idle foreground put_page latency at a set round trip. Opt-in, never run in CI.
 *
 *   bun scripts/bench/foreground-put-page.ts [--rtt 57] [--writes 30] [--warmup 2] [--label <name>] [--out <file.json>]
 *     [--database-url <admin url>] [--pg-port 55432] [--proxy-port 55433] [--api-port 58474] [--keep]
 *
 * Reuses the managed-sync-catchup harness (Docker pgvector Postgres behind a
 * toxiproxy with `--rtt` ms of round trip). Builds a managed source with a few
 * pages, then one long-lived writer process submits put_page through
 * `submitPageMutation` one at a time (closed loop, 1 s floor), each writing a
 * markdown file, with no sync running. Every round trip of the writer is traced
 * (GBRAIN_SQL_TRACE), and each write is split into spans: pre-admission,
 * admission, claim, preparation, recovery record, publication transaction and
 * completion, with statements, sequential waves and describe round trips per
 * span. Environment switches (GBRAIN_SINGLE_WRITE_GROUP, GBRAIN_PREADMIT_CACHE)
 * pass through to the writer.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import postgres from '#postgres';
import { flatSql, measureRtt, pct, readTrace, round1, startHarness, type Harness, type TraceRecord } from './managed-sync-catchup-lib.ts';
import { cost, transactions, type Txn } from './managed-sync-catchup-phases.ts';

const REPO = resolve(import.meta.dir, '../..');
const CLI = join(REPO, 'src/cli.ts');
const SOURCE = 'bench';
function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
function gitDescribe(): string {
  try { return execFileSync('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim() + '@' + execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}
const log = (msg: string) => console.error(`[fg-put ${new Date().toISOString().slice(11, 19)}] ${msg}`);

interface WriteResult { start: number; end: number; ms: number; ok: boolean; state: string; mode?: string }

if (flag('worker', '')) await runWorker();

const RTT = Number(flag('rtt', '57'));
const WRITES = Number(flag('writes', '30'));
const WARMUP = Number(flag('warmup', '2'));
const LABEL = flag('label', gitDescribe());
const OUT = resolve(flag('out', join(REPO, '.context', 'bench', `foreground-put-page-${LABEL.replace(/[^\w.-]/g, '_')}-${Date.now()}.json`)));
const KEEP = process.argv.includes('--keep');
const work = mkdtempSync(join(tmpdir(), 'gbrain-fgput-'));
const created: string[] = [];
let harness: Harness;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function childEnv(home: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (/_API_KEY$|_API_TOKEN$|^DATABASE_URL$|^GBRAIN_DATABASE_URL$|^OPENAI_BASE_URL$/.test(key)) delete env[key];
  return { ...env, GBRAIN_HOME: home, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SKILLS_DIR: join(home, 'skills'), NO_COLOR: '1', ...extra };
}
async function cli(home: string, args: string[]): Promise<Record<string, unknown> | null> {
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: home, env: childEnv(home), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`gbrain ${args.join(' ')} exited ${code}\nstdout: ${stdout.slice(-1500)}\nstderr: ${stderr.slice(-1500)}`);
  try { return JSON.parse(stdout); } catch { return null; }
}
function writeConfig(home: string, url: string): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(join(home, 'skills'), { recursive: true });
  writeFileSync(join(home, 'skills', 'RESOLVER.md'), '# Bench fixture skills\n');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: url, self_upgrade: { mode: 'off' }, embedding_disabled: true }, null, 2) + '\n');
}
async function admin<T>(fn: (sql: ReturnType<typeof postgres>) => Promise<T>, db = 'postgres'): Promise<T> {
  const sql = postgres(harness.directUrl(db), { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}

async function setup(): Promise<{ home: string; db: string; trace: string }> {
  const db = `gbrain_fgput_${randomBytes(4).toString('hex')}`;
  await admin(sql => sql.unsafe(`CREATE DATABASE ${db}`));
  created.push(db);
  const home = mkdtempSync(join(work, 'home-'));
  writeConfig(home, harness.directUrl(db));
  process.env.GBRAIN_HOME = home;
  const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
  const engine = new PostgresEngine();
  await engine.connect({ database_url: harness.directUrl(db), poolSize: 2 });
  await engine.initSchema();
  await engine.disconnect();
  const root = join(home, `repo-${SOURCE}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, 'README.md'), '# Bench source\n');
  for (let i = 0; i < 5; i++) writeFileSync(join(root, 'notes', `seed-${i}.md`), `---\ntitle: Seed ${i}\n---\nSeed page ${i}.\n`);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Bench Example', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'seed');
  await cli(home, ['sources', 'add', SOURCE, '--path', root, '--no-federated']);
  await cli(home, ['sync', '--source', SOURCE, '--no-pull', '--no-embed', '--json']);
  let state = (await cli(home, ['sources', 'writer', 'status', '--json']))!.admin_state as string;
  await cli(home, ['sources', 'writer', 'claim', SOURCE, '--path', root, '--admin-intent', 'writer_claim', '--expected-state', state, '--json']);
  state = (await cli(home, ['sources', 'writer', 'status', '--json']))!.admin_state as string;
  const activated = await cli(home, ['sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', state, '--json']);
  if (activated?.enabled !== true) throw new Error(`activation did not enable managed persistence: ${JSON.stringify(activated)}`);
  writeConfig(home, harness.proxyUrl(db));
  return { home, db, trace: join(home, 'sql-trace.jsonl') };
}

async function runWorker(): Promise<never> {
  const { loadConfig, toEngineConfig } = await import('../../src/core/config.ts');
  const { createEngine } = await import('../../src/core/engine-factory.ts');
  const config = loadConfig()!;
  const engine = await createEngine(toEngineConfig(config));
  await engine.connect(toEngineConfig(config));
  const { disposePersistenceConsumer } = await import('../../src/core/persistence/service.ts');
  const { submitPageMutation } = await import('../../src/core/persistence/page-mutations.ts');
  const total = Number(process.env.BENCH_WRITES);
  const results: WriteResult[] = [];
  const logger = { info() {}, warn() {}, error() {} };
  for (let i = 0; i < total; i++) {
    const start = performance.timeOrigin + performance.now();
    let state = 'error', ok = false;
    try {
      const out = await submitPageMutation({ engine, config, remote: false, dryRun: false, sourceId: process.env.BENCH_SOURCE, logger } as unknown as Parameters<typeof submitPageMutation>[0],
        { operation: 'put_page', params: { slug: `notes/fg-${process.pid}-${i}`, content: `---\ntitle: Foreground ${i}\n---\nForeground write ${i}, idle.\n` }, waitMs: 30_000 });
      state = String((out as { state?: string; status?: string }).state ?? (out as { status?: string }).status ?? '');
      ok = state === 'committed';
    } catch (error) { state = String((error as { code?: string; message?: string }).code ?? (error as Error).message).slice(0, 200); }
    const end = performance.timeOrigin + performance.now();
    results.push({ start, end, ms: round1(end - start), ok, state });
    await Bun.sleep(Math.max(0, 1000 - (end - start)));
  }
  writeFileSync(process.env.BENCH_RESULTS!, JSON.stringify(results));
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  process.exit(0);
}

const RECOVERY = /^(?:WITH recorded AS \(UPDATE persistence_requests (?:r )?SET recovery=|UPDATE persistence_requests SET recovery=)/;
const ADMISSION = /INSERT INTO persistence_requests\b/;
const CLAIM = /^UPDATE persistence_requests (?:r )?SET state='running'/;
const COMPLETION = /^WITH effects AS \(SELECT COALESCE|UPDATE persistence_requests r SET state='committed'/;
const SPANS = ['pre_admission', 'admission', 'claim', 'preparation', 'recovery_record', 'publication_txn', 'completion'] as const;
type Span = typeof SPANS[number];

/** Splits each write into spans from the writer's own transactions. */
function spans(records: TraceRecord[], writes: WriteResult[]): Array<Record<Span, { ms: number; statements: number; waves: number; describes: number }> & { total_ms: number; publication_kind: string }> {
  const { txns } = transactions(records);
  const has = (re: RegExp) => (t: Txn) => t.records.some(r => re.test(flatSql(r.sql)));
  return writes.flatMap(w => {
    const inside = txns.filter(t => t.start >= w.start && t.start < w.end);
    const admission = inside.find(has(ADMISSION));
    const claim = admission && inside.find(t => has(CLAIM)(t) && t.start >= admission.end);
    const recovery = claim && inside.find(t => has(RECOVERY)(t) && t.start >= claim.end);
    const publication = claim && inside.find(t => has(COMPLETION)(t) && t.committed && t.start >= (recovery?.end ?? claim.end));
    if (!admission || !claim || !publication) return [];
    const bounds: Record<Span, [number, number]> = {
      pre_admission: [w.start, admission.start], admission: [admission.start, admission.end], claim: [admission.end, claim.end],
      preparation: [claim.end, recovery?.start ?? publication.start], recovery_record: recovery ? [recovery.start, publication.start] : [publication.start, publication.start],
      publication_txn: [publication.start, publication.end], completion: [publication.end, w.end],
    };
    const out = { total_ms: round1(w.end - w.start), publication_kind: publication.records.some(r => /SET state='committed'/.test(r.sql)) ? 'group' : 'single' } as ReturnType<typeof spans>[number];
    for (const span of SPANS) {
      const [from, to] = bounds[span];
      out[span] = { ms: round1(to - from), ...cost(records.filter(r => r.t >= from && r.t < to)) };
    }
    return [out];
  });
}

function summarize(records: TraceRecord[], measured: WriteResult[]): Record<string, unknown> {
  const split = spans(records, measured);
  const ms = measured.map(w => w.ms);
  return {
    writes: { count: measured.length, failures: measured.filter(w => !w.ok).length, states: [...new Set(measured.map(w => w.state))],
      p50_ms: pct(ms, 50), p95_ms: pct(ms, 95), max_ms: pct(ms, 100), all_ms: ms, raw: measured },
    spans_found: split.length,
    publication_kinds: Object.fromEntries([...new Set(split.map(s => s.publication_kind))].map(k => [k, split.filter(s => s.publication_kind === k).length])),
    spans: Object.fromEntries(SPANS.map(span => [span, {
      ms_p50: pct(split.map(s => s[span].ms), 50), ms_p95: pct(split.map(s => s[span].ms), 95),
      statements_p50: pct(split.map(s => s[span].statements), 50), waves_p50: pct(split.map(s => s[span].waves), 50), describes_p50: pct(split.map(s => s[span].describes), 50),
    }])),
  };
}
function printSummary(summary: Record<string, unknown>): void {
  const writes = summary.writes as { p50_ms: number; p95_ms: number; count: number; failures: number };
  log(`p50 ${writes.p50_ms} ms, p95 ${writes.p95_ms} ms over ${writes.count} writes (${writes.failures} failed); publication ${JSON.stringify(summary.publication_kinds)}`);
  for (const span of SPANS) { const s = (summary.spans as Record<string, Record<string, unknown>>)[span]!; log(`  ${span.padEnd(16)} p50 ${s.ms_p50} ms (p95 ${s.ms_p95})  stmts ${s.statements_p50}  waves ${s.waves_p50}  describes ${s.describes_p50}`); }
}

const analyze = flag('analyze', '');
if (analyze) {
  const prior = JSON.parse(readFileSync(analyze, 'utf8')) as { trace: string; writes: { raw: WriteResult[] } };
  const summary = summarize(readTrace(prior.trace, r => r.label.startsWith('foreground')), prior.writes.raw);
  printSummary(summary);
  console.log(JSON.stringify(summary.spans, null, 2));
  process.exit(0);
}

harness = await startHarness({ pgPort: Number(flag('pg-port', '55432')), proxyPort: Number(flag('proxy-port', '55433')), apiPort: Number(flag('api-port', '58474')),
  adminUrl: process.argv.includes('--database-url') ? flag('database-url', '') : undefined, keep: KEEP });
const report: Record<string, unknown> = { schema: 'gbrain.bench.foreground-put-page/v1', label: LABEL, commit: gitDescribe(), started_at: new Date().toISOString(),
  params: { rtt_ms: RTT, writes: WRITES, warmup: WARMUP, switches: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^GBRAIN_(SINGLE_WRITE_GROUP|PREADMIT_CACHE|PREPARE)$/.test(k))) },
  rerun: `bun scripts/bench/foreground-put-page.ts ${process.argv.slice(2).join(' ')}` };
try {
  log('setting up the managed source');
  const row = await setup();
  await harness.setRtt(RTT);
  report.measured_rtt_ms = round1(await measureRtt(harness.proxyUrl(row.db)));
  log(`measured RTT ${report.measured_rtt_ms} ms; writing ${WRITES + WARMUP} pages`);
  const results = join(row.home, 'results.json');
  const child = Bun.spawn([process.execPath, import.meta.path, '--worker', '1'], { cwd: row.home, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: childEnv(row.home, { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'foreground', BENCH_SOURCE: SOURCE, BENCH_RESULTS: results, BENCH_WRITES: String(WRITES + WARMUP) }) });
  const [stderr] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (!existsSync(results)) throw new Error(`writer wrote no results: ${stderr.slice(-2000)}`);
  const all = JSON.parse(readFileSync(results, 'utf8')) as WriteResult[];
  const measured = all.slice(WARMUP);
  const records = readTrace(row.trace, r => r.label.startsWith('foreground'));
  for (const [key, value] of Object.entries(summarize(records, measured))) report[key] = value;
  mkdirSync(dirname(OUT), { recursive: true });
  copyFileSync(row.trace, OUT.replace(/\.json$/, '') + '.trace.jsonl');
  report.trace = OUT.replace(/\.json$/, '') + '.trace.jsonl';
  report.writer_stderr_tail = stderr.slice(-1000);
  printSummary(report);
} finally {
  report.finished_at = new Date().toISOString();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  log(`report: ${OUT}`);
  if (!KEEP) {
    for (const datname of created) await admin(sql => sql.unsafe(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`)).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  }
  harness.stop();
}
process.exit(0);
