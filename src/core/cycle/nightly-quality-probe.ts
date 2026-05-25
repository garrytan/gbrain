/**
 * v0.40.1.0 Track D / T6 — Nightly cross-modal quality probe phase.
 *
 * Once per 24h, runs the canonical quality pipeline:
 *   1. `gbrain eval longmemeval --by-type` against the committed nightly
 *      fixture (test/fixtures/longmemeval-nightly.jsonl) → JSONL output.
 *   2. `gbrain eval cross-modal --batch <jsonl> --max-usd $cap --yes`
 *      → batch summary with verdict.
 *   3. Audit JSONL row recording outcome / cost / pass-fail counts.
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

import { logQualityProbeEvent, readRecentQualityProbeEvents } from '../audit-quality-probe.ts';

/** Run-once gate window in ms. 24h matches the "nightly" cadence. */
const NIGHTLY_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  /** Runs the cross-modal batch; returns exit code (0/1/2). */
  runCrossModalBatch: (args: {
    batchPath: string;
    summaryPath: string;
    maxUsd: number;
  }) => Promise<{ exitCode: number; summary?: { pass_count: number; fail_count: number; inconclusive_count: number; error_count: number; est_cost_usd: number; verdict: string } }>;
  /** Now provider — overridable for tests of the 24h rate limit. */
  now: () => Date;
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

  // 24h rate limit — skip + audit "rate_limited".
  const now = deps.now();
  const recent = readRecentQualityProbeEvents(2, now); // 2-day window is enough for 24h check
  const decision = shouldRunNightly(now, recent);
  if (!decision.run) {
    logQualityProbeEvent({
      outcome: 'rate_limited',
      exit_code: 0,
      pass_count: 0,
      fail_count: 0,
      inconclusive_count: 0,
      error_count: 0,
      est_cost_usd: 0,
      detail: 'already ran within 24h window',
    });
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
  const maxUsd = (await deps.resolveMaxUsd()) ?? DEFAULT_MAX_USD;

  // Tempdir for the per-question hypothesis JSONL + batch summary.
  const workDir = fs.mkdtempSync(path.join(tmpdir(), 'nightly-probe-'));
  const lmeOutPath = path.join(workDir, 'lme-output.jsonl');
  const summaryPath = path.join(workDir, 'summary.json');

  try {
    await deps.runLongMemEval({ fixturePath, outputPath: lmeOutPath });
    const { exitCode, summary } = await deps.runCrossModalBatch({
      batchPath: lmeOutPath,
      summaryPath,
      maxUsd,
    });

    const outcome: NightlyProbeResult['outcome'] = (() => {
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

    logQualityProbeEvent({
      outcome,
      exit_code: exitCode,
      pass_count: summary?.pass_count ?? 0,
      fail_count: summary?.fail_count ?? 0,
      inconclusive_count: summary?.inconclusive_count ?? 0,
      error_count: summary?.error_count ?? 0,
      est_cost_usd: summary?.est_cost_usd ?? 0,
      fixture_sha8: fixtureSha8,
    });

    return { outcome, exit_code: exitCode };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[nightly-quality-probe] runtime error: ${detail}\n`);
    logQualityProbeEvent({
      outcome: 'error',
      exit_code: 1,
      pass_count: 0,
      fail_count: 0,
      inconclusive_count: 0,
      error_count: 0,
      est_cost_usd: 0,
      fixture_sha8: fixtureSha8,
      detail,
    });
    return { outcome: 'error', exit_code: 1, detail };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
}
