#!/usr/bin/env bun
/**
 * Office-ingest retrieval sanity-eval harness.
 *
 * Imports a corpus of office documents into a THROWAWAY brain, then scores
 * keyword retrieval against a labeled query set (hit@k + MRR).
 *
 * This is a SCAFFOLD, not BrainBench. It answers one honest question — "does
 * office content import and come back when asked?" — over whatever corpus you
 * point it at. It does NOT claim gbrain is better than any other system; that is
 * a whole-system claim proven across the full BrainBench suite, not by one
 * feature's harness. Bring a real labeled corpus to get meaningful numbers.
 *
 * Usage:
 *   bun evals/office-ingest/harness.ts --corpus <dir> --queries <file.jsonl> [--k 5]
 *
 * queries.jsonl — one JSON object per line:
 *   {"query": "...", "expect_slug": "report.pdf"}
 *   {"query": "...", "expect_substring": "two hundred fifty million"}
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { loadConfig } from '../../src/core/config.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { importOfficeFile } from '../../src/core/office/adapter.ts';
import { isOfficeFilePath } from '../../src/core/office/extensions.ts';

function arg(name: string, def: string | null): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1]! : def;
}

const corpus = arg('--corpus', null);
const queriesPath = arg('--queries', null);
const k = parseInt(arg('--k', '5')!, 10);
if (!corpus || !queriesPath) {
  console.error('Usage: bun evals/office-ingest/harness.ts --corpus <dir> --queries <file.jsonl> [--k 5]');
  process.exit(1);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    const s = statSync(f);
    if (s.isDirectory()) out.push(...walk(f));
    else if (isOfficeFilePath(f)) out.push(f);
  }
  return out;
}

configureGateway(buildGatewayConfig(loadConfig())); // ambient embedder (text → ollama, image → Voyage if set)
const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
await engine.setConfig('ingest.docling.enabled', 'true');

const files = walk(corpus);
console.error(`[eval] importing ${files.length} office files from ${corpus} …`);
for (const f of files) {
  const rel = f.slice(corpus.length + 1).replace(/\\/g, '/');
  try {
    const r = await importOfficeFile(engine, f, rel, {});
    console.error(`  ${rel}: ${r.status} (${r.chunks} chunks)`);
  } catch (e) {
    console.error(`  ${rel}: ERROR ${(e as Error).message}`);
  }
}

interface Q { query: string; expect_slug?: string; expect_substring?: string }
const queries: Q[] = readFileSync(queriesPath, 'utf-8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

let hits = 0;
let rrSum = 0;
const perQuery: Array<{ query: string; hit: boolean; rank: number | null }> = [];
for (const q of queries) {
  const res = await engine.searchKeywordChunks(q.query, { limit: k }); // chunk-level → has chunk_text
  let rank = -1;
  for (let i = 0; i < res.length; i++) {
    const h = res[i] as { slug: string; chunk_text?: string };
    const ok = q.expect_slug
      ? h.slug === q.expect_slug
      : (h.chunk_text ?? '').toLowerCase().includes((q.expect_substring ?? '').toLowerCase());
    if (ok) { rank = i + 1; break; }
  }
  if (rank > 0) { hits++; rrSum += 1 / rank; }
  perQuery.push({ query: q.query, hit: rank > 0, rank: rank > 0 ? rank : null });
}

const n = queries.length || 1;
const report = {
  scope: 'retrieval sanity-eval (keyword); NOT BrainBench',
  corpus,
  files_imported: files.length,
  queries: queries.length,
  k,
  hit_at_k: +(hits / n).toFixed(3),
  mrr: +(rrSum / n).toFixed(3),
  per_query: perQuery,
};
console.log(JSON.stringify(report, null, 2));
await engine.disconnect();
