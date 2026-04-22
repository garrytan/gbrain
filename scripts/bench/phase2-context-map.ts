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
  buildStructuralContextMapEntry,
  CONTEXT_MAP_BUILD_MODE,
  CONTEXT_MAP_EXTRACTOR_VERSION,
  CONTEXT_MAP_STALE_REASON_SOURCE_SET_CHANGED,
  WORKSPACE_CONTEXT_MAP_KIND,
  getStructuralContextMapEntry,
  listStructuralContextMapEntries,
  workspaceContextMapId,
} from '../../src/core/services/context-map-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../../src/core/services/note-manifest-service.ts';

type Phase2ContextMapLatencyWorkloadName = 'context_map_build' | 'context_map_get' | 'context_map_list';

type Phase2ContextMapWorkloadResult =
  | {
      name: Phase2ContextMapLatencyWorkloadName;
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'context_map_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase2ContextMapAcceptanceCheck {
  name:
    | 'context_map_build_p95_ms'
    | 'context_map_get_p95_ms'
    | 'context_map_list_p95_ms'
    | 'context_map_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

interface Fixture {
  slug: string;
  path: string;
  content: string;
}

const PHASE2_CONTEXT_MAP_THRESHOLDS = {
  context_map_build_p95_ms_max: 150,
  context_map_get_p95_ms_max: 100,
  context_map_list_p95_ms_max: 100,
  context_map_correctness_success_rate: 100,
} as const;

const PHASE2_CONTEXT_MAP_SAMPLE_COUNT = 5;

const PHASE2_CONTEXT_MAP_FIXTURES: Fixture[] = [
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
      '[Source: User, direct message, 2026-04-20 11:00 AM KST]',
      '',
      '## Runtime',
      'Explains deterministic structural layers.',
      '',
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
      '[Source: User, direct message, 2026-04-20 11:05 AM KST]',
      '',
      '## Inputs',
      'Derived from canonical Markdown.',
      '',
    ].join('\n'),
  },
];

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase2-context-map.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase2-context-map-'));
const databasePath = join(tempDir, 'phase2-context-map.db');

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

  const mapId = workspaceContextMapId(DEFAULT_NOTE_MANIFEST_SCOPE_ID);
  await buildStructuralContextMapEntry(engine);

  const workloads: Phase2ContextMapWorkloadResult[] = [
    await runLatencyWorkload(engine, 'context_map_build'),
    await runLatencyWorkload(engine, 'context_map_get', mapId),
    await runLatencyWorkload(engine, 'context_map_list'),
    await runCorrectnessWorkload(engine, mapId),
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
    console.log(`Phase 2 context-map benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) {
    await engine.disconnect();
  }
  rmSync(tempDir, { recursive: true, force: true });
}

async function seedFixtures(engine: BrainEngine): Promise<void> {
  for (const fixture of PHASE2_CONTEXT_MAP_FIXTURES) {
    const result = await importFromContent(engine, fixture.slug, fixture.content, { path: fixture.path });
    if (result.status !== 'imported') {
      throw new Error(`Failed to seed fixture ${fixture.slug}: ${result.error ?? result.status}`);
    }
  }
}

async function runLatencyWorkload(
  engine: BrainEngine,
  name: Phase2ContextMapLatencyWorkloadName,
  mapId = workspaceContextMapId(DEFAULT_NOTE_MANIFEST_SCOPE_ID),
): Promise<Extract<Phase2ContextMapWorkloadResult, { name: Phase2ContextMapLatencyWorkloadName }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < PHASE2_CONTEXT_MAP_SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    if (name === 'context_map_build') {
      await buildStructuralContextMapEntry(engine);
    } else if (name === 'context_map_get') {
      await engine.getContextMapEntry(mapId);
    } else {
      await engine.listContextMapEntries({
        scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        kind: WORKSPACE_CONTEXT_MAP_KIND,
        limit: 10,
      });
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
  mapId: string,
): Promise<Extract<Phase2ContextMapWorkloadResult, { name: 'context_map_correctness' }>> {
  const entry = await getStructuralContextMapEntry(engine, mapId);
  const list = await listStructuralContextMapEntries(engine, {
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    kind: WORKSPACE_CONTEXT_MAP_KIND,
    limit: 10,
  });

  const graph = entry?.graph_json as { nodes?: Array<Record<string, unknown>>; edges?: Array<Record<string, unknown>> } | undefined;
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  await importFromContent(engine, 'concepts/note-manifest', [
    '---',
    'type: concept',
    'title: Note Manifest',
    '---',
    '# Purpose',
    'Indexes [[systems/mbrain]] and validates stale refresh.',
    '[Source: User, direct message, 2026-04-20 11:10 AM KST]',
  ].join('\n'), { path: 'concepts/note-manifest.md' });

  const staleEntry = await getStructuralContextMapEntry(engine, mapId);
  const staleList = await listStructuralContextMapEntries(engine, {
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    kind: WORKSPACE_CONTEXT_MAP_KIND,
    limit: 10,
  });

  const rebuilt = await buildStructuralContextMapEntry(engine);
  const refreshedEntry = await getStructuralContextMapEntry(engine, mapId);

  const matches =
    entry?.id === mapId &&
    entry.scope_id === DEFAULT_NOTE_MANIFEST_SCOPE_ID &&
    entry.kind === WORKSPACE_CONTEXT_MAP_KIND &&
    entry.build_mode === CONTEXT_MAP_BUILD_MODE &&
    entry.status === 'ready' &&
    entry.extractor_version === CONTEXT_MAP_EXTRACTOR_VERSION &&
    typeof entry.source_set_hash === 'string' &&
    entry.source_set_hash.length > 0 &&
    nodes.length === entry.node_count &&
    edges.length === entry.edge_count &&
    list.some((candidate) => candidate.id === mapId) &&
    list.every((candidate) => candidate.status === 'ready') &&
    nodes.some((node) => node.node_id === 'page:systems/mbrain') &&
    nodes.some((node) => node.node_id === 'section:systems/mbrain#overview') &&
    edges.some((edge) => edge.edge_kind === 'section_links_page') &&
    staleEntry?.status === 'stale' &&
    staleEntry?.stale_reason === CONTEXT_MAP_STALE_REASON_SOURCE_SET_CHANGED &&
    staleList.some((candidate) =>
      candidate.id === mapId
      && candidate.status === 'stale'
      && candidate.stale_reason === CONTEXT_MAP_STALE_REASON_SOURCE_SET_CHANGED,
    ) &&
    rebuilt.status === 'ready' &&
    rebuilt.stale_reason === null &&
    refreshedEntry?.status === 'ready' &&
    refreshedEntry?.stale_reason === null;

  return {
    name: 'context_map_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: matches ? 100 : 0,
  };
}

function evaluateAcceptance(workloads: Phase2ContextMapWorkloadResult[]) {
  const checks: Phase2ContextMapAcceptanceCheck[] = [];

  const build = getLatencyWorkload(workloads, 'context_map_build');
  checks.push({
    name: 'context_map_build_p95_ms',
    status: build.p95_ms <= PHASE2_CONTEXT_MAP_THRESHOLDS.context_map_build_p95_ms_max ? 'pass' : 'fail',
    actual: build.p95_ms,
    threshold: {
      operator: '<=',
      value: PHASE2_CONTEXT_MAP_THRESHOLDS.context_map_build_p95_ms_max,
      unit: 'ms',
    },
  });

  const get = getLatencyWorkload(workloads, 'context_map_get');
  checks.push({
    name: 'context_map_get_p95_ms',
    status: get.p95_ms <= PHASE2_CONTEXT_MAP_THRESHOLDS.context_map_get_p95_ms_max ? 'pass' : 'fail',
    actual: get.p95_ms,
    threshold: {
      operator: '<=',
      value: PHASE2_CONTEXT_MAP_THRESHOLDS.context_map_get_p95_ms_max,
      unit: 'ms',
    },
  });

  const list = getLatencyWorkload(workloads, 'context_map_list');
  checks.push({
    name: 'context_map_list_p95_ms',
    status: list.p95_ms <= PHASE2_CONTEXT_MAP_THRESHOLDS.context_map_list_p95_ms_max ? 'pass' : 'fail',
    actual: list.p95_ms,
    threshold: {
      operator: '<=',
      value: PHASE2_CONTEXT_MAP_THRESHOLDS.context_map_list_p95_ms_max,
      unit: 'ms',
    },
  });

  const correctness = getCorrectnessWorkload(workloads);
  checks.push({
    name: 'context_map_correctness_success_rate',
    status: correctness.success_rate === PHASE2_CONTEXT_MAP_THRESHOLDS.context_map_correctness_success_rate
      ? 'pass'
      : 'fail',
    actual: correctness.success_rate,
    threshold: {
      operator: '===',
      value: PHASE2_CONTEXT_MAP_THRESHOLDS.context_map_correctness_success_rate,
      unit: 'percent',
    },
  });

  const readiness_status = checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';
  const phase2_status = readiness_status;

  return {
    thresholds: PHASE2_CONTEXT_MAP_THRESHOLDS,
    readiness_status,
    phase2_status,
    checks,
    summary: readiness_status === 'pass'
      ? 'Phase 2 context-map workloads pass the local guardrails.'
      : 'Phase 2 context-map workloads failed one or more local guardrails.',
  };
}

function getLatencyWorkload(
  workloads: Phase2ContextMapWorkloadResult[],
  name: Phase2ContextMapLatencyWorkloadName,
): Extract<Phase2ContextMapWorkloadResult, { name: Phase2ContextMapLatencyWorkloadName }> {
  const workload = workloads.find((entry) => entry.name === name);
  if (!workload || workload.unit !== 'ms') {
    throw new Error(`Missing latency workload: ${name}`);
  }
  return workload;
}

function getCorrectnessWorkload(
  workloads: Phase2ContextMapWorkloadResult[],
): Extract<Phase2ContextMapWorkloadResult, { name: 'context_map_correctness' }> {
  const workload = workloads.find((entry) => entry.name === 'context_map_correctness');
  if (!workload || workload.unit !== 'percent') {
    throw new Error('Missing correctness workload: context_map_correctness');
  }
  return workload;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
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
