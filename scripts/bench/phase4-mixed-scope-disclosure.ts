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
import { getMixedScopeDisclosure } from '../../src/core/services/mixed-scope-disclosure-service.ts';

type Phase4MixedScopeDisclosureWorkloadResult =
  | {
      name: 'mixed_scope_disclosure';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'mixed_scope_disclosure_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase4MixedScopeDisclosureAcceptanceCheck {
  name: 'mixed_scope_disclosure_p95_ms' | 'mixed_scope_disclosure_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  mixed_scope_disclosure_p95_ms_max: 100,
  mixed_scope_disclosure_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase4-mixed-scope-disclosure.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase4-mixed-scope-disclosure-'));
const databasePath = join(tempDir, 'phase4-mixed-scope-disclosure.db');

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

  const workloads: Phase4MixedScopeDisclosureWorkloadResult[] = [
    await runCorrectnessWorkload(engine),
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
    console.log(`Phase 4 mixed-scope-disclosure benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function seedFixtures(engine: BrainEngine) {
  await importFromContent(engine, 'systems/mbrain', [
    '---',
    'type: system',
    'title: MBrain',
    '---',
    '# Overview',
    'See [[concepts/note-manifest]].',
    '[Source: User, direct message, 2026-04-22 2:11 PM KST]',
  ].join('\n'), { path: 'systems/mbrain.md' });

  await importFromContent(engine, 'concepts/note-manifest', [
    '---',
    'type: concept',
    'title: Note Manifest',
    '---',
    '# Purpose',
    'Indexes [[systems/mbrain]].',
    '[Source: User, direct message, 2026-04-22 2:12 PM KST]',
  ].join('\n'), { path: 'concepts/note-manifest.md' });

  await buildStructuralContextMapEntry(engine);

  await engine.upsertProfileMemoryEntry({
    id: 'profile-exportable',
    scope_id: 'personal:default',
    profile_type: 'routine',
    subject: 'daily routine',
    content: 'Starts with a written morning reset before deep work.',
    source_refs: ['User, direct message, 2026-04-22 9:03 AM KST'],
    sensitivity: 'personal',
    export_status: 'exportable',
    last_confirmed_at: new Date('2026-04-22T00:03:00.000Z'),
    superseded_by: null,
  });

  await engine.upsertProfileMemoryEntry({
    id: 'profile-private',
    scope_id: 'personal:default',
    profile_type: 'relationship_boundary',
    subject: 'family boundary',
    content: 'Avoid discussing private family conflict during work planning.',
    source_refs: ['User, direct message, 2026-04-22 9:11 AM KST'],
    sensitivity: 'personal',
    export_status: 'private_only',
    last_confirmed_at: new Date('2026-04-22T00:11:00.000Z'),
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
): Promise<Extract<Phase4MixedScopeDisclosureWorkloadResult, { name: 'mixed_scope_disclosure' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await getMixedScopeDisclosure(engine, {
      requested_scope: 'mixed',
      personal_route_kind: 'profile',
      query: 'mbrain',
      subject: 'daily routine',
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'mixed_scope_disclosure',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase4MixedScopeDisclosureWorkloadResult, { name: 'mixed_scope_disclosure_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const exportable = await getMixedScopeDisclosure(engine, {
    requested_scope: 'mixed',
    personal_route_kind: 'profile',
    query: 'mbrain',
    subject: 'daily routine',
  });
  checks += 1;
  if (
    exportable.selection_reason === 'direct_mixed_scope_bridge'
    && exportable.disclosure?.personal_visibility === 'profile_content_disclosed'
    && exportable.disclosure.personal_summary_lines.some((line) => line.includes('Personal profile content:'))
  ) {
    passes += 1;
  }

  const privateProfile = await getMixedScopeDisclosure(engine, {
    requested_scope: 'mixed',
    personal_route_kind: 'profile',
    query: 'mbrain',
    subject: 'family boundary',
  });
  checks += 1;
  if (
    privateProfile.selection_reason === 'direct_mixed_scope_bridge'
    && privateProfile.disclosure?.personal_visibility === 'profile_metadata_only'
    && privateProfile.disclosure.personal_summary_lines.every((line) => !line.includes('Avoid discussing private family conflict'))
  ) {
    passes += 1;
  }

  const episode = await getMixedScopeDisclosure(engine, {
    requested_scope: 'mixed',
    personal_route_kind: 'episode',
    query: 'mbrain',
    episode_title: 'Morning reset',
  });
  checks += 1;
  if (
    episode.selection_reason === 'direct_mixed_scope_bridge'
    && episode.disclosure?.personal_visibility === 'episode_metadata_only'
    && episode.disclosure.personal_summary_lines.every((line) => !line.includes('Re-established the daily routine'))
  ) {
    passes += 1;
  }

  const degraded = await getMixedScopeDisclosure(engine, {
    requested_scope: 'mixed',
    personal_route_kind: 'profile',
    query: 'mbrain',
    subject: 'missing routine',
  });
  checks += 1;
  if (degraded.selection_reason === 'personal_route_no_match' && degraded.disclosure === null) {
    passes += 1;
  }

  return {
    name: 'mixed_scope_disclosure_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

function evaluateAcceptance(workloads: Phase4MixedScopeDisclosureWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'mixed_scope_disclosure');
  const correctness = workloads.find((workload) => workload.name === 'mixed_scope_disclosure_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing mixed-scope-disclosure workload results');
  }

  const checks: Phase4MixedScopeDisclosureAcceptanceCheck[] = [
    {
      name: 'mixed_scope_disclosure_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.mixed_scope_disclosure_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.mixed_scope_disclosure_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'mixed_scope_disclosure_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.mixed_scope_disclosure_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.mixed_scope_disclosure_correctness_success_rate,
        unit: 'percent',
      },
    },
  ];

  const allPass = checks.every((check) => check.status === 'pass');
  return {
    readiness_status: allPass ? 'pass' : 'fail',
    phase4_status: allPass ? 'pass' : 'fail',
    checks,
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function formatMeasuredMs(value: number): number {
  return Number(value.toFixed(3));
}

function formatPercent(value: number): number {
  return Number(value.toFixed(2));
}
