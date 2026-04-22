#!/usr/bin/env bun

import { spawnSync } from 'bun';

interface Phase4BenchmarkSummary {
  name: string;
  readiness_status: 'pass' | 'fail';
  phase4_status: 'pass' | 'fail';
}

const BENCHMARKS = [
  { name: 'scope_gate', path: 'scripts/bench/phase4-scope-gate.ts' },
  { name: 'personal_profile_lookup', path: 'scripts/bench/phase4-personal-profile-lookup.ts' },
  { name: 'personal_episode_lookup', path: 'scripts/bench/phase4-personal-episode-lookup.ts' },
  { name: 'personal_write_target', path: 'scripts/bench/phase4-personal-write-target.ts' },
  { name: 'personal_export_visibility', path: 'scripts/bench/phase4-export-visibility.ts' },
  { name: 'mixed_scope_bridge', path: 'scripts/bench/phase4-mixed-scope-bridge.ts' },
  { name: 'mixed_scope_disclosure', path: 'scripts/bench/phase4-mixed-scope-disclosure.ts' },
] as const;

const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase4-acceptance-pack.ts [--json]');
  process.exit(0);
}

const summaries = BENCHMARKS.map(runBenchmark);
const allPass = summaries.every((item) => item.readiness_status === 'pass' && item.phase4_status === 'pass');

const payload = {
  generated_at: new Date().toISOString(),
  engine: 'sqlite',
  phase: 'phase4',
  benchmarks: summaries,
  acceptance: {
    readiness_status: allPass ? 'pass' : 'fail',
    phase4_status: allPass ? 'pass' : 'fail',
    summary: allPass
      ? 'Phase 4 acceptance pack passed across all published benchmark slices.'
      : 'Phase 4 acceptance pack failed because one or more benchmark slices failed.',
  },
};

console.log(JSON.stringify(payload, null, 2));

if (!allPass) {
  process.exit(1);
}

function runBenchmark(benchmark: typeof BENCHMARKS[number]): Phase4BenchmarkSummary {
  const proc = spawnSync(['bun', 'run', benchmark.path, '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (proc.exitCode !== 0) {
    return {
      name: benchmark.name,
      readiness_status: 'fail',
      phase4_status: 'fail',
    };
  }

  const stdout = new TextDecoder().decode(proc.stdout);
  const parsed = JSON.parse(stdout);
  const acceptance = parsed?.acceptance ?? {};
  const readinessStatus = acceptance.readiness_status === 'pass' ? 'pass' : 'fail';
  const phase4Status = acceptance.phase4_status === 'pass' ? 'pass' : 'fail';

  return {
    name: benchmark.name,
    readiness_status: readinessStatus,
    phase4_status: phase4Status,
  };
}
