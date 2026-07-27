/**
 * SkillOpt benchmark loader, validator, and splitter.
 *
 * Benchmark format: JSONL with one task per line:
 *   {"task_id":"x","task":"...","judge":{"kind":"rule","checks":[...]}}
 *
 * Enforces (at load time, fail-loud with paste-ready hints):
 *  - File exists and is non-empty.
 *  - Every row parses as JSON.
 *  - Every row has task_id (unique), task (non-empty string), judge.kind ∈ {rule,llm,qrels}.
 *  - Judge-specific shape validation (rule.checks array, llm.rubric string, qrels.expected_slugs).
 *  - D17: D_sel >= 5 after split — refuses below floor with `--split` override hint.
 *  - D15: refuses bootstrap output that still has the BOOTSTRAP_PENDING_REVIEW sentinel.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { errorFor } from '../errors.ts';
import {
  type Benchmark,
  type BenchmarkSplit,
  type BenchmarkTask,
  type Judge,
  type RuleCheck,
  type RuleCheckOp,
  BOOTSTRAP_PENDING_REVIEW,
  D_SEL_MIN_SIZE,
} from './types.ts';

const VALID_RULE_OPS: ReadonlySet<RuleCheckOp> = new Set([
  'contains',
  'regex',
  'section_present',
  'max_chars',
  'min_citations',
  'tool_called',
  'tool_not_called',
]);

/**
 * Load + validate a benchmark JSONL file.
 *
 * @param path absolute path to the benchmark file.
 * @param opts.bootstrapReviewed set true after the user passed --bootstrap-reviewed.
 *        When false (default), the loader refuses files that still carry the
 *        BOOTSTRAP_PENDING_REVIEW sentinel line (D15).
 */
export function loadBenchmark(
  path: string,
  opts: { bootstrapReviewed?: boolean } = {},
): Benchmark {
  let content: string;
  try {
    content = fs.readFileSync(path, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw errorFor({
      class: 'BenchmarkNotFound',
      code: 'benchmark_not_found',
      message: `Benchmark file unreadable: ${path} (${msg})`,
      hint: `Auto-generate a starter with 'gbrain skillopt <skill> --bootstrap-from-skill' (reads SKILL.md), then review + run with --bootstrap-reviewed --split 1:1:1. Or pass --bootstrap-from-routing if a routing-eval.jsonl exists.`,
    });
  }

  if (content.trim().length === 0) {
    throw errorFor({
      class: 'BenchmarkEmpty',
      code: 'benchmark_empty',
      message: `Benchmark file is empty: ${path}`,
      hint: `Add at least ${D_SEL_MIN_SIZE} tasks (one JSON object per line) — D_sel requires >=${D_SEL_MIN_SIZE} after split.`,
    });
  }

  // D15: detect the bootstrap-pending sentinel before parsing rows.
  // Sentinel is always the LAST non-empty line of the file. A user who's
  // hand-reviewed the bootstrap deletes the line before re-running.
  const allLines = content.split('\n');
  const lastNonEmpty = [...allLines].reverse().find((l) => l.trim().length > 0);
  if (lastNonEmpty && lastNonEmpty.trim() === BOOTSTRAP_PENDING_REVIEW) {
    if (!opts.bootstrapReviewed) {
      throw errorFor({
        class: 'BootstrapPendingReview',
        code: 'bootstrap_pending_review',
        message: `Benchmark at ${path} is a bootstrap output awaiting human review.`,
        hint: `Review the file, delete the trailing '${BOOTSTRAP_PENDING_REVIEW}' line, then re-run with --bootstrap-reviewed.`,
      });
    }
  } else if (opts.bootstrapReviewed) {
    // User passed --bootstrap-reviewed but the sentinel is already gone.
    // This is fine — the flag is idempotent. Don't error.
  }

  // Parse rows.
  const tasks: BenchmarkTask[] = [];
  const seenIds = new Set<string>();
  const rows = allLines.filter((l) => l.trim().length > 0 && l.trim() !== BOOTSTRAP_PENDING_REVIEW);

  for (let i = 0; i < rows.length; i++) {
    const line = rows[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw errorFor({
        class: 'BenchmarkMalformed',
        code: 'benchmark_malformed',
        message: `Row ${i + 1} is not valid JSON: ${msg}`,
        hint: `Fix the offending line in ${path}; benchmarks are one JSON object per line.`,
      });
    }

    const task = validateRow(parsed, i + 1, path);
    if (seenIds.has(task.task_id)) {
      throw errorFor({
        class: 'BenchmarkDuplicateId',
        code: 'benchmark_duplicate_task_id',
        message: `Duplicate task_id '${task.task_id}' at row ${i + 1}.`,
        hint: `Every task_id in ${path} must be unique.`,
      });
    }
    seenIds.add(task.task_id);
    tasks.push(task);
  }

  if (tasks.length === 0) {
    throw errorFor({
      class: 'BenchmarkEmpty',
      code: 'benchmark_empty',
      message: `Benchmark file at ${path} has no tasks.`,
      hint: `Add at least ${D_SEL_MIN_SIZE} tasks.`,
    });
  }

  return {
    source_path: path,
    tasks,
    benchmark_sha8: computeBenchmarkSha8(tasks),
  };
}

/** Validate a single parsed row. Throws StructuredAgentError on failure. */
function validateRow(parsed: unknown, rowNum: number, path: string): BenchmarkTask {
  if (!parsed || typeof parsed !== 'object') {
    throw errorFor({
      class: 'BenchmarkMalformed',
      code: 'benchmark_malformed',
      message: `Row ${rowNum} is not an object.`,
      hint: `Each line in ${path} must be a JSON object with task_id, task, judge.`,
    });
  }
  const obj = parsed as Record<string, unknown>;

  const task_id = typeof obj.task_id === 'string' ? obj.task_id.trim() : '';
  if (!task_id) {
    throw errorFor({
      class: 'BenchmarkMalformed',
      code: 'benchmark_missing_task_id',
      message: `Row ${rowNum} is missing a non-empty task_id.`,
      hint: `Add a unique task_id string to row ${rowNum} of ${path}.`,
    });
  }

  const task = typeof obj.task === 'string' ? obj.task : '';
  if (!task.trim()) {
    throw errorFor({
      class: 'BenchmarkMalformed',
      code: 'benchmark_missing_task',
      message: `Row ${rowNum} (${task_id}) is missing a non-empty task description.`,
      hint: `Add a 'task' field describing the prompt to run against the skill.`,
    });
  }

  const judge = validateJudge(obj.judge, rowNum, task_id, path);
  return { task_id, task, judge };
}

function validateJudge(raw: unknown, rowNum: number, task_id: string, path: string): Judge {
  if (!raw || typeof raw !== 'object') {
    throw errorFor({
      class: 'BenchmarkMalformed',
      code: 'benchmark_missing_judge',
      message: `Row ${rowNum} (${task_id}) is missing a judge object.`,
      hint: `Add a 'judge' field with shape {"kind":"rule"|"llm"|"qrels", ...}.`,
    });
  }
  const j = raw as Record<string, unknown>;
  const kind = j.kind;
  if (kind === 'rule') {
    const checks = j.checks;
    if (!Array.isArray(checks) || checks.length === 0) {
      throw errorFor({
        class: 'BenchmarkMalformed',
        code: 'benchmark_judge_rule_no_checks',
        message: `Row ${rowNum} (${task_id}) judge.kind='rule' needs a non-empty checks array.`,
        hint: `Add at least one check, e.g. {"op":"max_chars","arg":4000}.`,
      });
    }
    const validated: RuleCheck[] = checks.map((c, ci) => validateRuleCheck(c, rowNum, ci, task_id, path));
    return { kind: 'rule', checks: validated };
  }
  if (kind === 'llm') {
    const rubric = typeof j.rubric === 'string' ? j.rubric : '';
    if (!rubric.trim()) {
      throw errorFor({
        class: 'BenchmarkMalformed',
        code: 'benchmark_judge_llm_no_rubric',
        message: `Row ${rowNum} (${task_id}) judge.kind='llm' needs a non-empty rubric string.`,
        hint: `Add a 'rubric' field describing how to score the output 0..1.`,
      });
    }
    const model = typeof j.model === 'string' ? j.model : undefined;
    return model !== undefined ? { kind: 'llm', rubric, model } : { kind: 'llm', rubric };
  }
  if (kind === 'qrels') {
    const expected_slugs = Array.isArray(j.expected_slugs) ? j.expected_slugs : null;
    if (!expected_slugs || expected_slugs.length === 0 || !expected_slugs.every((s) => typeof s === 'string')) {
      throw errorFor({
        class: 'BenchmarkMalformed',
        code: 'benchmark_judge_qrels_no_expected',
        message: `Row ${rowNum} (${task_id}) judge.kind='qrels' needs expected_slugs: string[].`,
        hint: `Add an array of expected slugs the retrieval should return.`,
      });
    }
    const k = typeof j.k === 'number' && j.k > 0 ? Math.floor(j.k) : 10;
    return { kind: 'qrels', expected_slugs: expected_slugs as string[], k };
  }
  throw errorFor({
    class: 'BenchmarkMalformed',
    code: 'benchmark_judge_unknown_kind',
    message: `Row ${rowNum} (${task_id}) judge.kind='${String(kind)}' is not one of rule|llm|qrels.`,
    hint: `Use one of: {"kind":"rule","checks":[...]}, {"kind":"llm","rubric":"..."}, {"kind":"qrels","expected_slugs":[...]}.`,
  });
}

function validateRuleCheck(
  raw: unknown,
  rowNum: number,
  checkIdx: number,
  task_id: string,
  path: string,
): RuleCheck {
  if (!raw || typeof raw !== 'object') {
    throw errorFor({
      class: 'BenchmarkMalformed',
      code: 'benchmark_rule_check_malformed',
      message: `Row ${rowNum} (${task_id}) rule check #${checkIdx} is not an object.`,
      hint: `Each check must be {"op":"...","arg":...}.`,
    });
  }
  const c = raw as Record<string, unknown>;
  const op = c.op;
  if (typeof op !== 'string' || !VALID_RULE_OPS.has(op as RuleCheckOp)) {
    throw errorFor({
      class: 'BenchmarkMalformed',
      code: 'benchmark_rule_check_unknown_op',
      message: `Row ${rowNum} (${task_id}) rule check #${checkIdx} has unknown op '${String(op)}'.`,
      hint: `Valid ops: ${[...VALID_RULE_OPS].join(', ')}.`,
    });
  }
  const arg = c.arg;
  if (typeof arg !== 'string' && typeof arg !== 'number') {
    throw errorFor({
      class: 'BenchmarkMalformed',
      code: 'benchmark_rule_check_bad_arg',
      message: `Row ${rowNum} (${task_id}) rule check #${checkIdx} has non-string/number arg.`,
      hint: `arg must be a string (contains, regex, section_present, tool_called, tool_not_called) or number (max_chars, min_citations).`,
    });
  }
  return { op: op as RuleCheckOp, arg };
}

/**
 * Compute a deterministic SHA-256-prefix-8 over the benchmark contents.
 * Stable across whitespace changes (re-serializes the parsed tasks).
 */
export function computeBenchmarkSha8(tasks: BenchmarkTask[]): string {
  const canonical = tasks
    .slice()
    .sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0))
    .map((t) => JSON.stringify({ task_id: t.task_id, task: t.task, judge: t.judge }))
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

/**
 * Split a benchmark deterministically by ratio. Sorts by task_id for stable
 * splits across runs (paper: benchmarks must not shuffle between epochs).
 *
 * Returns `{train, sel, test}`. D17: refuses if D_sel < 5 — caller must
 * either add more tasks or pass an explicit --split override (which still
 * routes through this function with the override ratio).
 */
export function splitBench(
  benchmark: Benchmark,
  ratio: [number, number, number],
  opts: { allowSmallSel?: boolean } = {},
): BenchmarkSplit {
  const [r1, r2, r3] = ratio;
  if (r1 <= 0 || r2 <= 0 || r3 <= 0) {
    throw errorFor({
      class: 'BadSplit',
      code: 'split_bad_ratio',
      message: `Split ratio ${ratio.join(':')} has a zero or negative segment.`,
      hint: `Use positive integers like 4:1:5.`,
    });
  }

  const sorted = benchmark.tasks
    .slice()
    .sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));

  const total = r1 + r2 + r3;
  const n = sorted.length;
  // Round to nearest int; ensure all three buckets get at least 1 if n>=3.
  const trainN = Math.max(1, Math.floor((r1 * n) / total));
  const selN = Math.max(1, Math.floor((r2 * n) / total));
  const testN = Math.max(1, n - trainN - selN);

  const train = sorted.slice(0, trainN);
  const sel = sorted.slice(trainN, trainN + selN);
  const test = sorted.slice(trainN + selN, trainN + selN + testN);

  // D17: refuse if D_sel < 5 unless explicitly overridden.
  if (sel.length < D_SEL_MIN_SIZE && !opts.allowSmallSel) {
    throw errorFor({
      class: 'DSelTooSmall',
      code: 'd_sel_too_small',
      message: `D_sel has ${sel.length} task(s) after split (need >=${D_SEL_MIN_SIZE} for meaningful validation).`,
      hint: `Add more tasks to the benchmark (need ~${Math.ceil((D_SEL_MIN_SIZE * total) / r2)} total for ${ratio.join(':')}) or pass --split with a larger sel segment.`,
    });
  }

  return { train, sel, test };
}

/** Parse a split string like "4:1:5" into a tuple. */
export function parseSplit(s: string): [number, number, number] {
  const parts = s.split(':').map((p) => Number(p.trim()));
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p) || p <= 0)) {
    throw errorFor({
      class: 'BadSplit',
      code: 'split_unparseable',
      message: `Invalid --split value '${s}'.`,
      hint: `Use three positive integers separated by ':', e.g. '4:1:5'.`,
    });
  }
  return [parts[0]!, parts[1]!, parts[2]!];
}
