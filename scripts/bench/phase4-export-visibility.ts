#!/usr/bin/env bun

import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { runExport } from '../../src/commands/export.ts';
import { previewPersonalExport } from '../../src/core/services/personal-export-visibility-service.ts';

type Phase4ExportVisibilityWorkloadResult =
  | {
      name: 'personal_export_visibility';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'personal_export_visibility_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase4ExportVisibilityAcceptanceCheck {
  name: 'personal_export_visibility_p95_ms' | 'personal_export_visibility_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  personal_export_visibility_p95_ms_max: 100,
  personal_export_visibility_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase4-export-visibility.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase4-export-visibility-'));
const databasePath = join(tempDir, 'phase4-export-visibility.db');

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

  const workloads: Phase4ExportVisibilityWorkloadResult[] = [
    await runCorrectnessWorkload(engine, tempDir),
    await runLatencyWorkload(engine),
  ];

  const payload = {
    generated_at: new Date().toISOString(),
    engine: config.engine,
    phase: 'phase4',
    workloads,
    acceptance: evaluateAcceptance(workloads),
  };

  if (jsonOutput) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Phase 4 export-visibility benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function seedFixtures(engine: BrainEngine) {
  await engine.putPage('systems/export-boundary', {
    type: 'system',
    title: 'Export Boundary',
    compiled_truth: 'Default export should include this canonical page.',
    timeline: '- 2026-04-22: Added export boundary coverage.',
    frontmatter: { tags: ['export'] },
  });
  await engine.upsertProfileMemoryEntry({
    id: 'profile-exportable',
    scope_id: 'personal:default',
    profile_type: 'routine',
    subject: 'daily routine',
    content: 'Wake at 7 AM, review priorities, then write.',
    source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
    sensitivity: 'personal',
    export_status: 'exportable',
    last_confirmed_at: new Date('2026-04-22T00:05:00.000Z'),
    superseded_by: null,
  });
  await engine.upsertProfileMemoryEntry({
    id: 'profile-private',
    scope_id: 'personal:default',
    profile_type: 'stable_fact',
    subject: 'home address',
    content: 'Private location record.',
    source_refs: ['User, direct message, 2026-04-22 9:06 AM KST'],
    sensitivity: 'secret',
    export_status: 'private_only',
    last_confirmed_at: null,
    superseded_by: null,
  });
  await engine.createPersonalEpisodeEntry({
    id: 'episode-1',
    scope_id: 'personal:default',
    title: 'Morning reset',
    start_time: new Date('2026-04-22T06:30:00.000Z'),
    end_time: new Date('2026-04-22T07:00:00.000Z'),
    source_kind: 'chat',
    summary: 'Re-established the daily routine after travel.',
    source_refs: ['User, direct message, 2026-04-22 9:07 AM KST'],
    candidate_ids: ['profile-exportable'],
  });
}

async function runLatencyWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase4ExportVisibilityWorkloadResult, { name: 'personal_export_visibility' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await previewPersonalExport(engine, {
      requested_scope: 'personal',
      query: 'export my personal routine notes',
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'personal_export_visibility',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
  tempDir: string,
): Promise<Extract<Phase4ExportVisibilityWorkloadResult, { name: 'personal_export_visibility_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const pageExportDir = join(tempDir, 'page-export');
  const personalExportDir = join(tempDir, 'personal-export');

  await runExportSilently(engine, ['--dir', pageExportDir]);
  checks += 1;
  if (
    existsSync(join(pageExportDir, 'systems/export-boundary.md'))
    && !existsSync(join(pageExportDir, 'personal'))
  ) {
    passes += 1;
  }

  await runExportSilently(engine, ['--dir', personalExportDir, '--personal-export']);
  checks += 1;
  if (
    !existsSync(join(personalExportDir, 'systems/export-boundary.md'))
    && existsSync(join(personalExportDir, 'personal/profile-memory/profile-exportable.md'))
    && !existsSync(join(personalExportDir, 'personal/profile-memory/profile-private.md'))
    && !existsSync(join(personalExportDir, 'personal/personal-episodes'))
  ) {
    passes += 1;
  }

  return {
    name: 'personal_export_visibility_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

async function runExportSilently(engine: BrainEngine, args: string[]) {
  const originalLog = console.log;
  const originalWrite = process.stdout.write.bind(process.stdout);
  console.log = () => undefined;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await runExport(engine, args);
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
}

function evaluateAcceptance(workloads: Phase4ExportVisibilityWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'personal_export_visibility');
  const correctness = workloads.find((workload) => workload.name === 'personal_export_visibility_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing export-visibility workload results');
  }

  const checks: Phase4ExportVisibilityAcceptanceCheck[] = [
    {
      name: 'personal_export_visibility_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.personal_export_visibility_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.personal_export_visibility_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'personal_export_visibility_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.personal_export_visibility_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.personal_export_visibility_correctness_success_rate,
        unit: 'percent',
      },
    },
  ];

  const readinessStatus = checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';
  return {
    readiness_status: readinessStatus,
    phase4_status: readinessStatus,
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
