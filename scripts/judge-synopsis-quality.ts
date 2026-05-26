#!/usr/bin/env bun
/**
 * LLM-as-judge for synopsis quality.
 *
 * Reads bench output files from /tmp/bench-synopsis-out/{model_slug}/{bucket}-B{N}.json
 * (produced by scripts/bench-batched-synopsis.ts), re-fetches full chunk text from
 * the brain DB, then calls anthropic:claude-opus-4-7 to score each
 * (chunk, synopsis) pair on three dimensions:
 *
 *   accuracy           — does the synopsis correctly describe the chunk?
 *   specificity        — does it use chunk-specific entities vs generic terms?
 *   retrieval_utility  — would a user query for the chunk find it via this synopsis?
 *
 * Each dimension 1-5. Output JSON envelope per pair. Aggregates per (model, B, page)
 * with mean + min + count-below-threshold.
 *
 * Frontier model required because the question is essentially "did the smaller
 * model do the job well." Sonnet judging Gemma's output is suspect at the margin;
 * Opus gives stable ground-truth.
 *
 * Usage:
 *   bun run scripts/judge-synopsis-quality.ts [--bench-dir DIR] [--limit-per-page N] [--dry-run]
 *
 * Cost estimate (Opus 4.7 = $5/$25 per MTok):
 *   ~830 input + ~80 output tokens per pair
 *   For 3 models × 30 pages × ~7 chunks avg × 2 sizes ≈ 1200 pairs ≈ ~$7-10.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import {
  configureGateway,
  chat as gwChat,
  type AIGatewayConfig,
} from '../src/core/ai/gateway.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const JUDGE_MODEL = process.env.GBRAIN_JUDGE_MODEL ?? 'anthropic:claude-opus-4-7';
const BENCH_DIR = '/tmp/bench-synopsis-out';
const REPORT_DIR = '/tmp/judge-synopsis-quality-out';
const CHUNK_PREVIEW_CHARS = 2000;

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

const SYSTEM_PROMPT = [
  'You are evaluating a one-sentence synopsis written about a chunk of a document.',
  'The synopsis is wrapped around the chunk before embedding to help retrieval search',
  'surface the chunk when a user queries for its content.',
  '',
  'Score on THREE dimensions, each 1-5 (5 = best):',
  '',
  'ACCURACY: Does the synopsis correctly describe what the chunk is about?',
  '  5 = entirely accurate, no hallucinated claims, captures the chunk\'s subject',
  '  4 = mostly accurate, minor inaccuracies',
  '  3 = somewhat accurate, mixes correct and incorrect details',
  '  2 = mostly wrong, but mentions something from the chunk',
  '  1 = wrong, or describes a different chunk entirely',
  '',
  'SPECIFICITY: Does it use chunk-specific terms (entities, identifiers, technical names, dates)',
  'rather than generic descriptions that could apply to many chunks?',
  '  5 = names exact entities/concepts/tokens that uniquely identify this chunk',
  '  3 = mentions the topic area but not specifics',
  '  1 = generic, could apply to almost any chunk in the document',
  '',
  'RETRIEVAL_UTILITY: Would a user searching for content from this chunk find it via this synopsis?',
  'Consider: are the query terms a user would type present in the synopsis?',
  '  5 = strong query terms, would rank high on user queries about this chunk',
  '  3 = some query terms present, partial match likely',
  '  1 = no useful query terms, retrieval would miss this',
  '',
  'Reply ONLY with one line of JSON. No prose, no markdown fences. Schema:',
  '{"accuracy":N,"specificity":N,"retrieval_utility":N,"rationale":"<short>"}',
].join('\n');

function buildUserPrompt(chunkText: string, synopsis: string): string {
  const trimmedChunk = chunkText.length > CHUNK_PREVIEW_CHARS
    ? chunkText.slice(0, CHUNK_PREVIEW_CHARS) + `\n[... ${chunkText.length - CHUNK_PREVIEW_CHARS} more chars ...]`
    : chunkText;
  return [
    '<chunk>',
    trimmedChunk,
    '</chunk>',
    '',
    '<synopsis>',
    synopsis,
    '</synopsis>',
    '',
    'Output JSON only:',
  ].join('\n');
}

interface JudgeScore {
  accuracy: number;
  specificity: number;
  retrieval_utility: number;
  rationale: string;
}

function parseJudgeReply(raw: string): JudgeScore | { error: string; raw: string } {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (
      typeof parsed.accuracy === 'number' &&
      typeof parsed.specificity === 'number' &&
      typeof parsed.retrieval_utility === 'number'
    ) {
      return {
        accuracy: Math.max(1, Math.min(5, parsed.accuracy)),
        specificity: Math.max(1, Math.min(5, parsed.specificity)),
        retrieval_utility: Math.max(1, Math.min(5, parsed.retrieval_utility)),
        rationale: String(parsed.rationale ?? '').slice(0, 200),
      };
    }
    return { error: 'missing fields', raw: cleaned.slice(0, 300) };
  } catch (err) {
    return { error: `parse: ${(err as Error).message}`, raw: cleaned.slice(0, 300) };
  }
}

interface PerPairResult {
  chunk_index: number;
  synopsis: string;
  chunk_text_first_120: string;
  score: JudgeScore | null;
  parse_error: string | null;
  parse_raw: string | null;
  wall_ms: number;
}

interface PerFileResult {
  model: string;
  bucket: string;
  batch_size: number;
  page_slug: string;
  source_id: string;
  chunk_count_total: number;
  pairs_judged: number;
  pairs_skipped_empty: number;
  pairs: PerPairResult[];
  aggregates: {
    accuracy_mean: number | null;
    accuracy_min: number | null;
    accuracy_below_3: number;
    specificity_mean: number | null;
    specificity_min: number | null;
    specificity_below_3: number;
    retrieval_utility_mean: number | null;
    retrieval_utility_min: number | null;
    retrieval_utility_below_3: number;
    parse_failures: number;
  };
  cost_estimate_usd: number;
  total_judge_wall_ms: number;
}

interface BenchFile {
  page_slug: string;
  source_id: string;
  batch_size: number;
  chunk_count: number;
  synopses: Array<{ chunk_index: number; chunk_text_preview: string; synopsis: string }>;
}

async function judgeFile(
  engine: BrainEngine,
  filePath: string,
  modelSlug: string,
  limitPerPage: number | null,
  dryRun: boolean,
): Promise<PerFileResult | null> {
  const raw = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as BenchFile;
  const fileName = basename(filePath, '.json');
  const bucket = fileName.replace(/-B\d+$/, '');
  const batchSize = data.batch_size;

  const chunks = (await engine.getChunks(data.page_slug, { sourceId: data.source_id })) as Array<{
    chunk_index: number;
    chunk_text: string;
    chunk_source: string;
  }>;
  const chunksByIndex = new Map<number, string>();
  for (const c of chunks) chunksByIndex.set(c.chunk_index, c.chunk_text);

  const nonEmpty = data.synopses.filter((s) => s.synopsis && s.synopsis.length > 0);
  if (nonEmpty.length === 0) {
    console.log(`  [skip] ${fileName}: no non-empty synopses`);
    return null;
  }

  let toJudge = nonEmpty;
  if (limitPerPage !== null && nonEmpty.length > limitPerPage) {
    toJudge = nonEmpty.slice(0, limitPerPage);
  }

  const pairs: PerPairResult[] = [];
  let totalWall = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const s of toJudge) {
    const chunkText = chunksByIndex.get(s.chunk_index);
    if (!chunkText) {
      pairs.push({
        chunk_index: s.chunk_index,
        synopsis: s.synopsis,
        chunk_text_first_120: '(missing from DB)',
        score: null,
        parse_error: 'chunk-not-in-db',
        parse_raw: null,
        wall_ms: 0,
      });
      continue;
    }
    if (dryRun) {
      console.log(`    [dry] chunk ${s.chunk_index}: synopsis="${s.synopsis.slice(0, 80)}..."`);
      pairs.push({
        chunk_index: s.chunk_index,
        synopsis: s.synopsis,
        chunk_text_first_120: chunkText.slice(0, 120),
        score: null,
        parse_error: 'dry-run',
        parse_raw: null,
        wall_ms: 0,
      });
      continue;
    }
    const userPrompt = buildUserPrompt(chunkText, s.synopsis);
    const t0 = performance.now();
    let reply: string;
    let inTok = 0;
    let outTok = 0;
    try {
      const res = await gwChat({
        model: JUDGE_MODEL,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 200,
      });
      reply = res.text;
      inTok = res.usage.input_tokens;
      outTok = res.usage.output_tokens;
    } catch (err) {
      const wall = Math.round(performance.now() - t0);
      pairs.push({
        chunk_index: s.chunk_index,
        synopsis: s.synopsis,
        chunk_text_first_120: chunkText.slice(0, 120),
        score: null,
        parse_error: `chat-throw: ${(err as Error).message.slice(0, 200)}`,
        parse_raw: null,
        wall_ms: wall,
      });
      continue;
    }
    const wall = Math.round(performance.now() - t0);
    totalWall += wall;
    totalInputTokens += inTok;
    totalOutputTokens += outTok;
    const parsed = parseJudgeReply(reply);
    if ('error' in parsed) {
      pairs.push({
        chunk_index: s.chunk_index,
        synopsis: s.synopsis,
        chunk_text_first_120: chunkText.slice(0, 120),
        score: null,
        parse_error: parsed.error,
        parse_raw: parsed.raw,
        wall_ms: wall,
      });
    } else {
      pairs.push({
        chunk_index: s.chunk_index,
        synopsis: s.synopsis,
        chunk_text_first_120: chunkText.slice(0, 120),
        score: parsed,
        parse_error: null,
        parse_raw: null,
        wall_ms: wall,
      });
    }
  }

  const scored = pairs.filter((p) => p.score !== null).map((p) => p.score!);
  const acc = scored.map((s) => s.accuracy);
  const spec = scored.map((s) => s.specificity);
  const util = scored.map((s) => s.retrieval_utility);
  const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  const min = (xs: number[]) => (xs.length === 0 ? null : Math.min(...xs));
  const below3 = (xs: number[]) => xs.filter((x) => x < 3).length;

  const aggregates = {
    accuracy_mean: mean(acc),
    accuracy_min: min(acc),
    accuracy_below_3: below3(acc),
    specificity_mean: mean(spec),
    specificity_min: min(spec),
    specificity_below_3: below3(spec),
    retrieval_utility_mean: mean(util),
    retrieval_utility_min: min(util),
    retrieval_utility_below_3: below3(util),
    parse_failures: pairs.filter((p) => p.parse_error !== null && p.parse_error !== 'dry-run').length,
  };

  // Opus 4.7 pricing: $5/MTok input, $25/MTok output
  const cost = (totalInputTokens * 5) / 1_000_000 + (totalOutputTokens * 25) / 1_000_000;

  console.log(
    `  ${fileName}: ${pairs.length} pairs, acc_mean=${aggregates.accuracy_mean?.toFixed(2) ?? 'n/a'}, spec_mean=${aggregates.specificity_mean?.toFixed(2) ?? 'n/a'}, util_mean=${aggregates.retrieval_utility_mean?.toFixed(2) ?? 'n/a'}, cost=$${cost.toFixed(3)}, wall=${Math.round(totalWall / 1000)}s`,
  );

  return {
    model: modelSlug,
    bucket,
    batch_size: batchSize,
    page_slug: data.page_slug,
    source_id: data.source_id,
    chunk_count_total: data.chunk_count,
    pairs_judged: pairs.length,
    pairs_skipped_empty: data.synopses.length - nonEmpty.length,
    pairs,
    aggregates,
    cost_estimate_usd: cost,
    total_judge_wall_ms: totalWall,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let limitPerPage: number | null = null;
  let dryRun = false;
  let modelFilter: string | null = null;
  let benchDir = BENCH_DIR;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit-per-page') limitPerPage = parseInt(args[++i], 10);
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--model') modelFilter = args[++i];
    else if (args[i] === '--bench-dir') benchDir = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`judge-synopsis-quality.ts

Flags:
  --bench-dir DIR        Bench output root (default ${BENCH_DIR})
  --limit-per-page N     Cap pairs judged per file (default: all)
  --model SLUG           Only judge files under this model dir (slug match)
  --dry-run              List pairs without calling judge
  --help, -h             This help

Env:
  GBRAIN_JUDGE_MODEL     Judge model (default anthropic:claude-opus-4-7)

Cost (Opus 4.7 = $5/$25 per MTok): ~$0.006 per pair.
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

  console.log(`[judge] model=${JUDGE_MODEL} bench-dir=${benchDir} limit-per-page=${limitPerPage ?? 'all'} dry=${dryRun}`);

  const modelDirs = readdirSync(benchDir).filter((d) => {
    if (modelFilter && !d.includes(modelFilter)) return false;
    return !d.startsWith('.');
  });

  const allResults: PerFileResult[] = [];
  let totalCost = 0;
  for (const modelDir of modelDirs) {
    const modelPath = resolve(benchDir, modelDir);
    let files: string[] = [];
    try {
      files = readdirSync(modelPath).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    console.log(`\n[judge] === model: ${modelDir} ===`);
    for (const f of files) {
      const result = await judgeFile(engine, resolve(modelPath, f), modelDir, limitPerPage, dryRun);
      if (result) {
        allResults.push(result);
        totalCost += result.cost_estimate_usd;
      }
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const detailPath = resolve(REPORT_DIR, `judge-detail-${ts}.json`);
  writeFileSync(detailPath, JSON.stringify(allResults, null, 2));

  const lines: string[] = [];
  lines.push(`# LLM-as-judge synopsis quality report`);
  lines.push(``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Judge model: ${JUDGE_MODEL}`);
  lines.push(`Total cost: $${totalCost.toFixed(3)}`);
  lines.push(``);
  lines.push(`Scores 1-5 per dimension. Higher = better. \`<3 count\` = pairs scored below 3 (concerning).`);
  lines.push(``);
  lines.push(`| Model | Page | B | pairs | acc mean | acc min | acc <3 | spec mean | spec min | spec <3 | util mean | util min | util <3 | parse fail |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of allResults) {
    const a = r.aggregates;
    lines.push(
      `| ${r.model} | ${r.bucket} | ${r.batch_size} | ${r.pairs_judged} | ${a.accuracy_mean?.toFixed(2) ?? 'n/a'} | ${a.accuracy_min ?? 'n/a'} | ${a.accuracy_below_3} | ${a.specificity_mean?.toFixed(2) ?? 'n/a'} | ${a.specificity_min ?? 'n/a'} | ${a.specificity_below_3} | ${a.retrieval_utility_mean?.toFixed(2) ?? 'n/a'} | ${a.retrieval_utility_min ?? 'n/a'} | ${a.retrieval_utility_below_3} | ${a.parse_failures} |`,
    );
  }
  lines.push(``);

  lines.push(`## Per-model summary`);
  lines.push(``);
  lines.push(`| Model | Avg accuracy | Avg specificity | Avg retrieval-utility | Total <3 |`);
  lines.push(`|---|---|---|---|---|`);
  const byModel = new Map<string, PerFileResult[]>();
  for (const r of allResults) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model)!.push(r);
  }
  for (const [model, results] of byModel) {
    const allScores = results.flatMap((r) => r.pairs.filter((p) => p.score).map((p) => p.score!));
    if (allScores.length === 0) {
      lines.push(`| ${model} | n/a | n/a | n/a | n/a |`);
      continue;
    }
    const avgAcc = allScores.reduce((s, x) => s + x.accuracy, 0) / allScores.length;
    const avgSpec = allScores.reduce((s, x) => s + x.specificity, 0) / allScores.length;
    const avgUtil = allScores.reduce((s, x) => s + x.retrieval_utility, 0) / allScores.length;
    const totalBelow3 = allScores.filter(
      (x) => x.accuracy < 3 || x.specificity < 3 || x.retrieval_utility < 3,
    ).length;
    lines.push(
      `| ${model} | ${avgAcc.toFixed(2)} | ${avgSpec.toFixed(2)} | ${avgUtil.toFixed(2)} | ${totalBelow3} |`,
    );
  }
  lines.push(``);

  lines.push(`## Concerning pairs (any dim < 3)`);
  lines.push(``);
  let badCount = 0;
  for (const r of allResults) {
    for (const p of r.pairs) {
      if (!p.score) continue;
      const minScore = Math.min(p.score.accuracy, p.score.specificity, p.score.retrieval_utility);
      if (minScore < 3) {
        badCount++;
        if (badCount <= 30) {
          lines.push(`- **${r.model} ${r.bucket} B=${r.batch_size} chunk#${p.chunk_index}** (acc=${p.score.accuracy}, spec=${p.score.specificity}, util=${p.score.retrieval_utility})`);
          lines.push(`  - chunk: \`${p.chunk_text_first_120.replace(/\n/g, ' ').slice(0, 100)}...\``);
          lines.push(`  - synopsis: "${p.synopsis}"`);
          lines.push(`  - rationale: ${p.score.rationale}`);
        }
      }
    }
  }
  if (badCount === 0) lines.push(`(none — every pair scored >= 3 on every dimension)`);
  else if (badCount > 30) lines.push(`\n(${badCount - 30} more truncated; see ${detailPath})`);
  lines.push(``);

  lines.push(`## Files`);
  lines.push(`- Detail JSON: ${detailPath}`);
  lines.push(``);

  const reportPath = resolve(REPORT_DIR, `judge-report-${ts}.md`);
  writeFileSync(reportPath, lines.join('\n'));
  console.log(`\n[judge] report written: ${reportPath}`);
  console.log(`[judge] detail written: ${detailPath}`);
  console.log(`[judge] total cost: $${totalCost.toFixed(3)}`);
  console.log('\n' + lines.join('\n'));

  await engine.disconnect();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
