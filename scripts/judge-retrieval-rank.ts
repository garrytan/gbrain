#!/usr/bin/env bun
/**
 * Retrieval-rank A/B for batched vs per-chunk synopsis quality.
 *
 * The user-facing question this answers: "does batched synopsis preserve
 * retrievability vs per-chunk?" Tests by:
 *
 *   1. For each test page, pick N chunks (default 10) as targets.
 *   2. Auto-generate a query per target via Opus 4.7 ("write a query a user
 *      would type to find this chunk").
 *   3. For each (model, B) combo, wrap each chunk = `<context>title — synopsis</context>chunk_text`
 *      and embed via production embedder (text-embedding-3-large by default).
 *   4. Embed each query (production embedder).
 *   5. Cosine-rank all wrapped chunks per query. Find target chunk's rank
 *      (1 = perfect, lower = retrieval worse).
 *   6. Aggregate: mean rank, % at rank=1, % at rank<=3, per (model, B).
 *
 * Output: head-to-head per-query rank table + per-(model,B) summary.
 *
 * Cost (Opus + OpenAI embed):
 *   Query gen: ~10 queries × 3 pages × Opus call ≈ $0.10
 *   Embeds: ~3 pages × ~50 chunks × 3 models × 3 sizes ≈ ~1350 embeds × small ≈ $0.20
 *   Total: ~$0.30
 *
 * Usage:
 *   bun run scripts/judge-retrieval-rank.ts [--queries-per-page N] [--models a,b,c]
 *                                            [--sizes 1,16] [--dry-run]
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import {
  configureGateway,
  chat as gwChat,
  embed as gwEmbed,
  type AIGatewayConfig,
} from '../src/core/ai/gateway.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const JUDGE_MODEL = process.env.GBRAIN_JUDGE_MODEL ?? 'anthropic:claude-opus-4-7';
const BENCH_DIR = '/tmp/bench-synopsis-out';
const REPORT_DIR = '/tmp/judge-retrieval-rank-out';

function buildGatewayConfig(c: GBrainConfig): AIGatewayConfig {
  const envFromConfig: Record<string, string> = {};
  if (c.openai_api_key) envFromConfig.OPENAI_API_KEY = c.openai_api_key;
  if (c.anthropic_api_key) envFromConfig.ANTHROPIC_API_KEY = c.anthropic_api_key;
  if (c.zeroentropy_api_key) envFromConfig.ZEROENTROPY_API_KEY = c.zeroentropy_api_key;
  return {
    embedding_model: c.embedding_model,
    embedding_dimensions: c.embedding_dimensions,
    embedding_multimodal_model: c.embedding_multimodal_model,
    expansion_model: c.expansion_model,
    chat_model: c.chat_model,
    chat_fallback_chain: c.chat_fallback_chain,
    base_urls: c.provider_base_urls,
    env: { ...envFromConfig, ...process.env },
  };
}

// ---- Query generation ----

const QUERY_GEN_SYSTEM = [
  'You write search queries that real users would type to find a specific chunk of text.',
  '',
  'Given a chunk from a personal knowledge brain, write ONE concise query (5-15 words) that:',
  '- A user would actually type into search',
  '- Specifically targets this chunk over other chunks in the same document',
  '- Uses real entities, terms, or concepts FROM the chunk',
  '- Does NOT directly quote 10+ consecutive words from the chunk (avoid trivial substring match)',
  '',
  'Output ONLY the query as plain text. No quotes, no preamble, no markdown.',
].join('\n');

async function generateQueryForChunk(chunkText: string): Promise<string> {
  const trimmed = chunkText.length > 2000 ? chunkText.slice(0, 2000) + '\n[...]' : chunkText;
  const userPrompt = `<chunk>\n${trimmed}\n</chunk>\n\nWrite the search query:`;
  const res = await gwChat({
    model: JUDGE_MODEL,
    system: QUERY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 80,
  });
  return res.text.trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 500);
}

// ---- Wrapping (mirror production embedding-context.ts) ----

function wrapChunkForEmbedding(title: string, synopsis: string, chunkText: string): string {
  const safeTitle = title.replace(/[<>]/g, '').trim();
  const safeSyn = synopsis.replace(/[<>]/g, '').trim();
  return `<context>${safeTitle}${safeSyn ? ' — ' + safeSyn : ''}</context>\n${chunkText}`;
}

// ---- Cosine ranking ----

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function rankTargetByCosine(
  queryEmbed: Float32Array,
  wrappedEmbeds: Float32Array[],
  targetIdx: number,
): { rank: number; topScore: number; targetScore: number; score_gap: number } {
  const scores = wrappedEmbeds.map((emb, i) => ({ idx: i, score: cosine(queryEmbed, emb) }));
  scores.sort((a, b) => b.score - a.score);
  const rank = scores.findIndex((s) => s.idx === targetIdx) + 1;
  const targetScore = scores.find((s) => s.idx === targetIdx)?.score ?? 0;
  const topScore = scores[0]?.score ?? 0;
  return { rank, topScore, targetScore, score_gap: topScore - targetScore };
}

// ---- Bench file loader ----

interface BenchFile {
  page_slug: string;
  source_id: string;
  batch_size: number;
  chunk_count: number;
  synopses: Array<{ chunk_index: number; synopsis: string }>;
}

interface ModelDirIndex {
  modelSlug: string;
  filesByPageAndB: Map<string, Map<number, BenchFile>>;
}

function indexBenchDir(): ModelDirIndex[] {
  const result: ModelDirIndex[] = [];
  for (const d of readdirSync(BENCH_DIR)) {
    if (d.startsWith('.')) continue;
    const dirPath = resolve(BENCH_DIR, d);
    let files: string[] = [];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    const filesByPageAndB = new Map<string, Map<number, BenchFile>>();
    for (const f of files) {
      const raw = readFileSync(resolve(dirPath, f), 'utf-8');
      const data = JSON.parse(raw) as BenchFile;
      if (!filesByPageAndB.has(data.page_slug)) filesByPageAndB.set(data.page_slug, new Map());
      filesByPageAndB.get(data.page_slug)!.set(data.batch_size, data);
    }
    result.push({ modelSlug: d, filesByPageAndB });
  }
  return result;
}

interface QueryRank {
  query: string;
  target_chunk_index: number;
  rank: number;
  target_score: number;
  top_score: number;
  score_gap: number;
}

interface PerCellResult {
  model_slug: string;
  page_slug: string;
  batch_size: number;
  per_query_ranks: QueryRank[];
  mean_rank: number;
  rank_1_count: number;
  rank_3_count: number;
  rank_10_count: number;
  total_chunks_in_page: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let queriesPerPage = 10;
  let modelFilter: string[] | null = null;
  let sizeFilter: number[] | null = null;
  let pageFilter: string | null = null;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--queries-per-page') queriesPerPage = parseInt(args[++i], 10);
    else if (args[i] === '--models') modelFilter = args[++i].split(',');
    else if (args[i] === '--sizes') sizeFilter = args[++i].split(',').map((n) => parseInt(n, 10));
    else if (args[i] === '--page') pageFilter = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`judge-retrieval-rank.ts

Flags:
  --queries-per-page N   Number of (chunk, query) targets per page (default 10)
  --models a,b,c         Filter to model slugs (substring match)
  --sizes 1,16           Filter to batch sizes (default: all in bench output)
  --page SLUG            Only test this page slug
  --dry-run              Generate queries + report counts, no embeds
  --help, -h             This help

Env:
  GBRAIN_JUDGE_MODEL     Query-gen model (default anthropic:claude-opus-4-7)
`);
      process.exit(0);
    }
  }

  mkdirSync(REPORT_DIR, { recursive: true });

  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(1);
  }
  configureGateway(buildGatewayConfig(config));
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);

  console.log(`[rank] queries-per-page=${queriesPerPage} dry=${dryRun}`);

  const dirs = indexBenchDir();
  const filtered = modelFilter
    ? dirs.filter((d) => modelFilter!.some((f) => d.modelSlug.includes(f)))
    : dirs;
  console.log(`[rank] indexed ${dirs.length} model dirs, ${filtered.length} after filter`);

  const pagesAcrossModels = new Map<string, Set<string>>();
  for (const d of filtered) {
    for (const page of d.filesByPageAndB.keys()) {
      if (!pagesAcrossModels.has(page)) pagesAcrossModels.set(page, new Set());
      pagesAcrossModels.get(page)!.add(d.modelSlug);
    }
  }
  const eligiblePages = pageFilter
    ? [pageFilter]
    : [...pagesAcrossModels.entries()]
        .filter(([_, models]) => models.size >= 2)
        .map(([page]) => page);
  console.log(`[rank] eligible pages (>=2 models): ${eligiblePages.length}`);
  for (const p of eligiblePages) console.log(`    - ${p}`);

  const allCellResults: PerCellResult[] = [];
  const queryCache: Map<string, { chunk_index: number; query: string; chunk_text: string }[]> = new Map();

  for (const pageSlug of eligiblePages) {
    let sourceId = 'default';
    for (const d of filtered) {
      const pageFiles = d.filesByPageAndB.get(pageSlug);
      if (pageFiles) {
        const anyB = [...pageFiles.values()][0];
        sourceId = anyB.source_id;
        break;
      }
    }
    console.log(`\n[rank] === page: ${pageSlug.slice(-60)} (source=${sourceId}) ===`);

    const chunks = (await engine.getChunks(pageSlug, { sourceId })) as Array<{
      chunk_index: number;
      chunk_text: string;
      chunk_source: string;
    }>;
    const textChunks = chunks.filter((c) => c.chunk_source !== 'fenced_code');
    if (textChunks.length === 0) {
      console.log(`  skip: no text chunks`);
      continue;
    }

    const pageRow = await engine.getPage(pageSlug, { sourceId });
    if (!pageRow) {
      console.log(`  skip: page not found`);
      continue;
    }
    const title = pageRow.title;

    const targetIndices: number[] = [];
    const stride = Math.max(1, Math.floor(textChunks.length / queriesPerPage));
    for (let i = 0; i < textChunks.length && targetIndices.length < queriesPerPage; i += stride) {
      targetIndices.push(i);
    }

    console.log(`  generating ${targetIndices.length} queries via ${JUDGE_MODEL}...`);
    const queries: { chunk_index: number; query: string; chunk_text: string }[] = [];
    for (const idx of targetIndices) {
      const chunk = textChunks[idx];
      if (dryRun) {
        queries.push({ chunk_index: chunk.chunk_index, query: `(dry-run query for chunk ${chunk.chunk_index})`, chunk_text: chunk.chunk_text });
        continue;
      }
      try {
        const q = await generateQueryForChunk(chunk.chunk_text);
        queries.push({ chunk_index: chunk.chunk_index, query: q, chunk_text: chunk.chunk_text });
        console.log(`    chunk#${chunk.chunk_index}: "${q.slice(0, 80)}"`);
      } catch (err) {
        console.warn(`    chunk#${chunk.chunk_index}: query-gen failed: ${(err as Error).message.slice(0, 100)}`);
      }
    }
    queryCache.set(pageSlug, queries);
    if (queries.length === 0) continue;

    if (dryRun) {
      console.log(`  [dry] would test ${queries.length} queries across each (model, B) cell`);
      continue;
    }

    console.log(`  embedding ${queries.length} queries via production embedder...`);
    const queryTexts = queries.map((q) => q.query);
    const queryEmbeds = await gwEmbed(queryTexts);

    for (const d of filtered) {
      const pageFiles = d.filesByPageAndB.get(pageSlug);
      if (!pageFiles) continue;
      const sizesAvailable = [...pageFiles.keys()];
      const sizesToTest = sizeFilter ? sizesAvailable.filter((s) => sizeFilter!.includes(s)) : sizesAvailable;
      for (const B of sizesToTest) {
        const data = pageFiles.get(B);
        if (!data) continue;
        const synopsesByIdx = new Map<number, string>();
        for (const s of data.synopses) synopsesByIdx.set(s.chunk_index, s.synopsis);

        const wrappedTexts = textChunks.map((c) => {
          const syn = synopsesByIdx.get(c.chunk_index) ?? '';
          return wrapChunkForEmbedding(title, syn, c.chunk_text);
        });

        console.log(`    [${d.modelSlug} B=${B}] embedding ${wrappedTexts.length} wrapped chunks...`);
        const wrappedEmbeds = await gwEmbed(wrappedTexts);

        const chunkIdxToPos = new Map<number, number>();
        for (let i = 0; i < textChunks.length; i++) {
          chunkIdxToPos.set(textChunks[i].chunk_index, i);
        }

        const perQuery: QueryRank[] = [];
        for (let qi = 0; qi < queries.length; qi++) {
          const q = queries[qi];
          const targetPos = chunkIdxToPos.get(q.chunk_index);
          if (targetPos === undefined) continue;
          const r = rankTargetByCosine(queryEmbeds[qi], wrappedEmbeds, targetPos);
          perQuery.push({
            query: q.query,
            target_chunk_index: q.chunk_index,
            rank: r.rank,
            target_score: r.targetScore,
            top_score: r.topScore,
            score_gap: r.score_gap,
          });
        }

        const meanRank = perQuery.reduce((s, q) => s + q.rank, 0) / Math.max(1, perQuery.length);
        const rank1 = perQuery.filter((q) => q.rank === 1).length;
        const rank3 = perQuery.filter((q) => q.rank <= 3).length;
        const rank10 = perQuery.filter((q) => q.rank <= 10).length;

        allCellResults.push({
          model_slug: d.modelSlug,
          page_slug: pageSlug,
          batch_size: B,
          per_query_ranks: perQuery,
          mean_rank: meanRank,
          rank_1_count: rank1,
          rank_3_count: rank3,
          rank_10_count: rank10,
          total_chunks_in_page: textChunks.length,
        });
        console.log(
          `    [${d.modelSlug} B=${B}] mean_rank=${meanRank.toFixed(2)} rank1=${rank1}/${perQuery.length} rank<=3=${rank3} rank<=10=${rank10} (pop=${textChunks.length})`,
        );
      }
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const detailPath = resolve(REPORT_DIR, `rank-detail-${ts}.json`);
  writeFileSync(detailPath, JSON.stringify({ allCellResults, queries: [...queryCache.entries()] }, null, 2));

  const lines: string[] = [];
  lines.push(`# Retrieval-rank A/B report`);
  lines.push(``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Query-gen model: ${JUDGE_MODEL}`);
  lines.push(``);
  lines.push(`Rank = position of target chunk in cosine-similarity ranking of all wrapped chunks for that page.`);
  lines.push(`1 = perfect retrieval (target ranked first). Higher = worse retrieval.`);
  lines.push(``);
  lines.push(`| Model | Page | B | queries | mean rank | rank=1 | rank<=3 | rank<=10 | pop |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const c of allCellResults) {
    const pageShort = c.page_slug.length > 40 ? '...' + c.page_slug.slice(-37) : c.page_slug;
    lines.push(
      `| ${c.model_slug} | ${pageShort} | ${c.batch_size} | ${c.per_query_ranks.length} | ${c.mean_rank.toFixed(2)} | ${c.rank_1_count} | ${c.rank_3_count} | ${c.rank_10_count} | ${c.total_chunks_in_page} |`,
    );
  }
  lines.push(``);

  lines.push(`## Per-model summary (avg across pages)`);
  lines.push(``);
  lines.push(`| Model | B | total queries | mean rank | rank=1 % | rank<=3 % | rank<=10 % |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  const byModelB = new Map<string, PerCellResult[]>();
  for (const c of allCellResults) {
    const key = `${c.model_slug}|B${c.batch_size}`;
    if (!byModelB.has(key)) byModelB.set(key, []);
    byModelB.get(key)!.push(c);
  }
  for (const [key, cells] of [...byModelB.entries()].sort()) {
    const [model, bStr] = key.split('|');
    const totalQ = cells.reduce((s, c) => s + c.per_query_ranks.length, 0);
    if (totalQ === 0) continue;
    const totalRank = cells.reduce((s, c) => s + c.per_query_ranks.reduce((ss, q) => ss + q.rank, 0), 0);
    const totalRank1 = cells.reduce((s, c) => s + c.rank_1_count, 0);
    const totalRank3 = cells.reduce((s, c) => s + c.rank_3_count, 0);
    const totalRank10 = cells.reduce((s, c) => s + c.rank_10_count, 0);
    lines.push(
      `| ${model} | ${bStr} | ${totalQ} | ${(totalRank / totalQ).toFixed(2)} | ${((totalRank1 / totalQ) * 100).toFixed(0)}% | ${((totalRank3 / totalQ) * 100).toFixed(0)}% | ${((totalRank10 / totalQ) * 100).toFixed(0)}% |`,
    );
  }
  lines.push(``);

  lines.push(`## Files`);
  lines.push(`- Detail JSON: ${detailPath}`);
  lines.push(``);

  const reportPath = resolve(REPORT_DIR, `rank-report-${ts}.md`);
  writeFileSync(reportPath, lines.join('\n'));
  console.log(`\n[rank] report written: ${reportPath}`);
  console.log('\n' + lines.join('\n'));

  await engine.disconnect();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
