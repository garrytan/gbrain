#!/usr/bin/env bun
/**
 * Production-shaped scale soak, step 2: load a fixture.ts brain into Postgres
 * the way production got there (GBRA-174). Opt-in bench code, never run in CI.
 *
 *   bun scripts/bench/production-soak/load.ts --fixture <dir> --work <dir> [--db soak_brain] [--skip-embed] [--extract-budget-s 1200] [--managed-passes 20]
 *
 * 1. Starts the topology (lib.ts): Postgres, the session and transaction
 *    PgBouncers and toxiproxy (no latency while loading).
 * 2. Checks the default source out at its import-base tag and the other sources at HEAD,
 *    registers each with gbrain sources add and imports it with gbrain's own
 *    classic sync, then federates it.
 * 3. Writes the drift (fixture drift.jsonl) through the importer, database
 *    only: db_only pages no commit ever held, and kept_deleted pages whose
 *    files history deleted.
 * 4. Activates managed persistence (sources writer claim / activate) and runs
 *    the first managed sync of every source to its end state, then settles the
 *    mention-link pass and embeds every stale chunk through the loopback mock
 *    provider (keyless; nothing leaves the machine).
 * 5. Fast-forwards the default source to the final history, so the soak starts with the
 *    backlog a production brain carries (commits after import-base, including
 *    merges whose side branches move and delete files, and files gbrain holds).
 *
 * Writes <work>/ready.json with every phase's timing and the starting counts
 * (pages, chunks, holds, drift rows written). Reuses nothing: every run is a
 * fresh database, and a fixture loads once (managed activation leaves ownership
 * markers in its checkouts), so regenerate it for another load.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import postgres from '#postgres';
import { startMockProviders } from '../retrieval-scale/mock-providers.ts';
import { childEnv, gb, log as baseLog, now, REPO, startTopology, writeConfig, type Topology } from './lib.ts';

const argv = process.argv.slice(2);
const flag = (n: string, f?: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : f; };
const FIXTURE = resolve(flag('fixture') ?? '');
const WORK = resolve(flag('work') ?? '');
const DB = flag('db', 'soak_brain')!;
const CLI = join(resolve(flag('gbrain-root', REPO)!), 'src', 'cli.ts');
const log = (m: string) => baseLog('soak-load', m);
if (!flag('fixture') || !flag('work') || !/^[a-z0-9_]+$/.test(DB)) { console.error('usage: load.ts --fixture <dir> --work <dir> [--db name] [--skip-embed] [--extract-budget-s 1200] [--managed-passes 20]'); process.exit(2); }

interface SourceRow { id: string; repo: string; head: string; import_base: string; live_pages: number }
const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
const sources: SourceRow[] = manifest.sources;
const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

export async function syncUntilSettled(cli: string, home: string, env: Record<string, string>, source: string, label: string, maxPasses: number, extra: string[] = []) {
  const t = now();
  const passes: Array<{ status: string; ms: number; code: number }> = [];
  for (let i = 0; i < maxPasses; i++) {
    const r = await gb(cli, home, env, ['sync', '--source', source, '--no-pull', '--no-embed', '--json', ...extra], { allowFail: true });
    const status = String(r.json?.sync_status ?? r.json?.outcome ?? r.json?.status ?? 'exit_' + r.code);
    passes.push({ status, ms: Math.round(r.ms), code: r.code });
    log(label + ' pass ' + (i + 1) + ': ' + status + ' (' + Math.round(r.ms / 1000) + ' s)');
    if (['synced', 'first_sync', 'up_to_date'].includes(status)) break;
    if (r.code !== 0 && status !== 'partial' && !/blocked/.test(status)) { appendFileSync(join(WORK, 'load-errors.log'), label + '\n' + r.stdout.slice(-4000) + '\n' + r.stderr.slice(-4000) + '\n'); break; }
  }
  return { ms: Math.round(now() - t), passes };
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  const t0 = now();
  const ready: Record<string, unknown> = { fixture: { pages: manifest.pages, options: manifest.options, drift: manifest.drift }, db: DB, gbrain_rev: git(REPO, 'rev-parse', 'HEAD'), started_at: new Date().toISOString() };
  const topo: Topology = await startTopology(WORK, undefined, undefined, true);
  await topo.setRtt(0);
  const admin = postgres(topo.direct('postgres'), { max: 1, onnotice: () => {} });
  await admin.unsafe('DROP DATABASE IF EXISTS ' + DB + ' WITH (FORCE)');
  await admin.unsafe('CREATE DATABASE ' + DB);
  await admin.end();
  for (const s of sources) {
    const t = now();
    git(s.repo, 'checkout', '-q', '-f', '-B', 'master', s.id === 'default' ? 'import-base' : 'final');
    git(s.repo, 'config', 'user.name', 'Brain Writer'); git(s.repo, 'config', 'user.email', 'writer@example.invalid');
    ready['checkout_' + s.id + '_ms'] = Math.round(now() - t);
  }
  const mock = startMockProviders({ manifest: { seed: manifest.options.seed, chunks: manifest.pages * 4, pages: manifest.pages, dims: 1536 } });
  const home = join(WORK, 'home');
  writeConfig(home, topo.direct(DB), mock.url);
  const env = childEnv(home, mock.url);
  await gb(CLI, home, env, ['config', 'set', 'search.mode', 'tokenmax'], { allowFail: true });
  for (const s of sources) {
    await gb(CLI, home, env, ['sources', 'add', s.id, '--path', s.repo, '--no-federated']);
    ready['import_' + s.id] = await syncUntilSettled(CLI, home, env, s.id, 'import ' + s.id, 50);
    await gb(CLI, home, env, ['sources', 'federate', s.id, '--brain', 'host'], { allowFail: true });
  }
  ready.import_ms = Math.round(now() - t0);

  const t1 = now();
  const { PostgresEngine } = await import('../../../src/core/postgres-engine.ts');
  const { importFromContent } = await import('../../../src/core/import-file.ts');
  const { slugifyPath } = await import('../../../src/core/sync.ts');
  const engine = new PostgresEngine();
  process.env.GBRAIN_HOME = home;
  await engine.connect({ database_url: topo.direct(DB), poolSize: 4 });
  const written: Record<string, number> = {}, failed: Record<string, number> = {};
  for (const line of readFileSync(join(FIXTURE, 'drift.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line) as { kind: string; source: string; path: string; content: string };
    try {
      await importFromContent(engine, slugifyPath(row.path), row.content, { sourceId: row.source, sourcePath: row.path, noEmbed: true, filename: row.path.split('/').pop()!.replace(/\.md$/, '') });
      written[row.kind] = (written[row.kind] ?? 0) + 1;
    } catch (e) { failed[row.kind] = (failed[row.kind] ?? 0) + 1; if ((failed[row.kind] ?? 0) <= 3) log('drift ' + row.kind + ' ' + row.path + ' failed: ' + String(e).slice(0, 300)); }
  }
  await engine.disconnect();
  ready.drift = { written, failed, ms: Math.round(now() - t1) };
  log('drift written ' + JSON.stringify(written) + ' failed ' + JSON.stringify(failed));

  const t2 = now();
  let state = '';
  for (const s of sources) {
    state = (await gb(CLI, home, env, ['sources', 'writer', 'status', '--json'])).json.admin_state as string;
    await gb(CLI, home, env, ['sources', 'writer', 'claim', s.id, '--path', s.repo, '--admin-intent', 'writer_claim', '--expected-state', state, '--json']);
  }
  state = (await gb(CLI, home, env, ['sources', 'writer', 'status', '--json'])).json.admin_state as string;
  const a = await gb(CLI, home, env, ['sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', state, '--json']);
  if (a.json?.enabled !== true) throw new Error('activation did not enable managed persistence: ' + a.stdout.slice(-1500));
  ready.activate_ms = Math.round(now() - t2);
  for (const s of sources) {
    ready['first_managed_sync_' + s.id] = await syncUntilSettled(CLI, home, env, s.id, 'first managed sync ' + s.id, Number(flag('managed-passes', '20')));
    const st = await gb(CLI, home, env, ['sync', 'status', '--source', s.id, '--json'], { allowFail: true });
    ready['after_activation_' + s.id] = { state: st.json?.state ?? null, reason: st.json?.reason ?? null, holds: Array.isArray(st.json?.holds) ? st.json.holds.length : null, legacy_swept: st.json?.convergence?.counts?.legacy_swept ?? null, legacy_recorded: st.json?.convergence?.counts?.legacy_recorded ?? null };
  }

  const sql = postgres(topo.direct(DB), { max: 1, onnotice: () => {} });
  const t3 = now();
  const extractBudgetMs = Number(flag('extract-budget-s', '1200')) * 1000;
  for (const s of sources) {
    const ts = now();
    for (let i = 0; i < 30; i++) {
      const left = Math.floor(extractBudgetMs - (now() - ts));
      if (left <= 0) break;
      const r = await gb(CLI, home, env, ['extract', '--stale', '--catch-up', '--source-id', s.id, '--brain', 'host'], { allowFail: true, timeoutMs: left });
      if (r.code !== 0 || !/Actionable: [1-9]\d* page\(s\) still need|[1-9]\d* page\(s\) due for the mention pass/.test(r.stdout + r.stderr)) break;
    }
    const [x] = await sql.unsafe('SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND links_extracted_at IS NULL', [s.id]) as any[];
    ready['extract_' + s.id] = { ms: Math.round(now() - ts), capped: now() - ts >= extractBudgetMs, remaining: x?.n ?? null };
    log('extract ' + s.id + ': ' + JSON.stringify(ready['extract_' + s.id]));
  }
  ready.extract_ms = Math.round(now() - t3);
  if (!argv.includes('--skip-embed')) {
    const t4 = now();
    const passes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await gb(CLI, home, env, ['embed', '--stale', '--yes'], { allowFail: true });
      passes.push(r.code);
      log('embed --stale pass ' + (i + 1) + ' exit ' + r.code + ' (' + Math.round(r.ms / 1000) + ' s): ' + (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 300));
      if (r.code === 0) break;
    }
    ready.embed = { ms: Math.round(now() - t4), exits: passes, provider: mock.stats };
  }
  const sa = sources.find(s => s.id === 'default')!;
  git(sa.repo, 'merge', '-q', '--ff-only', 'final');
  ready.backlog_commits = Number(git(sa.repo, 'rev-list', '--count', 'import-base..HEAD'));

  await sql.unsafe('ANALYZE');
  ready.import_records = await sql.unsafe("SELECT p.source_id, count(*)::int AS pages, count(o.fingerprint)::int AS recorded FROM pages p LEFT JOIN op_checkpoints o ON o.op = 'sync-import-provenance' AND (o.completed_keys->0->>'page_id')::bigint = p.id WHERE p.deleted_at IS NULL GROUP BY 1 ORDER BY 1");
  const [c] = await sql.unsafe("SELECT (SELECT count(*) FROM pages WHERE deleted_at IS NULL)::int AS pages, (SELECT count(*) FROM content_chunks)::int AS chunks, (SELECT count(*) FROM content_chunks WHERE embedding IS NULL)::int AS unembedded, pg_database_size(current_database())::bigint AS bytes") as any[];
  await sql.end();
  mock.stop();
  ready.counts = { ...c, bytes: Number(c.bytes) };
  ready.load_s = Math.round((now() - t0) / 1000);
  writeFileSync(join(WORK, 'ready.json'), JSON.stringify(ready, null, 2));
  log('ready: ' + JSON.stringify(ready.counts) + ' in ' + ready.load_s + ' s');
}

if (import.meta.main) await main();
