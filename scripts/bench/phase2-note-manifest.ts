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
  DEFAULT_NOTE_MANIFEST_SCOPE_ID,
  NOTE_MANIFEST_EXTRACTOR_VERSION,
  rebuildNoteManifestEntries,
} from '../../src/core/services/note-manifest-service.ts';

type Phase2LatencyWorkloadName = 'manifest_get' | 'manifest_list' | 'manifest_rebuild';

type Phase2WorkloadResult =
  | {
      name: Phase2LatencyWorkloadName;
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'structural_projection';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase2AcceptanceCheck {
  name:
    | 'manifest_get_p95_ms'
    | 'manifest_list_p95_ms'
    | 'manifest_rebuild_p95_ms'
    | 'structural_projection_success_rate';
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
  expected: {
    page_type: 'system' | 'concept';
    aliases: string[];
    tags: string[];
    outgoing_wikilinks: string[];
    outgoing_urls: string[];
    source_refs: string[];
    heading_texts: string[];
  };
}

const PHASE2_ACCEPTANCE_THRESHOLDS = {
  manifest_get_p95_ms_max: 100,
  manifest_list_p95_ms_max: 100,
  manifest_rebuild_p95_ms_max: 150,
  structural_projection_success_rate: 100,
} as const;

const PHASE2_SAMPLE_COUNT = 5;

const PHASE2_FIXTURES: Fixture[] = [
  {
    slug: 'systems/mbrain',
    path: 'systems/mbrain.md',
    content: [
      '---',
      'type: system',
      'title: MBrain System',
      'tags: [phase2, manifest]',
      'aliases: [MBrain Core]',
      '---',
      '# Overview',
      'Links to [[concepts/note-manifest]] and [[people/sarah-chen|Sarah]].',
      '[Source: User, direct message, 2026-04-20 09:00 AM KST]',
      '',
      '## Runtime',
      'Docs: https://example.com/mbrain and https://example.com/mbrain.',
      '',
      '---',
      '',
      '### Timeline',
      '- Manifest import added.',
      '[Source: Meeting notes, phase2 sync, 2026-04-20 10:00 AM KST]',
      '',
    ].join('\n'),
    expected: {
      page_type: 'system',
      aliases: ['MBrain Core'],
      tags: ['manifest', 'phase2'],
      outgoing_wikilinks: ['concepts/note-manifest', 'people/sarah-chen'],
      outgoing_urls: ['https://example.com/mbrain'],
      source_refs: [
        'User, direct message, 2026-04-20 09:00 AM KST',
        'Meeting notes, phase2 sync, 2026-04-20 10:00 AM KST',
      ],
      heading_texts: ['Overview', 'Runtime', 'Timeline'],
    },
  },
  {
    slug: 'concepts/note-manifest',
    path: 'concepts/note-manifest.md',
    content: [
      '---',
      'type: concept',
      'title: Note Manifest',
      'tags: [phase2, manifest]',
      'aliases: [Structural Index]',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
      '[Source: User, direct message, 2026-04-20 09:05 AM KST]',
      '',
      '## Fields',
      'Review https://example.com/specs/manifest.',
      '',
    ].join('\n'),
    expected: {
      page_type: 'concept',
      aliases: ['Structural Index'],
      tags: ['manifest', 'phase2'],
      outgoing_wikilinks: ['systems/mbrain'],
      outgoing_urls: ['https://example.com/specs/manifest'],
      source_refs: ['User, direct message, 2026-04-20 09:05 AM KST'],
      heading_texts: ['Purpose', 'Fields'],
    },
  },
];

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase2-note-manifest.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase2-'));
const databasePath = join(tempDir, 'phase2.db');

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

  const workloads: Phase2WorkloadResult[] = [
    await runLatencyWorkload(engine, 'manifest_get'),
    await runLatencyWorkload(engine, 'manifest_list'),
    await runLatencyWorkload(engine, 'manifest_rebuild'),
    await runStructuralProjectionWorkload(engine),
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
    console.log(`Phase 2 note-manifest benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) {
    await engine.disconnect();
  }
  rmSync(tempDir, { recursive: true, force: true });
}

async function seedFixtures(engine: BrainEngine): Promise<void> {
  for (const fixture of PHASE2_FIXTURES) {
    const result = await importFromContent(engine, fixture.slug, fixture.content, { path: fixture.path });
    if (result.status !== 'imported') {
      throw new Error(`Failed to seed fixture ${fixture.slug}: ${result.error ?? result.status}`);
    }
  }
}

async function runLatencyWorkload(
  engine: BrainEngine,
  name: Phase2LatencyWorkloadName,
): Promise<Extract<Phase2WorkloadResult, { name: Phase2LatencyWorkloadName }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < PHASE2_SAMPLE_COUNT; sample += 1) {
    if (name === 'manifest_get') {
      for (const fixture of PHASE2_FIXTURES) {
        const start = performance.now();
        await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, fixture.slug);
        durations.push(performance.now() - start);
      }
      continue;
    }

    const start = performance.now();
    if (name === 'manifest_list') {
      await engine.listNoteManifestEntries({
        scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        limit: PHASE2_FIXTURES.length,
      });
    } else {
      await rebuildNoteManifestEntries(engine, { scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID });
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

async function runStructuralProjectionWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase2WorkloadResult, { name: 'structural_projection' }>> {
  let passed = 0;

  for (const fixture of PHASE2_FIXTURES) {
    const entry = await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, fixture.slug);
    const matches =
      entry?.page_type === fixture.expected.page_type &&
      entry.extractor_version === NOTE_MANIFEST_EXTRACTOR_VERSION &&
      hasExactItems(entry.aliases, fixture.expected.aliases) &&
      hasExactItems(entry.tags, fixture.expected.tags) &&
      hasExactItems(entry.outgoing_wikilinks, fixture.expected.outgoing_wikilinks) &&
      hasExactItems(entry.outgoing_urls, fixture.expected.outgoing_urls) &&
      hasExactItems(entry.source_refs, fixture.expected.source_refs) &&
      hasExactItems(entry.heading_index.map((heading) => heading.text), fixture.expected.heading_texts);

    if (matches) {
      passed += 1;
    }
  }

  return {
    name: 'structural_projection',
    status: 'measured',
    unit: 'percent',
    success_rate: roundTo((passed / PHASE2_FIXTURES.length) * 100, 2),
  };
}

function evaluateAcceptance(workloads: Phase2WorkloadResult[]) {
  const checks: Phase2AcceptanceCheck[] = [];

  const manifestGet = getLatencyWorkload(workloads, 'manifest_get');
  checks.push({
    name: 'manifest_get_p95_ms',
    status: manifestGet.p95_ms <= PHASE2_ACCEPTANCE_THRESHOLDS.manifest_get_p95_ms_max ? 'pass' : 'fail',
    actual: manifestGet.p95_ms,
    threshold: {
      operator: '<=',
      value: PHASE2_ACCEPTANCE_THRESHOLDS.manifest_get_p95_ms_max,
      unit: 'ms',
    },
  });

  const manifestList = getLatencyWorkload(workloads, 'manifest_list');
  checks.push({
    name: 'manifest_list_p95_ms',
    status: manifestList.p95_ms <= PHASE2_ACCEPTANCE_THRESHOLDS.manifest_list_p95_ms_max ? 'pass' : 'fail',
    actual: manifestList.p95_ms,
    threshold: {
      operator: '<=',
      value: PHASE2_ACCEPTANCE_THRESHOLDS.manifest_list_p95_ms_max,
      unit: 'ms',
    },
  });

  const manifestRebuild = getLatencyWorkload(workloads, 'manifest_rebuild');
  checks.push({
    name: 'manifest_rebuild_p95_ms',
    status: manifestRebuild.p95_ms <= PHASE2_ACCEPTANCE_THRESHOLDS.manifest_rebuild_p95_ms_max ? 'pass' : 'fail',
    actual: manifestRebuild.p95_ms,
    threshold: {
      operator: '<=',
      value: PHASE2_ACCEPTANCE_THRESHOLDS.manifest_rebuild_p95_ms_max,
      unit: 'ms',
    },
  });

  const structuralProjection = getCorrectnessWorkload(workloads, 'structural_projection');
  checks.push({
    name: 'structural_projection_success_rate',
    status: structuralProjection.success_rate === PHASE2_ACCEPTANCE_THRESHOLDS.structural_projection_success_rate
      ? 'pass'
      : 'fail',
    actual: structuralProjection.success_rate,
    threshold: {
      operator: '===',
      value: PHASE2_ACCEPTANCE_THRESHOLDS.structural_projection_success_rate,
      unit: 'percent',
    },
  });

  const readiness_status = checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';
  const phase2_status = readiness_status;

  return {
    thresholds: PHASE2_ACCEPTANCE_THRESHOLDS,
    readiness_status,
    phase2_status,
    checks,
    summary: readiness_status === 'pass'
      ? 'Phase 2 note-manifest workloads pass the local guardrails.'
      : 'Phase 2 note-manifest workloads failed one or more local guardrails.',
  };
}

function getLatencyWorkload(
  workloads: Phase2WorkloadResult[],
  name: Phase2LatencyWorkloadName,
): Extract<Phase2WorkloadResult, { name: Phase2LatencyWorkloadName }> {
  const workload = workloads.find((entry) => entry.name === name);
  if (!workload || workload.unit !== 'ms') {
    throw new Error(`Missing latency workload: ${name}`);
  }
  return workload;
}

function getCorrectnessWorkload(
  workloads: Phase2WorkloadResult[],
  name: 'structural_projection',
): Extract<Phase2WorkloadResult, { name: 'structural_projection' }> {
  const workload = workloads.find((entry) => entry.name === name);
  if (!workload || workload.unit !== 'percent') {
    throw new Error(`Missing correctness workload: ${name}`);
  }
  return workload;
}

function hasExactItems(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((entry, index) => actual[index] === entry);
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
