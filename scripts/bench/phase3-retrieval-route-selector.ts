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

type Phase3RetrievalRouteSelectorWorkloadResult =
  | {
      name: 'retrieval_route_selector';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'retrieval_route_selector_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase3RetrievalRouteSelectorAcceptanceCheck {
  name: 'retrieval_route_selector_p95_ms' | 'retrieval_route_selector_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  retrieval_route_selector_p95_ms_max: 100,
  retrieval_route_selector_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase3-retrieval-route-selector.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase3-retrieval-route-selector-'));
const databasePath = join(tempDir, 'phase3-retrieval-route-selector.db');

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

  const workloads: Phase3RetrievalRouteSelectorWorkloadResult[] = [
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
    console.log(`Phase 3 retrieval-route-selector benchmark complete for ${config.engine}`);
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
    title: 'Phase 3 selector',
    goal: 'Unify route dispatch',
    status: 'active',
    repo_path: '/repo',
    branch_name: 'phase2-note-manifest',
    current_summary: 'Need one selector surface',
  });
  await engine.upsertTaskWorkingSet({
    task_id: 'task-1',
    active_paths: ['src/core/operations.ts'],
    active_symbols: ['selectRetrievalRoute'],
    blockers: ['selector surface missing'],
    open_questions: ['should selector write traces later'],
    next_steps: ['add selector service'],
    verification_notes: ['task state is current'],
    last_verified_at: new Date('2026-04-22T12:25:00.000Z'),
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
    '[Source: User, direct message, 2026-04-22 12:30 PM KST]',
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
): Promise<Extract<Phase3RetrievalRouteSelectorWorkloadResult, { name: 'retrieval_route_selector' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await selectRetrievalRoute(engine, {
      intent: 'broad_synthesis',
      query: 'mbrain',
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'retrieval_route_selector',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase3RetrievalRouteSelectorWorkloadResult, { name: 'retrieval_route_selector_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const task = await selectRetrievalRoute(engine, {
    intent: 'task_resume',
    task_id: 'task-1',
  });
  checks += 1;
  if (task.selection_reason === 'direct_task_match' && task.route?.route_kind === 'task_resume') {
    passes += 1;
  }

  const broad = await selectRetrievalRoute(engine, {
    intent: 'broad_synthesis',
    query: 'mbrain',
  });
  checks += 1;
  if (broad.selection_reason === 'selected_fresh_match' && broad.route?.route_kind === 'broad_synthesis') {
    passes += 1;
  }

  const exact = await selectRetrievalRoute(engine, {
    intent: 'precision_lookup',
    slug: 'systems/mbrain',
  });
  checks += 1;
  if (exact.selection_reason === 'direct_page_match' && exact.route?.route_kind === 'precision_lookup') {
    passes += 1;
  }

  const byPath = await selectRetrievalRoute(engine, {
    intent: 'precision_lookup',
    path: 'systems/mbrain.md',
  });
  checks += 1;
  if (byPath.selection_reason === 'direct_path_match' && byPath.route?.route_kind === 'precision_lookup') {
    passes += 1;
  }

  const bySectionPath = await selectRetrievalRoute(engine, {
    intent: 'precision_lookup',
    path: 'systems/mbrain.md#overview/runtime',
  });
  checks += 1;
  if (bySectionPath.selection_reason === 'direct_section_path_match' && bySectionPath.route?.route_kind === 'precision_lookup') {
    passes += 1;
  }

  const bySourceRef = await selectRetrievalRoute(engine, {
    intent: 'precision_lookup',
    source_ref: 'User, direct message, 2026-04-22 12:30 PM KST',
  });
  checks += 1;
  if (bySourceRef.selection_reason === 'direct_source_ref_section_match' && bySourceRef.route?.route_kind === 'precision_lookup') {
    passes += 1;
  }

  const ambiguous = await selectRetrievalRoute(engine, {
    intent: 'precision_lookup',
    source_ref: 'User, direct message, 2026-04-22 12:31 PM KST',
  });
  checks += 1;
  if (
    ambiguous.selection_reason === 'ambiguous_source_ref_match'
    && ambiguous.candidate_count === 2
    && ambiguous.route === null
  ) {
    passes += 1;
  }

  const scopedDeny = await selectRetrievalRoute(engine, {
    intent: 'precision_lookup',
    requested_scope: 'personal',
    query: 'remember my daily routine',
    slug: 'systems/mbrain',
  });
  checks += 1;
  if (
    scopedDeny.selection_reason === 'unsupported_scope_intent'
    && scopedDeny.route === null
    && scopedDeny.scope_gate?.policy === 'deny'
  ) {
    passes += 1;
  }

  const missing = await selectRetrievalRoute(engine, {
    intent: 'precision_lookup',
    slug: 'systems/unknown',
  });
  checks += 1;
  if (missing.selection_reason === 'no_match' && missing.route === null) {
    passes += 1;
  }

  return {
    name: 'retrieval_route_selector_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

function evaluateAcceptance(workloads: Phase3RetrievalRouteSelectorWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'retrieval_route_selector');
  const correctness = workloads.find((workload) => workload.name === 'retrieval_route_selector_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing retrieval-route-selector workload results');
  }

  const checks: Phase3RetrievalRouteSelectorAcceptanceCheck[] = [
    {
      name: 'retrieval_route_selector_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.retrieval_route_selector_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.retrieval_route_selector_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'retrieval_route_selector_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.retrieval_route_selector_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.retrieval_route_selector_correctness_success_rate,
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
