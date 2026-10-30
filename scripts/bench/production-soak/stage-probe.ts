#!/usr/bin/env bun
/**
 * Warm search stage probe on a loaded production-soak brain (GBRA-156): the
 * soak topology at --rtt-ms, the loopback mock provider with --embed-ms and
 * --rerank-ms, one stdio `gbrain serve` (a warm MCP caller), and --n search
 * calls whose `_meta.retrieval.timings` (stages_ms and parts_ms) are written
 * to <out>/calls.jsonl with the wall time. --trace records GBRAIN_SQL_TRACE.
 *
 *   bun scripts/bench/production-soak/stage-probe.ts --fixture ~/soak/fixture --work ~/soak/work --out ~/probe \
 *     [--rtt-ms 66] [--n 40] [--warmup 5] [--embed-ms 200] [--rerank-ms 300] [--trace]
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from '#postgres';
import { startMockProviders } from '../retrieval-scale/mock-providers.ts';
import { McpClient, spawnChild } from '../sync-freshness-lib.ts';
import { childEnv, REPO, startTopology, writeConfig } from './lib.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback = '') => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1]! : fallback; };
const FIXTURE = resolve(flag('fixture')), WORK = resolve(flag('work')), OUT = resolve(flag('out'));
const RTT = Number(flag('rtt-ms', '66')), N = Number(flag('n', '40')), WARMUP = Number(flag('warmup', '5'));
const EMBED = Number(flag('embed-ms', '200')), RERANK = Number(flag('rerank-ms', '300')), TRACE = argv.includes('--trace');
const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
const ready = JSON.parse(readFileSync(join(WORK, 'ready.json'), 'utf8'));
const HOME = join(WORK, 'home');

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
const qs = await queries(topo.direct(ready.db));
await topo.setRtt(RTT);
const mock = startMockProviders({ manifest: { seed: manifest.options.seed, chunks: manifest.pages * 4, pages: manifest.pages, dims: 1536 }, embedMs: EMBED, rerankMs: RERANK });
writeConfig(HOME, topo.txn(ready.db), mock.url);
const env = childEnv(HOME, mock.url, { GBRAIN_DIRECT_DATABASE_URL: topo.session(ready.db), ...(TRACE ? { GBRAIN_SQL_TRACE: join(OUT, 'trace-serve.jsonl') } : {}) });
const child = spawnChild([process.execPath, join(REPO, 'src', 'cli.ts'), 'serve'], { cwd: HOME, env, logFile: join(OUT, 'serve.log'), stdin: true });
const client = new McpClient(child);
await client.init();
for (let i = 0; i < WARMUP + N; i++) {
  const query = qs[i % qs.length]!;
  const t0 = performance.timeOrigin + performance.now();
  const r = await client.request('tools/call', { name: 'search', arguments: { query } }, 120_000);
  const t1 = performance.timeOrigin + performance.now();
  if (i < WARMUP) continue;
  const timings = r.result?._meta?.retrieval?.timings;
  appendFileSync(join(OUT, 'calls.jsonl'), JSON.stringify({ i, query_words: query.split(' ').length, t0, t1, ms: Math.round(t1 - t0), error: r.error ? String(JSON.stringify(r.error)).slice(0, 200) : undefined, timings }) + '\n');
}
child.kill();
mock.stop();
const rows = readFileSync(join(OUT, 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const med = (xs: number[]) => { const s = xs.filter(x => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const keys = new Set<string>();
for (const r of rows) { for (const k of Object.keys(r.timings?.stages_ms ?? {})) keys.add(k); for (const [s, parts] of Object.entries(r.timings?.parts_ms ?? {})) for (const p of Object.keys(parts as object)) keys.add(s + '.' + p); }
const val = (r: any, k: string) => k.includes('.') ? r.timings?.parts_ms?.[k.split('.')[0]!]?.[k.split('.')[1]!] : r.timings?.stages_ms?.[k];
console.log('wall p50', med(rows.map(r => r.ms)), 'total p50', med(rows.map(r => r.timings?.total_ms)), 'other p50', med(rows.map(r => r.timings?.other_ms)), 'errors', rows.filter(r => r.error).length);
for (const k of [...keys].sort()) console.log(k.padEnd(32), 'p50', med(rows.map(r => val(r, k))), 'max', Math.max(...rows.map(r => val(r, k) ?? 0)));
process.exit(0);
