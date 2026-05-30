/**
 * v0.42 — Extract Receipt writer.
 *
 * Every LLM-backed extraction run writes a receipt page recording the
 * round's outcome: total rows, cost, model id, eval verdict. Receipts
 * are first-class brain memory — queryable via gbrain search, citable
 * in takes, surfaced in cross-modal contradiction probes.
 *
 * Two structural protections against extraction loops (D-EXTRACT-19,
 * belt + suspenders):
 *   1. `type: extract_receipt` — eligibility predicate's type filter
 *      rejects this type because it's not in ELIGIBLE_TYPES.
 *   2. `dream_generated: true` — the anti-loop guard at
 *      `src/core/facts/eligibility.ts:62` rejects this flag.
 *
 * Search-rank: receipts get factor 0.3 demote via the `extracts/` slug
 * prefix entry in DEFAULT_SOURCE_BOOSTS (D-EXTRACT-42). They surface
 * when specifically relevant (extraction-related queries) but never
 * dominate user content.
 *
 * Slug shape (D-EXTRACT-17):
 *   extracts/{date}/{kind}/{source_id}/{run_id_short}/round-{N}.md
 *
 * Where:
 *   - date    = YYYY-MM-DD of extraction
 *   - kind    = extractor kind ("facts.conversation", "atoms", ...)
 *   - source_id = brain source the extraction targeted
 *   - run_id_short = first 8 chars of the op-checkpoint id (or
 *                    progressive-batch operation_id) — groups all
 *                    rounds of one run under one directory
 *   - N       = round identifier ("trial" | "ramp_100" | "ramp_500" |
 *               "full" | "single")
 *
 * Resume rounds land under the same run_id_short so the audit trail
 * for a halted-then-resumed run stays coherent.
 */

import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';

/**
 * Round identifier. Matches the progressive-batch primitive's Stage
 * union from src/core/progressive-batch/types.ts:42, plus 'single' for
 * extractors that don't ramp (deterministic / one-shot).
 */
export type ExtractReceiptRound =
  | 'trial'
  | 'ramp_100'
  | 'ramp_500'
  | 'full'
  | 'single';

/**
 * Input to writeReceipt. Optional fields are recorded in frontmatter
 * only when the caller provides them, so receipts stay clean for
 * deterministic extractors (no LLM cost or eval to record).
 */
export interface ExtractReceiptInput {
  /** Kind of extraction (matches the conceptual handler name). */
  kind: string;
  /** Brain source the extraction targeted. */
  source_id: string;
  /** Op-checkpoint id or progressive-batch operation_id for trace continuity. */
  run_id: string;
  /** Which round this receipt covers. */
  round: ExtractReceiptRound;
  /** ISO timestamp of round completion. */
  extracted_at: string;
  /** Rows committed to the target store this round. */
  total_rows: number;
  /** Cumulative cost across the round in USD. 0 for deterministic extractors. */
  cost_usd: number;
  /** LLM model id (optional; only for LLM-backed extractors). */
  model_id?: string;
  /** Eval gate verdict (optional; only when a gate fired). */
  eval_pass?: boolean;
  /** Eval gate score (optional; companion to eval_pass). */
  eval_score?: number;
  /** Human-readable summary line (1-2 sentences). */
  summary?: string;
}

const RUN_ID_SHORT_LEN = 8;

/**
 * Truncate a run id to the standard 8-char short form used in slug
 * paths. Idempotent — passing an already-short id returns it unchanged.
 * Non-hex / non-alphanumeric chars survive (op-checkpoint ids may
 * include dashes or other separators).
 */
export function shortRunId(runId: string): string {
  return runId.slice(0, RUN_ID_SHORT_LEN);
}

/**
 * Derive a YYYY-MM-DD date string from an ISO timestamp.
 * Falls back to UTC slice; locale-independent.
 */
export function dateFromIso(iso: string): string {
  // ISO 8601 always starts YYYY-MM-DD. Slice the first 10 chars.
  // If the caller passes a non-ISO shape, slice still returns something;
  // the receipt slug is best-effort labeling, not load-bearing parsing.
  return iso.slice(0, 10);
}

/**
 * Compute the canonical slug for a receipt. Exported for tests +
 * symmetry with read-side code that needs to compose the same slug
 * (e.g. doctor reading receipts by run_id).
 */
export function receiptSlug(input: ExtractReceiptInput): string {
  const date = dateFromIso(input.extracted_at);
  const short = shortRunId(input.run_id);
  return `extracts/${date}/${input.kind}/${input.source_id}/${short}/round-${input.round}`;
}

/**
 * Build the receipt page body. Operator-readable. Frontmatter is
 * machine-readable.
 */
function buildReceiptBody(input: ExtractReceiptInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.kind} — round ${input.round}`);
  lines.push('');
  if (input.summary) {
    lines.push(input.summary);
    lines.push('');
  }
  lines.push(`Source: \`${input.source_id}\``);
  lines.push(`Run: \`${input.run_id}\``);
  lines.push(`Round: \`${input.round}\``);
  lines.push(`Extracted at: ${input.extracted_at}`);
  lines.push('');
  lines.push(`Rows extracted: **${input.total_rows}**`);
  if (typeof input.cost_usd === 'number' && input.cost_usd > 0) {
    lines.push(`Cost: $${input.cost_usd.toFixed(4)}`);
  }
  if (input.model_id) {
    lines.push(`Model: \`${input.model_id}\``);
  }
  if (typeof input.eval_pass === 'boolean') {
    const verdict = input.eval_pass ? 'PASS' : 'FAIL';
    const score = typeof input.eval_score === 'number'
      ? ` (score ${input.eval_score.toFixed(2)})`
      : '';
    lines.push(`Eval gate: **${verdict}**${score}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Build the receipt frontmatter. Two anti-loop flags
 * (type:extract_receipt + dream_generated:true) are stamped by every
 * writeReceipt call regardless of caller. Per D-EXTRACT-19.
 */
function buildReceiptFrontmatter(input: ExtractReceiptInput): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    type: 'extract_receipt',
    dream_generated: true,
    kind: input.kind,
    source_id: input.source_id,
    run_id: input.run_id,
    round: input.round,
    extracted_at: input.extracted_at,
    total_rows: input.total_rows,
    cost_usd: input.cost_usd,
  };
  if (input.model_id) fm.model_id = input.model_id;
  if (typeof input.eval_pass === 'boolean') fm.eval_pass = input.eval_pass;
  if (typeof input.eval_score === 'number') fm.eval_score = input.eval_score;
  return fm;
}

/**
 * Write an extract receipt page. Returns the slug of the written page
 * for the caller's audit/logging needs.
 *
 * Side-effects: calls engine.putPage with the receipt's compiled body +
 * frontmatter. Threads sourceId so federated brains route the receipt
 * to the same source the extraction targeted.
 *
 * Re-running with the same run_id + round overwrites the prior receipt
 * (idempotent on resume). The op-checkpoint id is stable across
 * resumes per src/core/op-checkpoint.ts, so this is the desired
 * semantic.
 */
export async function writeReceipt(
  engine: BrainEngine,
  input: ExtractReceiptInput,
): Promise<{ slug: string; page: Page }> {
  const slug = receiptSlug(input);
  const title = `${input.kind} — ${input.round} — ${input.source_id}`;
  const frontmatter = buildReceiptFrontmatter(input);
  const compiled_truth = buildReceiptBody(input);

  const page = await engine.putPage(
    slug,
    {
      type: 'extract_receipt',
      title,
      compiled_truth,
      frontmatter,
    },
    { sourceId: input.source_id },
  );

  return { slug, page };
}
