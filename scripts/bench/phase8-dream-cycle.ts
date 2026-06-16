#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  advanceMemoryCandidateStatus,
  verifyMemoryCandidateEntry,
} from '../../src/core/services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../../src/core/services/memory-inbox-promotion-service.ts';
import { recordCanonicalHandoff } from '../../src/core/services/canonical-handoff-service.ts';
import { runDreamCycleMaintenance } from '../../src/core/services/dream-cycle-maintenance-service.ts';

const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase8-dream-cycle.ts [--json]');
  process.exit(0);
}

const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase8-dream-cycle-'));
const databasePath = join(tempDir, 'phase8-dream-cycle.db');
let engine: BrainEngine | null = null;

try {
  const config = createLocalConfigDefaults({
    database_path: databasePath,
    embedding_provider: 'none',
    query_rewrite_provider: 'none',
  });

  engine = await createConnectedEngine(config);
  await engine.initSchema();
  await seedDreamCycleFixtures(engine);

  const correctness = await runCandidateOnlyWorkload(engine);
  const measured = await runMeasuredWorkload(engine);
  const workloads = [correctness, measured];
  const allPass = workloads.every((workload) => workload.success_rate === 100);

  const payload = {
    generated_at: new Date().toISOString(),
    engine: config.engine,
    phase: 'phase8',
    workloads,
    acceptance: {
      readiness_status: allPass ? 'pass' : 'fail',
      phase8_status: allPass ? 'pass' : 'fail',
      summary: allPass
        ? 'Phase 8 dream-cycle maintenance stayed candidate-only and bounded.'
        : 'Phase 8 dream-cycle maintenance failed its candidate-only guardrail.',
    },
  };

  console.log(JSON.stringify(payload, null, 2));

  if (!allPass) {
    process.exit(1);
  }
} finally {
  if (engine) {
    await engine.disconnect();
  }
  rmSync(tempDir, { recursive: true, force: true });
}

async function runCandidateOnlyWorkload(engine: BrainEngine) {
  const result = await runDreamCycleMaintenance(engine, {
    scope_id: 'workspace:default',
    now: new Date('2026-04-23T12:00:00.000Z'),
    limit: 3,
    write_candidates: true,
  });
  const stored = await Promise.all(
    result.suggestions.map((suggestion) => engine.getMemoryCandidateEntry(suggestion.candidate_id ?? '')),
  );
  const expectedTypes = ['duplicate_merge', 'recap', 'stale_claim_challenge'];
  const passed = result.suggestions.length === 3
    && result.suggestions.map((suggestion) => suggestion.suggestion_type).sort().join(',') === expectedTypes.join(',')
    && stored.every((entry) => entry?.generated_by === 'dream_cycle' && entry.status === 'candidate');

  return {
    name: 'dream_cycle_candidate_only',
    status: 'measured',
    unit: 'percent',
    success_rate: passed ? 100 : 0,
  };
}

async function runMeasuredWorkload(engine: BrainEngine) {
  const startedAt = performance.now();
  const result = await runDreamCycleMaintenance(engine, {
    scope_id: 'workspace:default',
    now: new Date('2026-04-23T12:00:00.000Z'),
    limit: 1,
    write_candidates: false,
  });
  const elapsedMs = Math.max(0.001, Number((performance.now() - startedAt).toFixed(3)));

  return {
    name: 'dream_cycle',
    status: 'measured',
    unit: 'ms',
    p50_ms: elapsedMs,
    p95_ms: elapsedMs,
    success_rate: result.suggestions.length === 1 && result.suggestions[0]?.candidate_id === null ? 100 : 0,
  };
}

async function seedDreamCycleFixtures(engine: BrainEngine) {
  await seedCandidate(engine, {
    id: 'bench-dup-a',
    proposed_content: 'Duplicate maintenance claim.',
    source_refs: ['bench:a'],
    recurrence_score: 0.3,
  });
  await seedCandidate(engine, {
    id: 'bench-dup-b',
    proposed_content: ' duplicate   maintenance claim. ',
    source_refs: ['bench:b'],
    recurrence_score: 0.2,
  });
  await seedStalePromotedCandidate(engine, 'bench-stale');
}

async function seedCandidate(
  engine: BrainEngine,
  input: {
    id: string;
    proposed_content: string;
    source_refs: string[];
    recurrence_score: number;
  },
) {
  await engine.createMemoryCandidateEntry({
    id: input.id,
    scope_id: 'workspace:default',
    candidate_type: 'note_update',
    proposed_content: input.proposed_content,
    source_refs: input.source_refs,
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.75,
    importance_score: 0.7,
    recurrence_score: input.recurrence_score,
    sensitivity: 'work',
    status: 'candidate',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/dream-cycle',
    reviewed_at: null,
    review_reason: null,
  });
}

async function seedStalePromotedCandidate(engine: BrainEngine, id: string) {
  await engine.createMemoryCandidateEntry({
    id,
    scope_id: 'workspace:default',
    candidate_type: 'note_update',
    proposed_content: 'A stale promoted maintenance claim.',
    source_refs: ['bench:stale'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.8,
    importance_score: 0.8,
    recurrence_score: 0.2,
    sensitivity: 'work',
    status: 'candidate',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/dream-cycle',
    reviewed_at: null,
    review_reason: null,
  });
  await advanceMemoryCandidateStatus(engine, { id, next_status: 'staged_for_review' });
  await verifyMemoryCandidateEntry(engine, {
    id,
    verification_status: 'verified',
    verification_method: 'source_recheck',
    verification_evidence: `Verified dream-cycle benchmark fixture ${id}.`,
    verification_source_refs: [`Fixture verification for ${id}`],
    verified_at: '2026-06-16T00:00:00Z',
  });
  await promoteMemoryCandidateEntry(engine, {
    id,
    reviewed_at: '2026-02-01T10:00:00.000Z',
    review_reason: 'Promoted before the review window.',
  });
  await recordCanonicalHandoff(engine, {
    candidate_id: id,
    reviewed_at: '2026-02-01T10:05:00.000Z',
  });
}
