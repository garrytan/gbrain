/**
 * v0.41.16.0 — Nightly conversation-parser quality probe.
 *
 * Per D10: mode-gated default. When `search.mode=tokenmax` is set the
 * probe runs ON by default; for `conservative` and `balanced` it's
 * opt-in via `autopilot.conversation_parser_probe.enabled=true`.
 *
 * The probe runs the fixture corpus + the adversarial set through
 * `parseConversation` WITH polish + fallback ENABLED (config-gated by
 * the orchestrator), records the run to an audit JSONL, and surfaces
 * `outcome: 'fail' | 'budget_exceeded' | 'adversarial_false_positive'`
 * for the doctor check to read.
 *
 * Opt-IN via:
 *   gbrain config set autopilot.conversation_parser_probe.enabled true
 *
 * Cost: ~$0.05/night with default fixtures × Haiku polish. Bounded
 * by the active BudgetTracker the autopilot loop creates per-tick.
 *
 * **Wiring into the autopilot loop is deferred to a follow-up**
 * (filed in TODOS.md). v0.41.16.0 ships the phase as a callable
 * module so doctor + future cron drivers can invoke it; the
 * scheduler wire-up follows the same shape as
 * `src/core/cycle/nightly-quality-probe.ts` (v0.40.1.0 Track D / T6).
 *
 * Test seam: all dependencies are injected via NightlyProbeDeps so
 * unit tests don't touch real LLMs or real fixtures.
 */

import { readFileSync, existsSync } from 'node:fs';
import {
  parseFixtureJsonl,
  scoreFixture,
  aggregateScores,
  type ConversationFixture,
  type EvalReport,
  type FixtureScore,
} from './eval.ts';

export type ProbeOutcome =
  | 'pass'
  | 'fail'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'adversarial_false_positive'
  | 'no_embedding_key';

export interface NightlyProbeResult {
  outcome: ProbeOutcome;
  schema_version: 1;
  ts: string;
  fixtures_total: number;
  fixtures_passed: number;
  recall_mean: number;
  participants_recall_mean: number;
  adversarial_false_positives: number;
  failed_fixture_ids: string[];
  reason?: string;
}

export interface NightlyProbeDeps {
  /** Read autopilot.conversation_parser_probe.enabled config. */
  isEnabled(): boolean;
  /** Reads `search.mode` config; 'tokenmax' flips default-on per D10. */
  searchMode(): string;
  /** Returns true if there's an active provider key for the polish
   *  model (Haiku by default). Mirrors longmemeval probe semantics. */
  hasLlmKey(): boolean;
  /** Returns the path to the fixture corpus file (default:
   *  test/fixtures/conversation-formats/all.jsonl). */
  resolveFixturePath(): string;
  /** Returns the path to the adversarial fixture file. */
  resolveAdversarialPath(): string;
  /** Wall-clock for the audit row. */
  now(): Date;
  /** Rate-limit gate: returns true if the probe already ran within
   *  the last 24h. */
  shouldSkipForRateLimit(): boolean;
}

/**
 * Run the nightly probe. Returns a NightlyProbeResult — the caller
 * writes the audit row.
 *
 * Verdict precedence:
 *   1. Disabled (via config or mode-gate): outcome='no_embedding_key'
 *      OR 'rate_limited' is informational; caller's autopilot
 *      decides whether to invoke.
 *   2. Rate-limit: 'rate_limited' (24h since last run).
 *   3. No LLM key: 'no_embedding_key' (skip; polish/fallback won't fire anyway).
 *   4. Adversarial false positive: 'adversarial_false_positive'
 *      (the LLM hallucinated structure on a non-chat fixture).
 *   5. Any fixture failure: 'fail'.
 *   6. All pass: 'pass'.
 */
export async function runConversationParserNightlyProbe(
  deps: NightlyProbeDeps,
): Promise<NightlyProbeResult> {
  const ts = deps.now().toISOString();
  const baseResult = {
    schema_version: 1 as const,
    ts,
    fixtures_total: 0,
    fixtures_passed: 0,
    recall_mean: 0,
    participants_recall_mean: 0,
    adversarial_false_positives: 0,
    failed_fixture_ids: [] as string[],
  };

  // Gate 1: enabled?
  const enabled = deps.isEnabled() || deps.searchMode() === 'tokenmax';
  if (!enabled) {
    return {
      ...baseResult,
      outcome: 'rate_limited', // caller's loop decides re-enablement; we surface no-action
      reason: 'autopilot.conversation_parser_probe.enabled=false (and search.mode != tokenmax)',
    };
  }

  // Gate 2: rate limit (24h window).
  if (deps.shouldSkipForRateLimit()) {
    return {
      ...baseResult,
      outcome: 'rate_limited',
      reason: 'probe ran within the last 24h',
    };
  }

  // Gate 3: LLM key available?
  if (!deps.hasLlmKey()) {
    return {
      ...baseResult,
      outcome: 'no_embedding_key',
      reason: 'no Anthropic key configured (polish/fallback would be no-ops)',
    };
  }

  // Read fixtures (both positive + adversarial).
  const fixturePath = deps.resolveFixturePath();
  const adversarialPath = deps.resolveAdversarialPath();
  if (!existsSync(fixturePath) || !existsSync(adversarialPath)) {
    return {
      ...baseResult,
      outcome: 'fail',
      reason: `fixture path missing: ${!existsSync(fixturePath) ? fixturePath : adversarialPath}`,
    };
  }

  let positiveFixtures: ConversationFixture[];
  let adversarialFixtures: ConversationFixture[];
  try {
    positiveFixtures = parseFixtureJsonl(readFileSync(fixturePath, 'utf8'));
    adversarialFixtures = parseFixtureJsonl(
      readFileSync(adversarialPath, 'utf8'),
    );
  } catch (err) {
    return {
      ...baseResult,
      outcome: 'fail',
      reason: `fixture parse failed: ${(err as Error).message}`,
    };
  }

  // Score everything WITH LLM enabled (the parser's config flags
  // determine whether polish/fallback actually fires; this probe
  // doesn't override them).
  const positiveScores: FixtureScore[] = positiveFixtures.map((f) =>
    scoreFixture(f),
  );
  const adversarialScores: FixtureScore[] = adversarialFixtures.map((f) =>
    scoreFixture(f),
  );

  // Adversarial fixtures must score `messages_parsed === 0`.
  const adversarialFps = adversarialScores.filter((s) => !s.passed).length;
  const allScores = [...positiveScores, ...adversarialScores];
  const aggregate: EvalReport = aggregateScores(allScores);

  let outcome: ProbeOutcome = 'pass';
  let reason: string | undefined;
  if (adversarialFps > 0) {
    outcome = 'adversarial_false_positive';
    reason = `${adversarialFps} adversarial fixture(s) parsed to non-empty (LLM hallucinated structure)`;
  } else if (aggregate.failed > 0) {
    outcome = 'fail';
    reason = `${aggregate.failed} fixture(s) failed (see failed_fixture_ids)`;
  }

  return {
    schema_version: 1,
    ts,
    outcome,
    fixtures_total: aggregate.total_fixtures,
    fixtures_passed: aggregate.passed,
    recall_mean: aggregate.recall_mean,
    participants_recall_mean: aggregate.participants_recall_mean,
    adversarial_false_positives: adversarialFps,
    failed_fixture_ids: aggregate.failed_fixture_ids,
    reason,
  };
}
