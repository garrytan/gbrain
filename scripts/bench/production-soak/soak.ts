#!/usr/bin/env bun
/**
 * Production-shaped scale soak, step 3: run the production topology against a
 * load.ts brain for N hours and record every measurement (GBRA-174). Opt-in
 * bench code, never run in CI.
 *
 *   bun scripts/bench/production-soak/soak.ts --fixture <dir> --work <dir> --out <dir>
 *     [--rtt-ms 65] [--hours 2] [--commit-every-s 180] [--cli-readers 2] [--mcp-readers 2]
 *     [--read-gap-s 4] [--write-every-s 60] [--stale-every-s 600] [--status-every-s 120]
 *     [--embed-ms 0] [--rerank-ms 0] [--resident http|stdio] [--label <name>]
 *
 * Database: database_url is the transaction lane and GBRAIN_DIRECT_DATABASE_URL
 * the session lane (pool 25, a 26th client refused), both through toxiproxy at
 * --rtt-ms round trip. Processes, all from this checkout:
 *   - one resident gbrain serve (--http by default) with sync.on_commit=true, the
 *     only process that syncs;
 *   - one gbrain jobs work worker;
 *   - --mcp-readers gbrain serve stdio clients (remote callers) looping
 *     search / query / get_page / recall (warm latency), plus privacy probes
 *     that look for the fixture's private canaries;
 *   - --cli-readers loops of one-shot gbrain search / query / get (cold);
 *   - an external writer committing edits, new pages, moves, archive culls,
 *     deletes and now and then a file gbrain must hold, every --commit-every-s;
 *   - put / remember writes through the CLI and MCP every --write-every-s;
 *   - extract --stale and embed --stale every --stale-every-s;
 *   - samplers: session-lane and transaction-lane server connections each 5 s,
 *     resident RSS, sync status (holds, state, behind) each --status-every-s,
 *     and doctor --json at start, midpoint and end.
 * Freshness is commit -> keyword-searchable for every token the writer commits,
 * probed on a direct connection so the probe adds no latency.
 *
 * Writes <out>/events.jsonl (one row per measurement), <out>/logs/ and then
 * <out>/scoreboard.json + scoreboard.md (scoreboard.ts). Embedding and rerank go
 * to the loopback mock provider; nothing leaves the machine.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import postgres from '#postgres';
import { startMockProviders } from '../retrieval-scale/mock-providers.ts';
import { McpClient, spawnChild, type Child } from '../sync-freshness-lib.ts';
import { childEnv, gb, log as baseLog, now, REPO, SESSION_ROLE, sleep, startTopology, TXN_ROLE, writeConfig } from './lib.ts';
import { buildScoreboard, renderScoreboard } from './scoreboard.ts';

const argv = process.argv.slice(2);
const flag = (n: string, f: string) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1]! : f; };
const num = (n: string, f: number) => Number(flag(n, String(f)));
const FIXTURE = resolve(flag('fixture', '')), WORK = resolve(flag('work', '')), OUT = resolve(flag('out', ''));
if (!argv.includes('--fixture') || !argv.includes('--work') || !argv.includes('--out')) { console.error('usage: see the header of scripts/bench/production-soak/soak.ts'); process.exit(2); }
export const CONFIG = {
  rtt_ms: num('rtt-ms', 65), hours: num('hours', 2), commit_every_s: num('commit-every-s', 180), cli_readers: num('cli-readers', 2), mcp_readers: num('mcp-readers', 2),
  read_gap_s: num('read-gap-s', 4), write_every_s: num('write-every-s', 60), stale_every_s: num('stale-every-s', 600), status_every_s: num('status-every-s', 120),
  embed_ms: num('embed-ms', 0), rerank_ms: num('rerank-ms', 0), resident: flag('resident', 'http') as 'http' | 'stdio', label: flag('label', ''),
};
const CLI = join(REPO, 'src', 'cli.ts');
const log = (m: string) => baseLog('soak', m);
const ready = JSON.parse(readFileSync(join(WORK, 'ready.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
const DB: string = ready.db;
const HOME = join(WORK, 'home');
const WRITER_SOURCE = 'default';
const REPO_A: string = manifest.sources.find((s: { id: string }) => s.id === WRITER_SOURCE).repo;
const EVENTS = join(OUT, 'events.jsonl');
const LOGS = join(OUT, 'logs');
let deadline = 0, stopping = false, passiveScanned = 0;
const PRIVATE = new Set<string>(JSON.parse(readFileSync(join(FIXTURE, 'private-tokens.json'), 'utf8')));
/** Private tokens (canaries and private pages' search tokens) in a remote caller's response, minus the token the caller itself sent. */
export function leakedTokens(text: string, sent = ''): string[] { return [...new Set(text.match(/zq(?:pv|pg|pd)[0-9a-z]{7}/g) ?? [])].filter(t => PRIVATE.has(t) && t !== sent); }
const live = () => now() < deadline;
export function emit(kind: string, data: Record<string, unknown>): void { appendFileSync(EVENTS, JSON.stringify({ t: Math.round(now()), kind, ...data }) + '\n'); }
const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(xs: T[]): T => xs[rnd(xs.length)]!;
const git = (...args: string[]) => execFileSync('git', ['-C', REPO_A, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

interface Target { slug: string; source: string; title: string; text: string; path: string | null; token: string | null }

async function sampleTargets(directUrl: string): Promise<Target[]> {
  const sql = postgres(directUrl, { max: 1, onnotice: () => {} });
  const rows = await sql.unsafe("SELECT p.slug, p.source_id, p.title, p.source_path, left(c.chunk_text, 600) AS text FROM pages p JOIN content_chunks c ON c.page_id = p.id AND c.chunk_index = 0 WHERE p.deleted_at IS NULL AND p.frontmatter->>'visibility' IS NULL AND p.frontmatter->>'access' IS NULL AND p.frontmatter->>'confidentiality' IS NULL AND p.type <> 'chat' ORDER BY md5(p.id::text) LIMIT 1500") as Array<{ slug: string; source_id: string; title: string; source_path: string | null; text: string }>;
  await sql.end();
  return rows.map(r => ({ slug: r.slug, source: r.source_id, title: r.title, text: r.text, path: r.source_path, token: /zqpg[0-9a-z]{7}/.exec(r.text)?.[0] ?? null }));
}
function queryFor(t: Target, i: number): string {
  if (i % 5 === 0 && t.token) return t.token;
  const words = t.text.replace(/[^a-z\s]/gi, ' ').split(/\s+/).filter(w => w.length > 3);
  const k = 2 + (i % 3), at = (i * 7919) % Math.max(1, words.length - k);
  const titleWord = t.title.split(/\s+/).find(w => w.length > 3);
  return [...(i % 2 === 0 && titleWord ? [titleWord.toLowerCase()] : []), ...words.slice(at, at + k)].join(' ') || t.title;
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(LOGS, { recursive: true });
  const topo = await startTopology(WORK, undefined, undefined, true);
  await topo.setRtt(0);
  const directUrl = topo.direct(DB);
  const targets = await sampleTargets(directUrl);
  const mock = startMockProviders({ manifest: { seed: manifest.options.seed, chunks: manifest.pages * 4, pages: manifest.pages, dims: 1536 }, embedMs: CONFIG.embed_ms, rerankMs: CONFIG.rerank_ms });
  writeConfig(HOME, topo.txn(DB), mock.url);
  const env = childEnv(HOME, mock.url, { GBRAIN_DIRECT_DATABASE_URL: topo.session(DB) });
  await gb(CLI, HOME, env, ['config', 'set', 'sync.on_commit', 'true']);
  await topo.setRtt(CONFIG.rtt_ms);
  const startedAt = now();
  deadline = startedAt + CONFIG.hours * 3600_000;
  emit('start', { config: CONFIG, ready: { counts: ready.counts, backlog_commits: ready.backlog_commits, drift: ready.drift, fixture: ready.fixture }, gbrain_rev: execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    version: (await gb(CLI, HOME, env, ['--version'], { allowFail: true })).stdout.trim(), targets: targets.length, canaries: manifest.privacy.canaries.length });
  log('soak ' + CONFIG.hours + ' h at ' + CONFIG.rtt_ms + ' ms RTT on ' + ready.counts?.pages + ' pages (' + ready.backlog_commits + ' backlog commits)');

  const residents: Record<string, Child> = {};
  const port = 3131 + rnd(500);
  residents.serve = spawnChild([process.execPath, CLI, 'serve', ...(CONFIG.resident === 'http' ? ['--http', '--bind', '127.0.0.1', '--port', String(port)] : [])], { cwd: HOME, env, logFile: join(LOGS, 'serve.log'), stdin: true });
  const owned = await waitForLine(residents.serve, /owner of this host's notifier/, 180_000);
  emit('notifier_owner', { name: 'serve', owned, wait_ms: Math.round(now() - startedAt) });
  if (!owned) log('resident serve did not take the notifier within 180 s; continuing (the scoreboard records it)');
  residents.worker = spawnChild([process.execPath, CLI, 'jobs', 'work'], { cwd: HOME, env, logFile: join(LOGS, 'worker.log') });
  for (const [name, c] of Object.entries(residents)) void c.exited.then(code => { if (stopping) return; emit('resident_exit', { name, code, at_s: Math.round((now() - startedAt) / 1000) }); log(name + ' exited ' + code); });

  const tasks: Promise<unknown>[] = [];
  tasks.push(doctorAt(env, startedAt, [0, 0.5]));
  tasks.push(sampler(directUrl, residents, startedAt));
  tasks.push(statusLoop(env, directUrl, startedAt));
  tasks.push(writerLoop(directUrl, startedAt));
  for (let r = 0; r < CONFIG.cli_readers; r++) tasks.push(cliReader(env, targets, r));
  for (let r = 0; r < CONFIG.mcp_readers; r++) tasks.push(mcpReader(env, targets, r));
  tasks.push(writeLoop(env, targets));
  tasks.push(staleLoop(env));
  await Promise.allSettled(tasks);

  await doctorOnce(env, startedAt, 'end');
  const refused = topo.refusals();
  const logHits = grepLogs(/EMAXCONNSESSION|no more connections allowed|max_client_conn|remaining connection slots|too many clients/i);
  emit('sync_jobs', syncJobs());
  emit('end', { refused, log_hits: logHits, elapsed_s: Math.round((now() - startedAt) / 1000), provider: mock.stats, privacy_passive_scanned: passiveScanned });
  stopping = true;
  for (const c of Object.values(residents)) c.kill('SIGTERM');
  await Promise.race([Promise.all(Object.values(residents).map(c => c.exited)), sleep(15_000)]);
  for (const c of Object.values(residents)) c.kill('SIGKILL');
  mock.stop();
  await topo.setRtt(0);
  const board = buildScoreboard(readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
  writeFileSync(join(OUT, 'scoreboard.json'), JSON.stringify(board, null, 2));
  writeFileSync(join(OUT, 'scoreboard.md'), renderScoreboard(board));
  console.log(renderScoreboard(board));
  process.exit(0);
}

function waitForLine(c: Child, re: RegExp, ms: number): Promise<boolean> {
  if (c.lines.some(l => re.test(l.text))) return Promise.resolve(true);
  return new Promise(resolve => { const t = setTimeout(() => resolve(false), ms); c.onLine(l => { if (re.test(l.text)) { clearTimeout(t); resolve(true); } }); });
}

/** Every managed sync job any process ran (its done line) and every notifier ownership change, from the process logs. */
function syncJobs(): Record<string, unknown> {
  const jobs: Array<{ log: string; status: string; added: number; modified: number; deleted: number; s: number }> = [];
  const owners: Array<{ log: string; at: string }> = [];
  for (const f of readdirSync(LOGS)) {
    if (!f.endsWith('.log')) continue;
    for (const l of readFileSync(join(LOGS, f), 'utf8').split('\n')) {
      const m = /\[serve-sync\] done job=\S+ status=(\S+) added=(\d+) modified=(\d+) deleted=(\d+).* in=(\d+)s/.exec(l);
      if (m) jobs.push({ log: f, status: m[1]!, added: +m[2]!, modified: +m[3]!, deleted: +m[4]!, s: +m[5]! });
      if (/owner of this host's notifier/.test(l)) owners.push({ log: f, at: l.slice(0, 24) });
    }
  }
  return { jobs: jobs.length, by_status: jobs.reduce<Record<string, number>>((o, j) => { o[j.status] = (o[j.status] ?? 0) + 1; return o; }, {}),
    zero_progress: jobs.filter(j => j.added + j.modified + j.deleted === 0 && !['synced', 'up_to_date', 'first_sync'].includes(j.status)).length, max_s: jobs.length ? Math.max(...jobs.map(j => j.s)) : null,
    applied: jobs.reduce((a, j) => a + j.added + j.modified + j.deleted, 0), notifier_owners: owners };
}

function grepLogs(re: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of readdirSync(LOGS)) { const n = readFileSync(join(LOGS, f), 'utf8').split('\n').filter(l => re.test(l)).length; if (n) out[f] = n; }
  return out;
}

async function doctorOnce(env: Record<string, string>, startedAt: number, at: string): Promise<void> {
  const r = await gb(CLI, HOME, env, ['doctor', '--json'], { allowFail: true, timeoutMs: 20 * 60_000 });
  writeFileSync(join(LOGS, 'doctor-' + at + '.json'), r.stdout);
  const checks: Array<{ name: string; status: string; message?: string; details?: { reason?: string } }> = r.json?.checks ?? [];
  const unfinished = (c: typeof checks[number]) => c.details?.reason === 'budget' || ['skipped', 'timeout', 'unfinished'].includes(String(c.status));
  emit('doctor', { at, at_s: Math.round((now() - startedAt) / 1000), ms: Math.round(r.ms), code: r.code, health_score: r.json?.health_score ?? r.json?.score ?? null, status: r.json?.status ?? null,
    red: checks.filter(c => ['fail', 'error', 'red'].includes(String(c.status)) && !unfinished(c)).map(c => ({ name: c.name, message: String(c.message ?? '').slice(0, 300) })),
    warn: checks.filter(c => ['warn', 'yellow'].includes(String(c.status)) && !unfinished(c)).map(c => c.name), unfinished: checks.filter(unfinished).map(c => c.name), total: checks.length });
}
async function doctorAt(env: Record<string, string>, startedAt: number, fractions: number[]): Promise<void> {
  for (const f of fractions) {
    const at = startedAt + f * CONFIG.hours * 3600_000;
    while (now() < at && live()) await sleep(5000);
    if (!live()) return;
    await doctorOnce(env, startedAt, f === 0 ? 'start' : 'mid');
  }
}

/** /proc RSS of a process and its live descendants, in MiB, plus the process's own peak (VmHWM). */
function rssTree(pid: number): { rss_mb: number; hwm_mb: number } {
  const kids = new Map<number, number[]>();
  const rss = new Map<number, number>();
  let hwm = 0;
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync('/proc/' + name + '/status', 'utf8');
      const ppid = Number(/PPid:\s+(\d+)/.exec(status)?.[1]);
      rss.set(Number(name), Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0));
      if (Number(name) === pid) hwm = Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0);
      kids.set(ppid, [...(kids.get(ppid) ?? []), Number(name)]);
    } catch { /* exited */ }
  }
  let total = 0;
  for (const q = [pid]; q.length;) { const p = q.pop()!; total += rss.get(p) ?? 0; q.push(...(kids.get(p) ?? [])); }
  return { rss_mb: Math.round(total / 1024), hwm_mb: Math.round(hwm / 1024) };
}

async function sampler(directUrl: string, residents: Record<string, Child>, startedAt: number): Promise<void> {
  const sql = postgres(directUrl, { max: 1, onnotice: () => {} });
  while (live()) {
    try {
      const rows = await sql.unsafe("SELECT usename, state, count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 GROUP BY 1, 2", [DB]) as Array<{ usename: string; state: string | null; n: number }>;
      const sum = (u: string, active?: boolean) => rows.filter(r => r.usename === u && (active === undefined || (r.state === 'active' || r.state === 'idle in transaction') === active)).reduce((a, r) => a + r.n, 0);
      const mem = Object.fromEntries(Object.entries(residents).map(([k, c]) => [k, c.exitAt === null ? rssTree(c.proc.pid) : null]));
      emit('sample', { at_s: Math.round((now() - startedAt) / 1000), session: sum(SESSION_ROLE), session_active: sum(SESSION_ROLE, true), txn: sum(TXN_ROLE), txn_active: sum(TXN_ROLE, true), backends: rows.reduce((a, r) => a + r.n, 0), mem });
    } catch (e) { emit('sample_error', { error: String(e).slice(0, 200) }); }
    await sleep(5000);
  }
  await sql.end();
}

async function statusLoop(env: Record<string, string>, directUrl: string, startedAt: number): Promise<void> {
  const sql = postgres(directUrl, { max: 1, onnotice: () => {} });
  while (live()) {
    const r = await gb(CLI, HOME, env, ['sync', 'status', '--source', WRITER_SOURCE, '--json'], { allowFail: true, timeoutMs: 10 * 60_000 });
    const j = r.json ?? {};
    const holds: Array<{ code: string }> = Array.isArray(j.holds) ? j.holds : [];
    const codes: Record<string, number> = {};
    for (const h of holds) codes[h.code] = (codes[h.code] ?? 0) + 1;
    const src = await sql.unsafe('SELECT id, last_commit, last_sync_at FROM sources ORDER BY id').catch(() => []) as Array<{ id: string; last_commit: string | null; last_sync_at: Date | null }>;
    let head = '';
    try { head = git('rev-parse', 'HEAD'); } catch { /* writer mid-commit */ }
    const a = src.find(s => s.id === WRITER_SOURCE);
    const coverage = await sql.unsafe("SELECT p.source_id, count(*)::int AS pages, count(o.fingerprint)::int AS recorded FROM pages p LEFT JOIN op_checkpoints o ON o.op = 'sync-import-provenance' AND (o.completed_keys->0->>'page_id')::bigint = p.id WHERE p.deleted_at IS NULL GROUP BY 1 ORDER BY 1").catch(() => []) as Array<{ source_id: string; pages: number; recorded: number }>;
    emit('status', { at_s: Math.round((now() - startedAt) / 1000), ms: Math.round(r.ms), code: r.code, state: j.state ?? null, reason: j.reason ?? null, holds: holds.length, hold_codes: codes,
      needs_human: j.needs_human ?? null, behind_commits: j.freshness?.behind?.commits ?? null, behind_oldest_s: j.freshness?.behind?.oldest_seconds ?? null,
      gbrain_c2s_p50_s: j.freshness?.commit_to_searchable?.p50_seconds ?? null, gbrain_c2s_p95_s: j.freshness?.commit_to_searchable?.p95_seconds ?? null,
      notifier_state: j.notifier?.state ?? null, notifier_stalled: j.notifier?.stalled ?? null, last_error: j.last_error ? JSON.stringify(j.last_error).slice(0, 300) : null,
      import_records: Object.fromEntries(coverage.map(c => [c.source_id, { pages: c.pages, recorded: c.recorded }])), legacy_swept: j.convergence?.counts?.legacy_swept ?? null,
      head, last_commit: a?.last_commit ?? null, last_sync_at: a?.last_sync_at ? new Date(a.last_sync_at).toISOString() : null,
      sources: src.map(s => ({ id: s.id, last_commit: s.last_commit, last_sync_at: s.last_sync_at ? new Date(s.last_sync_at).toISOString() : null })) });
    const until = now() + CONFIG.status_every_s * 1000;
    while (live() && now() < until) await sleep(2000);
  }
  await sql.end();
}

/** External writer: named-path commits to the default source's checkout, like an agent editing files plus a librarian committing them. */
async function writerLoop(directUrl: string, startedAt: number): Promise<void> {
  const { PostgresEngine } = await import('../../../src/core/postgres-engine.ts');
  const engine = new PostgresEngine();
  await engine.connect({ database_url: directUrl, poolSize: 2 });
  const sql = postgres(directUrl, { max: 1, onnotice: () => {} });
  const paths = (await sql.unsafe("SELECT source_path FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND source_path IS NOT NULL AND type NOT IN ('chat') AND source_path NOT LIKE 'archive/%' ORDER BY md5(id::text) LIMIT 4000", [WRITER_SOURCE]) as Array<{ source_path: string }>)
    .map(r => r.source_path).filter(p => existsSync(join(REPO_A, p)));
  await sql.end();
  const pending: Array<{ n: number; sha: string; token: string; t_commit: number; expect: number; files: number; problem: boolean; first?: number }> = [];
  let n = 0;
  const probe = (async () => {
    while (live() || pending.length) {
      for (const c of [...pending]) {
        const hits = await engine.searchKeyword(c.token, { limit: 100, sourceId: WRITER_SOURCE }).catch(() => []) as Array<{ slug: string }>;
        const found = new Set(hits.map(h => h.slug)).size;
        if (found > 0 && c.first === undefined) c.first = now();
        if (found >= c.expect) {
          emit('freshness', { n: c.n, sha: c.sha, lag_ms: Math.round(now() - c.t_commit), first_ms: Math.round((c.first ?? now()) - c.t_commit), files: c.files, problem: c.problem, at_s: Math.round((c.t_commit - startedAt) / 1000) });
          pending.splice(pending.indexOf(c), 1);
        }
      }
      if (!live() && pending.length) { for (const c of pending) emit('freshness_unresolved', { n: c.n, sha: c.sha, age_ms: Math.round(now() - c.t_commit), first_ms: c.first === undefined ? null : Math.round(c.first - c.t_commit), files: c.files, at_s: Math.round((c.t_commit - startedAt) / 1000) }); break; }
      await sleep(2000);
    }
  })();
  while (live()) {
    n++;
    const token = 'zqfr' + n.toString(36).padStart(3, '0') + Math.random().toString(36).slice(2, 8);
    const touched: string[] = [], removed: string[] = [];
    let expect = 0;
    const edits = 5 + rnd(16);
    for (let k = 0; k < edits && paths.length; k++) {
      const p = pick(paths);
      if (touched.includes(p) || !existsSync(join(REPO_A, p))) continue;
      appendFileSync(join(REPO_A, p), '\nEdited in soak commit ' + n + ': ' + token + ' follow-up on the plan.\n');
      touched.push(p); expect++;
    }
    for (let k = 0; k < 1 + rnd(3); k++) {
      const p = 'notes/inbox/soak-' + token + '-' + k + '.md';
      mkdirSync(dirname(join(REPO_A, p)), { recursive: true });
      writeFileSync(join(REPO_A, p), '---\ntitle: "Soak note ' + n + '-' + k + '"\ntype: note\n---\n# Soak note ' + n + '-' + k + '\n\nNew note ' + token + ' written during the soak.\n');
      touched.push(p); paths.push(p); expect++;
    }
    const move = (to: (p: string) => string) => { const p = pick(paths); if (!existsSync(join(REPO_A, p)) || touched.includes(p)) return; const dest = to(p); mkdirSync(dirname(join(REPO_A, dest)), { recursive: true }); try { git('mv', p, dest); removed.push(p); touched.push(dest); paths.splice(paths.indexOf(p), 1, dest); } catch { /* raced */ } };
    if (n % 3 === 0) move(p => p.replace(/^notes\/[^/]+\//, 'notes/ops/').replace(/^(?!notes\/)/, 'moved/'));
    if (n % 5 === 0) move(p => 'archive/2026/' + p);
    if (n % 4 === 0) { const p = pick(paths); if (existsSync(join(REPO_A, p)) && !touched.includes(p)) { try { git('rm', '-q', p); removed.push(p); paths.splice(paths.indexOf(p), 1); } catch { /* raced */ } } }
    const problem = n % 10 === 0;
    if (problem) { const p = 'notes/inbox/soak-broken-' + token + '.md'; writeFileSync(join(REPO_A, p), '---\ntitle: "unterminated ' + token + '\ntype: note\n---\n# Broken\n'); touched.push(p); }
    const t0 = now();
    let sha = '', err = '';
    for (let attempt = 0; attempt < 10 && !sha; attempt++) {
      try {
        git('add', '-A', '--', ...touched.filter(p => existsSync(join(REPO_A, p))));
        git('commit', '-q', '-m', 'soak writer ' + n + ' ' + token);
        sha = git('rev-parse', 'HEAD');
      } catch (e) { err = String(e).slice(0, 300); await sleep(2000); }
    }
    if (!sha) { emit('writer_error', { n, error: err }); continue; }
    const t_commit = now();
    pending.push({ n, sha, token, t_commit, expect, files: touched.length + removed.length, problem });
    emit('commit', { n, sha, files: touched.length + removed.length, edits: expect, removed: removed.length, problem, commit_ms: Math.round(t_commit - t0), at_s: Math.round((t_commit - startedAt) / 1000) });
    const until = now() + CONFIG.commit_every_s * 1000;
    while (live() && now() < until) await sleep(1000);
  }
  await probe;
  await engine.disconnect();
}

async function cliReader(env: Record<string, string>, targets: Target[], r: number): Promise<void> {
  let i = r * 1000;
  while (live()) {
    const t = targets[i % targets.length]!;
    const op = ['search', 'query', 'get', 'search', 'query'][i % 5]!;
    const args = op === 'get' ? ['get', t.slug, '--source', t.source] : [op, queryFor(t, i), '--json'];
    const res = await gb(CLI, HOME, env, args, { allowFail: true, timeoutMs: 120_000 });
    emit('read', { surface: 'cli', mode: 'cold', op, ms: Math.round(res.ms), ok: res.code === 0, code: res.code, err: res.code === 0 ? undefined : (res.stderr || res.stdout).trim().split('\n').slice(-1)[0]?.slice(0, 200) });
    i++;
    await sleep(CONFIG.read_gap_s * 1000);
  }
}

/** A stdio MCP client; only its stderr is logged (stdout carries every response). */
function mcpChild(env: Record<string, string>, name: string): { child: Child; client: McpClient } {
  const child = spawnChild([process.execPath, CLI, 'serve'], { cwd: HOME, env, stdin: true });
  child.onLine(l => { if (l.stream === 'err') appendFileSync(join(LOGS, name + '.log'), new Date(l.t).toISOString() + ' err ' + l.text + '\n'); });
  return { child, client: new McpClient(child) };
}

async function mcpReader(env: Record<string, string>, targets: Target[], r: number): Promise<void> {
  const { child, client } = mcpChild(env, 'mcp-reader-' + r);
  try { await client.init(); } catch (e) { emit('mcp_error', { reader: r, error: String(e).slice(0, 300) }); child.kill(); return; }
  const canaries: Array<{ source: string; slug: string; class: string; token: string }> = manifest.privacy.canaries;
  let i = r * 1000;
  while (live() && child.exitAt === null) {
    const t = targets[i % targets.length]!;
    const op = ['search', 'query', 'get_page', 'recall', 'search'][i % 5]!;
    const args: Record<string, unknown> = op === 'get_page' ? { slug: t.slug, source_id: t.source } : { query: queryFor(t, i) };
    const t0 = now();
    const text = await client.call(op, args).catch(e => 'ERROR ' + String(e));
    emit('read', { surface: 'mcp', mode: 'warm', op, ms: Math.round(now() - t0), ok: !text.startsWith('ERROR'), err: text.startsWith('ERROR') ? text.slice(0, 200) : undefined });
    passiveScanned++;
    const passive = leakedTokens(text);
    if (passive.length) emit('privacy_passive', { op, tokens: passive.slice(0, 5), snippet: text.slice(Math.max(0, text.indexOf(passive[0]!) - 300), text.indexOf(passive[0]!) + 100) });
    if (i % 3 === 0 && canaries.length) {
      const c = canaries[(i / 3 + r) % canaries.length]!;
      for (const [probeOp, probeArgs] of [['search', { query: c.token }], ['query', { query: c.token }], ['get_page', { slug: c.slug, source_id: c.source }], ['recall', { query: c.token }]] as const) {
        const out = await client.call(probeOp, probeArgs as Record<string, unknown>).catch(e => 'ERROR ' + String(e));
        const found = leakedTokens(out, probeOp === 'get_page' ? '' : c.token);
        emit('privacy', { op: probeOp, class: c.class, leaked: found.length > 0, error: out.startsWith('ERROR') ? out.slice(0, 120) : undefined, ...(found.length ? { slug: c.slug, tokens: found.slice(0, 5), snippet: out.slice(Math.max(0, out.indexOf(found[0]!) - 300), out.indexOf(found[0]!) + 100) } : {}) });
      }
    }
    i++;
    await sleep(CONFIG.read_gap_s * 1000);
  }
  child.kill();
}

async function writeLoop(env: Record<string, string>, targets: Target[]): Promise<void> {
  const { child, client } = mcpChild(env, 'mcp-writer');
  const ok = await client.init().then(() => true, e => { emit('mcp_error', { reader: 'writer', error: String(e).slice(0, 300) }); return false; });
  const people = targets.filter(t => t.slug.startsWith('people/') && t.source === WRITER_SOURCE);
  let i = 0;
  while (live()) {
    const kind = i % 4;
    const slug = 'notes/soak-writes/w-' + i + '-' + Math.random().toString(36).slice(2, 7);
    const body = '---\ntitle: "Soak write ' + i + '"\ntype: note\n---\n# Soak write ' + i + '\n\nA page written through ' + (kind < 2 ? 'the CLI' : 'MCP') + ' during the soak.\n';
    const entity = people.length ? pick(people).slug : undefined;
    const fact = 'Soak fact ' + i + ': prefers the ' + pick(['harbor', 'quartz', 'meadow', 'signal']) + ' plan';
    const t0 = now();
    let outcome = 'error' as 'ok' | 'pending' | 'error', detail = '';
    const cliOutcome = (r: { code: number; stdout: string; stderr: string }) => { outcome = r.code === 0 ? 'ok' : r.code === 10 ? 'pending' : 'error'; detail = r.code === 0 ? '' : (r.stderr || r.stdout).trim().split('\n').filter(l => !/^Docs: /.test(l)).slice(-2).join(' ').slice(0, 300); };
    const mcpOutcome = (out: string) => { outcome = /write_pending|accepted and awaiting completion|"status"\s*:\s*"(pending|accepted)"/.test(out) ? 'pending' : /^ERROR|"error"\s*:/.test(out) ? 'error' : 'ok'; detail = outcome === 'ok' ? '' : out.slice(0, 300); };
    if (kind === 0) cliOutcome(await gb(CLI, HOME, env, ['put', slug, '--source-id', WRITER_SOURCE, '--content-origin', 'inferred', '--wait', '300', '--content', body], { allowFail: true, timeoutMs: 600_000 }));
    else if (kind === 1) cliOutcome(await gb(CLI, HOME, env, ['remember', fact, ...(entity ? ['--entity', entity] : []), '--provenance', 'soak writer', '--source-id', WRITER_SOURCE, '--content-origin', 'inferred', '--wait', '300'], { allowFail: true, timeoutMs: 600_000 }));
    else if (ok && kind === 2) mcpOutcome(await client.call('put_page', { slug, content: body, content_origin: 'inferred' }).catch(e => 'ERROR ' + String(e)));
    else if (ok) mcpOutcome(await client.call('remember', { fact, ...(entity ? { entity } : {}), provenance: 'soak writer', content_origin: 'inferred' }).catch(e => 'ERROR ' + String(e)));
    emit('write', { surface: kind < 2 ? 'cli' : 'mcp', op: kind % 2 === 0 ? 'put' : 'remember', ms: Math.round(now() - t0), ok: outcome === 'ok', outcome, err: detail || undefined });
    i++;
    const until = now() + CONFIG.write_every_s * 1000;
    while (live() && now() < until) await sleep(1000);
  }
  child.kill();
}

async function staleLoop(env: Record<string, string>): Promise<void> {
  while (live()) {
    for (const args of [['extract', '--stale', '--source-id', WRITER_SOURCE], ['embed', '--stale', '--yes']]) {
      if (!live()) break;
      const r = await gb(CLI, HOME, env, args, { allowFail: true, timeoutMs: 3600_000 });
      emit('maintenance', { op: args.slice(0, 2).join(' '), ms: Math.round(r.ms), code: r.code, tail: (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 300) });
    }
    const until = now() + CONFIG.stale_every_s * 1000;
    while (live() && now() < until) await sleep(2000);
  }
}

if (import.meta.main) await main();
