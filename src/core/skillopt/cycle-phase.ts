/**
 * SkillOpt dream-cycle phase wrapper.
 *
 * Walks every skill that has `skillopt-benchmark.jsonl` AND a stale
 * `last_run_at` (>7d by default; configurable). Per-skill cap $0.50;
 * brain-wide cap $2.00 (both configurable). Bundled-skill safety
 * (D16): bundled skills never auto-mutate — proposed.md is written
 * to `~/.gbrain/skillopt-proposed-bundled/<skill>.md` for review.
 *
 * Per-skill last-run state lives in `config` table keyed
 * `cycle.skillopt.last_run.<skill>` so the cycle is cheap to re-enter
 * (don't re-run the same skill every cycle). An `errored` run (or a thrown
 * error) does NOT bank last_run: it records `cycle.skillopt.last_error.<skill>`
 * instead, and the skill is retried no sooner than 24h after that error.
 * Each result row forwards the run's abort_reason / abort_detail / run_id /
 * remediation so the cycle report says why a skill failed.
 *
 * Admission (#5585): when one call of the run can never fit the per-skill cap
 * (preflight's `reservation_exceeds_cap: ...` abort, raised before any model call) the
 * skill is recorded `skipped_budget` with remediation, and
 * `cycle.skillopt.last_skip.<skill>` stores a fingerprint of everything the
 * reservation check prices: the resolved optimizer, target and judge models,
 * `cycle.skillopt.per_skill_cap_usd`, `skillopt.reflect_max_tokens`,
 * `pricing.overrides`, the gbrain version (built-in prices and default caps)
 * and the skill's benchmark (per-task judge models); the skill is not retried
 * until one of them changes. Models resolve once per cycle through `resolveSkillOptModels`; the
 * models banner prints once and each run prints only rows that differ.
 *
 * Each per-skill invocation runs with epochs=1 (incremental nightly
 * improvement, not full optimization). Users who want a full multi-epoch
 * run invoke `gbrain skillopt <name> --epochs N` directly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { autoDetectSkillsDirReadOnly } from '../repo-root.ts';
import { StructuredAgentError } from '../errors.ts';
import { buildModelsPlan, formatModelsBanner, resolveSkillOptModels, skillOptModelOpts } from './models-plan.ts';
import { runSkillOpt } from './orchestrator.ts';
import { REFLECT_MAX_TOKENS_CONFIG_KEY } from './output-cap.ts';
import { parseSplit } from './benchmark.ts';
import { gcStaleCheckpoints } from './checkpoint.ts';
import { sha8 } from './audit.ts';
import { VERSION } from '../../version.ts';
import { buildRemediation, errorCode } from './remediation.ts';
import type { SkillOptOpts } from './types.ts';

export interface SkilloptPhaseOpts {
  engine: BrainEngine;
  dryRun?: boolean;
  signal?: AbortSignal;
  /**
   * issue #2860 — `gbrain dream --phase skillopt --once`. Bypasses the
   * `cycle.skillopt.enabled` feature flag for THIS call only; never reads
   * or writes config. Per-skill + brain-wide cost caps still apply.
   */
  once?: boolean;
}

export interface SkilloptPhaseResult {
  phase: 'skillopt';
  status: 'ok' | 'skipped' | 'warn' | 'fail';
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
}

interface SkillCandidate {
  name: string;
  benchmarkPath: string;
  lastRunAt: number | null;
}

interface SkillResult {
  skill: string;
  outcome: string;
  cost_usd: number;
  reason?: string;
  abort_reason?: string;
  abort_detail?: string;
  run_id?: string;
  remediation?: Array<{ code: string; fix: string; docs: string }>;
}

/** Default per-skill cost cap for the phase. */
const DEFAULT_PER_SKILL_CAP_USD = 0.50;
/** Default brain-wide cost cap for one cycle. */
const DEFAULT_BRAIN_WIDE_CAP_USD = 2.00;
/** Default stale threshold (skip skills that ran within this window). */
const DEFAULT_STALE_DAYS = 7;
/** An errored skill is retried no sooner than this after its last error. */
const ERROR_RETRY_MS = 24 * 3600 * 1000;

export async function runPhaseSkillopt(opts: SkilloptPhaseOpts): Promise<SkilloptPhaseResult> {
  const { engine } = opts;
  const start = Date.now();

  // Read the feature flag. Default OFF.
  let enabled = false;
  try {
    const v = await engine.getConfig('cycle.skillopt.enabled');
    enabled = v === 'true';
  } catch { /* default OFF */ }
  if (!enabled) {
    if (!opts.once) {
      return {
        phase: 'skillopt',
        status: 'skipped',
        duration_ms: Date.now() - start,
        summary: 'feature flag off (gbrain config set cycle.skillopt.enabled true to enable)',
        details: { reason: 'feature_flag_off' },
      };
    }
    process.stderr.write(
      '[dream] --once: cycle.skillopt.enabled is false but ' +
      '--phase skillopt --once forces this run (config untouched)\n',
    );
  }

  // Per-skill + brain-wide cost caps.
  const perSkillCap = await readNumericConfig(engine, 'cycle.skillopt.per_skill_cap_usd', DEFAULT_PER_SKILL_CAP_USD);
  const brainWideCap = await readNumericConfig(engine, 'cycle.skillopt.brain_wide_cap_usd', DEFAULT_BRAIN_WIDE_CAP_USD);
  const staleDays = await readNumericConfig(engine, 'cycle.skillopt.stale_days', DEFAULT_STALE_DAYS);

  // Locate skills dir.
  const detected = autoDetectSkillsDirReadOnly(process.cwd());
  const skillsDir = detected.dir;
  if (!skillsDir) {
    return {
      phase: 'skillopt',
      status: 'skipped',
      duration_ms: Date.now() - start,
      summary: 'no skills directory found',
      details: { reason: 'no_skills_dir' },
    };
  }

  // Cycle runs never resume, so kept checkpoints (errored / early-stopped)
  // are reclaimed here once they age past the 7-day window.
  if (!opts.dryRun) {
    try { gcStaleCheckpoints(skillsDir); } catch { /* best effort; never blocks the phase */ }
  }

  // Resolve models once. Tiers default to deep/subagent/reasoning.
  const models = await resolveSkillOptModels(engine);
  const admission = {
    optimizer: models.optimizer.model,
    target: models.target.model,
    judge: models.judge.model,
    per_skill_cap_usd: perSkillCap,
    reflect_max_tokens: await engine.getConfig(REFLECT_MAX_TOKENS_CONFIG_KEY).catch(() => null) ?? null,
    pricing_overrides: await engine.getConfig('pricing.overrides').catch(() => null) ?? null,
    // Built-in prices and default caps move with releases.
    gbrain_version: VERSION,
  };
  // An unreadable benchmark hashes as null (never matches a stored skip), so the
  // skill is re-admitted and fails on its own instead of throwing the phase.
  const fingerprint = (benchmarkPath: string): string => {
    let benchmarkSha8: string | null = null;
    try { benchmarkSha8 = sha8(fs.readFileSync(benchmarkPath, 'utf8')); } catch { /* re-admit */ }
    return JSON.stringify({ ...admission, benchmark_sha8: benchmarkSha8 });
  };

  // Walk skills dir; pick candidates with skillopt-benchmark.jsonl + stale last_run_at.
  const candidates = await collectCandidates(engine, skillsDir, staleDays, fingerprint);
  if (candidates.length === 0) {
    return {
      phase: 'skillopt',
      status: 'ok',
      duration_ms: Date.now() - start,
      summary: 'no stale skills with benchmarks; nothing to optimize',
      details: { skills_scanned: 0, candidates: 0, brain_wide_cap_usd: brainWideCap },
    };
  }

  const basePlan = await buildModelsPlan(engine, models);
  process.stderr.write(formatModelsBanner(basePlan));

  // Run per-skill. Each invocation gets its own per-skill cap; we track
  // cumulative cost across the cycle and bail when brain-wide cap hit.
  const results: SkillResult[] = [];
  let cumulativeCostUsd = 0;
  let skipped_brain_wide_cap = 0;
  let skipped_budget = 0;

  for (const c of candidates) {
    if (opts.signal?.aborted) break;
    if (cumulativeCostUsd >= brainWideCap) {
      skipped_brain_wide_cap += 1;
      results.push({ skill: c.name, outcome: 'skipped', cost_usd: 0, reason: 'brain_wide_cap_reached' });
      continue;
    }
    // Cap the per-skill spend at min(per_skill_cap, remaining_brain_wide).
    const remaining = brainWideCap - cumulativeCostUsd;
    const effectiveCap = Math.min(perSkillCap, remaining);

    try {
      const split = parseSplit('4:1:5');
      const skillOptOpts: SkillOptOpts = {
        engine,
        skillName: c.name,
        skillsDir,
        benchmarkPath: c.benchmarkPath,
        epochs: 1, // incremental nightly: ONE epoch per cycle
        batchSize: 4, // smaller batch for the nightly path
        lr: 4,
        lrSchedule: 'cosine',
        split,
        ...skillOptModelOpts(models),
        modelsBannerBaseline: basePlan,
        mode: 'patch',
        dryRun: opts.dryRun ?? false,
        // Bundled-skill safety: dream-cycle NEVER auto-mutates bundled skills.
        // For bundled skills we set --no-mutate; the user reviews proposed.md
        // at their own cadence.
        noMutate: true, // ALL dream-cycle runs are no-mutate by default
        allowMutateBundled: false,
        bootstrapReviewed: false,
        json: true,
        maxCostUsd: effectiveCap,
        maxRuntimeMin: 10, // shorter wall-clock cap for the nightly path
        force: false,
      };
      const result = await runSkillOpt(skillOptOpts);
      const receipt = result.receipt;
      const spent = receipt.final_cost_usd ?? 0;
      cumulativeCostUsd += spent;
      results.push({
        skill: c.name,
        outcome: result.outcome,
        cost_usd: spent,
        ...(receipt.abort_reason ? { abort_reason: receipt.abort_reason } : {}),
        ...(receipt.abort_detail ? { abort_detail: receipt.abort_detail } : {}),
        ...(receipt.run_id ? { run_id: receipt.run_id } : {}),
        ...(receipt.remediation?.length ? { remediation: receipt.remediation } : {}),
      });
      // Persist last_run_at so we don't re-enter every cycle; an errored run
      // records last_error instead so it is retried (after the 24h gate).
      const stateKey = result.outcome === 'errored' ? 'last_error' : 'last_run';
      await engine.setConfig(`cycle.skillopt.${stateKey}.${c.name}`, String(Date.now()));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof StructuredAgentError && errorCode(err.envelope.message) === 'reservation_exceeds_cap') {
        if (effectiveCap < perSkillCap) {
          skipped_brain_wide_cap += 1;
          results.push({ skill: c.name, outcome: 'skipped', cost_usd: 0, reason: 'brain_wide_cap_reached' });
        } else {
          skipped_budget += 1;
          results.push({ skill: c.name, outcome: 'skipped_budget', cost_usd: 0, reason: err.envelope.message,
            remediation: buildRemediation(['reservation_exceeds_cap']) });
          await engine.setConfig(`cycle.skillopt.last_skip.${c.name}`, fingerprint(c.benchmarkPath)).catch(() => {});
        }
        continue;
      }
      results.push({ skill: c.name, outcome: 'errored', cost_usd: 0, reason: msg });
      await engine.setConfig(`cycle.skillopt.last_error.${c.name}`, String(Date.now())).catch(() => {});
    }
  }

  const accepted = results.filter((r) => r.outcome === 'accepted').length;
  const noImprovement = results.filter((r) => r.outcome === 'no_improvement').length;
  const errored = results.filter((r) => r.outcome === 'errored').length;

  return {
    phase: 'skillopt',
    status: errored > 0 ? 'warn' : 'ok',
    duration_ms: Date.now() - start,
    summary: `optimized ${accepted}/${candidates.length} skills (${noImprovement} no-improvement, ${errored} errored, ${skipped_brain_wide_cap} skipped over brain-wide cap${skipped_budget > 0 ? `, ${skipped_budget} skipped: one call exceeds the per-skill cap` : ''})`,
    details: {
      skills_scanned: candidates.length,
      accepted,
      no_improvement: noImprovement,
      errored,
      skipped_brain_wide_cap,
      skipped_budget,
      cumulative_cost_usd: cumulativeCostUsd,
      brain_wide_cap_usd: brainWideCap,
      per_skill_cap_usd: perSkillCap,
      results,
    },
  };
}

/**
 * Walk skillsDir and return skills that have a benchmark file AND a stale
 * last_run_at (older than staleDays, or never run) AND no error within the
 * last 24h AND no budget skip under the current admission fingerprint.
 */
async function collectCandidates(
  engine: BrainEngine,
  skillsDir: string,
  staleDays: number,
  fingerprint: (benchmarkPath: string) => string,
): Promise<SkillCandidate[]> {
  const out: SkillCandidate[] = [];
  if (!fs.existsSync(skillsDir)) return out;
  const cutoffMs = Date.now() - staleDays * 86400 * 1000;
  for (const entry of fs.readdirSync(skillsDir)) {
    const skillDir = path.join(skillsDir, entry);
    if (!fs.statSync(skillDir).isDirectory()) continue;
    const benchPath = path.join(skillDir, 'skillopt-benchmark.jsonl');
    if (!fs.existsSync(benchPath)) continue;
    // Read last_run_at.
    let lastRunAt: number | null = null;
    try {
      const v = await engine.getConfig(`cycle.skillopt.last_run.${entry}`);
      if (v) lastRunAt = Number(v);
    } catch { /* fall through */ }
    if (lastRunAt !== null && lastRunAt >= cutoffMs) {
      continue; // ran recently; skip
    }
    let lastErrorAt: number | null = null;
    try {
      const v = await engine.getConfig(`cycle.skillopt.last_error.${entry}`);
      if (v) lastErrorAt = Number(v);
    } catch { /* fall through */ }
    if (lastErrorAt !== null && Date.now() - lastErrorAt < ERROR_RETRY_MS) {
      continue; // errored recently; retry after the 24h gate
    }
    const lastSkip = await engine.getConfig(`cycle.skillopt.last_skip.${entry}`).catch(() => null);
    if (lastSkip && !lastSkip.includes('"benchmark_sha8":null') && lastSkip === fingerprint(benchPath)) continue; // budget-skipped; wait for a config change
    out.push({ name: entry, benchmarkPath: benchPath, lastRunAt });
  }
  return out;
}

async function readNumericConfig(engine: BrainEngine, key: string, defaultValue: number): Promise<number> {
  try {
    const v = await engine.getConfig(key);
    if (v) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* fall through */ }
  return defaultValue;
}
