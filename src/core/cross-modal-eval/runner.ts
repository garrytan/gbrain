/**
 * cross-modal-eval/runner — orchestrate one or more eval cycles.
 *
 * Each cycle: 3 different-provider models score the OUTPUT against the TASK
 * on a fixed dimension list. `Promise.allSettled` so a single-provider 5xx
 * doesn't kill the cycle (T4=A — bare allSettled, no rate-leases for the
 * CLI path; future minion-integration TODO recovers cross-process
 * concurrency control).
 *
 * Pass / FAIL / INCONCLUSIVE verdict per `aggregate()`. The receipt schema
 * (schema_version: 1) is stable: timestamps, model strings, raw scores, and
 * dim rolls. Receipt filename binds skill slug + content sha-8 (T10=A) so
 * `gbrain skillify check` can tell whether a receipt is current or stale.
 */

import { join } from 'path';

import { chat as gwChat } from '../ai/gateway.ts';
import type { ChatMessage } from '../ai/gateway.ts';
import { aggregate } from './aggregate.ts';
import type { AggregateResult, SlotResult } from './aggregate.ts';
import { parseModelJSON } from './json-repair.ts';
import { receiptName, sha8 } from './receipt-name.ts';
import { writeReceipt } from './receipt-write.ts';

export const RECEIPT_SCHEMA_VERSION = 1;

/** Default dimensions match the v1.1.0 SKILL.md. */
export const DEFAULT_DIMENSIONS: string[] = [
  'GOAL_ACHIEVEMENT — Does the output actually accomplish what the task asked for?',
  'DEPTH — Is the output substantive, or surface-level / thin?',
  'SOURCING — Are claims backed by evidence, links, or citations?',
  'SPECIFICITY — Are there concrete details, data, quotes, examples?',
  'USEFULNESS — Would the intended audience find this valuable?',
];

/**
 * Default 3-provider slot configuration. Implementer should refresh the
 * model strings alongside model-family bumps in CLAUDE.md.
 *
 * The model strings here resolve through `src/core/ai/recipes/`. Each slot
 * uses a distinct family so blind spots don't correlate. Override via
 * `--slot-a-model`, `--slot-b-model`, `--slot-c-model` on the CLI.
 */
export const DEFAULT_SLOTS: SlotConfig[] = [
  { id: 'A', model: 'openai:gpt-4o' },
  { id: 'B', model: 'anthropic:claude-opus-4-7' },
  { id: 'C', model: 'google:gemini-1.5-pro' },
];

export interface SlotConfig {
  id: string;
  /** "<provider>:<modelId>" string consumed by gateway.ts:resolveChatProvider. */
  model: string;
}

export interface RunEvalOpts {
  task: string;
  output: string;
  /** Optional skill slug for receipt naming (T10). Falls back to a content sha. */
  slug?: string;
  /** Override default dimensions list. */
  dimensions?: string[];
  /** Override default 3 slots. */
  slots?: SlotConfig[];
  /** 1-3. CLI defaults to 3 in TTY, 1 in non-TTY (T11=B). */
  cycles?: number;
  /** Where receipts are written. CLI defaults to gbrainPath('eval-receipts'). */
  receiptDir: string;
  /** Per-call max output tokens (default 4000). */
  maxTokens?: number;
  /** Optional abort signal threaded into gateway calls. */
  abortSignal?: AbortSignal;
  /** Stderr progress callback (cycle 1/3, slot A done, etc.). */
  onProgress?: (event: ProgressEvent) => void;
}

export type ProgressEvent =
  | { kind: 'cycle_start'; cycle: number; total: number }
  | { kind: 'slot_done'; cycle: number; slotId: string; modelId: string; ok: boolean; ms: number }
  | { kind: 'cycle_end'; cycle: number; verdict: 'pass' | 'fail' | 'inconclusive' };

export interface CycleReceipt {
  schema_version: 1;
  cycle: number;
  task: string;
  output_sha8: string;
  /** Slug used in receipt filename. */
  slug: string;
  /** Skill SHA-8 used in receipt filename — caller-supplied via skill_sha. */
  skill_sha8?: string;
  timestamp: string;
  dimensions: string[];
  slots: Array<{
    id: string;
    model: string;
    ok: boolean;
    error?: string;
    raw?: string;
    parsed?: unknown;
  }>;
  aggregate: AggregateResult;
  /** Path the receipt was written to. */
  receipt_path: string;
}

export interface RunEvalResult {
  /** Last cycle's aggregate (the verdict that drives exit code). */
  finalAggregate: AggregateResult;
  /** Receipt for each cycle that ran. */
  cycles: CycleReceipt[];
  /** Path of the LAST cycle's receipt (the one binding the current sha). */
  finalReceiptPath: string;
}

/** Run up to `cycles` cycles. Stops early on PASS. */
export async function runEval(opts: RunEvalOpts): Promise<RunEvalResult> {
  const dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
  const slots = opts.slots ?? DEFAULT_SLOTS;
  const cycles = clampCycles(opts.cycles);
  const slug = opts.slug ?? `eval-${sha8(opts.output).slice(0, 6)}`;

  const cycleReceipts: CycleReceipt[] = [];
  let finalAggregate: AggregateResult | null = null;
  let finalReceiptPath = '';

  for (let cycle = 1; cycle <= cycles; cycle++) {
    opts.onProgress?.({ kind: 'cycle_start', cycle, total: cycles });

    const slotResults = await runOneCycle({
      task: opts.task,
      output: opts.output,
      dimensions,
      slots,
      maxTokens: opts.maxTokens ?? 4000,
      abortSignal: opts.abortSignal,
      cycle,
      onProgress: opts.onProgress,
    });

    const agg = aggregate({ slots: slotResults });
    finalAggregate = agg;

    // Receipt filename: <slug>-<sha8 of output>.json on cycle 1; subsequent
    // cycles append `.cycle<N>` so we don't clobber.
    const baseName = receiptName(slug, opts.output);
    const receiptFile =
      cycle === 1 ? baseName : baseName.replace(/\.json$/, `.cycle${cycle}.json`);
    const receiptPath = join(opts.receiptDir, receiptFile);

    const receipt: CycleReceipt = {
      schema_version: RECEIPT_SCHEMA_VERSION,
      cycle,
      task: opts.task,
      output_sha8: sha8(opts.output),
      slug,
      timestamp: new Date().toISOString(),
      dimensions,
      slots: slotResults.map(s => ({
        id: s.modelId.split(':')[0]!.toUpperCase().slice(0, 1),
        model: s.modelId,
        ok: s.ok,
        error: s.ok ? undefined : s.error,
        raw: s.ok ? undefined : undefined, // raw is large; skip from receipt by default
        parsed: s.ok ? s.parsed : undefined,
      })),
      aggregate: agg,
      receipt_path: receiptPath,
    };

    writeReceipt(receiptPath, receipt);
    cycleReceipts.push(receipt);
    finalReceiptPath = receiptPath;

    opts.onProgress?.({ kind: 'cycle_end', cycle, verdict: agg.verdict });

    if (agg.verdict === 'pass' || agg.verdict === 'inconclusive') break;
  }

  if (!finalAggregate) {
    throw new Error('runEval: no cycles ran');
  }

  return { finalAggregate, cycles: cycleReceipts, finalReceiptPath };
}

interface OneCycleOpts {
  task: string;
  output: string;
  dimensions: string[];
  slots: SlotConfig[];
  maxTokens: number;
  abortSignal?: AbortSignal;
  cycle: number;
  onProgress?: (event: ProgressEvent) => void;
}

async function runOneCycle(opts: OneCycleOpts): Promise<SlotResult[]> {
  const prompt = buildPrompt(opts.task, opts.dimensions, opts.output);

  const tasks = opts.slots.map(slot => callSlot(slot, prompt, opts));
  const settled = await Promise.allSettled(tasks);

  const slotResults: SlotResult[] = settled.map((s, idx) => {
    const slot = opts.slots[idx]!;
    if (s.status === 'fulfilled') return s.value;
    return { ok: false, modelId: slot.model, error: errorMessage(s.reason) };
  });

  return slotResults;
}

async function callSlot(
  slot: SlotConfig,
  prompt: string,
  opts: OneCycleOpts,
): Promise<SlotResult> {
  const start = Date.now();
  try {
    const messages: ChatMessage[] = [
      { role: 'user', content: prompt },
    ];
    const result = await gwChat({
      model: slot.model,
      system: SYSTEM_PROMPT,
      messages,
      maxTokens: opts.maxTokens,
      abortSignal: opts.abortSignal,
    });

    const parsed = parseModelJSON(result.text ?? '');
    const ms = Date.now() - start;
    opts.onProgress?.({
      kind: 'slot_done',
      cycle: opts.cycle,
      slotId: slot.id,
      modelId: slot.model,
      ok: true,
      ms,
    });
    return { ok: true, modelId: slot.model, parsed };
  } catch (err) {
    const ms = Date.now() - start;
    const msg = errorMessage(err);
    opts.onProgress?.({
      kind: 'slot_done',
      cycle: opts.cycle,
      slotId: slot.id,
      modelId: slot.model,
      ok: false,
      ms,
    });
    return { ok: false, modelId: slot.model, error: msg };
  }
}

function buildPrompt(task: string, dimensions: string[], output: string): string {
  const dimList = dimensions.map((d, i) => `${i + 1}. ${d}`).join('\n');
  return [
    'You are a strict quality evaluator. Given a TASK and an OUTPUT, evaluate whether the output achieves the task goals.',
    '',
    'TASK:',
    task,
    '',
    `Score the OUTPUT 1-10 on each dimension:`,
    dimList,
    '',
    'Scoring calibration:',
    '  9-10: Exceptional — would impress a domain expert',
    '  7-8:  Solid — accomplishes the goal, no major gaps',
    '  5-6:  Mediocre — obvious weaknesses',
    '  3-4:  Poor — missing important elements',
    '  1-2:  Failed',
    '',
    'Then list exactly 10 specific, actionable improvements — concrete changes with examples, prioritized by impact.',
    '',
    'Respond in JSON only (no markdown fences):',
    '{',
    '  "scores": {',
    '    "dim_1_name": { "score": N, "feedback": "..." },',
    '    ...',
    '  },',
    '  "overall": N,',
    '  "improvements": ["1. ...", "2. ...", ... "10. ..."]',
    '}',
    '',
    'OUTPUT:',
    output,
  ].join('\n');
}

const SYSTEM_PROMPT =
  'You are a strict quality evaluator. Reply with JSON only. Do not wrap in markdown fences. ' +
  'Each score must be an integer 1-10. Improvements must be concrete and actionable.';

function clampCycles(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > 3) return 3;
  return Math.floor(n);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Cost estimation table. Used by the CLI to print a per-run upper-bound
 * before each cycle (T11=B). Source: gateway recipes' price_last_verified
 * fields. Prices drift; this is intentionally rough.
 */
export interface CostEstimate {
  perCycleUSD: number;
  perRunMaxUSD: number;
  perCallTokens: number;
  notes: string[];
}

export function estimateCost(slots: SlotConfig[], cycles: number, maxTokens: number): CostEstimate {
  // Per-call cost = (input_tokens × input_price + output_tokens × output_price) / 1e6.
  // Without knowing prompt size, estimate input ~5k tokens (a SKILL.md + scoring rubric).
  const ESTIMATED_INPUT_TOKENS = 5000;
  const PRICING: Record<string, { in: number; out: number } | undefined> = {
    'openai:gpt-4o': { in: 2.5, out: 10.0 },
    'openai:gpt-4o-mini': { in: 0.15, out: 0.6 },
    'anthropic:claude-opus-4-7': { in: 15.0, out: 75.0 },
    'anthropic:claude-sonnet-4-6-20250929': { in: 3.0, out: 15.0 },
    'anthropic:claude-haiku-4-5-20251001': { in: 0.25, out: 1.25 },
    'google:gemini-1.5-pro': { in: 1.25, out: 5.0 },
    'google:gemini-2.0-flash': { in: 0.1, out: 0.4 },
    'together:meta-llama/Llama-3.3-70B-Instruct-Turbo': { in: 0.88, out: 0.88 },
    'deepseek:deepseek-chat': { in: 0.14, out: 0.28 },
  };

  const notes: string[] = [];
  let perCycle = 0;
  for (const slot of slots) {
    const p = PRICING[slot.model];
    if (!p) {
      notes.push(`(${slot.model}): no pricing on file; cost estimate may be low`);
      continue;
    }
    const cost = (ESTIMATED_INPUT_TOKENS * p.in + maxTokens * p.out) / 1_000_000;
    perCycle += cost;
  }
  return {
    perCycleUSD: round2(perCycle),
    perRunMaxUSD: round2(perCycle * cycles),
    perCallTokens: ESTIMATED_INPUT_TOKENS + maxTokens,
    notes,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
