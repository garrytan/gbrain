/**
 * gbrain eval cross-modal — multi-model quality gate (v0.27.x).
 *
 * Three different-provider frontier models score the OUTPUT against the TASK
 * on a fixed dimension list. Verdict: PASS (exit 0) / FAIL (exit 1) /
 * INCONCLUSIVE (exit 2; <2/3 model successes).
 *
 * Reuses `src/core/ai/gateway.ts` for provider config + auth (T1+T2). Bypasses
 * `connectEngine()` via the cli.ts no-DB branch (T3=A) so onboarding works
 * before `gbrain init`. Receipts are bound to (slug, SKILL.md sha-8) so
 * `gbrain skillify check` can detect stale audits (T10=A).
 *
 * Cost guardrails (T11=B):
 *   - Default cycles = 3 in TTY, 1 in non-TTY (limits scripted bulk spend).
 *   - Cost-estimate prints to stderr before each cycle.
 *   - `--budget-usd` hard cap is a v0.27.x follow-up TODO.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

import { gbrainPath, loadConfig } from '../core/config.ts';
import { configureGateway, isAvailable } from '../core/ai/gateway.ts';
import { runWithLimit } from '../core/worker-pool.ts';
import { resolveCycleDefault, cycleDefaultSuffix } from '../core/eval/cycle-default.ts';
import {
  DEFAULT_DIMENSIONS,
  DEFAULT_SLOTS,
  estimateCost,
  runEval,
} from '../core/cross-modal-eval/runner.ts';
import type {
  ProgressEvent,
  RunEvalResult,
  SlotConfig,
} from '../core/cross-modal-eval/runner.ts';

const HELP = `gbrain eval cross-modal — multi-model quality gate

USAGE:
  gbrain eval cross-modal --task "<description>" --output <path-or-skill-slug> [flags]
  gbrain eval cross-modal --batch <jsonl> [--limit N] [--output <receipt-path>] [flags]   (v0.40.1.0 Track D)

REQUIRED (single-task mode):
  --task "..."             What the OUTPUT was meant to achieve.
  --output <path>          File whose content gets scored. Pass a skill slug
                           shortcut (e.g. \`--output skills/my-skill/SKILL.md\`)
                           to bind the receipt to that skill (T10).

REQUIRED (batch mode, v0.40.1.0 Track D / T3):
  --batch <jsonl>          LongMemEval-shape JSONL (output of \`gbrain eval
                           longmemeval --output\`). Each row: {question, hypothesis,
                           question_id, ...}. Summary rows (kind:by_type_summary)
                           are filtered out. Mutually exclusive with --task.

BATCH FLAGS:
  --limit N                Slice the first N rows (default 10).
  --concurrent N           Semaphore cap; max N questions in-flight at once
                           (default 3, ceiling = 3 questions x 3 model slots =
                           9 parallel API calls). Per D6.
  --max-usd FLOAT          Refuse to start if estimated cost exceeds this
                           ceiling without --yes (default 5.00). Per D10.
  --yes                    Bypass the --max-usd refusal. Required for
                           non-interactive (CI / cron) runs over the budget.
  --output PATH            Where to write the SUMMARY receipt (NOT where to
                           read agent response). Default:
                           ~/.gbrain/eval-receipts/cross-modal-batch-<sha8>.json

FLAGS:
  --slug <name>            Receipt filename slug. Defaults to inferred slug
                           from --output path (skills/<slug>/SKILL.md → <slug>),
                           or a content sha for ad-hoc inputs.
  --dimensions "d1,d2,..." Comma-separated dimension list. Default: 5 standard
                           dimensions (goal, depth, sourcing, specificity, useful).
  --cycles N               1-3. Default: 3 in TTY, 1 in non-TTY (T11). Each
                           cycle is 3 model calls; verdict aggregates over them.
  --slot-a-model <id>      Override default 'openai:gpt-4o'.
  --slot-b-model <id>      Override default 'anthropic:claude-opus-4-7'.
  --slot-c-model <id>      Override default 'google:gemini-1.5-pro'.
  --receipt-dir <path>     Default: gbrainPath('eval-receipts').
  --max-tokens N           Output token budget per call. Default: 4000.
  --json                   Emit final aggregate as JSON to stdout (progress to stderr).
  --help, -h               Show this help.

EXIT CODES:
  0  PASS  — every dim mean >=7 AND no model scored any dim <5.
  1  FAIL  — at least one dim mean <7 OR at least one model scored a dim <5.
  2  INCONCLUSIVE — fewer than 2/3 models returned parseable scores. Receipt
     is still written for forensics; the gate is not authoritative.

CONFIGURATION:
  Models resolve via the gbrain AI gateway. Configure with:
    gbrain providers test            # see what's configured
    gbrain config                    # set keys
  Or set env vars: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY,
  TOGETHER_API_KEY, etc. The gateway reads from \`~/.gbrain/config.json\` plus
  process.env.

EXAMPLES:
  gbrain eval cross-modal \\
    --task "Skillify SKILL.md teaches the 11-item meta-skill checklist" \\
    --output skills/skillify/SKILL.md

  gbrain eval cross-modal \\
    --task "PR description sells the value of cross-modal eval" \\
    --output /tmp/pr-description.md \\
    --cycles 1
`;

interface ParsedArgs {
  help: boolean;
  task?: string;
  output?: string;
  slug?: string;
  dimensions?: string[];
  cycles?: number;
  slotAModel?: string;
  slotBModel?: string;
  slotCModel?: string;
  receiptDir?: string;
  maxTokens?: number;
  json: boolean;
  // v0.40.1.0 Track D / T3 — batch mode over LongMemEval-shape JSONL.
  batch?: string;
  limit?: number;
  concurrent?: number;
  maxUsd?: number;
  yes: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, json: false, yes: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--task':
        if (next === undefined) break;
        out.task = next;
        i++;
        break;
      case '--output':
        if (next === undefined) break;
        out.output = next;
        i++;
        break;
      case '--batch':
        if (next === undefined) break;
        out.batch = next;
        i++;
        break;
      case '--limit':
        if (next === undefined) break;
        out.limit = parseIntStrict(next);
        i++;
        break;
      case '--concurrent':
        if (next === undefined) break;
        out.concurrent = parseIntStrict(next);
        i++;
        break;
      case '--max-usd':
        if (next === undefined) break;
        out.maxUsd = parseFloatStrict(next);
        i++;
        break;
      case '--yes':
        out.yes = true;
        break;
      case '--slug':
        if (next === undefined) break;
        out.slug = next;
        i++;
        break;
      case '--dimensions':
        if (next === undefined) break;
        out.dimensions = next.split(',').map(s => s.trim()).filter(Boolean);
        i++;
        break;
      case '--cycles':
        if (next === undefined) break;
        out.cycles = parseIntStrict(next);
        i++;
        break;
      case '--slot-a-model':
        if (next === undefined) break;
        out.slotAModel = next;
        i++;
        break;
      case '--slot-b-model':
        if (next === undefined) break;
        out.slotBModel = next;
        i++;
        break;
      case '--slot-c-model':
        if (next === undefined) break;
        out.slotCModel = next;
        i++;
        break;
      case '--receipt-dir':
        if (next === undefined) break;
        out.receiptDir = next;
        i++;
        break;
      case '--max-tokens':
        if (next === undefined) break;
        out.maxTokens = parseIntStrict(next);
        i++;
        break;
      case '--json':
        out.json = true;
        break;
    }
  }
  return out;
}

function parseIntStrict(s: string): number {
  const m = String(s).trim();
  if (!/^\d+$/.test(m)) {
    throw new Error(`expected positive integer, got: ${s}`);
  }
  return parseInt(m, 10);
}

function parseFloatStrict(s: string): number {
  const m = String(s).trim();
  const n = Number(m);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`expected non-negative number, got: ${s}`);
  }
  return n;
}

// v0.41.15.0 (T4) — `runWithLimit` migrated to the shared worker-pool
// helper at src/core/worker-pool.ts. Re-exported here so callers that
// import from eval-cross-modal.ts keep working without a shim. The
// helper's API is opts-object shape — callers that built against the
// pre-v0.41.15 positional signature must update at the call site
// (no back-compat overload; codex #15).
export { runWithLimit };

function inferSlugFromOutputPath(path: string): string | undefined {
  // skills/<slug>/SKILL.md or .../skills/<slug>/...
  const m = path.replace(/\\/g, '/').match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/);
  return m ? m[1] : undefined;
}

function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * Configure the AI gateway from `~/.gbrain/config.json` + process.env.
 *
 * Mirrors the body of `cli.ts:connectEngine()` minus the DB connect — we call
 * this from the no-DB branch so the gateway is ready when runEval starts.
 * Returns true on success; false (and prints a hint) when no config is found.
 */
function configureGatewayForCli(): boolean {
  const config = loadConfig();
  if (!config) {
    // No config file is fine for the eval command — env vars alone may serve.
    // We still call configureGateway so gateway recipes can read the env map.
    configureGateway({
      embedding_model: undefined,
      embedding_dimensions: undefined,
      expansion_model: undefined,
      chat_model: undefined,
      chat_fallback_chain: undefined,
      base_urls: undefined,
      env: { ...process.env },
    });
    return true;
  }
  configureGateway({
    embedding_model: config.embedding_model,
    embedding_dimensions: config.embedding_dimensions,
    expansion_model: config.expansion_model,
    chat_model: config.chat_model,
    chat_fallback_chain: config.chat_fallback_chain,
    base_urls: config.provider_base_urls,
    env: { ...process.env },
  });
  return true;
}

/**
 * v0.40.1.0 Track D / T3 (per D5) — DI seam for hermetic batch tests.
 * Mirrors the `runEvalLongMemEval(args, {client?})` pattern at
 * eval-longmemeval.ts:299. Default code path uses the imported runEval;
 * tests pass `opts.runEval` returning canned RunEvalResult.
 */
export interface RunCrossModalOpts {
  runEval?: typeof runEval;
}

export async function runEvalCrossModal(args: string[], opts: RunCrossModalOpts = {}): Promise<number> {
  const parsed = parseArgs(args);

  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // v0.40.1.0 Track D / T3 — --batch vs --task mutex.
  if (parsed.batch && parsed.task) {
    process.stderr.write('Error: --batch and --task are mutually exclusive\n');
    return 1;
  }

  // Batch path — short-circuit before the single-task validation below.
  if (parsed.batch) {
    return runBatchMode(parsed, opts);
  }

  if (!parsed.task) {
    process.stderr.write('Error: --task "<description>" is required (or --batch <jsonl>)\n\n');
    process.stderr.write(HELP);
    return 1;
  }
  if (!parsed.output) {
    process.stderr.write('Error: --output <path> is required\n\n');
    process.stderr.write(HELP);
    return 1;
  }

  if (!existsSync(parsed.output)) {
    process.stderr.write(`Error: --output path not found: ${parsed.output}\n`);
    return 1;
  }

  const outputContent = readFileSync(parsed.output, 'utf-8');
  if (outputContent.trim().length === 0) {
    process.stderr.write(`Error: --output file is empty: ${parsed.output}\n`);
    return 1;
  }

  const slug = parsed.slug ?? inferSlugFromOutputPath(parsed.output);
  // #1784: resolve the cycle default once; annotate the cost banner below when
  // it's the silent non-TTY fallback so the 1-vs-3 difference isn't a surprise.
  const cycleDef = resolveCycleDefault(parsed.cycles, isTTY());
  const cycles = cycleDef.cycles;
  const dimensions = parsed.dimensions ?? DEFAULT_DIMENSIONS;
  const receiptDir = parsed.receiptDir ?? gbrainPath('eval-receipts');
  const maxTokens = parsed.maxTokens ?? 4000;

  const slots: SlotConfig[] = [
    { id: 'A', model: parsed.slotAModel ?? DEFAULT_SLOTS[0]!.model },
    { id: 'B', model: parsed.slotBModel ?? DEFAULT_SLOTS[1]!.model },
    { id: 'C', model: parsed.slotCModel ?? DEFAULT_SLOTS[2]!.model },
  ];

  // Configure the AI gateway. Without this, every chat() call throws
  // "AI gateway is not configured" because the cli.ts no-DB branch skips
  // connectEngine (T3=A).
  configureGatewayForCli();

  // Probe whether the gateway can serve `chat`. If not, we can't run.
  if (!isAvailable('chat')) {
    process.stderr.write(
      'Error: AI gateway has no usable chat provider. ' +
        'Configure one of OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY ' +
        'in your shell or run `gbrain config` to set keys.\n',
    );
    return 1;
  }

  // Cost estimate (T11=B).
  const cost = estimateCost(slots, cycles, maxTokens);
  process.stderr.write(
    `[eval cross-modal] estimated cost: ~$${cost.perCycleUSD.toFixed(2)}/cycle, ` +
      `~$${cost.perRunMaxUSD.toFixed(2)} max for ${cycles} cycle(s)${cycleDefaultSuffix(cycleDef)}.\n`,
  );
  for (const note of cost.notes) {
    process.stderr.write(`[eval cross-modal] note: ${note}\n`);
  }

  // Progress reporter (stderr only).
  const onProgress = (ev: ProgressEvent) => {
    switch (ev.kind) {
      case 'cycle_start':
        process.stderr.write(`[eval cross-modal] cycle ${ev.cycle}/${ev.total} starting...\n`);
        break;
      case 'slot_done': {
        const status = ev.ok ? 'ok' : 'failed';
        process.stderr.write(
          `[eval cross-modal]   slot ${ev.slotId} (${ev.modelId}) ${status} in ${ev.ms}ms\n`,
        );
        break;
      }
      case 'cycle_end':
        process.stderr.write(`[eval cross-modal] cycle ${ev.cycle} verdict: ${ev.verdict}\n`);
        break;
    }
  };

  const runEvalFn = opts.runEval ?? runEval;
  let result: RunEvalResult;
  try {
    result = await runEvalFn({
      task: parsed.task,
      output: outputContent,
      slug,
      dimensions,
      slots,
      cycles,
      receiptDir,
      maxTokens,
      onProgress,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[eval cross-modal] runtime error: ${msg}\n`);
    return 1;
  }

  // Final summary to stderr (always) + JSON to stdout (when --json).
  const verdict = result.finalAggregate.verdict;
  process.stderr.write('\n');
  process.stderr.write(`[eval cross-modal] ${result.finalAggregate.verdictMessage}\n`);
  process.stderr.write(`[eval cross-modal] receipt: ${result.finalReceiptPath}\n`);

  if (parsed.json) {
    process.stdout.write(
      JSON.stringify(
        {
          verdict,
          aggregate: result.finalAggregate,
          cycles: result.cycles.map(c => ({
            cycle: c.cycle,
            receipt_path: c.receipt_path,
            verdict: c.aggregate.verdict,
            overall: c.aggregate.overall,
          })),
          finalReceiptPath: result.finalReceiptPath,
        },
        null,
        2,
      ),
    );
    process.stdout.write('\n');
  }

  if (verdict === 'pass') return 0;
  if (verdict === 'inconclusive') return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// v0.40.1.0 Track D / T3 — Batch mode over LongMemEval-shape JSONL.
//
// Reads {question, hypothesis, ...} rows, slices to --limit, fans out via
// runWithLimit semaphore, aggregates per-question verdicts into a single
// summary receipt. Per-question receipts land in a tempdir and are deleted
// at end of run (per D10 — keeps ~/.gbrain/eval-receipts/ clean).
// ---------------------------------------------------------------------------

interface BatchRow {
  question_id: string;
  question: string;
  hypothesis: string;
}

/**
 * v0.40.1.0 Track D (codex CDX-1) — upstream-error row from
 * `gbrain eval longmemeval`. Carries `question`+`question_type` and an
 * `error` field but no usable hypothesis. Counted in the batch summary's
 * `upstream_error_count` so the denominator includes failed rows, never
 * silently dropped (which would let the gate pass on a surviving subset).
 */
interface UpstreamErrorRow {
  question_id: string;
  question: string;
  question_type?: string;
  error: string;
}

interface BatchReadResult {
  rows: BatchRow[];
  upstream_errors: UpstreamErrorRow[];
  malformed_count: number;
}

export interface BatchSummary {
  schema_version: 1;
  kind: 'cross_modal_batch_summary';
  timestamp: string;
  /** Sum of scored + upstream_error + malformed rows. Real denominator. */
  total: number;
  pass_count: number;
  fail_count: number;
  inconclusive_count: number;
  /** Per-question runtime errors from the cross-modal scoring layer. */
  error_count: number;
  /**
   * v0.40.1.0 Track D (codex CDX-1) — rows that arrived from the upstream
   * eval already failed (longmemeval emitted an error row with no usable
   * hypothesis). Counted in `total` so the denominator can't bypass the gate.
   */
  upstream_error_count: number;
  /**
   * v0.40.1.0 Track D (codex CDX-1) — JSONL rows that didn't have the
   * required shape (missing question or hypothesis, not a tagged error row).
   * Counted in `total`; treated as ERROR for exit precedence.
   */
  malformed_count: number;
  verdict: 'pass' | 'fail' | 'inconclusive' | 'error';
  est_cost_usd: number;
  slots: SlotConfig[];
  cycles_per_question: number;
  concurrent: number;
  per_question: Array<{
    question_id: string;
    verdict: 'pass' | 'fail' | 'inconclusive' | 'error' | 'upstream_error';
    error?: string;
    final_aggregate?: unknown;
  }>;
}

function readBatchRows(path: string): BatchReadResult {
  if (!existsSync(path)) {
    throw new Error(`--batch file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  const rows: BatchRow[] = [];
  const upstream_errors: UpstreamErrorRow[] = [];
  let lineNo = 0;
  let summarySkipped = 0;
  let parseErrors = 0;
  let malformed_count = 0;
  for (const line of raw.split('\n')) {
    lineNo++;
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      parseErrors++;
      process.stderr.write(`[eval cross-modal batch] skipping invalid JSON at line ${lineNo}\n`);
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    // Skip the by_type_summary tail row — metadata, not a question.
    if (obj.kind === 'by_type_summary') {
      summarySkipped++;
      continue;
    }
    // v0.40.1.0 Track D (codex CDX-1): upstream error rows from
    // `gbrain eval longmemeval` carry an `error` field and an empty/missing
    // hypothesis. Treat them as upstream_error verdicts in the batch summary
    // so they count in the denominator instead of silently disappearing.
    if (typeof obj.error === 'string' && obj.error.length > 0) {
      upstream_errors.push({
        question_id: typeof obj.question_id === 'string' ? obj.question_id : `line-${lineNo}`,
        question: typeof obj.question === 'string' ? obj.question : '',
        ...(typeof obj.question_type === 'string' ? { question_type: obj.question_type } : {}),
        error: obj.error,
      });
      continue;
    }
    if (typeof obj.question !== 'string' || typeof obj.hypothesis !== 'string') {
      // Row missing required fields — malformed, count it. We count instead
      // of silently dropping so the batch summary can surface the loss.
      malformed_count++;
      process.stderr.write(
        `[eval cross-modal batch] skipping malformed row at line ${lineNo}: ` +
        `missing question or hypothesis field\n`,
      );
      continue;
    }
    rows.push({
      question_id: typeof obj.question_id === 'string' ? obj.question_id : `line-${lineNo}`,
      question: obj.question,
      hypothesis: obj.hypothesis,
    });
  }
  if (summarySkipped > 0) {
    process.stderr.write(`[eval cross-modal batch] filtered ${summarySkipped} summary row(s)\n`);
  }
  if (upstream_errors.length > 0) {
    process.stderr.write(
      `[eval cross-modal batch] ${upstream_errors.length} upstream-error row(s) detected; ` +
      `they will count in the batch denominator as ERROR verdicts.\n`,
    );
  }
  if (malformed_count > 0) {
    process.stderr.write(
      `[eval cross-modal batch] ${malformed_count} malformed row(s) skipped. ` +
      `Batch will FAIL — re-run upstream eval to fix.\n`,
    );
  }
  if (parseErrors > 0) {
    process.stderr.write(`[eval cross-modal batch] skipped ${parseErrors} corrupt line(s)\n`);
    // Corrupt JSON lines roll into malformed for exit-precedence purposes.
    malformed_count += parseErrors;
  }
  return { rows, upstream_errors, malformed_count };
}

async function runBatchMode(parsed: ParsedArgs, opts: RunCrossModalOpts): Promise<number> {
  // Defaults specific to batch mode.
  const limit = parsed.limit ?? 10;
  const concurrent = parsed.concurrent ?? 3;
  const cycles = parsed.cycles ?? 1; // default 1 in batch to bound cost
  const dimensions = parsed.dimensions ?? DEFAULT_DIMENSIONS;
  const maxTokens = parsed.maxTokens ?? 4000;
  const maxUsd = parsed.maxUsd ?? 5.0;

  const slots: SlotConfig[] = [
    { id: 'A', model: parsed.slotAModel ?? DEFAULT_SLOTS[0]!.model },
    { id: 'B', model: parsed.slotBModel ?? DEFAULT_SLOTS[1]!.model },
    { id: 'C', model: parsed.slotCModel ?? DEFAULT_SLOTS[2]!.model },
  ];

  // v0.40.1.0 Track D (codex CDX-2): --limit must be >= 1. Passing
  // --limit 0 would let an empty result fall through to PASS with
  // total:0 — a direct CI bypass. Fail fast.
  if (limit < 1) {
    process.stderr.write(
      `Error: --limit must be >= 1 (got ${limit}). --limit 0 would bypass the gate.\n`,
    );
    return 1;
  }

  // Read + slice rows BEFORE configuring the gateway so a malformed batch
  // file fails fast without spending any setup time.
  let rows: BatchRow[];
  let upstreamErrors: UpstreamErrorRow[];
  let malformedCount: number;
  try {
    const result = readBatchRows(parsed.batch!);
    rows = result.rows;
    upstreamErrors = result.upstream_errors;
    malformedCount = result.malformed_count;
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  // Total usable inputs = scored rows + upstream errors (CDX-1: both count
  // in the denominator). Zero usable inputs means there's nothing to do
  // AND nothing to flag — the upstream eval produced no output at all.
  if (rows.length === 0 && upstreamErrors.length === 0) {
    process.stderr.write(`Error: --batch file has zero usable rows\n`);
    return 1;
  }
  if (limit < rows.length) rows = rows.slice(0, limit);

  // Pre-flight cost estimate. Refuse if over --max-usd without --yes.
  const perQuestion = estimateCost(slots, cycles, maxTokens);
  const estTotal = perQuestion.perRunMaxUSD * rows.length;
  process.stderr.write(
    `[eval cross-modal batch] estimated cost: ~$${estTotal.toFixed(2)} ` +
    `for ${rows.length} questions x ${cycles} cycle(s) x 3 slots ` +
    `(per-question ~$${perQuestion.perRunMaxUSD.toFixed(2)}, concurrent=${concurrent})\n`,
  );
  if (estTotal > maxUsd && !parsed.yes) {
    process.stderr.write(
      `Error: estimated cost $${estTotal.toFixed(2)} exceeds --max-usd $${maxUsd.toFixed(2)}; ` +
      `pass --yes to proceed or lower --limit / --cycles.\n`,
    );
    return 1;
  }

  // Configure gateway (same path as single-task mode). When runEval is
  // injected (test mode), skip the gateway availability gate — the injected
  // function handles its own backend, so requiring an API key here would
  // make hermetic unit tests impossible.
  if (!opts.runEval) {
    configureGatewayForCli();
    if (!isAvailable('chat')) {
      process.stderr.write(
        'Error: AI gateway has no usable chat provider. ' +
        'Configure one of OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY.\n',
      );
      return 1;
    }
  }

  // Per-question receipts land in a tempdir; we delete the tempdir at the
  // end of the batch (per D10 — keeps ~/.gbrain/eval-receipts/ clean).
  const batchTempDir = mkdtempSync(join(tmpdir(), 'gbrain-batch-receipts-'));
  const runEvalFn = opts.runEval ?? runEval;

  try {
    const results = await runWithLimit({
      items: rows,
      limit: concurrent,
      fn: async (row, idx) => {
        process.stderr.write(`[eval cross-modal batch] ${idx + 1}/${rows.length} ${row.question_id} starting...\n`);
        return await runEvalFn({
          task: row.question,
          output: row.hypothesis,
          slug: row.question_id,
          dimensions,
          slots,
          cycles,
          receiptDir: batchTempDir,
          maxTokens,
        });
      },
    });

    // Aggregate verdicts.
    let pass = 0, fail = 0, inconclusive = 0, errored = 0;
    const perQuestionResults: BatchSummary['per_question'] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const qid = rows[i]!.question_id;
      if (!r.ok) {
        errored++;
        // Helper's error field is `unknown` (was `Error` pre-v0.41.15);
        // narrow at the use site.
        const errMsg = r.error instanceof Error ? r.error.message : String(r.error);
        perQuestionResults.push({ question_id: qid, verdict: 'error', error: errMsg });
        continue;
      }
      const v = r.value.finalAggregate.verdict;
      if (v === 'pass') pass++;
      else if (v === 'fail') fail++;
      else inconclusive++;
      perQuestionResults.push({
        question_id: qid,
        verdict: v,
        final_aggregate: r.value.finalAggregate,
      });
    }

    // v0.40.1.0 Track D (codex CDX-1): upstream errors from the upstream
    // eval are folded into per_question with verdict 'upstream_error' so
    // the audit trail is complete. They count in the ERROR exit precedence.
    for (const ue of upstreamErrors) {
      perQuestionResults.push({
        question_id: ue.question_id,
        verdict: 'upstream_error',
        error: ue.error,
      });
    }

    // v0.40.1.0 Track D (codex CDX-1): malformed rows can't be scored AND
    // can't be cited (no question text). They count toward total + ERROR
    // exit code so a corrupt JSONL can't silently shrink the denominator.

    const upstreamErrorCount = upstreamErrors.length;
    const totalDenom = rows.length + upstreamErrorCount + malformedCount;

    // Exit precedence (fail-loud convention; CDX-1 widens "ERROR" to include
    // upstream and malformed):
    //   any error / upstream_error / malformed → 2
    //   else any FAIL → 1
    //   else any INCONCLUSIVE → 2
    //   else 0 (all PASS)
    let batchVerdict: BatchSummary['verdict'];
    let exitCode: number;
    if (errored > 0 || upstreamErrorCount > 0 || malformedCount > 0) {
      batchVerdict = 'error';
      exitCode = 2;
    } else if (fail > 0) { batchVerdict = 'fail'; exitCode = 1; }
    else if (inconclusive > 0) { batchVerdict = 'inconclusive'; exitCode = 2; }
    else { batchVerdict = 'pass'; exitCode = 0; }

    const summary: BatchSummary = {
      schema_version: 1,
      kind: 'cross_modal_batch_summary',
      timestamp: new Date().toISOString(),
      total: totalDenom,
      pass_count: pass,
      fail_count: fail,
      inconclusive_count: inconclusive,
      error_count: errored,
      upstream_error_count: upstreamErrorCount,
      malformed_count: malformedCount,
      verdict: batchVerdict,
      est_cost_usd: estTotal,
      slots,
      cycles_per_question: cycles,
      concurrent,
      per_question: perQuestionResults,
    };

    // Write summary to --output or default path.
    const summaryPath = parsed.output ??
      join(gbrainPath('eval-receipts'), `cross-modal-batch-${batchSha8(summary)}.json`);
    // Ensure receipts dir exists (the inline ad-hoc default path bypasses
    // the per-cycle runEval mkdir).
    try {
      const summaryDir = summaryPath.substring(0, summaryPath.lastIndexOf('/'));
      if (summaryDir && !existsSync(summaryDir)) {
        mkdirSync(summaryDir, { recursive: true });
      }
    } catch { /* best-effort */ }
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

    process.stderr.write(
      `\n[eval cross-modal batch] verdict=${batchVerdict} ` +
      `pass=${pass} fail=${fail} inconclusive=${inconclusive} ` +
      `error=${errored} upstream_error=${upstreamErrorCount} malformed=${malformedCount} ` +
      `(total ${totalDenom})\n`,
    );
    process.stderr.write(`[eval cross-modal batch] summary receipt: ${summaryPath}\n`);

    if (parsed.json) {
      process.stdout.write(JSON.stringify(summary, null, 2));
      process.stdout.write('\n');
    }

    return exitCode;
  } finally {
    // Clean up the per-question receipt tempdir (per D10).
    try {
      rmSync(batchTempDir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(
        `[eval cross-modal batch] warning: tempdir cleanup failed: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

function batchSha8(summary: BatchSummary): string {
  return createHash('sha256')
    .update(JSON.stringify({ ts: summary.timestamp, n: summary.total, ids: summary.per_question.map(p => p.question_id) }))
    .digest('hex')
    .slice(0, 8);
}
