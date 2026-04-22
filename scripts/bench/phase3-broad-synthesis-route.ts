#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { getBroadSynthesisRoute } from '../../src/core/services/broad-synthesis-route-service.ts';
import { buildStructuralContextMapEntry } from '../../src/core/services/context-map-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../../src/core/services/note-manifest-service.ts';

type Phase3BroadSynthesisRouteWorkloadResult =
  | {
      name: 'broad_synthesis_route';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'broad_synthesis_route_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase3BroadSynthesisRouteAcceptanceCheck {
  name: 'broad_synthesis_route_p95_ms' | 'broad_synthesis_route_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  broad_synthesis_route_p95_ms_max: 100,
  broad_synthesis_route_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const QUERY = 'mbrain';
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase3-broad-synthesis-route.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase3-broad-synthesis-route-'));
const databasePath = join(tempDir, 'phase3-broad-synthesis-route.db');

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

  const workloads: Phase3BroadSynthesisRouteWorkloadResult[] = [
    await runCorrectnessWorkload(engine),
    await runLatencyWorkload(engine),
  ];

  const payload = {
    generated_at: new Date().toISOString(),
    engine: config.engine,
    phase: 'phase3',
    workloads,
    acceptance: evaluateAcceptance(workloads),
  };

  if (jsonOutput) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Phase 3 broad-synthesis-route benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function seedFixtures(engine: BrainEngine): Promise<void> {
  await importFromContent(engine, 'systems/mbrain', [
    '---',
    'type: system',
    'title: MBrain',
    '---',
    '# Overview',
    'See [[concepts/note-manifest]].',
    '',
    '## Runtime',
    'Coordinates structural extraction.',
    '[Source: User, direct message, 2026-04-22 11:30 AM KST]',
  ].join('\n'), { path: 'systems/mbrain.md' });

  await importFromContent(engine, 'concepts/note-manifest', [
    '---',
    'type: concept',
    'title: Note Manifest',
    '---',
    '# Purpose',
    'Indexes [[systems/mbrain]].',
    '[Source: User, direct message, 2026-04-22 11:31 AM KST]',
  ].join('\n'), { path: 'concepts/note-manifest.md' });
}

async function runLatencyWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase3BroadSynthesisRouteWorkloadResult, { name: 'broad_synthesis_route' }>> {
  const built = await buildStructuralContextMapEntry(engine);
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await getBroadSynthesisRoute(engine, {
      map_id: built.id,
      query: QUERY,
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'broad_synthesis_route',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase3BroadSynthesisRouteWorkloadResult, { name: 'broad_synthesis_route_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const noMatch = await getBroadSynthesisRoute(engine, {
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    query: QUERY,
  });
  checks += 1;
  if (noMatch.selection_reason === 'no_match' && noMatch.route === null) {
    passes += 1;
  }

  const built = await buildStructuralContextMapEntry(engine);

  const fresh = await getBroadSynthesisRoute(engine, {
    map_id: built.id,
    query: QUERY,
  });
  checks += 1;
  if (
    fresh.selection_reason === 'direct_map_id'
    && fresh.route?.status === 'ready'
    && fresh.route.focal_node_id === 'page:systems/mbrain'
  ) {
    passes += 1;
  }

  const fallback = await getBroadSynthesisRoute(engine, {
    map_id: built.id,
    query: 'unmatched-query',
  });
  checks += 1;
  if (
    fallback.selection_reason === 'direct_map_id'
    && fallback.route?.focal_node_id === null
    && fallback.route.summary_lines.includes('No structural node matched the route query; fall back to report-driven orientation.')
  ) {
    passes += 1;
  }

  await importFromContent(engine, 'concepts/note-manifest', [
    '---',
    'type: concept',
    'title: Note Manifest',
    '---',
    '# Purpose',
    'Indexes [[systems/mbrain]] and changes freshness.',
    '[Source: User, direct message, 2026-04-22 11:32 AM KST]',
  ].join('\n'), { path: 'concepts/note-manifest.md' });

  const stale = await getBroadSynthesisRoute(engine, {
    map_id: built.id,
    query: QUERY,
  });
  checks += 1;
  if (
    stale.selection_reason === 'direct_map_id'
    && stale.route?.status === 'stale'
    && stale.route.summary_lines.includes('Rebuild the context map before trusting this broad-synthesis route.')
  ) {
    passes += 1;
  }

  return {
    name: 'broad_synthesis_route_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

function evaluateAcceptance(workloads: Phase3BroadSynthesisRouteWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'broad_synthesis_route');
  const correctness = workloads.find((workload) => workload.name === 'broad_synthesis_route_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing broad-synthesis-route workload results');
  }

  const checks: Phase3BroadSynthesisRouteAcceptanceCheck[] = [
    {
      name: 'broad_synthesis_route_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.broad_synthesis_route_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.broad_synthesis_route_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'broad_synthesis_route_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.broad_synthesis_route_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.broad_synthesis_route_correctness_success_rate,
        unit: 'percent',
      },
    },
  ];

  const readinessStatus = checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';
  return {
    readiness_status: readinessStatus,
    phase3_status: readinessStatus,
    checks,
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 0;
}

function formatMeasuredMs(value: number): number {
  return Number(value.toFixed(3));
}

function formatPercent(value: number): number {
  return Number(value.toFixed(2));
}
