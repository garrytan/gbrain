/**
 * v0.40.1.0 Track D / T6 — Nightly cross-modal quality probe phase.
 *
 * Once per 24h, runs the canonical quality pipeline:
 *   1. `gbrain eval longmemeval --by-type` against the committed nightly
 *      fixture (test/fixtures/longmemeval-nightly.jsonl) → JSONL output.
 *   2. `gbrain eval cross-modal --batch <jsonl> --max-usd $cap --yes`
 *      → batch summary with verdict.
 *   3. Audit JSONL row recording outcome / cost / pass-fail counts, the
 *      judge panel, the non-passing questions with per-judge scores and
 *      the run's metered chat spend (#5506).
 *
 * Both stages run under one BudgetTracker capped at `max_usd` (CEO B4).
 * A collapsed judge panel is inconclusive, and a non-pass run keeps its
 * receipts under the audit dir (#5506, D12).
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
  type QualityProbeFailure,
} from '../audit-quality-probe.ts';
import { withChatCallMeter, type ChatCallMeter } from '../ai/chat-usage.ts';
import { withBudgetTracker } from '../ai/gateway.ts';
import {
  BudgetExhausted,
  BudgetTracker,
  type BudgetActualUsage,
  type BudgetEstimate,
  type BudgetReservation,
  type PricingOverrides,
} from '../budget/budget-tracker.ts';
import { resolveAuditDir } from '../minions/handlers/shell-audit.ts';
import type { CrossModalBatchSummary } from './nightly-probe-adapters.ts';
import { NightlyProbeModelRoutesError, type NightlyProbeModelRoutes } from './nightly-probe-routes.ts';

/** Run-once gate window in ms. 24h matches the "nightly" cadence. */
const NIGHTLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Default run-level USD cap over every paid call of a probe run (LongMemEval
 * reader, extractor and query embeddings, then the judges). A default cap:
 * an unpriced model warns and runs; a configured `max_usd` is a user cap and
 * refuses an unpriced model with the shared no_pricing guidance.
 */
const DEFAULT_MAX_USD = 5.0;

/** Receipt directories (batch summary + LongMemEval output of a non-pass run) kept under the audit dir. */
const RECEIPTS_KEPT = 7;

/** Where a non-pass run's receipts go, under the audit dir (honors GBRAIN_AUDIT_DIR). */
const RECEIPTS_DIR = 'nightly-probe';

/** Committed fixture used as the probe's input dataset. */
const NIGHTLY_FIXTURE_REL_PATH = 'test/fixtures/longmemeval-nightly.jsonl';

export const NIGHTLY_PROBE_SEARCH_CONFIG_KEYS: ReadonlyArray<string> = Object.freeze([
  'search.mode',
  'search.reranker.enabled',
  'search.reranker.model',
  'search.reranker.top_n_in',
  'search.reranker.top_n_out',
  'search.reranker.timeout_ms',
]);

/** Result reported back to the cycle dispatcher / Minion handler. */
export interface NightlyProbeResult {
  outcome: 'pass' | 'fail' | 'inconclusive' | 'error' | 'budget_exceeded' | 'rate_limited' | 'no_embedding_key' | 'skipped' | 'disabled';
  exit_code: number;
  detail?: string;
}

export interface NightlyProbeDeps {
  /** Returns true when the feature config flag is on. */
  isEnabled: () => boolean | Promise<boolean>;
  /** Returns true when an embedding provider is configured + reachable. */
  hasEmbeddingProvider: () => boolean | Promise<boolean>;
  /** Resolves the run-level USD cap (config override OR DEFAULT_MAX_USD). */
  resolveMaxUsd: () => number | Promise<number>;
  /**
   * Where the cap came from and the brain's `pricing.overrides`: a `user` cap
   * (a configured max_usd) refuses an unpriced model, a `default` cap warns
   * and runs it. Absent: a default cap with no overrides.
   */
  resolveBudgetPolicy?: () => Promise<{ capSource: 'user' | 'default'; pricingOverrides?: PricingOverrides }>;
  /** Path of the LongMemEval fixture (the embedded asset, #5187); wins over resolveRepoRoot. */
  resolveFixturePath?: () => string | Promise<string>;
  /** Resolves a root holding test/fixtures/longmemeval-nightly.jsonl (used when resolveFixturePath is absent). */
  resolveRepoRoot?: () => string | Promise<string>;
  /** Resolves live search-mode/reranker overrides copied into the isolated benchmark brain. */
  resolveSearchConfigSnapshot?: () => Record<string, string> | Promise<Record<string, string>>;
  /**
   * Refreshes the gateway from the live brain and resolves the reader,
   * extractor and judge-slot routes (#5872). Runs only on a run that passed
   * the rate limit; a rejection becomes an `error` audit row.
   */
  resolveModelRoutes?: () => Promise<NightlyProbeModelRoutes>;
  /** Runs the longmemeval command; returns the path to the JSONL output. */
  runLongMemEval: (args: {
    fixturePath: string;
    outputPath: string;
    searchConfigSnapshot?: Record<string, string>;
    modelRoutes?: NightlyProbeModelRoutes;
  }) => Promise<void>;
  /** Runs the cross-modal batch; returns exit code (0/1/2). */
  runCrossModalBatch: (args: {
    batchPath: string;
    summaryPath: string;
    maxUsd: number;
    modelRoutes?: NightlyProbeModelRoutes;
  }) => Promise<{ exitCode: number; summary?: CrossModalBatchSummary }>;
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
 * Same dual-plane rule for the run-level USD cap. Malformed or negative
 * values on either plane fall through to the next plane / the default.
 */
export function resolveProbeMaxUsd(
  dbVal: string | null | undefined,
  fileVal: unknown,
  fallback: number = DEFAULT_MAX_USD,
): number {
  return resolveProbeCap(dbVal, fileVal, fallback).maxUsd;
}

/** The run-level cap and its source: a valid value on either plane is a `user` cap, else the `default`. */
export function resolveProbeCap(
  dbVal: string | null | undefined,
  fileVal: unknown,
  fallback: number = DEFAULT_MAX_USD,
): { maxUsd: number; capSource: 'user' | 'default' } {
  for (const raw of [dbVal, fileVal]) {
    if (raw == null) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return { maxUsd: n, capSource: 'user' };
  }
  return { maxUsd: fallback, capSource: 'default' };
}

/**
 * The run's one BudgetTracker (CEO B4): every gateway chat and embed call of
 * both stages reserves against it, so the LongMemEval stage is capped too.
 * Keeps the first refusal so the phase can tell a budget stop from a crash
 * even when LongMemEval records the refusal as a per-question error.
 */
class ProbeBudgetTracker extends BudgetTracker {
  exhausted: BudgetExhausted | null = null;

  override reserve(estimate: BudgetEstimate): BudgetReservation | undefined {
    try {
      return super.reserve(estimate);
    } catch (err) {
      if (err instanceof BudgetExhausted) this.exhausted ??= err;
      throw err;
    }
  }

  override record(actual: BudgetActualUsage & { kind?: BudgetEstimate['kind'] }): void {
    try {
      super.record(actual);
    } catch (err) {
      if (err instanceof BudgetExhausted) this.exhausted ??= err;
      throw err;
    }
  }
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

function sha8File(p: string): string | undefined {
  try {
    const content = fs.readFileSync(p);
    return createHash('sha256').update(content).digest('hex').slice(0, 8);
  } catch {
    return undefined;
  }
}

/** A non-pass audit row lists at most this many questions; its digest counts them all. */
const AUDIT_MAX_FAILURES = 10;

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The non-pass row's one-line `detail`: questions that did not pass out of
 * the total, the count per failing dimension and reason (per verdict for a
 * question with no failing dimension, and the malformed rows, which have
 * no failure entry), and the judge panel. Undefined when the batch names
 * no question that did not pass.
 */
function failureDigest(summary: CrossModalBatchSummary, failures: QualityProbeFailure[]): string | undefined {
  const tally = new Map<string, number>();
  for (const f of failures) {
    const keys = f.dimensions?.length ? f.dimensions.map(d => `${d.dimension} ${d.fail_reason}`) : [f.verdict];
    for (const key of keys) tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const malformed = summary.malformed_count ?? 0;
  if (malformed > 0) tally.set('malformed', malformed);
  const notPassed = failures.length + malformed;
  if (notPassed === 0) return undefined;
  const total = summary.total ?? summary.pass_count + notPassed;
  const reasons = [...tally].map(([key, n]) => `${key} x${n}`).join(', ');
  return `${notPassed}/${total} questions did not pass (${reasons})${panelDigest(summary)}`;
}

/** The digest's judge panel, naming each slot (A, B, C in slot order) that scored no question. */
function panelDigest(summary: CrossModalBatchSummary): string {
  const panel = summary.panel;
  if (!panel) return '';
  const silent = (panel.slot_scored_questions ?? []).flatMap((scored, i) => {
    if (scored > 0) return [];
    const model = summary.judge_models?.[i];
    return [`, slot ${String.fromCharCode(65 + i)}${model ? ` (${model})` : ''} scored no question`];
  });
  return `; judges: ${plural(panel.distinct_models, 'distinct model')} from ` +
    `${plural(panel.distinct_providers, 'provider')}${silent.join('')}`;
}

/** The judge panel of a completed batch: models in slot order, per-slot scored counts, distinct counts. */
function panelFields(summary: CrossModalBatchSummary): Partial<QualityProbeAuditEvent> {
  const panel = summary.panel;
  return {
    ...(summary.judge_models ? { judge_models: summary.judge_models } : {}),
    ...(panel?.slot_scored_questions ? { judge_scored_questions: panel.slot_scored_questions } : {}),
    ...(panel
      ? { distinct_judge_models: panel.distinct_models, distinct_judge_providers: panel.distinct_providers }
      : {}),
  };
}

/** Reader and extractor of a run whose routes resolved (#5872). */
function routeFields(routes: NightlyProbeModelRoutes | undefined): Partial<QualityProbeAuditEvent> {
  return routes ? { reader_model: routes.reader.model, extractor_model: routes.extractor.model } : {};
}

/** Metered chat spend of every call; `est_cost_usd` stays the batch's pre-flight estimate for its judges. */
function spendFields(meter: ChatCallMeter): Partial<QualityProbeAuditEvent> {
  return {
    chat_calls: meter.calls,
    chat_cost_usd: Math.round((meter.cost_usd ?? 0) * 1e6) / 1e6,
    unpriced_chat_calls: meter.unpriced_calls ?? 0,
  };
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
  const recent = readRecentQualityProbeEvents(2, now); // 2-day window is enough for 24h check
  const decision = shouldRunNightly(now, recent);
  if (!decision.run) {
    return { outcome: 'rate_limited', exit_code: 0, detail: 'already ran within 24h' };
  }

  // Embedding key check (longmemeval embeds queries).
  const hasEmbed = await deps.hasEmbeddingProvider();
  if (!hasEmbed) {
    process.stderr.write(
      `[nightly-quality-probe] no embedding provider configured; skipping. ` +
      `Configure VOYAGE_API_KEY / OPENAI_API_KEY and re-enable.\n`,
    );
    logQualityProbeEvent({
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

  const fixturePath = deps.resolveFixturePath
    ? await deps.resolveFixturePath()
    : path.join(deps.resolveRepoRoot ? await deps.resolveRepoRoot() : process.cwd(), NIGHTLY_FIXTURE_REL_PATH);
  if (!fs.existsSync(fixturePath)) {
    // A skip, not a runtime error (#5187): the probe could not run, so the
    // row says why instead of blaming a file in the user's brain repo.
    const detail =
      `the nightly fixture is not readable at ${fixturePath}, so the probe gave no quality signal. ` +
      `Reinstall gbrain (bun install -g github:garrytan/gbrain) and run gbrain doctor. See docs/eval-bench.md#nightly-cross-modal-quality-probe-opt-in-autopilot`;
    process.stderr.write(`[nightly-quality-probe] ${detail}\n`);
    logQualityProbeEvent({
      outcome: 'skipped',
      exit_code: 0,
      pass_count: 0,
      fail_count: 0,
      inconclusive_count: 0,
      error_count: 0,
      est_cost_usd: 0,
      reason: 'fixture_unavailable',
      detail,
    });
    return { outcome: 'skipped', exit_code: 0, detail };
  }

  const fixtureSha8 = sha8File(fixturePath);
  const maxUsd = (await deps.resolveMaxUsd()) ?? DEFAULT_MAX_USD;

  // Tempdir for the per-question hypothesis JSONL + batch summary.
  const workDir = fs.mkdtempSync(path.join(tmpdir(), 'nightly-probe-'));
  const lmeOutPath = path.join(workDir, 'lme-output.jsonl');
  const summaryPath = path.join(workDir, 'summary.json');

  // Set once a stage that makes model calls starts: the routes the run
  // uses (#5872), the meter pricing its chat calls (#5506) and the run
  // budget, so a row written after a part-way failure still carries them.
  let modelRoutes: NightlyProbeModelRoutes | undefined;
  let meter: ChatCallMeter | undefined;
  let tracker: ProbeBudgetTracker | undefined;
  let capFields: Partial<QualityProbeAuditEvent> = {};
  const stopped = (): Partial<QualityProbeAuditEvent> => {
    if (!tracker?.exhausted) return {};
    const reason = tracker.exhausted.reason;
    return {
      reason,
      detail:
        `stopped by the run budget before a verdict (${reason}): ${tracker.exhausted.message} ` +
        `No further paid call was made. Raise the cap with: gbrain config set autopilot.nightly_quality_probe.max_usd <usd>`,
    };
  };
  try {
    const searchConfigSnapshot = deps.resolveSearchConfigSnapshot
      ? await deps.resolveSearchConfigSnapshot()
      : undefined;
    if (deps.resolveModelRoutes) {
      try {
        modelRoutes = await deps.resolveModelRoutes();
      } catch (err) {
        throw err instanceof NightlyProbeModelRoutesError ? err : new NightlyProbeModelRoutesError(err);
      }
    }
    const policy = deps.resolveBudgetPolicy ? await deps.resolveBudgetPolicy() : { capSource: 'default' as const };
    tracker = new ProbeBudgetTracker({
      label: 'nightly_quality_probe',
      maxCostUsd: maxUsd,
      capSource: policy.capSource,
      ...(policy.pricingOverrides ? { pricingOverrides: policy.pricingOverrides } : {}),
    });
    capFields = { cap_usd: maxUsd, cap_source: policy.capSource };
    const runTracker = tracker;
    meter = { calls: 0, cost_usd: 0, unpriced_calls: 0, ...(policy.pricingOverrides ? { pricing_overrides: policy.pricingOverrides } : {}) };
    const runMeter = meter;
    await withBudgetTracker(runTracker, () => withChatCallMeter(runMeter, () =>
      deps.runLongMemEval({ fixturePath, outputPath: lmeOutPath, searchConfigSnapshot, modelRoutes })));
    if (runTracker.exhausted) {
      const fields = stopped();
      process.stderr.write(`[nightly-quality-probe] ${fields.detail}\n`);
      logQualityProbeEvent({
        outcome: 'budget_exceeded',
        exit_code: 1,
        pass_count: 0,
        fail_count: 0,
        inconclusive_count: 0,
        error_count: 0,
        est_cost_usd: 0,
        fixture_sha8: fixtureSha8,
        ...fields,
        ...routeFields(modelRoutes),
        ...spendFields(runMeter),
        ...capFields,
        ...keepReceipts(workDir, deps.now()),
      });
      return { outcome: 'budget_exceeded', exit_code: 1, detail: fields.detail };
    }
    const { exitCode, summary } = await withBudgetTracker(runTracker, () => withChatCallMeter(runMeter, () =>
      deps.runCrossModalBatch({
        batchPath: lmeOutPath,
        summaryPath,
        maxUsd,
        modelRoutes,
      })));

    const verdict: NightlyProbeResult['outcome'] = (() => {
      if (runTracker.exhausted) return 'budget_exceeded';
      if (summary) {
        if (summary.verdict === 'pass') return 'pass';
        if (summary.verdict === 'fail') return 'fail';
        if (summary.verdict === 'inconclusive') return 'inconclusive';
        if (summary.verdict === 'error') return 'error';
      }
      // If exit code is 1 with no summary, the batch refused (budget).
      if (exitCode === 1) return 'budget_exceeded';
      return 'error';
    })();
    const collapse = (verdict === 'pass' || verdict === 'fail') && summary ? collapsedPanel(summary) : undefined;
    const outcome: NightlyProbeResult['outcome'] = collapse ? 'inconclusive' : verdict;

    const failures = outcome !== 'pass' ? summary?.failures : undefined;
    const digest = summary && outcome !== 'pass' ? failureDigest(summary, failures ?? []) : undefined;
    const detail = collapse
      ? `${collapse} (batch verdict: ${verdict})${digest ? `; ${digest}` : ''}`
      : digest;
    logQualityProbeEvent({
      outcome,
      exit_code: exitCode,
      pass_count: summary?.pass_count ?? 0,
      fail_count: summary?.fail_count ?? 0,
      inconclusive_count: summary?.inconclusive_count ?? 0,
      error_count: summary?.error_count ?? 0,
      est_cost_usd: summary?.est_cost_usd ?? 0,
      fixture_sha8: fixtureSha8,
      ...(detail ? { detail } : {}),
      ...(collapse ? { reason: 'panel_collapsed' } : {}),
      ...stopped(),
      ...routeFields(modelRoutes),
      ...(summary ? panelFields(summary) : {}),
      ...(failures?.length ? { failures: failures.slice(0, AUDIT_MAX_FAILURES) } : {}),
      ...spendFields(runMeter),
      ...capFields,
      ...(outcome !== 'pass' ? keepReceipts(workDir, deps.now()) : {}),
    });

    return { outcome, exit_code: exitCode, ...(detail ? { detail } : {}) };
  } catch (err) {
    const budget = stopped();
    const outcome = budget.reason ? 'budget_exceeded' : 'error';
    const detail = budget.detail ?? (err instanceof Error ? err.message : String(err));
    process.stderr.write(`[nightly-quality-probe] ${outcome === 'error' ? 'runtime error: ' : ''}${detail}\n`);
    logQualityProbeEvent({
      outcome,
      exit_code: 1,
      pass_count: 0,
      fail_count: 0,
      inconclusive_count: 0,
      error_count: 0,
      est_cost_usd: 0,
      fixture_sha8: fixtureSha8,
      detail,
      ...(budget.reason ? { reason: budget.reason } : {}),
      ...routeFields(modelRoutes),
      ...(meter ? spendFields(meter) : {}),
      ...capFields,
      ...keepReceipts(workDir, deps.now()),
    });
    return { outcome, exit_code: 1, detail };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
}

/**
 * A panel that is not three independent judges (#5506, D12): among the
 * slots that scored, one model holding two or more slots (its votes count
 * more than once), or fewer than two distinct models. Returns the detail's
 * problem + next step, or undefined for a sound panel or a summary without
 * panel fields (older batches keep their verdict).
 */
function collapsedPanel(summary: CrossModalBatchSummary): string | undefined {
  const models = summary.judge_models;
  const panel = summary.panel;
  if (!models || !panel) return undefined;
  const scored = panel.slot_scored_questions;
  const judged = models.flatMap((model, i) =>
    scored && !((scored[i] ?? 0) > 0) ? [] : [{ model, id: String.fromCharCode(65 + i) }]);
  const remedy =
    'Set three different judge models: gbrain config set models.eval.cross_modal.slot_a <model> ' +
    '(and slot_b, slot_c; one provider is enough). See docs/eval-bench.md#nightly-cross-modal-quality-probe-opt-in-autopilot';
  if (panel.distinct_models < 2) {
    return `judge panel collapsed: ${plural(panel.distinct_models, 'distinct model')} judged, so there is no cross-check. ${remedy}`;
  }
  const slotsByModel = new Map<string, string[]>();
  for (const { model, id } of judged) slotsByModel.set(model, [...(slotsByModel.get(model) ?? []), id]);
  const shared = [...slotsByModel].filter(([, ids]) => ids.length > 1);
  if (shared.length === 0) return undefined;
  const holders = shared.map(([model, ids]) => `${model} holds slots ${ids.join(', ')}`).join('; ');
  return `judge panel collapsed: ${holders}, so its votes count more than once. ${remedy}`;
}

/**
 * Keep a non-pass run's batch summary and LongMemEval output (#5506) under
 * `<audit dir>/nightly-probe/<ts>/`, pruning to the newest RECEIPTS_KEPT.
 * The fixture is synthetic, so receipts hold no user data. Best-effort:
 * returns `receipt_dir` only when at least one file was kept.
 */
function keepReceipts(workDir: string, now: Date): Partial<QualityProbeAuditEvent> {
  try {
    const files = ['summary.json', 'lme-output.jsonl'].filter(f => fs.existsSync(path.join(workDir, f)));
    if (files.length === 0) return {};
    const root = path.join(resolveAuditDir(), RECEIPTS_DIR);
    const dir = path.join(root, now.toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(workDir, f), path.join(dir, f));
    const kept = fs.readdirSync(root).sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - RECEIPTS_KEPT))) {
      fs.rmSync(path.join(root, old), { recursive: true, force: true });
    }
    return { receipt_dir: dir };
  } catch (err) {
    process.stderr.write(`[nightly-quality-probe] could not keep the run's receipts: ${err instanceof Error ? err.message : String(err)}\n`);
    return {};
  }
}
