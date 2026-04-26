import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

interface EngineHarness {
  label: string;
  engine: BrainEngine;
  reopen: () => Promise<BrainEngine>;
  cleanup: () => Promise<void>;
}

const ENGINE_COLD_START_BUDGET_MS = 30_000;

async function createSqliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-sqlite-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  return {
    label: 'sqlite',
    engine,
    reopen: async () => {
      const reopened = new SQLiteEngine();
      await reopened.connect({ engine: 'sqlite', database_path: databasePath });
      await reopened.initSchema();
      return reopened;
    },
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-pglite-'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dir });
  await engine.initSchema();

  return {
    label: 'pglite',
    engine,
    reopen: async () => {
      const reopened = new PGLiteEngine();
      await reopened.connect({ engine: 'pglite', database_path: dir });
      await reopened.initSchema();
      return reopened;
    },
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedMemoryCandidate(engine: BrainEngine, id: string, scopeId: string) {
  return engine.createMemoryCandidateEntry({
    id,
    scope_id: scopeId,
    candidate_type: 'fact',
    proposed_content: 'Context maps can propose a note update candidate.',
    source_refs: ['User, direct message, 2026-04-22 3:01 PM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.95,
    importance_score: 0.8,
    recurrence_score: 0.2,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/note-manifest',
    reviewed_at: null,
    review_reason: null,
  });
}

async function expectMemoryCandidate(engine: BrainEngine, id: string, scopeId: string) {
  const entry = await engine.getMemoryCandidateEntry(id);
  const entries = await engine.listMemoryCandidateEntries({
    scope_id: scopeId,
    limit: 10,
  });

  expect(entry).not.toBeNull();
  expect(entry?.scope_id).toBe(scopeId);
  expect(entry?.candidate_type).toBe('fact');
  expect(entry?.generated_by).toBe('manual');
  expect(entry?.extraction_kind).toBe('manual');
  expect(entry?.sensitivity).toBe('work');
  expect(entry?.status).toBe('captured');
  expect(entry?.source_refs).toEqual(['User, direct message, 2026-04-22 3:01 PM KST']);
  expect(entries.map((candidate) => candidate.id)).toContain(id);
}

async function seedPatchCandidate(engine: BrainEngine, id: string, scopeId: string) {
  return engine.createMemoryCandidateEntry({
    id,
    scope_id: scopeId,
    candidate_type: 'note_update',
    proposed_content: 'Patch candidate proposes a reviewable canonical note update.',
    source_refs: ['User, direct message, 2026-04-26 11:00 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.91,
    importance_score: 0.74,
    recurrence_score: 0.12,
    sensitivity: 'work',
    status: 'staged_for_review',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/patch-target',
    reviewed_at: null,
    review_reason: 'Patch candidate staged for review.',
    patch_target_kind: 'page',
    patch_target_id: 'concepts/patch-target',
    patch_base_target_snapshot_hash: 'a'.repeat(64),
    patch_body: {
      compiled_truth: 'Updated compiled truth from a reviewable patch.',
    },
    patch_format: 'merge_patch',
    patch_operation_state: 'proposed',
    patch_risk_class: 'medium',
    patch_expected_resulting_target_snapshot_hash: 'b'.repeat(64),
    patch_provenance_summary: 'User explicitly requested the canonical note update.',
    patch_actor: 'agent:memory-reviewer',
    patch_originating_session_id: 'session:patch-review',
    patch_ledger_event_ids: ['ledger:patch-candidate-created'],
  } as any);
}

async function expectPatchCandidate(engine: BrainEngine, id: string, scopeId: string) {
  const entry = await engine.getMemoryCandidateEntry(id) as any;
  expect(entry).not.toBeNull();
  expect(entry.scope_id).toBe(scopeId);
  expect(entry.status).toBe('staged_for_review');
  expect(entry.patch_target_kind).toBe('page');
  expect(entry.patch_target_id).toBe('concepts/patch-target');
  expect(entry.patch_base_target_snapshot_hash).toBe('a'.repeat(64));
  expect(entry.patch_body).toEqual({
    compiled_truth: 'Updated compiled truth from a reviewable patch.',
  });
  expect(entry.patch_format).toBe('merge_patch');
  expect(entry.patch_operation_state).toBe('proposed');
  expect(entry.patch_risk_class).toBe('medium');
  expect(entry.patch_expected_resulting_target_snapshot_hash).toBe('b'.repeat(64));
  expect(entry.patch_provenance_summary).toBe('User explicitly requested the canonical note update.');
  expect(entry.patch_actor).toBe('agent:memory-reviewer');
  expect(entry.patch_originating_session_id).toBe('session:patch-review');
  expect(entry.patch_ledger_event_ids).toEqual(['ledger:patch-candidate-created']);

  const filtered = await engine.listMemoryCandidateEntries({
    scope_id: scopeId,
    patch_operation_state: 'proposed',
    patch_target_kind: 'page',
    patch_target_id: 'concepts/patch-target',
    limit: 10,
  } as any);
  expect(filtered.map((candidate) => candidate.id)).toEqual([id]);
}

let statusEventCounter = 0;

function nextStatusEventPrefix(label: string): string {
  statusEventCounter += 1;
  return `memory-candidate-status-event:${label}:${Date.now()}:${statusEventCounter}`;
}

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((row) => row.id);
}

async function expectMemoryCandidateStatusEventEngine(engine: BrainEngine, prefix: string) {
  const scopeId = `${prefix}:scope`;
  const otherScopeId = `${prefix}:other-scope`;
  const candidateA = `${prefix}:candidate-a`;
  const candidateB = `${prefix}:candidate-b`;
  const candidateC = `${prefix}:candidate-c`;
  const candidateD = `${prefix}:candidate-d`;
  const traceA = `${prefix}:interaction-a`;
  const traceB = `${prefix}:interaction-b`;
  const traceSort = `${prefix}:interaction-sort`;
  const eventCreated = `${prefix}:event-created`;
  const eventAdvanced = `${prefix}:event-advanced`;
  const eventRejected = `${prefix}:event-rejected`;
  const eventPromotedOtherScope = `${prefix}:event-promoted-other-scope`;
  const eventSameA = `${prefix}:event-same-a`;
  const eventSameB = `${prefix}:event-same-b`;

  const created = await engine.createMemoryCandidateStatusEvent({
    id: eventCreated,
    candidate_id: candidateA,
    scope_id: scopeId,
    from_status: null,
    to_status: 'captured',
    event_kind: 'created',
    interaction_id: traceA,
    reviewed_at: null,
    review_reason: null,
    created_at: new Date('2026-04-22T06:00:00.000Z'),
  });
  expect(created.id).toBe(eventCreated);
  expect(created.from_status).toBeNull();
  expect(created.to_status).toBe('captured');
  expect(created.event_kind).toBe('created');
  expect(created.interaction_id).toBe(traceA);
  expect(created.reviewed_at).toBeNull();
  expect(created.created_at.toISOString()).toBe('2026-04-22T06:00:00.000Z');

  const advanced = await engine.createMemoryCandidateStatusEvent({
    id: eventAdvanced,
    candidate_id: candidateA,
    scope_id: scopeId,
    from_status: 'captured',
    to_status: 'candidate',
    event_kind: 'advanced',
    interaction_id: traceB,
    reviewed_at: '2026-04-22T06:04:00.000Z',
    review_reason: 'Advanced into candidate queue.',
    created_at: new Date('2026-04-22T06:05:00.000Z'),
  });
  expect(advanced.reviewed_at?.toISOString()).toBe('2026-04-22T06:04:00.000Z');
  expect(advanced.review_reason).toBe('Advanced into candidate queue.');

  const rejected = await engine.createMemoryCandidateStatusEvent({
    id: eventRejected,
    candidate_id: candidateB,
    scope_id: scopeId,
    from_status: 'staged_for_review',
    to_status: 'rejected',
    event_kind: 'rejected',
    interaction_id: traceA,
    reviewed_at: new Date('2026-04-22T06:09:00.000Z'),
    review_reason: 'Rejected during explicit review.',
    created_at: new Date('2026-04-22T06:10:00.000Z'),
  });
  expect(rejected.reviewed_at?.toISOString()).toBe('2026-04-22T06:09:00.000Z');

  await engine.createMemoryCandidateStatusEvent({
    id: eventPromotedOtherScope,
    candidate_id: candidateC,
    scope_id: otherScopeId,
    from_status: 'staged_for_review',
    to_status: 'promoted',
    event_kind: 'promoted',
    interaction_id: null,
    reviewed_at: null,
    review_reason: 'Promoted outside the default scope.',
    created_at: new Date('2026-04-22T06:15:00.000Z'),
  });

  await engine.createMemoryCandidateStatusEvent({
    id: eventSameA,
    candidate_id: candidateD,
    scope_id: scopeId,
    from_status: 'candidate',
    to_status: 'staged_for_review',
    event_kind: 'advanced',
    interaction_id: traceSort,
    reviewed_at: null,
    review_reason: null,
    created_at: new Date('2026-04-22T06:20:00.000Z'),
  });
  await engine.createMemoryCandidateStatusEvent({
    id: eventSameB,
    candidate_id: candidateD,
    scope_id: scopeId,
    from_status: 'staged_for_review',
    to_status: 'promoted',
    event_kind: 'promoted',
    interaction_id: traceSort,
    reviewed_at: null,
    review_reason: null,
    created_at: new Date('2026-04-22T06:20:00.000Z'),
  });

  const beforeDefaultCreate = Date.now();
  const defaultTimestampEvent = await engine.createMemoryCandidateStatusEvent({
    id: `${prefix}:event-default-created-at`,
    candidate_id: `${prefix}:candidate-default-created-at`,
    scope_id: `${prefix}:clock-scope`,
    from_status: null,
    to_status: 'captured',
    event_kind: 'created',
    interaction_id: null,
    reviewed_at: null,
    review_reason: null,
    created_at: null,
  });
  const afterDefaultCreate = Date.now();
  expect(defaultTimestampEvent.created_at.getTime()).toBeGreaterThanOrEqual(beforeDefaultCreate - 1_000);
  expect(defaultTimestampEvent.created_at.getTime()).toBeLessThanOrEqual(afterDefaultCreate + 1_000);

  await expect(engine.createMemoryCandidateStatusEvent({
    id: `${prefix}:event-invalid-kind-status`,
    candidate_id: `${prefix}:candidate-invalid-kind-status`,
    scope_id: scopeId,
    from_status: 'staged_for_review',
    to_status: 'captured',
    event_kind: 'promoted',
    interaction_id: null,
  })).rejects.toThrow(/Invalid memory candidate status event/);
  await expect(engine.createMemoryCandidateStatusEvent({
    id: `${prefix}:event-invalid-created-final-status`,
    candidate_id: `${prefix}:candidate-invalid-created-final-status`,
    scope_id: scopeId,
    from_status: null,
    to_status: 'promoted',
    event_kind: 'created',
    interaction_id: null,
  })).rejects.toThrow(/Invalid memory candidate status event/);

  expect(ids(await engine.listMemoryCandidateStatusEvents({ candidate_id: candidateA }))).toEqual([
    eventAdvanced,
    eventCreated,
  ]);
  expect(ids(await engine.listMemoryCandidateStatusEvents({ scope_id: scopeId }))).toEqual([
    eventSameB,
    eventSameA,
    eventRejected,
    eventAdvanced,
    eventCreated,
  ]);
  expect(ids(await engine.listMemoryCandidateStatusEvents({ scope_id: scopeId, event_kind: 'rejected' }))).toEqual([
    eventRejected,
  ]);
  expect(ids(await engine.listMemoryCandidateStatusEvents({ scope_id: scopeId, to_status: 'candidate' }))).toEqual([
    eventAdvanced,
  ]);
  expect(ids(await engine.listMemoryCandidateStatusEvents({ interaction_id: traceA }))).toEqual([
    eventRejected,
    eventCreated,
  ]);
  expect(ids(await engine.listMemoryCandidateStatusEvents({
    scope_id: scopeId,
    created_since: new Date('2026-04-22T06:09:00.000Z'),
  }))).toEqual([
    eventSameB,
    eventSameA,
    eventRejected,
  ]);
  expect(ids(await engine.listMemoryCandidateStatusEvents({
    scope_id: scopeId,
    created_until: new Date('2026-04-22T06:11:00.000Z'),
  }))).toEqual([
    eventRejected,
    eventAdvanced,
    eventCreated,
  ]);
  expect(ids(await engine.listMemoryCandidateStatusEvents({
    scope_id: scopeId,
    limit: 2,
    offset: 1,
  }))).toEqual([
    eventSameA,
    eventRejected,
  ]);
  expect(await engine.listMemoryCandidateStatusEventsByInteractionIds([])).toEqual([]);
  expect(ids(await engine.listMemoryCandidateStatusEventsByInteractionIds([traceA, traceSort]))).toEqual([
    eventSameB,
    eventSameA,
    eventRejected,
    eventCreated,
  ]);
  expect(ids(await engine.listMemoryCandidateStatusEventsByInteractionIds(Array.from({ length: 501 }, () => traceA)))).toEqual([
    eventRejected,
    eventCreated,
  ]);
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  const timeoutMs = createHarness === createPgliteHarness
    ? ENGINE_COLD_START_BUDGET_MS
    : undefined;

  test(`${createHarness.name} persists memory candidate entries across reopen`, async () => {
    const harness = await createHarness();
    const scopeId = 'workspace:default';
    const id = `memory-candidate:${scopeId}:${harness.label}`;
    let reopened: BrainEngine | null = null;

    try {
      await seedMemoryCandidate(harness.engine, id, scopeId);
      await expectMemoryCandidate(harness.engine, id, scopeId);

      await harness.engine.disconnect();
      reopened = await harness.reopen();
      await expectMemoryCandidate(reopened, id, scopeId);

      const filtered = await reopened.listMemoryCandidateEntries({
        scope_id: scopeId,
        status: 'captured',
        candidate_type: 'fact',
        limit: 1,
        offset: 0,
      });
      expect(filtered.map((candidate) => candidate.id)).toEqual([id]);

      const advanced = await reopened.updateMemoryCandidateEntryStatus(id, {
        status: 'candidate',
        reviewed_at: new Date('2026-04-22T06:00:00.000Z'),
        review_reason: 'Prepared for review queue.',
      });
      expect(advanced?.status).toBe('candidate');
      expect(advanced?.review_reason).toBe('Prepared for review queue.');

      const staged = await reopened.updateMemoryCandidateEntryStatus(id, {
        status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:05:00.000Z'),
        review_reason: 'Ready for explicit review decision.',
      });
      expect(staged?.status).toBe('staged_for_review');

      const rejected = await reopened.updateMemoryCandidateEntryStatus(id, {
        status: 'rejected',
        reviewed_at: new Date('2026-04-22T06:10:00.000Z'),
        review_reason: 'Insufficient provenance for durable memory.',
      });
      expect(rejected?.status).toBe('rejected');
      expect(rejected?.review_reason).toBe('Insufficient provenance for durable memory.');

      await expect(reopened.createMemoryCandidateEntry({
        id: `${id}:direct-promoted`,
        scope_id: scopeId,
        candidate_type: 'fact',
        proposed_content: 'Direct promoted inserts should be blocked at the engine surface.',
        source_refs: ['User, direct message, 2026-04-23 11:00 AM KST'],
        generated_by: 'manual',
        extraction_kind: 'manual',
        confidence_score: 0.9,
        importance_score: 0.7,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'promoted' as any,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/memory-inbox',
        reviewed_at: null,
        review_reason: null,
      })).rejects.toThrow(/Cannot create memory candidate directly in promoted status/);

      const promotedId = `${id}:promoted`;
      await seedMemoryCandidate(reopened, promotedId, scopeId);
      expect((await reopened.updateMemoryCandidateEntryStatus(promotedId, {
        status: 'candidate',
        reviewed_at: new Date('2026-04-22T06:12:00.000Z'),
      }))?.status).toBe('candidate');
      expect((await reopened.updateMemoryCandidateEntryStatus(promotedId, {
        status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:14:00.000Z'),
      }))?.status).toBe('staged_for_review');
      const promoted = await reopened.promoteMemoryCandidateEntry(promotedId, {
        expected_current_status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:16:00.000Z'),
        review_reason: 'Promoted after passing preflight.',
      });
      expect(promoted?.status).toBe('promoted');
      expect(promoted?.review_reason).toBe('Promoted after passing preflight.');
      expect(await reopened.promoteMemoryCandidateEntry(promotedId, {
        expected_current_status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:16:30.000Z'),
        review_reason: 'Duplicate promotion should lose the expected-status race.',
      })).toBeNull();

      await expect(reopened.updateMemoryCandidateEntryStatus(promotedId, {
        status: 'rejected',
        reviewed_at: new Date('2026-04-22T06:17:00.000Z'),
        review_reason: 'Terminal promoted outcomes must remain immutable.',
      })).rejects.toThrow(/Cannot update memory candidate from promoted to rejected/);

      expect((await reopened.getMemoryCandidateEntry(promotedId))?.status).toBe('promoted');

      const replacementId = `${id}:replacement`;
      await seedMemoryCandidate(reopened, replacementId, scopeId);
      expect((await reopened.updateMemoryCandidateEntryStatus(replacementId, {
        status: 'candidate',
        reviewed_at: new Date('2026-04-22T06:18:00.000Z'),
      }))?.status).toBe('candidate');
      expect((await reopened.updateMemoryCandidateEntryStatus(replacementId, {
        status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:19:00.000Z'),
      }))?.status).toBe('staged_for_review');
      expect((await reopened.promoteMemoryCandidateEntry(replacementId, {
        expected_current_status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:20:00.000Z'),
        review_reason: 'Replacement candidate won review.',
      }))?.status).toBe('promoted');

      const invalidSupersessionId = `${promotedId}:invalid-supersession`;
      const invalidSupersession = await reopened.supersedeMemoryCandidateEntry({
        id: invalidSupersessionId,
        scope_id: 'workspace:bogus',
        superseded_candidate_id: replacementId,
        replacement_candidate_id: 'missing-replacement',
        expected_current_status: 'promoted',
        reviewed_at: new Date('2026-04-22T06:20:30.000Z'),
        review_reason: 'Invalid replacement should not be persisted.',
      });
      expect(invalidSupersession).toBeNull();
      expect((await reopened.getMemoryCandidateEntry(replacementId))?.status).toBe('promoted');
      expect(await reopened.getMemoryCandidateSupersessionEntry(invalidSupersessionId)).toBeNull();

      const supersession = await reopened.supersedeMemoryCandidateEntry({
        id: `${promotedId}:supersession`,
        scope_id: scopeId,
        superseded_candidate_id: promotedId,
        replacement_candidate_id: replacementId,
        expected_current_status: 'promoted',
        reviewed_at: new Date('2026-04-22T06:21:00.000Z'),
        review_reason: 'Newer promoted evidence replaced the older promoted candidate.',
      });
      expect(supersession?.replacement_candidate_id).toBe(replacementId);
      expect((await reopened.getMemoryCandidateEntry(promotedId))?.status).toBe('superseded');
      expect((await reopened.getMemoryCandidateSupersessionEntry(`${promotedId}:supersession`))?.superseded_candidate_id).toBe(promotedId);

      await reopened.disconnect();
      reopened = await harness.reopen();
      expect((await reopened.getMemoryCandidateEntry(promotedId))?.status).toBe('superseded');
      expect((await reopened.getMemoryCandidateSupersessionEntry(`${promotedId}:supersession`))?.superseded_candidate_id).toBe(promotedId);
      const contradiction = await reopened.createMemoryCandidateContradictionEntry({
        id: `${promotedId}:contradiction`,
        scope_id: scopeId,
        candidate_id: replacementId,
        challenged_candidate_id: promotedId,
        outcome: 'superseded',
        supersession_entry_id: `${promotedId}:supersession`,
        reviewed_at: new Date('2026-04-22T06:21:30.000Z'),
        review_reason: 'Contradiction record should persist across reopen.',
      });
      if (!contradiction) {
        throw new Error('Expected contradiction entry to be created');
      }
      expect(contradiction.outcome).toBe('superseded');
      expect(await reopened.createMemoryCandidateContradictionEntry({
        id: `${promotedId}:invalid-contradiction`,
        scope_id: 'workspace:bogus',
        candidate_id: replacementId,
        challenged_candidate_id: promotedId,
        outcome: 'unresolved',
        reviewed_at: new Date('2026-04-22T06:21:45.000Z'),
        review_reason: 'Cross-scope contradiction records should be rejected.',
      })).toBeNull();
      expect(await reopened.supersedeMemoryCandidateEntry({
        id: `${promotedId}:supersession-duplicate`,
        scope_id: scopeId,
        superseded_candidate_id: promotedId,
        replacement_candidate_id: replacementId,
        expected_current_status: 'promoted',
        reviewed_at: new Date('2026-04-22T06:22:00.000Z'),
        review_reason: 'Duplicate supersession should degrade to null.',
      })).toBeNull();

      await reopened.disconnect();
      reopened = await harness.reopen();
      expect((await reopened.getMemoryCandidateContradictionEntry(`${promotedId}:contradiction`))?.outcome).toBe('superseded');

      await reopened.deleteMemoryCandidateEntry(id);
      expect(await reopened.getMemoryCandidateEntry(id)).toBeNull();
    } finally {
      await reopened?.disconnect();
      await harness.cleanup();
    }
  }, timeoutMs);

  test(`${createHarness.name} persists reviewable patch candidate fields without changing candidate status lifecycle`, async () => {
    const harness = await createHarness();
    const scopeId = 'workspace:default';
    const id = `memory-patch-candidate:${scopeId}:${harness.label}`;
    let reopened: BrainEngine | null = null;

    try {
      await seedPatchCandidate(harness.engine, id, scopeId);
      await expectPatchCandidate(harness.engine, id, scopeId);

      await harness.engine.disconnect();
      reopened = await harness.reopen();
      await expectPatchCandidate(reopened, id, scopeId);

      const rejected = await reopened.updateMemoryCandidateEntryStatus(id, {
        status: 'rejected',
        reviewed_at: new Date('2026-04-26T02:10:00.000Z'),
        review_reason: 'Reviewer rejected the patch without changing canonical memory.',
      });
      expect(rejected?.status).toBe('rejected');
      expect((rejected as any)?.patch_operation_state).toBe('proposed');
      await expect(reopened.updateMemoryCandidateEntryStatus(id, {
        status: 'promoted' as any,
      })).rejects.toThrow(/Cannot update memory candidate from rejected to promoted/);
    } finally {
      await reopened?.disconnect();
      await harness.cleanup();
    }
  }, timeoutMs);

  test(`${createHarness.name} refuses promotion when provenance refs are blank-only`, async () => {
    const harness = await createHarness();
    const scopeId = 'workspace:default';
    const id = `memory-candidate:${scopeId}:${harness.label}:blank-provenance`;

    try {
      await harness.engine.createMemoryCandidateEntry({
        id,
        scope_id: scopeId,
        candidate_type: 'fact',
        proposed_content: 'Blank-only provenance must not be promotable.',
        source_refs: ['   '],
        generated_by: 'manual',
        extraction_kind: 'manual',
        confidence_score: 0.95,
        importance_score: 0.8,
        recurrence_score: 0.2,
        sensitivity: 'work',
        status: 'captured',
        target_object_type: 'curated_note',
        target_object_id: 'concepts/note-manifest',
        reviewed_at: null,
        review_reason: null,
      });

      expect((await harness.engine.updateMemoryCandidateEntryStatus(id, {
        status: 'candidate',
        reviewed_at: new Date('2026-04-22T06:00:00.000Z'),
      }))?.status).toBe('candidate');
      expect((await harness.engine.updateMemoryCandidateEntryStatus(id, {
        status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:05:00.000Z'),
      }))?.status).toBe('staged_for_review');

      expect(await harness.engine.promoteMemoryCandidateEntry(id, {
        expected_current_status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:16:00.000Z'),
        review_reason: 'Blank provenance must not pass the engine CAS guard.',
      })).toBeNull();
      expect((await harness.engine.getMemoryCandidateEntry(id))?.status).toBe('staged_for_review');
    } finally {
      await harness.cleanup();
    }
  }, timeoutMs);

  test(`${createHarness.name} creates and lists memory candidate status events`, async () => {
    const harness = await createHarness();

    try {
      await expectMemoryCandidateStatusEventEngine(harness.engine, nextStatusEventPrefix(harness.label));
    } finally {
      await harness.cleanup();
    }
  }, timeoutMs);
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  test('postgres persists memory candidate entries', async () => {
    const scopeId = 'workspace:default';
    const id = `memory-candidate:${scopeId}:postgres:${Date.now()}`;
    const engine = new PostgresEngine();
    const reopened = new PostgresEngine();

    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      await seedMemoryCandidate(engine, id, scopeId);
      await expectMemoryCandidate(engine, id, scopeId);

      await engine.disconnect();
      await reopened.connect({ engine: 'postgres', database_url: databaseUrl });
      await reopened.initSchema();
      await expectMemoryCandidate(reopened, id, scopeId);
    } finally {
      const cleanupEngine = reopened as PostgresEngine;
      if (!(cleanupEngine as any)._sql) {
        await cleanupEngine.connect({ engine: 'postgres', database_url: databaseUrl });
      }
      await cleanupEngine.deleteMemoryCandidateEntry(id).catch(() => undefined);
      await reopened.disconnect();
      await engine.disconnect().catch(() => undefined);
    }
  });

  test('postgres refuses promotion when provenance refs are blank-only', async () => {
    const scopeId = 'workspace:default';
    const id = `memory-candidate:${scopeId}:postgres:blank-provenance:${Date.now()}`;
    const engine = new PostgresEngine();

    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      await engine.createMemoryCandidateEntry({
        id,
        scope_id: scopeId,
        candidate_type: 'fact',
        proposed_content: 'Blank-only provenance must not be promotable.',
        source_refs: ['   '],
        generated_by: 'manual',
        extraction_kind: 'manual',
        confidence_score: 0.95,
        importance_score: 0.8,
        recurrence_score: 0.2,
        sensitivity: 'work',
        status: 'captured',
        target_object_type: 'curated_note',
        target_object_id: 'concepts/note-manifest',
        reviewed_at: null,
        review_reason: null,
      });

      expect((await engine.updateMemoryCandidateEntryStatus(id, {
        status: 'candidate',
        reviewed_at: new Date('2026-04-22T06:00:00.000Z'),
      }))?.status).toBe('candidate');
      expect((await engine.updateMemoryCandidateEntryStatus(id, {
        status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:05:00.000Z'),
      }))?.status).toBe('staged_for_review');

      expect(await engine.promoteMemoryCandidateEntry(id, {
        expected_current_status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:16:00.000Z'),
        review_reason: 'Blank provenance must not pass the engine CAS guard.',
      })).toBeNull();
      expect((await engine.getMemoryCandidateEntry(id))?.status).toBe('staged_for_review');
    } finally {
      if (!(engine as any)._sql) {
        await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      }
      await engine.deleteMemoryCandidateEntry(id).catch(() => undefined);
      await engine.disconnect().catch(() => undefined);
    }
  });

  test('postgres creates and lists memory candidate status events', async () => {
    const prefix = nextStatusEventPrefix('postgres');
    const engine = new PostgresEngine();

    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      await expectMemoryCandidateStatusEventEngine(engine, prefix);
    } finally {
      await cleanupPostgresStatusEvents(engine, prefix).catch(() => undefined);
      await engine.disconnect().catch(() => undefined);
    }
  });
} else {
  test.skip('postgres memory inbox persistence skipped: DATABASE_URL is not configured', () => {});
}

async function cleanupPostgresStatusEvents(engine: PostgresEngine, prefix: string): Promise<void> {
  if (!(engine as any)._sql) {
    return;
  }
  const sql = (engine as any).sql;
  await sql`
    DELETE FROM memory_candidate_status_events
    WHERE id LIKE ${`${prefix}:%`}
  `;
}
