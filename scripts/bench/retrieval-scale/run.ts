#!/usr/bin/env bun
/**
 * Retrieval scale bench, step 2: CLI and MCP latency for search, query, get
 * and recall on a corpus.ts brain (GBRA-156). Opt-in, never run in CI.
 *
 *   bun scripts/bench/retrieval-scale/run.ts --manifest manifest.json \
 *     --url postgresql://postgres:postgres@127.0.0.1:6543/bench_retrieval_300k?prepare=false \
 *     [--direct-url postgresql://...:5434/bench_retrieval_300k] [--n 20] [--warmup 3] \
 *     [--ops search,query,get,recall] [--modes cold,warm] [--search-mode tokenmax] \
 *     [--embed-ms 0] [--rerank-ms 0] [--toxiproxy http://127.0.0.1:8474 --rtt-ms 40] [--trace] [--serve-cpu-prof <dir>] \
 *     [--tree <checkout>] [--keep] [--label <name>] [--out results.jsonl] [--results calls.jsonl]
 *
 * --toxiproxy adds --rtt-ms of round-trip latency to its `pooler` proxy (vm-setup.sh
 * creates it on 127.0.0.1:6544 in front of PgBouncer); point --url at 6544 to use it.
 *
 * --url is what gbrain connects to (point it at a transaction-mode PgBouncer
 * to measure the pooled path); --direct-url (default --url) samples queries.
 * Embedding and rerank go to mock-providers.ts in this process, answering
 * after --embed-ms / --rerank-ms, so the numbers are gbrain's own cost plus a
 * fixed provider round trip.
 *
 *   cold  one fresh CLI process per sample, the cost a shell-out agent pays.
 *         With --trace each sample records GBRAIN_SQL_TRACE and splits wall
 *         time into startup (spawn -> first statement), db (first statement
 *         -> last reply) and tail (last reply -> exit), plus round trips.
 *   warm  one long-lived gbrain serve stdio MCP process; per-stage search
 *         timings come from _meta.retrieval.timings.
 *   socket  one long-lived `gbrain serve --cli-socket` and a CLI process per
 *         sample that answers through the warm socket (GBRAIN_CLI_SOCKET=1),
 *         the path a shell-out agent pays once a serve is running.
 *
 * Queries are 2-4 generated words from a random page body plus, for half of
 * them, a word of its title: synthetic text only. Rows carry timings and
 * counts. Prints a Markdown table and appends JSONL rows to --out.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from '#postgres';
import { startMockProviders } from './mock-providers.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
/** --tree points at another checkout (for example master) to measure its CLI against the same brain. */
const REPO = resolve(flag('--tree', resolve(import.meta.dir, '..', '..', '..'))!);
const CLI = join(REPO, 'src', 'cli.ts');
const has = (name: string) => argv.includes(name);
const manifest = JSON.parse(readFileSync(flag('--manifest')!, 'utf8'));
const url = flag('--url')!;
const directUrl = flag('--direct-url', url.replace(/\?.*$/, ''))!;
const N = Number(flag('--n', '20'));
const WARMUP = Number(flag('--warmup', '3'));
const ops = flag('--ops', 'search,query,get,recall')!.split(',');
const modes = flag('--modes', 'cold,warm')!.split(',');
const searchMode = flag('--search-mode', 'tokenmax')!;
const label = flag('--label', manifest.db + (flag('--rtt-ms') ? '-rtt' + flag('--rtt-ms') : ''))!;
const out = flag('--out');
const trace = has('--trace');
/** --results <file>: one JSONL line per warm call with its arguments and returned content (compare two trees' output). */
const resultsOut = flag('--results');
const log = (m: string) => console.error('[retrieval-run] ' + m);

export const pct = (xs: number[], q: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!; };
const r0 = (x: number) => Math.round(x);

interface Sample { ms: number; ok: boolean; stages?: Record<string, number>; startup?: number; db?: number; tail?: number; trips?: number }

async function main() {
  const toxiproxy = flag('--toxiproxy');
  const rttMs = Number(flag('--rtt-ms', '0'));
  if (toxiproxy) {
    for (const name of ['latency_up', 'latency_down']) await fetch(toxiproxy + '/proxies/pooler/toxics/' + name, { method: 'DELETE' }).catch(() => undefined);
    if (rttMs > 0) for (const [name, stream] of [['latency_up', 'upstream'], ['latency_down', 'downstream']] as const) {
      const res = await fetch(toxiproxy + '/proxies/pooler/toxics', { method: 'POST', body: JSON.stringify({ name, type: 'latency', stream, attributes: { latency: rttMs / 2, jitter: 0 } }) });
      if (!res.ok) throw new Error('toxiproxy: ' + res.status + ' ' + await res.text());
    }
    log('toxiproxy pooler RTT ' + rttMs + ' ms');
  }
  const mock = startMockProviders({ manifest, embedMs: Number(flag('--embed-ms', '0')), rerankMs: Number(flag('--rerank-ms', '0')) });
  const home = mkdtempSync(join(tmpdir(), 'gbrain-retrieval-bench-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'postgres', database_url: url, embedding_model: manifest.model, embedding_dimensions: manifest.dims,
    provider_base_urls: { voyage: mock.url + '/v1' },
  }));
  const env: Record<string, string> = {
    ...process.env as Record<string, string>, GBRAIN_HOME: home, OPENAI_BASE_URL: mock.url + '/v1', OPENAI_API_KEY: 'sk-bench', VOYAGE_API_KEY: 'pa-bench',
    GBRAIN_NO_UPDATE_CHECK: '1', GBRAIN_TELEMETRY: '0',
  };
  const runCli = async (args: string[], extra: Record<string, string> = {}) => {
    const t0 = performance.timeOrigin + performance.now();
    const p = Bun.spawn([process.execPath, CLI, ...args], { cwd: REPO, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    const t1 = performance.timeOrigin + performance.now();
    return { t0, t1, ms: t1 - t0, code, stdout, stderr };
  };
  const set = await runCli(['config', 'set', 'search.mode', searchMode]);
  if (set.code !== 0) log('config set search.mode failed: ' + set.stderr.slice(0, 300));

  // Query set and get targets, drawn deterministically from the corpus.
  const sql = postgres(directUrl, { max: 1, prepare: false, onnotice: () => {} });
  const picks = await sql.unsafe("SELECT p.slug, p.source_id, p.title, c.chunk_text FROM pages p JOIN content_chunks c ON c.page_id = p.id AND c.chunk_index = 0 WHERE p.id IN (SELECT 1 + ((g::bigint * 2654435761) % $1) FROM generate_series(1, $2) g) ORDER BY p.id", [manifest.pages, Math.max(N + WARMUP, 20) * 2]) as Array<{ slug: string; source_id: string; title: string; chunk_text: string }>;
  await sql.end();
  const queries = picks.map((p, i) => {
    const words = p.chunk_text.replace(/[^a-z\s]/gi, ' ').split(/\s+/).filter(w => w.length > 3);
    const k = 2 + (i % 3), at = (i * 7919) % Math.max(1, words.length - k);
    const titleWord = p.title.split(/\s+/).find(w => w.length > 3);
    return [...(i % 2 === 0 && titleWord ? [titleWord.toLowerCase()] : []), ...words.slice(at, at + k)].join(' ');
  });
  const q = (i: number) => queries[i % queries.length]!;
  // Each op reads its own slice of the query set, so no op reuses another's per-process query embedding.
  const opBase = (op: string) => ops.indexOf(op) * 7 + 1;
  const pk = (i: number) => picks[i % picks.length]!;
  const cli: Record<string, (i: number) => string[]> = {
    search: i => ['search', q(i + opBase('search')), '--json'],
    query: i => ['query', q(i + opBase('query')), '--json'],
    get: i => ['get', pk(i).slug, '--source', pk(i).source_id],
    recall: i => ['recall', q(i + opBase('recall')), '--json'],
  };
  const tool: Record<string, (i: number) => [string, Record<string, unknown>]> = {
    search: i => ['search', { query: q(i + opBase('search')) }],
    query: i => ['query', { query: q(i + opBase('query')) }],
    get: i => ['get_page', { slug: pk(i).slug, source_id: pk(i).source_id }],
    recall: i => ['recall', { query: q(i + opBase('recall')) }],
  };

  const rows: Array<Record<string, unknown>> = [];
  const add = (op: string, mode: string, s: Sample[]) => {
    const ok = s.filter(x => x.ok), ms = ok.map(x => x.ms);
    const row: Record<string, unknown> = { suite: 'retrieval-scale', label, pages: manifest.pages, chunks: manifest.chunks, op, mode, search_mode: searchMode, n: ok.length, errors: s.length - ok.length, p50_ms: r0(pct(ms, 0.5)), p95_ms: r0(pct(ms, 0.95)), embed_ms: Number(flag('--embed-ms', '0')), rerank_ms: Number(flag('--rerank-ms', '0')) };
    const med = (k: keyof Sample) => { const v = ok.map(x => x[k] as number).filter(x => typeof x === 'number'); return v.length ? r0(pct(v, 0.5)) : undefined; };
    if (trace) { row.startup_p50_ms = med('startup'); row.db_p50_ms = med('db'); row.tail_p50_ms = med('tail'); row.round_trips_p50 = med('trips'); }
    const stageNames = new Set(ok.flatMap(x => Object.keys(x.stages ?? {})));
    if (stageNames.size) row.stages_p50_ms = Object.fromEntries([...stageNames].map(k => [k, r0(pct(ok.map(x => x.stages?.[k] ?? 0), 0.5))]));
    if (stageNames.size) row.stages_p95_ms = Object.fromEntries([...stageNames].map(k => [k, r0(pct(ok.map(x => x.stages?.[k] ?? 0), 0.95))]));
    const worst = s.reduce((w, x, i) => (x.ok && x.ms > s[w]!.ms ? i : w), 0);
    if (s[worst]) row.slowest = { i: worst, ms: r0(s[worst]!.ms), target: op === 'get' ? pk(worst).slug : q(worst + opBase(op)), ...(s[worst]!.stages ? { stages: s[worst]!.stages } : {}) };
    rows.push(row);
    if (s[worst]?.stages) log(op + ' [' + mode + '] slowest i=' + worst + ' ' + JSON.stringify(row.slowest));
    log(op + ' [' + mode + '] n=' + row.n + ' p50=' + row.p50_ms + ' p95=' + row.p95_ms + ' err=' + row.errors + (row.round_trips_p50 !== undefined ? ' trips=' + row.round_trips_p50 : '') + (row.startup_p50_ms !== undefined ? ' startup=' + row.startup_p50_ms + ' db=' + row.db_p50_ms + ' tail=' + row.tail_p50_ms : '') + (row.stages_p50_ms ? ' ' + JSON.stringify(row.stages_p50_ms) : ''));
  };

  if (modes.includes('cold')) {
    for (const op of ops) {
      for (let i = 0; i < WARMUP; i++) await runCli(cli[op]!(1000 + i));
      const samples: Sample[] = [];
      for (let i = 0; i < N; i++) {
        const traceFile = join(home, 'trace-' + op + '-' + i + '.jsonl');
        const r = await runCli(cli[op]!(i), trace ? { GBRAIN_SQL_TRACE: traceFile } : {});
        const s: Sample = { ms: r.ms, ok: r.code === 0 };
        if (!s.ok && i === 0) log(op + ' cold exit ' + r.code + ': ' + r.stderr.slice(-400));
        if (trace) {
          const recs = readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((x: any) => typeof x.t === 'number' || typeof x.start === 'number');
          const starts = recs.map((x: any) => x.start ?? x.t), ends = recs.map((x: any) => (x.start ?? x.t) + (x.ms ?? x.duration_ms ?? 0));
          if (starts.length) { s.startup = Math.min(...starts) - r.t0; s.db = Math.max(...ends) - Math.min(...starts); s.tail = r.t1 - Math.max(...ends); s.trips = recs.length; }
        }
        samples.push(s);
      }
      add(op, 'cold', samples);
    }
  }

  if (modes.includes('socket')) {
    const proc = Bun.spawn([process.execPath, CLI, 'serve', '--cli-socket'], { cwd: REPO, env: { ...env, GBRAIN_CLI_SOCKET: '1' }, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' });
    let serveErr = '';
    (async () => { const dec = new TextDecoder(); for await (const c of proc.stderr as ReadableStream<Uint8Array>) serveErr += dec.decode(c); })();
    for (let waited = 0; !serveErr.includes('cli-socket: listening') && waited < 60_000; waited += 250) await new Promise(r => setTimeout(r, 250));
    if (!serveErr.includes('cli-socket: listening')) throw new Error('serve --cli-socket did not start: ' + serveErr.slice(-400));
    for (const op of ops) {
      for (let i = 0; i < WARMUP; i++) await runCli(cli[op]!(3000 + i), { GBRAIN_CLI_SOCKET: '1' });
      const samples: Sample[] = [];
      for (let i = 0; i < N; i++) {
        const r = await runCli(cli[op]!(i), { GBRAIN_CLI_SOCKET: '1' });
        samples.push({ ms: r.ms, ok: r.code === 0 });
      }
      add(op, 'socket', samples);
    }
    try { (proc.stdin as any).end(); } catch { /* closed */ }
    proc.kill();
    await proc.exited;
  }

  if (modes.includes('warm')) {
    const warmTrace = join(home, 'trace-serve.jsonl');
    const profDir = flag('--serve-cpu-prof');
    const proc = Bun.spawn([process.execPath, ...(profDir ? ['--cpu-prof', '--cpu-prof-dir=' + profDir] : []), CLI, 'serve'], { cwd: REPO, env: { ...env, ...(trace ? { GBRAIN_SQL_TRACE: warmTrace } : {}) }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
    const tripsBetween = async (t0: number, t1: number) => {
      await new Promise(r => setTimeout(r, 1100));
      let n = 0;
      try { for (const l of readFileSync(warmTrace, 'utf8').split('\n')) { if (!l) continue; const x = JSON.parse(l); if (typeof x.t === 'number' && x.t >= t0 && x.t <= t1) n++; } } catch { /* no trace yet */ }
      return n;
    };
    let buf = '';
    const waiters = new Map<number, (v: any) => void>();
    (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
          if (!line.startsWith('{')) continue;
          try { const m = JSON.parse(line); if (typeof m.id === 'number' && waiters.has(m.id)) { waiters.get(m.id)!(m); waiters.delete(m.id); } } catch { /* partial line */ }
        }
      }
    })();
    let nextId = 1;
    const request = (method: string, params: unknown) => new Promise<any>((res, rej) => {
      const id = nextId++;
      const t = setTimeout(() => { waiters.delete(id); rej(new Error('timeout ' + method)); }, 120_000);
      waiters.set(id, v => { clearTimeout(t); res(v); });
      (proc.stdin as any).write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      (proc.stdin as any).flush?.();
    });
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'retrieval-scale-bench', version: '1' } });
    (proc.stdin as any).write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    for (const op of ops) {
      const call = async (i: number): Promise<Sample> => {
        const [name, args] = tool[op]!(i);
        const t0 = performance.now();
        const r = await request('tools/call', { name, arguments: args });
        const ms = performance.now() - t0;
        const timings = r?.result?._meta?.retrieval?.timings;
        const trips = trace ? await tripsBetween(performance.timeOrigin + t0, performance.timeOrigin + t0 + ms) : undefined;
        if (trace) appendFileSync(join(home, 'warm-calls.jsonl'), JSON.stringify({ op, t0: performance.timeOrigin + t0, t1: performance.timeOrigin + t0 + ms }) + '\n');
        if (resultsOut) {
          const { timings: _t, cost: _c, ...retrieval } = r?.result?._meta?.retrieval ?? {};
          appendFileSync(resultsOut, JSON.stringify({ op, i, arguments: args, content: r?.result?.content, meta: { ...r?.result?._meta, retrieval } }) + '\n');
        }
        const parts = Object.entries(timings?.parts_ms ?? {}).flatMap(([stage, byPart]) => Object.entries(byPart as Record<string, number>).map(([part, v]) => [stage + '.' + part, v]));
        return { ms, ok: !r.error && !r.result?.isError, ...(trips !== undefined ? { trips } : {}), ...(timings ? { stages: { ...timings.stages_ms, ...Object.fromEntries(parts), other: timings.other_ms, total: timings.total_ms } } : {}) };
      };
      for (let i = 0; i < WARMUP; i++) await call(2000 + i);
      const samples: Sample[] = [];
      for (let i = 0; i < N; i++) samples.push(await call(i));
      add(op, 'warm', samples);
    }
    try { (proc.stdin as any).end(); } catch { /* closed */ }
    const kill = setTimeout(() => proc.kill(), 3000);
    await proc.exited; clearTimeout(kill);
  }

  log('provider calls: ' + JSON.stringify(mock.stats));
  mock.stop();
  if (has('--keep')) log('kept bench home ' + home); else rmSync(home, { recursive: true, force: true });
  if (out) for (const r of rows) appendFileSync(out, JSON.stringify({ ...r, at: new Date().toISOString() }) + '\n');
  console.log('| op | mode | n | p50 ms | p95 ms |' + (trace ? ' startup | db | tail | trips |' : ''));
  console.log('|---|---|---|---|---|' + (trace ? '---|---|---|---|' : ''));
  for (const r of rows) console.log('| ' + [r.op, r.mode, r.n, r.p50_ms, r.p95_ms, ...(trace ? [r.startup_p50_ms ?? '', r.db_p50_ms ?? '', r.tail_p50_ms ?? '', r.round_trips_p50 ?? ''] : [])].join(' | ') + ' |');
}

if (import.meta.main) await main();
