#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { buildStructuralContextAtlasEntry } from '../../src/core/services/context-atlas-service.ts';
import { buildStructuralContextMapEntry } from '../../src/core/services/context-map-service.ts';
import { getAtlasOrientationCard } from '../../src/core/services/atlas-orientation-card-service.ts';

type Phase2AtlasOrientationCardLatencyWorkloadName = 'atlas_orientation_card';

type Phase2AtlasOrientationCardWorkloadResult =
  | {
      name: Phase2AtlasOrientationCardLatencyWorkloadName;
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'atlas_orientation_card_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase2AtlasOrientationCardAcceptanceCheck {
  name:
    | 'atlas_orientation_card_p95_ms'
    | 'atlas_orientation_card_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  atlas_orientation_card_p95_ms_max: 100,
  atlas_orientation_card_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const FIXTURES = [
  {
    slug: 'projects/apollo',
    path: 'projects/apollo.md',
    content: [
      '---',
      'type: project',
      'title: Apollo',
      'repo: meghendra6/apollo',
      'status: active',
      '---',
      '# Overview',
      'Uses [[systems/mbrain]].',
      '[Source: User, direct message, 2026-04-21 1:30 PM KST]',
    ].join('\n'),
  },
  {
    slug: 'systems/mbrain',
    path: 'systems/mbrain.md',
    content: [
      '---',
      'type: system',
      'title: MBrain',
      'repo: meghendra6/mbrain',
      'build_command: bun run build',
      'test_command: bun test',
      '---',
      '# Overview',
      'Supports [[projects/apollo]].',
      '[Source: User, direct message, 2026-04-21 1:31 PM KST]',
    ].join('\n'),
  },
] as const;

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase2-atlas-orientation-card.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase2-atlas-orientation-card-'));
const databasePath = join(tempDir, 'phase2-atlas-orientation-card.db');

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
  const atlas = await buildStructuralContextAtlasEntry(engine);

  const workloads: Phase2AtlasOrientationCardWorkloadResult[] = [
    await runLatencyWorkload(engine, atlas.id),
    await runCorrectnessWorkload(engine, atlas.id),
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
    console.log(`Phase 2 atlas-orientation-card benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) await engine.disconnect();
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
  atlasId: string,
): Promise<Extract<Phase2AtlasOrientationCardWorkloadResult, { name: Phase2AtlasOrientationCardLatencyWorkloadName }>> {
  const durations: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await getAtlasOrientationCard(engine, {
      atlas_id: atlasId,
    });
    durations.push(performance.now() - start);
  }
  return {
    name: 'atlas_orientation_card',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
  atlasId: string,
): Promise<Extract<Phase2AtlasOrientationCardWorkloadResult, { name: 'atlas_orientation_card_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const result = await getAtlasOrientationCard(engine, {
    atlas_id: atlasId,
  });
  checks += 1;
  if (
    result.selection_reason === 'direct_atlas_id'
    && result.card?.anchor_slugs.join(',') === 'projects/apollo,systems/mbrain'
    && result.card.recommended_reads.length > 0
  ) {
    passes += 1;
  }

  return {
    name: 'atlas_orientation_card_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

function evaluateAcceptance(workloads: Phase2AtlasOrientationCardWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'atlas_orientation_card');
  const correctness = workloads.find((workload) => workload.name === 'atlas_orientation_card_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing atlas-orientation-card workload results');
  }
  const checks: Phase2AtlasOrientationCardAcceptanceCheck[] = [
    {
      name: 'atlas_orientation_card_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.atlas_orientation_card_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.atlas_orientation_card_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'atlas_orientation_card_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.atlas_orientation_card_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.atlas_orientation_card_correctness_success_rate,
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
      ? 'Phase 2 atlas-orientation-card workloads pass the local guardrails.'
      : 'Phase 2 atlas-orientation-card workloads failed one or more local guardrails.',
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
