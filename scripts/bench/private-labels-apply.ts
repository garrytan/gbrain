#!/usr/bin/env bun
/**
 * gbrain repair private-labels apply throughput on a managed Git source, with a second consumer running beside it.
 * Opt-in, never run in CI.
 *
 *   bun scripts/bench/private-labels-apply.ts [--pages 1000] [--rtt 0] [--cli <path to src/cli.ts>] [--no-worker]
 *     [--label <name>] [--out <file.json>] [--database-url <admin url>] [--pg-port 55432] [--proxy-port 55433] [--api-port 58474] [--keep]
 *
 * Builds a synthetic brain on Postgres (Docker pgvector behind a toxiproxy with --rtt ms of round trip, the
 * managed-sync-catchup harness): one managed Git source whose --pages pages each carry an over-stamped access: private,
 * committed and synced. A `gbrain jobs work` process runs beside the apply, so its persistence consumer competes to
 * claim the apply's requests as a resident worker would. Then one preview of a window of every page and one
 * `--apply --expect`, timed. --cli runs another checkout's gbrain (the same binary runs the worker), so the same script
 * measures a branch before and after a change. The report has the apply's wall time and pages per minute, the gaps
 * between consecutive requests' admission, each request's admission-to-completion time, how many distinct
 * publication transactions and Git commits carried the pages, and the apply's own result counts.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import postgres from '#postgres';
import { measureRtt, pct, round1, startHarness, type Harness } from './managed-sync-catchup-lib.ts';

const REPO = resolve(import.meta.dir, '../..');
const SOURCE = 'bench';
function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const PAGES = Number(flag('pages', '1000'));
const RTT = Number(flag('rtt', '0'));
const CLI = resolve(flag('cli', join(REPO, 'src/cli.ts')));
const WORKER = !process.argv.includes('--no-worker');
const KEEP = process.argv.includes('--keep');
const describeCheckout = (root: string) => {
  try { return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
};
const CLI_COMMIT = describeCheckout(dirname(dirname(CLI)));
const LABEL = flag('label', CLI_COMMIT);
const OUT = resolve(flag('out', join(REPO, '.context', 'bench', 'private-labels-apply-' + LABEL.replace(/[^\w.-]/g, '_') + '-' + Date.now() + '.json')));
const log = (msg: string) => console.error('[private-labels-bench ' + new Date().toISOString().slice(11, 19) + '] ' + msg);
const work = mkdtempSync(join(tmpdir(), 'gbrain-private-labels-bench-'));
const created: string[] = [];
let harness: Harness;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function childEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (/_API_KEY$|_API_TOKEN$|^DATABASE_URL$|^GBRAIN_DATABASE_URL$|^OPENAI_BASE_URL$/.test(key)) delete env[key];
  return { ...env, GBRAIN_HOME: home, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SKILLS_DIR: join(home, 'skills'), GBRAIN_INTERACTIVE: '0', NO_COLOR: '1' };
}
async function cli(home: string, args: string[], okExits = [0]): Promise<{ json: any; code: number; ms: number }> {
  const start = performance.now();
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: home, env: childEnv(home), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const ms = performance.now() - start;
  if (!okExits.includes(code)) throw new Error('gbrain ' + args.join(' ') + ' exited ' + code + '\nstdout: ' + stdout.slice(-1500) + '\nstderr: ' + stderr.slice(-1500));
  let json: any = null;
  try { json = JSON.parse(stdout); } catch { /* not JSON */ }
  return { json, code, ms };
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

async function setup(): Promise<{ home: string; db: string; root: string }> {
  const db = 'gbrain_plbench_' + randomBytes(4).toString('hex');
  await admin(sql => sql.unsafe('CREATE DATABASE ' + db));
  created.push(db);
  const home = mkdtempSync(join(work, 'home-'));
  writeConfig(home, harness.directUrl(db));
  process.env.GBRAIN_HOME = home;
  const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
  const engine = new PostgresEngine();
  await engine.connect({ database_url: harness.directUrl(db), poolSize: 2 });
  await engine.initSchema();
  await engine.disconnect();
  const root = join(home, 'repo-' + SOURCE);
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, 'README.md'), '# Bench source\n');
  for (let i = 0; i < PAGES; i++) {
    writeFileSync(join(root, 'notes', 'labelled-' + String(i).padStart(5, '0') + '.md'),
      '---\ntitle: Labelled note ' + i + '\ntype: note\naccess: private\ntopic: bench\n---\nSynthetic note ' + i + ' stamped private by a writer template.\n\nA second paragraph so the page has two chunks of text, ' + i + '.\n');
  }
  git(root, 'config', 'user.name', 'Bench Example');
  git(root, 'config', 'user.email', 'bench@example.invalid');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'seed');
  // A durability-hardened checkout with no remote, so every page's Git effect commits for real (as on a brain that pushes).
  writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n');
  chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
  await cli(home, ['sources', 'add', SOURCE, '--path', root, '--no-federated']);
  await cli(home, ['sync', '--source', SOURCE, '--no-pull', '--no-embed', '--json']);
  let state = (await cli(home, ['sources', 'writer', 'status', '--json'])).json.admin_state as string;
  await cli(home, ['sources', 'writer', 'claim', SOURCE, '--path', root, '--admin-intent', 'writer_claim', '--expected-state', state, '--json']);
  state = (await cli(home, ['sources', 'writer', 'status', '--json'])).json.admin_state as string;
  const activated = (await cli(home, ['sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', state, '--json'])).json;
  if (activated?.enabled !== true) throw new Error('activation did not enable managed persistence: ' + JSON.stringify(activated));
  writeConfig(home, harness.proxyUrl(db));
  return { home, db, root };
}

harness = await startHarness({ pgPort: Number(flag('pg-port', '55432')), proxyPort: Number(flag('proxy-port', '55433')), apiPort: Number(flag('api-port', '58474')),
  adminUrl: process.argv.includes('--database-url') ? flag('database-url', '') : undefined, keep: KEEP });
const report: Record<string, unknown> = { schema: 'gbrain.bench.private-labels-apply/v1', label: LABEL, cli: CLI, cli_commit: CLI_COMMIT, started_at: new Date().toISOString(),
  params: { pages: PAGES, rtt_ms: RTT, second_consumer: WORKER ? 'gbrain jobs work' : null }, rerun: 'bun scripts/bench/private-labels-apply.ts ' + process.argv.slice(2).join(' ') };
let worker: ReturnType<typeof Bun.spawn> | null = null;
try {
  log('building a managed source with ' + PAGES + ' labelled pages');
  const brain = await setup();
  await harness.setRtt(RTT);
  report.measured_rtt_ms = round1(await measureRtt(harness.proxyUrl(brain.db)));
  if (WORKER) {
    worker = Bun.spawn([process.execPath, CLI, 'jobs', 'work'], { cwd: brain.home, env: childEnv(brain.home), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    await Bun.sleep(5000);
    if (worker.exitCode !== null) throw new Error('the second consumer (gbrain jobs work) exited ' + worker.exitCode);
  }
  const preview = await cli(brain.home, ['repair', 'private-labels', '--source', SOURCE, '--limit', String(PAGES), '--json']);
  const planned = preview.json.results[0];
  if (planned.listing?.length !== PAGES) throw new Error('the preview listed ' + planned.listing?.length + ' pages, expected ' + PAGES);
  report.preview = { ms: Math.round(preview.ms), embedding_pages: planned.cost.embedding_pages };
  const [{ seq }] = await admin(sql => sql.unsafe('SELECT COALESCE(max(sequence), 0)::text AS seq FROM persistence_requests'), brain.db) as Array<{ seq: string }>;
  const commitsBefore = Number(git(brain.root, 'rev-list', '--count', 'HEAD'));
  log('applying the window (' + PAGES + ' pages; measured RTT ' + report.measured_rtt_ms + ' ms; second consumer ' + (WORKER ? 'on' : 'off') + ')');
  const applied = await cli(brain.home, ['repair', 'private-labels', '--source', SOURCE, '--apply', '--expect', planned.preview_hash, '--json'], [0, 1]);
  const result = applied.json.results[0];
  const rows = await admin(sql => sql.unsafe(`SELECT state, extract(epoch FROM created_at) * 1000 AS created_ms, extract(epoch FROM completed_at) * 1000 AS completed_ms,
      published_at::text AS published FROM persistence_requests WHERE sequence > $1::bigint AND intent->>'kind' = 'managed_maintenance_page' ORDER BY sequence`, [seq]), brain.db) as Array<{ state: string; created_ms: number; completed_ms: number | null; published: string | null }>;
  const gaps = rows.slice(1).map((row, i) => Number(row.created_ms) - Number(rows[i]!.created_ms));
  const latency = rows.filter(row => row.completed_ms !== null).map(row => Number(row.completed_ms) - Number(row.created_ms));
  const minutes = applied.ms / 60_000;
  // Git publication runs as an effect after each request commits: wait (bounded) for it before counting commits.
  for (let waited = 0; waited < 120_000; waited += 1000) {
    const [{ open }] = await admin(sql => sql.unsafe("SELECT count(*)::int AS open FROM persistence_effects WHERE kind='git' AND state<>'committed'"), brain.db) as Array<{ open: number }>;
    if (!open) break;
    await Bun.sleep(1000);
  }
  report.apply = {
    exit: applied.code, wall_s: round1(applied.ms / 1000), pages_per_minute: round1(result.applied / minutes),
    applied: result.applied, skipped: result.skipped, failed: result.failed.length, declined: result.declined ?? null, complete: result.complete, stopped: result.stopped?.reason ?? null,
    requests: rows.length, committed: rows.filter(row => row.state === 'committed').length,
    admission_gap_ms: { p50: pct(gaps, 50), p90: pct(gaps, 90), max: pct(gaps, 100) },
    admission_to_completion_ms: { p50: pct(latency, 50), p90: pct(latency, 90), max: pct(latency, 100) },
    publication_transactions: new Set(rows.map(row => row.published).filter(Boolean)).size,
    git_commits_after_effects_settled: Number(git(brain.root, 'rev-list', '--count', 'HEAD')) - commitsBefore,
    ledger_rows: result.details?.ledger_rows ?? null,
  };
  const a = report.apply as Record<string, any>;
  log('applied ' + a.applied + ' of ' + PAGES + ' in ' + a.wall_s + ' s: ' + a.pages_per_minute + ' pages/min (exit ' + a.exit + '); admission gap p50 ' + a.admission_gap_ms.p50
    + ' ms; admission to completion p50 ' + a.admission_to_completion_ms.p50 + ' ms; ' + a.publication_transactions + ' publication transactions, ' + a.git_commits_after_effects_settled + ' Git commits');
} finally {
  worker?.kill();
  await worker?.exited;
  report.finished_at = new Date().toISOString();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  log('report: ' + OUT);
  if (!KEEP) {
    for (const datname of created) await admin(sql => sql.unsafe('DROP DATABASE IF EXISTS ' + datname + ' WITH (FORCE)')).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  }
  harness.stop();
}
process.exit(0);
