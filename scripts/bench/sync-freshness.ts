#!/usr/bin/env bun
/**
 * GBRA-133 lane A: commit-to-searchable latency bench. Opt-in, never run in CI.
 *
 *   bun scripts/bench/sync-freshness.ts --engine pglite|postgres --mode classic|managed --pages N
 *     --commit single|batch|backlog --trigger serve|autopilot|jobs|watch|manual --reps N [--json]
 *     [--rtt MS] [--interval S] [--timeout S] [--scenario during-sync] [--gbrain-root <checkout>]
 *     [--work-dir <dir>] [--label <name>] [--rebuild] [--probe-ms 100]
 *   bun scripts/bench/sync-freshness.ts --report <results dir>   # markdown table of every cell JSON
 *
 * GBRA-133 PR 2b.6 cells:
 *   --embed stub [--embed-latency-ms 200]   loopback OpenAI-compatible stub (keys stripped, never a paid call; the brain build
 *                                           embeds at --build-embed-latency-ms, default 5); records
 *                                           commit -> every chunk embedded, and on Postgres a vector-search hit aimed at the chunk
 *   --embed keyless-stub                    keyless brain with OPENAI_BASE_URL pointed at the stub: any request is a failure
 *   --stub-fail-ms MS                       the stub answers 500 for MS after each commit (provider outage, then recovery)
 *   --scenario embed-drain                  a 1000-file commit per rep; times keyword-visible and every deferred embed drained
 *   --trigger serve-boot                    commit while no serve runs, then start foresights serve (stdio): boot -> visible
 *   --sources N [--source-pages 1000]       N sources in one brain (bench plus bench2..benchN of --source-pages pages each)
 *   --scenario fairness [--residents serve,jobs,autopilot]   one commit to every source at once; per-source latency and spread
 *   --scenario idle [--residents ...] [--idle-windows 10 --window-s 30 --warmup-s 60]   idle cost per window: transactions
 *                                           (pg_stat_database), backends (pg_stat_activity, sampled each second), CPU s/min per resident
 *   --detection watch|poll                  GBRAIN_NOTIFIER_DETECTION for residents (poll forces the 3 s rev-parse poll); the
 *                                           observed sync_notifier_sources.detection_mode is recorded with every cell
 *   --jitter-ms MS                          adds U(0, MS) to the gap between serve commits, so commits land at random poll offsets
 *   --mode managed --activation [--max-activation-passes N] [--brain-rev REV]
 *                                           activation cost (#6712): clones the classic brain, activates managed persistence,
 *                                           times the first managed sync to convergence (passes, wall time, and on Postgres the
 *                                           pg_stat_statements calls) and writes results/activation-<cell>.json; every pass's
 *                                           output goes to logs/<cell>-activation-passes/. Exits 1 when the cap stops it first.
 *                                           --brain-rev reuses a classic brain built at another revision as the input.
 *
 * Builds (once, then reuses) a synthetic git brain of N pages for the engine,
 * mode and foresights checkout: classic import first, then for managed the real
 * "foresights sources writer claim/activate" CLI (a managed brain of the same size
 * is cloned from the classic one). Per rep it commits a change with a fresh
 * token, fires or waits for the trigger, and polls until get_page returns the
 * new content and a keyword search returns every changed page.
 *
 * Probes: Postgres reads through an in-process engine on a direct (un-proxied)
 * connection every --probe-ms; PGLite with a serve reads through that serve's
 * own MCP stdio (get_page, search); PGLite without a serve cannot be read while
 * the syncing process holds the single-writer lock, so a manual sync is timed
 * to its completion line and verified after exit, and resident pollers are
 * derived (see the report). Every child line is timestamped on arrival, which
 * gives the phase breakdown (boot, discovery/freeze, publish, tail).
 * Postgres runs in Docker (gbrain-bench-pg) with toxiproxy for --rtt, the same
 * harness as scripts/bench/managed-sync-catchup.ts. Keyless: provider keys are
 * stripped from every child.
 */
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import postgres from '#postgres';
import { readPgStatStatements, startHarness, measureRtt, startEmbeddingStub, readTrace, groupStatements, classify, type Harness } from './managed-sync-catchup-lib.ts';
import {
  copyDir, engineProber, existsSync, git, machineInfo, makeChange, mcpProber, McpClient, mkdirSync, now, pollVisible, readFileSync, rmSync, round1,
  sleep, spawnChild, stats, treeCpuSeconds, waitLine, writeCorpus, writeFileSync, writeState, getTargets, slugOf, expectedHits,
  type Change, type Child, type CommitKind, type Prober, type Line, type Stats,
} from './sync-freshness-lib.ts';

const REPO = resolve(import.meta.dir, '../..');
const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback; };
const has = (name: string) => argv.includes('--' + name);

if (has('report')) { report(flag('report', '.').split(',').map(d => resolve(d)).join(',')); process.exit(0); }

const ENGINE = flag('engine', 'pglite') as 'pglite' | 'postgres';
const MODE = flag('mode', 'classic') as 'classic' | 'managed';
const PAGES = Number(flag('pages', '1000'));
const COMMIT = flag('commit', 'single') as CommitKind | 'noop';
const TRIGGER = flag('trigger', 'manual') as 'serve' | 'serve-boot' | 'autopilot' | 'jobs' | 'watch' | 'manual';
const REPS = Number(flag('reps', '10'));
const RTT = Number(flag('rtt', '0'));
const SCENARIO = flag('scenario', 'plain');
const PROBE_MS = Number(flag('probe-ms', '100'));
const GROOT = resolve(flag('gbrain-root', REPO));
const WORK = resolve(flag('work-dir', join(REPO, '.context/bench/sync-freshness')));
const CLI = join(GROOT, 'src/cli.ts');
/** The product revision (last commit touching src/), so bench-only commits keep reusing the same brains. */
const REV = flag('brain-rev', git(GROOT, 'log', '-1', '--format=%h', '--abbrev=8', '--', 'src', 'package.json'));
const LABEL = flag('label', git(GROOT, 'rev-parse', '--abbrev-ref', 'HEAD') + '@' + REV);
const INTERVAL = Number(flag('interval', TRIGGER === 'autopilot' ? '300' : '60'));
const TIMEOUT_S = Number(flag('timeout', String(TRIGGER === 'autopilot' ? INTERVAL * 2 + 600 : TRIGGER === 'watch' ? INTERVAL + 300 : COMMIT === 'backlog' ? 3600 : 300)));
const JSON_OUT = has('json');
const EMBED = flag('embed', 'off') as 'off' | 'stub' | 'keyless-stub';
const EMBED_LATENCY_MS = Number(flag('embed-latency-ms', '200'));
let stubUrl = '';
const TRACE = has('trace');
const DETECTION = flag('detection', 'watch') as 'watch' | 'poll';
const JITTER_MS = Number(flag('jitter-ms', '0'));
const SOURCES = Number(flag('sources', '1'));
const SOURCE_PAGES = Number(flag('source-pages', '1000'));
const EXTRA_IDS = Array.from({ length: Math.max(0, SOURCES - 1) }, (_, i) => 'bench' + (i + 2));
const RESIDENTS = flag('residents', 'serve').split(',').filter(Boolean) as Array<'serve' | 'jobs' | 'autopilot'>;
const STUB_FAIL_MS = Number(flag('stub-fail-ms', '0'));
const IDLE_WINDOWS = Number(flag('idle-windows', '10'));
const WINDOW_S = Number(flag('window-s', '30'));
const WARMUP_S = Number(flag('warmup-s', '60'));
const SETTLE_S = Number(flag('settle-s', '20'));
const MULTI = SCENARIO === 'idle' || SCENARIO === 'fairness';
const ACTIVATION = has('activation');
const MAX_ACTIVATION_PASSES = Number(flag('max-activation-passes', '0'));
if (ACTIVATION && (MODE !== 'managed' || SOURCES !== 1 || EMBED !== 'off')) { console.error('--activation measures one source in --mode managed without --embed'); process.exit(2); }
if (COMMIT === 'noop' && TRIGGER !== 'manual') { console.error('--commit noop measures a manual sync with nothing to do; use --trigger manual'); process.exit(2); }
if (!['pglite', 'postgres'].includes(ENGINE) || !['classic', 'managed'].includes(MODE) || !['single', 'batch', 'backlog', 'noop'].includes(COMMIT)
  || !['serve', 'serve-boot', 'autopilot', 'jobs', 'watch', 'manual'].includes(TRIGGER) || !(PAGES > 0) || !(REPS > 0) || !['watch', 'poll'].includes(DETECTION)
  || !['plain', 'during-sync', 'embed-drain', 'idle', 'fairness'].includes(SCENARIO) || !['off', 'stub', 'keyless-stub'].includes(EMBED) || !(SOURCES >= 1)
  || RESIDENTS.some(r => !['serve', 'jobs', 'autopilot'].includes(r))) {
  console.error('usage: see the header of scripts/bench/sync-freshness.ts'); process.exit(2);
}
if (RTT && ENGINE !== 'postgres') { console.error('--rtt applies to --engine postgres'); process.exit(2); }
if ((SCENARIO === 'embed-drain' || SCENARIO === 'fairness') && TRIGGER !== 'serve' && !MULTI) { console.error('--scenario ' + SCENARIO + ' runs under --trigger serve'); process.exit(2); }
if (SCENARIO === 'fairness' && SOURCES < 2) { console.error('--scenario fairness needs --sources 2 or more'); process.exit(2); }
if (MULTI && ENGINE === 'pglite' && RESIDENTS.some(r => r !== 'serve')) { console.error('PGLite has one writer process: jobs work drains and exits, and an autopilot cycle holds the lock; use --residents serve'); process.exit(2); }
const log = (m: string) => console.error('[freshness ' + new Date().toISOString().slice(11, 19) + '] ' + m);

const brainKey = (mode: string, sources = SOURCES) => ENGINE + '-' + mode + '-' + PAGES + (sources > 1 ? '-s' + sources + 'x' + SOURCE_PAGES : '') + (EMBED === 'stub' ? '-embed' : '') + '-' + REV;
const brainDir = (mode: string, sources = SOURCES) => join(WORK, 'brains', brainKey(mode, sources));
const dbName = (mode: string, sources = SOURCES) => ('gbf_' + brainKey(mode, sources)).replace(/\W/g, '_').toLowerCase();
/** Repo and corpus-state directory of a source inside a brain directory (bench keeps the original layout). */
const srcRoot = (dir: string, id: string) => id === 'bench' ? join(dir, 'repo') : join(dir, 'src-' + id);
const srcState = (dir: string, id: string) => id === 'bench' ? dir : join(dir, 'state-' + id);
const ALL_IDS = ['bench', ...EXTRA_IDS];
const DIR = brainDir(MODE);
const HOME = join(DIR, 'home');
const ROOT = join(DIR, 'repo');

let harness: Harness | null = null;
const directUrl = (mode = MODE) => harness!.directUrl(dbName(mode));

function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (/_API_KEY$|_API_TOKEN$|^DATABASE_URL$|^GBRAIN_DATABASE_URL$|^OPENAI_BASE_URL$|^GBRAIN_HOME$/.test(k)) delete env[k];
  return { ...env, GBRAIN_HOME: HOME, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SKILLS_DIR: join(HOME, 'skills'), NO_COLOR: '1',
    ...(EMBED === 'stub' ? { OPENAI_API_KEY: 'sk-bench-stub-not-a-key', OPENAI_BASE_URL: stubUrl } : EMBED === 'keyless-stub' ? { OPENAI_BASE_URL: stubUrl } : {}),
    ...(DETECTION === 'poll' ? { GBRAIN_NOTIFIER_DETECTION: 'poll' } : {}), ...extra };
}
/** Async on purpose: the embedding stub answers from this process's event loop. */
async function gb(args: string[], opts: { home?: string; allowFail?: boolean; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string; json: any }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], { cwd: opts.home ?? HOME, env: childEnv(opts.home ? { GBRAIN_HOME: opts.home, GBRAIN_SKILLS_DIR: join(opts.home, 'skills') } : {}) as Record<string, string>,
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: opts.timeoutMs ?? 4 * 3600_000 });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const r = { exitCode };
  let json: any = null;
  try { json = JSON.parse(stdout); } catch { const last = stdout.trim().split('\n').reverse().find(l => l.startsWith('{')); try { json = last ? JSON.parse(last) : null; } catch { json = null; } }
  if (r.exitCode !== 0 && !opts.allowFail) throw new Error('foresights ' + args.join(' ') + ' exited ' + r.exitCode + '\n' + stdout.slice(-1500) + '\n' + stderr.slice(-1500));
  return { code: r.exitCode ?? -1, stdout, stderr, json };
}
function writeConfig(home: string, mode: string, url?: string): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(join(home, 'skills'), { recursive: true });
  if (!existsSync(join(home, 'skills', 'RESOLVER.md'))) writeFileSync(join(home, 'skills', 'RESOLVER.md'), '# Bench fixture skills\n');
  const file = join(home, '.gbrain', 'config.json');
  const prior = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const base = ENGINE === 'postgres' ? { engine: 'postgres', database_url: url ?? harness!.directUrl(dbName(mode)) } : { engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') };
  const embedding = EMBED === 'stub' ? { embedding_disabled: false, embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536 } : { embedding_disabled: true };
  writeFileSync(file, JSON.stringify({ ...prior, ...base, ...embedding, self_upgrade: { mode: 'off' } }, null, 2) + '\n');
}
async function admin<T>(fn: (sql: ReturnType<typeof postgres>) => Promise<T>, db = 'postgres'): Promise<T> {
  const sql = postgres(harness!.directUrl(db), { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}
async function dbExists(db: string): Promise<boolean> { return admin(async sql => (await sql.unsafe('SELECT 1 FROM pg_database WHERE datname=$1', [db])).length > 0); }
/** A cached brain counts only while its database still exists: a recreated gbrain-bench-pg container (machine restart) loses every database. */
async function brainBuilt(mode: 'classic' | 'managed', sources = SOURCES): Promise<boolean> {
  if (!existsSync(join(brainDir(mode, sources), 'ready.json'))) return false;
  if (ENGINE !== 'postgres' || await dbExists(dbName(mode, sources))) return true;
  log('cached ' + brainKey(mode, sources) + ' has no database ' + dbName(mode, sources) + '; rebuilding');
  return false;
}

async function syncUntilDone(home: string, label: string, source = 'bench', maxPasses = 0, passDir?: string): Promise<{ ms: number; runs: number; capped?: boolean; statuses?: string[] }> {
  const t = now();
  const statuses: string[] = [];
  for (let i = 0; ; i++) {
    const r = await gb(['sync', '--source', source, '--no-pull', ...(EMBED === 'stub' ? [] : ['--no-embed']), '--json'], { home, allowFail: true });
    const status = r.json?.sync_status ?? r.json?.outcome;
    statuses.push(String(status));
    log(label + ' sync pass ' + (i + 1) + ': ' + status + ' (' + round1((now() - t) / 1000) + ' s)');
    if (passDir) { mkdirSync(passDir, { recursive: true }); writeFileSync(join(passDir, 'pass-' + (i + 1) + '.out'), r.stdout + '\n----STDERR----\n' + r.stderr); }
    if (['synced', 'first_sync', 'up_to_date'].includes(status)) return { ms: now() - t, runs: i + 1, ...(passDir ? { statuses } : {}) };
    if (maxPasses && i + 1 >= maxPasses) return { ms: now() - t, runs: i + 1, capped: true, statuses };
    if (i > 200 || (r.code !== 0 && status !== 'partial')) throw new Error(label + ' sync did not converge: ' + r.stdout.slice(-1500) + r.stderr.slice(-1500));
  }
}

/**
 * A full import leaves the mention-link pass to later (links_extraction_lag), and a managed sync then spends its tail on
 * that backlog. Cells measure steady state, so the build clears it the way the sync's own hint says.
 */
async function settleLinks(home: string, source = 'bench'): Promise<{ ms: number; runs: number; last: string }> {
  const t = now();
  let last = '';
  for (let i = 0; i < 20; i++) {
    const r = await gb(['extract', '--stale', '--catch-up', '--source-id', source, '--brain', 'host'], { home, allowFail: true });
    last = (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ').slice(0, 400);
    log('links settle pass ' + (i + 1) + ' (' + round1((now() - t) / 1000) + ' s): ' + last);
    if (r.code !== 0 || !/Actionable: [1-9]\d* page\(s\) still need|[1-9]\d* page\(s\) due for the mention pass/.test(r.stdout + r.stderr)) return { ms: round1(now() - t), runs: i + 1, last };
  }
  return { ms: round1(now() - t), runs: 20, last };
}

async function activate(home: string, ids: string[]): Promise<number> {
  const t = now();
  let state = '';
  for (const id of ids) {
    state = (await gb(['sources', 'writer', 'status', '--json'], { home })).json.admin_state as string;
    await gb(['sources', 'writer', 'claim', id, '--path', srcRoot(join(home, '..'), id), '--admin-intent', 'writer_claim', '--expected-state', state, '--json'], { home });
  }
  state = (await gb(['sources', 'writer', 'status', '--json'], { home })).json.admin_state as string;
  const a = await gb(['sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', state, '--json'], { home });
  if (a.json?.enabled !== true) throw new Error('activation did not enable managed persistence: ' + a.stdout.slice(-1500));
  return now() - t;
}

/** Copies a built brain (repos, corpus state, database) into `dir` for `mode`, pointing every source at the copy. */
async function cloneBrain(fromDir: string, fromDb: string, dir: string, db: string, mode: string, ids: string[]): Promise<void> {
  const home = join(dir, 'home');
  for (const id of ids) {
    copyDir(srcRoot(fromDir, id), srcRoot(dir, id));
    mkdirSync(srcState(dir, id), { recursive: true });
    writeFileSync(join(srcState(dir, id), 'corpus-state.json'), readFileSync(join(srcState(fromDir, id), 'corpus-state.json')));
  }
  const repoint = 'UPDATE sources SET local_path=$1 WHERE id=$2';
  if (ENGINE === 'postgres') {
    await admin(sql => sql.unsafe('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [fromDb]));
    if (await dbExists(db)) await admin(sql => sql.unsafe('DROP DATABASE ' + db + ' WITH (FORCE)'));
    await admin(sql => sql.unsafe('CREATE DATABASE ' + db + ' TEMPLATE ' + fromDb));
    writeConfig(home, mode, harness!.directUrl(db));
    for (const id of ids) await admin(sql => sql.unsafe(repoint, [srcRoot(dir, id), id]), db);
  } else {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    for (const f of readdirSync(join(fromDir, 'home', '.gbrain'))) if (f.startsWith('brain.pglite') && !f.includes('owner')) copyDir(join(fromDir, 'home', '.gbrain', f), join(home, '.gbrain', f));
    writeConfig(home, mode);
    await withPglite(home, async e => { for (const id of ids) await e.executeRaw(repoint, [srcRoot(dir, id), id]); });
  }
}

/** Builds the brain for (engine, mode, pages, sources, checkout) unless it is already built. */
async function ensureBrain(mode: 'classic' | 'managed', sources = SOURCES): Promise<Record<string, unknown>> {
  const dir = brainDir(mode, sources), home = join(dir, 'home'), root = join(dir, 'repo');
  const ids = ['bench', ...EXTRA_IDS.slice(0, sources - 1)];
  const ready = join(dir, 'ready.json');
  if (!has('rebuild') && !(ACTIVATION && mode === 'managed') && await brainBuilt(mode, sources)) {
    const prior = JSON.parse(readFileSync(ready, 'utf8'));
    if (prior.links_settled) return prior;
    writeConfig(home, mode, ENGINE === 'postgres' ? harness!.directUrl(dbName(mode, sources)) : undefined);
    prior.links_settled = await settleLinks(home);
    writeFileSync(ready, JSON.stringify(prior, null, 2));
    return prior;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const build: Record<string, unknown> = { engine: ENGINE, mode, pages: PAGES, sources: ids, source_pages: sources > 1 ? SOURCE_PAGES : undefined, rev: REV, built_at: new Date().toISOString() };
  const cloneFrom = mode === 'managed' && await brainBuilt('classic', sources) ? brainDir('classic', sources)
    : mode === 'classic' && sources > 1 && await brainBuilt('classic', 1) ? brainDir('classic', 1) : null;
  if (cloneFrom) {
    const from = mode === 'managed' ? ['classic', sources] as const : ['classic', 1] as const;
    log('cloning ' + brainKey(...from) + ' for ' + brainKey(mode, sources));
    const t = now();
    await cloneBrain(cloneFrom, dbName(...from), dir, dbName(mode, sources), mode, mode === 'managed' ? ids : ['bench']);
    build.cloned_from = brainKey(...from);
    build.clone_ms = round1(now() - t);
    if (mode === 'classic') {
      makeChange(srcRoot(dir, 'bench'), srcState(dir, 'bench'), 'single', 'bench');
      build.rebind_sync = await syncUntilDone(home, 'rebind bench to this home', 'bench');
    }
  } else {
    log('building ' + brainKey(mode, sources) + ': writing ' + PAGES + ' pages');
    let t = now();
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q');
    writeCorpus(root, PAGES);
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=Bench Example', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'corpus');
    writeState(dir, { pages: PAGES, deleted: [], added: [], nextAdd: 0, cursor: 0 });
    build.corpus_ms = round1(now() - t);
    if (ENGINE === 'postgres') {
      if (await dbExists(dbName(mode, sources))) await admin(sql => sql.unsafe('DROP DATABASE ' + dbName(mode, sources) + ' WITH (FORCE)'));
      await admin(sql => sql.unsafe('CREATE DATABASE ' + dbName(mode, sources)));
    }
    writeConfig(home, mode, ENGINE === 'postgres' ? harness!.directUrl(dbName(mode, sources)) : undefined);
    t = now();
    await gb(['sources', 'add', 'bench', '--path', root, '--no-federated'], { home });
    build.sources_add_ms = round1(now() - t);
    const s = await syncUntilDone(home, 'initial import');
    build.initial_import_ms = round1(s.ms);
    build.initial_import_pages_per_s = round1(PAGES / (s.ms / 1000));
  }
  if (mode === 'classic' && sources > 1) {
    for (const id of ids.slice(1)) {
      const r = srcRoot(dir, id);
      mkdirSync(r, { recursive: true });
      mkdirSync(srcState(dir, id), { recursive: true });
      git(r, 'init', '-q');
      writeCorpus(r, SOURCE_PAGES);
      git(r, 'add', '-A');
      git(r, '-c', 'user.name=Bench Example', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'corpus ' + id);
      writeState(srcState(dir, id), { pages: SOURCE_PAGES, deleted: [], added: [], nextAdd: 0, cursor: 0 });
      await gb(['sources', 'add', id, '--path', r, '--no-federated'], { home });
      build['import_' + id] = await syncUntilDone(home, 'initial import ' + id, id);
    }
    for (const id of ids) await gb(['sources', 'federate', id, '--brain', 'host'], { home });
  }
  if (mode === 'classic') build.links_settled = await settleLinks(home);
  if (mode === 'classic' && sources > 1) for (const id of ids.slice(1)) build['links_settled_' + id] = await settleLinks(home, id);
  if (mode === 'managed') {
    build.activate_ms = round1(await activate(home, ids));
    if (ACTIVATION) {
      if (ENGINE === 'postgres') await admin(async sql => { await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements'); await sql.unsafe('SELECT pg_stat_statements_reset()'); });
      build.first_managed_sync = await syncUntilDone(home, 'post-activation bench', 'bench', MAX_ACTIVATION_PASSES, join(outDir, 'logs', cellId + '-activation-passes'));
      if (ENGINE === 'postgres') {
        const pg = await admin(sql => readPgStatStatements(sql, dbName(mode, sources)));
        build.first_managed_sync_statements = { calls: pg.calls, calls_ex_txn: pg.calls_ex_txn, total_ms: pg.total_ms, top: pg.top };
      }
      return build;
    }
    for (const id of ids) build[id === 'bench' ? 'first_managed_sync' : 'first_managed_sync_' + id] = await syncUntilDone(home, 'post-activation ' + id, id);
    build.links_settled = await settleLinks(home);
    for (const id of ids.slice(1)) build['links_settled_' + id] = await settleLinks(home, id);
  }
  writeFileSync(ready, JSON.stringify(build, null, 2));
  return build;
}

async function withPglite<T>(home: string, fn: (engine: any) => Promise<T>): Promise<T> {
  const prior = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = home;
  const { PGLiteEngine } = await import(join(GROOT, 'src/core/pglite-engine.ts'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
  try { return await fn(engine); } finally { await engine.disconnect(); if (prior === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = prior; }
}
async function pgliteVerify(c: Change): Promise<{ getOk: boolean; searchOk: boolean; hits: number }> {
  return withPglite(HOME, async engine => {
    const { present, gone } = getTargets(c);
    let getOk = true;
    for (const p of present) { const page = await engine.getPage(slugOf(p), { sourceId: c.source }); if (!page || !String(page.compiled_truth).includes(c.token)) getOk = false; }
    for (const p of gone) if (await engine.getPage(slugOf(p), { sourceId: c.source })) getOk = false;
    const hits = new Set((await engine.searchKeyword(c.token, { limit: 100, sourceId: c.source })).map((h: { slug: string }) => h.slug)).size;
    const [{ n }] = await engine.executeRaw("SELECT count(*)::int AS n FROM pages WHERE source_id=$2 AND deleted_at IS NULL AND compiled_truth LIKE $1", ['%' + c.token + '%', c.source]);
    return { getOk, searchOk: hits >= Math.min(100, expectedHits(c)) && n >= expectedHits(c), hits, pages_with_token: n };
  });
}

// ---------------------------------------------------------------------------
// Phase extraction from timestamped child lines.
// ---------------------------------------------------------------------------
const PHASE_RES: Array<[string, RegExp]> = [
  ['first_line', /./],
  ['frozen', /entries frozen|managed catch-up:/],
  ['first_progress', /\d+\/\d+ processed/],
  ['done', /^Synced [0-9a-f]+\.\.|^First sync complete|Managed sync synced|^\[\d\d:\d\d:\d\d\] Synced:|Already up to date|up to date/],
  ['serve_job_started', /on-commit: .*started managed sync job/],
  ['serve_resuming', /on-commit: .*resuming/],
  ['cycle', /\[cycle\]|"event":"cycle"/],
];
function phaseMarks(lines: Line[], from: number, to: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) {
    if (l.t < from || l.t > to) continue;
    const gp = /\[(?:foresights|gbrain) phase\] (\S+) done (\d+)ms/.exec(l.text);
    if (gp && out['gp:' + gp[1]] === undefined) out['gp:' + gp[1]] = Number(gp[2]);
    for (const [name, re] of PHASE_RES) if (out[name] === undefined && (name !== 'first_line' || l.stream === 'err') && re.test(l.text.replace(/^\[\d\d:\d\d:\d\d\] (?=\[)/, ''))) out[name] = round1(l.t - from);
  }
  return out;
}

// ---------------------------------------------------------------------------
// One cell.
// ---------------------------------------------------------------------------
interface Rep { rep: number; sha: string; token: string; files: number; get_ms: number | null; search_ms: number | null; first_hit_ms: number | null; commit_git_ms: number;
  source: string; phases: Record<string, number>; probes?: number; probe_ms_mean?: number; exit_ms?: number | null; verified?: unknown; note?: string; error?: string;
  per_source?: Record<string, number | null> }

/** sync_notifier_sources.detection_mode per source (null on a brain without the notifier tables). */
async function readDetection(): Promise<Record<string, string | null> | null> {
  const q = 'SELECT source_id, detection_mode, owner_kind FROM sync_notifier_sources ORDER BY source_id';
  try {
    const rows: Array<{ source_id: string; detection_mode: string | null; owner_kind: string | null }> = ENGINE === 'postgres'
      ? await admin(sql => sql.unsafe(q) as any, dbName(MODE)) : await withPglite(HOME, e => e.executeRaw(q));
    return Object.fromEntries(rows.map(r => [r.source_id, r.detection_mode ? r.detection_mode + (r.owner_kind ? ' (' + r.owner_kind + ')' : '') : null]));
  } catch { return null; }
}

/** Every rep's token: chunks carrying it, and how many of them have a vector; plus chunks of the source still without one. */
async function embedAudit(tokens: string[]): Promise<{ per_rep: Array<{ token: string; total: number; embedded: number }>; source_chunks_missing_vector: number }> {
  const q = "SELECT count(*)::int AS total, count(*) FILTER (WHERE c.embedding IS NOT NULL)::int AS embedded FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='bench' AND p.deleted_at IS NULL AND c.chunk_text LIKE $1";
  const qm = "SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='bench' AND p.deleted_at IS NULL AND c.embedding IS NULL";
  const run = async (exec: (sql: string, params: unknown[]) => Promise<any[]>) => ({
    per_rep: await Promise.all(tokens.map(async token => ({ token, ...(await exec(q, ['%' + token + '%']))[0] }))),
    source_chunks_missing_vector: (await exec(qm, []))[0].n as number,
  });
  return ENGINE === 'postgres' ? admin(sql => run((s, p) => sql.unsafe(s, p as any[]) as any), dbName(MODE)) : withPglite(HOME, e => run((s, p) => e.executeRaw(s, p)));
}

const cellId = [ENGINE, MODE, PAGES, SOURCES > 1 ? 's' + SOURCES : '', MULTI ? SCENARIO + '-' + RESIDENTS.join('+') : COMMIT, MULTI ? '' : TRIGGER, RTT ? 'rtt' + RTT : '',
  !MULTI && SCENARIO !== 'plain' ? SCENARIO : '', DETECTION === 'poll' ? 'poll' : '', EMBED === 'stub' ? 'embed' + EMBED_LATENCY_MS : EMBED === 'keyless-stub' ? 'keylessstub' : '',
  STUB_FAIL_MS ? 'fail' + STUB_FAIL_MS : '', LABEL.replace(/[^\w.-]/g, '_')].filter(Boolean).join('-');
const outDir = join(WORK, 'results');

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  if (has('skip-existing') && existsSync(join(outDir, cellId + '.json'))) { log('cell ' + cellId + ': result exists, skipped (--skip-existing)'); return; }
  if (ENGINE === 'postgres') harness = await startHarness({ pgPort: 55432, proxyPort: Number(flag('proxy-port', String(56000 + (process.pid % 1000)))), apiPort: 58474, keep: true });
  const seen = new Map<string, { first: number; texts: Set<string> }>();
  let failUntil = 0;
  const stubOpts = { latencyMs: Number(flag('build-embed-latency-ms', '5')), maxConcurrent: 8, dims: 1536 };
  const stub = EMBED !== 'off' ? await startEmbeddingStub({ ...stubOpts, get latencyMs() { return stubOpts.latencyMs; }, failWhile: () => now() < failUntil,
    onInputs: xs => { const t = now(); for (const x of xs) for (const m of x.matchAll(/zq[a-z]{10}/g)) { const e = seen.get(m[0]) ?? { first: t, texts: new Set<string>() }; e.texts.add(x); seen.set(m[0], e); } } }) : null;
  if (stub) stubUrl = stub.url;
  if (SOURCES > 1 && !(await brainBuilt('classic', 1))) await ensureBrain('classic', 1);
  if (MODE === 'managed' && !(await brainBuilt('classic')) && (PAGES >= 10000 || SOURCES > 1)) await ensureBrain('classic');
  const build = await ensureBrain(MODE);
  if (ACTIVATION) {
    if (harness) harness.stop();
    const first = build.first_managed_sync as { ms: number; runs: number; capped?: boolean; statuses: string[] };
    const stmts = build.first_managed_sync_statements as { calls: number; calls_ex_txn: number } | undefined;
    const result = { schema: 'gbrain-sync-activation/1', cell: cellId, label: LABEL, gbrain_rev: git(GROOT, 'log', '-1', '--format=%h', '--abbrev=8', '--', 'src', 'package.json'), brain_rev: REV,
      gbrain_root: GROOT, at: new Date().toISOString(), params: { engine: ENGINE, pages: PAGES, max_passes: MAX_ACTIVATION_PASSES || null }, machine: machineInfo(), build,
      converged: !first.capped, passes: first.runs, wall_ms: round1(first.ms), statements: stmts ? { calls: stmts.calls, calls_ex_txn: stmts.calls_ex_txn } : null };
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, 'activation-' + cellId + '.json');
    writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
    if (JSON_OUT) console.log(JSON.stringify(result));
    log('wrote ' + file + ': ' + (first.capped ? 'NOT converged' : 'converged') + ' in ' + first.runs + ' pass(es), ' + round1(first.ms / 1000) + ' s'
      + (stmts ? ', ' + stmts.calls + ' statements (' + stmts.calls_ex_txn + ' without transaction control)' : '') + ' [' + first.statuses.join(', ') + ']');
    if (first.capped) process.exit(1);
    return;
  }
  stubOpts.latencyMs = EMBED_LATENCY_MS;
  const brainUrl = ENGINE === 'postgres' ? (RTT ? harness!.proxyUrl(dbName(MODE)) : directUrl()) : undefined;
  writeConfig(HOME, MODE, brainUrl);
  let measuredRtt: number | null = null;
  if (ENGINE === 'postgres') { await harness!.setRtt(RTT); measuredRtt = await measureRtt(brainUrl!); }
  mkdirSync(join(outDir, 'logs'), { recursive: true });
  const logFile = join(outDir, 'logs', cellId + '-' + Date.now() + '.log');
  log('cell ' + cellId + ' (' + REPS + ' reps)');

  const reps: Rep[] = [];
  const notes: string[] = [];
  const extra: Record<string, unknown> = {};
  let resident: Child | null = null;
  const residents: Array<{ kind: string; child: Child }> = [];
  let mcp: McpClient | null = null;
  const embedSeen = EMBED === 'stub' ? (t: string) => seen.has(t) : undefined;
  let prober: Prober | null = ENGINE === 'postgres' && SCENARIO !== 'idle'
    ? await engineProber(GROOT, directUrl(), EMBED === 'stub', t => [...(seen.get(t)?.texts ?? [])][0]) : null;
  const startServe = async (): Promise<Child> => {
    const child = spawnChild([process.execPath, CLI, 'serve'], { cwd: HOME, env: childEnv(), logFile, stdin: true });
    mcp = new McpClient(child);
    await mcp.init();
    return child;
  };
  const stopChild = async (child: Child) => { child.kill('SIGTERM'); await Promise.race([child.exited, sleep(40_000)]); child.kill('SIGKILL'); await child.exited; };

  if (MULTI) {
    await gb(['config', 'set', 'sync.on_commit', 'true']);
    for (const kind of RESIDENTS) {
      if (kind === 'serve') {
        const child = await startServe();
        residents.push({ kind, child });
        if (!prober) prober = mcpProber(mcp!, embedSeen);
        const enabled = await waitLine(child, /on-commit: enabled/, 45_000);
        notes.push(enabled ? 'serve on-commit watcher enabled ' + round1(enabled.t - child.startedAt) + ' ms after spawn' : 'serve printed no on-commit enabled line within 45 s');
      } else {
        const argv = kind === 'jobs' ? ['jobs', 'work'] : ['autopilot', '--repo', ROOT, '--interval', String(INTERVAL), '--json'];
        residents.push({ kind, child: spawnChild([process.execPath, CLI, ...argv], { cwd: HOME, env: childEnv(), logFile }) });
      }
    }
    await sleep(5000);
  } else if (TRIGGER === 'serve') {
    await gb(['config', 'set', 'sync.on_commit', 'true']);
    resident = await startServe();
    if (!prober) prober = mcpProber(mcp!, embedSeen);
    const enabled = await waitLine(resident, /on-commit: enabled/, 45_000);
    notes.push(enabled ? 'serve on-commit watcher enabled ' + round1(enabled.t - resident.startedAt) + ' ms after spawn' : 'serve printed no on-commit enabled line within 45 s');
    await sleep(4000);
  } else if (TRIGGER === 'serve-boot') {
    await gb(['config', 'set', 'sync.on_commit', 'true']);
    notes.push('serve-boot: each rep commits while no serve runs, then spawns foresights serve (stdio); boot_to_visible_ms is spawn -> search visible (PGLite probes through that serve, so it includes MCP initialize)');
  } else if (TRIGGER === 'watch') {
    resident = spawnChild([process.execPath, CLI, 'sync', '--watch', '--interval', String(INTERVAL), '--source', 'bench', '--no-pull'], { cwd: HOME, env: childEnv(), logFile });
    await waitLine(resident, /Watching for changes/, 120_000);
    if (ENGINE === 'pglite') notes.push('PGLite: the watch process holds the single-writer lock, so nothing else can read the brain; probes cannot run (derive from interval + manual sync cost).');
  } else if (TRIGGER === 'autopilot') {
    resident = spawnChild([process.execPath, CLI, 'autopilot', '--repo', ROOT, '--interval', String(INTERVAL), '--json'], { cwd: HOME, env: childEnv(), logFile });
    await waitLine(resident, /cycle|Autopilot starting/, 120_000);
  } else if (TRIGGER === 'jobs') {
    if (ENGINE !== 'postgres') { notes.push('PGLite has no resident jobs worker ("foresights jobs work" drains the queue and exits).'); }
    else {
      resident = spawnChild([process.execPath, CLI, 'jobs', 'work'], { cwd: HOME, env: childEnv(), logFile });
      await sleep(5000);
    }
  }

  if (TRIGGER === 'jobs' && prober && resident && !MULTI) {
    const c = makeChange(ROOT, DIR, 'single');
    const v = await pollVisible(prober, c, now() + 30_000, 500);
    notes.push('jobs worker alone (no submit): ' + (v.t_search === null ? 'nothing synced a single-file commit within 30 s; the worker has no autonomous sync trigger' : 'the commit became visible after ' + round1(v.t_search - c.t_commit) + ' ms without a submit'));
    await gb(['jobs', 'submit', 'sync', '--params', JSON.stringify({ sourceId: 'bench', noPull: true })], { allowFail: true });
    await pollVisible(prober, c, now() + 120_000, 200);
  }

  if (COMMIT === 'noop' && !MULTI) {
    await gb(['sync', '--source', 'bench', '--no-pull', '--json'], { allowFail: true });
    notes.push('noop: HEAD equals the last synced commit (one unrecorded sync converged it first); each rep is one manual sync with nothing to do, timed spawn to exit');
    for (let rep = 0; rep < REPS; rep++) {
      await sleep(300);
      const trace = TRACE && ENGINE === 'postgres' ? join(outDir, 'logs', cellId + '-rep' + rep + '-sql.jsonl') : undefined;
      if (trace) rmSync(trace, { force: true });
      const child = spawnChild([process.execPath, CLI, 'sync', '--source', 'bench', '--no-pull', '--json'], { cwd: HOME, env: childEnv(trace ? { GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: 'noop-sync' } : {}), logFile });
      const code = await child.exited;
      const r: Rep = { rep, sha: git(ROOT, 'rev-parse', '--short=12', 'HEAD'), token: '', files: 0, get_ms: null, search_ms: null, first_hit_ms: null, commit_git_ms: 0, source: 'exit', phases: {} };
      r.exit_ms = round1(child.exitAt! - child.startedAt);
      for (const [k, v] of Object.entries(phaseMarks(child.lines, child.startedAt, now()))) r.phases[k] = v;
      const out = child.stdoutRaw();
      try { const j = JSON.parse(out.slice(out.indexOf('{'))); r.phases.sync_status = j.sync_status; } catch { /* not json */ }
      if (code !== 0) r.error = 'sync exited ' + code;
      if (trace && existsSync(trace)) {
        const recs = readTrace(trace);
        const byClass: Record<string, { n: number; ms: number }> = {};
        for (const x of recs) { const c = byClass[classify(x.sql)] ??= { n: 0, ms: 0 }; c.n++; c.ms += x.ms; }
        r.phases.db_round_trips = recs.length;
        r.phases.db_ms = round1(recs.reduce((a, x) => a + x.ms, 0));
        if (recs.length) r.phases.db_span_ms = round1(Math.max(...recs.map(x => x.t + x.ms)) - Math.min(...recs.map(x => x.t)));
        (r as Rep & { sql?: unknown }).sql = { by_class: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, { n: v.n, ms: round1(v.ms) }])), top: groupStatements(recs, 1, 100000).sort((a, b) => b.total_ms - a.total_ms).slice(0, 12).map(g => ({ sql: g.sql, count: g.count, total_ms: g.total_ms })) };
      }
      reps.push(r);
      log('noop rep ' + (rep + 1) + '/' + REPS + ': exit ' + r.exit_ms + ' ms ' + JSON.stringify(r.phases) + (r.error ? ' ERROR ' + r.error : ''));
    }
  }

  const tokens: string[] = [];
  try {
    if (SCENARIO === 'idle') {
      log('idle: warming up ' + WARMUP_S + ' s, then ' + IDLE_WINDOWS + ' windows of ' + WINDOW_S + ' s');
      await sleep(WARMUP_S * 1000);
      const db = dbName(MODE);
      const sql = ENGINE === 'postgres' ? postgres(harness!.directUrl('postgres'), { max: 1, onnotice: () => {} }) : null;
      const counters = async () => sql ? (await sql.unsafe('SELECT (xact_commit + xact_rollback)::bigint AS tx, tup_returned::bigint AS returned, (tup_inserted + tup_updated + tup_deleted)::bigint AS writes FROM pg_stat_database WHERE datname=$1', [db]))[0] as any : null;
      const windows: Array<Record<string, unknown>> = [];
      try {
        for (let k = 0; k < IDLE_WINDOWS; k++) {
          const x0 = await counters();
          const c0 = residents.map(r => treeCpuSeconds(r.child.proc.pid));
          const t0 = now();
          const backends: number[] = [];
          while (now() - t0 < WINDOW_S * 1000) {
            if (sql) backends.push(Number((await sql.unsafe('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [db]))[0]!.n));
            await sleep(1000);
          }
          const x1 = await counters();
          const minutes = (now() - t0) / 60_000;
          const c1 = residents.map(r => treeCpuSeconds(r.child.proc.pid));
          const w: Record<string, unknown> = { window_s: round1((now() - t0) / 1000), cpu_s_per_min: Object.fromEntries(residents.map((r, i) => [r.kind, Math.round(((c1[i]! - c0[i]!) / minutes) * 1000) / 1000])) };
          if (x0 && x1) Object.assign(w, { tx: Number(x1.tx) - Number(x0.tx), rows_returned: Number(x1.returned) - Number(x0.returned), rows_written: Number(x1.writes) - Number(x0.writes),
            backends_median: stats(backends).p50, backends_max: stats(backends).max });
          windows.push(w);
          log('idle window ' + (k + 1) + '/' + IDLE_WINDOWS + ': ' + JSON.stringify(w));
        }
        if (sql) extra.backends_by_app = await sql.unsafe("SELECT coalesce(nullif(application_name,''),'(none)') AS app, state, count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 GROUP BY 1,2 ORDER BY 3 DESC", [db]);
      } finally { await sql?.end(); }
      const col = (k: string) => windows.map(w => w[k]).filter((x): x is number => typeof x === 'number');
      extra.idle = { windows, tx_per_window: stats(col('tx')), rows_returned_per_window: stats(col('rows_returned')), rows_written_per_window: stats(col('rows_written')),
        backends_median: stats(col('backends_median')), backends_max: stats(col('backends_max')),
        cpu_s_per_min: Object.fromEntries(residents.map(r => [r.kind, stats(windows.map(w => (w.cpu_s_per_min as Record<string, number>)[r.kind]!))])) };
      notes.push('idle: residents ' + RESIDENTS.join('+') + ' on one brain with sync.on_commit=true and ' + SOURCES + ' source(s), no commits; tx from pg_stat_database (the sampler connects to the postgres database, so it is not counted), backends from pg_stat_activity each second, CPU from /proc (resident plus live children)');
    }

    for (let rep = 0; rep < (COMMIT === 'noop' || SCENARIO === 'idle' ? 0 : REPS); rep++) {
      if (TRIGGER === 'watch' || TRIGGER === 'autopilot') await sleep(Math.random() * INTERVAL * 1000);
      else await sleep((TRIGGER === 'serve' || MULTI ? 3500 : 300) + Math.random() * JITTER_MS);

      if (SCENARIO === 'fairness') {
        const changes = ALL_IDS.map(id => makeChange(srcRoot(DIR, id), srcState(DIR, id), 'single', id));
        const vs = await Promise.all(changes.map(c => pollVisible(prober!, c, c.t_commit + TIMEOUT_S * 1000, PROBE_MS)));
        const per = Object.fromEntries(changes.map((c, i) => [c.source, vs[i]!.t_search === null ? null : round1(vs[i]!.t_search! - c.t_commit)]));
        const got = Object.values(per).filter((x): x is number => x !== null);
        const r: Rep = { rep, sha: changes[0]!.sha.slice(0, 12), token: changes[0]!.token, files: changes.length, get_ms: null, search_ms: got.length === changes.length ? Math.max(...got) : null,
          first_hit_ms: got.length ? Math.min(...got) : null, commit_git_ms: round1(changes.at(-1)!.t_commit - changes[0]!.t_commit_start), source: prober!.kind, phases: {}, per_source: per };
        r.get_ms = r.search_ms;
        if (got.length) r.phases.spread_ms = round1(Math.max(...got) - Math.min(...got));
        r.phases.all_visible_after_first_commit_ms = r.search_ms === null ? -1 : round1(Math.max(...changes.map((c, i) => vs[i]!.t_search ?? Infinity)) - changes[0]!.t_commit_start);
        if (r.search_ms === null) r.error = 'source(s) never visible within ' + TIMEOUT_S + ' s: ' + Object.entries(per).filter(([, v]) => v === null).map(([k]) => k).join(', ');
        reps.push(r);
        log('fairness rep ' + (rep + 1) + '/' + REPS + ': ' + JSON.stringify(per) + ' spread ' + r.phases.spread_ms + (r.error ? ' ERROR ' + r.error : ''));
        continue;
      }

      if (TRIGGER === 'serve-boot') {
        const c = makeChange(ROOT, DIR, COMMIT as CommitKind);
        await sleep(300);
        const tSpawn = now();
        const child = await startServe();
        const tReady = now();
        const p = prober ?? mcpProber(mcp!, embedSeen);
        const v = await pollVisible(p, c, c.t_commit + TIMEOUT_S * 1000, PROBE_MS);
        const r: Rep = { rep, sha: c.sha.slice(0, 12), token: c.token, files: expectedHits(c) + c.deleted.length, get_ms: v.t_get === null ? null : round1(v.t_get - c.t_commit),
          search_ms: v.t_search === null ? null : round1(v.t_search - c.t_commit), first_hit_ms: null, commit_git_ms: round1(c.t_commit - c.t_commit_start), source: p.kind,
          phases: { mcp_ready_ms: round1(tReady - tSpawn), ...(v.t_search !== null ? { boot_to_visible_ms: round1(v.t_search - tSpawn) } : {}) } };
        for (const [k, val] of Object.entries(phaseMarks(child.lines, tSpawn, now()))) r.phases[k] = val;
        if (r.search_ms === null) r.error = 'never visible within ' + TIMEOUT_S + ' s of the commit';
        await stopChild(child);
        reps.push(r);
        log('serve-boot rep ' + (rep + 1) + '/' + REPS + ': boot->visible ' + r.phases.boot_to_visible_ms + ' ms, commit->visible ' + r.search_ms + ' ms ' + JSON.stringify(r.phases) + (r.error ? ' ERROR ' + r.error : ''));
        continue;
      }

      let pre: Change | null = null;
      if (SCENARIO === 'during-sync') {
        pre = makeChange(ROOT, DIR, 'batch');
        if (TRIGGER === 'serve' && resident) await waitLine(resident, /started managed sync job/, 60_000, pre.t_commit);
        await sleep(Number(flag('during-delay-ms', '500')));
      }
      const before = stub ? { ...stub.stats } : null;
      if (STUB_FAIL_MS) failUntil = now() + STUB_FAIL_MS;
      const c = makeChange(ROOT, DIR, SCENARIO === 'embed-drain' ? 'backlog' : COMMIT as CommitKind);
      tokens.push(c.token);
      const deadline = c.t_commit + TIMEOUT_S * 1000;
      const r: Rep = { rep, sha: c.sha.slice(0, 12), token: c.token, files: c.edited.length + c.added.length + c.deleted.length, get_ms: null, search_ms: null, first_hit_ms: null,
        commit_git_ms: round1(c.t_commit - c.t_commit_start), source: '', phases: {} };
      let child: Child | null = resident;
      if (TRIGGER === 'manual') {
        child = spawnChild([process.execPath, CLI, 'sync', '--source', 'bench', '--no-pull', '--json'], { cwd: HOME, env: childEnv(), logFile });
      } else if (TRIGGER === 'jobs' && ENGINE === 'postgres') {
        const t = now();
        const sub = await gb(['jobs', 'submit', 'sync', '--params', JSON.stringify({ sourceId: 'bench', noPull: true })], { allowFail: true });
        r.phases.submit_cli_ms = round1(now() - t);
        r.phases.submit_after_commit_ms = round1(t - c.t_commit);
        if (sub.code !== 0) r.error = 'jobs submit failed: ' + (sub.stdout + sub.stderr).slice(-400);
      }
      if (prober) {
        const v = await pollVisible(prober, c, deadline, PROBE_MS);
        r.source = prober.kind;
        r.get_ms = v.t_get === null ? null : round1(v.t_get - c.t_commit);
        r.search_ms = v.t_search === null ? null : round1(v.t_search - c.t_commit);
        r.first_hit_ms = v.t_first_hit === null ? null : round1(v.t_first_hit - c.t_commit);
        r.probes = v.probes; r.probe_ms_mean = v.probe_ms_mean;
        if (v.t_embedded !== undefined) r.phases.embedded_ms = v.t_embedded === null ? -1 : round1(v.t_embedded - c.t_commit);
        if (v.t_vector !== undefined) r.phases.vector_hit_ms = v.t_vector === null ? -1 : round1(v.t_vector - c.t_commit);
        if (SCENARIO === 'embed-drain' && EMBED === 'stub') {
          const want = expectedHits(c);
          while (now() < deadline && (seen.get(c.token)?.texts.size ?? 0) < want) await sleep(PROBE_MS);
          const n = seen.get(c.token)?.texts.size ?? 0;
          r.phases.stub_inputs_with_token = n;
          if (n >= want) r.phases.stub_drained_ms = round1(now() - c.t_commit);
          else r.error = 'the stub embedded ' + n + ' of ' + want + ' changed chunks within ' + TIMEOUT_S + ' s';
          if (ENGINE === 'postgres' && r.phases.embedded_ms === -1) r.error = (r.error ? r.error + '; ' : '') + 'chunks with the token never all carried a vector';
        }
        if (EMBED === 'keyless-stub') await sleep(SETTLE_S * 1000);
        if (TRIGGER === 'manual' && child) { await child.exited; r.exit_ms = round1(child.exitAt! - c.t_commit); }
      } else if (TRIGGER === 'manual' && child) {
        await child.exited;
        r.exit_ms = round1(child.exitAt! - c.t_commit);
        const done = child.lines.find(l => PHASE_RES[3]![1].test(l.text));
        r.source = 'done-line';
        r.get_ms = r.search_ms = done ? round1(done.t - c.t_commit) : null;
        const total = expectedHits(c) + c.deleted.length;
        const processed = child.lines.find(l => new RegExp('\\b' + total + '/' + total + ' processed').test(l.text));
        if (processed) r.phases.all_processed_line_ms = round1(processed.t - c.t_commit);
        r.verified = await pgliteVerify(c);
        if (!(r.verified as { getOk: boolean }).getOk) r.error = 'PGLite verification after exit did not see the change';
      } else {
        r.source = 'none';
        r.note = 'no reader available while the trigger process holds the PGLite lock';
        if (resident) await waitLine(resident, PHASE_RES[3]![1], TIMEOUT_S * 1000, c.t_commit).then(l => { if (l) r.phases.done_line_ms = round1(l.t - c.t_commit); });
      }
      if (stub && before) { r.phases.stub_requests = stub.stats.requests - before.requests; r.phases.stub_calls = stub.stats.calls - before.calls; r.phases.stub_failed = stub.stats.failed - before.failed; }
      if (child && child === resident && r.search_ms !== null) await waitLine(child, PHASE_RES[3]![1], 5000, c.t_commit);
      if (child) {
        const base = TRIGGER === 'manual' ? child.startedAt : c.t_commit;
        const marks = phaseMarks(child.lines, base, now());
        for (const [k, v] of Object.entries(marks)) r.phases[k] = v;
        if (TRIGGER === 'manual') r.phases.spawn_after_commit_ms = round1(child.startedAt - c.t_commit);
        if (TRIGGER === 'manual') { const out = child.stdoutRaw(); try { const j = JSON.parse(out.slice(out.indexOf('{'))); r.phases.sync_status = j.sync_status; r.phases.written = j.drain?.written ?? j.added + j.modified; } catch { /* not json */ } }
      }
      if (pre) r.note = 'committed while the sync of a 60-file batch (' + pre.sha.slice(0, 8) + ') was running';
      reps.push(r);
      log('rep ' + (rep + 1) + '/' + REPS + ': get ' + r.get_ms + ' ms, search ' + r.search_ms + ' ms' + (r.exit_ms ? ', exit ' + r.exit_ms + ' ms' : '') + ' ' + JSON.stringify(r.phases) + (r.error ? ' ERROR ' + r.error : ''));
      if (r.search_ms === null && r.get_ms === null && r.source !== 'none' && TRIGGER !== 'serve') { notes.push('rep ' + rep + ' never became visible within ' + TIMEOUT_S + ' s'); }
      if (r.search_ms === null && MODE === 'classic' && TRIGGER === 'serve') { notes.push('classic brain: serve never synced the commit within ' + TIMEOUT_S + ' s'); break; }
    }
    if (ENGINE === 'postgres') extra.detection_observed = await readDetection();
  } finally {
    if (SCENARIO === 'embed-drain' && ENGINE === 'pglite') await sleep(SETTLE_S * 1000);
    if (resident) await stopChild(resident);
    for (const r of residents) await stopChild(r.child);
    if (TRIGGER === 'serve' || TRIGGER === 'serve-boot' || MULTI) await gb(['config', 'set', 'sync.on_commit', 'false'], { allowFail: true });
    await prober?.close();
    if (stub) { notes.push('embedding stub: ' + JSON.stringify(stub.stats) + ', ' + EMBED_LATENCY_MS + ' ms per call' + (STUB_FAIL_MS ? ', 500 for ' + STUB_FAIL_MS + ' ms after each commit' : '')); stub.close(); }
  }
  if (ENGINE === 'pglite' && (TRIGGER === 'serve' || TRIGGER === 'serve-boot' || MULTI)) extra.detection_observed = await readDetection();
  if (SCENARIO === 'embed-drain' && EMBED === 'stub') extra.embed_audit = await embedAudit(tokens);
  if (EMBED === 'keyless-stub') extra.keyless_stub_requests = stub!.stats.requests;
  if (harness) { await harness.setRtt(0); harness.stop(); }

  const ok = (k: 'get_ms' | 'search_ms') => reps.map(r => r[k]).filter((x): x is number => typeof x === 'number');
  const phaseKeys = [...new Set(reps.flatMap(r => Object.keys(r.phases)))].filter(k => reps.some(r => typeof r.phases[k] === 'number'));
  const phaseStats: Record<string, Stats> = {};
  for (const k of phaseKeys) phaseStats[k] = stats(reps.map(r => r.phases[k]).filter((x): x is number => typeof x === 'number' && x >= 0));
  if (SCENARIO === 'fairness') extra.per_source = Object.fromEntries(ALL_IDS.map(id => [id, stats(reps.map(r => r.per_source?.[id]).filter((x): x is number => typeof x === 'number'))]));
  const kind = SCENARIO === 'idle' ? 'idle' : SCENARIO === 'fairness' ? 'fairness' : SCENARIO === 'embed-drain' ? 'embed-drain' : 'latency';
  const result = {
    schema: 'gbrain-sync-freshness/1', kind, cell: cellId, label: LABEL, gbrain_rev: REV, gbrain_root: GROOT, at: new Date().toISOString(),
    params: { engine: ENGINE, mode: MODE, pages: PAGES, commit: SCENARIO === 'embed-drain' ? 'backlog' : COMMIT, trigger: MULTI ? RESIDENTS.join('+') : TRIGGER, reps: REPS, rtt_ms: RTT, measured_rtt_ms: measuredRtt,
      interval_s: ['watch', 'autopilot'].includes(TRIGGER) || RESIDENTS.includes('autopilot') ? INTERVAL : null, scenario: SCENARIO, probe_ms: PROBE_MS, timeout_s: TIMEOUT_S, keyless: EMBED !== 'stub',
      embed: EMBED === 'stub' ? { provider: 'loopback OpenAI stub', latency_ms: EMBED_LATENCY_MS, fail_ms_after_commit: STUB_FAIL_MS } : EMBED === 'keyless-stub' ? { provider: 'none (keyless; OPENAI_BASE_URL points at a counting stub)' } : null,
      detection: ['serve', 'serve-boot'].includes(TRIGGER) || MULTI ? DETECTION : null, jitter_ms: JITTER_MS, sources: ALL_IDS, source_pages: SOURCES > 1 ? SOURCE_PAGES : null, residents: MULTI ? RESIDENTS : null },
    machine: machineInfo(), build, notes: [...new Set(notes)],
    get_page: stats(ok('get_ms')), search: stats(ok('search_ms')), exit: stats(reps.map(r => r.exit_ms).filter((x): x is number => typeof x === 'number')),
    phases: phaseStats, ...extra, failures: reps.filter(r => r.error || (r.source !== 'none' && r.source !== 'exit' && r.search_ms === null)).length, reps, log: logFile,
  };
  const file = join(outDir, cellId + '.json');
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  if (JSON_OUT) console.log(JSON.stringify(result));
  log('wrote ' + file + ': search p50 ' + result.search.p50 + ' p95 ' + result.search.p95 + ' max ' + result.search.max + ' cv ' + result.search.cv + ' (n=' + result.search.n + ')'
    + (phaseStats.embedded_ms ? ' embedded p50 ' + phaseStats.embedded_ms.p50 : '') + (extra.detection_observed ? ' detection ' + JSON.stringify(extra.detection_observed) : ''));
}

/** p50 / p95 / max in seconds; p95 only from n >= 40 (otherwise "-", read the max). */
function sec(x: Stats | undefined): string {
  return x && x.n ? [x.p50, x.n >= 40 ? x.p95 : null, x.max].map(v => v === null || v === undefined ? '-' : (v / 1000).toFixed(2)).join(' / ') : '-';
}

function report(dirs: string): void {
  const rows = dirs.split(',').flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))).filter(r => r.schema === 'gbrain-sync-freshness/1')
    .sort((a, b) => a.cell.localeCompare(b.cell));
  const det = (r: any) => !r.params.detection ? '-' : r.detection_observed
    ? [...new Set(Object.values(r.detection_observed as Record<string, string | null>).map(v => v ?? 'unrecorded'))].join(', ') : r.params.detection + ' (requested; not recorded)';
  const ph = (r: any) => Object.entries(r.phases as Record<string, Stats>).filter(([k, v]) => v.n && v.p50 !== null && !['written', 'spawn_after_commit_ms', 'submit_cli_ms'].includes(k) && !k.startsWith('stub_') || k === 'stub_drained_ms').map(([k, v]) => k + ' ' + (v.p50! / 1000).toFixed(2)).join(', ');
  const lat = rows.filter(r => !r.kind || r.kind === 'latency' || r.kind === 'embed-drain');
  console.log('| cell | engine | mode | pages | commit | trigger | detection | rtt | n | get_page p50/p95/max s | search p50/p95/max s | search cv | embedded p50/p95/max s | exit p50/p95/max s | phases (p50 s) | failures | foresights |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of lat) {
    const p = r.params;
    const emb = r.phases.embedded_ms ?? r.phases.stub_drained_ms;
    console.log('| ' + [r.cell, p.engine, p.mode, p.pages, p.commit + (p.scenario !== 'plain' ? ' (' + p.scenario + ')' : ''), p.trigger + (p.interval_s ? ' ' + p.interval_s + 's' : ''), det(r), p.rtt_ms ? p.rtt_ms + ' ms' : '0',
      r.search.n + '/' + p.reps, sec(r.get_page), sec(r.search), r.search.cv ?? '-', sec(emb), sec(r.exit), ph(r), r.failures ?? 0, r.gbrain_rev].join(' | ') + ' |');
  }
  const fair = rows.filter(r => r.kind === 'fairness');
  if (fair.length) {
    console.log('\n| cell | engine | mode | sources | residents | detection | n | all sources visible p50/p95/max s | spread p50/p95/max s | per-source p50 s | failures | foresights |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of fair) console.log('| ' + [r.cell, r.params.engine, r.params.mode, r.params.sources.length, r.params.residents.join('+'), det(r), r.search.n + '/' + r.params.reps, sec(r.search), sec(r.phases.spread_ms),
      Object.entries(r.per_source as Record<string, Stats>).map(([k, v]) => k + ' ' + (v.p50 === null ? '-' : (v.p50 / 1000).toFixed(2))).join(', '), r.failures ?? 0, r.gbrain_rev].join(' | ') + ' |');
  }
  const idle = rows.filter(r => r.kind === 'idle');
  if (idle.length) {
    const m = (x: Stats | undefined) => x && x.n ? x.p50 + ' / ' + x.max : '-';
    console.log('\n| cell | engine | mode | sources | residents | detection | windows | tx per 30 s p50 / max | backends p50 / max | rows read per 30 s p50 | CPU s/min per resident p50 / max | foresights |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of idle) console.log('| ' + [r.cell, r.params.engine, r.params.mode, r.params.sources.length, r.params.residents.join('+'), det(r), r.idle.windows.length, m(r.idle.tx_per_window),
      r.idle.backends_median.n ? r.idle.backends_median.p50 + ' / ' + r.idle.backends_max.max : '-', r.idle.rows_returned_per_window.p50 ?? '-',
      Object.entries(r.idle.cpu_s_per_min as Record<string, Stats>).map(([k, v]) => k + ' ' + m(v)).join(', '), r.gbrain_rev].join(' | ') + ' |');
  }
}

await main();
process.exit(0);
