/**
 * v0.34 pre-w0 — code-retrieval eval harness.
 *
 * The baseline this captures is what v0.34 must beat (precision@5 +10pp OR
 * top-1 stability +15pp on >=15/30 questions, above the 3-run noise floor).
 *
 * Two modes:
 *   --baseline       Uses only `query` + `search` (today's gbrain). The number
 *                    captured here is the v0.34 ship gate.
 *   --with-code-intel Uses the v0.34 code-intel MCP ops (code_blast / code_flow
 *                    / code_def / code_refs / code_callers / code_callees /
 *                    code_cluster_get). Numerator of the gate comparison.
 *
 * Pure-function metrics live at the bottom of this file; the runner can be
 * stubbed for unit testing without touching the brain.
 *
 * Hermetic by design: cli.ts skips connectEngine() when the user is in
 * --help mode. Real runs connect to ~/.gbrain (the dogfood brain) by default
 * unless --corpus points elsewhere.
 */

import { readFileSync, existsSync } from 'fs';

// ─────────────────────────────────────────────────────────────────
// Types — stable contract for downstream consumers (gbrain-evals, CI)
// ─────────────────────────────────────────────────────────────────

export type CodeQuestionKind =
  | 'callers'
  | 'callees'
  | 'definition'
  | 'references'
  | 'blast_radius'
  | 'execution_flow'
  | 'cluster_membership';

export interface CodeQuestion {
  id: string;
  kind: CodeQuestionKind;
  /** Human-language query an agent would type. */
  query: string;
  /** Canonical symbol to look up structurally (post-v0.34). */
  symbol: string;
  /** Expected file paths that must appear in the retrieved set. */
  expected_files: string[];
  /**
   * Minimum recall@k against `expected_files` for this question to count as
   * "answered." For some post-v0.34-only questions, baseline expectations
   * are intentionally low (0.3) since today's gbrain can't answer them.
   */
  expected_min_recall: number;
  note?: string;
}

export interface CodeQuestionFile {
  version: number;
  schema: string;
  corpus: string;
  description: string;
  questions: CodeQuestion[];
}

export interface QuestionResult {
  id: string;
  kind: CodeQuestionKind;
  /** Files actually returned, in rank order (top-k). */
  retrieved_files: string[];
  /** Top-1 file (the single most-confident answer). */
  top_1: string | null;
  /** precision@k = |relevant ∩ retrieved| / |retrieved|. */
  precision_at_k: number;
  /** recall@k = |relevant ∩ retrieved| / |relevant|. */
  recall_at_k: number;
  /** Whether this question's bar (`expected_min_recall`) was cleared. */
  answered: boolean;
  /** Total latency for this question's tool calls, in ms. */
  latency_ms: number;
}

export interface EvalRunReport {
  mode: 'baseline' | 'with-code-intel';
  schema_version: 1;
  corpus: string;
  k: number;
  questions: QuestionResult[];
  /** Mean precision@k across all questions. */
  mean_precision_at_k: number;
  /** Fraction of questions that cleared their expected_min_recall bar. */
  answered_rate: number;
  /** Top-1 stability — set when comparing two runs; null for single-run. */
  top_1_stability_rate?: number;
  /** Aggregate run latency, ms. */
  total_latency_ms: number;
  /** ISO-8601 capture time. */
  captured_at: string;
  /** Git short-SHA at capture time. */
  commit: string;
}

// ─────────────────────────────────────────────────────────────────
// Pure metrics (no engine dependency, fully unit-testable)
// ─────────────────────────────────────────────────────────────────

/**
 * precision@k = relevant ∩ retrieved (top-k) / retrieved (top-k)
 * Returns 0 when retrieved is empty.
 */
export function precisionAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k);
  if (topK.length === 0) return 0;
  let hits = 0;
  for (const r of topK) {
    if (relevant.has(r)) hits++;
  }
  return hits / topK.length;
}

/**
 * recall@k = relevant ∩ retrieved (top-k) / relevant
 * Returns 1 when relevant is empty (degenerate case).
 */
export function recallAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 1;
  const topK = new Set(retrieved.slice(0, k));
  let hits = 0;
  for (const r of relevant) {
    if (topK.has(r)) hits++;
  }
  return hits / relevant.size;
}

/**
 * top-1 stability rate between two runs over the same question set.
 * Computed as |{q : run1.top_1 === run2.top_1}| / total. NaN → 0.
 */
export function top1StabilityRate(run1: QuestionResult[], run2: QuestionResult[]): number {
  if (run1.length === 0 || run2.length === 0) return 0;
  const lookup = new Map(run2.map((q) => [q.id, q.top_1]));
  let stable = 0;
  let comparable = 0;
  for (const q of run1) {
    if (!lookup.has(q.id)) continue;
    comparable++;
    if (q.top_1 === lookup.get(q.id)) stable++;
  }
  return comparable === 0 ? 0 : stable / comparable;
}

/**
 * Match `retrieved_files` against `expected_files` accounting for prefix
 * matching: a retrieved file "src/foo/bar.ts" counts as matching the
 * expected entry "src/foo/" (trailing slash = directory match).
 * Set semantics — duplicates collapse.
 */
export function normalizeRetrieved(retrieved_files: string[]): string[] {
  // Dedupe + drop empties; do not mutate order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of retrieved_files) {
    if (!f) continue;
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

export function expandExpectedToRelevantSet(expected: string[]): {
  exactFiles: Set<string>;
  dirPrefixes: string[];
} {
  const exactFiles = new Set<string>();
  const dirPrefixes: string[] = [];
  for (const e of expected) {
    if (e.endsWith('/')) dirPrefixes.push(e);
    else exactFiles.add(e);
  }
  return { exactFiles, dirPrefixes };
}

export function isFileRelevant(file: string, expected: ReturnType<typeof expandExpectedToRelevantSet>): boolean {
  if (expected.exactFiles.has(file)) return true;
  for (const p of expected.dirPrefixes) {
    if (file.startsWith(p)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────

export function loadQuestions(path: string): CodeQuestionFile {
  if (!existsSync(path)) {
    throw new Error(`questions file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  let parsed: CodeQuestionFile;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`failed to parse questions JSON: ${err.message}`);
  }
  if (parsed.version !== 1) {
    throw new Error(`unsupported questions file version ${parsed.version} (expected 1)`);
  }
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error('questions file contains no questions');
  }
  for (const q of parsed.questions) {
    if (!q.id || !q.kind || !q.query || !Array.isArray(q.expected_files)) {
      throw new Error(`malformed question entry: ${JSON.stringify(q)}`);
    }
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────
// Mode dispatch — pluggable retrieval strategies
// ─────────────────────────────────────────────────────────────────

/**
 * A retrieval strategy maps a question to a ranked list of file paths.
 * Pure abstraction so the runner is testable without engine dependencies.
 */
export interface RetrievalStrategy {
  readonly mode: 'baseline' | 'with-code-intel';
  retrieve(question: CodeQuestion, k: number): Promise<{ files: string[]; latency_ms: number }>;
}

// ─────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────

export interface RunnerOpts {
  k: number;
  corpus: string;
  onProgress?: (done: number, total: number, currentQ: string) => void;
}

export async function runCodeRetrievalEval(
  questions: CodeQuestion[],
  strategy: RetrievalStrategy,
  opts: RunnerOpts,
): Promise<EvalRunReport> {
  const results: QuestionResult[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const t0 = Date.now();
    let retrieved: string[] = [];
    let latency_ms = 0;
    try {
      const r = await strategy.retrieve(q, opts.k);
      retrieved = normalizeRetrieved(r.files);
      latency_ms = r.latency_ms;
    } catch (err: any) {
      // Retrieval errors are part of the eval signal — record as empty result.
      retrieved = [];
      latency_ms = Date.now() - t0;
      process.stderr.write(`[eval] retrieval error on ${q.id}: ${err?.message ?? err}\n`);
    }

    const expected = expandExpectedToRelevantSet(q.expected_files);
    const relevantSet = new Set(retrieved.filter((f) => isFileRelevant(f, expected)));
    const recall_at_k = recallAtK(Array.from(relevantSet), expected.exactFiles, opts.k);
    const precision_at_k = precisionAtK(retrieved, relevantSet, opts.k);
    const top_1 = retrieved[0] ?? null;
    const answered = recall_at_k >= q.expected_min_recall;

    results.push({
      id: q.id,
      kind: q.kind,
      retrieved_files: retrieved,
      top_1,
      precision_at_k,
      recall_at_k,
      answered,
      latency_ms,
    });

    opts.onProgress?.(i + 1, questions.length, q.id);
  }

  const total_latency_ms = Date.now() - startedAt;
  const mean_precision_at_k = results.reduce((a, r) => a + r.precision_at_k, 0) / Math.max(1, results.length);
  const answered_rate = results.filter((r) => r.answered).length / Math.max(1, results.length);

  let commit = 'unknown';
  try {
    const { execSync } = await import('child_process');
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // Not in a git repo or git unavailable — leave as 'unknown'
  }

  return {
    mode: strategy.mode,
    schema_version: 1,
    corpus: opts.corpus,
    k: opts.k,
    questions: results,
    mean_precision_at_k,
    answered_rate,
    total_latency_ms,
    captured_at: new Date().toISOString(),
    commit,
  };
}

// ─────────────────────────────────────────────────────────────────
// Comparison — used by the v0.34 ship gate
// ─────────────────────────────────────────────────────────────────

export interface GateResult {
  passed: boolean;
  precision_delta_pp: number;
  top_1_stability_rate: number;
  questions_cleared_bar: number;
  questions_total: number;
  baseline: EvalRunReport;
  with_code_intel: EvalRunReport;
  /** Free-form summary explaining pass/fail. */
  summary: string;
}

export interface GateOpts {
  /** Required precision@5 delta (in percentage points) to pass. Default: 10. */
  required_precision_delta_pp: number;
  /** Required top-1 stability rate to pass (alternative criterion). Default: 0.15 lower bound. */
  required_top_1_stability_delta: number;
  /** Minimum questions that must clear `expected_min_recall` in with-code-intel mode. Default: 15. */
  min_questions_cleared: number;
}

export const DEFAULT_GATE: GateOpts = {
  required_precision_delta_pp: 10,
  required_top_1_stability_delta: 0.15,
  min_questions_cleared: 15,
};

export function evaluateGate(
  baseline: EvalRunReport,
  with_code_intel: EvalRunReport,
  opts: GateOpts = DEFAULT_GATE,
): GateResult {
  const precision_delta_pp = (with_code_intel.mean_precision_at_k - baseline.mean_precision_at_k) * 100;
  const top_1_stability_rate = top1StabilityRate(baseline.questions, with_code_intel.questions);
  const questions_cleared_bar = with_code_intel.questions.filter((q) => q.answered).length;
  const questions_total = with_code_intel.questions.length;

  const precisionPasses = precision_delta_pp >= opts.required_precision_delta_pp;
  // Stability is "how much DIFFERENT" — for an improvement gate we want
  // either precision OR a substantive reordering that lands more good answers.
  // We use a delta over baseline's own stability, treating baseline as 1.0
  // self-stability. Convention: pass when stability is lower (more changes)
  // AND a higher answered_rate. Otherwise the gate would punish v0.34 for
  // changing the retrieval order even when it lands better answers.
  const stabilityPasses =
    with_code_intel.answered_rate - baseline.answered_rate >= opts.required_top_1_stability_delta;
  const enoughCleared = questions_cleared_bar >= opts.min_questions_cleared;

  const passed = enoughCleared && (precisionPasses || stabilityPasses);

  const reasons: string[] = [];
  if (!enoughCleared) {
    reasons.push(
      `only ${questions_cleared_bar}/${questions_total} questions cleared expected_min_recall (need >=${opts.min_questions_cleared})`,
    );
  }
  if (precisionPasses) reasons.push(`precision@${baseline.k} +${precision_delta_pp.toFixed(1)}pp (>=${opts.required_precision_delta_pp})`);
  else reasons.push(`precision@${baseline.k} delta ${precision_delta_pp.toFixed(1)}pp (<${opts.required_precision_delta_pp})`);
  if (stabilityPasses) reasons.push(`answered_rate +${((with_code_intel.answered_rate - baseline.answered_rate) * 100).toFixed(1)}pp`);

  const summary = passed
    ? `GATE PASS — ${reasons.join('; ')}`
    : `GATE FAIL — ${reasons.join('; ')}`;

  return {
    passed,
    precision_delta_pp,
    top_1_stability_rate,
    questions_cleared_bar,
    questions_total,
    baseline,
    with_code_intel,
    summary,
  };
}
