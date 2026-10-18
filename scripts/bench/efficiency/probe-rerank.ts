#!/usr/bin/env bun
/**
 * Reranker cost/latency probe (GBRA-66). Opt-in, never run in CI. Spends real
 * Voyage tokens: about (variants x queries) calls; the default grid is ~$0.25.
 *
 *   VOYAGE_API_KEY=... bun scripts/bench/efficiency/probe-rerank.ts --label synth-full [--queries 20] [--grid 25x1400,25x512,10x1400,10x512]
 *       [--models rerank-2.5,rerank-2.5-lite]
 *
 * For each query it draws one candidate set (the --pool-size chunks best matching
 * any query word by Postgres full-text rank, falling back to random chunks) from
 * engines/postgres-<label>, then calls Voyage /v1/rerank once per grid cell
 * `<top_n_in>x<max_doc_tokens>` and model: the first top_n_in candidates, each cut
 * to max_doc_tokens (cl100k estimate, the same cut rerank.ts applies at 1400).
 * Reports provider-billed tokens per call, $/query, latency p50/p95, and top-5
 * agreement with the default cell (25x1400 on rerank-2.5): the share of the
 * default's top 5 that the cell also ranks top 5. Agreement is a drift signal,
 * not a quality metric; quality needs a judged eval (gbrain-evals).
 * Prints no chunk text; queries are generated words.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokens } from '../../../src/core/chunkers/token-estimate.ts';
import { WORK, flag, machine, pct, rng } from './lib.ts';

const label = flag('label')!;
const Q = Number(flag('queries', '20'));
const poolSize = Number(flag('pool-size', '25'));
const grid = flag('grid', '25x1400,25x512,10x1400,10x512')!.split(',').map((c) => c.split('x').map(Number) as [number, number]);
const models = flag('models', 'rerank-2.5')!.split(',');
const container = flag('container', process.env.BENCH_PG_CONTAINER ?? 'gbrain-bench-pg')!;
const PRICE: Record<string, number> = { 'rerank-2.5': 0.05, 'rerank-2.5-lite': 0.02, 'rerank-3': 0.05, 'rerank-3-lite': 0.02 };
const key = process.env.VOYAGE_API_KEY;
if (!key) throw new Error('VOYAGE_API_KEY is required');
if (!existsSync(join(WORK, 'engines', `postgres-${label}`))) throw new Error(`no brain for ${label}`);
const db = `bench_${label.replace(/[^a-z0-9]/gi, '_')}`;

async function psqlRows(sql: string): Promise<string[]> {
  const p = Bun.spawn(['docker', 'exec', container, 'psql', '-U', 'postgres', '-d', db, '-tA', '-c', sql], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return out.split('\u001e').map((s) => s.replace(/^\n/, '')).filter((s) => s.length > 0);
}

function cut(text: string, maxTokens: number): string {
  if (text.length <= maxTokens) return text;
  let doc = text.slice(0, maxTokens * 5);
  for (let i = 0; i < 4; i++) {
    const t = estimateTokens(doc);
    if (t <= maxTokens) break;
    doc = doc.slice(0, Math.floor(doc.length * (maxTokens / t) * 0.95));
  }
  return doc;
}

const vocab = (await psqlRows(`SELECT string_agg(w, chr(30)) FROM (SELECT word AS w FROM ts_stat('SELECT search_vector FROM content_chunks TABLESAMPLE SYSTEM (5)') WHERE length(word) > 4 ORDER BY ndoc DESC LIMIT 400) s`))[0]!.split('\u001e');
const r = rng(7);
const queries = Array.from({ length: Q }, () => Array.from({ length: 3 }, () => vocab[Math.floor(r() * vocab.length)]).join(' '));

interface Cell { model: string; topN: number; maxTok: number; ms: number[]; tokens: number[]; agree: number[] }
const cells: Cell[] = models.flatMap((model) => grid.map(([topN, maxTok]) => ({ model, topN, maxTok, ms: [], tokens: [], agree: [] })));
const baseline = cells.find((c) => c.model === 'rerank-2.5' && c.topN === 25 && c.maxTok === 1400) ?? cells[0]!;

for (const q of queries) {
  const safe = q.split(' ').map((w) => w.replace(/[^a-z0-9]/gi, '')).filter(Boolean).join(' | ');
  let docs = await psqlRows(`SELECT chunk_text || chr(30) FROM content_chunks WHERE search_vector @@ to_tsquery('english', '${safe}') ORDER BY ts_rank(search_vector, to_tsquery('english', '${safe}')) DESC LIMIT ${poolSize}`);
  if (docs.length < poolSize) docs = docs.concat(await psqlRows(`SELECT chunk_text || chr(30) FROM content_chunks TABLESAMPLE SYSTEM (2) LIMIT ${poolSize - docs.length}`));
  const tops = new Map<Cell, number[]>();
  for (const c of [baseline, ...cells.filter((x) => x !== baseline)]) {
    const documents = docs.slice(0, c.topN).map((d) => cut(d, c.maxTok));
    const t = performance.now();
    const res = await fetch('https://api.voyageai.com/v1/rerank', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ query: q, documents, model: c.model }) });
    const body = (await res.json()) as { data?: { index: number }[]; usage?: { total_tokens: number } };
    c.ms.push(performance.now() - t);
    if (!res.ok || !body.data) throw new Error(`rerank ${res.status}`);
    c.tokens.push(body.usage?.total_tokens ?? 0);
    tops.set(c, body.data.slice(0, 5).map((d) => d.index));
  }
  const base = new Set(tops.get(baseline)!);
  for (const c of cells) c.agree.push(tops.get(c)!.filter((i) => base.has(i)).length / Math.max(1, base.size));
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
console.log(`machine: ${machine()}\nbrain: ${label} (postgres)  queries: ${Q}  candidate pool: ${poolSize} chunks/query  mode: direct Voyage /v1/rerank\n`);
console.log('| model | top_n_in | max doc tokens | billed tokens/call | $/1k queries | p50 ms | p95 ms | top-5 agreement vs 25x1400 |\n|---|---|---|---|---|---|---|---|');
let spend = 0;
for (const c of cells) {
  const tok = mean(c.tokens);
  spend += c.tokens.reduce((s, x) => s + x, 0) * (PRICE[c.model] ?? 0.05) / 1e6;
  console.log(`| ${c.model} | ${c.topN} | ${c.maxTok} | ${Math.round(tok)} | ${((tok * (PRICE[c.model] ?? 0.05)) / 1e3).toFixed(3)} | ${pct(c.ms, 0.5).toFixed(0)} | ${pct(c.ms, 0.95).toFixed(0)} | ${(100 * mean(c.agree)).toFixed(0)}% |`);
}
console.log(`\nprobe spend: $${spend.toFixed(3)}`);
