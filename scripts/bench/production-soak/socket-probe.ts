#!/usr/bin/env bun
/**
 * Warm CLI socket probe on a loaded production-soak brain (GBRA-156): the soak topology at --rtt-ms, the loopback mock
 * provider, one `gbrain serve --cli-socket` (GBRAIN_SQL_TRACE on) and --n warm `gbrain search --json --timings` CLI
 * calls. Per call it records the CLI's wall time, the serve's op time (timings_ms.op), the CLI overhead around it,
 * and the serve's database round trips for the call: the total, and the sequential ones (the longest chain of round
 * trips each starting after the previous one answered, i.e. the network floor the call cannot overlap).
 *
 * Background work the serve runs on its own (the persistence effects drain, the on-commit notifier) is not the call's:
 * its statements, and every statement in a transaction that holds one, are counted as bg_trips, apart from the
 * call's trips. Before measuring, the probe waits until the serve's trace has shown no persistence_effects statement for
 * --settle-quiet-s (at most --settle-max-s), so a drain left over from the load does not ride along.
 *
 * --sweep N forces the serve's idle maintenance sweep beside searches N times: the serve ticks every
 * --sweep-interval-ms (GBRAIN_SWEEP_IDLE_INTERVAL_MS), --touch pages with facts fences are marked updated before each
 * cycle so the facts reconcile has work, and the probe starts --burst searches the moment the serve logs
 * `idle sweep: started`, recording whether each search ran while the sweep was in flight.
 *
 *   bun scripts/bench/production-soak/socket-probe.ts --fixture ~/soak/fixture --work ~/soak/work --out ~/socket-probe \
 *     [--rtt-ms 58] [--n 30] [--warmup 3] [--embed-ms 200] [--rerank-ms 300] [--sweep 0] [--sweep-interval-ms 15000] [--burst 3] [--touch 40]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from '#postgres';
import { startMockProviders } from '../retrieval-scale/mock-providers.ts';
import { spawnChild } from '../sync-freshness-lib.ts';
import { childEnv, now, REPO, sleep, startTopology, writeConfig } from './lib.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback = '') => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1]! : fallback; };
const FIXTURE = resolve(flag('fixture')), WORK = resolve(flag('work')), OUT = resolve(flag('out'));
const RTT = Number(flag('rtt-ms', '58')), N = Number(flag('n', '30')), WARMUP = Number(flag('warmup', '3'));
const EMBED = Number(flag('embed-ms', '200')), RERANK = Number(flag('rerank-ms', '300'));
const SETTLE_QUIET_S = Number(flag('settle-quiet-s', '15')), SETTLE_MAX_S = Number(flag('settle-max-s', '1800'));
const SWEEPS = Number(flag('sweep', '0')), SWEEP_MS = Number(flag('sweep-interval-ms', '15000')), BURST = Number(flag('burst', '3')), TOUCH = Number(flag('touch', '40'));
const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
const ready = JSON.parse(readFileSync(join(WORK, 'ready.json'), 'utf8'));
const HOME = join(WORK, 'home');
const CLI = join(REPO, 'src', 'cli.ts');

interface Trip { t: number; ms: number; label: string; conn: number; kind: string; sql: string; bg?: boolean }
const BACKGROUND = /persistence_|sync_notifier/;
const DRAIN = /persistence_effects/;

/** The longest chain of round trips in which each one starts after the previous one answered. */
function sequential(trips: Trip[]): number {
  const sorted = [...trips].sort((a, b) => (a.t + a.ms) - (b.t + b.ms));
  const depth: number[] = [];
  let best = 0;
  for (let i = 0; i < sorted.length; i++) {
    let d = 1;
    for (let j = 0; j < i; j++) if (sorted[j]!.t + sorted[j]!.ms <= sorted[i]!.t) d = Math.max(d, depth[j]! + 1);
    depth.push(d);
    best = Math.max(best, d);
  }
  return best;
}

function readTrips(file: string): Trip[] {
  if (!existsSync(file)) return [];
  const trips = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Trip).filter(r => r.kind !== 'connect' && r.kind !== 'tls_untraced');
  const open = new Map<number, Trip[]>();
  for (const r of [...trips].sort((a, b) => a.t - b.t)) {
    r.bg = BACKGROUND.test(r.sql);
    const sql = r.sql.trim().toLowerCase();
    if (sql.startsWith('begin')) { open.set(r.conn, [r]); continue; }
    const tx = open.get(r.conn);
    if (!tx) continue;
    tx.push(r);
    if (sql === 'commit' || sql === 'rollback') {
      open.delete(r.conn);
      if (tx.some(x => x.bg)) for (const x of tx) x.bg = true;
    }
  }
  return trips;
}

async function queries(directUrl: string): Promise<string[]> {
  const sql = postgres(directUrl, { max: 1, onnotice: () => {} });
  const rows = await sql.unsafe("SELECT p.title, left(c.chunk_text, 600) AS text FROM pages p JOIN content_chunks c ON c.page_id = p.id AND c.chunk_index = 0 WHERE p.deleted_at IS NULL AND p.frontmatter->>'visibility' IS NULL AND p.type <> 'chat' ORDER BY md5(p.id::text) LIMIT 200") as Array<{ title: string; text: string }>;
  await sql.end();
  return rows.map((r, i) => {
    const words = r.text.replace(/[^a-z\s]/gi, ' ').split(/\s+/).filter(w => w.length > 3);
    const k = 2 + (i % 3), at = (i * 7919) % Math.max(1, words.length - k);
    const name = i % 3 === 0 ? r.title.split(/\s+/).slice(0, 2).join(' ') : '';
    return [name, ...words.slice(at, at + k)].filter(Boolean).join(' ') || r.title;
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const topo = await startTopology(WORK, undefined, undefined, true);
await topo.setRtt(0);
const direct = topo.direct(ready.db);
const qs = await queries(direct);
await topo.setRtt(RTT);
const mock = startMockProviders({ manifest: { seed: manifest.options.seed, chunks: manifest.pages * 4, pages: manifest.pages, dims: 1536 }, embedMs: EMBED, rerankMs: RERANK });
writeConfig(HOME, topo.txn(ready.db), mock.url);
const serveTrace = join(OUT, 'trace-serve.jsonl');
const base = childEnv(HOME, mock.url, { GBRAIN_DIRECT_DATABASE_URL: topo.session(ready.db) });
const serveEnv = { ...base, GBRAIN_SQL_TRACE: serveTrace, GBRAIN_SQL_TRACE_LABEL: 'serve', GBRAIN_SWEEP: SWEEPS > 0 ? '1' : '0', GBRAIN_SWEEP_IDLE_INTERVAL_MS: String(SWEEP_MS) };
let serveLog = '';
const serve = spawnChild([process.execPath, CLI, 'serve', '--cli-socket'], { cwd: HOME, env: serveEnv, logFile: join(OUT, 'serve.log'), stdin: true });
serve.onLine(l => { if (l.stream === 'err') serveLog += l.text + '\n'; });
for (let i = 0; i < 720 && !/cli-socket: listening/.test(serveLog); i++) await sleep(250);
if (!/cli-socket: listening/.test(serveLog)) throw new Error('serve did not open the CLI socket:\n' + serveLog.slice(-2000));

const settleStart = now();
let lastBg = now();
for (;;) {
  const bg = readTrips(serveTrace).filter(r => DRAIN.test(r.sql));
  if (bg.length) lastBg = Math.max(lastBg, ...bg.slice(-50).map(r => r.t + r.ms));
  if (now() - lastBg >= SETTLE_QUIET_S * 1000 || now() - settleStart >= SETTLE_MAX_S * 1000) break;
  await sleep(1000);
}
const settledAfterS = Math.round((now() - settleStart) / 1000);
console.log('settle', settledAfterS, 's', now() - lastBg >= SETTLE_QUIET_S * 1000 ? 'quiet' : 'still busy at --settle-max-s');

const sweepStarts = () => (serveLog.match(/idle sweep: started/g) ?? []).length;
const sweepEnds = () => (serveLog.match(/idle sweep: finished/g) ?? []).length;

async function call(i: number, label: string): Promise<void> {
  const query = qs[i % qs.length]!;
  const cliTrace = join(OUT, 'trace-cli-' + i + '.jsonl');
  const inSweep = sweepStarts() > sweepEnds();
  const t0 = now();
  const p = Bun.spawn([process.execPath, CLI, 'search', query, '--json', '--timings'], { cwd: HOME, env: { ...base, GBRAIN_SQL_TRACE: cliTrace }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const t1 = now();
  await sleep(1200);
  let op: number | null = null;
  let timings: Record<string, unknown> | null = null;
  try { timings = JSON.parse(stdout).timings_ms ?? null; op = typeof timings?.op === 'number' ? timings.op : null; } catch { /* non-JSON output */ }
  const window = readTrips(serveTrace).filter(r => r.label === 'serve' && r.t >= t0 && r.t + r.ms <= t1 + 5);
  const trips = window.filter(r => !r.bg);
  const record = { i, label, t0, t1, query_words: query.split(' ').length, ms: Math.round(t1 - t0), op_ms: op, cli_overhead_ms: op === null ? null : Math.round(t1 - t0 - op),
    code, warm: readTrips(cliTrace).length === 0, in_sweep_at_start: inSweep, in_sweep_at_end: sweepStarts() > sweepEnds(),
    trips: trips.length, bg_trips: window.length - trips.length, sequential: sequential(trips), conns: new Set(trips.map(r => r.conn)).size, stages: timings?.stages, parts: timings?.parts_ms, stderr_tail: code === 0 ? undefined : stderr.slice(-300) };
  appendFileSync(join(OUT, 'calls.jsonl'), JSON.stringify(record) + '\n');
}

for (let i = 0; i < WARMUP; i++) await call(i, 'warmup');
for (let i = 0; i < N; i++) await call(WARMUP + i, 'baseline');
if (SWEEPS > 0) {
  const sql = postgres(direct, { max: 1, onnotice: () => {} });
  for (let cycle = 0; cycle < SWEEPS; cycle++) {
    await sql.unsafe(`UPDATE pages SET updated_at = now() WHERE id IN (SELECT id FROM pages WHERE source_id = 'default' AND deleted_at IS NULL AND compiled_truth LIKE '%gbrain:facts:begin%' ORDER BY random() LIMIT ${TOUCH})`);
    const before = sweepStarts();
    for (let w = 0; w < 4 * SWEEP_MS / 250 && sweepStarts() === before; w++) await sleep(250);
    if (sweepStarts() === before) { appendFileSync(join(OUT, 'calls.jsonl'), JSON.stringify({ label: 'sweep', cycle, error: 'no sweep started' }) + '\n'); continue; }
    await Promise.all(Array.from({ length: BURST }, (_, k) => call(10_000 + cycle * BURST + k, 'during_sweep')));
    for (let w = 0; w < 240 && sweepStarts() > sweepEnds(); w++) await sleep(250);
  }
  await sql.end();
}
serve.kill();
mock.stop();
const rows = readFileSync(join(OUT, 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const p50 = (xs: Array<number | null>) => { const s = xs.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const max = (xs: Array<number | null>) => Math.max(...xs.filter((x): x is number => typeof x === 'number'));
const sweeps = [...serveLog.matchAll(/idle sweep: finished in (\d+) ms/g)].map(m => Number(m[1]));
for (const label of ['baseline', 'during_sweep']) {
  const r = rows.filter(x => x.label === label);
  if (!r.length) continue;
  console.log(label, 'n', r.length, 'warm', r.filter(x => x.warm).length, 'wall p50', p50(r.map(x => x.ms)), 'max', max(r.map(x => x.ms)), 'op p50', p50(r.map(x => x.op_ms)),
    'cli overhead p50', p50(r.map(x => x.cli_overhead_ms)), 'trips p50', p50(r.map(x => x.trips)), 'bg trips p50', p50(r.map(x => x.bg_trips)), 'sequential p50', p50(r.map(x => x.sequential)), 'conns p50', p50(r.map(x => x.conns)),
    'errors', r.filter(x => x.code !== 0).length);
}
const stageKeys = new Set<string>();
for (const r of rows.filter(x => x.label === 'baseline')) for (const k of Object.keys(r.stages ?? {})) stageKeys.add(k);
for (const k of [...stageKeys].sort()) console.log('  stage', k.padEnd(14), 'p50', p50(rows.filter(x => x.label === 'baseline').map(x => x.stages?.[k] ?? null)));
const partKeys = new Set<string>();
for (const r of rows.filter(x => x.label === 'baseline')) for (const [s, ps] of Object.entries(r.parts ?? {})) for (const k of Object.keys(ps as object)) partKeys.add(s + '.' + k);
for (const k of [...partKeys].sort()) { const [s, n] = k.split('.'); console.log('  part', k.padEnd(24), 'p50', p50(rows.filter(x => x.label === 'baseline').map(x => x.parts?.[s!]?.[n!] ?? null))); }
if (sweeps.length) console.log('sweeps', sweeps.length, 'duration ms', sweeps.join(','));
process.exit(0);
