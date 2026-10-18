#!/usr/bin/env bun
/**
 * #6278 managed-sync stall reproduction (plan Phase 0.2–0.5). Opt-in, never
 * run in CI. Builds the reporter's shape and records what a stuck preparation
 * is waiting on, without fixing anything.
 *
 *   bun scripts/bench/managed-sync-stall-repro.ts [--files 15000] [--history 1500] [--legacy-facts 1000]
 *     [--marker-pages 20] [--doomed-pages 12] [--drip-rows 20] [--backlog-marker-pages 20] [--rtt 57] [--pool-size 10] [--pooler pgbouncer|none]
 *     [--cli-repo <checkout>] [--max-minutes 90] [--passes 3] [--sample-seconds 30] [--adoption-interval 60]
 *     [--stall-minutes 5] [--stall-kill-minutes 15] [--stall-signal SIGUSR2] [--seed 1] [--label <name>] [--out <dir>] [--keep] [--inspect] [--inspect-port 6499]
 *     [--chaos-at <minutes>] [--chaos-toxicity 0.3] [--chaos-kind timeout|reset|lock|partition] [--chaos-stream downstream|upstream] [--chaos-for <seconds>]
 *     [--chaos-lock 'LOCK TABLE pages IN ACCESS EXCLUSIVE MODE']
 *     [--pg-port 55432] [--proxy-port 55433] [--api-port 58474] [--pooler-port 55434]
 *
 * Topology: pgvector Postgres in Docker, a transaction-mode PgBouncer in front
 * of it (startup parameters such as statement_timeout ignored, as Supavisor
 * does), toxiproxy in front of the pooler with `--rtt` ms of round trip, and
 * every gbrain process pointed at the proxy with GBRAIN_POOL_SIZE=--pool-size.
 * `--cli-repo` names the gbrain checkout under test (default: this one), so the
 * same fixture runs on a release commit and on a branch head; that checkout's
 * engine initializes the schema.
 *
 * Fixture (one git source, `bench`): `--history` pages imported in classic
 * mode before activation, then `--files` new pages committed as the backlog.
 * Seeded on the history pages, before activation:
 *   (a) `--marker-pages` entity pages whose timeline section carries two facts
 *       fences (a `repeated_marker` defect in the stored body) and legacy rows,
 *       so a fact-adoption write targets a page whose body cannot compile;
 *   (b) `--legacy-facts` unfenced fact rows (`row_num IS NULL`) spread over the
 *       other entity pages: one of the four shapes that do not round-trip
 *       through renderFactsTable → parseFactsFence (trailing whitespace, leading
 *       whitespace, whitespace-only, CRLF) on each of `--doomed-pages` pages, and
 *       round-tripping controls (pipes, newlines, backslashes, backticks, plain)
 *       everywhere, so most adoptions succeed and the doomed pages are refused
 *       on every replan. After activation the adoption loop drips `--drip-rows`
 *       more control rows before each run (the inline writer's DB-only
 *       fallback keeps producing such rows), so adoption writes keep landing
 *       mid-sync instead of only in the first minute.
 * The backlog also carries `--backlog-marker-pages` repeated-marker pages, to
 * see whether the managed screen holds a sync member before admission.
 *
 * Drive: `timeout 3600 gbrain sync --source bench --no-pull --no-embed` in a
 * non-TTY (stdout/stderr piped), re-run up to `--passes` times until synced,
 * while a second process runs `gbrain dream --phase extract_facts --source bench`
 * every `--adoption-interval` seconds so adoption writes land mid-sync. Every
 * `--sample-seconds` the sampler records, through the pooler: the running
 * requests (request_id, operation, kind, claim_phase, blocked_reason),
 * pg_stat_activity (pid, state, wait event, xact/query age, query head), the
 * queue state counts and `gbrain sources writer status --probe --json`; and from
 * the admin connection: lock waits with their blockers. `SHOW statement_timeout`
 * is read once through the pooler. Every gbrain process writes GBRAIN_SQL_TRACE,
 * so the sync process's last completed round trips are known at any moment.
 *
 * A stall is `--stall-minutes` without a new committed sync request while a
 * sync pass runs; on detection a deep capture (pg_locks, pg_stat_activity,
 * blocking pids, the sync process's last 50 trace records, writer status) goes
 * to `stall-<pass>.json`, and after `--stall-kill-minutes` of stall the pass is
 * killed (SIGTERM, the watchdog would otherwise take an hour). The report
 * (`report.json`) carries pages/min per pass, time to stall, failed receipts by
 * kind and error, holds written and the adoption outcomes (Phase 0.5).
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import postgres from '#postgres';
import { generateScaleFixture } from '../scale/fixture.ts';
import { renderFactsTable, type ParsedFact } from '../../src/core/facts-fence.ts';
import { resolveSessionTimeouts } from '../../src/core/db.ts';
import { BENCH_SQL, readTrace, round1, startHarness, type Harness, type TraceRecord } from './managed-sync-catchup-lib.ts';

const REPO = resolve(import.meta.dir, '../..');
function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const worker = flag('worker', '');
if (worker) await runWorker(worker);

const CLI_REPO = resolve(flag('cli-repo', REPO));
const CLI = join(CLI_REPO, 'src/cli.ts');
if (!existsSync(CLI)) { console.error(`--cli-repo has no src/cli.ts: ${CLI_REPO}`); process.exit(2); }
const CLI_VERSION = existsSync(join(CLI_REPO, 'VERSION')) ? readFileSync(join(CLI_REPO, 'VERSION'), 'utf8').trim() : 'unknown';
const FILES = Number(flag('files', '15000'));
const HISTORY = Number(flag('history', '1500'));
const LEGACY_FACTS = Number(flag('legacy-facts', '1000'));
const MARKER_PAGES = Number(flag('marker-pages', '20'));
const DOOMED_PAGES = Number(flag('doomed-pages', '12'));
const DRIP_ROWS = Number(flag('drip-rows', '20'));
const BACKLOG_MARKER_PAGES = Number(flag('backlog-marker-pages', '20'));
const RTT = Number(flag('rtt', '57'));
const POOL_SIZE = flag('pool-size', '10');
const POOLER = flag('pooler', 'pgbouncer');
const MAX_MS = Number(flag('max-minutes', '90')) * 60_000;
const PASSES = Number(flag('passes', '3'));
const SAMPLE_MS = Number(flag('sample-seconds', '30')) * 1000;
const ADOPTION_INTERVAL_MS = Number(flag('adoption-interval', '60')) * 1000;
const STALL_MS = Number(flag('stall-minutes', '5')) * 60_000;
const STALL_KILL_MS = Number(flag('stall-kill-minutes', '15')) * 60_000;
const SEED = Number(flag('seed', '1'));
const KEEP = process.argv.includes('--keep');
/** `--inspect`: start each sync pass with Bun's inspector on 127.0.0.1:<--inspect-port> so a stalled process can be examined in place (Runtime.evaluate). */
const INSPECT = process.argv.includes('--inspect');
const INSPECT_PORT = Number(flag('inspect-port', '6499'));
/** `--stall-signal SIGUSR2`: sent to the sync process on every sample while it is stalled; with scripts/bench/stall-debug-instrument.py applied to the checkout under test, each signal dumps the in-flight preparations to the pass's stderr. Default: no signal. */
const STALL_SIGNAL = flag('stall-signal', '');
/**
 * `--chaos-at <minutes>` (0 = off): that many minutes into pass 1, a toxiproxy toxic is added to the database proxy with
 * `--chaos-toxicity` (probability per connection, existing ones included): `timeout` (default) is a black hole, responses on
 * the affected connections never arrive and the connection stays open, as a pooler that silently drops a server-side
 * session leaves a client; `reset` closes them with a TCP reset instead. `--chaos-for <seconds>` removes the toxic again
 * after that long (0 = keep it for the rest of the run).
 */
const CHAOS_AT_MS = Number(flag('chaos-at', '0')) * 60_000;
const CHAOS_TOXICITY = Number(flag('chaos-toxicity', '0.3'));
const CHAOS_KIND = flag('chaos-kind', 'timeout');
const CHAOS_FOR_MS = Number(flag('chaos-for', '0')) * 1000;
const CHAOS_STREAM = flag('chaos-stream', 'downstream');
/** `--chaos-kind lock`: instead of a toxic, one connection through the pooler opens a transaction, runs `--chaos-lock` and holds it (a leaked or pending table lock behind a pooler that dropped statement_timeout). */
const CHAOS_LOCK = flag('chaos-lock', 'LOCK TABLE pages IN ACCESS EXCLUSIVE MODE');
/** Phase 4.1: `--chaos-repeat N` holds the lock N times (default once), `--chaos-gap <seconds>` apart, so the second hold lands on a run that already recovered once. */
const CHAOS_REPEAT = Number(flag('chaos-repeat', '1'));
const CHAOS_GAP_MS = Number(flag('chaos-gap', '300')) * 1000;
/** Phase 4.1: `--fence-repair-at <minutes>` (0 = off) runs `gbrain dream --phase fence_repair` once, that many minutes into pass 1, and records its verification block (`fence-repair.json`). */
const FENCE_REPAIR_AT_MS = Number(flag('fence-repair-at', '0')) * 60_000;
/** Phase 4.1: `--retry-held-after` runs `gbrain sources retry-held` plus the sync it prints once the passes end, and records what the held files did (`retry-held.json`). */
const RETRY_HELD_AFTER = process.argv.includes('--retry-held-after');
/**
 * #6317 (GBRA-61 Phase 0): `--scenario two-consumer` builds the reporter's two-process shape instead of the pass loop.
 * A seeding drain (`gbrain sync`, bulk lanes `--lanes`) runs `--seed-seconds` and is killed with `--seed-kill` (the
 * reporter's watchdog kill), leaving its lane groups queued; then `gbrain serve --http` and a fresh `gbrain sync` start
 * `--gap-seconds` apart in `--order` (serve-first: serve boots, claims the FIFO head, the CLI arrives later, as in the
 * reporter's timeline; cli-first: the reverse). `--cli-restart-seconds N` kills the CLI with SIGTERM every N s and
 * restarts it 10 s later (the reporter's passes were restarted after each watchdog kill). A wedge is a `preparing`
 * claim older than `--wedge-minutes` while nothing in pg_stat_activity is older than 10 s; on detection the sampler
 * writes `wedge-<n>.json`, sends `--stall-signal` to every gbrain process it started and records each dump.
 * `--seed-settle-seconds` lets the seed's claims lapse before the first consumer boots. `--serve-port` is the serve's HTTP port; `--wedge-hold-minutes` keeps a wedge alive that long before the scenario
 * ends (0 = until --max-minutes).
 */
const SCENARIO = flag('scenario', 'passes');
const LANES = flag('lanes', '6');
const SEED_S = Number(flag('seed-seconds', '90'));
const SEED_KILL = flag('seed-kill', 'SIGTERM');
/** After the seed kill, time for its claims to lapse (30 s lease) before the first consumer boots, so that consumer sweeps and claims the dead run's groups alone, as serve did in the reporter's timeline. */
const SEED_SETTLE_S = Number(flag('seed-settle-seconds', '40'));
const ORDER = flag('order', 'serve-first');
const GAP_S = Number(flag('gap-seconds', '75'));
const CLI_RESTART_S = Number(flag('cli-restart-seconds', '0'));
const SERVE_PORT = Number(flag('serve-port', '53131'));
const WEDGE_MS = Number(flag('wedge-minutes', '5')) * 60_000;
const WEDGE_HOLD_MS = Number(flag('wedge-hold-minutes', '0')) * 60_000;
/** `--direct-pool`: every scenario process also gets GBRAIN_DIRECT_DATABASE_URL (the database without the pooler), so the engine runs its dual pool (claims, followers, renewals and DDL on a 3-connection direct pool) as a Supabase deployment does. */
const DIRECT_POOL = process.argv.includes('--direct-pool');
/** `--hang-after N` (debug instrument applied): the N-th managed_sync_import preparation of the scenario's `--hang-role` process (serve | cli-sync; default any) parks forever, the reporter's wedge on demand. */
const HANG_AFTER = Number(flag('hang-after', '0'));
const HANG_ROLE = flag('hang-role', '');
if (!['passes', 'two-consumer'].includes(SCENARIO)) { console.error(`--scenario takes passes or two-consumer; got ${SCENARIO}`); process.exit(2); }
if (!['serve-first', 'cli-first'].includes(ORDER)) { console.error(`--order takes serve-first or cli-first; got ${ORDER}`); process.exit(2); }
const LABEL = flag('label', `${gitDescribe(CLI_REPO)}-pool${POOL_SIZE}-${POOLER}`).replace(/[^\w.-]/g, '_');
const OUT = resolve(flag('out', join(REPO, '.context', 'bench', `stall-repro-${LABEL}-${Date.now()}`)));
if (POOLER !== 'pgbouncer' && POOLER !== 'none') { console.error(`--pooler takes pgbouncer or none; got ${POOLER}`); process.exit(2); }
const SOURCE = 'bench';
const SYNC_ARGS = ['sync', '--source', SOURCE, '--no-pull', '--no-embed'];

function gitDescribe(repo: string): string {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim() + '@'
      + execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commitAll(root: string, message: string): string {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Bench Example', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}
const log = (msg: string) => { const line = `[stall-repro ${new Date().toISOString().slice(11, 19)}] ${msg}`; console.error(line); try { appendFileSync(join(OUT, 'log.txt'), line + '\n'); } catch { /* before OUT exists */ } };

/** Child environment: hermetic home, no ambient database URL or provider keys, the pool size under test, unprepared behind the pooler. */
function childEnv(home: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (/_API_KEY$|_API_TOKEN$|^DATABASE_URL$|^GBRAIN_DATABASE_URL$|^OPENAI_BASE_URL$/.test(key)) delete env[key];
  return { ...env, GBRAIN_HOME: home, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SKILLS_DIR: join(home, 'skills'), NO_COLOR: '1',
    GBRAIN_POOL_SIZE: POOL_SIZE, ...(POOLER === 'pgbouncer' ? { GBRAIN_PREPARE: 'false' } : {}), ...extra };
}

interface CliRun { killed: boolean; code: number; stdout: string; stderr: string; wallMs: number; json: Record<string, unknown> | null }
async function runCli(home: string, args: string[], env: Record<string, string | undefined> = {}, timeoutMs = 30 * 60_000): Promise<CliRun> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: home, env: childEnv(home, env), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let killed = false;
  const timer = setTimeout(() => { killed = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 30_000).unref(); }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  const lastJson = stdout.trim().split('\n').reverse().find(l => l.startsWith('{'));
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(stdout); } catch { try { json = lastJson ? JSON.parse(lastJson) : null; } catch { json = null; } }
  return { killed, code, stdout, stderr, wallMs: performance.now() - started, json };
}
async function mustCli(home: string, args: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> {
  const r = await runCli(home, args, env);
  if (r.code !== 0) throw new Error(`gbrain ${args.join(' ')} exited ${r.code}\nstdout: ${r.stdout.slice(-1500)}\nstderr: ${r.stderr.slice(-1500)}`);
  return r;
}

function writeConfig(home: string, url: string): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(join(home, 'skills'), { recursive: true });
  if (!existsSync(join(home, 'skills', 'RESOLVER.md'))) writeFileSync(join(home, 'skills', 'RESOLVER.md'), '# Bench fixture skills\n');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: url, self_upgrade: { mode: 'off' }, embedding_disabled: true }, null, 2) + '\n');
}

/** Schema initialization and the worker side of the fixture run inside the checkout under test. */
async function runWorker(kind: string): Promise<never> {
  const cliRepo = process.env.REPRO_CLI_REPO!;
  if (kind === 'init-schema') {
    const { PostgresEngine } = await import(join(cliRepo, 'src/core/postgres-engine.ts'));
    const engine = new PostgresEngine();
    await engine.connect({ database_url: process.env.REPRO_DB_URL!, poolSize: 2 });
    await engine.initSchema();
    await engine.disconnect();
    process.exit(0);
  }
  console.error(`unknown worker ${kind}`);
  process.exit(2);
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const fixture = generateScaleFixture({ pages: Math.max(20, 2 * (HISTORY + FILES) + 4), seed: SEED });
const defaultPages = fixture.pages.filter(p => p.sourceId === 'default');
const historyPages = defaultPages.slice(0, HISTORY);
const backlogPages = defaultPages.slice(HISTORY, HISTORY + FILES);
const isEntity = (slug: string) => slug.startsWith('people/') || slug.startsWith('companies/');

/** Two facts fences inside the timeline section: the `repeated_marker` defect the reporter saw at line 896 of a timeline. */
function withRepeatedTimelineMarker(content: string, i: number): string {
  const cut = content.indexOf('## Timeline');
  const head = cut >= 0 ? content.slice(0, cut).trimEnd() : content.trimEnd();
  const fence = (rowNum: number) => renderFactsTable([{ rowNum, claim: `Timeline fact ${rowNum} for page ${i}`, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium',
    validFrom: '2025-01-01', source: 'bench-fixture', active: true } satisfies ParsedFact]);
  return [head, '', '<!-- timeline -->', '', '## Timeline', '', `- **2025-03-0${1 + i % 9}** | Scale event ${i} recorded`, '', fence(1), '', `- **2025-04-0${1 + i % 9}** | Scale follow-up ${i}`, '', fence(2), ''].join('\n');
}

const markerHistory = new Set(historyPages.filter(p => isEntity(p.slug)).slice(0, MARKER_PAGES).map(p => p.slug));
const markerBacklog = new Set(backlogPages.slice(0, BACKLOG_MARKER_PAGES).map(p => p.slug));
function files(pages: typeof defaultPages, markers: Set<string>): Array<{ path: string; content: string }> {
  return pages.map((p, i) => ({ path: `${p.slug}.md`, content: markers.has(p.slug) ? withRepeatedTimelineMarker(p.content, i) : p.content }));
}
function writeFiles(root: string, list: Array<{ path: string; content: string }>): void {
  for (const p of list) { mkdirSync(dirname(join(root, p.path)), { recursive: true }); writeFileSync(join(root, p.path), p.content); }
}

/** Legacy claim shapes. `roundtrips: false` are the four shapes the parser normalizes and the renderer does not (plan 0.4). */
const SHAPES: Array<{ name: string; roundtrips: boolean; make: (i: number) => string }> = [
  { name: 'trailing_ws', roundtrips: false, make: i => `Legacy fact ${i} with trailing space ` },
  { name: 'leading_ws', roundtrips: false, make: i => ` Legacy fact ${i} with leading space` },
  { name: 'whitespace_only', roundtrips: false, make: () => '   ' },
  { name: 'crlf', roundtrips: false, make: i => `Legacy fact ${i} line one\r\nline two` },
  { name: 'plain', roundtrips: true, make: i => `Legacy fact ${i} plain` },
  { name: 'pipe', roundtrips: true, make: i => `Legacy fact ${i} with a | pipe` },
  { name: 'newline', roundtrips: true, make: i => `Legacy fact ${i} line one\nline two` },
  { name: 'backslash', roundtrips: true, make: i => `Legacy fact ${i} with a \\ backslash` },
  { name: 'backtick', roundtrips: true, make: i => `Legacy fact ${i} with \`code\`` },
];
interface LegacyRow { slug: string; fact: string; shape: string; roundtrips: boolean; doomedPage: boolean; markerPage: boolean }
/**
 * `--legacy-facts` rows over the history entity pages: the marker pages first
 * (controls only, so the adoption targets the stored defect), then
 * `--doomed-pages` pages carrying one failing shape each (the reporter saw nine
 * such refusals per pass) plus controls, then controls over the rest, so most
 * adoptions succeed and land as maintenance writes.
 */
function planLegacyRows(): LegacyRow[] {
  const entities = historyPages.filter(p => isEntity(p.slug)).map(p => p.slug);
  const rows: LegacyRow[] = [];
  if (!entities.length) return rows;
  const perPage = Math.max(2, Math.ceil(LEGACY_FACTS / Math.max(1, Math.min(entities.length, Math.ceil(LEGACY_FACTS / 4)))));
  const failing = SHAPES.filter(s => !s.roundtrips), controls = SHAPES.filter(s => s.roundtrips);
  const ordered = [...entities.filter(slug => markerHistory.has(slug)), ...entities.filter(slug => !markerHistory.has(slug))];
  for (let page = 0, i = 0; rows.length < LEGACY_FACTS; page++) {
    const slug = ordered[page % ordered.length]!;
    const marker = markerHistory.has(slug);
    const doomed = !marker && page >= markerHistory.size && page < markerHistory.size + DOOMED_PAGES;
    for (let k = 0; k < perPage && rows.length < LEGACY_FACTS; k++, i++) {
      const shape = doomed && k === 0 ? failing[(page - markerHistory.size) % failing.length]! : controls[i % controls.length]!;
      rows.push({ slug, fact: shape.make(i), shape: shape.name, roundtrips: shape.roundtrips, doomedPage: doomed, markerPage: marker });
    }
  }
  return rows;
}
/** Pages the drip feeds after activation: entity pages that are neither marker nor doomed pages. */
function dripPages(legacy: LegacyRow[]): string[] {
  const excluded = new Set(legacy.filter(r => r.doomedPage || r.markerPage).map(r => r.slug));
  return historyPages.filter(p => isEntity(p.slug) && !excluded.has(p.slug) && !markerHistory.has(p.slug)).map(p => p.slug);
}

// ── Run ──────────────────────────────────────────────────────────────────────

interface Row { db: string; home: string; root: string; trace: string; proxyUrl: string; directUrl: string; poolerUrl: string | null }

let harness: Harness;

async function admin<T>(url: string, fn: (sql: ReturnType<typeof postgres>) => Promise<T>, prepare = true, connection?: Record<string, string>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => {}, prepare, connect_timeout: 20, ...(connection ? { connection } : {}) });
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }).catch(() => undefined); }
}

async function setup(): Promise<{ row: Row; legacy: LegacyRow[] }> {
  const db = `gbrain_stall_${randomBytes(3).toString('hex')}`;
  await admin(harness.adminUrl, sql => sql.unsafe(`CREATE DATABASE ${db}`));
  const directUrl = harness.directUrl(db);
  const home = mkdtempSync(join(tmpdir(), 'gbrain-stall-'));
  writeConfig(home, directUrl);
  const started = performance.now();
  const init = Bun.spawnSync([process.execPath, import.meta.path, '--worker', 'init-schema'], { cwd: CLI_REPO, stdout: 'pipe', stderr: 'pipe',
    env: { ...childEnv(home), REPRO_CLI_REPO: CLI_REPO, REPRO_DB_URL: directUrl } });
  if (init.exitCode !== 0) throw new Error(`schema init in ${CLI_REPO} failed: ${init.stderr.toString().slice(-2000)}`);
  log(`schema initialized by ${CLI_REPO} (${CLI_VERSION}) in ${round1((performance.now() - started) / 1000)} s`);

  const root = join(home, `repo-${SOURCE}`);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  writeFiles(root, files(historyPages, markerHistory));
  writeFileSync(join(root, 'README.md'), '# Bench source\n');
  commitAll(root, 'history');
  await mustCli(home, ['sources', 'add', SOURCE, '--path', root, '--no-federated']);
  const classic = await mustCli(home, [...SYNC_ARGS, '--json'], { GBRAIN_SQL_TRACE_LABEL: 'setup' });
  log(`classic history sync: ${HISTORY} pages in ${round1(classic.wallMs / 1000)} s`);

  const legacy = planLegacyRows();
  await admin(directUrl, async sql => {
    for (let at = 0; at < legacy.length; at += 200) {
      const batch = legacy.slice(at, at + 200);
      await sql.unsafe(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
        SELECT $1, slug, fact, 'fact', 'private', 'medium', '2026-02-05T13:45:12Z', 'mcp:remember', 0.9 FROM unnest($2::text[], $3::text[]) AS t(slug, fact)`,
        [SOURCE, batch.map(r => r.slug), batch.map(r => r.fact)]);
    }
  });
  const pending = await admin(directUrl, async sql => Number((await sql.unsafe(`SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND row_num IS NULL AND expired_at IS NULL`, [SOURCE]))[0]!.n));
  log(`seeded ${legacy.length} legacy fact rows (${pending} pending) over ${new Set(legacy.map(r => r.slug)).size} pages; ${markerHistory.size} history + ${markerBacklog.size} backlog repeated-marker pages`);

  const state = (await mustCli(home, ['sources', 'writer', 'status', '--json'])).json!.admin_state as string;
  await mustCli(home, ['sources', 'writer', 'claim', SOURCE, '--path', root, '--admin-intent', 'writer_claim', '--expected-state', state, '--json']);
  const state2 = (await mustCli(home, ['sources', 'writer', 'status', '--json'])).json!.admin_state as string;
  const activated = await mustCli(home, ['sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', state2, '--json']);
  if (activated.json?.enabled !== true) throw new Error(`activation did not enable managed persistence: ${activated.stdout}`);
  writeFiles(root, files(backlogPages, markerBacklog));
  commitAll(root, 'backlog');
  log(`backlog committed: ${backlogPages.length} pages`);

  const proxyUrl = harness.proxyUrl(db);
  writeConfig(home, proxyUrl);
  await harness.setRtt(RTT);
  const poolerUrl = harness.pooler ? (() => { const u = new URL(harness.adminUrl); u.hostname = '127.0.0.1'; u.port = String(harness.pooler!.listen).split(':')[1]!; u.pathname = `/${db}`; return u.toString(); })() : null;
  return { row: { db, home, root, trace: join(OUT, 'sql-trace.log'), proxyUrl, directUrl, poolerUrl }, legacy };
}

const SAMPLE_SQL = {
  running: `${BENCH_SQL} SELECT request_id, operation, intent->>'kind' AS kind, intent->>'group' AS grp, claim_phase, blocked_reason, state, publication_started,
      claim_expires_at < now() AS claim_lapsed, (extract(epoch FROM now()-created_at)*1000)::int AS age_ms, (extract(epoch FROM now()-updated_at)*1000)::int AS since_update_ms
    FROM persistence_requests WHERE state IN ('running','recovering') ORDER BY sequence`,
  activity: `${BENCH_SQL} SELECT pid, state, application_name, backend_type, wait_event_type, wait_event, (extract(epoch FROM now()-xact_start)*1000)::int AS xact_age_ms,
      (extract(epoch FROM now()-query_start)*1000)::int AS query_age_ms, (extract(epoch FROM now()-state_change)*1000)::int AS state_age_ms, left(query, 200) AS query,
      pg_blocking_pids(pid) AS blocked_by
    FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() ORDER BY xact_start NULLS LAST`,
  states: `${BENCH_SQL} SELECT coalesce(intent->>'kind', operation) AS kind, state, count(*)::int AS n FROM persistence_requests GROUP BY 1,2 ORDER BY 1,2`,
  committedSync: `${BENCH_SQL} SELECT count(*)::int AS n FROM persistence_requests WHERE state='committed' AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete')`,
  failed: `${BENCH_SQL} SELECT request_id, operation, intent->>'kind' AS kind, slug, error_code, left(error_message, 240) AS error_message, blocked_reason, completed_at
    FROM persistence_requests WHERE state IN ('failed','conflict','cancelled') ORDER BY completed_at DESC NULLS LAST LIMIT 40`,
  holds: `${BENCH_SQL} SELECT op, fingerprint, completed_keys->0 AS record FROM op_checkpoints WHERE op IN ('sync-hold','sync-hold-summary') ORDER BY op, fingerprint`,
  locks: `${BENCH_SQL} SELECT w.pid, w.application_name AS waiting_app, left(w.query, 300) AS waiting_query, (extract(epoch FROM now()-w.query_start)*1000)::int AS wait_ms,
      b.pid AS blocker_pid, coalesce(b.application_name,'') AS blocker_app, coalesce(b.state,'') AS blocker_state, left(coalesce(b.query,''), 300) AS blocker_query,
      (extract(epoch FROM now()-b.xact_start)*1000)::int AS blocker_xact_ms
    FROM pg_stat_activity w CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS bp(pid) LEFT JOIN pg_stat_activity b ON b.pid = bp.pid
    WHERE w.datname = $1 AND w.wait_event_type = 'Lock'`,
};

interface SyncPass { pass: number; pid: number; inspect?: string; startedAt: number; endedAt?: number; code?: number; killedBy?: string; committedAtStart: number; committedAtEnd?: number; stallAt?: number; stallCaptured?: boolean }
interface Proc { label: string; kind: 'serve' | 'cli' | 'seed'; pid: number; startedAt: number; endedAt?: number; code?: number; killedBy?: string; exited: Promise<number>; stderrPath: string; child: ReturnType<typeof Bun.spawn> }
const state = { committed: 0, committedChangedAt: Date.now(), pass: null as SyncPass | null, samples: 0, stalls: [] as Array<Record<string, unknown>>, lastSample: null as Record<string, unknown> | null,
  procs: [] as Proc[], wedges: [] as Array<Record<string, unknown>>, wedgeSince: null as number | null, wedgeCaptured: false };
const liveProcs = () => state.procs.filter(p => p.endedAt === undefined);

function append(file: string, record: Record<string, unknown>): void { appendFileSync(join(OUT, file), JSON.stringify(record) + '\n'); }

async function sampleOnce(row: Row, deep: boolean): Promise<Record<string, unknown>> {
  const t = Date.now();
  const via = row.poolerUrl ?? row.directUrl;
  const pooled = await admin(via, async sql => ({
    running: await sql.unsafe(SAMPLE_SQL.running), activity: await sql.unsafe(SAMPLE_SQL.activity), states: await sql.unsafe(SAMPLE_SQL.states),
    committed: Number((await sql.unsafe(SAMPLE_SQL.committedSync))[0]!.n),
    ...(deep ? { failed: await sql.unsafe(SAMPLE_SQL.failed), holds: await sql.unsafe(SAMPLE_SQL.holds) } : {}),
  }), false).catch(error => ({ error: String(error instanceof Error ? error.message : error) }));
  const locks = await admin(harness.adminUrl, sql => sql.unsafe(SAMPLE_SQL.locks, [row.db])).catch(error => [{ error: String(error) }]);
  const sample: Record<string, unknown> = { t, at: new Date(t).toISOString(), pass: state.pass?.pass ?? null, sync_pid: state.pass?.pid ?? null, via: row.poolerUrl ? 'pooler' : 'direct', ...pooled, locks };
  if ('committed' in pooled && typeof pooled.committed === 'number') {
    if (pooled.committed !== state.committed) { state.committed = pooled.committed; state.committedChangedAt = t; }
    sample.committed_stale_ms = t - state.committedChangedAt;
  }
  if (deep) {
    const status = await runCli(row.home, ['sources', 'writer', 'status', '--probe', '--json'], { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'writer-status' }, 120_000);
    sample.writer_status = status.json ?? { exit: status.code, stdout: status.stdout.slice(-2000), stderr: status.stderr.slice(-2000) };
  }
  return sample;
}

/** The sync process's most recent completed round trips and the time since its last one (a renewal every 10 s is expected while it holds a claim). */
function traceTail(trace: string, pid: number | null, n = 60): Record<string, unknown> {
  if (!pid || !existsSync(trace)) return { records: [] };
  const records = readTrace(trace, r => r.pid === pid);
  const last = records.at(-1);
  const now = Date.now();
  const byClass = new Map<string, { n: number; last_t: number }>();
  for (const r of records.slice(-2000)) {
    const head = r.sql.replace(/\s+/g, ' ').slice(0, 80);
    const e = byClass.get(head) ?? { n: 0, last_t: 0 }; e.n++; e.last_t = Math.max(e.last_t, r.t); byClass.set(head, e);
  }
  return { total_round_trips: records.length, last_round_trip_age_ms: last ? now - last.t : null, in_flight_hint: 'a statement in flight is not yet in the trace; see activity[] for the backend side',
    recent_statement_classes: [...byClass.entries()].sort((a, b) => b[1].last_t - a[1].last_t).slice(0, 25).map(([sql, e]) => ({ sql, n: e.n, last_age_ms: now - e.last_t })),
    tail: records.slice(-n).map((r: TraceRecord) => ({ age_ms: now - r.t, ms: r.ms, pool: r.pool, conn: r.conn, backend: r.backend, kind: r.kind, sql: r.sql.replace(/\s+/g, ' ').slice(0, 300), ...(r.err ? { err: r.err } : {}) })) };
}

async function sampler(row: Row, stop: () => boolean): Promise<void> {
  let n = 0;
  while (!stop()) {
    const deep = n % 2 === 0;
    try {
      const sample = await sampleOnce(row, deep);
      state.lastSample = sample;
      state.samples++;
      append('samples.jsonl', sample);
      const running = Array.isArray(sample.running) ? sample.running as Array<Record<string, unknown>> : [];
      const stale = Number(sample.committed_stale_ms ?? 0);
      log(`sample ${n}: pass=${sample.pass} committed=${state.committed} stale=${Math.round(stale / 1000)}s running=${running.length}`
        + (running.length ? ` [${running.slice(0, 4).map(r => `${r.kind ?? r.operation}:${(r.claim_phase as { phase?: string } | null)?.phase ?? '?'}${r.blocked_reason ? '/' + r.blocked_reason : ''}`).join(', ')}]` : '')
        + ` activity=${Array.isArray(sample.activity) ? (sample.activity as unknown[]).length : '?'} locks=${Array.isArray(sample.locks) ? (sample.locks as unknown[]).length : '?'}`);
      if (SCENARIO === 'two-consumer') await detectWedge(row, sample);
      const pass = state.pass;
      if (pass && !pass.endedAt && stale >= STALL_MS) {
        if (!pass.stallAt) { pass.stallAt = Date.now() - stale; log(`STALL: no committed sync request for ${Math.round(stale / 1000)} s in pass ${pass.pass} (pid ${pass.pid})`); }
        if (STALL_SIGNAL) {
          try { process.kill(pass.pid, STALL_SIGNAL as NodeJS.Signals); } catch { /* gone */ }
          await Bun.sleep(1500);
          const dump = readFileSync(join(OUT, `pass-${pass.pass}.stderr`), 'utf8').split('\n').filter(l => l.startsWith('[stall-debug]')).at(-1);
          if (dump) { append('stall-debug.jsonl', { pass: pass.pass, t: Date.now(), dump: safeJson(dump.slice('[stall-debug] '.length)) }); log(`stall-debug: ${dump.slice(0, 600)}`); }
          else log('stall-debug: no dump line in the pass stderr (checkout not instrumented?)');
        }
        if (!pass.stallCaptured) {
          pass.stallCaptured = true;
          const capture: Record<string, unknown> = { ...await sampleOnce(row, true), stall_since: new Date(pass.stallAt).toISOString(), trace: traceTail(row.trace, pass.pid),
            running_detail: await admin(row.poolerUrl ?? row.directUrl, sql => sql.unsafe(`${BENCH_SQL} SELECT * FROM persistence_requests WHERE state IN ('running','recovering') ORDER BY sequence`), false).catch(e => String(e)),
            queued_head: await admin(row.poolerUrl ?? row.directUrl, sql => sql.unsafe(`${BENCH_SQL} SELECT request_id, operation, intent->>'kind' AS kind, intent->>'group' AS grp, blocked_reason, created_at FROM persistence_requests WHERE state='queued' ORDER BY sequence LIMIT 10`), false).catch(e => String(e)) };
          writeFileSync(join(OUT, `stall-${pass.pass}.json`), JSON.stringify(capture, null, 2) + '\n');
          state.stalls.push({ pass: pass.pass, stall_since: capture.stall_since, running: capture.running, activity_summary: summarizeActivity(capture.activity), locks: capture.locks,
            trace_last_round_trip_age_ms: (capture.trace as { last_round_trip_age_ms?: number }).last_round_trip_age_ms });
          log(`stall capture written: stall-${pass.pass}.json`);
        } else if (stale >= STALL_KILL_MS) {
          log(`killing pass ${pass.pass} (pid ${pass.pid}) after ${Math.round(stale / 1000)} s without progress`);
          pass.killedBy = 'stall_kill';
          try { process.kill(pass.pid, 'SIGTERM'); } catch { /* already gone */ }
          setTimeout(() => { try { process.kill(pass.pid, 'SIGKILL'); } catch { /* gone */ } }, 30_000).unref();
          // second capture 20 s later, after the TERM: does the preparation settle or hang past shutdown?
          setTimeout(() => { void sampleOnce(row, true).then(s => writeFileSync(join(OUT, `stall-${pass.pass}-after-term.json`), JSON.stringify({ ...s, trace: traceTail(row.trace, pass.pid) }, null, 2) + '\n')).catch(() => undefined); }, 20_000).unref();
        }
      }
    } catch (error) { log(`sample failed: ${error instanceof Error ? error.message : String(error)}`); }
    n++;
    const until = Date.now() + SAMPLE_MS;
    while (!stop() && Date.now() < until) await Bun.sleep(500);
  }
}

function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return text; } }

/** Phase 4.1 (G2): every `preparing` blocker the deep samples saw in writer status, and how the overdue ones were named (`claim.stall` with a step, or only `diagnostic.reason`). */
function preparingClaimsObserved(): Record<string, unknown> {
  if (!existsSync(join(OUT, 'samples.jsonl'))) return { samples: 0 };
  let observed = 0, overdue = 0, overdueWithStallStep = 0, overdueCauseUnknown = 0, overdueStallMissing = 0, maxPhaseAgeMs = 0, maxStepAgeMs = 0;
  const steps = new Map<string, number>(), waiting = new Map<string, number>(), reasons = new Map<string, number>();
  for (const line of readFileSync(join(OUT, 'samples.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    let sample: Record<string, unknown>; try { sample = JSON.parse(line); } catch { continue; }
    const blockers = ((sample.writer_status as { blockers?: Array<Record<string, unknown>> } | undefined)?.blockers) ?? [];
    for (const b of blockers) {
      const claim = b.claim as { phase?: string; phase_age_ms?: number | null; step?: string | null; step_age_ms?: number | null; waiting_on?: string; budget_ms?: number; stall?: { reason?: string; step?: string | null } | null } | undefined;
      if (!claim || claim.phase !== 'preparing' || b.state !== 'running') continue;
      observed++;
      const reason = (b.diagnostic as { reason?: string } | undefined)?.reason ?? 'none';
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      if (claim.step) steps.set(claim.step, (steps.get(claim.step) ?? 0) + 1);
      if (claim.waiting_on) waiting.set(claim.waiting_on, (waiting.get(claim.waiting_on) ?? 0) + 1);
      maxPhaseAgeMs = Math.max(maxPhaseAgeMs, Number(claim.phase_age_ms ?? 0)); maxStepAgeMs = Math.max(maxStepAgeMs, Number(claim.step_age_ms ?? 0));
      if (claim.budget_ms && Number(claim.phase_age_ms ?? 0) >= claim.budget_ms) {
        overdue++;
        if (claim.stall?.reason === 'preparation_overdue' && claim.stall.step) overdueWithStallStep++; else overdueStallMissing++;
        if (reason === 'cause_unknown') overdueCauseUnknown++;
      }
    }
  }
  return { preparing_blockers_observed: observed, overdue, overdue_with_claim_stall_and_step: overdueWithStallStep, overdue_without_claim_stall_or_step: overdueStallMissing,
    overdue_with_diagnostic_cause_unknown: overdueCauseUnknown, max_phase_age_ms: maxPhaseAgeMs, max_step_age_ms: maxStepAgeMs,
    steps: Object.fromEntries(steps), waiting_on: Object.fromEntries(waiting), diagnostic_reasons: Object.fromEntries(reasons) };
}

function summarizeActivity(activity: unknown): unknown {
  if (!Array.isArray(activity)) return activity;
  return (activity as Array<Record<string, unknown>>).map(a => `${a.pid} ${a.application_name} ${a.state} ${a.wait_event_type ?? '-'}/${a.wait_event ?? '-'} xact=${a.xact_age_ms}ms q=${a.query_age_ms}ms blocked_by=${JSON.stringify(a.blocked_by)} :: ${String(a.query).slice(0, 120)}`);
}

/** `gbrain dream --phase extract_facts` on a cadence: the fact-adoption writes that land mid-sync (and the Phase 0.5 refusals). */
async function adoptionLoop(row: Row, legacy: LegacyRow[], stop: () => boolean): Promise<void> {
  if (ADOPTION_INTERVAL_MS <= 0) return;
  const pool = dripPages(legacy);
  const controls = SHAPES.filter(s => s.roundtrips);
  for (let i = 0; !stop(); i++) {
    let dripped = 0;
    if (i > 0 && DRIP_ROWS > 0 && pool.length) {
      const pages = Math.max(1, Math.ceil(DRIP_ROWS / 4));
      const slugs = Array.from({ length: DRIP_ROWS }, (_, k) => pool[((i - 1) * pages + Math.floor(k / 4)) % pool.length]!);
      const facts = slugs.map((_, k) => controls[k % controls.length]!.make(100_000 + i * 1000 + k));
      // The managed writer guard allowlists the source for this transaction only; the seeded rows stand in for the inline writer's DB-only fallback.
      dripped = await admin(row.directUrl, sql => sql.begin(async tx => {
        await tx.unsafe(`SELECT set_config('gbrain.write_sources', $1, true)`, [JSON.stringify([SOURCE])]);
        const inserted = await tx.unsafe(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
          SELECT $1, slug, fact, 'fact', 'private', 'medium', '2026-02-05T13:45:12Z', 'mcp:remember', 0.9 FROM unnest($2::text[], $3::text[]) AS t(slug, fact) RETURNING id`, [SOURCE, slugs, facts]);
        return inserted.length;
      })).catch(error => { log(`drip failed: ${error instanceof Error ? error.message : String(error)}`); return 0; });
    }
    const r = await runCli(row.home, ['dream', '--phase', 'extract_facts', '--source', SOURCE, '--json'], { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'dream' }, 20 * 60_000);
    const phases = (r.json?.phases as Array<Record<string, unknown>> | undefined) ?? (r.json?.phase_results as Array<Record<string, unknown>> | undefined) ?? [];
    const xf = phases.find(p => p.phase === 'extract_facts') ?? null;
    const details = (xf?.details ?? {}) as Record<string, unknown>;
    const warnings = ((details.warnings as string[] | undefined) ?? (xf?.warnings as string[] | undefined) ?? []);
    const record = { i, t: Date.now(), at: new Date().toISOString(), code: r.code, wall_ms: round1(r.wallMs), dripped, status: xf?.status ?? null, summary: xf?.summary ?? null,
      unfenced_rows_fenced: details.unfencedRowsFenced ?? null, legacy_rows_pending: details.legacyRowsPending ?? null, pages_failed: details.pagesFailed ?? null,
      fence_failed: warnings.filter(w => w.startsWith('FACTS_FENCE_FAILED')).length, warnings_sample: warnings.slice(0, 12), stderr_tail: r.stderr.slice(-1200),
      ...(r.json ? xf ? {} : { json_head: JSON.stringify(r.json).slice(0, 800) } : { stdout_tail: r.stdout.slice(-1200) }) };
    append('adoption.jsonl', record);
    log(`adoption ${i}: exit=${r.code} dripped=${dripped} status=${record.status} fenced=${record.unfenced_rows_fenced} pending=${record.legacy_rows_pending} fence_failed=${record.fence_failed} ${round1(r.wallMs / 1000)}s`);
    const until = Date.now() + ADOPTION_INTERVAL_MS;
    while (!stop() && Date.now() < until) await Bun.sleep(500);
  }
}

/** Forced fault (see `--chaos-at`): a toxic on the database proxy, recorded in chaos.jsonl. */
let chaosRow: Row | null = null;
async function chaos(stop: () => boolean): Promise<void> {
  if (CHAOS_AT_MS <= 0) return;
  while (!stop() && !(state.pass && state.pass.pass === 1 && Date.now() - state.pass.startedAt >= CHAOS_AT_MS)) await Bun.sleep(1000);
  if (stop()) return;
  if (CHAOS_KIND === 'partition') {
    // #6317: the client->pooler half of every gbrain connection is dropped (iptables, never closed): statements already sent park
    // in JS while their backend waits in ClientRead for the rest of the exchange; new connections time out. The reporter's
    // Supavisor wedge, deterministically and for every connection at once; lifted after --chaos-for.
    const rule = ['OUTPUT', '-p', 'tcp', '--dport', flag('proxy-port', '55433'), '-j', 'DROP'];
    execFileSync('sudo', ['iptables', '-I', ...rule], { stdio: 'inherit' });
    append('chaos.jsonl', { t: Date.now(), at: new Date().toISOString(), action: 'partition', rule: rule.join(' '), pass: state.pass?.pass ?? null, committed: state.committed });
    log(`CHAOS: partition: iptables -I ${rule.join(' ')}${CHAOS_FOR_MS > 0 ? ` for ${CHAOS_FOR_MS / 1000} s` : ''}`);
    if (CHAOS_FOR_MS <= 0) return;
    const until = Date.now() + CHAOS_FOR_MS;
    while (!stop() && Date.now() < until) await Bun.sleep(1000);
    execFileSync('sudo', ['iptables', '-D', ...rule], { stdio: 'inherit' });
    append('chaos.jsonl', { t: Date.now(), at: new Date().toISOString(), action: 'partition_lifted', committed: state.committed });
    log('CHAOS: partition lifted');
    return;
  }
  if (CHAOS_KIND === 'lock') {
    for (let episode = 1; episode <= Math.max(1, CHAOS_REPEAT) && !stop(); episode++) {
      if (episode > 1) { const gapUntil = Date.now() + CHAOS_GAP_MS; while (!stop() && Date.now() < gapUntil) await Bun.sleep(1000); if (stop()) return; }
      const via = chaosRow!.poolerUrl ?? chaosRow!.proxyUrl;
      const sql = postgres(via, { max: 1, onnotice: () => {}, prepare: false, connect_timeout: 20 });
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const holder = sql.begin(async tx => {
        await tx.unsafe(CHAOS_LOCK);
        append('chaos.jsonl', { t: Date.now(), at: new Date().toISOString(), action: 'lock_held', episode, statement: CHAOS_LOCK, via: 'pooler', pass: state.pass?.pass ?? null, committed: state.committed });
        log(`CHAOS ${episode}/${CHAOS_REPEAT}: holding "${CHAOS_LOCK}" in an open transaction through the pooler${CHAOS_FOR_MS > 0 ? ` for ${CHAOS_FOR_MS / 1000} s` : ' for the rest of the run'}`);
        await held;
      }).catch(error => { append('chaos.jsonl', { t: Date.now(), at: new Date().toISOString(), action: 'lock_error', episode, error: String(error) }); log(`CHAOS: lock holder failed: ${error instanceof Error ? error.message : String(error)}`); });
      const until = CHAOS_FOR_MS > 0 ? Date.now() + CHAOS_FOR_MS : Infinity;
      while (!stop() && Date.now() < until) await Bun.sleep(1000);
      release();
      await holder;
      await sql.end({ timeout: 5 }).catch(() => undefined);
      append('chaos.jsonl', { t: Date.now(), at: new Date().toISOString(), action: 'lock_released', episode, pass: state.pass?.pass ?? null, committed: state.committed });
      log(`CHAOS ${episode}/${CHAOS_REPEAT}: lock released`);
    }
    return;
  }
  const api = `http://127.0.0.1:${flag('api-port', '58474')}/proxies/pg-${flag('proxy-port', '55433')}/toxics`;
  const toxic = CHAOS_KIND === 'reset'
    ? { name: 'chaos_reset', type: 'reset_peer', stream: CHAOS_STREAM, toxicity: CHAOS_TOXICITY, attributes: { timeout: 0 } }
    : { name: 'chaos_blackhole', type: 'timeout', stream: CHAOS_STREAM, toxicity: CHAOS_TOXICITY, attributes: { timeout: 0 } };
  const r = await fetch(api, { method: 'POST', body: JSON.stringify(toxic) });
  const record = { t: Date.now(), at: new Date().toISOString(), action: 'add', toxic, ok: r.ok, response: (await r.text()).slice(0, 400), pass: state.pass?.pass ?? null, committed: state.committed };
  append('chaos.jsonl', record);
  log(`CHAOS: ${toxic.type} toxic added (toxicity ${CHAOS_TOXICITY}, ${CHAOS_STREAM}) ok=${r.ok}: ${record.response.slice(0, 200)}`);
  if (CHAOS_FOR_MS <= 0) return;
  const until = Date.now() + CHAOS_FOR_MS;
  while (!stop() && Date.now() < until) await Bun.sleep(1000);
  const d = await fetch(`${api}/${toxic.name}`, { method: 'DELETE' });
  append('chaos.jsonl', { t: Date.now(), at: new Date().toISOString(), action: 'remove', name: toxic.name, ok: d.ok, committed: state.committed });
  log(`CHAOS: toxic removed ok=${d.ok}`);
}

/** Phase 4.1 (plan 4.1, G4 evidence): one `fence_repair` phase run while pass 1 is draining; its verification block is the record. */
async function fenceRepairOnce(row: Row, stop: () => boolean): Promise<void> {
  if (FENCE_REPAIR_AT_MS <= 0) return;
  while (!stop() && !(state.pass && state.pass.pass === 1 && Date.now() - state.pass.startedAt >= FENCE_REPAIR_AT_MS)) await Bun.sleep(1000);
  if (stop()) return;
  const t = Date.now();
  log('fence_repair: running gbrain dream --phase fence_repair during pass 1');
  const r = await runCli(row.home, ['dream', '--phase', 'fence_repair', '--source', SOURCE, '--json'], { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'fence-repair' }, 20 * 60_000);
  const phases = (r.json?.phases as Array<Record<string, unknown>> | undefined) ?? (r.json?.phase_results as Array<Record<string, unknown>> | undefined) ?? [];
  const phase = phases.find(p => p.phase === 'fence_repair') ?? null;
  const record = { t, at: new Date(t).toISOString(), pass: state.pass?.pass ?? null, committed_at_start: state.committed, code: r.code, wall_ms: round1(r.wallMs), phase,
    stderr_tail: r.stderr.slice(-2000), ...(r.json ? {} : { stdout_tail: r.stdout.slice(-2000) }) };
  writeFileSync(join(OUT, 'fence-repair.json'), JSON.stringify(record, null, 2) + '\n');
  log(`fence_repair: exit=${r.code} status=${phase?.status ?? '?'} ${round1(r.wallMs / 1000)}s: ${String(phase?.summary ?? '').slice(0, 300)}`);
}

/** Holds by code and reason, from the hold records themselves (the status listing is bounded). */
async function holdSummary(row: Row): Promise<Record<string, unknown>> {
  return admin(row.directUrl, async sql => {
    const rows = await sql.unsafe(`${BENCH_SQL} SELECT completed_keys->0->>'code' AS code, completed_keys->0->'meta'->>'reason' AS reason,
        completed_keys->0->'meta'->'stall'->>'step' AS step, count(*)::int AS n
      FROM op_checkpoints WHERE op='sync-hold' AND completed_keys->0->>'source_id'=$1 GROUP BY 1,2,3 ORDER BY n DESC`, [SOURCE]);
    const summary = await sql.unsafe(`${BENCH_SQL} SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op='sync-hold-summary' AND fingerprint LIKE $1`, [`${SOURCE}:%`]);
    const paths = await sql.unsafe(`${BENCH_SQL} SELECT completed_keys->0->>'path' AS path, completed_keys->0->>'code' AS code, completed_keys->0->'meta'->>'reason' AS reason
      FROM op_checkpoints WHERE op='sync-hold' AND completed_keys->0->>'source_id'=$1 ORDER BY 1 LIMIT 200`, [SOURCE]);
    return { by_code_reason: rows, summary: summary[0]?.record ?? null, paths };
  });
}

/** After each pass: `sources status --json`, `writer status --json` and the hold records, so holds and stalled receipts are known per pass. */
async function postPass(row: Row, pass: number): Promise<Record<string, unknown>> {
  const status = await runCli(row.home, ['sources', 'status', SOURCE, '--json'], { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'sources-status' }, 120_000);
  const writer = await runCli(row.home, ['sources', 'writer', 'status', '--json'], { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'writer-status' }, 120_000);
  const holds = await holdSummary(row).catch(e => ({ error: String(e) }));
  const stalled = await admin(row.directUrl, sql => sql.unsafe(`${BENCH_SQL} SELECT request_id, operation, intent->>'kind' AS kind, slug, state, error_code, blocked_reason, preparation_attempts,
      left(error_message, 300) AS error_message, completed_at FROM persistence_requests WHERE error_code='preparation_stalled' OR blocked_reason IN ('preparation_deadline','preparation_stalled') ORDER BY sequence`)).catch(e => [{ error: String(e) }]);
  const attempts = await admin(row.directUrl, sql => sql.unsafe(`${BENCH_SQL} SELECT preparation_attempts, state, count(*)::int AS n FROM persistence_requests WHERE preparation_attempts > 0 GROUP BY 1,2 ORDER BY 1,2`)).catch(e => [{ error: String(e) }]);
  const record = { pass, at: new Date().toISOString(), sources_status: status.json ?? { exit: status.code, stdout: status.stdout.slice(-3000), stderr: status.stderr.slice(-2000) },
    writer_status: writer.json ?? { exit: writer.code, stdout: writer.stdout.slice(-3000), stderr: writer.stderr.slice(-2000) }, holds, preparation_stalled_receipts: stalled, preparation_attempts: attempts };
  writeFileSync(join(OUT, `post-pass-${pass}.json`), JSON.stringify(record, null, 2) + '\n');
  const byCode = Array.isArray((holds as { by_code_reason?: unknown[] }).by_code_reason) ? (holds as { by_code_reason: Array<Record<string, unknown>> }).by_code_reason : [];
  log(`post-pass ${pass}: holds=[${byCode.map(h => `${h.code}/${h.reason ?? '-'}${h.step ? '@' + h.step : ''}:${h.n}`).join(', ')}] stalled_receipts=${Array.isArray(stalled) ? stalled.length : '?'}`);
  return { holds_by_code_reason: byCode, stalled_receipts: Array.isArray(stalled) ? stalled.length : null };
}

/** The managed drain's closing lines and the `stalled <N>s on <step>` progress lines of a pass. */
function passLines(pass: number): Record<string, unknown> {
  const stdout = readFileSync(join(OUT, `pass-${pass}.stdout`), 'utf8');
  const stderr = readFileSync(join(OUT, `pass-${pass}.stderr`), 'utf8');
  const lines = (stdout + '\n' + stderr).split('\n');
  const drain = lines.filter(l => /Managed sync (synced|resumable|blocked)|^\s*(Next|Why|Oldest unfinished request):|Oldest unfinished request/.test(l)).slice(0, 12);
  const stalled = lines.filter(l => /stalled \d+s on /.test(l));
  const steps = new Map<string, { n: number; max_s: number }>();
  for (const l of stalled) { const m = l.match(/stalled (\d+)s on (\S+)/); if (!m) continue; const e = steps.get(m[2]!) ?? { n: 0, max_s: 0 }; e.n++; e.max_s = Math.max(e.max_s, Number(m[1])); steps.set(m[2]!, e); }
  const outcome = (stdout + stderr).match(/Managed sync (synced|resumable|blocked)/)?.[1] ?? null;
  const sync_deadline_stop = /sync_deadline_stop/.test(stdout + stderr);
  return { outcome, sync_deadline_stop, drain_lines: drain, stalled_progress_lines: stalled.length, stalled_by_step: Object.fromEntries(steps), stalled_sample: stalled.slice(0, 3).concat(stalled.length > 3 ? stalled.slice(-2) : []),
    persistence_lines: lines.filter(l => l.includes('[persistence]')).slice(0, 40), restart_required: /restart_required/.test(stdout + stderr) };
}

/** Phase 4.1: what each seeded legacy row did (adopted under its id with its row number, or still pending), by shape; the drip's control rows are their own class. */
async function legacyOutcome(row: Row, legacy: LegacyRow[]): Promise<Record<string, unknown>> {
  const norm = (s: string) => s.replace(/\r\n?/g, '\n').trim();
  const byFact = new Map<string, string>(), byNorm = new Map<string, string>();
  for (const r of legacy) { byFact.set(r.fact, r.shape); if (!byNorm.has(norm(r.fact))) byNorm.set(norm(r.fact), r.shape); }
  const rows = await admin(row.directUrl, sql => sql.unsafe<Array<{ fact: string; row_num: number | null; expired_at: string | null }>>(
    `${BENCH_SQL} SELECT fact, row_num, expired_at FROM facts WHERE source_id=$1 AND source='mcp:remember'`, [SOURCE]));
  const out: Record<string, { adopted: number; pending: number; expired: number }> = {};
  for (const r of rows) {
    const shape = byFact.get(r.fact) ?? byNorm.get(norm(r.fact)) ?? (/Legacy fact 1\d{5} /.test(r.fact) ? 'drip_control' : 'unmatched');
    const e = out[shape] ?? (out[shape] = { adopted: 0, pending: 0, expired: 0 });
    if (r.expired_at) e.expired++; else if (r.row_num !== null) e.adopted++; else e.pending++;
  }
  return out;
}

/** Phase 4.1: `gbrain sources retry-held` and the sync it prints, with the holds before and after. */
async function retryHeldAfter(row: Row): Promise<Record<string, unknown>> {
  const before = await holdSummary(row).catch(e => ({ error: String(e) }));
  const retry = await runCli(row.home, ['sources', 'retry-held', SOURCE, '--json'], { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'retry-held' }, 120_000);
  const fix = (retry.json?.fix as { argv?: string[] } | undefined)?.argv ?? null;
  const argv = fix && fix[0] === 'gbrain' ? fix.slice(1) : null;
  log(`retry-held: exit=${retry.code} scheduled=${retry.json?.scheduled ?? '?'} fix=${argv ? argv.join(' ') : '(none)'}`);
  const sync = argv ? await runCli(row.home, argv, { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'retry-sync' }, 60 * 60_000) : null;
  if (sync) log(`retry-held sync: exit=${sync.code} in ${round1(sync.wallMs / 1000)} s; tail: ${(sync.stdout + sync.stderr).slice(-300).replace(/\n/g, ' | ')}`);
  const after = await holdSummary(row).catch(e => ({ error: String(e) }));
  const record = { at: new Date().toISOString(), holds_before: before, retry: retry.json ?? { exit: retry.code, stdout: retry.stdout.slice(-3000), stderr: retry.stderr.slice(-2000) }, sync_argv: argv,
    sync: sync ? { code: sync.code, wall_ms: round1(sync.wallMs), stdout_tail: sync.stdout.slice(-3000), stderr_tail: sync.stderr.slice(-3000) } : null, holds_after: after,
    committed_after: await committedCount(row) };
  writeFileSync(join(OUT, 'retry-held.json'), JSON.stringify(record, null, 2) + '\n');
  return { scheduled: retry.json?.scheduled ?? null, sync_argv: argv, sync_code: sync?.code ?? null, holds_before: (before as { by_code_reason?: unknown }).by_code_reason ?? before, holds_after: (after as { by_code_reason?: unknown }).by_code_reason ?? after };
}

async function committedCount(row: Row): Promise<number> {
  return admin(row.directUrl, async sql => Number((await sql.unsafe(SAMPLE_SQL.committedSync))[0]!.n));
}

async function syncPass(row: Row, pass: number): Promise<SyncPass> {
  const out = Bun.file(join(OUT, `pass-${pass}.stdout`)).writer();
  const err = Bun.file(join(OUT, `pass-${pass}.stderr`)).writer();
  const child = Bun.spawn(['timeout', '3600', process.execPath, ...(INSPECT ? [`--inspect=127.0.0.1:${INSPECT_PORT}`] : []), CLI, ...SYNC_ARGS], { cwd: row.home, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: childEnv(row.home, { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'cli-sync', GBRAIN_SYNC_LANES: LANES, ...(DIRECT_POOL ? { GBRAIN_DIRECT_DATABASE_URL: row.directUrl } : {}) }) });
  // `timeout` is the parent; the gbrain process is its child. Find it for the kill and trace attribution.
  await Bun.sleep(1500);
  let gbrainPid = child.pid;
  try { const kids = execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); if (kids[0]) gbrainPid = Number(kids[0]); } catch { /* keep the timeout pid */ }
  const record: SyncPass = { pass, pid: gbrainPid, startedAt: Date.now(), committedAtStart: await committedCount(row), ...(INSPECT ? { inspect: `127.0.0.1:${INSPECT_PORT}` } : {}) };
  state.pass = record;
  state.committedChangedAt = Date.now();
  log(`pass ${pass} started: timeout pid ${child.pid}, gbrain pid ${gbrainPid}`);
  const pump = async (stream: ReadableStream<Uint8Array>, sink: { write(chunk: Uint8Array): unknown; flush(): unknown; end(): unknown }) => {
    for await (const chunk of stream) { sink.write(chunk); await sink.flush(); }
    await sink.end();
  };
  const [code] = await Promise.all([child.exited, pump(child.stdout as ReadableStream<Uint8Array>, out), pump(child.stderr as ReadableStream<Uint8Array>, err)]);
  record.endedAt = Date.now();
  record.code = code;
  record.committedAtEnd = await committedCount(row);
  if (code === 124 && !record.killedBy) record.killedBy = 'timeout_3600';
  state.pass = null;
  const stderr = readFileSync(join(OUT, `pass-${pass}.stderr`), 'utf8');
  const stdout = readFileSync(join(OUT, `pass-${pass}.stdout`), 'utf8');
  log(`pass ${pass} ended: code=${code} ${record.killedBy ?? ''} committed ${record.committedAtStart} -> ${record.committedAtEnd} in ${round1((record.endedAt - record.startedAt) / 1000)} s; stderr tail: ${stderr.slice(-300).replace(/\n/g, ' | ')}`);
  append('passes.jsonl', { ...record, stdout_tail: stdout.slice(-1500), stderr_persistence_lines: stderr.split('\n').filter(l => l.includes('[persistence]')).slice(0, 40),
    stderr_tail: stderr.slice(-1500) });
  return record;
}

/** Oldest `preparing` claim (phase age from the stamp's `since`) and the oldest non-idle backend statement, both in ms. */
function wedgeSignature(sample: Record<string, unknown>): { preparing_age_ms: number; preparing: number; oldest_active_query_ms: number; idle_in_tx_ms: number; running: number } {
  const running = Array.isArray(sample.running) ? sample.running as Array<Record<string, unknown>> : [];
  const now = Date.now();
  let preparingAge = 0, preparing = 0;
  for (const r of running) {
    const phase = r.claim_phase as { phase?: string; since?: string; phase_since?: string } | null;
    if (!phase || phase.phase !== 'preparing' || r.state !== 'running') continue;
    preparing++;
    const since = Date.parse(phase.phase_since ?? phase.since ?? '');
    if (!Number.isNaN(since)) preparingAge = Math.max(preparingAge, now - since);
  }
  const activity = Array.isArray(sample.activity) ? sample.activity as Array<Record<string, unknown>> : [];
  let oldestActive = 0, idleInTx = 0;
  for (const a of activity) {
    if (a.state === 'active') oldestActive = Math.max(oldestActive, Number(a.query_age_ms ?? 0));
    if (String(a.state).startsWith('idle in transaction')) idleInTx = Math.max(idleInTx, Number(a.state_age_ms ?? 0));
  }
  return { preparing_age_ms: preparingAge, preparing, oldest_active_query_ms: oldestActive, idle_in_tx_ms: idleInTx, running: running.length };
}

/** Sends `signal` to every live gbrain process the scenario started and collects the `[stall-debug]` line each wrote. */
async function dumpAll(signal: string): Promise<Array<Record<string, unknown>>> {
  const procs = liveProcs();
  for (const p of procs) { try { process.kill(p.pid, signal as NodeJS.Signals); } catch { /* gone */ } }
  await Bun.sleep(2000);
  const dumps: Array<Record<string, unknown>> = [];
  for (const p of procs) {
    const line = existsSync(p.stderrPath) ? readFileSync(p.stderrPath, 'utf8').split('\n').filter(l => l.startsWith('[stall-debug]')).at(-1) : undefined;
    dumps.push({ label: p.label, pid: p.pid, dump: line ? safeJson(line.slice('[stall-debug] '.length)) : null });
  }
  return dumps;
}

/** #6317: the wedge rule (preparing > --wedge-minutes, nothing old at the server); one capture per episode, dumps on every sample while it lasts. */
async function detectWedge(row: Row, sample: Record<string, unknown>): Promise<void> {
  const sig = wedgeSignature(sample);
  sample.wedge_signature = sig;
  const wedged = sig.preparing_age_ms >= WEDGE_MS && sig.oldest_active_query_ms < 10_000;
  if (!wedged) { if (state.wedgeSince) log(`wedge over: preparing_age=${Math.round(sig.preparing_age_ms / 1000)}s`); state.wedgeSince = null; state.wedgeCaptured = false; return; }
  if (!state.wedgeSince) { state.wedgeSince = Date.now() - sig.preparing_age_ms; log(`WEDGE: ${sig.preparing} preparing claim(s), oldest ${Math.round(sig.preparing_age_ms / 1000)} s, oldest active statement ${sig.oldest_active_query_ms} ms, idle-in-tx ${sig.idle_in_tx_ms} ms; live procs ${liveProcs().map(p => `${p.label}:${p.pid}`).join(',')}`); }
  const dumps = STALL_SIGNAL ? await dumpAll(STALL_SIGNAL) : [];
  for (const d of dumps) { const dump = d.dump as { inflight?: Array<Record<string, unknown>>; sql_inflight?: unknown[]; pools?: unknown } | null; log(`stall-debug ${d.label}:${d.pid}: ${dump ? `inflight=${(dump.inflight ?? []).map(i => `${String(i.id).slice(0, 8)}@${i.step}/${Math.round(Number(i.step_age_ms) / 1000)}s`).join(' ')} sql_inflight=${(dump.sql_inflight ?? []).length} pools=${JSON.stringify(dump.pools ?? null).slice(0, 300)}` : 'no dump'}`); }
  if (dumps.length) append('wedge-dumps.jsonl', { t: Date.now(), at: new Date().toISOString(), wedge: state.wedges.length, dumps });
  if (state.wedgeCaptured) return;
  state.wedgeCaptured = true;
  const n = state.wedges.length + 1;
  const via = row.poolerUrl ?? row.directUrl;
  const pids = liveProcs().map(p => p.pid);
  const capture: Record<string, unknown> = { ...sample, wedge_since: new Date(state.wedgeSince).toISOString(), procs: state.procs.map(({ child: _c, exited: _e, ...p }) => p), dumps,
    running_detail: await admin(via, sql => sql.unsafe(`${BENCH_SQL} SELECT * FROM persistence_requests WHERE state IN ('running','recovering') ORDER BY sequence`), false).catch(e => String(e)),
    queued_head: await admin(via, sql => sql.unsafe(`${BENCH_SQL} SELECT request_id, operation, intent->>'kind' AS kind, intent->>'group' AS grp, intent->>'lane' AS lane, intent->>'after' AS after, blocked_reason, created_at FROM persistence_requests WHERE state='queued' ORDER BY sequence LIMIT 20`), false).catch(e => String(e)),
    cursor: await admin(via, sql => sql.unsafe(`${BENCH_SQL} SELECT fingerprint, completed_keys->0 AS cursor FROM op_checkpoints WHERE op='managed-sync'`), false).catch(e => String(e)),
    pg_locks: await admin(harness.adminUrl, sql => sql.unsafe(`${BENCH_SQL} SELECT l.locktype, l.relation::regclass::text AS relation, l.mode, l.granted, l.pid, a.application_name, a.state FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=$1 AND l.locktype IN ('relation','transactionid','tuple','advisory') ORDER BY l.pid`, [row.db])).catch(e => String(e)),
    traces: Object.fromEntries(pids.map(pid => [pid, traceTail(row.trace, pid, 40)])),
    os: { lslocks: sh('lslocks', '-n', '-o', 'PID,TYPE,MODE,PATH'), fds: Object.fromEntries(pids.map(pid => [pid, sh('sh', '-c', `ls -l /proc/${pid}/fd 2>/dev/null | grep -v socket | tail -n 30`)])),
      ps: sh('ps', '-o', 'pid,ppid,stat,%cpu,etime,cmd', '-p', pids.join(',') || '0'), children: Object.fromEntries(pids.map(pid => [pid, sh('pgrep', '-P', String(pid))])) } };
  writeFileSync(join(OUT, `wedge-${n}.json`), JSON.stringify(capture, null, 2) + '\n');
  state.wedges.push({ n, wedge_since: capture.wedge_since, signature: sig, procs: capture.procs, dumps_summary: dumps.map(d => ({ label: d.label, pid: d.pid, inflight: ((d.dump as { inflight?: unknown[] } | null)?.inflight ?? []).length })) });
  log(`wedge capture written: wedge-${n}.json`);
}

function sh(cmd: string, ...args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim(); } catch (error) { return `(${cmd} failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`; }
}

/** One gbrain process of the scenario, output to `<label>.stdout` / `<label>.stderr`; the gbrain pid is the child itself (no `timeout` wrapper). */
function spawnProc(row: Row, label: string, kind: Proc['kind'], args: string[], env: Record<string, string | undefined> = {}): Proc {
  const out = Bun.file(join(OUT, `${label}.stdout`)).writer();
  const err = Bun.file(join(OUT, `${label}.stderr`)).writer();
  const child = Bun.spawn([process.execPath, ...(INSPECT && kind !== 'seed' ? [`--inspect=127.0.0.1:${INSPECT_PORT + state.procs.length}`] : []), CLI, ...args], { cwd: row.home, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: childEnv(row.home, { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: label, GBRAIN_SYNC_LANES: LANES, ...(DIRECT_POOL ? { GBRAIN_DIRECT_DATABASE_URL: row.directUrl } : {}),
      ...(HANG_AFTER > 0 && kind !== 'seed' ? { STALL_DEBUG_HANG_KIND: 'managed_sync_import', STALL_DEBUG_HANG_AFTER: String(HANG_AFTER), ...(HANG_ROLE ? { STALL_DEBUG_HANG_ROLE: HANG_ROLE } : {}) } : {}), ...env }) });
  const pump = async (stream: ReadableStream<Uint8Array>, sink: { write(chunk: Uint8Array): unknown; flush(): unknown; end(): unknown }) => {
    for await (const chunk of stream) { sink.write(chunk); await sink.flush(); }
    await sink.end();
  };
  const proc: Proc = { label, kind, pid: child.pid, startedAt: Date.now(), stderrPath: join(OUT, `${label}.stderr`), child,
    exited: Promise.all([child.exited, pump(child.stdout as ReadableStream<Uint8Array>, out), pump(child.stderr as ReadableStream<Uint8Array>, err)]).then(([code]) => { proc.endedAt = Date.now(); proc.code = code; return code; }) };
  state.procs.push(proc);
  log(`${label} started: pid ${child.pid} (${args.join(' ')})`);
  append('procs.jsonl', { t: Date.now(), at: new Date().toISOString(), event: 'start', label, kind, pid: child.pid, args });
  void proc.exited.then(code => { append('procs.jsonl', { t: Date.now(), at: new Date().toISOString(), event: 'exit', label, pid: child.pid, code, killed_by: proc.killedBy ?? null, wall_s: round1((proc.endedAt! - proc.startedAt) / 1000) });
    log(`${label} exited: code=${code} ${proc.killedBy ?? ''} after ${round1((proc.endedAt! - proc.startedAt) / 1000)} s; stderr tail: ${readFileSync(proc.stderrPath, 'utf8').slice(-300).replace(/\n/g, ' | ')}`); });
  return proc;
}
async function killProc(proc: Proc, signal: string, why: string): Promise<number> {
  if (proc.endedAt !== undefined) return proc.code!;
  proc.killedBy = `${signal}:${why}`;
  log(`killing ${proc.label} (pid ${proc.pid}) with ${signal}: ${why}`);
  try { process.kill(proc.pid, signal as NodeJS.Signals); } catch { /* gone */ }
  const escalate = setTimeout(() => { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* gone */ } }, 30_000);
  const code = await proc.exited;
  clearTimeout(escalate);
  return code;
}
async function sleepUntil(until: number, stop: () => boolean): Promise<void> { while (!stop() && Date.now() < until) await Bun.sleep(500); }

/** #6317: the reporter's two-consumer shape (see the `--scenario two-consumer` flags). */
async function twoConsumerScenario(row: Row): Promise<void> {
  const started = Date.now();
  const stop = () => stopped || Date.now() - started >= MAX_MS;
  const syncArgs = [...SYNC_ARGS];
  // 1. seed: a lane drain that is killed mid-run, its admitted groups left queued (the reporter's killed passes).
  const seed = spawnProc(row, 'seed-sync', 'seed', syncArgs);
  state.pass = { pass: 0, pid: seed.pid, startedAt: seed.startedAt, committedAtStart: await committedCount(row) };
  await Promise.race([seed.exited, sleepUntil(seed.startedAt + SEED_S * 1000, stop)]);
  const seedCommitted = await committedCount(row);
  if (seed.endedAt === undefined) await killProc(seed, SEED_KILL, `seed window of ${SEED_S} s over`);
  state.pass = null;
  const afterSeed = await admin(row.poolerUrl ?? row.directUrl, sql => sql.unsafe(`${BENCH_SQL} SELECT state, intent->>'lane' AS lane, count(*)::int AS n, min(sequence) AS first_seq FROM persistence_requests WHERE intent->>'kind' IN ('managed_sync_import','managed_sync_delete') GROUP BY 1,2 ORDER BY 1,2`), false).catch(e => [{ error: String(e) }]);
  append('scenario.jsonl', { t: Date.now(), at: new Date().toISOString(), event: 'seeded', committed: seedCommitted, requests_by_state_and_lane: afterSeed });
  log(`seeded: ${seedCommitted} committed; requests by state/lane: ${JSON.stringify(afterSeed).slice(0, 600)}`);
  await sleepUntil(Date.now() + SEED_SETTLE_S * 1000, stop);
  if (stop()) return;
  // 2. the two consumers, --gap-seconds apart.
  const startServe = () => spawnProc(row, `serve-${state.procs.filter(p => p.kind === 'serve').length + 1}`, 'serve', ['serve', '--http', '--port', String(SERVE_PORT), '--bind', '127.0.0.1'],
    { GBRAIN_ADMIN_BOOTSTRAP_TOKEN: 'bench-admin-token-0123456789abcdefghijklmnopqrstuvwxyz' });
  let passNo = 0;
  const startCli = async () => { passNo++; const p = spawnProc(row, `cli-sync-${passNo}`, 'cli', syncArgs); state.pass = { pass: passNo, pid: p.pid, startedAt: p.startedAt, committedAtStart: await committedCount(row) }; state.committedChangedAt = Date.now(); return p; };
  let serve: Proc | null = null, cli: Proc | null = null;
  if (ORDER === 'serve-first') { serve = startServe(); await sleepUntil(Date.now() + GAP_S * 1000, stop); if (!stop()) cli = await startCli(); }
  else { cli = await startCli(); await sleepUntil(Date.now() + GAP_S * 1000, stop); if (!stop()) serve = startServe(); }
  // 3. keep the shape alive: restart the CLI on exit or on --cli-restart-seconds; end on synced, the wedge hold or --max-minutes.
  let cliRestarts = 0;
  while (!stop()) {
    await Bun.sleep(1000);
    if (serve && serve.endedAt !== undefined && Date.now() - serve.endedAt > 5000) { log(`serve exited on its own (code ${serve.code}); restarting it`); serve = startServe(); }
    if (cli && cli.endedAt !== undefined) {
      const status = readFileSync(join(OUT, `${cli.label}.stdout`), 'utf8').concat(readFileSync(cli.stderrPath, 'utf8'));
      const synced = /Managed sync synced|"sync_status"\s*:\s*"synced"/.test(status);
      const pass = state.pass as SyncPass | null;
      if (pass && pass.pid === cli.pid) { pass.endedAt = cli.endedAt; pass.code = cli.code; pass.committedAtEnd = await committedCount(row); append('passes.jsonl', { ...pass, label: cli.label, killed_by: cli.killedBy ?? null }); state.pass = null; }
      if (synced) { log('CLI reports synced; scenario ends'); append('scenario.jsonl', { t: Date.now(), at: new Date().toISOString(), event: 'synced', cli: cli.label }); break; }
      if (cliRestarts >= PASSES) { log(`CLI exited ${cliRestarts + 1} times; no more restarts (--passes ${PASSES})`); cli = null; }
      else { cliRestarts++; await sleepUntil(Date.now() + 10_000, stop); if (!stop()) cli = await startCli(); }
      continue;
    }
    if (cli && CLI_RESTART_S > 0 && Date.now() - cli.startedAt >= CLI_RESTART_S * 1000) { await killProc(cli, 'SIGTERM', `--cli-restart-seconds ${CLI_RESTART_S}`); continue; }
    if (WEDGE_HOLD_MS > 0 && state.wedgeSince && Date.now() - state.wedgeSince >= WEDGE_HOLD_MS) { log(`wedge held ${Math.round(WEDGE_HOLD_MS / 60_000)} min; scenario ends`); break; }
  }
  // 4. teardown: stop both, recording whether the stuck preparation settles when the other process dies.
  if (cli && cli.endedAt === undefined) { await killProc(cli, 'SIGTERM', 'scenario end'); await Bun.sleep(15_000); const after = await sampleOnce(row, true); writeFileSync(join(OUT, 'after-cli-exit.json'), JSON.stringify({ ...after, wedge_signature: wedgeSignature(after), dumps: STALL_SIGNAL ? await dumpAll(STALL_SIGNAL) : [] }, null, 2) + '\n'); log(`after CLI exit: ${JSON.stringify(wedgeSignature(after))} committed=${after.committed}`); }
  if (serve && serve.endedAt === undefined) await killProc(serve, 'SIGTERM', 'scenario end');
  for (const p of liveProcs()) await killProc(p, 'SIGKILL', 'scenario end');
  report.scenario = { kind: SCENARIO, direct_pool: DIRECT_POOL, hang_after: HANG_AFTER, hang_role: HANG_ROLE || null, lanes: LANES, seed_seconds: SEED_S, seed_kill: SEED_KILL, seed_settle_seconds: SEED_SETTLE_S, order: ORDER, gap_seconds: GAP_S, cli_restart_seconds: CLI_RESTART_S, serve_port: SERVE_PORT,
    wedge_minutes: WEDGE_MS / 60_000, procs: state.procs.map(({ child: _c, exited: _e, ...p }) => p), wedges: state.wedges, cli_restarts: cliRestarts };
}

function statusOf(pass: number): string | null {
  const text = readFileSync(join(OUT, `pass-${pass}.stdout`), 'utf8') + readFileSync(join(OUT, `pass-${pass}.stderr`), 'utf8');
  const m = text.match(/"sync_status"\s*:\s*"(\w+)"/) ?? text.match(/\b(synced|up to date|up_to_date|first_sync|partial|stopped)\b/i);
  return m ? m[1]!.toLowerCase() : null;
}

mkdirSync(OUT, { recursive: true });
log(`out: ${OUT}`);
log(`cli: ${CLI_REPO} (${CLI_VERSION}, ${gitDescribe(CLI_REPO)}); files=${FILES} history=${HISTORY} legacy=${LEGACY_FACTS} markers=${MARKER_PAGES}+${BACKLOG_MARKER_PAGES} rtt=${RTT} pool=${POOL_SIZE} pooler=${POOLER}`);
harness = await startHarness({ pgPort: Number(flag('pg-port', '55432')), proxyPort: Number(flag('proxy-port', '55433')), apiPort: Number(flag('api-port', '58474')),
  keep: KEEP, poolerPort: POOLER === 'pgbouncer' ? Number(flag('pooler-port', '55434')) : undefined });
const report: Record<string, unknown> = {
  schema: 'gbrain.bench.managed-sync-stall-repro/v1', label: LABEL, cli_repo: CLI_REPO, cli_version: CLI_VERSION, cli_commit: gitDescribe(CLI_REPO), harness_commit: gitDescribe(REPO),
  started_at: new Date().toISOString(),
  params: { files: FILES, history: HISTORY, legacy_facts: LEGACY_FACTS, marker_pages: MARKER_PAGES, backlog_marker_pages: BACKLOG_MARKER_PAGES, rtt_ms: RTT, pool_size: Number(POOL_SIZE), pooler: POOLER,
    doomed_pages: DOOMED_PAGES, drip_rows: DRIP_ROWS, max_minutes: MAX_MS / 60_000, passes: PASSES, sample_seconds: SAMPLE_MS / 1000, adoption_interval_s: ADOPTION_INTERVAL_MS / 1000, stall_minutes: STALL_MS / 60_000, stall_kill_minutes: STALL_KILL_MS / 60_000, seed: SEED },
  pooler: harness.pooler, host: { cpus: navigator.hardwareConcurrency, platform: process.platform, bun: Bun.version },
  rerun: `bun scripts/bench/managed-sync-stall-repro.ts ${process.argv.slice(2).join(' ')}`,
};
const save = () => writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
let row: Row | null = null;
let stopped = false;
try {
  const built = await setup();
  row = built.row;
  report.fixture = { database: row.db, home: row.home, root: row.root, backlog_entries: backlogPages.length, history_pages: historyPages.length,
    legacy_rows: built.legacy.length, legacy_pages: new Set(built.legacy.map(r => r.slug)).size,
    legacy_by_shape: Object.fromEntries(SHAPES.map(s => [s.name, built.legacy.filter(r => r.shape === s.name).length])),
    doomed_pages: new Set(built.legacy.filter(r => r.doomedPage).map(r => r.slug)).size, adoptable_pages: new Set(built.legacy.filter(r => !r.doomedPage && !r.markerPage).map(r => r.slug)).size,
    drip_pool_pages: dripPages(built.legacy).length, drip_rows_per_run: DRIP_ROWS,
    marker_history_pages: [...markerHistory], marker_backlog_pages: [...markerBacklog] };
  // The same startup parameters gbrain sends (db.ts resolveSessionTimeouts), through the pooler and directly: does the pooler keep them?
  const showTimeouts = async (sql: ReturnType<typeof postgres>) => ({
    statement_timeout: (await sql.unsafe('SHOW statement_timeout'))[0]!.statement_timeout, idle_in_transaction_session_timeout: (await sql.unsafe('SHOW idle_in_transaction_session_timeout'))[0]!.idle_in_transaction_session_timeout,
    lock_timeout: (await sql.unsafe('SHOW lock_timeout'))[0]!.lock_timeout });
  report.session_timeouts = { requested_startup_parameters: resolveSessionTimeouts(),
    via_pooler: await admin(row.poolerUrl ?? row.proxyUrl, showTimeouts, false, resolveSessionTimeouts()).catch(e => String(e)),
    direct: await admin(row.directUrl, showTimeouts, true, resolveSessionTimeouts()).catch(e => String(e)) };
  log(`session timeouts: ${JSON.stringify(report.session_timeouts)}`);
  save();
  const stop = () => stopped;
  chaosRow = row;
  const background = Promise.allSettled([sampler(row, stop), adoptionLoop(row, built.legacy, stop), chaos(stop), fenceRepairOnce(row, stop)]);
  const passes: SyncPass[] = [];
  const passExtras = new Map<number, Record<string, unknown>>();
  const started = Date.now();
  if (SCENARIO === 'two-consumer') await twoConsumerScenario(row);
  for (let pass = 1; SCENARIO === 'passes' && pass <= PASSES && Date.now() - started < MAX_MS; pass++) {
    const result = await syncPass(row, pass);
    passes.push(result);
    const status = statusOf(pass);
    log(`pass ${pass} status: ${status}`);
    passExtras.set(pass, { ...passLines(pass), ...await postPass(row, pass).catch(e => ({ post_pass_error: String(e) })) });
    report.passes = passes.map(p => ({ ...p, status: statusOf(p.pass), wall_s: p.endedAt ? round1((p.endedAt - p.startedAt) / 1000) : null,
      pages_per_min: p.endedAt && p.committedAtEnd !== undefined ? round1((p.committedAtEnd - p.committedAtStart) / ((p.endedAt - p.startedAt) / 60_000)) : null,
      time_to_stall_s: p.stallAt ? round1((p.stallAt - p.startedAt) / 1000) : null, ...passExtras.get(p.pass) }));
    save();
    if (status && ['synced', 'up_to_date', 'up to date', 'first_sync'].includes(status)) break;
    await Bun.sleep(5000);
  }
  stopped = true;
  await background;
  if (RETRY_HELD_AFTER) report.retry_held = await retryHeldAfter(row).catch(e => ({ error: String(e) }));
  const doctorFences = await runCli(row.home, ['doctor', '--only', 'fence_integrity', '--json'], { GBRAIN_SQL_TRACE: row.trace, GBRAIN_SQL_TRACE_LABEL: 'doctor' }, 10 * 60_000);
  writeFileSync(join(OUT, 'doctor-fence-integrity.json'), (doctorFences.json ? JSON.stringify(doctorFences.json, null, 2) : JSON.stringify({ exit: doctorFences.code, stdout: doctorFences.stdout, stderr: doctorFences.stderr }, null, 2)) + '\n');
  report.legacy_outcome = await legacyOutcome(row, built.legacy).catch(e => ({ error: String(e) }));
  report.fence_repair = existsSync(join(OUT, 'fence-repair.json')) ? JSON.parse(readFileSync(join(OUT, 'fence-repair.json'), 'utf8')) : null;
  const final = await sampleOnce(row, true);
  const failed = (final.failed as Array<Record<string, unknown>> | undefined) ?? [];
  const failedAll = await admin(row.directUrl, sql => sql.unsafe(`${BENCH_SQL} SELECT operation, intent->>'kind' AS kind, error_code, state,
      CASE WHEN error_message ~ 'repeated_marker' THEN 'repeated_marker' WHEN error_message ~ 'does not render its legacy fact' THEN 'adoption_roundtrip' ELSE left(error_message, 80) END AS error_class, count(*)::int AS n
    FROM persistence_requests WHERE state IN ('failed','conflict','cancelled') GROUP BY 1,2,3,4,5 ORDER BY n DESC`));
  const adoption = existsSync(join(OUT, 'adoption.jsonl')) ? readFileSync(join(OUT, 'adoption.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const chaosEvents = existsSync(join(OUT, 'chaos.jsonl')) ? readFileSync(join(OUT, 'chaos.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const stallDebug = existsSync(join(OUT, 'stall-debug.jsonl')) ? readFileSync(join(OUT, 'stall-debug.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const doctorChecks = (doctorFences.json?.checks as Array<Record<string, unknown>> | undefined) ?? [];
  const fenceCheck = doctorChecks.find(c => c.name === 'fence_integrity' || c.check === 'fence_integrity' || c.id === 'fence_integrity') ?? doctorChecks[0] ?? null;
  const unrenderable = ((fenceCheck?.details ?? fenceCheck?.data ?? fenceCheck ?? {}) as Record<string, unknown>).unrenderable_legacy_facts as { total?: number; complete?: boolean; pages?: Array<{ slug: string; rows: Array<{ class: string; reason: string }> }> } | undefined;
  report.result = { committed_sync_requests: state.committed, chaos: chaosEvents, wedges: state.wedges, stall_debug_last: stallDebug.at(-1) ?? null, backlog_entries: backlogPages.length, states: final.states, stalls: state.stalls,
    preparing_claims_observed: preparingClaimsObserved(),
    doctor_fence_integrity: { exit: doctorFences.code, status: fenceCheck?.status ?? null, unrenderable_total: unrenderable?.total ?? null, unrenderable_complete: unrenderable?.complete ?? null,
      unrenderable_by_class: Object.fromEntries([...(unrenderable?.pages ?? []).flatMap(p => p.rows).reduce((m, r) => m.set(`${r.class}/${r.reason}`, (m.get(`${r.class}/${r.reason}`) ?? 0) + 1), new Map<string, number>())]),
      unrenderable_pages: (unrenderable?.pages ?? []).length },
    failed_receipts_by_kind_and_error: failedAll, failed_receipts_recent: failed, holds: final.holds, samples: state.samples,
    adoption_runs: adoption.length, adoption_summary: adoption.map((a: Record<string, unknown>) => ({ i: a.i, status: a.status, dripped: a.dripped, fenced: a.unfenced_rows_fenced, pending: a.legacy_rows_pending, fence_failed: a.fence_failed, code: a.code })),
    legacy_pending_at_end: await admin(row.directUrl, async sql => Number((await sql.unsafe(`SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND row_num IS NULL AND expired_at IS NULL`, [SOURCE]))[0]!.n)) };
} catch (error) {
  log(`failed: ${error instanceof Error ? error.stack : String(error)}`);
  report.error = String(error instanceof Error ? error.stack : error).slice(0, 4000);
} finally {
  stopped = true;
  report.finished_at = new Date().toISOString();
  save();
  log(`report: ${join(OUT, 'report.json')}`);
  if (!KEEP && row) {
    await admin(harness.adminUrl, sql => sql.unsafe(`DROP DATABASE IF EXISTS ${row!.db} WITH (FORCE)`)).catch(() => undefined);
    rmSync(row.home, { recursive: true, force: true });
  }
  harness.stop();
}
process.exit(report.error ? 1 : 0);
