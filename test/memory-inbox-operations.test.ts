import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMemoryInboxOperations } from '../src/core/operations-memory-inbox.ts';
import { operations } from '../src/core/operations.ts';
import { OperationError } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

function compareEventSummaries(
  left: { event_kind: string; interaction_id: string | null },
  right: { event_kind: string; interaction_id: string | null },
) {
  const leftKey = `${left.event_kind}:${left.interaction_id ?? ''}`;
  const rightKey = `${right.event_kind}:${right.interaction_id ?? ''}`;
  return leftKey.localeCompare(rightKey);
}

test('memory inbox operations can be built from a dedicated domain module', () => {
  const built = createMemoryInboxOperations({
    defaultScopeId: 'workspace:default',
    OperationError,
  });

  expect(built.map((operation) => operation.name)).toEqual([
    'get_memory_candidate_entry',
    'list_memory_candidate_entries',
    'list_memory_candidate_status_events',
    'delete_memory_candidate_entry',
    'create_memory_candidate_entry',
    'rank_memory_candidate_entries',
    'capture_map_derived_candidates',
    'list_memory_candidate_review_backlog',
    'record_canonical_handoff',
    'list_canonical_handoff_entries',
    'assess_historical_validity',
    'advance_memory_candidate_status',
    'reject_memory_candidate_entry',
    'preflight_promote_memory_candidate',
    'promote_memory_candidate_entry',
    'supersede_memory_candidate_entry',
    'resolve_memory_candidate_contradiction',
    'run_dream_cycle_maintenance',
  ]);
});

test('memory inbox operations are registered with CLI hints', () => {
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const get = operations.find((operation) => operation.name === 'get_memory_candidate_entry');
  const list = operations.find((operation) => operation.name === 'list_memory_candidate_entries');
  const listStatusEvents = operations.find((operation) => operation.name === 'list_memory_candidate_status_events');
  const deleteCandidate = operations.find((operation) => operation.name === 'delete_memory_candidate_entry');
  const rank = operations.find((operation) => operation.name === 'rank_memory_candidate_entries');
  const captureMapDerived = operations.find((operation) => operation.name === 'capture_map_derived_candidates');
  const reviewBacklog = operations.find((operation) => operation.name === 'list_memory_candidate_review_backlog');
  const recordCanonicalHandoff = operations.find((operation) => operation.name === 'record_canonical_handoff');
  const listCanonicalHandoffs = operations.find((operation) => operation.name === 'list_canonical_handoff_entries');
  const assessHistoricalValidity = operations.find((operation) => operation.name === 'assess_historical_validity');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');
  const reject = operations.find((operation) => operation.name === 'reject_memory_candidate_entry');
  const preflight = operations.find((operation) => operation.name === 'preflight_promote_memory_candidate');
  const promote = operations.find((operation) => operation.name === 'promote_memory_candidate_entry');
  const supersede = operations.find((operation) => operation.name === 'supersede_memory_candidate_entry');
  const contradiction = operations.find((operation) => operation.name === 'resolve_memory_candidate_contradiction');
  const dreamCycle = operations.find((operation) => operation.name === 'run_dream_cycle_maintenance');

  expect(create?.cliHints?.name).toBe('create-memory-candidate');
  expect(get?.cliHints?.name).toBe('get-memory-candidate');
  expect(list?.cliHints?.name).toBe('list-memory-candidates');
  expect(listStatusEvents?.cliHints?.name).toBe('list-memory-candidate-status-events');
  expect(deleteCandidate?.cliHints?.name).toBe('delete-memory-candidate');
  expect(rank?.cliHints?.name).toBe('rank-memory-candidates');
  expect(captureMapDerived?.cliHints?.name).toBe('capture-map-derived-candidates');
  expect(reviewBacklog?.cliHints?.name).toBe('list-memory-candidate-review-backlog');
  expect(recordCanonicalHandoff?.cliHints?.name).toBe('record-canonical-handoff');
  expect(listCanonicalHandoffs?.cliHints?.name).toBe('list-canonical-handoffs');
  expect(assessHistoricalValidity?.cliHints?.name).toBe('assess-historical-validity');
  expect(advance?.cliHints?.name).toBe('advance-memory-candidate-status');
  expect(reject?.cliHints?.name).toBe('reject-memory-candidate');
  expect(preflight?.cliHints?.name).toBe('preflight-promote-memory-candidate');
  expect(promote?.cliHints?.name).toBe('promote-memory-candidate');
  expect(supersede?.cliHints?.name).toBe('supersede-memory-candidate');
  expect(contradiction?.cliHints?.name).toBe('resolve-memory-candidate-contradiction');
  expect(dreamCycle?.cliHints?.name).toBe('run-dream-cycle-maintenance');
  expect(create?.params.status?.enum).toEqual(['captured', 'candidate', 'staged_for_review']);
  expect(list?.params.status?.enum).toEqual(['captured', 'candidate', 'staged_for_review', 'rejected', 'promoted', 'superseded']);
  expect(listStatusEvents?.params.interaction_id?.type).toBe('string');
  expect(deleteCandidate?.params.id?.type).toBe('string');
  expect(create?.params.interaction_id?.type).toBe('string');
  expect(advance?.params.interaction_id?.type).toBe('string');
  expect(reject?.params.interaction_id?.type).toBe('string');
  expect(promote?.params.interaction_id?.type).toBe('string');
  expect(supersede?.params.interaction_id?.type).toBe('string');
  expect(contradiction?.params.interaction_id?.type).toBe('string');
  expect(recordCanonicalHandoff?.params.interaction_id?.type).toBe('string');
  expect(advance?.params.next_status?.description).toContain('depends on the current stored status');
});

test('memory inbox operations create and list candidate status events by interaction id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-op-status-events-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const listStatusEvents = operations.find((operation) => operation.name === 'list_memory_candidate_status_events');

  if (!create || !listStatusEvents) {
    throw new Error('memory inbox create/status event list operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const ctx = {
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    };

    await create.handler(ctx, {
      id: 'candidate-op-status-events',
      candidate_type: 'fact',
      proposed_content: 'Operation-created candidate should get a status event.',
      source_ref: 'User, direct message, 2026-04-25 9:30 AM KST',
      interaction_id: 'trace-op-status-events',
    });

    const events = await listStatusEvents.handler(ctx, {
      candidate_id: 'candidate-op-status-events',
      interaction_id: 'trace-op-status-events',
      limit: 10,
    });
    expect((events as any[]).map((event) => event.event_kind)).toEqual(['created']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox lifecycle operations reject blank interaction ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-op-blank-interaction-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const listStatusEvents = operations.find((operation) => operation.name === 'list_memory_candidate_status_events');
  const deleteCandidate = operations.find((operation) => operation.name === 'delete_memory_candidate_entry');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');
  const reject = operations.find((operation) => operation.name === 'reject_memory_candidate_entry');
  const promote = operations.find((operation) => operation.name === 'promote_memory_candidate_entry');
  const supersede = operations.find((operation) => operation.name === 'supersede_memory_candidate_entry');
  const contradiction = operations.find((operation) => operation.name === 'resolve_memory_candidate_contradiction');

  if (!create || !listStatusEvents || !deleteCandidate || !advance || !reject || !promote || !supersede || !contradiction) {
    throw new Error('memory inbox lifecycle operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const ctx = {
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    };

    await expect(create.handler(ctx, {
      id: 'candidate-blank-create-interaction',
      candidate_type: 'fact',
      proposed_content: 'Blank interaction ids should be rejected.',
      interaction_id: '   ',
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(listStatusEvents.handler(ctx, {
      interaction_id: '   ',
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(deleteCandidate.handler(ctx, {
      id: '   ',
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(advance.handler(ctx, {
      id: 'missing-candidate',
      next_status: 'candidate',
      interaction_id: '   ',
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(reject.handler(ctx, {
      id: 'missing-candidate',
      review_reason: 'Reject blank interaction ids before service calls.',
      interaction_id: '   ',
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(promote.handler(ctx, {
      id: 'missing-candidate',
      interaction_id: '   ',
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(supersede.handler(ctx, {
      superseded_candidate_id: 'missing-old',
      replacement_candidate_id: 'missing-new',
      interaction_id: '   ',
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(contradiction.handler(ctx, {
      candidate_id: 'missing-candidate',
      challenged_candidate_id: 'missing-challenged-candidate',
      outcome: 'rejected',
      interaction_id: '   ',
    })).rejects.toMatchObject({ code: 'invalid_params' });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox operations expose dry-run, direct get, filtered list, and bounded advance behavior', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const get = operations.find((operation) => operation.name === 'get_memory_candidate_entry');
  const list = operations.find((operation) => operation.name === 'list_memory_candidate_entries');
  const listStatusEvents = operations.find((operation) => operation.name === 'list_memory_candidate_status_events');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');
  const reject = operations.find((operation) => operation.name === 'reject_memory_candidate_entry');
  const preflight = operations.find((operation) => operation.name === 'preflight_promote_memory_candidate');

  if (!create || !get || !list || !listStatusEvents || !advance || !reject || !preflight) {
    throw new Error('memory inbox operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const preview = await create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: true,
    }, {
      candidate_type: 'fact',
      proposed_content: 'Context maps can propose a note update candidate.',
      source_ref: 'User, direct message, 2026-04-22 3:01 PM KST',
    });

    expect((preview as any).dry_run).toBe(true);
    expect((preview as any).action).toBe('create_memory_candidate_entry');
    expect((preview as any).scope_id).toBe('workspace:default');
    expect((preview as any).status).toBe('captured');

    const created = await create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-1',
      candidate_type: 'fact',
      proposed_content: 'Context maps can propose a note update candidate.',
      source_ref: 'User, direct message, 2026-04-22 3:01 PM KST',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/note-manifest',
    });

    expect((created as any).id).toBe('candidate-1');
    expect((created as any).scope_id).toBe('workspace:default');
    expect((created as any).status).toBe('captured');
    expect((created as any).source_refs).toEqual(['User, direct message, 2026-04-22 3:01 PM KST']);

    const loaded = await get.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-1',
    });

    expect((loaded as any).id).toBe('candidate-1');
    expect((loaded as any).candidate_type).toBe('fact');

    const listed = await list.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
      status: 'captured',
      candidate_type: 'fact',
      limit: 10,
    });

    expect((listed as any[]).map((entry) => entry.id)).toEqual(['candidate-1']);

    const advanced = await advance.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-1',
      next_status: 'candidate',
      interaction_id: ' trace-op-advance ',
    });

    expect((advanced as any).id).toBe('candidate-1');
    expect((advanced as any).status).toBe('candidate');

    const staged = await advance.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-1',
      next_status: 'staged_for_review',
      review_reason: 'Prepared for explicit decision.',
      interaction_id: 'trace-op-advance',
    });

    expect((staged as any).status).toBe('staged_for_review');

    const rejected = await reject.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-1',
      review_reason: 'Insufficient provenance for durable memory.',
      interaction_id: 'trace-op-reject',
    });

    expect((rejected as any).id).toBe('candidate-1');
    expect((rejected as any).status).toBe('rejected');

    const lifecycleEvents = await listStatusEvents.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      candidate_id: 'candidate-1',
      limit: 10,
    });

    const lifecycleEventSummaries = (lifecycleEvents as any[]).map((event) => ({
      event_kind: event.event_kind,
      interaction_id: event.interaction_id,
    })).sort(compareEventSummaries);
    expect(lifecycleEventSummaries).toEqual([
      { event_kind: 'advanced', interaction_id: 'trace-op-advance' },
      { event_kind: 'advanced', interaction_id: 'trace-op-advance' },
      { event_kind: 'created', interaction_id: null },
      { event_kind: 'rejected', interaction_id: 'trace-op-reject' },
    ]);

    const preflightResult = await preflight.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-1',
    });

    expect((preflightResult as any).candidate_id).toBe('candidate-1');
    expect((preflightResult as any).decision).toBe('deny');
    expect((preflightResult as any).reasons).toContain('candidate_not_staged_for_review');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox promotion preflight operation returns explicit allow and not-found errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-op-preflight-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');
  const preflight = operations.find((operation) => operation.name === 'preflight_promote_memory_candidate');

  if (!create || !advance || !preflight) {
    throw new Error('memory inbox create/advance/preflight operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-preflight',
      candidate_type: 'fact',
      proposed_content: 'Promotion preflight stays read-only and explicit.',
      source_ref: 'User, direct message, 2026-04-23 7:10 PM KST',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/memory-inbox',
    });

    await advance.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-preflight',
      next_status: 'candidate',
    });

    await advance.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-preflight',
      next_status: 'staged_for_review',
      review_reason: 'Ready for promotion governance.',
    });

    const result = await preflight.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-preflight',
    });

    expect((result as any).decision).toBe('allow');
    expect((result as any).reasons).toEqual(['candidate_ready_for_promotion']);

    await expect(preflight.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'missing-candidate',
    })).rejects.toMatchObject({
      code: 'memory_candidate_not_found',
    });

    await expect(preflight.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {})).rejects.toMatchObject({
      code: 'invalid_params',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox promotion operation promotes staged candidates and rejects blocked ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-op-promote-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');
  const promote = operations.find((operation) => operation.name === 'promote_memory_candidate_entry');
  const listStatusEvents = operations.find((operation) => operation.name === 'list_memory_candidate_status_events');

  if (!create || !advance || !promote || !listStatusEvents) {
    throw new Error('memory inbox create/advance/promote operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-promote',
      candidate_type: 'fact',
      proposed_content: 'Promotion writes an explicit governance outcome.',
      source_ref: 'User, direct message, 2026-04-23 8:10 PM KST',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/memory-inbox',
    });

    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-promote',
      next_status: 'candidate',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-promote',
      next_status: 'staged_for_review',
      review_reason: 'Ready for promotion.',
    });

    const promoted = await promote.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-promote',
      review_reason: 'Promoted after passing preflight.',
      interaction_id: ' trace-op-promote ',
    });

    expect((promoted as any).status).toBe('promoted');
    expect((promoted as any).review_reason).toBe('Promoted after passing preflight.');

    const promotedEvents = await listStatusEvents.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      candidate_id: 'candidate-promote',
      event_kind: 'promoted',
      interaction_id: 'trace-op-promote',
    });

    expect((promotedEvents as any[]).map((event) => event.to_status)).toEqual(['promoted']);

    await create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-promote-blocked',
      candidate_type: 'fact',
      proposed_content: 'Blocked promotion should stay staged when target binding is missing.',
      source_ref: 'User, direct message, 2026-04-23 8:15 PM KST',
    });

    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-promote-blocked',
      next_status: 'candidate',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-promote-blocked',
      next_status: 'staged_for_review',
      review_reason: 'Waiting for deterministic governance check.',
    });

    await expect(promote.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-promote-blocked',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    const blocked = await engine.getMemoryCandidateEntry('candidate-promote-blocked');
    expect(blocked?.status).toBe('staged_for_review');

    await expect(promote.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'missing-promoted-candidate',
    })).rejects.toMatchObject({
      code: 'memory_candidate_not_found',
    });

    await expect(promote.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-promote',
      review_reason: 123,
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox supersession operation records explicit old/new links', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-op-supersede-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');
  const promote = operations.find((operation) => operation.name === 'promote_memory_candidate_entry');
  const supersede = operations.find((operation) => operation.name === 'supersede_memory_candidate_entry');
  const listStatusEvents = operations.find((operation) => operation.name === 'list_memory_candidate_status_events');

  if (!create || !advance || !promote || !supersede || !listStatusEvents) {
    throw new Error('memory inbox supersession operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    for (const id of ['candidate-old', 'candidate-new']) {
      await create.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
        id,
        candidate_type: 'fact',
        proposed_content: `Candidate ${id} participates in supersession review.`,
        source_ref: 'User, direct message, 2026-04-23 11:30 PM KST',
        target_object_type: 'curated_note',
        target_object_id: 'concepts/memory-inbox',
      });
      await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
        id,
        next_status: 'candidate',
      });
      await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
        id,
        next_status: 'staged_for_review',
      });
      await promote.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
        id,
        review_reason: 'Promotion before supersession test.',
      });
    }

    const result = await supersede.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      superseded_candidate_id: 'candidate-old',
      replacement_candidate_id: 'candidate-new',
      review_reason: 'Newer promoted candidate replaced the older one.',
      interaction_id: ' trace-op-supersede ',
    });

    expect((result as any).superseded_candidate.status).toBe('superseded');
    expect((result as any).supersession_entry.replacement_candidate_id).toBe('candidate-new');

    const supersededEvents = await listStatusEvents.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      candidate_id: 'candidate-old',
      event_kind: 'superseded',
      interaction_id: 'trace-op-supersede',
    });

    expect((supersededEvents as any[]).map((event) => event.to_status)).toEqual(['superseded']);

    await expect(supersede.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      superseded_candidate_id: 'missing-candidate',
      replacement_candidate_id: 'candidate-new',
    })).rejects.toMatchObject({
      code: 'memory_candidate_not_found',
    });

    await create.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-not-promoted',
      candidate_type: 'fact',
      proposed_content: 'Replacement is not yet promoted.',
      source_ref: 'User, direct message, 2026-04-23 11:35 PM KST',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/memory-inbox',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-not-promoted',
      next_status: 'candidate',
    });

    await expect(supersede.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      superseded_candidate_id: 'candidate-new',
      replacement_candidate_id: 'candidate-not-promoted',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    await expect(supersede.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      superseded_candidate_id: 'candidate-new',
      replacement_candidate_id: 'candidate-not-promoted',
      reviewed_at: 'Thu Apr 23 2026 10:15:00 GMT+0900 (Korean Standard Time)',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    await expect(supersede.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      superseded_candidate_id: 'candidate-new',
      replacement_candidate_id: 'candidate-not-promoted',
      reviewed_at: '2026-99-99T25:61:61Z',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox contradiction operation forwards interaction ids to lifecycle status events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-op-contradiction-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');
  const contradiction = operations.find((operation) => operation.name === 'resolve_memory_candidate_contradiction');
  const listStatusEvents = operations.find((operation) => operation.name === 'list_memory_candidate_status_events');

  if (!create || !advance || !contradiction || !listStatusEvents) {
    throw new Error('memory inbox contradiction operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    for (const id of ['candidate-contradiction-new', 'candidate-contradiction-old']) {
      await create.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
        id,
        candidate_type: 'fact',
        proposed_content: `Candidate ${id} participates in contradiction review.`,
        source_ref: 'User, direct message, 2026-04-25 10:00 AM KST',
      });
      await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
        id,
        next_status: 'candidate',
      });
      await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
        id,
        next_status: 'staged_for_review',
      });
    }

    const result = await contradiction.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      candidate_id: 'candidate-contradiction-new',
      challenged_candidate_id: 'candidate-contradiction-old',
      outcome: 'rejected',
      review_reason: 'The challenger lost contradiction review.',
      interaction_id: ' trace-op-contradiction ',
    });

    expect((result as any).candidate.status).toBe('rejected');

    const events = await listStatusEvents.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      candidate_id: 'candidate-contradiction-new',
      event_kind: 'rejected',
      interaction_id: 'trace-op-contradiction',
    });

    expect((events as any[]).map((event) => event.to_status)).toEqual(['rejected']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox create accepts source_refs arrays and rejects future-only statuses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-op-source-refs-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');

  if (!create) {
    throw new Error('create memory candidate operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const created = await create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-multi-source',
      candidate_type: 'fact',
      proposed_content: 'Multiple provenance strings stay attached to one candidate.',
      source_refs: [
        'User, direct message, 2026-04-23 1:15 PM KST',
        'Meeting notes, Architecture Sync, 2026-04-23 1:20 PM KST',
      ],
    });

    expect((created as any).source_refs).toEqual([
      'User, direct message, 2026-04-23 1:15 PM KST',
      'Meeting notes, Architecture Sync, 2026-04-23 1:20 PM KST',
    ]);

    const trimmed = await create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-trimmed-boundaries',
      candidate_type: 'fact',
      proposed_content: 'Operation boundaries normalize provenance and target ids before persistence.',
      source_refs: [
        ' User, direct message, 2026-04-23 1:25 PM KST ',
        ' Meeting notes, Architecture Sync, 2026-04-23 1:30 PM KST ',
      ],
      target_object_type: 'curated_note',
      target_object_id: ' concepts/normalized-target ',
    });

    expect((trimmed as any).source_refs).toEqual([
      'User, direct message, 2026-04-23 1:25 PM KST',
      'Meeting notes, Architecture Sync, 2026-04-23 1:30 PM KST',
    ]);
    expect((trimmed as any).target_object_id).toBe('concepts/normalized-target');

    await expect(create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-invalid-status',
      candidate_type: 'fact',
      proposed_content: 'Future-only statuses should stay hidden in Phase 5.',
      status: 'promoted',
    })).rejects.toBeInstanceOf(OperationError);

    await expect(create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-invalid-status',
      candidate_type: 'fact',
      proposed_content: 'Future-only statuses should stay hidden in Phase 5.',
      status: 'promoted',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    await expect(create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-invalid-reviewed-at',
      candidate_type: 'fact',
      proposed_content: 'Invalid reviewed_at strings should be rejected at the public operation boundary.',
      status: 'staged_for_review',
      reviewed_at: '2026-99-99T25:61:61Z',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    await expect(create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-blank-source-ref',
      candidate_type: 'fact',
      proposed_content: 'Blank provenance strings should be rejected.',
      source_refs: [''],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    await expect(create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-blank-target-id',
      candidate_type: 'fact',
      proposed_content: 'Blank target ids should be rejected.',
      target_object_type: 'curated_note',
      target_object_id: '   ',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox list caps oversized limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-op-limit-cap-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const list = operations.find((operation) => operation.name === 'list_memory_candidate_entries');

  if (!create || !list) {
    throw new Error('memory inbox create/list operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    for (let index = 0; index < 105; index++) {
      await create.handler({
        engine,
        config: {} as any,
        logger: console,
        dryRun: false,
      }, {
        id: `candidate-cap-${index}`,
        candidate_type: 'fact',
        proposed_content: `Candidate ${index}`,
      });
    }

    const listed = await list.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
      limit: 999,
    });

    expect((listed as any[])).toHaveLength(100);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
