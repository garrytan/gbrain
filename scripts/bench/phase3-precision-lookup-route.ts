#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { getPrecisionLookupRoute } from '../../src/core/services/precision-lookup-route-service.ts';

type Phase3PrecisionLookupRouteWorkloadResult =
  | {
      name: 'precision_lookup_route';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'precision_lookup_route_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase3PrecisionLookupRouteAcceptanceCheck {
  name: 'precision_lookup_route_p95_ms' | 'precision_lookup_route_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  precision_lookup_route_p95_ms_max: 100,
  precision_lookup_route_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase3-precision-lookup-route.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase3-precision-lookup-route-'));
const databasePath = join(tempDir, 'phase3-precision-lookup-route.db');

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

  const workloads: Phase3PrecisionLookupRouteWorkloadResult[] = [
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
    console.log(`Phase 3 precision-lookup-route benchmark complete for ${config.engine}`);
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
    'Coordinates structural extraction.',
    '',
    '## Runtime',
    'Owns exact retrieval routing.',
    '[Source: User, direct message, 2026-04-22 12:00 PM KST]',
  ].join('\n'), { path: 'systems/mbrain.md' });

  await importFromContent(engine, 'systems/brain-graph', [
    '---',
    'type: system',
    'title: Brain Graph',
    '---',
    '# Overview',
    'Maps knowledge structures.',
    '',
    '## Runtime',
    'Owns graph traversal.',
    '[Source: User, direct message, 2026-04-22 12:01 PM KST]',
  ].join('\n'), { path: 'systems/brain-graph.md' });

  await importFromContent(engine, 'systems/brain-cache', [
    '---',
    'type: system',
    'title: Brain Cache',
    '---',
    '# Overview',
    'Caches memory snapshots.',
    '',
    '## Runtime',
    'Owns cache invalidation.',
    '[Source: User, direct message, 2026-04-22 12:01 PM KST]',
  ].join('\n'), { path: 'systems/brain-cache.md' });
}

async function runLatencyWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase3PrecisionLookupRouteWorkloadResult, { name: 'precision_lookup_route' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await getPrecisionLookupRoute(engine, {
      slug: 'systems/mbrain',
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'precision_lookup_route',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase3PrecisionLookupRouteWorkloadResult, { name: 'precision_lookup_route_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const noMatch = await getPrecisionLookupRoute(engine, {
    slug: 'systems/unknown',
  });
  checks += 1;
  if (noMatch.selection_reason === 'no_match' && noMatch.route === null) {
    passes += 1;
  }

  const page = await getPrecisionLookupRoute(engine, {
    slug: 'systems/mbrain',
  });
  checks += 1;
  if (
    page.selection_reason === 'direct_page_match'
    && page.route?.target_kind === 'page'
    && page.route.slug === 'systems/mbrain'
  ) {
    passes += 1;
  }

  const [, section] = await engine.listNoteSectionEntries({
    scope_id: 'workspace:default',
    page_slug: 'systems/mbrain',
    limit: 10,
  });
  if (!section) {
    throw new Error('section fixture missing for precision-lookup-route benchmark');
  }

  const exactSection = await getPrecisionLookupRoute(engine, {
    section_id: section.section_id,
  });
  checks += 1;
  if (
    exactSection.selection_reason === 'direct_section_match'
    && exactSection.route?.target_kind === 'section'
    && exactSection.route.section_id === section.section_id
  ) {
    passes += 1;
  }

  const byPath = await getPrecisionLookupRoute(engine, {
    path: 'systems/mbrain.md',
  });
  checks += 1;
  if (
    byPath.selection_reason === 'direct_path_match'
    && byPath.route?.target_kind === 'page'
    && byPath.route.path === 'systems/mbrain.md'
  ) {
    passes += 1;
  }

  const bySectionPath = await getPrecisionLookupRoute(engine, {
    path: 'systems/mbrain.md#overview/runtime',
  });
  checks += 1;
  if (
    bySectionPath.selection_reason === 'direct_section_path_match'
    && bySectionPath.route?.target_kind === 'section'
    && bySectionPath.route.path === 'systems/mbrain.md#overview/runtime'
  ) {
    passes += 1;
  }

  const bySourceRef = await getPrecisionLookupRoute(engine, {
    source_ref: 'User, direct message, 2026-04-22 12:00 PM KST',
  });
  checks += 1;
  if (
    bySourceRef.selection_reason === 'direct_source_ref_section_match'
    && bySourceRef.route?.target_kind === 'section'
    && bySourceRef.route.path === 'systems/mbrain.md#overview/runtime'
  ) {
    passes += 1;
  }

  const ambiguous = await getPrecisionLookupRoute(engine, {
    source_ref: 'User, direct message, 2026-04-22 12:01 PM KST',
  });
  checks += 1;
  if (
    ambiguous.selection_reason === 'ambiguous_source_ref_match'
    && ambiguous.candidate_count === 2
    && ambiguous.route === null
  ) {
    passes += 1;
  }

  return {
    name: 'precision_lookup_route_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

function evaluateAcceptance(workloads: Phase3PrecisionLookupRouteWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'precision_lookup_route');
  const correctness = workloads.find((workload) => workload.name === 'precision_lookup_route_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing precision-lookup-route workload results');
  }

  const checks: Phase3PrecisionLookupRouteAcceptanceCheck[] = [
    {
      name: 'precision_lookup_route_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.precision_lookup_route_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.precision_lookup_route_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'precision_lookup_route_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.precision_lookup_route_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.precision_lookup_route_correctness_success_rate,
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
