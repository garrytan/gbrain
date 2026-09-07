/**
 * lme-miss-diagnostics.ts — Phase B1 miss diagnostics for a LongMemEval
 * harness receipt (plan D27 "B1 locates causes before a fix is chosen").
 *
 * For every strict miss in the receipt (recall_all_hit=false; --all for every
 * scored question) the question's brain is re-created exactly as the harness
 * built it and each missing gold session is located per arm (vector /
 * keyword / title to depth 200, fused + post-rerank from one hybridSearch call
 * at limit 50 under the same pins), classified (i)-(iv), and probed for the
 * H1 signature, the counterfactual clause sub-queries, and the H3a/H3b split.
 * The core lives in src/eval/longmemeval/diagnostics.ts; this file owns argv,
 * gateway bootstrap, file I/O and printing. Not a `gbrain` subcommand — its
 * flags are outside the CLI flag registry by design.
 *
 * Usage:
 *   bun run scripts/lme-miss-diagnostics.ts <receipt.ndjson> --dataset FILE
 *     [--splits evals/longmemeval/splits-seed42.json]
 *     [--mode conservative|balanced|tokenmax] [--reranker on|off] [--autocut on|off]
 *     [--expansion-variant-budget legacy|B]
 *     [--embed-cache PATH | --no-embed-cache] [--k N] [--depth 200] [--fused-limit 50]
 *     [--all] [--question-ids FILE] [--limit N]
 *     [--out-ndjson FILE] [--out-md FILE] [--json]
 *
 * Pins default to the receipt's `run_config` (the by_type_summary line — the
 * harness writes them flat: mode, reranker, autocut, topK, ...); explicit flags
 * win. Spend: every page/question embed is a cache hit when
 * the receipt's cache is given; the clause sub-query embeds (≤ 2 per miss)
 * and, with --reranker on, one rerank call per miss are the only paid calls.
 *
 * Exit: 0 ok · 1 bad input / run error · 2 gateway or reranker not ready.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { configureGateway, getEmbeddingDimensions, getEmbeddingModel, isAvailable } from '../src/core/ai/gateway.ts';
import { rerankerReadinessForEngine } from '../src/core/ai/reranker-readiness-engine.ts';
import { describeRerankerFix } from '../src/core/ai/reranker-readiness.ts';
import { loadConfig, type GBrainConfig } from '../src/core/config.ts';
import { isSearchMode, type SearchMode } from '../src/core/search/mode.ts';
import type { LongMemEvalQuestion } from '../src/eval/longmemeval/adapter.ts';
import {
  DEFAULT_DEPTH,
  DEFAULT_FUSED_LIMIT,
  parseReceipt,
  pinsFromReceipt,
  renderDiagnosticsMarkdown,
  runDiagnostics,
  type DiagnosticsPins,
} from '../src/eval/longmemeval/diagnostics.ts';
import { withBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import { loadQuestionIds } from '../src/eval/longmemeval/run-config.ts';

const DEFAULT_EMBED_CACHE_PATH = join(homedir(), '.cache', 'gbrain-eval', 'longmemeval-embed.sqlite');

function usage(code: number): never {
  process.stderr.write(
    'usage: bun run scripts/lme-miss-diagnostics.ts <receipt.ndjson> --dataset FILE [--splits FILE]\n' +
      '         [--mode M] [--reranker on|off] [--autocut on|off] [--expansion-variant-budget legacy|B]\n' +
      '         [--embed-cache PATH | --no-embed-cache] [--k N] [--depth 200] [--fused-limit 50]\n' +
      '         [--all] [--question-ids FILE] [--limit N] [--out-ndjson FILE] [--out-md FILE] [--json]\n',
  );
  process.exit(code);
}

interface Args {
  receipt: string;
  dataset?: string;
  splits?: string;
  pins: DiagnosticsPins;
  embedCache: string | null;
  k?: number;
  depth: number;
  fusedLimit: number;
  all: boolean;
  questionIds?: string;
  limit?: number;
  outNdjson?: string;
  outMd?: string;
  json: boolean;
}

function onOff(flag: string, v: string): boolean {
  const s = v.trim().toLowerCase();
  if (s === 'on' || s === 'true' || s === '1') return true;
  if (s === 'off' || s === 'false' || s === '0') return false;
  throw new Error(`${flag} must be on|off (got ${v})`);
}

function posInt(flag: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer (got ${v})`);
  return n;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { receipt: '', pins: {}, embedCache: DEFAULT_EMBED_CACHE_PATH, depth: DEFAULT_DEPTH, fusedLimit: DEFAULT_FUSED_LIMIT, all: false, json: false };
  const need = (i: number, flag: string): string => {
    if (i + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': usage(0);
      case '--dataset': out.dataset = need(i, a); i++; break;
      case '--splits': out.splits = need(i, a); i++; break;
      case '--mode': {
        const m = need(i, a); i++;
        if (!isSearchMode(m)) throw new Error(`--mode must be conservative|balanced|tokenmax (got ${m})`);
        out.pins.mode = m;
        break;
      }
      case '--reranker': out.pins.reranker = onOff(a, need(i, a)); i++; break;
      case '--autocut': out.pins.autocut = onOff(a, need(i, a)); i++; break;
      case '--expansion-variant-budget': {
        const v = need(i, a).trim().toLowerCase(); i++;
        if (v === 'legacy' || v === 'null') out.pins.expansionVariantBudget = null;
        else {
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0 || n > 4) throw new Error(`--expansion-variant-budget must be legacy or a number in (0, 4] (got ${v})`);
          out.pins.expansionVariantBudget = n;
        }
        break;
      }
      case '--embed-cache': out.embedCache = need(i, a); i++; break;
      case '--no-embed-cache': out.embedCache = null; break;
      case '--k': out.k = posInt(a, need(i, a)); i++; break;
      case '--depth': out.depth = posInt(a, need(i, a)); i++; break;
      case '--fused-limit': out.fusedLimit = posInt(a, need(i, a)); i++; break;
      case '--all': out.all = true; break;
      case '--question-ids': out.questionIds = need(i, a); i++; break;
      case '--limit': out.limit = posInt(a, need(i, a)); i++; break;
      case '--out-ndjson': out.outNdjson = need(i, a); i++; break;
      case '--out-md': out.outMd = need(i, a); i++; break;
      case '--json': out.json = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
        if (out.receipt) throw new Error(`unexpected positional ${a}`);
        out.receipt = a;
    }
  }
  if (!out.receipt || !out.dataset) usage(2);
  return out;
}

function loadDataset(path: string): LongMemEvalQuestion[] {
  if (!existsSync(path)) throw new Error(`dataset not found: ${path}`);
  const raw = readFileSync(path, 'utf8');
  if (raw.trimStart().startsWith('[')) return JSON.parse(raw) as LongMemEvalQuestion[];
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as LongMemEvalQuestion);
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    usage(2);
  }

  // Gateway bootstrap — the cli.ts longmemeval path verbatim: ~/.gbrain/config.json
  // when present, else env (OPENAI_API_KEY / GBRAIN_EMBEDDING_MODEL / _DIMENSIONS).
  const config = loadConfig() ?? ({
    embedding_model: process.env.GBRAIN_EMBEDDING_MODEL,
    embedding_dimensions: process.env.GBRAIN_EMBEDDING_DIMENSIONS ? Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS) : undefined,
  } as GBrainConfig);
  configureGateway(buildGatewayConfig(config));
  if (!isAvailable('embedding')) {
    process.stderr.write('Error: no embedding provider is configured (set OPENAI_API_KEY + GBRAIN_EMBEDDING_MODEL / GBRAIN_EMBEDDING_DIMENSIONS, or a ~/.gbrain/config.json).\n');
    process.exit(2);
  }

  if (!existsSync(args.receipt)) { process.stderr.write(`Error: receipt not found: ${args.receipt}\n`); process.exit(1); }
  const receipt = parseReceipt(readFileSync(args.receipt, 'utf8'));
  if (receipt.rows.length === 0) { process.stderr.write(`Error: no question rows in ${args.receipt}\n`); process.exit(1); }
  let questions: LongMemEvalQuestion[];
  try {
    questions = loadDataset(args.dataset!);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const splits = args.splits ? (JSON.parse(readFileSync(args.splits, 'utf8')) as Record<string, unknown>) : null;
  const questionIds = args.questionIds ? new Set(loadQuestionIds(args.questionIds)) : null;

  // Pins: explicit flags > receipt run_config (flat, as buildRunConfig writes it) > (mode) balanced with a warning.
  const rp = pinsFromReceipt(receipt);
  const pins: DiagnosticsPins = { ...args.pins };
  if (pins.mode === undefined && isSearchMode(rp.mode)) pins.mode = rp.mode as SearchMode;
  if (pins.reranker === undefined && typeof rp.reranker?.enabled === 'boolean') pins.reranker = rp.reranker.enabled;
  if (pins.autocut === undefined && typeof rp.autocut === 'boolean') pins.autocut = rp.autocut;
  if (pins.expansionVariantBudget === undefined && rp.expansion_variant_budget !== undefined) pins.expansionVariantBudget = rp.expansion_variant_budget;
  if (pins.mode === undefined) process.stderr.write('[lme-diag] WARN no --mode and no pins in the receipt summary; resolving through the balanced bundle\n');
  const embedder = `${getEmbeddingModel()}@${getEmbeddingDimensions()}`;
  if (rp.embedder && rp.embedder !== embedder) {
    process.stderr.write(`[lme-diag] WARN receipt embedder ${rp.embedder} != configured ${embedder}; vectors will NOT be like-for-like\n`);
  }
  const misses = receipt.rows.filter(r => r.recall_all_hit === false && !r.error && r.abstention !== true).length;
  process.stderr.write(
    `[lme-diag] receipt ${args.receipt}: ${receipt.rows.length} rows, ${misses} strict misses; pins mode=${pins.mode ?? 'balanced'} ` +
      `reranker=${pins.reranker === undefined ? 'unpinned' : pins.reranker ? 'on' : 'off'} autocut=${pins.autocut === undefined ? 'unpinned' : pins.autocut ? 'on' : 'off'} ` +
      `budget=${pins.expansionVariantBudget === undefined ? 'unpinned' : pins.expansionVariantBudget ?? 'legacy'}; embedder ${embedder}; ` +
      `cache ${args.embedCache ?? 'off'}; depth ${args.depth}; fused limit ${args.fusedLimit}${args.all ? '; --all' : ''}\n`,
  );

  const started = Date.now();
  const result = await withBenchmarkBrain(async (engine) => {
    if (pins.reranker === true) {
      const { resolveSearchMode } = await import('../src/core/search/mode.ts');
      const knobs = resolveSearchMode({ mode: pins.mode, perCall: { reranker_enabled: true } });
      const r = await rerankerReadinessForEngine(engine, knobs.reranker_model);
      if (!r.readiness.ready) {
        process.stderr.write(`[lme-diag] reranker not ready (${r.plane} plane): ${describeRerankerFix(r.readiness) ?? 'not ready'}\n`);
        process.exit(2);
      }
    }
    return runDiagnostics({
      engine,
      receipt,
      questions,
      splits,
      pins,
      k: args.k,
      depth: args.depth,
      fusedLimit: args.fusedLimit,
      all: args.all,
      embedCachePath: args.embedCache,
      questionIds,
      limit: args.limit,
      onProgress: (done, total, qid) => process.stderr.write(`[lme-diag] ${done}/${total} ${qid}\n`),
    });
  });

  const ndjson = result.rows.map(r => JSON.stringify(r)).concat(JSON.stringify(result.summary)).join('\n') + '\n';
  const md = renderDiagnosticsMarkdown(result.rows, result.summary);
  if (args.outNdjson) writeFileSync(args.outNdjson, ndjson, 'utf8');
  if (args.outMd) writeFileSync(args.outMd, md, 'utf8');
  if (args.json) process.stdout.write(ndjson);
  else if (!args.outMd) process.stdout.write(md);
  const s = result.summary;
  process.stderr.write(
    `[lme-diag] done in ${Math.round((Date.now() - started) / 1000)}s: ${s.questions_diagnosed} diagnosed, ${s.misses} misses, ${s.errors} errors; ` +
      `classes ${JSON.stringify(s.gold_sessions_by_class)}; H1sig ${s.h1_signature_count}, split ${s.splitter_fired}/${s.splitter_supported} supported, ` +
      `H3a ${s.h3a_count}, H3b ${s.h3b_count}` +
      (s.cache ? `; cache ${s.cache.hits} hits / ${s.cache.misses} misses` : '') +
      (args.outNdjson ? `; ndjson → ${args.outNdjson}` : '') + (args.outMd ? `; md → ${args.outMd}` : '') + '\n',
  );
  if (s.errors > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`Error: ${(err as Error)?.stack ?? err}\n`);
  process.exit(1);
});
