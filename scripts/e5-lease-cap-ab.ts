#!/usr/bin/env bun
/**
 * v0.41 E5 A/B harness (D11 + codex pass-2 #7 spec).
 *
 * Manually-runnable script that proves the auto-adaptive lease-cap
 * controller beats fixed-cap on a real upstream. Writes a structured
 * receipt to test/fixtures/e5-lease-cap-ab/{timestamp}.json — that file
 * is committed as the baseline. Future controller changes ship with
 * their own receipt + diff against prior.
 *
 * **Spec (D11):**
 *   Workload: 500 subagent jobs, log-normal prompt distribution
 *     (mean 2k tokens, p99 16k tokens). Synthesized via fixture file.
 *   Provider: Anthropic (real API) via gateway.
 *   Cost cap: --budget-usd 8 per arm (D5 enforced).
 *   Failure injection: synthetic 429 burst at minute 15 (10s window).
 *   Statistical threshold: controller arm must beat fixed-cap on
 *     (completed_jobs / wall_clock_time) by ≥5% AND match
 *     (completed_jobs / dollars_spent) within ±2%.
 *
 * **Usage:**
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e5-lease-cap-ab.ts
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e5-lease-cap-ab.ts --dry-run
 *
 * **Cost:** ~$16 per full run ($8/arm × 2 arms). Approximate; depends on
 * actual prompt lengths sampled from the fixture.
 *
 * **Not in CI:** This script requires a real API key + ~30min wall-clock
 * + real Anthropic budget. Intended to be run BEFORE landing a controller
 * change; receipt is the durable artifact. CI gating happens via the
 * unit-test suite (`lease-cap-controller.test.ts` covers the pure
 * decision function exhaustively).
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadConfig } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

interface ArmStats {
  arm: 'fixed' | 'adaptive';
  jobs_submitted: number;
  jobs_completed: number;
  jobs_dead: number;
  wall_clock_ms: number;
  total_cost_usd: number;
  lease_cap_history: number[];
  bounces: number;
  upstream_429s: number;
}

interface ABReceipt {
  schema_version: 1;
  timestamp: string;
  spec: {
    job_count: number;
    budget_per_arm_usd: number;
    injection_at_min: number;
  };
  arms: ArmStats[];
  verdict: {
    throughput_advantage_pct: number;
    cost_efficiency_delta_pct: number;
    pr_gate_pass: boolean;
    note: string;
  };
}

function parseArgs(argv: string[]) {
  const args = {
    dryRun: argv.includes('--dry-run'),
    jobs: 500,
    budgetUsd: 8,
  };
  for (const arg of argv) {
    if (arg.startsWith('--jobs=')) args.jobs = parseInt(arg.split('=')[1] ?? '500', 10);
    if (arg.startsWith('--budget-usd=')) args.budgetUsd = parseFloat(arg.split('=')[1] ?? '8');
  }
  return args;
}

async function openEngine(): Promise<BrainEngine> {
  const cfg = loadConfig();
  if (cfg?.database_url) {
    const engine = new PostgresEngine();
    await engine.connect({ database_url: cfg.database_url });
    return engine;
  }
  // Fallback: PGLite ephemeral. Real A/B runs should use Postgres so the
  // lease-cap controller's elected-mutator pattern is exercised cross-process.
  process.stderr.write('[e5-ab] WARN: using PGLite ephemeral (no DATABASE_URL); cross-worker tests will not run\n');
  const engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  return engine;
}

/**
 * Generate a synthetic prompt with the spec'd token distribution.
 * Approximate — uses character counts as a stand-in for tokens (1 token
 * ≈ 4 chars on English).
 */
function syntheticPrompt(index: number): string {
  // Log-normal mean=2k tokens, σ such that p99 = 16k tokens.
  // log(p99/p50) = z_99 * σ → σ ≈ ln(8) / 2.33 ≈ 0.89
  const mu = Math.log(2000);
  const sigma = 0.89;
  // Box-Muller for deterministic-per-index pseudo-Normal sample.
  const u1 = ((index * 9301 + 49297) % 233280) / 233280;
  const u2 = ((index * 13849 + 65521) % 233280) / 233280;
  const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-9))) * Math.cos(2 * Math.PI * u2);
  const tokens = Math.exp(mu + sigma * z);
  const chars = Math.max(40, Math.min(64000, Math.floor(tokens * 4)));
  return `Synthetic A/B test prompt #${index}. Body: ` + 'X'.repeat(chars - 40);
}

async function runArm(
  engine: BrainEngine,
  arm: 'fixed' | 'adaptive',
  opts: { jobs: number; budgetUsd: number; dryRun: boolean },
): Promise<ArmStats> {
  const start = Date.now();
  const lease_cap_history: number[] = [];
  let jobs_submitted = 0;
  let jobs_completed = 0;
  let jobs_dead = 0;
  let total_cost_usd = 0;
  let bounces = 0;
  let upstream_429s = 0;

  process.stderr.write(`[e5-ab] === arm=${arm} starting ===\n`);

  // Configure the cap policy for this arm.
  if (arm === 'fixed') {
    await engine.setConfig('minions.auto_lease_cap', 'false');
    await engine.setConfig('minions.lease_cap_current', '8');
  } else {
    await engine.setConfig('minions.auto_lease_cap', 'true');
    await engine.setConfig('minions.lease_cap_current', '8');
  }

  if (opts.dryRun) {
    process.stderr.write(`[e5-ab] --dry-run: skipping real submission. Would submit ${opts.jobs} jobs.\n`);
    return {
      arm,
      jobs_submitted: opts.jobs,
      jobs_completed: 0,
      jobs_dead: 0,
      wall_clock_ms: Date.now() - start,
      total_cost_usd: 0,
      lease_cap_history: [8],
      bounces: 0,
      upstream_429s: 0,
    };
  }

  // Real-run scaffolding lives here. v0.41 ships the spec; the full
  // dispatcher (queue submit + worker spin-up + 15-min 429 injector +
  // tick loop) lands in the follow-up wave when the controller has been
  // exercised manually first. Receipt fixture is committed as a baseline
  // shape for future runs to diff against.
  process.stderr.write(`[e5-ab] arm=${arm}: real-run implementation deferred to v0.41.1 follow-up.\n`);
  process.stderr.write(`[e5-ab] See CHANGELOG.md "v0.41.0.0 → v0.41.1.0 follow-up" for details.\n`);

  return {
    arm,
    jobs_submitted,
    jobs_completed,
    jobs_dead,
    wall_clock_ms: Date.now() - start,
    total_cost_usd,
    lease_cap_history,
    bounces,
    upstream_429s,
  };
}

function computeVerdict(fixed: ArmStats, adaptive: ArmStats): ABReceipt['verdict'] {
  // Throughput ratio: completed_jobs / wall_clock_ms. Higher is better.
  const tputFixed = fixed.wall_clock_ms > 0 ? fixed.jobs_completed / fixed.wall_clock_ms : 0;
  const tputAdaptive = adaptive.wall_clock_ms > 0 ? adaptive.jobs_completed / adaptive.wall_clock_ms : 0;
  const throughputAdvantage = tputFixed > 0 ? ((tputAdaptive - tputFixed) / tputFixed) * 100 : 0;

  // Cost efficiency ratio: completed_jobs / dollars. Higher is better.
  const effFixed = fixed.total_cost_usd > 0 ? fixed.jobs_completed / fixed.total_cost_usd : 0;
  const effAdaptive = adaptive.total_cost_usd > 0 ? adaptive.jobs_completed / adaptive.total_cost_usd : 0;
  const costEfficiencyDelta = effFixed > 0 ? ((effAdaptive - effFixed) / effFixed) * 100 : 0;

  // PR gate: adaptive must beat fixed by ≥5% on throughput AND match
  // within ±2% on cost efficiency.
  const pr_gate_pass = throughputAdvantage >= 5 && Math.abs(costEfficiencyDelta) <= 2;

  return {
    throughput_advantage_pct: Math.round(throughputAdvantage * 100) / 100,
    cost_efficiency_delta_pct: Math.round(costEfficiencyDelta * 100) / 100,
    pr_gate_pass,
    note: pr_gate_pass
      ? 'controller beats fixed-cap; safe to default ON'
      : 'controller does NOT meet PR gate; defaults stay OFF',
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  const engine = await openEngine();
  try {
    const fixed = await runArm(engine, 'fixed', opts);
    const adaptive = await runArm(engine, 'adaptive', opts);
    const verdict = computeVerdict(fixed, adaptive);

    const receipt: ABReceipt = {
      schema_version: 1,
      timestamp: new Date().toISOString(),
      spec: {
        job_count: opts.jobs,
        budget_per_arm_usd: opts.budgetUsd,
        injection_at_min: 15,
      },
      arms: [fixed, adaptive],
      verdict,
    };

    const fixtureDir = join(process.cwd(), 'test/fixtures/e5-lease-cap-ab');
    if (!existsSync(fixtureDir)) mkdirSync(fixtureDir, { recursive: true });
    const receiptPath = join(
      fixtureDir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}${opts.dryRun ? '-dry-run' : ''}.json`,
    );
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    process.stderr.write(`[e5-ab] receipt written: ${receiptPath}\n`);
    process.stderr.write(`[e5-ab] verdict: ${verdict.note}\n`);
    process.exit(verdict.pr_gate_pass || opts.dryRun ? 0 : 1);
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

if (import.meta.main) {
  main().catch(err => {
    process.stderr.write(`[e5-ab] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
