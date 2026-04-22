#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../../src/core/services/context-map-service.ts';
import { selectRetrievalRoute } from '../../src/core/services/retrieval-route-selector-service.ts';

type Phase3RetrievalRouteTraceWorkloadResult =
  | {
      name: 'retrieval_route_trace';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'retrieval_route_trace_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase3RetrievalRouteTraceAcceptanceCheck {
  name: 'retrieval_route_trace_p95_ms' | 'retrieval_route_trace_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  retrieval_route_trace_p95_ms_max: 100,
  retrieval_route_trace_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase3-retrieval-route-trace.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase3-retrieval-route-trace-'));
const databasePath = join(tempDir, 'phase3-retrieval-route-trace.db');

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

  const workloads: Phase3RetrievalRouteTraceWorkloadResult[] = [
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
    console.log(`Phase 3 retrieval-route-trace benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function seedFixtures(engine: BrainEngine): Promise<void> {
  await engine.createTaskThread({
    id: 'task-1',
    scope: 'work',
    title: 'Traceable selector',
    goal: 'Persist retrieval traces',
    status: 'active',
    repo_path: '/repo',
    branch_name: 'phase2-note-manifest',
    current_summary: 'Need durable explainability',
  });

  await importFromContent(engine, 'systems/mbrain', [
    '---',
    'type: system',
    'title: MBrain',
    '---',
    '# Overview',
    'See [[concepts/note-manifest]].',
    '',
    '## Runtime',
    'Owns exact retrieval routing.',
  ].join('\n'), { path: 'systems/mbrain.md' });
  await importFromContent(engine, 'concepts/note-manifest', [
    '---',
    'type: concept',
    'title: Note Manifest',
    '---',
    '# Purpose',
    'Indexes [[systems/mbrain]].',
  ].join('\n'), { path: 'concepts/note-manifest.md' });

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
    '[Source: User, direct message, 2026-04-22 12:31 PM KST]',
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
    '[Source: User, direct message, 2026-04-22 12:31 PM KST]',
  ].join('\n'), { path: 'systems/brain-cache.md' });

  await buildStructuralContextMapEntry(engine);
}

async function runLatencyWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase3RetrievalRouteTraceWorkloadResult, { name: 'retrieval_route_trace' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await selectRetrievalRoute(engine, {
      intent: 'broad_synthesis',
      task_id: 'task-1',
      query: 'mbrain',
      persist_trace: true,
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'retrieval_route_trace',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase3RetrievalRouteTraceWorkloadResult, { name: 'retrieval_route_trace_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const success = await selectRetrievalRoute(engine, {
    intent: 'broad_synthesis',
    task_id: 'task-1',
    query: 'mbrain',
    persist_trace: true,
  });
  checks += 1;
  if (
    success.trace?.task_id === 'task-1'
    && success.trace.route.length > 0
    && success.trace.outcome === 'broad_synthesis route selected'
  ) {
    passes += 1;
  }

  const miss = await selectRetrievalRoute(engine, {
    intent: 'precision_lookup',
    task_id: 'task-1',
    slug: 'systems/unknown',
    persist_trace: true,
  });
  checks += 1;
  if (
    miss.trace?.task_id === 'task-1'
    && miss.trace.outcome === 'precision_lookup route unavailable'
    && miss.trace.route.length === 0
  ) {
    passes += 1;
  }

  const sectionPath = await selectRetrievalRoute(engine, {
    intent: 'precision_lookup',
    task_id: 'task-1',
    path: 'systems/mbrain.md#overview/runtime',
    persist_trace: true,
  });
  checks += 1;
  if (
    sectionPath.selection_reason === 'direct_section_path_match'
    && sectionPath.trace?.outcome === 'precision_lookup route selected'
    && sectionPath.trace.source_refs.includes('section:systems/mbrain#overview/runtime')
  ) {
    passes += 1;
  }

  const ambiguous = await selectRetrievalRoute(engine, {
    intent: 'precision_lookup',
    task_id: 'task-1',
    source_ref: 'User, direct message, 2026-04-22 12:31 PM KST',
    persist_trace: true,
  });
  checks += 1;
  if (
    ambiguous.selection_reason === 'ambiguous_source_ref_match'
    && ambiguous.trace?.outcome === 'precision_lookup route unavailable'
    && ambiguous.trace.route.length === 0
  ) {
    passes += 1;
  }

  const scopedDeny = await selectRetrievalRoute(engine, {
    intent: 'precision_lookup',
    task_id: 'task-1',
    requested_scope: 'personal',
    query: 'remember my daily routine',
    slug: 'systems/mbrain',
    persist_trace: true,
  });
  checks += 1;
  if (
    scopedDeny.selection_reason === 'unsupported_scope_intent'
    && scopedDeny.trace?.outcome === 'precision_lookup route unavailable'
    && scopedDeny.trace.verification.includes('scope_gate:deny')
  ) {
    passes += 1;
  }

  return {
    name: 'retrieval_route_trace_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

function evaluateAcceptance(workloads: Phase3RetrievalRouteTraceWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'retrieval_route_trace');
  const correctness = workloads.find((workload) => workload.name === 'retrieval_route_trace_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing retrieval-route-trace workload results');
  }

  const checks: Phase3RetrievalRouteTraceAcceptanceCheck[] = [
    {
      name: 'retrieval_route_trace_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.retrieval_route_trace_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.retrieval_route_trace_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'retrieval_route_trace_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.retrieval_route_trace_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.retrieval_route_trace_correctness_success_rate,
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
