#!/usr/bin/env bun

import { spawnSync } from 'bun';

interface Phase2BenchmarkSummary {
  name: string;
  readiness_status: 'pass' | 'fail';
  phase2_status: 'pass' | 'fail';
}

const BENCHMARKS = [
  { name: 'note_manifest', path: 'scripts/bench/phase2-note-manifest.ts' },
  { name: 'note_sections', path: 'scripts/bench/phase2-note-sections.ts' },
  { name: 'structural_paths', path: 'scripts/bench/phase2-structural-paths.ts' },
  { name: 'context_map', path: 'scripts/bench/phase2-context-map.ts' },
  { name: 'context_atlas', path: 'scripts/bench/phase2-context-atlas.ts' },
  { name: 'context_atlas_select', path: 'scripts/bench/phase2-context-atlas-select.ts' },
  { name: 'context_atlas_overview', path: 'scripts/bench/phase2-context-atlas-overview.ts' },
  { name: 'context_atlas_report', path: 'scripts/bench/phase2-context-atlas-report.ts' },
  { name: 'context_map_report', path: 'scripts/bench/phase2-context-map-report.ts' },
  { name: 'workspace_system_card', path: 'scripts/bench/phase2-workspace-system-card.ts' },
  { name: 'workspace_project_card', path: 'scripts/bench/phase2-workspace-project-card.ts' },
  { name: 'workspace_orientation_bundle', path: 'scripts/bench/phase2-workspace-orientation-bundle.ts' },
  { name: 'workspace_corpus_card', path: 'scripts/bench/phase2-workspace-corpus-card.ts' },
  { name: 'atlas_orientation_card', path: 'scripts/bench/phase2-atlas-orientation-card.ts' },
  { name: 'atlas_orientation_bundle', path: 'scripts/bench/phase2-atlas-orientation-bundle.ts' },
] as const;

const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase2-acceptance-pack.ts [--json]');
  process.exit(0);
}

const summaries = BENCHMARKS.map(runBenchmark);
const allPass = summaries.every((item) => item.readiness_status === 'pass' && item.phase2_status === 'pass');

const payload = {
  generated_at: new Date().toISOString(),
  engine: 'sqlite',
  phase: 'phase2',
  benchmarks: summaries,
  acceptance: {
    readiness_status: allPass ? 'pass' : 'fail',
    phase2_status: allPass ? 'pass' : 'fail',
    summary: allPass
      ? 'Phase 2 acceptance pack passed across all published benchmark slices.'
      : 'Phase 2 acceptance pack failed because one or more benchmark slices failed.',
  },
};

if (args.has('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(JSON.stringify(payload, null, 2));
}

if (!allPass) {
  process.exit(1);
}

function runBenchmark(benchmark: typeof BENCHMARKS[number]): Phase2BenchmarkSummary {
  const proc = spawnSync(['bun', 'run', benchmark.path, '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (proc.exitCode !== 0) {
    return {
      name: benchmark.name,
      readiness_status: 'fail',
      phase2_status: 'fail',
    };
  }

  const stdout = new TextDecoder().decode(proc.stdout);
  const parsed = JSON.parse(stdout);
  const acceptance = parsed?.acceptance ?? {};
  const readinessStatus = acceptance.readiness_status === 'pass' ? 'pass' : 'fail';
  const phase2Status = acceptance.phase2_status === 'pass' ? 'pass' : 'fail';

  return {
    name: benchmark.name,
    readiness_status: readinessStatus,
    phase2_status: phase2Status,
  };
}
