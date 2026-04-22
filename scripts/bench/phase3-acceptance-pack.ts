#!/usr/bin/env bun

import { spawnSync } from 'bun';

interface Phase3BenchmarkSummary {
  name: string;
  readiness_status: 'pass' | 'fail';
  phase3_status: 'pass' | 'fail';
}

const BENCHMARKS = [
  { name: 'context_map_explain', path: 'scripts/bench/phase3-context-map-explain.ts' },
  { name: 'context_map_query', path: 'scripts/bench/phase3-context-map-query.ts' },
  { name: 'context_map_path', path: 'scripts/bench/phase3-context-map-path.ts' },
  { name: 'broad_synthesis_route', path: 'scripts/bench/phase3-broad-synthesis-route.ts' },
  { name: 'precision_lookup_route', path: 'scripts/bench/phase3-precision-lookup-route.ts' },
  { name: 'retrieval_route_selector', path: 'scripts/bench/phase3-retrieval-route-selector.ts' },
  { name: 'retrieval_route_trace', path: 'scripts/bench/phase3-retrieval-route-trace.ts' },
] as const;

const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase3-acceptance-pack.ts [--json]');
  process.exit(0);
}

const summaries = BENCHMARKS.map(runBenchmark);
const allPass = summaries.every((item) => item.readiness_status === 'pass' && item.phase3_status === 'pass');

const payload = {
  generated_at: new Date().toISOString(),
  engine: 'sqlite',
  phase: 'phase3',
  benchmarks: summaries,
  acceptance: {
    readiness_status: allPass ? 'pass' : 'fail',
    phase3_status: allPass ? 'pass' : 'fail',
    summary: allPass
      ? 'Phase 3 acceptance pack passed across all published benchmark slices.'
      : 'Phase 3 acceptance pack failed because one or more benchmark slices failed.',
  },
};

console.log(JSON.stringify(payload, null, 2));

if (!allPass) {
  process.exit(1);
}

function runBenchmark(benchmark: typeof BENCHMARKS[number]): Phase3BenchmarkSummary {
  const proc = spawnSync(['bun', 'run', benchmark.path, '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (proc.exitCode !== 0) {
    return {
      name: benchmark.name,
      readiness_status: 'fail',
      phase3_status: 'fail',
    };
  }

  const stdout = new TextDecoder().decode(proc.stdout);
  const parsed = JSON.parse(stdout);
  const acceptance = parsed?.acceptance ?? {};
  const readinessStatus = acceptance.readiness_status === 'pass' ? 'pass' : 'fail';
  const phase3Status = acceptance.phase3_status === 'pass' ? 'pass' : 'fail';

  return {
    name: benchmark.name,
    readiness_status: readinessStatus,
    phase3_status: phase3Status,
  };
}
