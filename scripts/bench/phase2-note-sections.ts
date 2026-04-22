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
} from '../../src/core/services/note-manifest-service.ts';
import {
  NOTE_SECTION_EXTRACTOR_VERSION,
  rebuildNoteSectionEntries,
} from '../../src/core/services/note-section-service.ts';

type Phase2SectionLatencyWorkloadName = 'section_get' | 'section_list' | 'section_rebuild';

type Phase2SectionWorkloadResult =
  | {
      name: Phase2SectionLatencyWorkloadName;
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'section_projection';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase2SectionAcceptanceCheck {
  name:
    | 'section_get_p95_ms'
    | 'section_list_p95_ms'
    | 'section_rebuild_p95_ms'
    | 'section_projection_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

interface ExpectedSection {
  section_id: string;
  parent_section_id: string | null;
  heading_text: string;
  heading_path: string[];
  outgoing_urls: string[];
  source_refs: string[];
}

interface Fixture {
  slug: string;
  path: string;
  content: string;
  expected: ExpectedSection[];
}

const PHASE2_SECTION_ACCEPTANCE_THRESHOLDS = {
  section_get_p95_ms_max: 100,
  section_list_p95_ms_max: 100,
  section_rebuild_p95_ms_max: 150,
  section_projection_success_rate: 100,
} as const;

const PHASE2_SECTION_SAMPLE_COUNT = 5;

const PHASE2_SECTION_FIXTURES: Fixture[] = [
  {
    slug: 'systems/mbrain',
    path: 'systems/mbrain.md',
    content: [
      '---',
      'type: system',
      'title: MBrain System',
      'tags: [phase2, sections]',
      'aliases: [MBrain Core]',
      '---',
      '# Overview',
      'Links to [[concepts/note-manifest]].',
      '[Source: User, direct message, 2026-04-20 09:00 AM KST]',
      '',
      '## Runtime',
      'Docs: https://example.com/mbrain/runtime.',
      '',
      '### Explainability',
      'Explains retrieved paths.',
      '',
    ].join('\n'),
    expected: [
      {
        section_id: 'systems/mbrain#overview',
        parent_section_id: null,
        heading_text: 'Overview',
        heading_path: ['overview'],
        outgoing_urls: [],
        source_refs: ['User, direct message, 2026-04-20 09:00 AM KST'],
      },
      {
        section_id: 'systems/mbrain#overview/runtime',
        parent_section_id: 'systems/mbrain#overview',
        heading_text: 'Runtime',
        heading_path: ['overview', 'runtime'],
        outgoing_urls: ['https://example.com/mbrain/runtime'],
        source_refs: [],
      },
      {
        section_id: 'systems/mbrain#overview/runtime/explainability',
        parent_section_id: 'systems/mbrain#overview/runtime',
        heading_text: 'Explainability',
        heading_path: ['overview', 'runtime', 'explainability'],
        outgoing_urls: [],
        source_refs: [],
      },
    ],
  },
  {
    slug: 'concepts/note-manifest',
    path: 'concepts/note-manifest.md',
    content: [
      '---',
      'type: concept',
      'title: Note Manifest',
      'tags: [phase2, sections]',
      'aliases: [Structural Index]',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
      '[Source: User, direct message, 2026-04-20 09:05 AM KST]',
      '',
      '## Inputs',
      'Review https://example.com/specs/manifest.',
      '',
    ].join('\n'),
    expected: [
      {
        section_id: 'concepts/note-manifest#purpose',
        parent_section_id: null,
        heading_text: 'Purpose',
        heading_path: ['purpose'],
        outgoing_urls: [],
        source_refs: ['User, direct message, 2026-04-20 09:05 AM KST'],
      },
      {
        section_id: 'concepts/note-manifest#purpose/inputs',
        parent_section_id: 'concepts/note-manifest#purpose',
        heading_text: 'Inputs',
        heading_path: ['purpose', 'inputs'],
        outgoing_urls: ['https://example.com/specs/manifest'],
        source_refs: [],
      },
    ],
  },
];

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase2-note-sections.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase2-sections-'));
const databasePath = join(tempDir, 'phase2-sections.db');

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

  const workloads: Phase2SectionWorkloadResult[] = [
    await runLatencyWorkload(engine, 'section_get'),
    await runLatencyWorkload(engine, 'section_list'),
    await runLatencyWorkload(engine, 'section_rebuild'),
    await runProjectionWorkload(engine),
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
    console.log(`Phase 2 note-sections benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) {
    await engine.disconnect();
  }
  rmSync(tempDir, { recursive: true, force: true });
}

async function seedFixtures(engine: BrainEngine): Promise<void> {
  for (const fixture of PHASE2_SECTION_FIXTURES) {
    const result = await importFromContent(engine, fixture.slug, fixture.content, { path: fixture.path });
    if (result.status !== 'imported') {
      throw new Error(`Failed to seed fixture ${fixture.slug}: ${result.error ?? result.status}`);
    }
  }
}

async function runLatencyWorkload(
  engine: BrainEngine,
  name: Phase2SectionLatencyWorkloadName,
): Promise<Extract<Phase2SectionWorkloadResult, { name: Phase2SectionLatencyWorkloadName }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < PHASE2_SECTION_SAMPLE_COUNT; sample += 1) {
    if (name === 'section_get') {
      for (const fixture of PHASE2_SECTION_FIXTURES) {
        for (const expected of fixture.expected) {
          const start = performance.now();
          await engine.getNoteSectionEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, expected.section_id);
          durations.push(performance.now() - start);
        }
      }
      continue;
    }

    if (name === 'section_list') {
      for (const fixture of PHASE2_SECTION_FIXTURES) {
        const start = performance.now();
        await engine.listNoteSectionEntries({
          scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
          page_slug: fixture.slug,
          limit: fixture.expected.length,
        });
        durations.push(performance.now() - start);
      }
      continue;
    }

    const start = performance.now();
    await rebuildNoteSectionEntries(engine, { scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID });
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

async function runProjectionWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase2SectionWorkloadResult, { name: 'section_projection' }>> {
  let passed = 0;

  for (const fixture of PHASE2_SECTION_FIXTURES) {
    const entries = await engine.listNoteSectionEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      page_slug: fixture.slug,
      limit: fixture.expected.length,
    });

    const matches =
      entries.length === fixture.expected.length &&
      entries.every((entry, index) => matchesExpectedSection(entry, fixture.expected[index]!));

    if (matches) {
      passed += 1;
    }
  }

  return {
    name: 'section_projection',
    status: 'measured',
    unit: 'percent',
    success_rate: roundTo((passed / PHASE2_SECTION_FIXTURES.length) * 100, 2),
  };
}

function matchesExpectedSection(
  entry: Awaited<ReturnType<BrainEngine['listNoteSectionEntries']>>[number],
  expected: ExpectedSection,
): boolean {
  return (
    entry.extractor_version === NOTE_SECTION_EXTRACTOR_VERSION &&
    entry.section_id === expected.section_id &&
    entry.parent_section_id === expected.parent_section_id &&
    entry.heading_text === expected.heading_text &&
    hasExactItems(entry.heading_path, expected.heading_path) &&
    hasExactItems(entry.outgoing_urls, expected.outgoing_urls) &&
    hasExactItems(entry.source_refs, expected.source_refs)
  );
}

function evaluateAcceptance(workloads: Phase2SectionWorkloadResult[]) {
  const checks: Phase2SectionAcceptanceCheck[] = [];

  const sectionGet = getLatencyWorkload(workloads, 'section_get');
  checks.push({
    name: 'section_get_p95_ms',
    status: sectionGet.p95_ms <= PHASE2_SECTION_ACCEPTANCE_THRESHOLDS.section_get_p95_ms_max ? 'pass' : 'fail',
    actual: sectionGet.p95_ms,
    threshold: {
      operator: '<=',
      value: PHASE2_SECTION_ACCEPTANCE_THRESHOLDS.section_get_p95_ms_max,
      unit: 'ms',
    },
  });

  const sectionList = getLatencyWorkload(workloads, 'section_list');
  checks.push({
    name: 'section_list_p95_ms',
    status: sectionList.p95_ms <= PHASE2_SECTION_ACCEPTANCE_THRESHOLDS.section_list_p95_ms_max ? 'pass' : 'fail',
    actual: sectionList.p95_ms,
    threshold: {
      operator: '<=',
      value: PHASE2_SECTION_ACCEPTANCE_THRESHOLDS.section_list_p95_ms_max,
      unit: 'ms',
    },
  });

  const sectionRebuild = getLatencyWorkload(workloads, 'section_rebuild');
  checks.push({
    name: 'section_rebuild_p95_ms',
    status: sectionRebuild.p95_ms <= PHASE2_SECTION_ACCEPTANCE_THRESHOLDS.section_rebuild_p95_ms_max ? 'pass' : 'fail',
    actual: sectionRebuild.p95_ms,
    threshold: {
      operator: '<=',
      value: PHASE2_SECTION_ACCEPTANCE_THRESHOLDS.section_rebuild_p95_ms_max,
      unit: 'ms',
    },
  });

  const projection = getCorrectnessWorkload(workloads, 'section_projection');
  checks.push({
    name: 'section_projection_success_rate',
    status: projection.success_rate === PHASE2_SECTION_ACCEPTANCE_THRESHOLDS.section_projection_success_rate
      ? 'pass'
      : 'fail',
    actual: projection.success_rate,
    threshold: {
      operator: '===',
      value: PHASE2_SECTION_ACCEPTANCE_THRESHOLDS.section_projection_success_rate,
      unit: 'percent',
    },
  });

  const readiness_status = checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';
  const phase2_status = readiness_status;

  return {
    thresholds: PHASE2_SECTION_ACCEPTANCE_THRESHOLDS,
    readiness_status,
    phase2_status,
    checks,
    summary: readiness_status === 'pass'
      ? 'Phase 2 note-sections workloads pass the local guardrails.'
      : 'Phase 2 note-sections workloads failed one or more local guardrails.',
  };
}

function getLatencyWorkload(
  workloads: Phase2SectionWorkloadResult[],
  name: Phase2SectionLatencyWorkloadName,
): Extract<Phase2SectionWorkloadResult, { name: Phase2SectionLatencyWorkloadName }> {
  const workload = workloads.find((entry) => entry.name === name);
  if (!workload || workload.unit !== 'ms') {
    throw new Error(`Missing latency workload: ${name}`);
  }
  return workload;
}

function getCorrectnessWorkload(
  workloads: Phase2SectionWorkloadResult[],
  name: 'section_projection',
): Extract<Phase2SectionWorkloadResult, { name: 'section_projection' }> {
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
  const sorted = [...values].sort((left, right) => left - right);
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
