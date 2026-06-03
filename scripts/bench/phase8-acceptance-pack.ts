#!/usr/bin/env bun

import { spawnSync } from 'bun';

export type Phase8Status = 'pass' | 'fail' | 'pending_baseline';

export interface Phase8BenchmarkSummary {
  name: string;
  readiness_status: Phase8Status;
  phase8_status: Phase8Status;
}

export interface Phase8AcceptanceBenchmark {
  name: 'longitudinal_evaluation' | 'dream_cycle';
  path: string;
  extraArgs: (phase1BaselinePath: string | null) => string[];
}

export interface Phase8AcceptanceRunnerInput {
  benchmark: Phase8AcceptanceBenchmark;
  phase1BaselinePath: string | null;
}

export type Phase8AcceptanceBenchmarkRunner = (input: Phase8AcceptanceRunnerInput) => Phase8BenchmarkSummary;

export interface Phase8AcceptancePackPayload {
  generated_at: string;
  engine: string;
  phase: 'phase8';
  benchmarks: Phase8BenchmarkSummary[];
  acceptance: ReturnType<typeof evaluatePhase8Acceptance>;
}

export const PHASE8_ACCEPTANCE_BENCHMARKS: readonly Phase8AcceptanceBenchmark[] = [
  {
    name: 'longitudinal_evaluation',
    path: 'scripts/bench/phase8-longitudinal-evaluation.ts',
    extraArgs: (phase1BaselinePath) => phase1BaselinePath ? ['--phase1-baseline', phase1BaselinePath] : [],
  },
  {
    name: 'dream_cycle',
    path: 'scripts/bench/phase8-dream-cycle.ts',
    extraArgs: () => [],
  },
] as const;

export function runPhase8AcceptancePack(input: {
  phase1BaselinePath?: string | null;
  benchmarkRunner?: Phase8AcceptanceBenchmarkRunner;
} = {}): Phase8AcceptancePackPayload {
  const phase1BaselinePath = input.phase1BaselinePath ?? null;
  const benchmarkRunner = input.benchmarkRunner ?? runBenchmark;
  const summaries = PHASE8_ACCEPTANCE_BENCHMARKS.map((benchmark) =>
    benchmarkRunner({ benchmark, phase1BaselinePath })
  );
  const acceptance = evaluatePhase8Acceptance(summaries);

  return {
    generated_at: new Date().toISOString(),
    engine: 'sqlite',
    phase: 'phase8',
    benchmarks: summaries,
    acceptance,
  };
}

export function getProcessOutcome(payload: Phase8AcceptancePackPayload): { stdout: string; exitCode: number } {
  return {
    stdout: JSON.stringify(payload, null, 2),
    exitCode: payload.acceptance.phase8_status === 'fail' ? 1 : 0,
  };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = new Set(rawArgs);
  let phase1BaselinePath: string | null = null;

  try {
    phase1BaselinePath = getFlagValue(rawArgs, '--phase1-baseline');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (args.has('--help')) {
    console.log('Usage: bun run scripts/bench/phase8-acceptance-pack.ts [--json] [--phase1-baseline <path>]');
    process.exit(0);
  }

  const payload = runPhase8AcceptancePack({ phase1BaselinePath });
  const outcome = getProcessOutcome(payload);
  console.log(outcome.stdout);

  if (outcome.exitCode !== 0) {
    process.exit(outcome.exitCode);
  }
}

function runBenchmark(input: {
  benchmark: Phase8AcceptanceBenchmark;
  phase1BaselinePath: string | null;
}): Phase8BenchmarkSummary {
  const proc = spawnSync([
    'bun',
    'run',
    input.benchmark.path,
    '--json',
    ...input.benchmark.extraArgs(input.phase1BaselinePath),
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (proc.exitCode !== 0) {
    return {
      name: input.benchmark.name,
      readiness_status: 'fail',
      phase8_status: 'fail',
    };
  }

  const stdout = new TextDecoder().decode(proc.stdout);
  try {
    const parsed = JSON.parse(stdout);
    const phase8Status = normalizeStatus(parsed?.acceptance?.phase8_status);
    const rawReadinessStatus = normalizeStatus(parsed?.acceptance?.readiness_status);
    return {
      name: input.benchmark.name,
      readiness_status: phase8Status === 'pending_baseline' ? 'pending_baseline' : rawReadinessStatus,
      phase8_status: phase8Status,
    };
  } catch {
    return {
      name: input.benchmark.name,
      readiness_status: 'fail',
      phase8_status: 'fail',
    };
  }
}

export function evaluatePhase8Acceptance(summaries: Phase8BenchmarkSummary[]) {
  const hasFailure = summaries.some((summary) =>
    summary.readiness_status === 'fail' || summary.phase8_status === 'fail'
  );
  if (hasFailure) {
    return {
      readiness_status: 'fail' as const,
      phase8_status: 'fail' as const,
      summary: 'Phase 8 acceptance pack failed because one or more benchmark slices failed.',
    };
  }

  const hasPendingBaseline = summaries.some((summary) =>
    summary.readiness_status === 'pending_baseline' || summary.phase8_status === 'pending_baseline'
  );
  if (hasPendingBaseline) {
    return {
      readiness_status: 'pending_baseline' as const,
      phase8_status: 'pending_baseline' as const,
      summary: 'Phase 8 acceptance pack is incomplete until a comparable Phase 1 baseline is supplied.',
    };
  }

  return {
    readiness_status: 'pass' as const,
    phase8_status: 'pass' as const,
    summary: 'Phase 8 acceptance pack passed across all published benchmark slices.',
  };
}

function normalizeStatus(value: unknown): Phase8Status {
  if (value === 'pass' || value === 'fail' || value === 'pending_baseline') {
    return value;
  }
  return 'fail';
}

function getFlagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  if (typeof value !== 'string' || value.trim().length === 0 || value.startsWith('--')) {
    throw new Error(`${flag} requires a non-empty path value.`);
  }
  return value;
}

if (import.meta.main) {
  await main();
}
