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
 * (don't re-run the same skill every cycle).
 *
 * Each per-skill invocation runs with epochs=1 (incremental nightly
 * improvement, not full optimization). Users who want a full multi-epoch
 * run invoke `gbrain skillopt <name> --epochs N` directly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { autoDetectSkillsDirReadOnly } from '../repo-root.ts';
import { resolveModel } from '../model-config.ts';
import { runSkillOpt } from './orchestrator.ts';
import { parseSplit } from './benchmark.ts';
import type { SkillOptOpts } from './types.ts';

export interface SkilloptPhaseOpts {
  engine: BrainEngine;
  dryRun?: boolean;
  signal?: AbortSignal;
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

/** Default per-skill cost cap for the phase. */
const DEFAULT_PER_SKILL_CAP_USD = 0.50;
/** Default brain-wide cost cap for one cycle. */
const DEFAULT_BRAIN_WIDE_CAP_USD = 2.00;
/** Default stale threshold (skip skills that ran within this window). */
const DEFAULT_STALE_DAYS = 7;

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
    return {
      phase: 'skillopt',
      status: 'skipped',
      duration_ms: Date.now() - start,
      summary: 'feature flag off (gbrain config set cycle.skillopt.enabled true to enable)',
      details: { reason: 'feature_flag_off' },
    };
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

  // Walk skills dir; pick candidates with skillopt-benchmark.jsonl + stale last_run_at.
  const candidates = await collectCandidates(engine, skillsDir, staleDays);
  if (candidates.length === 0) {
    return {
      phase: 'skillopt',
      status: 'ok',
      duration_ms: Date.now() - start,
      summary: 'no stale skills with benchmarks; nothing to optimize',
      details: { skills_scanned: 0, candidates: 0, brain_wide_cap_usd: brainWideCap },
    };
  }

  // Resolve models once. Tiers default to deep/subagent/reasoning.
  const optimizerModel = await resolveModel(engine, { tier: 'deep', fallback: 'anthropic:claude-opus-4-7' });
  const targetModel = await resolveModel(engine, { tier: 'subagent', fallback: 'anthropic:claude-sonnet-4-6' });
  const judgeModel = await resolveModel(engine, { tier: 'reasoning', fallback: 'anthropic:claude-sonnet-4-6' });

  // Run per-skill. Each invocation gets its own per-skill cap; we track
  // cumulative cost across the cycle and bail when brain-wide cap hit.
  const results: Array<{ skill: string; outcome: string; cost_usd: number; reason?: string }> = [];
  let cumulativeCostUsd = 0;
  let skipped_brain_wide_cap = 0;

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
        optimizerModel,
        targetModel,
        judgeModel,
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
      const spent = result.receipt.final_cost_usd ?? 0;
      cumulativeCostUsd += spent;
      results.push({
        skill: c.name,
        outcome: result.outcome,
        cost_usd: spent,
      });
      // Persist last_run_at so we don't re-enter every cycle.
      await engine.setConfig(`cycle.skillopt.last_run.${c.name}`, String(Date.now()));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ skill: c.name, outcome: 'errored', cost_usd: 0, reason: msg });
    }
  }

  const accepted = results.filter((r) => r.outcome === 'accepted').length;
  const noImprovement = results.filter((r) => r.outcome === 'no_improvement').length;
  const errored = results.filter((r) => r.outcome === 'errored').length;

  return {
    phase: 'skillopt',
    status: errored > 0 ? 'warn' : 'ok',
    duration_ms: Date.now() - start,
    summary: `optimized ${accepted}/${candidates.length} skills (${noImprovement} no-improvement, ${errored} errored, ${skipped_brain_wide_cap} skipped over brain-wide cap)`,
    details: {
      skills_scanned: candidates.length,
      accepted,
      no_improvement: noImprovement,
      errored,
      skipped_brain_wide_cap,
      cumulative_cost_usd: cumulativeCostUsd,
      brain_wide_cap_usd: brainWideCap,
      per_skill_cap_usd: perSkillCap,
      results,
    },
  };
}

/**
 * Walk skillsDir and return skills that have a benchmark file AND a stale
 * last_run_at (older than staleDays, or never run).
 */
async function collectCandidates(
  engine: BrainEngine,
  skillsDir: string,
  staleDays: number,
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
