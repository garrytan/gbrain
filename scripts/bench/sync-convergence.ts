#!/usr/bin/env bun
/**
 * #6712 PR 4a convergence bench: measures the read-only convergence shadow
 * (src/core/persistence/sync-pass.ts) on a generated large repository. Opt-in,
 * never run in CI. Every number it prints is measured by this script on the
 * host it ran on.
 *
 *   bun scripts/bench/sync-convergence.ts --engine pglite|postgres|pgbouncer
 *     [--preset 61k|600k | --files N] [--rtt 57] [--idle-rounds 20] [--full-rounds 7] [--warmup 1]
 *     [--drift K] [--batch 5000] [--sample-ms 50] [--cache-dir <dir>] [--work-dir <dir>]
 *     [--pg-port 55442] [--pooler-port 55444] [--database-url <admin url>] [--raw-idle] [--episode] [--seed-only] [--keep] [--out <file.json>]
 *
 * Phases:
 *   1. fixture  N Markdown files under two levels of 100-way fan-out, one
 *               git fast-import commit, worktree materialized with
 *               read-tree -u --reset; cached under --cache-dir by N and the
 *               content version (default ~/.capy/work/6712/bench-fixtures).
 *   2. seed     a fresh brain (PGLite datastore in --work-dir, or a new
 *               database on the Docker pgvector Postgres) gets the managed
 *               source by direct SQL: source row at the fixture's base commit,
 *               worktree claim, N pages and N import provenance records
 *               (sync-convergence-lib.ts seedSource).
 *   3. drift    with --drift K, K evenly spaced files are edited in one commit
 *               on top of the base, so a full round has K candidates (K=1 is
 *               the one-file-commit round).
 *   4. measure  a child process (so its peak RSS is a fresh process opening
 *               the brain, not this one's seeding) runs --warmup rounds, then
 *               --idle-rounds idleTickProbe calls and --full-rounds
 *               shadowConvergence calls, timing each, sampling
 *               RSS every --sample-ms and reading VmHWM at the end. Postgres
 *               and PgBouncer (transaction mode, unprepared) are reached through
 *               test/helpers/latency-proxy.ts at --rtt ms round trip, running
 *               in this parent process; PGLite runs in the child, no proxy.
 *               PR 4a writes no pass row, so idle ticks pass assumeConverged
 *               (target = the fixture HEAD, request watermark = the current
 *               max sequence) to time the reads PR 4b's idle tick makes;
 *               --raw-idle times the tick without it (never idle in PR 4a).
 *               PR 4a has no pass row, so every shadowConvergence call is a
 *               full round's reads; --episode passes full: true (the forced
 *               reparse episode of sync --full, every live page an obligation).
 *
 * Output: one JSON document on stdout (and --out), a human summary on stderr.
 * Percentiles are nearest-rank (with 7 rounds p95 is the max).
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { LatencyProxy } from '../../test/helpers/latency-proxy.ts';
import { VERSION } from '../../src/version.ts';
import {
  PRESETS, PGBOUNCER_CONTAINER, applyDrift, breakdown, ensureFixture, ensurePostgres, git, gitVersion, hostInfo, measureRtt, mib, readVmHwm, removeContainer,
  resetFixture, seedSource, startPgbouncer, startRssSampler, summarize,
} from './sync-convergence-lib.ts';

const REPO = resolve(import.meta.dir, '../..');
const SYNC_PASS = join(REPO, 'src/core/persistence/sync-pass.ts');
const SOURCE_ID = 'bench-convergence';
type EngineKind = 'pglite' | 'postgres' | 'pgbouncer';

/** The measured functions (loaded dynamically, so the fixture and seed phases run without them). */
type SyncPassModule = Pick<typeof import('../../src/core/persistence/sync-pass.ts'), 'shadowConvergence' | 'idleTickProbe'>;

/** `target`: the HEAD the idle tick assumes converged (PR 4a writes no pass row; see idleTickProbe's assumeConverged), or null to time the raw tick. */
interface ChildConfig { engine: EngineKind; database_url?: string; database_path?: string; source_id: string; target: string | null; episode: boolean; idle_rounds: number; full_rounds: number; warmup: number; sample_ms: number }

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const log = (line: string) => process.stderr.write(`[sync-convergence] ${line}\n`);
function wholeNumber(name: string, fallback: string, min = 0): number {
  const n = Number(flag(name, fallback));
  if (!Number.isInteger(n) || n < min) { log(`--${name} takes a whole number of at least ${min}; got ${flag(name, fallback)}`); process.exit(2); }
  return n;
}

const child = flag('child', '');
if (child) process.exit(await runChild(JSON.parse(readFileSync(child, 'utf8')) as ChildConfig));
process.exit(await runParent());

// ─── measuring child ─────────────────────────────────────────────────

async function runChild(config: ChildConfig): Promise<number> {
  const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const sampler = startRssSampler(config.sample_ms);
  const t0 = performance.now();
  const engine = config.engine === 'pglite'
    ? new (await import('../../src/core/pglite-engine.ts')).PGLiteEngine()
    : new (await import('../../src/core/postgres-engine.ts')).PostgresEngine();
  await engine.connect(config.engine === 'pglite' ? { database_path: config.database_path } : { database_url: config.database_url });
  const connectMs = performance.now() - t0;
  const rssAfterConnect = process.memoryUsage().rss;
  try {
    const [seeded] = await engine.executeRaw<{ pages: number }>('SELECT count(*)::int AS pages FROM pages WHERE source_id=$1', [config.source_id]);
    const unavailable = (reason: string) => { sampler.stop(); out({ available: false, reason, connect_ms: Math.round(connectMs), seeded_pages: seeded?.pages ?? 0 }); return 0; };
    if (!existsSync(SYNC_PASS)) return unavailable('src/core/persistence/sync-pass.ts is not in this checkout');
    const specifier = SYNC_PASS;
    const pass = await import(specifier) as Partial<SyncPassModule>;
    if (typeof pass.shadowConvergence !== 'function' || typeof pass.idleTickProbe !== 'function') return unavailable('sync-pass.ts does not export shadowConvergence and idleTickProbe');
    const input = { sourceId: config.source_id };
    const [hwm] = await engine.executeRaw<{ hwm: number }>('SELECT COALESCE(max(sequence),0)::float8 AS hwm FROM persistence_requests');
    const tick = { ...input, ...(config.target ? { assumeConverged: { target: config.target, requestHwm: Number(hwm?.hwm ?? 0) } } : {}) };
    const round = async () => {
      const receipt = await pass.shadowConvergence!(engine, { ...input, full: config.episode });
      if (!receipt) throw new Error('shadowConvergence returned no receipt (a company-brain source?)');
      return receipt;
    };
    for (let i = 0; i < config.warmup; i++) { await pass.idleTickProbe(engine, tick); await round(); }
    const idle: Array<{ wall: number; idle: boolean; reasons: string[]; rows: number; timings_ms: Record<string, number> }> = [];
    sampler.mark();
    for (let i = 0; i < config.idle_rounds; i++) {
      const t = performance.now();
      const r = await pass.idleTickProbe(engine, tick);
      idle.push({ wall: performance.now() - t, idle: r.idle, reasons: r.reasons.map(String), rows: r.rows, timings_ms: r.timings_ms });
    }
    const idlePeak = sampler.phasePeak();
    const full: Array<{ wall: number; timings_ms: Record<string, number>; counts: unknown }> = [];
    sampler.mark();
    for (let i = 0; i < config.full_rounds; i++) {
      const t = performance.now();
      const r = await round();
      full.push({ wall: performance.now() - t, timings_ms: r.timings_ms, counts: r.counts });
    }
    const fullPeak = sampler.phasePeak();
    const overall = sampler.stop();
    out({ available: true, connect_ms: Math.round(connectMs), seeded_pages: seeded?.pages ?? 0, idle, full,
      rss: { after_connect: rssAfterConnect, idle_peak_sampled: idlePeak, full_peak_sampled: fullPeak, peak_sampled: overall.peak, samples: overall.samples, vm_hwm: readVmHwm() } });
    return 0;
  } catch (error) {
    sampler.stop();
    out({ available: true, connect_ms: Math.round(connectMs), error: { message: (error as Error).message, code: (error as { code?: string }).code ?? null, stack: (error as Error).stack ?? null } });
    return 1;
  } finally {
    await engine.disconnect();
  }
}

// ─── parent: fixture, seed, drift, measure ───────────────────────────

async function runParent(): Promise<number> {
  const engineKind = flag('engine', '') as EngineKind;
  if (!['pglite', 'postgres', 'pgbouncer'].includes(engineKind)) { log('--engine takes pglite, postgres or pgbouncer'); return 2; }
  const preset = flag('preset', '');
  if (preset && !PRESETS[preset]) { log(`--preset takes ${Object.keys(PRESETS).join(' or ')}; got ${preset}`); return 2; }
  const files = preset ? PRESETS[preset]! : wholeNumber('files', '2000', 1);
  const rtt = Number(flag('rtt', '57'));
  if (!(rtt >= 0)) { log(`--rtt takes milliseconds of at least 0; got ${flag('rtt', '57')}`); return 2; }
  const idleRounds = wholeNumber('idle-rounds', '20', 1), fullRounds = wholeNumber('full-rounds', '7', 1), warmup = wholeNumber('warmup', '1');
  const drift = wholeNumber('drift', '0'), batch = wholeNumber('batch', '5000', 1), sampleMs = wholeNumber('sample-ms', '50', 1);
  const pgPort = wholeNumber('pg-port', '55442', 1), poolerPort = wholeNumber('pooler-port', '55444', 1);
  const keep = has('keep'), seedOnly = has('seed-only'), rawIdle = has('raw-idle'), episode = has('episode');
  const cacheDir = resolve(flag('cache-dir', join(homedir(), '.capy/work/6712/bench-fixtures')));
  const runId = `${engineKind}-${files}-${Date.now()}`;
  const workDir = resolve(flag('work-dir', join(homedir(), '.capy/work/6712/bench-runs', runId)));
  mkdirSync(workDir, { recursive: true });
  process.env.GBRAIN_HOME = join(workDir, 'home');
  const wallStart = performance.now();
  const phases: Record<string, unknown> = {};
  const cleanups: Array<() => Promise<void> | void> = [];
  try {
    const fixture = await ensureFixture(cacheDir, files, log);
    resetFixture(fixture);
    phases.fixture = { cached: fixture.cached, generate_ms: Math.round(fixture.generate_ms), generation_timings_ms: fixture.timings_ms, base: fixture.base };
    log(`fixture: ${fixture.cached ? 'cached' : 'generated'} ${fixture.repo} (${files} files)`);

    let childUrl: string | undefined, databasePath: string | undefined, measuredRtt: number | null = null, pooler: Record<string, string> | null = null;
    let upstreamPort = pgPort;
    const seedStart = performance.now();
    if (engineKind === 'pglite') {
      const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
      databasePath = join(workDir, 'brain.pglite');
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: databasePath });
      try {
        const t = performance.now(); await engine.initSchema(); phases.init_schema_ms = Math.round(performance.now() - t);
        phases.seed = await seedSource(engine, { sourceId: SOURCE_ID, fixture, batch, log });
      } finally { await engine.disconnect(); }
      if (!keep) cleanups.push(() => rmSync(databasePath!, { recursive: true, force: true }));
    } else {
      const explicitAdmin = flag('database-url', '');
      let adminUrl = explicitAdmin;
      if (!adminUrl) adminUrl = (await ensurePostgres(pgPort)).adminUrl;
      else upstreamPort = Number(new URL(adminUrl).port || 5432);
      const database = `gbrain_bench_conv_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const admin = postgres(adminUrl, { max: 1, onnotice: () => {}, prepare: false });
      await admin.unsafe(`CREATE DATABASE ${database}`);
      cleanups.push(async () => { if (!keep) await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); });
      const direct = new URL(adminUrl); direct.pathname = `/${database}`;
      const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
      const engine = new PostgresEngine();
      await engine.connect({ database_url: direct.toString(), poolSize: 4 });
      try {
        const t = performance.now(); await engine.initSchema(); phases.init_schema_ms = Math.round(performance.now() - t);
        phases.seed = await seedSource(engine, { sourceId: SOURCE_ID, fixture, batch, log });
      } finally { await engine.disconnect(); }
      let target = upstreamPort;
      if (engineKind === 'pgbouncer') {
        pooler = await startPgbouncer(adminUrl, upstreamPort, poolerPort);
        if (!keep) cleanups.push(() => removeContainer(PGBOUNCER_CONTAINER));
        target = poolerPort;
      }
      const proxy = new LatencyProxy({ host: new URL(adminUrl).hostname, port: target }, rtt / 2);
      await proxy.listen();
      cleanups.push(() => proxy.close());
      const viaProxy = new URL(adminUrl); viaProxy.hostname = '127.0.0.1'; viaProxy.port = String(proxy.port); viaProxy.pathname = `/${database}`;
      if (engineKind === 'pgbouncer') viaProxy.searchParams.set('prepare', 'false');
      childUrl = viaProxy.toString();
      measuredRtt = await measureRtt(childUrl);
    }
    phases.seed_ms = Math.round(performance.now() - seedStart);
    log(`seed: ${JSON.stringify(phases.seed)} (phase ${phases.seed_ms} ms)`);

    let head = fixture.base, driftPaths: string[] = [];
    if (drift > 0) {
      const t = performance.now();
      ({ head, paths: driftPaths } = await applyDrift(fixture, drift));
      phases.drift = { files: driftPaths.length, head, ms: Math.round(performance.now() - t) };
    }

    let measured: Record<string, unknown> | null = null;
    if (!seedOnly) {
      const configPath = join(workDir, 'child.json');
      writeFileSync(configPath, JSON.stringify({ engine: engineKind, database_url: childUrl, database_path: databasePath, source_id: SOURCE_ID, target: rawIdle ? null : head, episode,
        idle_rounds: idleRounds, full_rounds: fullRounds, warmup, sample_ms: sampleMs } satisfies ChildConfig));
      log(`measure: ${warmup} warm-up, ${idleRounds} idle ticks, ${fullRounds} full rounds (${engineKind}${engineKind === 'pglite' ? '' : `, ${rtt} ms RTT`})`);
      const t = performance.now();
      measured = await runMeasureChild(configPath);
      phases.measure_ms = Math.round(performance.now() - t);
    }

    const doc = report({ engineKind, files, rtt, measuredRtt, pooler, drift, driftPaths, head, fixture, phases, measured, idleRounds, fullRounds, warmup, sampleMs,
      wallMs: performance.now() - wallStart, workDir, rawIdle, episode });
    const json = JSON.stringify(doc, null, 2);
    process.stdout.write(json + '\n');
    const out = flag('out', '');
    if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(resolve(out), json + '\n'); }
    printSummary(doc);
    return measured && (measured as { error?: unknown }).error ? 1 : 0;
  } finally {
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (error) { log(`cleanup: ${(error as Error).message}`); } }
    if (!keep) rmSync(join(workDir, 'home'), { recursive: true, force: true });
  }
}

async function runMeasureChild(configPath: string): Promise<Record<string, unknown>> {
  const proc = spawn(process.execPath, [import.meta.path, '--child', configPath], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
  let stdout = '';
  proc.stdout.on('data', d => { stdout += d; });
  const code = await new Promise<number>(done => proc.on('close', c => done(c ?? 1)));
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`measure child exited ${code} with no result`);
  return JSON.parse(line) as Record<string, unknown>;
}

// ─── report ──────────────────────────────────────────────────────────

interface ReportInput {
  engineKind: EngineKind; files: number; rtt: number; measuredRtt: number | null; pooler: Record<string, string> | null; drift: number; driftPaths: string[]; head: string;
  fixture: { repo: string; base: string }; phases: Record<string, unknown>; measured: Record<string, unknown> | null;
  idleRounds: number; fullRounds: number; warmup: number; sampleMs: number; wallMs: number; workDir: string; rawIdle: boolean; episode: boolean;
}

function report(r: ReportInput): Record<string, unknown> {
  type Idle = { wall: number; idle: boolean; reasons: string[]; rows: number; timings_ms: Record<string, number> };
  type Full = { wall: number; timings_ms: Record<string, number>; counts: unknown };
  const m = r.measured as null | { available: boolean; reason?: string; error?: unknown; connect_ms?: number; seeded_pages?: number; idle?: Idle[]; full?: Full[]; rss?: Record<string, number | null> };
  const idle = m?.idle ?? [], full = m?.full ?? [];
  const reasons: Record<string, number> = {};
  for (const tick of idle) for (const reason of tick.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
  const rss = m?.rss;
  return {
    measured_by: 'scripts/bench/sync-convergence.ts',
    measured_at: new Date().toISOString(),
    engine: r.engineKind,
    files: r.files,
    rtt_ms: r.engineKind === 'pglite' ? null : r.rtt,
    rtt_measured_p50_ms: r.measuredRtt,
    pooler: r.pooler,
    drift: { files: r.driftPaths.length, sample_paths: r.driftPaths.slice(0, 5) },
    target: r.head,
    base: r.fixture.base,
    host: hostInfo(),
    git_version: gitVersion(),
    gbrain_version: VERSION,
    gbrain_commit: git(REPO, ['rev-parse', 'HEAD']),
    settings: { idle_rounds: r.idleRounds, full_rounds: r.fullRounds, warmup: r.warmup, rss_sample_ms: r.sampleMs, percentile: 'nearest-rank', full_round_episode: r.episode },
    measured: m ? (m.available ? (m.error ? { error: m.error } : true) : { unavailable: m.reason }) : 'skipped (--seed-only)',
    idle_tick_ms: summarize(idle.map(t => t.wall)),
    idle_tick_idle_fraction: idle.length ? idle.filter(t => t.idle).length / idle.length : null,
    idle_tick_reasons: reasons,
    idle_tick_assumed_converged: !r.rawIdle,
    idle_tick_db_rows_max: idle.length ? Math.max(...idle.map(t => t.rows)) : null,
    full_round_ms: summarize(full.map(t => t.wall)),
    full_round_counts: full.at(-1)?.counts ?? null,
    rss_mib: rss ? { after_connect: mib(rss.after_connect ?? null), idle_peak_sampled: mib(rss.idle_peak_sampled ?? null), full_peak_sampled: mib(rss.full_peak_sampled ?? null),
      peak_sampled: mib(rss.peak_sampled ?? null), vm_hwm: mib(rss.vm_hwm ?? null), samples: rss.samples ?? null,
      process: r.engineKind === 'pglite' ? 'measuring child; includes the in-process PGLite database' : 'measuring child; database server and proxy are other processes' } : null,
    breakdown_ms: { idle: breakdown(idle.map(t => t.timings_ms)), full: breakdown(full.map(t => t.timings_ms)) },
    connect_ms: m?.connect_ms ?? null,
    seeded_pages_seen_by_child: m?.seeded_pages ?? null,
    phases: r.phases,
    fixture_repo: r.fixture.repo,
    work_dir: r.workDir,
    wall_ms: Math.round(r.wallMs),
  };
}

function printSummary(doc: Record<string, unknown>): void {
  const s = (x: unknown) => { const v = x as { p50: number | null; p95: number | null; max: number | null; n: number }; return `p50 ${v.p50} / p95 ${v.p95} / max ${v.max} ms (n=${v.n})`; };
  const rss = doc.rss_mib as Record<string, unknown> | null;
  const lines = [
    `measured by ${doc.measured_by} on ${(doc.host as { cpu_count: number }).cpu_count} CPUs, ${doc.git_version}`,
    `engine ${doc.engine}, ${doc.files} files, RTT ${doc.rtt_ms ?? 'n/a'} ms (measured p50 ${doc.rtt_measured_p50_ms ?? 'n/a'}), drift ${(doc.drift as { files: number }).files}`,
    `measured: ${typeof doc.measured === 'object' ? JSON.stringify(doc.measured) : doc.measured}`,
    `idle tick:  ${s(doc.idle_tick_ms)}, idle fraction ${doc.idle_tick_idle_fraction ?? 'n/a'}, DB rows max ${doc.idle_tick_db_rows_max ?? 'n/a'}`,
    `full round: ${s(doc.full_round_ms)}`,
    `peak RSS: sampled ${rss?.peak_sampled ?? 'n/a'} MiB, VmHWM ${rss?.vm_hwm ?? 'n/a'} MiB`,
    `phases: ${JSON.stringify(doc.phases)}`,
  ];
  for (const [kind, table] of Object.entries(doc.breakdown_ms as Record<string, Record<string, unknown>>))
    for (const [key, value] of Object.entries(table)) lines.push(`  ${kind}.${key}: ${s(value)}`);
  for (const line of lines) log(line);
}
