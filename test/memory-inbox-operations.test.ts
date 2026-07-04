import { setDefaultTimeout, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMemoryInboxOperations } from '../src/core/operations-memory-inbox.ts';
import { operations } from '../src/core/operations.ts';
import { OperationError } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

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
    'read_candidate_context',
    'list_memory_candidate_entries',
    'list_memory_candidate_status_events',
    'delete_memory_candidate_entry',
    'review_duplicate_memory',
    'create_memory_candidate_entry',
    'create_memory_patch_candidate',
    'propose_compile_debt_patches',
    'review_memory_patch_candidate',
    'apply_memory_patch_candidate',
    'finalize_memory_candidate',
    'rank_memory_candidate_entries',
    'capture_map_derived_candidates',
    'list_memory_candidate_review_backlog',
    'record_canonical_handoff',
    'list_canonical_handoff_entries',
    'assess_historical_validity',
    'advance_memory_candidate_status',
    'verify_memory_candidate_entry',
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
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const proposeCompileDebtPatches = operations.find((operation) => operation.name === 'propose_compile_debt_patches');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');
  const finalize = operations.find((operation) => operation.name === 'finalize_memory_candidate');
  const get = operations.find((operation) => operation.name === 'get_memory_candidate_entry');
  const list = operations.find((operation) => operation.name === 'list_memory_candidate_entries');
  const listStatusEvents = operations.find((operation) => operation.name === 'list_memory_candidate_status_events');
  const deleteCandidate = operations.find((operation) => operation.name === 'delete_memory_candidate_entry');
  const reviewDuplicate = operations.find((operation) => operation.name === 'review_duplicate_memory');
  const rank = operations.find((operation) => operation.name === 'rank_memory_candidate_entries');
  const captureMapDerived = operations.find((operation) => operation.name === 'capture_map_derived_candidates');
  const reviewBacklog = operations.find((operation) => operation.name === 'list_memory_candidate_review_backlog');
  const recordCanonicalHandoff = operations.find((operation) => operation.name === 'record_canonical_handoff');
  const listCanonicalHandoffs = operations.find((operation) => operation.name === 'list_canonical_handoff_entries');
  const assessHistoricalValidity = operations.find((operation) => operation.name === 'assess_historical_validity');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');
  const verify = operations.find((operation) => operation.name === 'verify_memory_candidate_entry');
  const reject = operations.find((operation) => operation.name === 'reject_memory_candidate_entry');
  const preflight = operations.find((operation) => operation.name === 'preflight_promote_memory_candidate');
  const promote = operations.find((operation) => operation.name === 'promote_memory_candidate_entry');
  const supersede = operations.find((operation) => operation.name === 'supersede_memory_candidate_entry');
  const contradiction = operations.find((operation) => operation.name === 'resolve_memory_candidate_contradiction');
  const dreamCycle = operations.find((operation) => operation.name === 'run_dream_cycle_maintenance');
  const readCandidateContext = operations.find((operation) => operation.name === 'read_candidate_context');

  expect(create?.cliHints?.name).toBe('create-memory-candidate');
  expect(createPatch?.cliHints?.name).toBe('create-memory-patch-candidate');
  expect(proposeCompileDebtPatches?.cliHints?.name).toBe('propose-compile-debt-patches');
  expect(reviewPatch?.cliHints?.name).toBe('review-memory-patch-candidate');
  expect(applyPatch?.cliHints?.name).toBe('apply-memory-patch-candidate');
  expect(finalize?.cliHints?.name).toBe('finalize-memory-candidate');
  expect(get?.cliHints?.name).toBe('get-memory-candidate');
  expect(list?.cliHints?.name).toBe('list-memory-candidates');
  expect(listStatusEvents?.cliHints?.name).toBe('list-memory-candidate-status-events');
  expect(deleteCandidate?.cliHints?.name).toBe('delete-memory-candidate');
  expect(reviewDuplicate?.cliHints?.name).toBe('review-duplicate-memory');
  expect(rank?.cliHints?.name).toBe('rank-memory-candidates');
  expect(captureMapDerived?.cliHints?.name).toBe('capture-map-derived-candidates');
  expect(reviewBacklog?.cliHints?.name).toBe('list-memory-candidate-review-backlog');
  expect(recordCanonicalHandoff?.cliHints?.name).toBe('record-canonical-handoff');
  expect(listCanonicalHandoffs?.cliHints?.name).toBe('list-canonical-handoffs');
  expect(assessHistoricalValidity?.cliHints?.name).toBe('assess-historical-validity');
  expect(advance?.cliHints?.name).toBe('advance-memory-candidate-status');
  expect(verify?.cliHints?.name).toBe('verify-memory-candidate');
  expect(reject?.cliHints?.name).toBe('reject-memory-candidate');
  expect(preflight?.cliHints?.name).toBe('preflight-promote-memory-candidate');
  expect(promote?.cliHints?.name).toBe('promote-memory-candidate');
  expect(promote?.params.retry_on_stale).toMatchObject({ type: 'boolean' });
  expect(supersede?.cliHints?.name).toBe('supersede-memory-candidate');
  expect(contradiction?.cliHints?.name).toBe('resolve-memory-candidate-contradiction');
  expect(dreamCycle?.cliHints?.name).toBe('run-dream-cycle-maintenance');
  expect(readCandidateContext?.cliHints?.name).toBe('read-candidate-context');
  expect(create?.params.status?.enum).toEqual(['captured', 'candidate', 'staged_for_review']);
  expect(create?.params.patch_operation_state).toBeUndefined();
  expect(create?.params.patch_ledger_event_ids).toBeUndefined();
  expect(createPatch?.params.status).toBeUndefined();
  expect(createPatch?.params.patch_operation_state).toBeUndefined();
  expect(createPatch?.params.patch_body?.type).toEqual(['object', 'array']);
  expect(createPatch?.params.target_kind?.enum).toEqual([
    'page',
    'task_thread',
    'working_set',
    'memory_candidate',
    'profile_memory',
    'personal_episode',
    'memory_realm',
    'memory_session',
    'memory_session_attachment',
    'context_map',
    'context_atlas',
  ]);
  expect(reviewPatch?.params.decision?.enum).toEqual(['approve', 'reject']);
  expect(reviewPatch?.params.risk_acknowledged?.type).toBe('boolean');
  expect(applyPatch?.params.candidate_id?.type).toBe('string');
  expect(applyPatch?.params.risk_acknowledged?.type).toBe('boolean');
  expect(finalize?.params.id?.type).toBe('string');
  expect(finalize?.params.verification_method?.enum).toContain('source_recheck');
  expect(finalize?.params.apply_patch?.type).toBe('boolean');
  expect(finalize?.params.sync?.type).toBe('boolean');
  expect(list?.params.status?.enum).toEqual(['captured', 'candidate', 'staged_for_review', 'rejected', 'promoted', 'superseded']);
  expect(list?.params.patch_operation_state?.enum).toContain('approved_for_apply');
  expect(list?.params.patch_target_kind?.enum).toContain('page');
  expect(list?.params.patch_target_id?.type).toBe('string');
  expect(listStatusEvents?.params.interaction_id?.type).toBe('string');
  expect(deleteCandidate?.params.id?.type).toBe('string');
  expect(reviewDuplicate?.params.subject_kind?.enum).toEqual(['page', 'memory_candidate', 'proposed_memory']);
  expect(reviewDuplicate?.params.include_pages?.type).toBe('boolean');
  expect(reviewDuplicate?.params.include_candidates?.type).toBe('boolean');
  expect(create?.params.interaction_id?.type).toBe('string');
  expect(advance?.params.interaction_id?.type).toBe('string');
  expect(reject?.params.interaction_id?.type).toBe('string');
  expect(promote?.params.interaction_id?.type).toBe('string');
  expect(supersede?.params.interaction_id?.type).toBe('string');
  expect(contradiction?.params.interaction_id?.type).toBe('string');
  expect(recordCanonicalHandoff?.params.interaction_id?.type).toBe('string');
  expect(readCandidateContext?.params.purpose?.enum).toEqual(['review', 'promotion', 'audit', 'debug']);
  expect(readCandidateContext?.params.requested_scope?.enum).toEqual(['work', 'personal', 'mixed']);
  expect(advance?.params.next_status?.description).toContain('depends on the current stored status');
  expect(verify?.params.verification_status?.enum).toEqual(['verified', 'refuted']);
  expect(verify?.params.verification_method?.enum).toContain('command_execution');
});

test('create_memory_patch_candidate stages a normal inbox candidate and records a mutation ledger event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-candidate-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const get = operations.find((operation) => operation.name === 'get_memory_candidate_entry');
  const list = operations.find((operation) => operation.name === 'list_memory_candidate_entries');

  if (!createPatch || !get || !list) {
    throw new Error('memory patch candidate operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-review',
      name: 'Patch review realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-review',
      actor_ref: 'agent:patch-reviewer',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-review',
      realm_id: 'realm:patch-review',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-target', {
      type: 'concept',
      title: 'Patch Target',
      compiled_truth: 'Original compiled truth. [Source: User, direct message, 2026-04-26 11:00 AM KST]',
      timeline: '',
    });
    const pageHash = page.content_hash as string;

    const ctx = {
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    };

    const created = await createPatch.handler(ctx, {
      id: 'patch-candidate-op',
      session_id: 'session:patch-review',
      realm_id: 'realm:patch-review',
      actor: 'agent:patch-reviewer',
      scope_id: 'workspace:default',
      target_kind: 'page',
      target_id: 'concepts/patch-target',
      base_target_snapshot_hash: pageHash,
      patch_body: {
        compiled_truth: 'Updated compiled truth. [Source: User, direct message, 2026-04-26 11:00 AM KST]',
      },
      patch_format: 'merge_patch',
      risk_class: 'medium',
      expected_resulting_target_snapshot_hash: '1'.repeat(64),
      proposed_content: 'Reviewable patch for concepts/patch-target.',
      source_refs: ['User, direct message, 2026-04-26 11:00 AM KST'],
      provenance_summary: 'User explicitly requested this canonical note change.',
    }) as any;

    expect(created.status).toBe('staged_for_review');
    expect(created.patch_operation_state).toBe('proposed');
    expect(created.patch_target_kind).toBe('page');
    expect(created.patch_target_id).toBe('concepts/patch-target');
    expect(created.patch_base_target_snapshot_hash).toBe(pageHash);
    expect(created.patch_ledger_event_ids).toHaveLength(1);

    const fetched = await get.handler(ctx, { id: 'patch-candidate-op' }) as any;
    expect(fetched.patch_ledger_event_ids).toEqual(created.patch_ledger_event_ids);
    const filtered = await list.handler(ctx, {
      patch_operation_state: 'proposed',
      patch_target_kind: 'page',
      patch_target_id: 'concepts/patch-target',
      limit: 10,
    }) as any[];
    expect(filtered.map((entry) => entry.id)).toContain('patch-candidate-op');
    const statusEvents = await engine.listMemoryCandidateStatusEvents({
      candidate_id: 'patch-candidate-op',
    });
    expect(statusEvents.map((event) => event.event_kind)).toEqual(['created']);

    const ledgerEvents = await engine.listMemoryMutationEvents({
      operation: 'create_memory_patch_candidate',
      target_kind: 'memory_candidate',
      target_id: 'patch-candidate-op',
      result: 'staged_for_review',
    });
    expect(ledgerEvents.map((event) => event.id)).toEqual(created.patch_ledger_event_ids);
    expect(ledgerEvents[0]?.metadata.patch_target_kind).toBe('page');
    expect(ledgerEvents[0]?.metadata.patch_current_target_snapshot_hash).toBe(pageHash);
    expect(ledgerEvents[0]?.metadata.patch_expected_resulting_target_snapshot_hash).toBe('1'.repeat(64));
    expect(ledgerEvents[0]?.expected_target_snapshot_hash).toBeNull();
    expect(ledgerEvents[0]?.current_target_snapshot_hash).toBeNull();
    expect((await engine.getPage('concepts/patch-target'))?.compiled_truth).toBe(page.compiled_truth);

    const jsonPatchCreated = await createPatch.handler(ctx, {
      id: 'patch-candidate-json-patch',
      session_id: 'session:patch-review',
      realm_id: 'realm:patch-review',
      actor: 'agent:patch-reviewer',
      scope_id: 'workspace:default',
      target_kind: 'page',
      target_id: 'concepts/patch-target',
      base_target_snapshot_hash: pageHash,
      patch_body: [
        {
          op: 'replace',
          path: '/compiled_truth',
          value: 'Updated through JSON Patch. [Source: User, direct message, 2026-04-26 11:00 AM KST]',
        },
      ],
      patch_format: 'json_patch',
      source_refs: ['User, direct message, 2026-04-26 11:00 AM KST'],
    }) as any;
    expect(Array.isArray(jsonPatchCreated.patch_body)).toBe(true);

    await expect(createPatch.handler(ctx, {
      session_id: 'session:patch-review',
      realm_id: 'realm:patch-review',
      actor: 'agent:patch-reviewer',
      scope_id: 'workspace:default',
      target_kind: 'page',
      target_id: 'concepts/patch-target',
      base_target_snapshot_hash: '0'.repeat(64),
      patch_body: { compiled_truth: 'Stale patch.' },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 11:00 AM KST'],
    })).rejects.toThrow(/base_target_snapshot_hash/);

    await expect(createPatch.handler(ctx, {
      session_id: 'session:patch-review',
      realm_id: 'realm:patch-review',
      actor: 'agent:patch-reviewer',
      target_kind: 'page',
      target_id: 'concepts/patch-target',
      base_target_snapshot_hash: pageHash,
      patch_body: { compiled_truth: 'Lifecycle override patch.' },
      patch_format: 'merge_patch',
      status: 'candidate',
      source_refs: ['User, direct message, 2026-04-26 11:00 AM KST'],
    })).rejects.toThrow(/status is managed/);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('propose_compile_debt_patches previews and flag-gates governed patch candidate creation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-compile-debt-patch-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const proposePatches = operations.find((operation) => operation.name === 'propose_compile_debt_patches');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!proposePatches || !reviewPatch || !applyPatch) {
    throw new Error('compile-debt patch operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:compile-debt',
      name: 'Compile debt realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:compile-debt',
      actor_ref: 'agent:compile-debt',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:compile-debt',
      realm_id: 'realm:compile-debt',
      access: 'read_write',
    });
    await engine.putPage('systems/compile-debt', {
      type: 'system',
      title: 'Compile Debt',
      compiled_truth: 'Original compiled truth. [Source: User, direct message, 2026-07-03 09:00 KST]',
      timeline: '',
      frontmatter: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.putPage('systems/compile-debt', {
      type: 'system',
      title: 'Compile Debt',
      compiled_truth: 'Original compiled truth. [Source: User, direct message, 2026-07-03 09:00 KST]',
      timeline: '- **2026-07-03** | New timeline fact. [Source: User, direct message, 2026-07-03 10:00 KST]',
      frontmatter: {},
    });

    const baseCtx = {
      engine,
      config: { maintenance_governed_recompile_enabled: false } as any,
      logger: console,
      dryRun: false,
    };
    const preview = await proposePatches.handler(baseCtx, { limit: 5 }) as any;
    expect(preview.applied).toBe(false);
    const patchBodyJson = JSON.stringify(preview.proposals[0].patch_body);
    expect(patchBodyJson.includes('- **2026-07-03** | New timeline fact.')).toBe(false);
    expect(patchBodyJson).toContain('- New timeline fact. [Source: User, direct message, 2026-07-03 10:00 KST]');
    expect(patchBodyJson).not.toContain('Pending Compile-Debt Review');
    expect(preview.proposals[0]).toMatchObject({
      slug: 'systems/compile-debt',
      patch_body: {
        compiled_truth: expect.stringContaining('Timeline Evidence Distillation'),
      },
    });

    await expect(proposePatches.handler(baseCtx, {
      apply: true,
      session_id: 'session:compile-debt',
      realm_id: 'realm:compile-debt',
      actor: 'agent:compile-debt',
    })).rejects.toThrow(/governed_recompile_enabled/);

    const applied = await proposePatches.handler({
      ...baseCtx,
      config: { maintenance_governed_recompile_enabled: true } as any,
    }, {
      apply: true,
      session_id: 'session:compile-debt',
      realm_id: 'realm:compile-debt',
      actor: 'agent:compile-debt',
    }) as any;

    expect(applied.applied).toBe(true);
    expect(applied.created).toHaveLength(1);
    const candidates = await engine.listMemoryCandidateEntries({
      patch_target_kind: 'page',
      patch_target_id: 'systems/compile-debt',
      patch_operation_state: 'proposed',
      limit: 10,
      offset: 0,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.proposed_content).toContain('compile-debt patch');

    await reviewPatch.handler(baseCtx, {
      candidate_id: candidates[0]?.id,
      session_id: 'session:compile-debt',
      realm_id: 'realm:compile-debt',
      actor: 'agent:compile-debt',
      decision: 'approve',
      review_reason: 'Generated distillation preserves source attribution.',
      source_refs: ['User, direct message, 2026-07-03 10:00 KST'],
    });
    await applyPatch.handler(baseCtx, {
      candidate_id: candidates[0]?.id,
      session_id: 'session:compile-debt',
      realm_id: 'realm:compile-debt',
      actor: 'agent:compile-debt',
      review_reason: 'Apply governed compile-debt distillation.',
      source_refs: ['User, direct message, 2026-07-03 10:00 KST'],
    });

    const updatedPage = await engine.getPage('systems/compile-debt');
    expect(updatedPage?.compiled_truth).toContain('Timeline Evidence Distillation');
    expect(updatedPage?.compiled_truth).toContain('- New timeline fact. [Source: User, direct message, 2026-07-03 10:00 KST]');
    expect(updatedPage?.compiled_truth).not.toContain('- **2026-07-03** | New timeline fact.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review and apply memory patch candidate update a page only after approval and hash validation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-apply-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!createPatch || !reviewPatch || !applyPatch) {
    throw new Error('memory patch review/apply operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-apply',
      name: 'Patch apply realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-apply',
      actor_ref: 'agent:patch-applier',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-apply',
      realm_id: 'realm:patch-apply',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-apply-target', {
      type: 'concept',
      title: 'Patch Apply Target',
      compiled_truth: 'Original page body. [Source: User, direct message, 2026-04-26 12:00 PM KST]',
      timeline: '',
    });
    const ctx = {
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    };

    const created = await createPatch.handler(ctx, {
      id: 'patch-candidate-apply',
      session_id: 'session:patch-apply',
      realm_id: 'realm:patch-apply',
      actor: 'agent:patch-applier',
      target_kind: 'page',
      target_id: 'concepts/patch-apply-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        compiled_truth: 'Applied page body. [Source: User, direct message, 2026-04-26 12:01 PM KST]',
        timeline: '- **2026-04-26** | Patch was applied. [Source: User, direct message, 2026-04-26 12:01 PM KST]',
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 12:01 PM KST'],
    }) as any;

    const approved = await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-apply',
      session_id: 'session:patch-apply',
      realm_id: 'realm:patch-apply',
      actor: 'agent:patch-applier',
      decision: 'approve',
      review_reason: 'Patch matches the cited source.',
      source_refs: ['User, direct message, 2026-04-26 12:01 PM KST'],
    }) as any;
    expect(approved.status).toBe('staged_for_review');
    expect(approved.patch_operation_state).toBe('approved_for_apply');
    expect(approved.patch_ledger_event_ids).toHaveLength(created.patch_ledger_event_ids.length + 1);
    const reviewEvents = await engine.listMemoryMutationEvents({
      operation: 'review_memory_patch_candidate',
      target_kind: 'memory_candidate',
      target_id: 'patch-candidate-apply',
      result: 'approved',
    });
    expect(reviewEvents).toHaveLength(1);

    const applied = await applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-apply',
      session_id: 'session:patch-apply',
      realm_id: 'realm:patch-apply',
      actor: 'agent:patch-applier',
      review_reason: 'Applied approved patch.',
      source_refs: ['User, direct message, 2026-04-26 12:01 PM KST'],
    }) as any;

    expect(applied.status).toBe('applied');
    expect(applied.target_kind).toBe('page');
    expect(applied.target_id).toBe('concepts/patch-apply-target');
    expect(applied.previous_target_snapshot_hash).toBe(page.content_hash);

    const updatedPage = await engine.getPage('concepts/patch-apply-target');
    expect(updatedPage?.compiled_truth).toBe('Applied page body. [Source: User, direct message, 2026-04-26 12:01 PM KST]');
    expect(updatedPage?.timeline).toBe('- **2026-04-26** | Patch was applied. [Source: User, direct message, 2026-04-26 12:01 PM KST]');

    const candidate = await engine.getMemoryCandidateEntry('patch-candidate-apply');
    expect(candidate?.status).toBe('promoted');
    expect(candidate?.patch_operation_state).toBe('applied');
    expect(candidate?.patch_ledger_event_ids).toHaveLength(3);

    const applyEvents = await engine.listMemoryMutationEvents({
      operation: 'apply_memory_patch_candidate',
      target_kind: 'page',
      target_id: 'concepts/patch-apply-target',
      result: 'applied',
    });
    expect(applyEvents).toHaveLength(1);
    expect(applyEvents[0]?.expected_target_snapshot_hash).toBe(page.content_hash ?? null);
    expect(applyEvents[0]?.current_target_snapshot_hash).toBe(updatedPage?.content_hash ?? null);
    expect(applyEvents[0]?.metadata.candidate_id).toBe('patch-candidate-apply');

    const statusEvents = await engine.listMemoryCandidateStatusEvents({
      candidate_id: 'patch-candidate-apply',
    });
    expect(statusEvents.map((event) => event.event_kind).sort()).toEqual(['created', 'promoted']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('high and critical risk memory patch candidates require explicit acknowledgement before approval and apply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-risk-gate-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!createPatch || !reviewPatch || !applyPatch) {
    throw new Error('memory patch review/apply operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-risk',
      name: 'Patch risk realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-risk',
      actor_ref: 'agent:patch-risk',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-risk',
      realm_id: 'realm:patch-risk',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-risk-target', {
      type: 'concept',
      title: 'Patch Risk Target',
      compiled_truth: 'Original high risk target. [Source: User, direct message, 2026-04-26 01:00 PM KST]',
      timeline: '',
    });
    const ctx = {
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    };

    const created = await createPatch.handler(ctx, {
      id: 'patch-candidate-high-risk',
      session_id: 'session:patch-risk',
      realm_id: 'realm:patch-risk',
      actor: 'agent:patch-risk',
      target_kind: 'page',
      target_id: 'concepts/patch-risk-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        compiled_truth: 'Applied high risk target. [Source: User, direct message, 2026-04-26 01:01 PM KST]',
      },
      patch_format: 'merge_patch',
      risk_class: 'high',
      source_refs: ['User, direct message, 2026-04-26 01:01 PM KST'],
    }) as any;

    await expect(reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-high-risk',
      session_id: 'session:patch-risk',
      realm_id: 'realm:patch-risk',
      actor: 'agent:patch-risk',
      decision: 'approve',
      review_reason: 'Approving without risk acknowledgement should be denied.',
      source_refs: ['User, direct message, 2026-04-26 01:01 PM KST'],
    })).rejects.toThrow(/risk_acknowledged=true/);

    let candidate = await engine.getMemoryCandidateEntry('patch-candidate-high-risk');
    expect(candidate?.status).toBe('staged_for_review');
    expect(candidate?.patch_operation_state).toBe('proposed');
    expect(candidate?.patch_ledger_event_ids).toHaveLength(created.patch_ledger_event_ids.length + 1);
    let deniedEvents = await engine.listMemoryMutationEvents({
      operation: 'review_memory_patch_candidate',
      target_kind: 'memory_candidate',
      target_id: 'patch-candidate-high-risk',
      result: 'denied',
    });
    expect(deniedEvents).toHaveLength(1);
    expect(deniedEvents[0]?.conflict_info?.reason).toBe('patch_risk_acknowledgement_required');
    expect(deniedEvents[0]?.metadata.patch_risk_class).toBe('high');

    const approved = await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-high-risk',
      session_id: 'session:patch-risk',
      realm_id: 'realm:patch-risk',
      actor: 'agent:patch-risk',
      decision: 'approve',
      risk_acknowledged: true,
      review_reason: 'High risk patch was explicitly acknowledged.',
      source_refs: ['User, direct message, 2026-04-26 01:01 PM KST'],
    }) as any;
    expect(approved.patch_operation_state).toBe('approved_for_apply');

    await expect(applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-high-risk',
      session_id: 'session:patch-risk',
      realm_id: 'realm:patch-risk',
      actor: 'agent:patch-risk',
      review_reason: 'Applying without risk acknowledgement should be denied.',
      source_refs: ['User, direct message, 2026-04-26 01:01 PM KST'],
    })).rejects.toThrow(/risk_acknowledged=true/);

    candidate = await engine.getMemoryCandidateEntry('patch-candidate-high-risk');
    expect(candidate?.status).toBe('staged_for_review');
    expect(candidate?.patch_operation_state).toBe('approved_for_apply');
    deniedEvents = await engine.listMemoryMutationEvents({
      operation: 'apply_memory_patch_candidate',
      target_kind: 'page',
      target_id: 'concepts/patch-risk-target',
      result: 'denied',
    });
    expect(deniedEvents).toHaveLength(1);
    expect(deniedEvents[0]?.conflict_info?.reason).toBe('patch_risk_acknowledgement_required');
    expect(deniedEvents[0]?.metadata.patch_risk_class).toBe('high');

    const applied = await applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-high-risk',
      session_id: 'session:patch-risk',
      realm_id: 'realm:patch-risk',
      actor: 'agent:patch-risk',
      risk_acknowledged: true,
      review_reason: 'High risk apply was explicitly acknowledged.',
      source_refs: ['User, direct message, 2026-04-26 01:01 PM KST'],
    }) as any;

    expect(applied.status).toBe('applied');
    expect((await engine.getPage('concepts/patch-risk-target'))?.compiled_truth).toBe(
      'Applied high risk target. [Source: User, direct message, 2026-04-26 01:01 PM KST]',
    );

    const criticalPage = await engine.putPage('concepts/patch-critical-risk-target', {
      type: 'concept',
      title: 'Patch Critical Risk Target',
      compiled_truth: 'Original critical risk target. [Source: User, direct message, 2026-04-26 01:02 PM KST]',
      timeline: '',
    });
    await createPatch.handler(ctx, {
      id: 'patch-candidate-critical-risk',
      session_id: 'session:patch-risk',
      realm_id: 'realm:patch-risk',
      actor: 'agent:patch-risk',
      target_kind: 'page',
      target_id: 'concepts/patch-critical-risk-target',
      base_target_snapshot_hash: criticalPage.content_hash,
      patch_body: {
        compiled_truth: 'Applied critical risk target. [Source: User, direct message, 2026-04-26 01:03 PM KST]',
      },
      patch_format: 'merge_patch',
      risk_class: 'critical',
      source_refs: ['User, direct message, 2026-04-26 01:03 PM KST'],
    });

    await expect(reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-critical-risk',
      session_id: 'session:patch-risk',
      realm_id: 'realm:patch-risk',
      actor: 'agent:patch-risk',
      decision: 'approve',
      review_reason: 'Critical risk approval without acknowledgement should be denied.',
      source_refs: ['User, direct message, 2026-04-26 01:03 PM KST'],
    })).rejects.toThrow(/critical risk memory patch candidates/);

    candidate = await engine.getMemoryCandidateEntry('patch-candidate-critical-risk');
    expect(candidate?.patch_operation_state).toBe('proposed');

    await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-critical-risk',
      session_id: 'session:patch-risk',
      realm_id: 'realm:patch-risk',
      actor: 'agent:patch-risk',
      decision: 'approve',
      risk_acknowledged: true,
      review_reason: 'Critical risk patch was explicitly acknowledged.',
      source_refs: ['User, direct message, 2026-04-26 01:03 PM KST'],
    });
    await expect(applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-critical-risk',
      session_id: 'session:patch-risk',
      realm_id: 'realm:patch-risk',
      actor: 'agent:patch-risk',
      review_reason: 'Critical risk apply without acknowledgement should be denied.',
      source_refs: ['User, direct message, 2026-04-26 01:03 PM KST'],
    })).rejects.toThrow(/critical risk memory patch candidates/);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply_memory_patch_candidate creates a missing page when the base snapshot is null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-apply-missing-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!createPatch || !reviewPatch || !applyPatch) {
    throw new Error('memory patch review/apply operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-missing',
      name: 'Patch missing realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-missing',
      actor_ref: 'agent:patch-applier',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-missing',
      realm_id: 'realm:patch-missing',
      access: 'read_write',
    });
    const ctx = {
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-missing',
      session_id: 'session:patch-missing',
      realm_id: 'realm:patch-missing',
      actor: 'agent:patch-applier',
      target_kind: 'page',
      target_id: 'concepts/patch-missing-target',
      base_target_snapshot_hash: null,
      patch_body: {
        type: 'concept',
        title: 'Patch Missing Target',
        compiled_truth: 'Created page body. [Source: User, direct message, 2026-04-26 12:20 PM KST]',
        timeline: '- **2026-04-26** | Patch created the page. [Source: User, direct message, 2026-04-26 12:20 PM KST]',
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 12:20 PM KST'],
    });
    await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-missing',
      session_id: 'session:patch-missing',
      realm_id: 'realm:patch-missing',
      actor: 'agent:patch-applier',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-26 12:20 PM KST'],
    });

    const applied = await applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-missing',
      session_id: 'session:patch-missing',
      realm_id: 'realm:patch-missing',
      actor: 'agent:patch-applier',
      source_refs: ['User, direct message, 2026-04-26 12:20 PM KST'],
    }) as any;

    expect(applied.status).toBe('applied');
    expect(applied.previous_target_snapshot_hash).toBeNull();
    const page = await engine.getPage('concepts/patch-missing-target');
    expect(page?.compiled_truth).toBe('Created page body. [Source: User, direct message, 2026-04-26 12:20 PM KST]');
    const applyEvents = await engine.listMemoryMutationEvents({
      operation: 'apply_memory_patch_candidate',
      target_kind: 'page',
      target_id: 'concepts/patch-missing-target',
      result: 'applied',
    });
    expect(applyEvents).toHaveLength(1);
    expect(applyEvents[0]?.expected_target_snapshot_hash).toBeNull();
    expect(applyEvents[0]?.current_target_snapshot_hash).toBe(page?.content_hash ?? null);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply_memory_patch_candidate conflicts when a missing page target appears before apply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-apply-missing-conflict-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!createPatch || !reviewPatch || !applyPatch) {
    throw new Error('memory patch review/apply operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-missing-conflict',
      name: 'Patch missing conflict realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-missing-conflict',
      actor_ref: 'agent:patch-applier',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-missing-conflict',
      realm_id: 'realm:patch-missing-conflict',
      access: 'read_write',
    });
    const ctx = {
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-missing-conflict',
      session_id: 'session:patch-missing-conflict',
      realm_id: 'realm:patch-missing-conflict',
      actor: 'agent:patch-applier',
      target_kind: 'page',
      target_id: 'concepts/patch-missing-conflict-target',
      base_target_snapshot_hash: null,
      patch_body: {
        compiled_truth: 'Patch body. [Source: User, direct message, 2026-04-26 12:30 PM KST]',
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 12:30 PM KST'],
    });
    await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-missing-conflict',
      session_id: 'session:patch-missing-conflict',
      realm_id: 'realm:patch-missing-conflict',
      actor: 'agent:patch-applier',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-26 12:30 PM KST'],
    });
    const concurrentPage = await engine.putPage('concepts/patch-missing-conflict-target', {
      type: 'concept',
      title: 'Patch Missing Conflict Target',
      compiled_truth: 'Concurrent page body. [Source: User, direct message, 2026-04-26 12:31 PM KST]',
      timeline: '',
    });

    await expect(applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-missing-conflict',
      session_id: 'session:patch-missing-conflict',
      realm_id: 'realm:patch-missing-conflict',
      actor: 'agent:patch-applier',
      source_refs: ['User, direct message, 2026-04-26 12:30 PM KST'],
    })).rejects.toMatchObject({
      code: 'write_conflict',
    });

    expect((await engine.getPage('concepts/patch-missing-conflict-target'))?.content_hash).toBe(concurrentPage.content_hash);
    const candidate = await engine.getMemoryCandidateEntry('patch-candidate-missing-conflict');
    expect(candidate?.patch_operation_state).toBe('conflicted');
    const conflictEvents = await engine.listMemoryMutationEvents({
      operation: 'apply_memory_patch_candidate',
      target_kind: 'page',
      target_id: 'concepts/patch-missing-conflict-target',
      result: 'conflict',
    });
    expect(conflictEvents).toHaveLength(1);
    expect(conflictEvents[0]?.expected_target_snapshot_hash).toBeNull();
    expect(conflictEvents[0]?.current_target_snapshot_hash).toBe(concurrentPage.content_hash ?? null);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply_memory_patch_candidate records conflicts without overwriting stale page targets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-apply-conflict-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!createPatch || !reviewPatch || !applyPatch) {
    throw new Error('memory patch review/apply operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-conflict',
      name: 'Patch conflict realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-conflict',
      actor_ref: 'agent:patch-applier',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-conflict',
      realm_id: 'realm:patch-conflict',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-conflict-target', {
      type: 'concept',
      title: 'Patch Conflict Target',
      compiled_truth: 'Original page body. [Source: User, direct message, 2026-04-26 12:10 PM KST]',
      timeline: '',
    });
    const ctx = {
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-conflict',
      session_id: 'session:patch-conflict',
      realm_id: 'realm:patch-conflict',
      actor: 'agent:patch-applier',
      target_kind: 'page',
      target_id: 'concepts/patch-conflict-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        compiled_truth: 'Stale patch body. [Source: User, direct message, 2026-04-26 12:11 PM KST]',
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 12:11 PM KST'],
    });
    await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-conflict',
      session_id: 'session:patch-conflict',
      realm_id: 'realm:patch-conflict',
      actor: 'agent:patch-applier',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-26 12:11 PM KST'],
    });
    const concurrentPage = await engine.putPage('concepts/patch-conflict-target', {
      type: 'concept',
      title: 'Patch Conflict Target',
      compiled_truth: 'Concurrent page body. [Source: User, direct message, 2026-04-26 12:12 PM KST]',
      timeline: '',
    });

    await expect(applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-conflict',
      session_id: 'session:patch-conflict',
      realm_id: 'realm:patch-conflict',
      actor: 'agent:patch-applier',
      source_refs: ['User, direct message, 2026-04-26 12:11 PM KST'],
    })).rejects.toMatchObject({
      code: 'write_conflict',
    });

    const currentPage = await engine.getPage('concepts/patch-conflict-target');
    expect(currentPage?.compiled_truth).toBe('Concurrent page body. [Source: User, direct message, 2026-04-26 12:12 PM KST]');

    const candidate = await engine.getMemoryCandidateEntry('patch-candidate-conflict');
    expect(candidate?.status).toBe('staged_for_review');
    expect(candidate?.patch_operation_state).toBe('conflicted');
    expect(candidate?.patch_ledger_event_ids).toHaveLength(3);

    const conflictEvents = await engine.listMemoryMutationEvents({
      operation: 'apply_memory_patch_candidate',
      target_kind: 'page',
      target_id: 'concepts/patch-conflict-target',
      result: 'conflict',
    });
    expect(conflictEvents).toHaveLength(1);
    expect(conflictEvents[0]?.expected_target_snapshot_hash).toBe(page.content_hash ?? null);
    expect(conflictEvents[0]?.current_target_snapshot_hash).toBe(concurrentPage.content_hash ?? null);
    expect(conflictEvents[0]?.metadata.candidate_id).toBe('patch-candidate-conflict');
    expect(conflictEvents[0]?.conflict_info?.reason).toBe('target_snapshot_hash_mismatch');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply_memory_patch_candidate fails without mutation when expected resulting hash does not match', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-apply-expected-hash-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!createPatch || !reviewPatch || !applyPatch) {
    throw new Error('memory patch review/apply operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-expected-hash',
      name: 'Patch expected hash realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-expected-hash',
      actor_ref: 'agent:patch-applier',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-expected-hash',
      realm_id: 'realm:patch-expected-hash',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-expected-hash-target', {
      type: 'concept',
      title: 'Patch Expected Hash Target',
      compiled_truth: 'Original page body. [Source: User, direct message, 2026-04-26 12:20 PM KST]',
      timeline: '',
    });
    const ctx = {
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-expected-hash',
      session_id: 'session:patch-expected-hash',
      realm_id: 'realm:patch-expected-hash',
      actor: 'agent:patch-applier',
      target_kind: 'page',
      target_id: 'concepts/patch-expected-hash-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        compiled_truth: 'Unexpected hash patch body. [Source: User, direct message, 2026-04-26 12:21 PM KST]',
      },
      patch_format: 'merge_patch',
      expected_resulting_target_snapshot_hash: '0'.repeat(64),
      source_refs: ['User, direct message, 2026-04-26 12:21 PM KST'],
    });
    await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-expected-hash',
      session_id: 'session:patch-expected-hash',
      realm_id: 'realm:patch-expected-hash',
      actor: 'agent:patch-applier',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-26 12:21 PM KST'],
    });

    await expect(applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-expected-hash',
      session_id: 'session:patch-expected-hash',
      realm_id: 'realm:patch-expected-hash',
      actor: 'agent:patch-applier',
      source_refs: ['User, direct message, 2026-04-26 12:21 PM KST'],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    const currentPage = await engine.getPage('concepts/patch-expected-hash-target');
    expect(currentPage?.compiled_truth).toBe('Original page body. [Source: User, direct message, 2026-04-26 12:20 PM KST]');

    const candidate = await engine.getMemoryCandidateEntry('patch-candidate-expected-hash');
    expect(candidate?.status).toBe('staged_for_review');
    expect(candidate?.patch_operation_state).toBe('failed');
    expect(candidate?.patch_ledger_event_ids).toHaveLength(3);

    const failedEvents = await engine.listMemoryMutationEvents({
      operation: 'apply_memory_patch_candidate',
      target_kind: 'page',
      target_id: 'concepts/patch-expected-hash-target',
      result: 'failed',
    });
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.conflict_info?.reason).toBe('expected_resulting_target_snapshot_hash_mismatch');
    expect(failedEvents[0]?.current_target_snapshot_hash).toBe(page.content_hash ?? null);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review_memory_patch_candidate denies unsupported apply formats with an audit event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-review-unsupported-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');

  if (!createPatch || !reviewPatch) {
    throw new Error('memory patch review operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-review-unsupported',
      name: 'Patch review unsupported realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-review-unsupported',
      actor_ref: 'agent:patch-reviewer',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-review-unsupported',
      realm_id: 'realm:patch-review-unsupported',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-review-unsupported-target', {
      type: 'concept',
      title: 'Patch Review Unsupported Target',
      compiled_truth: 'Original page body. [Source: User, direct message, 2026-04-26 12:30 PM KST]',
      timeline: '',
    });
    const ctx = { engine, config: {} as any, logger: console, dryRun: false };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-unsupported-json',
      session_id: 'session:patch-review-unsupported',
      realm_id: 'realm:patch-review-unsupported',
      actor: 'agent:patch-reviewer',
      target_kind: 'page',
      target_id: 'concepts/patch-review-unsupported-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: [
        {
          op: 'replace',
          path: '/compiled_truth',
          value: 'JSON Patch apply is not supported yet. [Source: User, direct message, 2026-04-26 12:31 PM KST]',
        },
      ],
      patch_format: 'json_patch',
      source_refs: ['User, direct message, 2026-04-26 12:31 PM KST'],
    });

    await expect(reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-unsupported-json',
      session_id: 'session:patch-review-unsupported',
      realm_id: 'realm:patch-review-unsupported',
      actor: 'agent:patch-reviewer',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-26 12:31 PM KST'],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    const candidate = await engine.getMemoryCandidateEntry('patch-candidate-unsupported-json');
    expect(candidate?.status).toBe('staged_for_review');
    expect(candidate?.patch_operation_state).toBe('proposed');
    expect(candidate?.patch_ledger_event_ids).toHaveLength(2);

    const deniedEvents = await engine.listMemoryMutationEvents({
      operation: 'review_memory_patch_candidate',
      target_kind: 'memory_candidate',
      target_id: 'patch-candidate-unsupported-json',
      result: 'denied',
    });
    expect(deniedEvents).toHaveLength(1);
    expect(deniedEvents[0]?.conflict_info?.reason).toBe('unsupported_patch_apply_surface');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review_memory_patch_candidate records denied audit events for invalid patch lifecycle states', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-review-lifecycle-denied-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');

  if (!createPatch || !reviewPatch) {
    throw new Error('memory patch review operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-review-lifecycle',
      name: 'Patch review lifecycle realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-review-lifecycle',
      actor_ref: 'agent:patch-reviewer',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-review-lifecycle',
      realm_id: 'realm:patch-review-lifecycle',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-review-lifecycle-target', {
      type: 'concept',
      title: 'Patch Review Lifecycle Target',
      compiled_truth: 'Original page body. [Source: User, direct message, 2026-04-26 12:35 PM KST]',
      timeline: '',
    });
    const ctx = { engine, config: {} as any, logger: console, dryRun: false };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-review-lifecycle',
      session_id: 'session:patch-review-lifecycle',
      realm_id: 'realm:patch-review-lifecycle',
      actor: 'agent:patch-reviewer',
      target_kind: 'page',
      target_id: 'concepts/patch-review-lifecycle-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        compiled_truth: 'Approved page body. [Source: User, direct message, 2026-04-26 12:36 PM KST]',
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 12:36 PM KST'],
    });
    await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-review-lifecycle',
      session_id: 'session:patch-review-lifecycle',
      realm_id: 'realm:patch-review-lifecycle',
      actor: 'agent:patch-reviewer',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-26 12:36 PM KST'],
    });

    await expect(reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-review-lifecycle',
      session_id: 'session:patch-review-lifecycle',
      realm_id: 'realm:patch-review-lifecycle',
      actor: 'agent:patch-reviewer',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-26 12:37 PM KST'],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    const candidate = await engine.getMemoryCandidateEntry('patch-candidate-review-lifecycle');
    expect(candidate?.status).toBe('staged_for_review');
    expect(candidate?.patch_operation_state).toBe('approved_for_apply');
    expect(candidate?.patch_ledger_event_ids).toHaveLength(3);

    const deniedEvents = await engine.listMemoryMutationEvents({
      operation: 'review_memory_patch_candidate',
      target_kind: 'memory_candidate',
      target_id: 'patch-candidate-review-lifecycle',
      result: 'denied',
    });
    expect(deniedEvents).toHaveLength(1);
    expect(deniedEvents[0]?.conflict_info?.reason).toBe('invalid_patch_candidate_lifecycle');
    expect(deniedEvents[0]?.metadata.previous_patch_operation_state).toBe('approved_for_apply');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply_memory_patch_candidate records denied audit events when patches are not approved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-apply-lifecycle-denied-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!createPatch || !applyPatch) {
    throw new Error('memory patch apply operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-apply-lifecycle',
      name: 'Patch apply lifecycle realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-apply-lifecycle',
      actor_ref: 'agent:patch-applier',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-apply-lifecycle',
      realm_id: 'realm:patch-apply-lifecycle',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-apply-lifecycle-target', {
      type: 'concept',
      title: 'Patch Apply Lifecycle Target',
      compiled_truth: 'Original page body. [Source: User, direct message, 2026-04-26 12:38 PM KST]',
      timeline: '',
    });
    const ctx = { engine, config: {} as any, logger: console, dryRun: false };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-apply-lifecycle',
      session_id: 'session:patch-apply-lifecycle',
      realm_id: 'realm:patch-apply-lifecycle',
      actor: 'agent:patch-applier',
      target_kind: 'page',
      target_id: 'concepts/patch-apply-lifecycle-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        compiled_truth: 'Unapproved page body. [Source: User, direct message, 2026-04-26 12:39 PM KST]',
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 12:39 PM KST'],
    });

    await expect(applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-apply-lifecycle',
      session_id: 'session:patch-apply-lifecycle',
      realm_id: 'realm:patch-apply-lifecycle',
      actor: 'agent:patch-applier',
      source_refs: ['User, direct message, 2026-04-26 12:39 PM KST'],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    const currentPage = await engine.getPage('concepts/patch-apply-lifecycle-target');
    expect(currentPage?.compiled_truth).toBe('Original page body. [Source: User, direct message, 2026-04-26 12:38 PM KST]');

    const candidate = await engine.getMemoryCandidateEntry('patch-candidate-apply-lifecycle');
    expect(candidate?.status).toBe('staged_for_review');
    expect(candidate?.patch_operation_state).toBe('proposed');
    expect(candidate?.patch_ledger_event_ids).toHaveLength(2);

    const deniedEvents = await engine.listMemoryMutationEvents({
      operation: 'apply_memory_patch_candidate',
      target_kind: 'page',
      target_id: 'concepts/patch-apply-lifecycle-target',
      result: 'denied',
    });
    expect(deniedEvents).toHaveLength(1);
    expect(deniedEvents[0]?.conflict_info?.reason).toBe('invalid_patch_candidate_lifecycle');
    expect(deniedEvents[0]?.metadata.previous_patch_operation_state).toBe('proposed');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply_memory_patch_candidate records materialization failures for invalid page patches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-apply-materialization-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!createPatch || !reviewPatch || !applyPatch) {
    throw new Error('memory patch review/apply operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-materialization',
      name: 'Patch materialization realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-materialization',
      actor_ref: 'agent:patch-applier',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-materialization',
      realm_id: 'realm:patch-materialization',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-materialization-target', {
      type: 'concept',
      title: 'Patch Materialization Target',
      compiled_truth: 'Original page body. [Source: User, direct message, 2026-04-26 12:40 PM KST]',
      timeline: '',
    });
    const ctx = { engine, config: {} as any, logger: console, dryRun: false };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-unsourced',
      session_id: 'session:patch-materialization',
      realm_id: 'realm:patch-materialization',
      actor: 'agent:patch-applier',
      target_kind: 'page',
      target_id: 'concepts/patch-materialization-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        compiled_truth: 'Unsourced replacement claim.',
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 12:41 PM KST'],
    });
    await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-unsourced',
      session_id: 'session:patch-materialization',
      realm_id: 'realm:patch-materialization',
      actor: 'agent:patch-applier',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-26 12:41 PM KST'],
    });

    await expect(applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-unsourced',
      session_id: 'session:patch-materialization',
      realm_id: 'realm:patch-materialization',
      actor: 'agent:patch-applier',
      source_refs: ['User, direct message, 2026-04-26 12:41 PM KST'],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    const currentPage = await engine.getPage('concepts/patch-materialization-target');
    expect(currentPage?.compiled_truth).toBe('Original page body. [Source: User, direct message, 2026-04-26 12:40 PM KST]');

    const candidate = await engine.getMemoryCandidateEntry('patch-candidate-unsourced');
    expect(candidate?.status).toBe('staged_for_review');
    expect(candidate?.patch_operation_state).toBe('failed');
    expect(candidate?.patch_ledger_event_ids).toHaveLength(3);

    const failedEvents = await engine.listMemoryMutationEvents({
      operation: 'apply_memory_patch_candidate',
      target_kind: 'page',
      target_id: 'concepts/patch-materialization-target',
      result: 'failed',
    });
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.conflict_info?.reason).toBe('patch_materialization_failed');
    expect(String(failedEvents[0]?.conflict_info?.error)).toContain('patch_body.compiled_truth');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review_memory_patch_candidate reject marks patch candidates terminal without applying content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-review-reject-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');

  if (!createPatch || !reviewPatch) {
    throw new Error('memory patch review operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-review-reject',
      name: 'Patch review reject realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-review-reject',
      actor_ref: 'agent:patch-reviewer',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-review-reject',
      realm_id: 'realm:patch-review-reject',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-review-reject-target', {
      type: 'concept',
      title: 'Patch Review Reject Target',
      compiled_truth: 'Original page body. [Source: User, direct message, 2026-04-26 12:50 PM KST]',
      timeline: '',
    });
    const ctx = { engine, config: {} as any, logger: console, dryRun: false };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-review-reject',
      session_id: 'session:patch-review-reject',
      realm_id: 'realm:patch-review-reject',
      actor: 'agent:patch-reviewer',
      target_kind: 'page',
      target_id: 'concepts/patch-review-reject-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        compiled_truth: 'Rejected page body. [Source: User, direct message, 2026-04-26 12:51 PM KST]',
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 12:51 PM KST'],
    });

    const rejected = await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-review-reject',
      session_id: 'session:patch-review-reject',
      realm_id: 'realm:patch-review-reject',
      actor: 'agent:patch-reviewer',
      decision: 'reject',
      review_reason: 'Reviewer rejected the proposed canonical note change.',
      source_refs: ['User, direct message, 2026-04-26 12:52 PM KST'],
    }) as any;

    expect(rejected.status).toBe('rejected');
    expect(rejected.patch_operation_state).toBe('failed');
    expect(rejected.patch_ledger_event_ids).toHaveLength(2);
    expect((await engine.getPage('concepts/patch-review-reject-target'))?.compiled_truth).toBe(
      'Original page body. [Source: User, direct message, 2026-04-26 12:50 PM KST]',
    );

    const deniedEvents = await engine.listMemoryMutationEvents({
      operation: 'review_memory_patch_candidate',
      target_kind: 'memory_candidate',
      target_id: 'patch-candidate-review-reject',
      result: 'denied',
    });
    expect(deniedEvents).toHaveLength(1);
    expect(deniedEvents[0]?.metadata.decision).toBe('reject');

    const statusEvents = await engine.listMemoryCandidateStatusEvents({
      candidate_id: 'patch-candidate-review-reject',
    });
    expect(statusEvents.map((event) => event.event_kind).sort()).toEqual(['created', 'rejected']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply_memory_patch_candidate rejects reserved frontmatter metadata patches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-apply-reserved-frontmatter-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!createPatch || !reviewPatch || !applyPatch) {
    throw new Error('memory patch review/apply operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-frontmatter',
      name: 'Patch frontmatter realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-frontmatter',
      actor_ref: 'agent:patch-applier',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-frontmatter',
      realm_id: 'realm:patch-frontmatter',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-frontmatter-target', {
      type: 'concept',
      title: 'Patch Frontmatter Target',
      compiled_truth: 'Original page body. [Source: User, direct message, 2026-04-26 1:00 PM KST]',
      timeline: '',
      frontmatter: { status: 'active' },
    });
    const ctx = { engine, config: {} as any, logger: console, dryRun: false };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-reserved-frontmatter',
      session_id: 'session:patch-frontmatter',
      realm_id: 'realm:patch-frontmatter',
      actor: 'agent:patch-applier',
      target_kind: 'page',
      target_id: 'concepts/patch-frontmatter-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        compiled_truth: 'Frontmatter reserved key patch body. [Source: User, direct message, 2026-04-26 1:01 PM KST]',
        frontmatter: { type: 'person' },
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 1:01 PM KST'],
    });
    await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-reserved-frontmatter',
      session_id: 'session:patch-frontmatter',
      realm_id: 'realm:patch-frontmatter',
      actor: 'agent:patch-applier',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-26 1:01 PM KST'],
    });

    await expect(applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-reserved-frontmatter',
      session_id: 'session:patch-frontmatter',
      realm_id: 'realm:patch-frontmatter',
      actor: 'agent:patch-applier',
      source_refs: ['User, direct message, 2026-04-26 1:01 PM KST'],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    const currentPage = await engine.getPage('concepts/patch-frontmatter-target');
    expect(currentPage?.type).toBe('concept');
    expect(currentPage?.frontmatter).toEqual({ status: 'active' });

    const candidate = await engine.getMemoryCandidateEntry('patch-candidate-reserved-frontmatter');
    expect(candidate?.patch_operation_state).toBe('failed');
    const failedEvents = await engine.listMemoryMutationEvents({
      operation: 'apply_memory_patch_candidate',
      target_kind: 'page',
      target_id: 'concepts/patch-frontmatter-target',
      result: 'failed',
    });
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.conflict_info?.reason).toBe('patch_materialization_failed');
    expect(String(failedEvents[0]?.conflict_info?.error)).toContain('reserved page metadata field: type');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply_memory_patch_candidate requires source-attributed text context for frontmatter patches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-apply-frontmatter-source-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!createPatch || !reviewPatch || !applyPatch) {
    throw new Error('memory patch review/apply operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-frontmatter-source',
      name: 'Patch frontmatter source realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-frontmatter-source',
      actor_ref: 'agent:patch-applier',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-frontmatter-source',
      realm_id: 'realm:patch-frontmatter-source',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-frontmatter-source-target', {
      type: 'concept',
      title: 'Patch Frontmatter Source Target',
      compiled_truth: 'Original page body. [Source: User, direct message, 2026-04-26 1:05 PM KST]',
      timeline: '',
      frontmatter: { status: 'active' },
    });
    const ctx = { engine, config: {} as any, logger: console, dryRun: false };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-frontmatter-source',
      session_id: 'session:patch-frontmatter-source',
      realm_id: 'realm:patch-frontmatter-source',
      actor: 'agent:patch-applier',
      target_kind: 'page',
      target_id: 'concepts/patch-frontmatter-source-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        frontmatter: { status: 'updated' },
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 1:06 PM KST'],
    });
    await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-frontmatter-source',
      session_id: 'session:patch-frontmatter-source',
      realm_id: 'realm:patch-frontmatter-source',
      actor: 'agent:patch-applier',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-26 1:06 PM KST'],
    });

    await expect(applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-frontmatter-source',
      session_id: 'session:patch-frontmatter-source',
      realm_id: 'realm:patch-frontmatter-source',
      actor: 'agent:patch-applier',
      source_refs: ['User, direct message, 2026-04-26 1:06 PM KST'],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    const currentPage = await engine.getPage('concepts/patch-frontmatter-source-target');
    expect(currentPage?.frontmatter).toEqual({ status: 'active' });

    const failedEvents = await engine.listMemoryMutationEvents({
      operation: 'apply_memory_patch_candidate',
      target_kind: 'page',
      target_id: 'concepts/patch-frontmatter-source-target',
      result: 'failed',
    });
    expect(failedEvents).toHaveLength(1);
    expect(String(failedEvents[0]?.conflict_info?.error)).toContain('metadata merge_patch fields');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply_memory_patch_candidate strips reserved frontmatter already present on page targets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-apply-existing-reserved-frontmatter-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!createPatch || !reviewPatch || !applyPatch) {
    throw new Error('memory patch review/apply operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-existing-frontmatter',
      name: 'Patch existing frontmatter realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-existing-frontmatter',
      actor_ref: 'agent:patch-applier',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-existing-frontmatter',
      realm_id: 'realm:patch-existing-frontmatter',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-existing-frontmatter-target', {
      type: 'concept',
      title: 'Patch Existing Frontmatter Target',
      compiled_truth: 'Original page body. [Source: User, direct message, 2026-04-26 1:07 PM KST]',
      timeline: '',
      frontmatter: {
        status: 'active',
        type: 'person',
        title: 'Overriding Title',
        tags: ['bad'],
        slug: 'people/bad',
      },
    });
    const ctx = { engine, config: {} as any, logger: console, dryRun: false };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-existing-frontmatter',
      session_id: 'session:patch-existing-frontmatter',
      realm_id: 'realm:patch-existing-frontmatter',
      actor: 'agent:patch-applier',
      target_kind: 'page',
      target_id: 'concepts/patch-existing-frontmatter-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        compiled_truth: 'Updated page body. [Source: User, direct message, 2026-04-26 1:08 PM KST]',
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 1:08 PM KST'],
    });
    await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-existing-frontmatter',
      session_id: 'session:patch-existing-frontmatter',
      realm_id: 'realm:patch-existing-frontmatter',
      actor: 'agent:patch-applier',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-26 1:08 PM KST'],
    });
    await applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-existing-frontmatter',
      session_id: 'session:patch-existing-frontmatter',
      realm_id: 'realm:patch-existing-frontmatter',
      actor: 'agent:patch-applier',
      source_refs: ['User, direct message, 2026-04-26 1:08 PM KST'],
    });

    const updatedPage = await engine.getPage('concepts/patch-existing-frontmatter-target');
    expect(updatedPage?.type).toBe('concept');
    expect(updatedPage?.title).toBe('Patch Existing Frontmatter Target');
    expect(updatedPage?.frontmatter).toEqual({ status: 'active' });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review and apply memory patch candidate work through the PGLite engine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-patch-apply-pglite-'));
  const engine = new PGLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const applyPatch = operations.find((operation) => operation.name === 'apply_memory_patch_candidate');

  if (!createPatch || !reviewPatch || !applyPatch) {
    throw new Error('memory patch review/apply operations are missing');
  }

  try {
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:patch-apply-pglite',
      name: 'Patch apply PGLite realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:patch-apply-pglite',
      actor_ref: 'agent:patch-applier',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:patch-apply-pglite',
      realm_id: 'realm:patch-apply-pglite',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/patch-apply-pglite-target', {
      type: 'concept',
      title: 'Patch Apply PGLite Target',
      compiled_truth: 'Original PGLite page body. [Source: User, direct message, 2026-04-26 1:10 PM KST]',
      timeline: '',
    });
    const ctx = { engine, config: {} as any, logger: console, dryRun: false };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-apply-pglite',
      session_id: 'session:patch-apply-pglite',
      realm_id: 'realm:patch-apply-pglite',
      actor: 'agent:patch-applier',
      target_kind: 'page',
      target_id: 'concepts/patch-apply-pglite-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        compiled_truth: 'Applied PGLite page body. [Source: User, direct message, 2026-04-26 1:11 PM KST]',
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 1:11 PM KST'],
    });
    await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-apply-pglite',
      session_id: 'session:patch-apply-pglite',
      realm_id: 'realm:patch-apply-pglite',
      actor: 'agent:patch-applier',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-26 1:11 PM KST'],
    });
    await applyPatch.handler(ctx, {
      candidate_id: 'patch-candidate-apply-pglite',
      session_id: 'session:patch-apply-pglite',
      realm_id: 'realm:patch-apply-pglite',
      actor: 'agent:patch-applier',
      source_refs: ['User, direct message, 2026-04-26 1:11 PM KST'],
    });

    const updatedPage = await engine.getPage('concepts/patch-apply-pglite-target');
    expect(updatedPage?.compiled_truth).toBe(
      'Applied PGLite page body. [Source: User, direct message, 2026-04-26 1:11 PM KST]',
    );
    const candidate = await engine.getMemoryCandidateEntry('patch-candidate-apply-pglite');
    expect(candidate?.status).toBe('promoted');
    expect(candidate?.patch_operation_state).toBe('applied');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox candidate create operations normalize score fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-candidate-score-normalization-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');

  if (!create || !createPatch) {
    throw new Error('memory inbox create operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:score-normalization',
      name: 'Score normalization realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:score-normalization',
      actor_ref: 'agent:score-normalization',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:score-normalization',
      realm_id: 'realm:score-normalization',
      access: 'read_write',
    });
    const page = await engine.putPage('concepts/score-normalization-target', {
      type: 'concept',
      title: 'Score Normalization Target',
      compiled_truth: 'Original compiled truth. [Source: User, direct message, 2026-04-26 11:00 AM KST]',
      timeline: '',
    });

    const ctx = {
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    };

    const created = await create.handler(ctx, {
      id: 'candidate-score-normalized',
      candidate_type: 'fact',
      proposed_content: 'Candidate scores should be safe normalized numbers.',
      source_ref: 'User, direct message, 2026-04-26 11:00 AM KST',
      confidence_score: Number.NaN,
      importance_score: Number.POSITIVE_INFINITY,
      recurrence_score: -3,
    }) as any;
    expect(created.confidence_score).toBe(0.5);
    expect(created.importance_score).toBe(0.5);
    expect(created.recurrence_score).toBe(0);

    const patchPreview = await createPatch.handler({
      ...ctx,
      dryRun: true,
    }, {
      id: 'patch-score-normalized',
      session_id: 'session:score-normalization',
      realm_id: 'realm:score-normalization',
      actor: 'agent:score-normalization',
      scope_id: 'workspace:default',
      target_kind: 'page',
      target_id: 'concepts/score-normalization-target',
      base_target_snapshot_hash: page.content_hash,
      patch_body: {
        compiled_truth: 'Updated compiled truth. [Source: User, direct message, 2026-04-26 11:00 AM KST]',
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-26 11:00 AM KST'],
      confidence_score: 1.7,
      importance_score: -2,
      recurrence_score: Number.NEGATIVE_INFINITY,
    }) as any;
    expect(patchPreview.candidate.confidence_score).toBe(1);
    expect(patchPreview.candidate.importance_score).toBe(0);
    expect(patchPreview.candidate.recurrence_score).toBe(0);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create_memory_candidate_entry rejects patch-only fields through the generic candidate path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-candidate-patch-bypass-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');

  if (!create) {
    throw new Error('memory candidate create operation is missing');
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
      candidate_type: 'fact',
      proposed_content: 'Generic create must not accept patch lifecycle fields.',
      source_ref: 'User, direct message, 2026-04-26 11:00 AM KST',
      patch_operation_state: 'applied',
      patch_ledger_event_ids: ['fake-ledger-event'],
    })).rejects.toThrow(/create_memory_patch_candidate/);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
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
  const verify = operations.find((operation) => operation.name === 'verify_memory_candidate_entry');
  const preflight = operations.find((operation) => operation.name === 'preflight_promote_memory_candidate');

  if (!create || !advance || !verify || !preflight) {
    throw new Error('memory inbox create/advance/verify/preflight operations are missing');
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

    await verify.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-preflight',
      verification_status: 'verified',
      verification_method: 'source_recheck',
      verification_evidence: 'Verified before promotion preflight.',
      verification_source_refs: ['Source: memory inbox operation verification fixture'],
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
  const verify = operations.find((operation) => operation.name === 'verify_memory_candidate_entry');
  const promote = operations.find((operation) => operation.name === 'promote_memory_candidate_entry');
  const listStatusEvents = operations.find((operation) => operation.name === 'list_memory_candidate_status_events');

  if (!create || !advance || !verify || !promote || !listStatusEvents) {
    throw new Error('memory inbox create/advance/verify/promote operations are missing');
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
    await verify.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-promote',
      verification_status: 'verified',
      verification_method: 'source_recheck',
      verification_evidence: 'Verified before promotion operation.',
      verification_source_refs: ['Source: memory inbox operation verification fixture'],
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
    // Promotion only flips status; it does not write retrievable markdown. The hint keeps
    // that explicit so a governed candidate lifecycle is not mistaken for "done" (D2).
    expect((promoted as any).canonical_write_pending).toBe(true);
    expect((promoted as any).canonical_write_hint).toContain('not yet retrievable');
    expect((promoted as any).canonical_write_hint).not.toContain('bind_and_promote');

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

    await expect(promote.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-promote',
      retry_on_stale: 'true',
    })).rejects.toMatchObject({
      code: 'invalid_params',
      message: 'retry_on_stale must be a boolean',
    });

    await expect(promote.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-promote',
      override_duplicate: 'true',
    })).rejects.toMatchObject({
      code: 'invalid_params',
      message: 'override_duplicate must be a boolean',
    });

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

test('finalize_memory_candidate verifies, stages, promotes, and resumes standard candidates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-finalize-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const finalize = operations.find((operation) => operation.name === 'finalize_memory_candidate');

  if (!create || !finalize) {
    throw new Error('memory inbox create/finalize operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    const ctx = { engine, config: {} as any, logger: console, dryRun: false };

    await create.handler(ctx, {
      id: 'candidate-finalize',
      candidate_type: 'fact',
      proposed_content: 'Composite finalize should complete the candidate lifecycle.',
      source_ref: 'User, direct message, 2026-04-24 09:00 AM KST',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/finalize-memory-candidate',
    });

    const result = await finalize.handler(ctx, {
      id: 'candidate-finalize',
      verification_status: 'verified',
      verification_method: 'source_recheck',
      verification_evidence: 'Checked the source ref before finalization.',
      verification_source_refs: ['Source: memory inbox finalize fixture'],
      review_reason: 'Composite finalize promotion.',
      interaction_id: ' trace-finalize ',
    }) as any;

    expect(result.status).toBe('promoted');
    expect(result.candidate.status).toBe('promoted');
    expect(result.canonical_write_pending).toBe(true);
    expect(result.ledger.map((step: any) => [step.step, step.status])).toEqual([
      ['verify', 'applied'],
      ['advance_to_candidate', 'applied'],
      ['advance_to_staged', 'applied'],
      ['preflight', 'allowed'],
      ['promote', 'applied'],
      ['patch_apply', 'skipped'],
      ['sync', 'skipped'],
    ]);

    const resumed = await finalize.handler(ctx, {
      id: 'candidate-finalize',
      verification_status: 'verified',
      verification_method: 'source_recheck',
      verification_evidence: 'Checked the source ref before finalization.',
      verification_source_refs: ['Source: memory inbox finalize fixture'],
    }) as any;

    expect(resumed.status).toBe('promoted');
    expect(resumed.ledger.map((step: any) => [step.step, step.status])).toEqual([
      ['verify', 'already_done'],
      ['advance_to_candidate', 'already_done'],
      ['advance_to_staged', 'already_done'],
      ['preflight', 'skipped'],
      ['promote', 'already_done'],
      ['patch_apply', 'skipped'],
      ['sync', 'skipped'],
    ]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalize_memory_candidate stops at the first defer when verification input is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-finalize-defer-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const finalize = operations.find((operation) => operation.name === 'finalize_memory_candidate');

  if (!create || !finalize) {
    throw new Error('memory inbox create/finalize operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    const ctx = { engine, config: {} as any, logger: console, dryRun: false };

    await create.handler(ctx, {
      id: 'candidate-finalize-defer',
      candidate_type: 'fact',
      proposed_content: 'Composite finalize should not guess verification evidence.',
      source_ref: 'User, direct message, 2026-04-24 09:10 AM KST',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/finalize-memory-candidate',
    });

    const result = await finalize.handler(ctx, {
      id: 'candidate-finalize-defer',
    }) as any;

    expect(result.status).toBe('deferred');
    expect(result.ledger).toEqual([
      {
        step: 'verify',
        status: 'deferred',
        reason: 'verification_required',
      },
    ]);
    const candidate = await engine.getMemoryCandidateEntry('candidate-finalize-defer');
    expect(candidate?.status).toBe('captured');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalize_memory_candidate applies approved page patch candidates through the existing apply path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-finalize-patch-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const createPatch = operations.find((operation) => operation.name === 'create_memory_patch_candidate');
  const reviewPatch = operations.find((operation) => operation.name === 'review_memory_patch_candidate');
  const finalize = operations.find((operation) => operation.name === 'finalize_memory_candidate');

  if (!createPatch || !reviewPatch || !finalize) {
    throw new Error('memory patch create/review/finalize operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.upsertMemoryRealm({
      id: 'realm:finalize-patch',
      name: 'Finalize patch realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await engine.createMemorySession({
      id: 'session:finalize-patch',
      actor_ref: 'agent:finalize-patch',
    });
    await engine.attachMemoryRealmToSession({
      session_id: 'session:finalize-patch',
      realm_id: 'realm:finalize-patch',
      access: 'read_write',
    });
    const ctx = { engine, config: {} as any, logger: console, dryRun: false };

    await createPatch.handler(ctx, {
      id: 'patch-candidate-finalize',
      session_id: 'session:finalize-patch',
      realm_id: 'realm:finalize-patch',
      actor: 'agent:finalize-patch',
      target_kind: 'page',
      target_id: 'concepts/finalize-patch-target',
      base_target_snapshot_hash: null,
      patch_body: {
        type: 'concept',
        title: 'Finalize Patch Target',
        compiled_truth: 'Composite finalize created this page. [Source: User, direct message, 2026-04-24 09:20 AM KST]',
        timeline: '- **2026-04-24** | Composite finalize applied the patch. [Source: User, direct message, 2026-04-24 09:20 AM KST]',
      },
      patch_format: 'merge_patch',
      source_refs: ['User, direct message, 2026-04-24 09:20 AM KST'],
    });
    await reviewPatch.handler(ctx, {
      candidate_id: 'patch-candidate-finalize',
      session_id: 'session:finalize-patch',
      realm_id: 'realm:finalize-patch',
      actor: 'agent:finalize-patch',
      decision: 'approve',
      source_refs: ['User, direct message, 2026-04-24 09:20 AM KST'],
    });

    const result = await finalize.handler(ctx, {
      id: 'patch-candidate-finalize',
      session_id: 'session:finalize-patch',
      realm_id: 'realm:finalize-patch',
      actor: 'agent:finalize-patch',
      source_refs: ['User, direct message, 2026-04-24 09:20 AM KST'],
    }) as any;

    expect(result.status).toBe('applied');
    expect(result.candidate.status).toBe('promoted');
    expect(result.ledger.map((step: any) => [step.step, step.status])).toEqual([
      ['verify', 'skipped'],
      ['advance_to_candidate', 'already_done'],
      ['advance_to_staged', 'already_done'],
      ['preflight', 'skipped'],
      ['promote', 'skipped'],
      ['patch_apply', 'applied'],
      ['sync', 'skipped'],
    ]);
    const page = await engine.getPage('concepts/finalize-patch-target');
    expect(page?.compiled_truth).toContain('Composite finalize created this page.');
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
  const verify = operations.find((operation) => operation.name === 'verify_memory_candidate_entry');
  const promote = operations.find((operation) => operation.name === 'promote_memory_candidate_entry');
  const supersede = operations.find((operation) => operation.name === 'supersede_memory_candidate_entry');
  const listStatusEvents = operations.find((operation) => operation.name === 'list_memory_candidate_status_events');

  if (!create || !advance || !verify || !promote || !supersede || !listStatusEvents) {
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
      await verify.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
        id,
        verification_status: 'verified',
        verification_method: 'source_recheck',
        verification_evidence: `Verified ${id} before supersession operation.`,
        verification_source_refs: ['Source: memory inbox operation verification fixture'],
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
