#!/usr/bin/env bun

import { spawnSync } from 'bun';

interface Phase5BenchmarkSummary {
  name: string;
  readiness_status: 'pass' | 'fail';
  phase5_status: 'pass' | 'fail';
}

const BENCHMARKS = [
  { name: 'memory_inbox_foundations', path: 'scripts/bench/phase5-memory-inbox-foundations.ts' },
] as const;

const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase5-acceptance-pack.ts [--json]');
  process.exit(0);
}

const summaries = BENCHMARKS.map(runBenchmark);
const allPass = summaries.every((item) => item.readiness_status === 'pass' && item.phase5_status === 'pass');

const payload = {
  generated_at: new Date().toISOString(),
  engine: 'sqlite',
  phase: 'phase5',
  benchmarks: summaries,
  acceptance: {
    readiness_status: allPass ? 'pass' : 'fail',
    phase5_status: allPass ? 'pass' : 'fail',
    summary: allPass
      ? 'Phase 5 acceptance pack passed across all published benchmark slices.'
      : 'Phase 5 acceptance pack failed because one or more benchmark slices failed.',
  },
};

console.log(JSON.stringify(payload, null, 2));

if (!allPass) {
  process.exit(1);
}

function runBenchmark(benchmark: typeof BENCHMARKS[number]): Phase5BenchmarkSummary {
  const proc = spawnSync(['bun', 'run', benchmark.path, '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (proc.exitCode !== 0) {
    return {
      name: benchmark.name,
      readiness_status: 'fail',
      phase5_status: 'fail',
    };
  }

  const stdout = new TextDecoder().decode(proc.stdout);
  const parsed = JSON.parse(stdout);
  const acceptance = parsed?.acceptance ?? {};
  const readinessStatus = acceptance.readiness_status === 'pass' ? 'pass' : 'fail';
  const phase5Status = acceptance.phase5_status === 'pass' ? 'pass' : 'fail';

  return {
    name: benchmark.name,
    readiness_status: readinessStatus,
    phase5_status: phase5Status,
  };
}
