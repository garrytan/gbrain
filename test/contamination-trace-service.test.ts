import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { MemoryCandidateCreateStatus, MemoryCandidateEntryInput } from '../src/core/types.ts';
import {
  advanceMemoryCandidateStatus,
  verifyMemoryCandidateEntry,
} from '../src/core/services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../src/core/services/memory-inbox-promotion-service.ts';
import { completeCanonicalHandoff, recordCanonicalHandoff } from '../src/core/services/canonical-handoff-service.ts';
import {
  ContaminationTraceServiceError,
  contaminationRefMatchesSlug,
  traceMemoryContamination,
} from '../src/core/services/contamination-trace-service.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

const SLUG = 'systems/ingest-worker';
const SCOPE_ID = 'workspace:default';
const WRITE_AT = '2026-07-01T00:00:00.000Z';
const FUTURE_UNTIL = new Date(Date.now() + 60_000);

async function withEngine<T>(label: string, fn: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-contamination-trace-${label}-`));
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    return await fn(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function seedCandidate(
  engine: SQLiteEngine,
  id: string,
  status: MemoryCandidateCreateStatus = 'candidate',
  overrides: Partial<MemoryCandidateEntryInput> = {},
) {
  return engine.createMemoryCandidateEntry({
    id,
    scope_id: SCOPE_ID,
    candidate_type: 'fact',
    proposed_content: 'The ingest worker retries failed chunks twice before flagging.',
    source_refs: ['Agent session transcript, 2026-06-30 10:00 AM KST'],
    generated_by: 'agent',
    extraction_kind: 'extracted',
    confidence_score: 0.8,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status,
    target_object_type: 'curated_note',
    target_object_id: SLUG,
    ...overrides,
  });
}

// Full loop: candidate created -> promoted -> page written (handoff + ledger),
// refuted post-promotion, then a retrieval trace consumed the page and a
// downstream page cited it.
async function seedContaminationScenario(engine: SQLiteEngine, candidateId: string) {
  await seedCandidate(engine, candidateId);
  await advanceMemoryCandidateStatus(engine, {
    id: candidateId,
    next_status: 'staged_for_review',
    review_reason: 'Prepared for promotion.',
  });
  await verifyMemoryCandidateEntry(engine, {
    id: candidateId,
    verification_status: 'verified',
    verification_method: 'file_inspection',
    verification_evidence: 'Read src/worker/ingest.ts; retry loop caps at 2 attempts.',
  });
  await promoteMemoryCandidateEntry(engine, {
    id: candidateId,
    review_reason: 'Promoted for contamination-trace test.',
  });

  const { handoff } = await recordCanonicalHandoff(engine, {
    candidate_id: candidateId,
    review_reason: 'Canonical handoff for contamination-trace test.',
  });
  await engine.putPage(SLUG, {
    type: 'system',
    title: 'Ingest Worker',
    compiled_truth: 'The ingest worker retries failed chunks twice before flagging. [Source: Agent session transcript, 2026-06-30 10:00 AM KST]',
    timeline: `- **2026-07-01** | Compiled from Memory Inbox candidate. [Source: memory_candidate:${candidateId}]`,
  });
  await completeCanonicalHandoff(engine, {
    id: handoff.id,
    completed_at: WRITE_AT,
    completion_kind: 'page_written',
    completion_ref: SLUG,
  });
  await engine.createMemoryMutationEvent({
    id: `event:write:${candidateId}`,
    session_id: 'session:contamination-test',
    realm_id: 'realm:contamination-test',
    actor: 'agent:test',
    operation: 'put_page',
    target_kind: 'page',
    target_id: SLUG,
    scope_id: SCOPE_ID,
    source_refs: [`memory_candidate:${candidateId}`],
    result: 'applied',
    applied_at: WRITE_AT,
  });

  // Post-promotion refutation (GV-10 correction lane).
  await verifyMemoryCandidateEntry(engine, {
    id: candidateId,
    verification_status: 'refuted',
    verification_method: 'command_execution',
    verification_evidence: 'Ran the worker locally; failed chunks are retried three times, not twice.',
  });

  // A read consumed the contaminated page after the write.
  const trace = await engine.putRetrievalTrace({
    id: 'trace:contam-read-1',
    task_id: null,
    scope: 'work',
    route: ['read_context'],
    source_refs: [`page:${SCOPE_ID}:${SLUG}`],
    verification: ['answer_ready:ready', 'scenario:project_qa'],
    write_outcome: 'no_durable_write',
    outcome: 'read_context returned canonical evidence',
  });

  // One-hop downstream: another page write cites the contaminated page.
  await engine.createMemoryMutationEvent({
    id: `event:downstream:${candidateId}`,
    session_id: 'session:contamination-test',
    realm_id: 'realm:contamination-test',
    actor: 'agent:test',
    operation: 'put_page',
    target_kind: 'page',
    target_id: 'concepts/retry-policy',
    scope_id: SCOPE_ID,
    source_refs: [`page:${SCOPE_ID}:${SLUG}`],
    result: 'applied',
  });

  return { handoff, trace };
}

test('traces contamination from a refuted promoted candidate to pages, traces, and downstream writes', async () => {
  await withEngine('full-loop', async (engine) => {
    const candidateId = 'cand:contam-1';
    const { handoff, trace } = await seedContaminationScenario(engine, candidateId);

    const result = await traceMemoryContamination(engine, {
      candidate_id: candidateId,
      until: FUTURE_UNTIL,
    });

    expect(result.subject).toMatchObject({
      kind: 'candidate',
      candidate_id: candidateId,
      verification_status: 'refuted',
      refuted: true,
    });

    expect(result.contaminated_pages).toHaveLength(1);
    const page = result.contaminated_pages[0]!;
    expect(page.slug).toBe(SLUG);
    expect(page.via).toContain('canonical_handoff');
    expect(page.via).toContain('mutation_event');
    expect(page.refs).toContain(`canonical_handoff:${handoff.id}`);
    expect(page.refs).toContain(`ledger_event:event:write:${candidateId}`);
    expect(page.first_written_at).toBe(WRITE_AT);

    expect(result.consuming_traces).toHaveLength(1);
    expect(result.consuming_traces[0]).toMatchObject({
      trace_id: trace.id,
      task_id: null,
      route_kind: 'read_context',
      scenario: 'project_qa',
      matched_slugs: [SLUG],
    });

    expect(result.downstream_pages).toHaveLength(1);
    expect(result.downstream_pages[0]).toMatchObject({
      slug: 'concepts/retry-policy',
      via: ['mutation_event'],
      refs: [`ledger_event:event:downstream:${candidateId}`],
    });

    expect(result.summary.contaminated_page_count).toBe(1);
    expect(result.summary.consuming_trace_count).toBe(1);
    expect(result.summary.downstream_page_count).toBe(1);
    expect(result.summary.next_actions.some((action) => action.includes('reverify_code_claims') && action.includes(SLUG))).toBe(true);
    expect(result.summary.next_actions.some((action) => action.includes(`supersede_memory_candidate_entry ${candidateId}`))).toBe(true);
    expect(result.summary.next_actions.some((action) => action.includes('concepts/retry-policy'))).toBe(true);
    expect(result.summary.notes).toEqual([]);
  });
});

test('detects contamination through patch candidates citing memory_candidate refs', async () => {
  await withEngine('patch-lane', async (engine) => {
    const candidateId = 'cand:contam-patch';
    await seedCandidate(engine, candidateId);
    await engine.createMemoryCandidateEntry({
      id: 'patch:contam-1',
      scope_id: SCOPE_ID,
      candidate_type: 'note_update',
      proposed_content: 'Canonical patch derived from the contaminated candidate.',
      source_refs: [`memory_candidate:${candidateId}`],
      generated_by: 'agent',
      extraction_kind: 'extracted',
      confidence_score: 0.8,
      importance_score: 0.5,
      recurrence_score: 0.1,
      sensitivity: 'work',
      status: 'staged_for_review',
      patch_target_kind: 'page',
      patch_target_id: SLUG,
      patch_body: { compiled_truth: 'updated' },
      patch_format: 'merge_patch',
      patch_operation_state: 'proposed',
    });

    const result = await traceMemoryContamination(engine, {
      candidate_id: candidateId,
      until: FUTURE_UNTIL,
    });

    expect(result.contaminated_pages).toHaveLength(1);
    expect(result.contaminated_pages[0]).toMatchObject({
      slug: SLUG,
      via: ['patch_candidate'],
      refs: ['memory_patch_candidate:patch:contam-1'],
      first_written_at: null,
    });
  });
});

test('reports nothing to contaminate and an informational note for an unrefuted candidate without writes', async () => {
  await withEngine('no-writes', async (engine) => {
    await seedCandidate(engine, 'cand:no-writes');

    const result = await traceMemoryContamination(engine, { candidate_id: 'cand:no-writes' });

    expect(result.subject.refuted).toBe(false);
    expect(result.contaminated_pages).toEqual([]);
    expect(result.consuming_traces).toEqual([]);
    expect(result.downstream_pages).toEqual([]);
    expect(result.summary.next_actions).toEqual([]);
    expect(result.summary.notes.some((note) => note.includes('not refuted'))).toBe(true);
    expect(result.summary.notes.some((note) => note.includes('nothing to contaminate'))).toBe(true);
  });
});

test('slug mode traces consuming reads and downstream writes for a page', async () => {
  await withEngine('slug-mode', async (engine) => {
    const candidateId = 'cand:contam-slug';
    await seedContaminationScenario(engine, candidateId);

    const result = await traceMemoryContamination(engine, {
      slug: SLUG,
      until: FUTURE_UNTIL,
    });

    expect(result.subject).toMatchObject({ kind: 'page', slug: SLUG, refuted: false });
    expect(result.contaminated_pages).toEqual([
      { slug: SLUG, via: ['input_slug'], refs: [], first_written_at: null },
    ]);
    expect(result.consuming_traces.map((trace) => trace.trace_id)).toEqual(['trace:contam-read-1']);
    expect(result.downstream_pages.map((page) => page.slug)).toEqual(['concepts/retry-policy']);
  });
});

test('validates input and surfaces missing candidates', async () => {
  await withEngine('validation', async (engine) => {
    await expect(traceMemoryContamination(engine, {})).rejects.toThrow(ContaminationTraceServiceError);
    await expect(traceMemoryContamination(engine, { candidate_id: 'x', slug: 'y' }))
      .rejects.toThrow(/not both/);
    await expect(traceMemoryContamination(engine, { candidate_id: 'cand:missing' }))
      .rejects.toThrow(/not found/);
    await expect(traceMemoryContamination(engine, { slug: SLUG, limit: -1 }))
      .rejects.toThrow(/limit/);
  });
});

test('selector-style source refs match page slugs without false positives', () => {
  expect(contaminationRefMatchesSlug(`page:${SCOPE_ID}:${SLUG}`, SLUG)).toBe(true);
  expect(contaminationRefMatchesSlug(`compiled_truth:${SCOPE_ID}:${SLUG}`, SLUG)).toBe(true);
  expect(contaminationRefMatchesSlug(`line_span:${SCOPE_ID}:${SLUG}:1:12`, SLUG)).toBe(true);
  expect(contaminationRefMatchesSlug(`page:${SCOPE_ID}:${SLUG}@chars:0:20`, SLUG)).toBe(true);
  expect(contaminationRefMatchesSlug(SLUG, SLUG)).toBe(true);
  expect(contaminationRefMatchesSlug(`page:${SLUG}`, SLUG)).toBe(true);
  expect(contaminationRefMatchesSlug(`page:${SCOPE_ID}:${SLUG}-legacy`, SLUG)).toBe(false);
  expect(contaminationRefMatchesSlug(`page:${SCOPE_ID}:systems/ingest`, SLUG)).toBe(false);
  expect(contaminationRefMatchesSlug(`page:${SCOPE_ID}:other/ingest-worker`, SLUG)).toBe(false);
});

test('trace_memory_contamination operation is registered as a read-only analysis surface', async () => {
  const operation = operations.find((entry) => entry.name === 'trace_memory_contamination');
  expect(operation).toBeDefined();
  expect(operation?.mutating).not.toBe(true);
  expect(operation?.cliHints?.name).toBe('trace-memory-contamination');

  await withEngine('operation', async (engine) => {
    const candidateId = 'cand:contam-op';
    await seedContaminationScenario(engine, candidateId);
    const ctx = { engine, config: {} as never, logger: console, dryRun: false };

    const result = await operation!.handler(ctx as never, {
      candidate_id: candidateId,
      until: FUTURE_UNTIL.toISOString(),
    }) as Awaited<ReturnType<typeof traceMemoryContamination>>;

    expect(result.subject.refuted).toBe(true);
    expect(result.contaminated_pages.map((page) => page.slug)).toEqual([SLUG]);
    expect(result.consuming_traces).toHaveLength(1);

    await expect(operation!.handler(ctx as never, {})).rejects.toThrow(/candidate_id or slug/);
    await expect(operation!.handler(ctx as never, { candidate_id: 'cand:absent' }))
      .rejects.toThrow(/not found/);
  });
});
