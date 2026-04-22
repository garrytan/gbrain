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
import { buildStructuralContextAtlasEntry, workspaceContextAtlasId } from '../../src/core/services/context-atlas-service.ts';
import { getStructuralContextAtlasOverview } from '../../src/core/services/context-atlas-overview-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../../src/core/services/note-manifest-service.ts';

type Phase2ContextAtlasOverviewLatencyWorkloadName = 'context_atlas_overview';

type Phase2ContextAtlasOverviewWorkloadResult =
  | {
      name: Phase2ContextAtlasOverviewLatencyWorkloadName;
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'context_atlas_overview_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase2ContextAtlasOverviewAcceptanceCheck {
  name:
    | 'context_atlas_overview_p95_ms'
    | 'context_atlas_overview_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  context_atlas_overview_p95_ms_max: 100,
  context_atlas_overview_correctness_success_rate: 100,
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
      'Coordinates structural extraction.',
      '[Source: User, direct message, 2026-04-21 10:00 AM KST]',
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
      '[Source: User, direct message, 2026-04-21 10:05 AM KST]',
    ].join('\n'),
  },
] as const;

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase2-context-atlas-overview.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase2-context-atlas-overview-'));
const databasePath = join(tempDir, 'phase2-context-atlas-overview.db');

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
  await buildStructuralContextMapEntry(engine);
  const built = await buildStructuralContextAtlasEntry(engine);

  const workloads: Phase2ContextAtlasOverviewWorkloadResult[] = [
    await runLatencyWorkload(engine),
    await runCorrectnessWorkload(engine, built.id),
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
    console.log(`Phase 2 context-atlas-overview benchmark complete for ${config.engine}`);
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
): Promise<Extract<Phase2ContextAtlasOverviewWorkloadResult, { name: Phase2ContextAtlasOverviewLatencyWorkloadName }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await getStructuralContextAtlasOverview(engine, {
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'context_atlas_overview',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
  atlasId: string,
): Promise<Extract<Phase2ContextAtlasOverviewWorkloadResult, { name: 'context_atlas_overview_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const selected = await getStructuralContextAtlasOverview(engine, {
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
  });
  checks += 1;
  if (
    selected.selection_reason === 'selected_fresh_match'
    && selected.overview?.entry.id === workspaceContextAtlasId(DEFAULT_NOTE_MANIFEST_SCOPE_ID)
    && selected.overview.recommended_reads[0]?.page_slug === 'concepts/note-manifest'
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
    '[Source: User, direct message, 2026-04-21 10:10 AM KST]',
  ].join('\n'), { path: 'concepts/note-manifest.md' });

  const direct = await getStructuralContextAtlasOverview(engine, {
    atlas_id: atlasId,
  });
  checks += 1;
  if (direct.selection_reason === 'direct_atlas_id' && direct.overview?.entry.freshness === 'stale') {
    passes += 1;
  }

  return {
    name: 'context_atlas_overview_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

function evaluateAcceptance(workloads: Phase2ContextAtlasOverviewWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'context_atlas_overview');
  const correctness = workloads.find((workload) => workload.name === 'context_atlas_overview_correctness');

  if (!latency || !correctness) {
    throw new Error('Missing context-atlas-overview workload results');
  }

  const checks: Phase2ContextAtlasOverviewAcceptanceCheck[] = [
    {
      name: 'context_atlas_overview_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.context_atlas_overview_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.context_atlas_overview_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'context_atlas_overview_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.context_atlas_overview_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.context_atlas_overview_correctness_success_rate,
        unit: 'percent',
      },
    },
  ];

  const readinessStatus = checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';
  return {
    thresholds: THRESHOLDS,
    readiness_status: readinessStatus,
    phase2_status: readinessStatus,
    checks,
    summary: readinessStatus === 'pass'
      ? 'Phase 2 context-atlas-overview workloads pass the local guardrails.'
      : 'Phase 2 context-atlas-overview workloads failed one or more local guardrails.',
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
