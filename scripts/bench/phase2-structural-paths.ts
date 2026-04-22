#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import {
  buildStructuralGraphSnapshot,
  findStructuralPath,
  getStructuralNeighbors,
} from '../../src/core/services/note-structural-graph-service.ts';

type StructuralPathLatencyWorkloadName =
  | 'structural_graph_build'
  | 'structural_neighbors'
  | 'structural_path';

type StructuralPathWorkloadResult =
  | {
      name: StructuralPathLatencyWorkloadName;
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'structural_path_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface StructuralPathAcceptanceCheck {
  name:
    | 'structural_graph_build_p95_ms'
    | 'structural_neighbors_p95_ms'
    | 'structural_path_p95_ms'
    | 'structural_path_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const STRUCTURAL_PATH_THRESHOLDS = {
  structural_graph_build_p95_ms_max: 150,
  structural_neighbors_p95_ms_max: 100,
  structural_path_p95_ms_max: 100,
  structural_path_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;

const FIXTURES = [
  {
    slug: 'systems/mbrain',
    path: 'systems/mbrain.md',
    content: [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'See [[concepts/note-manifest]].',
      '',
      '## Runtime',
      'Details',
    ].join('\n'),
  },
  {
    slug: 'concepts/note-manifest',
    path: 'concepts/note-manifest.md',
    content: [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
    ].join('\n'),
  },
] as const;

const EXPECTED_PATH = [
  'page:systems/mbrain',
  'section:systems/mbrain#overview',
  'page:concepts/note-manifest',
] as const;

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase2-structural-paths.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase2-structural-paths-'));
const databasePath = join(tempDir, 'phase2-structural-paths.db');

let engine: BrainEngine | null = null;

try {
  const config = createLocalConfigDefaults({
    database_path: databasePath,
    embedding_provider: 'none',
    query_rewrite_provider: 'none',
  });

  engine = await createConnectedEngine(config);
  await engine.initSchema();
  await seedFixtures(engine);

  const workloads: StructuralPathWorkloadResult[] = [
    await runLatencyWorkload(engine, 'structural_graph_build'),
    await runLatencyWorkload(engine, 'structural_neighbors'),
    await runLatencyWorkload(engine, 'structural_path'),
    await runCorrectnessWorkload(engine),
  ];

  const payload = {
    generated_at: new Date().toISOString(),
    engine: config.engine,
    workloads,
    acceptance: evaluateAcceptance(workloads),
  };

  if (jsonOutput) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Phase 2 structural-paths benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) {
    await engine.disconnect();
  }
  rmSync(tempDir, { recursive: true, force: true });
}

async function seedFixtures(engine: BrainEngine): Promise<void> {
  for (const fixture of FIXTURES) {
    const result = await importFromContent(engine, fixture.slug, fixture.content, { path: fixture.path });
    if (result.status !== 'imported') {
      throw new Error(`Failed to seed fixture ${fixture.slug}: ${result.error ?? result.status}`);
    }
  }
}

async function runLatencyWorkload(
  engine: BrainEngine,
  name: StructuralPathLatencyWorkloadName,
): Promise<Extract<StructuralPathWorkloadResult, { name: StructuralPathLatencyWorkloadName }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    if (name === 'structural_graph_build') {
      await buildStructuralGraphSnapshot(engine);
    } else if (name === 'structural_neighbors') {
      await getStructuralNeighbors(engine, 'page:systems/mbrain');
    } else {
      await findStructuralPath(engine, 'page:systems/mbrain', 'page:concepts/note-manifest');
    }
    durations.push(performance.now() - start);
  }

  return {
    name,
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
): Promise<Extract<StructuralPathWorkloadResult, { name: 'structural_path_correctness' }>> {
  const path = await findStructuralPath(engine, 'page:systems/mbrain', 'page:concepts/note-manifest');
  const successRate = path && path.node_ids.join('|') === EXPECTED_PATH.join('|') ? 100 : 0;

  return {
    name: 'structural_path_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: successRate,
  };
}

function evaluateAcceptance(workloads: StructuralPathWorkloadResult[]) {
  const checks: StructuralPathAcceptanceCheck[] = [];

  const graphBuild = getLatencyWorkload(workloads, 'structural_graph_build');
  checks.push({
    name: 'structural_graph_build_p95_ms',
    status: graphBuild.p95_ms <= STRUCTURAL_PATH_THRESHOLDS.structural_graph_build_p95_ms_max ? 'pass' : 'fail',
    actual: graphBuild.p95_ms,
    threshold: {
      operator: '<=',
      value: STRUCTURAL_PATH_THRESHOLDS.structural_graph_build_p95_ms_max,
      unit: 'ms',
    },
  });

  const neighbors = getLatencyWorkload(workloads, 'structural_neighbors');
  checks.push({
    name: 'structural_neighbors_p95_ms',
    status: neighbors.p95_ms <= STRUCTURAL_PATH_THRESHOLDS.structural_neighbors_p95_ms_max ? 'pass' : 'fail',
    actual: neighbors.p95_ms,
    threshold: {
      operator: '<=',
      value: STRUCTURAL_PATH_THRESHOLDS.structural_neighbors_p95_ms_max,
      unit: 'ms',
    },
  });

  const path = getLatencyWorkload(workloads, 'structural_path');
  checks.push({
    name: 'structural_path_p95_ms',
    status: path.p95_ms <= STRUCTURAL_PATH_THRESHOLDS.structural_path_p95_ms_max ? 'pass' : 'fail',
    actual: path.p95_ms,
    threshold: {
      operator: '<=',
      value: STRUCTURAL_PATH_THRESHOLDS.structural_path_p95_ms_max,
      unit: 'ms',
    },
  });

  const correctness = getCorrectnessWorkload(workloads);
  checks.push({
    name: 'structural_path_correctness_success_rate',
    status: correctness.success_rate === STRUCTURAL_PATH_THRESHOLDS.structural_path_correctness_success_rate ? 'pass' : 'fail',
    actual: correctness.success_rate,
    threshold: {
      operator: '===',
      value: STRUCTURAL_PATH_THRESHOLDS.structural_path_correctness_success_rate,
      unit: 'percent',
    },
  });

  const readiness_status = checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';
  const phase2_status = readiness_status;

  return {
    thresholds: STRUCTURAL_PATH_THRESHOLDS,
    readiness_status,
    phase2_status,
    checks,
    summary: readiness_status === 'pass'
      ? 'Phase 2 structural-path workloads pass the local guardrails.'
      : 'Phase 2 structural-path workloads failed one or more local guardrails.',
  };
}

function getLatencyWorkload(
  workloads: StructuralPathWorkloadResult[],
  name: StructuralPathLatencyWorkloadName,
): Extract<StructuralPathWorkloadResult, { name: StructuralPathLatencyWorkloadName }> {
  const workload = workloads.find((entry) => entry.name === name);
  if (!workload || workload.unit !== 'ms') {
    throw new Error(`Missing latency workload: ${name}`);
  }
  return workload;
}

function getCorrectnessWorkload(
  workloads: StructuralPathWorkloadResult[],
): Extract<StructuralPathWorkloadResult, { name: 'structural_path_correctness' }> {
  const workload = workloads.find((entry) => entry.name === 'structural_path_correctness');
  if (!workload || workload.unit !== 'percent') {
    throw new Error('Missing correctness workload: structural_path_correctness');
  }
  return workload;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function formatMeasuredMs(value: number): number {
  if (value <= 0) return 0;
  return Math.max(0.001, roundTo(value, 3));
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
