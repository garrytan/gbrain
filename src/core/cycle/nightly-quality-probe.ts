/**
 * v0.40.1.0 Track D / T6 — Nightly cross-modal quality probe phase.
 *
 * Once per 24h, runs the canonical quality pipeline:
 *   1. Select as many fixture rows as the configured cross-modal judge budget
 *      can afford, continuing after the last audited fixture index, then run
 *      LongMemEval.
 *   2. `gbrain eval cross-modal --batch <jsonl> --max-usd $cap`
 *      → batch summary with verdict.
 *   3. Audit JSONL row recording outcome / cost / pass-fail counts. Advance
 *      the durable fixture cursor only after a complete validated summary.
 *
 * Default: DISABLED. Opt-in via `gbrain config set
 * autopilot.nightly_quality_probe.enabled true`. Doctor surfaces a
 * paste-ready enable hint when disabled.
 *
 * Embedding-key dependency: longmemeval needs `gateway.embedQuery()`.
 * Short-circuits with `outcome: no_embedding_key` + stderr warn when no
 * provider is configured (mirrors how the v0.31.12 model-routing infra
 * handles missing-provider cases).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

import {
  logQualityProbeEvent,
  readRecentQualityProbeEvents,
  type QualityProbeAuditEvent,
} from '../audit-quality-probe.ts';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_SLOTS,
  estimateCost,
} from '../cross-modal-eval/runner.ts';
import { DEFAULT_CYCLES_NONTTY } from '../eval/cycle-default.ts';

/** Run-once gate window in ms. 24h matches the "nightly" cadence. */
const NIGHTLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Rotation state is recovered from the current + prior weekly audit files.
 * Fourteen days asks the reader for the full retained span; the reader itself
 * intentionally scans only those two files.
 */
const ROTATION_HISTORY_DAYS = 14;

/** Default max spend per run; matches eval-cross-modal --max-usd default. */
const DEFAULT_MAX_USD = 5.0;

/** Committed fixture used as the probe's input dataset. */
const NIGHTLY_FIXTURE_REL_PATH = 'test/fixtures/longmemeval-nightly.jsonl';

/** Result reported back to the cycle dispatcher / Minion handler. */
export interface NightlyProbeResult {
  outcome: 'pass' | 'fail' | 'inconclusive' | 'error' | 'budget_exceeded' | 'rate_limited' | 'no_embedding_key' | 'disabled';
  exit_code: number;
  detail?: string;
}

export interface NightlyProbeBatchSummary {
  total: number;
  pass_count: number;
  fail_count: number;
  inconclusive_count: number;
  error_count: number;
  upstream_error_count: number;
  malformed_count: number;
  est_cost_usd: number;
  verdict: string;
}

export interface NightlyProbeDeps {
  /** Returns true when the feature config flag is on. */
  isEnabled: () => boolean | Promise<boolean>;
  /** Returns true when an embedding provider is configured + reachable. */
  hasEmbeddingProvider: () => boolean | Promise<boolean>;
  /** Resolves the cost cap (config override OR DEFAULT_MAX_USD). */
  resolveMaxUsd: () => number | Promise<number>;
  /** Resolves the repo root so we can find the committed fixture. */
  resolveRepoRoot: () => string | Promise<string>;
  /** Runs the longmemeval command; returns the path to the JSONL output. */
  runLongMemEval: (args: { fixturePath: string; outputPath: string }) => Promise<void>;
  /** Runs exactly `limit` cross-modal rows; returns exit code (0/1/2). */
  runCrossModalBatch: (args: {
    batchPath: string;
    summaryPath: string;
    maxUsd: number;
    limit: number;
  }) => Promise<{ exitCode: number; summary?: NightlyProbeBatchSummary }>;
  /** Now provider — overridable for tests of the 24h rate limit. */
  now: () => Date;
}

/**
 * Dual-plane flag resolution (same precedent as `mcp.publish_skills` in
 * serve-http.ts): the DB config row — what `gbrain config set` writes —
 * wins when present; the file plane (~/.gbrain/config.json) is the
 * fallback. Doctor's paste-ready enable hint says `gbrain config set
 * autopilot.nightly_quality_probe.enabled true`, so the gate MUST read
 * the DB plane — a file-only read turns that hint into a silent no-op.
 */
export function resolveProbeEnabled(
  dbVal: string | null | undefined,
  fileVal: unknown,
): boolean {
  if (dbVal != null) return dbVal === 'true';
  return fileVal === true;
}

/**
 * Same dual-plane rule for the per-run cost cap. Malformed or negative
 * values on either plane fall through to the next plane / the default.
 */
export function resolveProbeMaxUsd(
  dbVal: string | null | undefined,
  fileVal: unknown,
  fallback: number = DEFAULT_MAX_USD,
): number {
  if (dbVal != null) {
    const n = Number(dbVal);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (fileVal != null) {
    const n = Number(fileVal);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/**
 * Pure function: decide whether the probe should run given the audit
 * history. Returns reason when skipping.
 */
export function shouldRunNightly(
  now: Date,
  recentEvents: ReadonlyArray<{ ts: string }>,
  windowMs: number = NIGHTLY_WINDOW_MS,
): { run: true } | { run: false; reason: 'rate_limited' } {
  const cutoff = now.getTime() - windowMs;
  for (const ev of recentEvents) {
    const ts = Date.parse(ev.ts);
    if (Number.isFinite(ts) && ts >= cutoff) {
      return { run: false, reason: 'rate_limited' };
    }
  }
  return { run: true };
}

export interface NightlyFixtureBatchSelection {
  /** Selected JSONL rows, in execution order, with one trailing newline. */
  rows: string;
  questionIds: string[];
  /** Zero-based index of the first selected row. */
  startIndex: number;
  /** Zero-based index of the last selected row; persisted only after validation. */
  lastIndex: number;
  count: number;
  total: number;
}

/**
 * Derive the affordable question count from the exact estimator/defaults used
 * by non-interactive `eval cross-modal --batch`. This keeps a $0.20 cap at one
 * question while preserving all 10 committed fixture rows under the default
 * $5 cap.
 */
export function resolveNightlyProbeBatchSize(
  maxUsd: number,
  fixtureTotal: number,
): { count: number; perQuestionUsd: number } {
  const estimate = estimateCost(
    DEFAULT_SLOTS,
    DEFAULT_CYCLES_NONTTY,
    DEFAULT_MAX_TOKENS,
  );
  const perQuestionUsd = estimate.perRunMaxUSD;
  if (!(perQuestionUsd > 0)) {
    throw new Error('nightly probe cannot enforce budget: cross-modal cost estimate is unavailable');
  }
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || fixtureTotal <= 0) {
    return { count: 0, perQuestionUsd };
  }
  // Tiny epsilon prevents an exact decimal cap such as 0.20 from flooring to
  // zero if a future estimator produces a binary floating representation just
  // above the configured value.
  const affordable = Math.floor((maxUsd + 1e-9) / perQuestionUsd);
  return {
    count: Math.max(0, Math.min(fixtureTotal, affordable)),
    perQuestionUsd,
  };
}

export type NightlySummaryValidation =
  | { valid: true }
  | { valid: false; detail: string };

/**
 * A completed cross-modal summary is the only event allowed to advance the
 * fixture cursor. Fail closed on partial/malformed denominators: otherwise a
 * truncated batch could silently skip unjudged fixture rows on the next run.
 */
export function validateNightlyProbeSummary(
  summary: NightlyProbeBatchSummary,
  expectedCount: number,
): NightlySummaryValidation {
  const validVerdicts = new Set(['pass', 'fail', 'inconclusive', 'error']);
  if (!validVerdicts.has(summary.verdict)) {
    return { valid: false, detail: `cross-modal summary has unknown verdict: ${summary.verdict}` };
  }

  const countFields = [
    ['total', summary.total],
    ['pass_count', summary.pass_count],
    ['fail_count', summary.fail_count],
    ['inconclusive_count', summary.inconclusive_count],
    ['error_count', summary.error_count],
    ['upstream_error_count', summary.upstream_error_count],
    ['malformed_count', summary.malformed_count],
  ] as const;
  for (const [name, value] of countFields) {
    if (!Number.isInteger(value) || value < 0) {
      return { valid: false, detail: `cross-modal summary ${name} is invalid: ${value}` };
    }
  }

  if (summary.total !== expectedCount) {
    return {
      valid: false,
      detail:
        `cross-modal summary total ${summary.total} does not match selected fixture count ` +
        `${expectedCount}`,
    };
  }

  const accounted =
    summary.pass_count +
    summary.fail_count +
    summary.inconclusive_count +
    summary.error_count +
    summary.upstream_error_count +
    summary.malformed_count;
  if (accounted !== expectedCount) {
    return {
      valid: false,
      detail:
        `cross-modal summary outcome counts total ${accounted} does not match selected ` +
        `fixture count ${expectedCount}`,
    };
  }

  return { valid: true };
}

interface ParsedFixtureRow {
  row: string;
  questionId: string;
}

function parseNightlyFixture(content: string): ParsedFixtureRow[] {
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) throw new Error('nightly fixture has zero usable rows');

  return lines.map((row, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row);
    } catch {
      throw new Error(`nightly fixture row ${index + 1}/${lines.length} is malformed JSON`);
    }
    const questionId =
      parsed && typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).question_id === 'string'
        ? (parsed as Record<string, unknown>).question_id as string
        : '';
    if (!questionId) {
      throw new Error(`nightly fixture row ${index + 1}/${lines.length} has no question_id`);
    }
    return { row, questionId };
  });
}

/**
 * Select a budget-sized fixture batch. Rotation is completion-cursor based,
 * not calendar based: the newest matching completed audit row stores the last
 * judged index, so a delayed run continues with index + 1 instead of skipping
 * rows. Failed attempts deliberately omit question_index and retry.
 *
 * A fixture SHA or row-count change resets the cursor to index 0. Audit
 * history is intentionally bounded by the caller's retained weekly files.
 */
export function selectNightlyFixtureBatch(
  content: string,
  batchSize: number,
  recentEvents: ReadonlyArray<
    Pick<QualityProbeAuditEvent, 'ts' | 'fixture_sha8' | 'question_index' | 'question_total'>
  >,
  fixtureSha8: string | undefined,
): NightlyFixtureBatchSelection {
  const fixture = parseNightlyFixture(content);
  const count = Number.isFinite(batchSize)
    ? Math.max(0, Math.min(fixture.length, Math.floor(batchSize)))
    : 0;
  if (count === 0) {
    throw new Error('nightly fixture batch size must be at least 1');
  }

  let latestCursorIndex: number | undefined;
  let latestTs = Number.NEGATIVE_INFINITY;
  if (fixtureSha8 !== undefined) {
    for (const event of recentEvents) {
      const index = event.question_index;
      if (
        event.fixture_sha8 !== fixtureSha8 ||
        event.question_total !== fixture.length ||
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= fixture.length
      ) {
        continue;
      }
      const ts = Date.parse(event.ts);
      if (Number.isFinite(ts) && ts > latestTs) {
        latestCursorIndex = index;
        latestTs = ts;
      }
    }
  }

  const startIndex = latestCursorIndex !== undefined
    ? (latestCursorIndex + 1) % fixture.length
    : 0;
  const selected = Array.from(
    { length: count },
    (_, offset) => fixture[(startIndex + offset) % fixture.length]!,
  );
  const lastIndex = (startIndex + count - 1) % fixture.length;

  return {
    rows: `${selected.map(item => item.row).join('\n')}\n`,
    questionIds: selected.map(item => item.questionId),
    startIndex,
    lastIndex,
    count,
    total: fixture.length,
  };
}

function sha8File(p: string): string | undefined {
  try {
    const content = fs.readFileSync(p);
    return createHash('sha256').update(content).digest('hex').slice(0, 8);
  } catch {
    return undefined;
  }
}

/**
 * Run the nightly probe. Pure DI surface — `deps` controls every external
 * effect so tests can stub long-running paths.
 */
export async function runNightlyQualityProbe(deps: NightlyProbeDeps): Promise<NightlyProbeResult> {
  const enabled = await deps.isEnabled();
  if (!enabled) {
    // Disabled-by-default; no audit row (doctor reads config separately).
    return { outcome: 'disabled', exit_code: 0, detail: 'feature flag off' };
  }

  // 24h rate limit — skip WITHOUT an audit row. The autopilot loop invokes
  // the probe every cycle (~5-10 min), so all but one invocation per day
  // lands here; logging each skip floods the audit file (~hundreds of
  // rows/day) and — because doctor treats any non-pass outcome as bad
  // signal — flips nightly_quality_probe_health to a permanent WARN the
  // moment the probe is enabled. A skip is a non-event: the real runs are
  // the signal, and their rows are what gates the next 24h window.
  const now = deps.now();
  // The same bounded history powers both the 24h gate and the durable fixture
  // cursor. It spans the two weekly files retained by the audit reader.
  const recent = readRecentQualityProbeEvents(ROTATION_HISTORY_DAYS, now);
  const decision = shouldRunNightly(now, recent);
  if (!decision.run) {
    return { outcome: 'rate_limited', exit_code: 0, detail: 'already ran within 24h' };
  }

  // Embedding key check (longmemeval embeds queries).
  const hasEmbed = await deps.hasEmbeddingProvider();
  if (!hasEmbed) {
    process.stderr.write(
      `[nightly-quality-probe] no embedding provider configured; skipping. ` +
      `Configure OPENAI_API_KEY / VOYAGE_API_KEY / ZEROENTROPY_API_KEY and re-enable.\n`,
    );
    logQualityProbeEvent({
      ts: now.toISOString(),
      outcome: 'no_embedding_key',
      exit_code: 0,
      pass_count: 0,
      fail_count: 0,
      inconclusive_count: 0,
      error_count: 0,
      est_cost_usd: 0,
      detail: 'no embedding provider configured',
    });
    return { outcome: 'no_embedding_key', exit_code: 0, detail: 'no embedding provider' };
  }

  const repoRoot = await deps.resolveRepoRoot();
  const fixturePath = path.join(repoRoot, NIGHTLY_FIXTURE_REL_PATH);
  if (!fs.existsSync(fixturePath)) {
    const detail = `nightly fixture not found at ${fixturePath}`;
    process.stderr.write(`[nightly-quality-probe] ${detail}\n`);
    logQualityProbeEvent({
      ts: now.toISOString(),
      outcome: 'error',
      exit_code: 1,
      pass_count: 0,
      fail_count: 0,
      inconclusive_count: 0,
      error_count: 0,
      est_cost_usd: 0,
      detail,
    });
    return { outcome: 'error', exit_code: 1, detail };
  }

  const fixtureSha8 = sha8File(fixturePath);
  const resolvedMaxUsd = await deps.resolveMaxUsd();
  const maxUsd =
    Number.isFinite(resolvedMaxUsd) && resolvedMaxUsd >= 0
      ? resolvedMaxUsd
      : DEFAULT_MAX_USD;

  let workDir: string | undefined;
  let selection: NightlyFixtureBatchSelection | undefined;
  try {
    const fixtureContent = fs.readFileSync(fixturePath, 'utf8');
    const fixtureTotal = parseNightlyFixture(fixtureContent).length;
    const budget = resolveNightlyProbeBatchSize(maxUsd, fixtureTotal);
    if (budget.count < 1) {
      const detail =
        `max_usd $${maxUsd.toFixed(2)} cannot fund one cross-modal question ` +
        `(estimated $${budget.perQuestionUsd.toFixed(2)})`;
      logQualityProbeEvent({
        ts: now.toISOString(),
        outcome: 'budget_exceeded',
        exit_code: 1,
        pass_count: 0,
        fail_count: 0,
        inconclusive_count: 0,
        error_count: 0,
        est_cost_usd: 0,
        fixture_sha8: fixtureSha8,
        question_count: 0,
        question_total: fixtureTotal,
        detail,
      });
      return { outcome: 'budget_exceeded', exit_code: 1, detail };
    }

    selection = selectNightlyFixtureBatch(
      fixtureContent,
      budget.count,
      recent,
      fixtureSha8,
    );

    // Tempdir for the selected fixture JSONL, hypotheses, and batch summary.
    workDir = fs.mkdtempSync(path.join(tmpdir(), 'nightly-probe-'));
    const selectedFixturePath = path.join(workDir, 'selected-fixture.jsonl');
    const lmeOutPath = path.join(workDir, 'lme-output.jsonl');
    const summaryPath = path.join(workDir, 'summary.json');
    fs.writeFileSync(selectedFixturePath, selection.rows, 'utf8');

    await deps.runLongMemEval({ fixturePath: selectedFixturePath, outputPath: lmeOutPath });
    const { exitCode, summary } = await deps.runCrossModalBatch({
      batchPath: lmeOutPath,
      summaryPath,
      maxUsd,
      limit: selection.count,
    });

    const summaryValidation = summary
      ? validateNightlyProbeSummary(summary, selection.count)
      : undefined;
    const completedSummary = summary !== undefined && summaryValidation?.valid === true;
    const outcome: NightlyProbeResult['outcome'] = (() => {
      if (summary && completedSummary) {
        if (summary.verdict === 'pass') return 'pass';
        if (summary.verdict === 'fail') return 'fail';
        if (summary.verdict === 'inconclusive') return 'inconclusive';
        if (summary.verdict === 'error') return 'error';
      }
      return 'error';
    })();
    const detail =
      summaryValidation?.valid === false
        ? summaryValidation.detail
        : summary === undefined
          ? `cross-modal batch exited ${exitCode} without a summary`
          : undefined;
    const lastQuestionId = completedSummary
      ? selection.questionIds[selection.questionIds.length - 1]!
      : undefined;

    logQualityProbeEvent({
      ts: now.toISOString(),
      outcome,
      exit_code: exitCode,
      pass_count: summary?.pass_count ?? 0,
      fail_count: summary?.fail_count ?? 0,
      inconclusive_count: summary?.inconclusive_count ?? 0,
      error_count: summary?.error_count ?? 0,
      est_cost_usd: summary?.est_cost_usd ?? 0,
      fixture_sha8: fixtureSha8,
      question_ids: selection.questionIds,
      question_count: selection.count,
      question_total: selection.total,
      ...(lastQuestionId !== undefined ? {
        question_id: lastQuestionId,
        question_index: selection.lastIndex,
      } : {}),
      detail,
    });

    return { outcome, exit_code: exitCode, ...(detail ? { detail } : {}) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[nightly-quality-probe] runtime error: ${detail}\n`);
    logQualityProbeEvent({
      ts: now.toISOString(),
      outcome: 'error',
      exit_code: 1,
      pass_count: 0,
      fail_count: 0,
      inconclusive_count: 0,
      error_count: 0,
      est_cost_usd: 0,
      fixture_sha8: fixtureSha8,
      ...(selection !== undefined ? {
        question_ids: selection.questionIds,
        question_count: selection.count,
        question_total: selection.total,
      } : {}),
      detail,
    });
    return { outcome: 'error', exit_code: 1, detail };
  } finally {
    if (workDir !== undefined) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
  }
}
