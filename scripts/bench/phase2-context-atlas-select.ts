#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { buildStructuralContextMapEntry } from '../../src/core/services/context-map-service.ts';
import { selectStructuralContextAtlasEntry } from '../../src/core/services/context-atlas-service.ts';

type Phase2ContextAtlasSelectLatencyWorkloadName = 'context_atlas_select';

type Phase2ContextAtlasSelectWorkloadResult =
  | {
      name: Phase2ContextAtlasSelectLatencyWorkloadName;
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'context_atlas_select_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase2ContextAtlasSelectAcceptanceCheck {
  name:
    | 'context_atlas_select_p95_ms'
    | 'context_atlas_select_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const PHASE2_CONTEXT_ATLAS_SELECT_THRESHOLDS = {
  context_atlas_select_p95_ms_max: 100,
  context_atlas_select_correctness_success_rate: 100,
} as const;

const PHASE2_CONTEXT_ATLAS_SELECT_SAMPLE_COUNT = 5;
const DEFAULT_SCOPE_ID = 'workspace:default';

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase2-context-atlas-select.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase2-context-atlas-select-'));
const databasePath = join(tempDir, 'phase2-context-atlas-select.db');

let engine: BrainEngine | null = null;

try {
  const config = createLocalConfigDefaults({
    database_path: databasePath,
    embedding_provider: 'none',
    query_rewrite_provider: 'none',
  });

  engine = await createConnectedEngine(config);
  await engine.initSchema();
  await seedSelectionFixtures(engine);

  const workloads: Phase2ContextAtlasSelectWorkloadResult[] = [
    await runLatencyWorkload(engine),
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
    console.log(`Phase 2 context-atlas-select benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) {
    await engine.disconnect();
  }
  rmSync(tempDir, { recursive: true, force: true });
}

async function seedSelectionFixtures(engine: BrainEngine): Promise<void> {
  const currentMap = await buildStructuralContextMapEntry(engine);
  const currentSourceSetHash = currentMap.source_set_hash;

  await engine.upsertContextMapEntry({
    id: 'context-map:workspace:workspace:default:project:fresh',
    scope_id: DEFAULT_SCOPE_ID,
    kind: 'project',
    title: 'Fresh Project Map',
    build_mode: 'structural',
    status: 'ready',
    source_set_hash: currentSourceSetHash,
    extractor_version: 'phase2-context-map-v1',
    node_count: 1,
    edge_count: 0,
    community_count: 0,
    graph_json: { nodes: [], edges: [] },
  });
  await engine.upsertContextMapEntry({
    id: 'context-map:workspace:workspace:default:project:stale',
    scope_id: DEFAULT_SCOPE_ID,
    kind: 'project',
    title: 'Stale Project Map',
    build_mode: 'structural',
    status: 'stale',
    source_set_hash: 'stale-project',
    extractor_version: 'phase2-context-map-v1',
    node_count: 1,
    edge_count: 0,
    community_count: 0,
    graph_json: { nodes: [], edges: [] },
  });

  await engine.upsertContextAtlasEntry({
    id: 'context-atlas:project:workspace:default:fresh',
    map_id: 'context-map:workspace:workspace:default:project:fresh',
    scope_id: DEFAULT_SCOPE_ID,
    kind: 'project',
    title: 'Fresh Project Atlas',
    freshness: 'fresh',
    entrypoints: ['page:systems/mbrain'],
    budget_hint: 4,
  });
  await engine.upsertContextAtlasEntry({
    id: 'context-atlas:project:workspace:default:stale',
    map_id: 'context-map:workspace:workspace:default:project:stale',
    scope_id: DEFAULT_SCOPE_ID,
    kind: 'project',
    title: 'Stale Project Atlas',
    freshness: 'stale',
    entrypoints: ['page:concepts/note-manifest'],
    budget_hint: 2,
  });
}

async function runLatencyWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase2ContextAtlasSelectWorkloadResult, { name: Phase2ContextAtlasSelectLatencyWorkloadName }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < PHASE2_CONTEXT_ATLAS_SELECT_SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await selectStructuralContextAtlasEntry(engine, {
      scope_id: DEFAULT_SCOPE_ID,
      kind: 'project',
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'context_atlas_select',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase2ContextAtlasSelectWorkloadResult, { name: 'context_atlas_select_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const fresh = await selectStructuralContextAtlasEntry(engine, {
    scope_id: DEFAULT_SCOPE_ID,
    kind: 'project',
  });
  checks += 1;
  if (fresh.reason === 'selected_fresh_match' && fresh.entry?.id === 'context-atlas:project:workspace:default:fresh') {
    passes += 1;
  }

  const blocked = await selectStructuralContextAtlasEntry(engine, {
    scope_id: DEFAULT_SCOPE_ID,
    kind: 'project',
    max_budget_hint: 2,
  });
  checks += 1;
  if (blocked.reason === 'no_budget_fit' && blocked.entry === null) {
    passes += 1;
  }

  const staleAllowed = await selectStructuralContextAtlasEntry(engine, {
    scope_id: DEFAULT_SCOPE_ID,
    kind: 'project',
    max_budget_hint: 2,
    allow_stale: true,
  });
  checks += 1;
  if (staleAllowed.reason === 'selected_stale_match' && staleAllowed.entry?.id === 'context-atlas:project:workspace:default:stale') {
    passes += 1;
  }

  return {
    name: 'context_atlas_select_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

function evaluateAcceptance(workloads: Phase2ContextAtlasSelectWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'context_atlas_select');
  const correctness = workloads.find((workload) => workload.name === 'context_atlas_select_correctness');

  if (!latency || !correctness) {
    throw new Error('Missing context-atlas-select workload results');
  }

  const checks: Phase2ContextAtlasSelectAcceptanceCheck[] = [
    {
      name: 'context_atlas_select_p95_ms',
      status: latency.p95_ms <= PHASE2_CONTEXT_ATLAS_SELECT_THRESHOLDS.context_atlas_select_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: PHASE2_CONTEXT_ATLAS_SELECT_THRESHOLDS.context_atlas_select_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'context_atlas_select_correctness_success_rate',
      status: correctness.success_rate === PHASE2_CONTEXT_ATLAS_SELECT_THRESHOLDS.context_atlas_select_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: PHASE2_CONTEXT_ATLAS_SELECT_THRESHOLDS.context_atlas_select_correctness_success_rate,
        unit: 'percent',
      },
    },
  ];

  const readinessStatus = checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';

  return {
    thresholds: PHASE2_CONTEXT_ATLAS_SELECT_THRESHOLDS,
    readiness_status: readinessStatus,
    phase2_status: readinessStatus,
    checks,
    summary: readinessStatus === 'pass'
      ? 'Phase 2 context-atlas-select workloads pass the local guardrails.'
      : 'Phase 2 context-atlas-select workloads failed one or more local guardrails.',
  };
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function formatMeasuredMs(value: number): number {
  return Number(value.toFixed(3));
}

function formatPercent(value: number): number {
  return Number(value.toFixed(2));
}
