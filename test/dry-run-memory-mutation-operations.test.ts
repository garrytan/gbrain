import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, operations } from '../src/core/operations.ts';
import type { Operation, OperationContext } from '../src/core/operations.ts';
import {
  memorySessionAttachmentTargetId,
  resolveTargetSnapshotHash,
} from '../src/core/services/target-snapshot-hash-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

function getOperation(name: string): Operation {
  const operation = operations.find((candidate) => candidate.name === name);
  if (!operation) throw new Error(`Operation not found: ${name}`);
  return operation;
}

async function createSqliteHarness(label: string): Promise<{
  engine: SQLiteEngine;
  ctx: (dryRun?: boolean) => OperationContext;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-dry-run-memory-mutation-${label}-`));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();
  return {
    engine,
    ctx: (dryRun = false) => ({
      engine: engine as unknown as BrainEngine,
      config: {
        engine: 'sqlite',
        database_path: databasePath,
        offline: true,
        embedding_provider: 'local',
        query_rewrite_provider: 'heuristic',
      },
      logger: console,
      dryRun,
    }),
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedSessionRealmTarget(
  engine: SQLiteEngine,
  input: {
    session_id: string;
    realm_id: string;
    access: 'read_only' | 'read_write';
    realm_scope?: 'work' | 'personal' | 'mixed';
    actor_ref?: string | null;
    target_id?: string;
    target_hash?: string;
  },
): Promise<string> {
  const targetId = input.target_id ?? `concepts/${input.session_id}-target`;
  const targetHash = input.target_hash ?? '0'.repeat(64);
  await engine.upsertMemoryRealm({
    id: input.realm_id,
    name: `Realm ${input.realm_id}`,
    scope: input.realm_scope ?? 'work',
    default_access: 'read_write',
  });
  await engine.createMemorySession({
    id: input.session_id,
    actor_ref: input.actor_ref ?? 'agent:dry-run-test',
    expires_at: new Date('2999-01-01T00:00:00.000Z'),
  });
  await engine.attachMemoryRealmToSession({
    session_id: input.session_id,
    realm_id: input.realm_id,
    access: input.access,
    instructions: `Attachment for ${input.access} dry-run mutation validation.`,
  });
  await engine.putPage(targetId, {
    type: 'concept',
    title: `Target ${input.session_id}`,
    compiled_truth: 'The dry-run validation target must not be mutated.',
    timeline: '- 2026-04-26: Seeded by dry-run mutation operation test.',
    content_hash: targetHash,
  });
  return targetId;
}

test('dry_run_memory_mutation is exposed through operations and MCP-style schema generation', () => {
  const operation = getOperation('dry_run_memory_mutation');
  expect(operation.mutating).toBe(true);
  expect(operation.params.session_id.required).toBe(true);
  expect(operation.params.realm_id.required).toBe(true);
  expect(operation.params.target_kind.required).toBe(true);
  expect(operation.params.target_id.required).toBe(true);
  expect(operation.params.operation.required).toBe(true);
  expect(operation.params.source_refs.required).toBe(true);
  expect(operation.params.dry_run.type).toBe('boolean');
  expect(operation.params.operation.enum).toContain('put_page');
  expect(operation.params.operation.enum).not.toContain('create_memory_session');
  expect(operation.params.operation.enum).not.toContain('upsert_memory_realm');
  expect(operation.params.operation.enum).not.toContain('record_memory_mutation_event');
  expect(operation.params.operation.enum).not.toContain('repair_memory_ledger');
  expect(operation.params.operation.enum).not.toContain('physical_delete_memory_record');
  expect(operation.params.target_kind.enum).toContain('page');
  expect(operation.params.target_kind.enum).toContain('profile_memory');
  expect(operation.params.target_kind.enum).not.toContain('source_record');

  const mcpSchema = {
    required: Object.entries(operation.params)
      .filter(([, value]) => value.required)
      .map(([key]) => key),
  };
  expect(mcpSchema.required).toEqual([
    'session_id',
    'realm_id',
    'target_kind',
    'target_id',
    'operation',
    'source_refs',
  ]);
});

test('dry_run_memory_mutation records a dry-run ledger event for a read-write attached realm', async () => {
  const harness = await createSqliteHarness('allowed');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    const targetId = await seedSessionRealmTarget(harness.engine, {
      session_id: 'session-allowed',
      realm_id: 'realm:allowed',
      access: 'read_write',
      target_hash: '1'.repeat(64),
    });
    const current = await resolveTargetSnapshotHash(harness.engine as unknown as BrainEngine, {
      target_kind: 'page',
      target_id: targetId,
    });

    const result = await operation.handler(harness.ctx(), {
      session_id: 'session-allowed',
      realm_id: 'realm:allowed',
      operation: 'put_page',
      target_kind: 'page',
      target_id: targetId,
      scope_id: 'work:phase9',
      source_refs: [' Source: dry-run mutation allowed test '],
    }) as any;

    expect(result).toMatchObject({
      action: 'dry_run_memory_mutation',
      allowed: true,
      result: 'dry_run',
      ledger_recorded: true,
      target_kind: 'page',
      target_id: targetId,
      expected_target_snapshot_hash: null,
      current_target_snapshot_hash: current?.target_snapshot_hash,
      policy_checks: {
        source_refs: true,
        operation_allowed: true,
        session_active: true,
        realm_active: true,
        attachment_read_write: true,
        scope_allowed: true,
        target_resolved: true,
        target_snapshot_hash_matched: true,
      },
    });
    expect(typeof result.event_id).toBe('string');

    const events = await harness.engine.listMemoryMutationEvents({
      session_id: 'session-allowed',
      operation: 'dry_run_memory_mutation',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: result.event_id,
      session_id: 'session-allowed',
      realm_id: 'realm:allowed',
      actor: 'agent:dry-run-test',
      operation: 'dry_run_memory_mutation',
      target_kind: 'page',
      target_id: targetId,
      scope_id: 'work:phase9',
      expected_target_snapshot_hash: null,
      current_target_snapshot_hash: current?.target_snapshot_hash,
      result: 'dry_run',
      dry_run: true,
      metadata: {
        requested_operation: 'put_page',
      },
    });
    expect(events[0].source_refs).toEqual(['Source: dry-run mutation allowed test']);
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation defaults omitted page scope to workspace default', async () => {
  const harness = await createSqliteHarness('page-default-scope');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    const targetId = await seedSessionRealmTarget(harness.engine, {
      session_id: 'session-page-default-scope',
      realm_id: 'realm:page-default-scope',
      access: 'read_write',
      target_hash: '8'.repeat(64),
    });

    const existingResult = await operation.handler(harness.ctx(), {
      session_id: 'session-page-default-scope',
      realm_id: 'realm:page-default-scope',
      operation: 'put_page',
      target_kind: 'page',
      target_id: targetId,
      source_refs: ['Source: dry-run page default scope test'],
    }) as any;
    expect(existingResult).toMatchObject({
      allowed: true,
      result: 'dry_run',
      current_target_snapshot_hash: '8'.repeat(64),
      policy_checks: {
        scope_allowed: true,
        target_resolved: true,
      },
    });

    const missingResult = await operation.handler(harness.ctx(), {
      session_id: 'session-page-default-scope',
      realm_id: 'realm:page-default-scope',
      operation: 'put_page',
      target_kind: 'page',
      target_id: 'concepts/new-page-default-scope',
      source_refs: ['Source: dry-run missing page default scope test'],
    }) as any;
    expect(missingResult).toMatchObject({
      allowed: true,
      result: 'dry_run',
      current_target_snapshot_hash: null,
      policy_checks: {
        scope_allowed: true,
        target_resolved: false,
      },
    });

    const events = await harness.engine.listMemoryMutationEvents({
      session_id: 'session-page-default-scope',
      operation: 'dry_run_memory_mutation',
    });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.scope_id)).toEqual([
      'workspace:default',
      'workspace:default',
    ]);
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation denies read-only attachments and records a denied ledger event', async () => {
  const harness = await createSqliteHarness('read-only');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    const targetId = await seedSessionRealmTarget(harness.engine, {
      session_id: 'session-read-only',
      realm_id: 'realm:read-only',
      access: 'read_only',
      target_hash: '2'.repeat(64),
    });

    const result = await operation.handler(harness.ctx(), {
      session_id: 'session-read-only',
      realm_id: 'realm:read-only',
      operation: 'put_page',
      target_kind: 'page',
      target_id: targetId,
      source_refs: ['Source: dry-run mutation read-only denial test'],
    }) as any;

    expect(result).toMatchObject({
      action: 'dry_run_memory_mutation',
      allowed: false,
      result: 'denied',
      ledger_recorded: true,
      target_kind: 'page',
      target_id: targetId,
      policy_checks: {
        attachment_read_write: false,
      },
    });
    expect('current_target_snapshot_hash' in result).toBe(true);
    expect(typeof result.event_id).toBe('string');

    const events = await harness.engine.listMemoryMutationEvents({
      session_id: 'session-read-only',
      operation: 'dry_run_memory_mutation',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: result.event_id,
      result: 'denied',
      dry_run: false,
      operation: 'dry_run_memory_mutation',
      metadata: {
        requested_operation: 'put_page',
      },
    });
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation reports stale target snapshot hashes as conflicts without mutating the target', async () => {
  const harness = await createSqliteHarness('conflict');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    const targetId = await seedSessionRealmTarget(harness.engine, {
      session_id: 'session-conflict',
      realm_id: 'realm:conflict',
      access: 'read_write',
      target_hash: '3'.repeat(64),
    });
    const before = await harness.engine.getPage(targetId);

    const result = await operation.handler(harness.ctx(), {
      session_id: 'session-conflict',
      realm_id: 'realm:conflict',
      operation: 'put_page',
      target_kind: 'page',
      target_id: targetId,
      scope_id: 'work:phase9',
      expected_target_snapshot_hash: '4'.repeat(64),
      source_refs: ['Source: dry-run mutation conflict test'],
    }) as any;

    expect(result).toMatchObject({
      action: 'dry_run_memory_mutation',
      allowed: false,
      result: 'conflict',
      ledger_recorded: true,
      target_kind: 'page',
      target_id: targetId,
      expected_target_snapshot_hash: '4'.repeat(64),
      current_target_snapshot_hash: '3'.repeat(64),
      policy_checks: {
        target_resolved: true,
        target_snapshot_hash_matched: false,
      },
      conflict_info: {
        reason: 'target_snapshot_hash_mismatch',
        legacy_reason: 'content_hash_mismatch',
      },
    });

    const after = await harness.engine.getPage(targetId);
    expect(after?.compiled_truth).toBe(before?.compiled_truth);
    expect(after?.timeline).toBe(before?.timeline);

    const events = await harness.engine.listMemoryMutationEvents({
      session_id: 'session-conflict',
      operation: 'dry_run_memory_mutation',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: result.event_id,
      result: 'conflict',
      dry_run: false,
      expected_target_snapshot_hash: '4'.repeat(64),
      current_target_snapshot_hash: '3'.repeat(64),
      conflict_info: {
        reason: 'target_snapshot_hash_mismatch',
        legacy_reason: 'content_hash_mismatch',
      },
    });
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation denies personal scoped targets through a work realm', async () => {
  const harness = await createSqliteHarness('target-scope-denied');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    await harness.engine.upsertMemoryRealm({
      id: 'realm:work-only',
      name: 'Work Only Realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await harness.engine.createMemorySession({
      id: 'session-work-only',
      actor_ref: 'agent:scope-test',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: 'session-work-only',
      realm_id: 'realm:work-only',
      access: 'read_write',
    });

    const targets = [
      {
        target_kind: 'profile_memory',
        target_id: 'profile:personal-target',
        operation: 'write_profile_memory_entry',
        seed: () => harness.engine.upsertProfileMemoryEntry({
          id: 'profile:personal-target',
          scope_id: 'personal:default',
          profile_type: 'preference',
          subject: 'scope',
          content: 'Personal target must not validate through work realm.',
          source_refs: ['Source: dry-run target scope test'],
          sensitivity: 'personal',
          export_status: 'private_only',
        }),
      },
      {
        target_kind: 'personal_episode',
        target_id: 'episode:personal-target',
        operation: 'delete_personal_episode_entry',
        seed: () => harness.engine.createPersonalEpisodeEntry({
          id: 'episode:personal-target',
          scope_id: 'personal:default',
          title: 'Personal Target',
          start_time: new Date('2026-04-26T00:00:00.000Z'),
          source_kind: 'chat',
          summary: 'Personal episode target must not validate through work realm.',
          source_refs: ['Source: dry-run target scope test'],
          candidate_ids: [],
        }),
      },
      {
        target_kind: 'memory_candidate',
        target_id: 'candidate:personal-target',
        operation: 'advance_memory_candidate_status',
        seed: () => harness.engine.createMemoryCandidateEntry({
          id: 'candidate:personal-target',
          scope_id: 'personal:default',
          candidate_type: 'fact',
          proposed_content: 'Personal candidate target must not validate through work realm.',
          source_refs: ['Source: dry-run target scope test'],
          generated_by: 'agent',
          extraction_kind: 'extracted',
          confidence_score: 0.8,
          importance_score: 0.6,
          recurrence_score: 0.2,
          sensitivity: 'personal',
          status: 'staged_for_review',
          target_object_type: 'profile_memory',
          target_object_id: 'profile:personal-target',
        }),
      },
    ] as const;

    for (const target of targets) {
      await target.seed();
      const result = await operation.handler(harness.ctx(), {
        session_id: 'session-work-only',
        realm_id: 'realm:work-only',
        operation: target.operation,
        target_kind: target.target_kind,
        target_id: target.target_id,
        scope_id: 'work:claimed',
        source_refs: ['Source: dry-run target scope denial test'],
      }) as any;

      expect(result).toMatchObject({
        allowed: false,
        result: 'denied',
        target_kind: target.target_kind,
        target_id: target.target_id,
        policy_checks: {
          scope_allowed: false,
          target_resolved: true,
        },
      });
      expect(result.current_target_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    }
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation denies privileged and internal operation names', async () => {
  const harness = await createSqliteHarness('privileged-operation-denied');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    const targetId = await seedSessionRealmTarget(harness.engine, {
      session_id: 'session-privileged-denied',
      realm_id: 'realm:privileged-denied',
      access: 'read_write',
      target_hash: '6'.repeat(64),
    });

    for (const deniedOperation of ['physical_delete_memory_record', 'repair_memory_ledger'] as const) {
      const result = await operation.handler(harness.ctx(), {
        session_id: 'session-privileged-denied',
        realm_id: 'realm:privileged-denied',
        operation: deniedOperation,
        target_kind: 'page',
        target_id: targetId,
        source_refs: ['Source: dry-run privileged operation denial test'],
      }) as any;

      expect(result).toMatchObject({
        allowed: false,
        result: 'denied',
        policy_checks: {
          operation_allowed: false,
        },
      });
    }
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation denies operation and target-kind mismatches', async () => {
  const harness = await createSqliteHarness('operation-target-mismatch');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    const targetId = await seedSessionRealmTarget(harness.engine, {
      session_id: 'session-operation-target-mismatch',
      realm_id: 'realm:operation-target-mismatch',
      access: 'read_write',
      target_hash: '7'.repeat(64),
    });

    const result = await operation.handler(harness.ctx(), {
      session_id: 'session-operation-target-mismatch',
      realm_id: 'realm:operation-target-mismatch',
      operation: 'write_profile_memory_entry',
      target_kind: 'page',
      target_id: targetId,
      scope_id: 'work:claimed',
      source_refs: ['Source: dry-run operation target mismatch test'],
    }) as any;

    expect(result).toMatchObject({
      allowed: false,
      result: 'denied',
      policy_checks: {
        operation_allowed: false,
        target_resolved: false,
      },
    });
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation denies missing personal-domain targets through work realms', async () => {
  const harness = await createSqliteHarness('missing-personal-target-work-denied');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    await harness.engine.upsertMemoryRealm({
      id: 'realm:work-missing-personal',
      name: 'Work Missing Personal Realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await harness.engine.createMemorySession({
      id: 'session-work-missing-personal',
      actor_ref: 'agent:missing-personal-test',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: 'session-work-missing-personal',
      realm_id: 'realm:work-missing-personal',
      access: 'read_write',
    });

    for (const target of [
      {
        operation: 'write_profile_memory_entry',
        target_kind: 'profile_memory',
        target_id: 'profile:new-work-scoped',
      },
      {
        operation: 'write_personal_episode_entry',
        target_kind: 'personal_episode',
        target_id: 'episode:new-work-scoped',
      },
    ] as const) {
      const result = await operation.handler(harness.ctx(), {
        session_id: 'session-work-missing-personal',
        realm_id: 'realm:work-missing-personal',
        operation: target.operation,
        target_kind: target.target_kind,
        target_id: target.target_id,
        scope_id: 'work:claimed',
        source_refs: ['Source: dry-run missing personal target denial test'],
      }) as any;

      expect(result).toMatchObject({
        allowed: false,
        result: 'denied',
        current_target_snapshot_hash: null,
        target_kind: target.target_kind,
        target_id: target.target_id,
        policy_checks: {
          operation_allowed: true,
          target_resolved: false,
          scope_allowed: false,
        },
      });
    }
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation defaults omitted personal target scope to personal default', async () => {
  const harness = await createSqliteHarness('personal-default-scope');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    await harness.engine.upsertMemoryRealm({
      id: 'realm:personal-default-scope',
      name: 'Personal Default Scope Realm',
      scope: 'personal',
      default_access: 'read_write',
    });
    await harness.engine.createMemorySession({
      id: 'session-personal-default-scope',
      actor_ref: 'agent:personal-default-scope-test',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: 'session-personal-default-scope',
      realm_id: 'realm:personal-default-scope',
      access: 'read_write',
    });

    const result = await operation.handler(harness.ctx(), {
      session_id: 'session-personal-default-scope',
      realm_id: 'realm:personal-default-scope',
      operation: 'write_profile_memory_entry',
      target_kind: 'profile_memory',
      target_id: 'profile:new-personal-default-scope',
      source_refs: ['Source: dry-run personal default scope test'],
    }) as any;

    expect(result).toMatchObject({
      allowed: true,
      result: 'dry_run',
      current_target_snapshot_hash: null,
      policy_checks: {
        scope_allowed: true,
        target_resolved: false,
      },
    });

    const events = await harness.engine.listMemoryMutationEvents({
      session_id: 'session-personal-default-scope',
      operation: 'dry_run_memory_mutation',
    });
    expect(events).toHaveLength(1);
    expect(events[0].scope_id).toBe('personal:default');
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation defaults omitted candidate create scope to workspace default', async () => {
  const harness = await createSqliteHarness('candidate-default-scope');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    await harness.engine.upsertMemoryRealm({
      id: 'realm:candidate-default-scope',
      name: 'Candidate Default Scope Realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await harness.engine.createMemorySession({
      id: 'session-candidate-default-scope',
      actor_ref: 'agent:candidate-default-scope-test',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: 'session-candidate-default-scope',
      realm_id: 'realm:candidate-default-scope',
      access: 'read_write',
    });

    const result = await operation.handler(harness.ctx(), {
      session_id: 'session-candidate-default-scope',
      realm_id: 'realm:candidate-default-scope',
      operation: 'create_memory_candidate_entry',
      target_kind: 'memory_candidate',
      target_id: 'candidate:new-default-scope',
      source_refs: ['Source: dry-run candidate default scope test'],
    }) as any;

    expect(result).toMatchObject({
      allowed: true,
      result: 'dry_run',
      current_target_snapshot_hash: null,
      policy_checks: {
        scope_allowed: true,
        target_resolved: false,
      },
    });

    const events = await harness.engine.listMemoryMutationEvents({
      session_id: 'session-candidate-default-scope',
      operation: 'dry_run_memory_mutation',
    });
    expect(events).toHaveLength(1);
    expect(events[0].scope_id).toBe('workspace:default');
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation denies create candidate when target already exists', async () => {
  const harness = await createSqliteHarness('create-existing-candidate-denied');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    await harness.engine.upsertMemoryRealm({
      id: 'realm:create-existing-candidate',
      name: 'Create Existing Candidate Realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await harness.engine.createMemorySession({
      id: 'session-create-existing-candidate',
      actor_ref: 'agent:create-existing-candidate-test',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: 'session-create-existing-candidate',
      realm_id: 'realm:create-existing-candidate',
      access: 'read_write',
    });
    await harness.engine.createMemoryCandidateEntry({
      id: 'candidate:already-exists',
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      proposed_content: 'Existing candidate must not validate as a create target.',
      source_refs: ['Source: dry-run existing candidate create denial test'],
      generated_by: 'agent',
      extraction_kind: 'extracted',
      confidence_score: 0.8,
      importance_score: 0.6,
      recurrence_score: 0.2,
      sensitivity: 'work',
      status: 'staged_for_review',
      target_object_type: 'other',
      target_object_id: 'candidate:already-exists',
    });

    const result = await operation.handler(harness.ctx(), {
      session_id: 'session-create-existing-candidate',
      realm_id: 'realm:create-existing-candidate',
      operation: 'create_memory_candidate_entry',
      target_kind: 'memory_candidate',
      target_id: 'candidate:already-exists',
      source_refs: ['Source: dry-run existing candidate create denial test'],
    }) as any;

    expect(result).toMatchObject({
      allowed: false,
      result: 'denied',
      current_target_snapshot_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      policy_checks: {
        operation_allowed: true,
        target_resolved: true,
      },
    });
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation denies same-realm scope-id mismatches', async () => {
  const harness = await createSqliteHarness('scope-id-mismatch');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    await harness.engine.upsertMemoryRealm({
      id: 'realm:work-scopes',
      name: 'Work Scopes Realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await harness.engine.createMemorySession({
      id: 'session-work-scopes',
      actor_ref: 'agent:scope-id-test',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: 'session-work-scopes',
      realm_id: 'realm:work-scopes',
      access: 'read_write',
    });
    await harness.engine.createMemoryCandidateEntry({
      id: 'candidate:work-b-target',
      scope_id: 'work:b',
      candidate_type: 'fact',
      proposed_content: 'Work B candidate must not validate under Work A scope.',
      source_refs: ['Source: dry-run scope-id mismatch test'],
      generated_by: 'agent',
      extraction_kind: 'extracted',
      confidence_score: 0.8,
      importance_score: 0.6,
      recurrence_score: 0.2,
      sensitivity: 'work',
      status: 'staged_for_review',
      target_object_type: 'other',
      target_object_id: 'candidate:work-b-target',
    });

    const result = await operation.handler(harness.ctx(), {
      session_id: 'session-work-scopes',
      realm_id: 'realm:work-scopes',
      operation: 'advance_memory_candidate_status',
      target_kind: 'memory_candidate',
      target_id: 'candidate:work-b-target',
      scope_id: 'work:a',
      source_refs: ['Source: dry-run scope-id mismatch test'],
    }) as any;

    expect(result).toMatchObject({
      allowed: false,
      result: 'denied',
      current_target_snapshot_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      policy_checks: {
        operation_allowed: true,
        target_resolved: true,
        scope_allowed: false,
      },
    });
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation denies mixed scope through work realms', async () => {
  const harness = await createSqliteHarness('mixed-scope-work-denied');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    await harness.engine.upsertMemoryRealm({
      id: 'realm:work-no-mixed',
      name: 'Work No Mixed Realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await harness.engine.createMemorySession({
      id: 'session-work-no-mixed',
      actor_ref: 'agent:mixed-scope-test',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: 'session-work-no-mixed',
      realm_id: 'realm:work-no-mixed',
      access: 'read_write',
    });
    await harness.engine.createMemoryCandidateEntry({
      id: 'candidate:mixed-target',
      scope_id: 'mixed',
      candidate_type: 'fact',
      proposed_content: 'Mixed candidate target must not validate through work realm.',
      source_refs: ['Source: dry-run mixed scope denial test'],
      generated_by: 'agent',
      extraction_kind: 'extracted',
      confidence_score: 0.8,
      importance_score: 0.6,
      recurrence_score: 0.2,
      sensitivity: 'unknown',
      status: 'staged_for_review',
      target_object_type: 'other',
      target_object_id: 'candidate:mixed-target',
    });

    const targetMixedResult = await operation.handler(harness.ctx(), {
      session_id: 'session-work-no-mixed',
      realm_id: 'realm:work-no-mixed',
      operation: 'advance_memory_candidate_status',
      target_kind: 'memory_candidate',
      target_id: 'candidate:mixed-target',
      scope_id: 'work:claimed',
      source_refs: ['Source: dry-run mixed target denial test'],
    }) as any;
    expect(targetMixedResult).toMatchObject({
      allowed: false,
      result: 'denied',
      policy_checks: {
        operation_allowed: true,
        target_resolved: true,
        scope_allowed: false,
      },
    });

    const requestedMixedResult = await operation.handler(harness.ctx(), {
      session_id: 'session-work-no-mixed',
      realm_id: 'realm:work-no-mixed',
      operation: 'write_profile_memory_entry',
      target_kind: 'profile_memory',
      target_id: 'profile:new-mixed-request',
      scope_id: 'mixed',
      source_refs: ['Source: dry-run mixed request denial test'],
    }) as any;
    expect(requestedMixedResult).toMatchObject({
      allowed: false,
      result: 'denied',
      current_target_snapshot_hash: null,
      policy_checks: {
        operation_allowed: true,
        scope_allowed: false,
        target_resolved: false,
      },
    });
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation denies attachment targets scoped to another realm category', async () => {
  const harness = await createSqliteHarness('attachment-scope-mismatch');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    await harness.engine.upsertMemoryRealm({
      id: 'realm:work-attachment',
      name: 'Work Attachment Realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await harness.engine.upsertMemoryRealm({
      id: 'realm:personal-attachment',
      name: 'Personal Attachment Realm',
      scope: 'personal',
      default_access: 'read_write',
    });
    await harness.engine.createMemorySession({
      id: 'session-attachment-scope',
      actor_ref: 'agent:attachment-scope-test',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: 'session-attachment-scope',
      realm_id: 'realm:work-attachment',
      access: 'read_write',
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: 'session-attachment-scope',
      realm_id: 'realm:personal-attachment',
      access: 'read_write',
    });
    const personalAttachmentTargetId = memorySessionAttachmentTargetId({
      session_id: 'session-attachment-scope',
      realm_id: 'realm:personal-attachment',
    });

    const result = await operation.handler(harness.ctx(), {
      session_id: 'session-attachment-scope',
      realm_id: 'realm:work-attachment',
      operation: 'attach_memory_realm_to_session',
      target_kind: 'memory_session_attachment',
      target_id: personalAttachmentTargetId,
      scope_id: 'work:claimed',
      source_refs: ['Source: dry-run attachment scope mismatch test'],
    }) as any;

    expect(result).toMatchObject({
      allowed: false,
      result: 'denied',
      current_target_snapshot_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      policy_checks: {
        operation_allowed: true,
        target_resolved: true,
        scope_allowed: false,
      },
    });
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation denies new attachment targets scoped to another realm category', async () => {
  const harness = await createSqliteHarness('new-attachment-scope-mismatch');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    await harness.engine.upsertMemoryRealm({
      id: 'realm:work-new-attachment',
      name: 'Work New Attachment Realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await harness.engine.upsertMemoryRealm({
      id: 'realm:personal-new-attachment',
      name: 'Personal New Attachment Realm',
      scope: 'personal',
      default_access: 'read_write',
    });
    await harness.engine.createMemorySession({
      id: 'session-new-attachment-scope',
      actor_ref: 'agent:new-attachment-scope-test',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: 'session-new-attachment-scope',
      realm_id: 'realm:work-new-attachment',
      access: 'read_write',
    });
    const personalAttachmentTargetId = memorySessionAttachmentTargetId({
      session_id: 'session-new-attachment-scope',
      realm_id: 'realm:personal-new-attachment',
    });

    const result = await operation.handler(harness.ctx(), {
      session_id: 'session-new-attachment-scope',
      realm_id: 'realm:work-new-attachment',
      operation: 'attach_memory_realm_to_session',
      target_kind: 'memory_session_attachment',
      target_id: personalAttachmentTargetId,
      scope_id: 'work:claimed',
      source_refs: ['Source: dry-run new attachment scope mismatch test'],
    }) as any;

    expect(result).toMatchObject({
      allowed: false,
      result: 'denied',
      current_target_snapshot_hash: null,
      policy_checks: {
        operation_allowed: true,
        target_resolved: false,
        scope_allowed: false,
      },
    });
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation allows new attachment targets for the requested session and realm', async () => {
  const harness = await createSqliteHarness('new-attachment-allowed');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    await harness.engine.upsertMemoryRealm({
      id: 'realm:new-attachment-allowed',
      name: 'New Attachment Allowed Realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await harness.engine.createMemorySession({
      id: 'session-new-attachment-allowed',
      actor_ref: 'agent:new-attachment-allowed-test',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    const targetId = memorySessionAttachmentTargetId({
      session_id: 'session-new-attachment-allowed',
      realm_id: 'realm:new-attachment-allowed',
    });

    const result = await operation.handler(harness.ctx(), {
      session_id: 'session-new-attachment-allowed',
      realm_id: 'realm:new-attachment-allowed',
      operation: 'attach_memory_realm_to_session',
      target_kind: 'memory_session_attachment',
      target_id: targetId,
      source_refs: ['Source: dry-run new attachment allowed test'],
    }) as any;

    expect(result).toMatchObject({
      allowed: true,
      result: 'dry_run',
      current_target_snapshot_hash: null,
      policy_checks: {
        attachment_read_write: true,
        scope_allowed: true,
        target_resolved: false,
      },
    });

    const events = await harness.engine.listMemoryMutationEvents({
      session_id: 'session-new-attachment-allowed',
      operation: 'dry_run_memory_mutation',
    });
    expect(events).toHaveLength(1);
    expect(events[0].scope_id).toBe('work');
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation denies attachment targets for a different session or realm', async () => {
  const harness = await createSqliteHarness('attachment-target-mismatch');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    await harness.engine.upsertMemoryRealm({
      id: 'realm:control-work',
      name: 'Control Work Realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await harness.engine.upsertMemoryRealm({
      id: 'realm:target-work',
      name: 'Target Work Realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await harness.engine.createMemorySession({
      id: 'session-control',
      actor_ref: 'agent:attachment-target-mismatch',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    await harness.engine.createMemorySession({
      id: 'session-target',
      actor_ref: 'agent:attachment-target-mismatch',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: 'session-control',
      realm_id: 'realm:control-work',
      access: 'read_write',
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: 'session-target',
      realm_id: 'realm:target-work',
      access: 'read_write',
    });

    for (const targetId of [
      memorySessionAttachmentTargetId({
        session_id: 'session-target',
        realm_id: 'realm:target-work',
      }),
      memorySessionAttachmentTargetId({
        session_id: 'session-control',
        realm_id: 'realm:target-work',
      }),
    ]) {
      const result = await operation.handler(harness.ctx(), {
        session_id: 'session-control',
        realm_id: 'realm:control-work',
        operation: 'attach_memory_realm_to_session',
        target_kind: 'memory_session_attachment',
        target_id: targetId,
        scope_id: 'work:claimed',
        source_refs: ['Source: dry-run attachment target mismatch test'],
      }) as any;

      expect(result).toMatchObject({
        allowed: false,
        result: 'denied',
        target_id: targetId,
        policy_checks: {
          operation_allowed: true,
          scope_allowed: false,
        },
      });
    }
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation accepts prefix-shaped legacy attachment target ids that resolve to the requested attachment', async () => {
  const harness = await createSqliteHarness('legacy-prefix-attachment');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    const sessionId = 'memory_session_attachment:v1:legacy';
    const realmId = 'realm';
    await harness.engine.upsertMemoryRealm({
      id: realmId,
      name: 'Legacy Prefix Realm',
      scope: 'work',
      default_access: 'read_write',
    });
    await harness.engine.createMemorySession({
      id: sessionId,
      actor_ref: 'agent:legacy-prefix-attachment-test',
      expires_at: new Date('2999-01-01T00:00:00.000Z'),
    });
    await harness.engine.attachMemoryRealmToSession({
      session_id: sessionId,
      realm_id: realmId,
      access: 'read_write',
    });
    const legacyTargetId = `${sessionId}:${realmId}`;

    const result = await operation.handler(harness.ctx(), {
      session_id: sessionId,
      realm_id: realmId,
      operation: 'attach_memory_realm_to_session',
      target_kind: 'memory_session_attachment',
      target_id: legacyTargetId,
      scope_id: 'work:claimed',
      source_refs: ['Source: dry-run legacy prefix attachment test'],
    }) as any;

    expect(result).toMatchObject({
      allowed: true,
      result: 'dry_run',
      current_target_snapshot_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      policy_checks: {
        scope_allowed: true,
        target_resolved: true,
      },
    });
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation previews without ledger writes when context or params request dry run', async () => {
  const harness = await createSqliteHarness('preview');
  try {
    const operation = getOperation('dry_run_memory_mutation');
    const targetId = await seedSessionRealmTarget(harness.engine, {
      session_id: 'session-preview',
      realm_id: 'realm:preview',
      access: 'read_write',
      target_hash: '5'.repeat(64),
    });
    const params = {
      session_id: 'session-preview',
      realm_id: 'realm:preview',
      operation: 'put_page',
      target_kind: 'page',
      target_id: targetId,
      scope_id: 'work:phase9',
      source_refs: ['Source: dry-run mutation preview test'],
    };

    const contextPreview = await operation.handler(harness.ctx(true), params) as any;
    const paramPreview = await operation.handler(harness.ctx(), {
      ...params,
      dry_run: true,
    }) as any;

    for (const result of [contextPreview, paramPreview]) {
      expect(result).toMatchObject({
        action: 'dry_run_memory_mutation',
        allowed: true,
        result: 'dry_run',
        ledger_recorded: false,
        target_kind: 'page',
        target_id: targetId,
        current_target_snapshot_hash: '5'.repeat(64),
      });
      expect(result.event_id).toBeUndefined();
    }

    expect(await harness.engine.listMemoryMutationEvents({
      session_id: 'session-preview',
      operation: 'dry_run_memory_mutation',
    })).toEqual([]);
  } finally {
    await harness.cleanup();
  }
});

test('dry_run_memory_mutation denies unsupported control-plane create operations', async () => {
  const operation = getOperation('dry_run_memory_mutation');
  const ctx = {
    engine: {} as any,
    config: {} as any,
    logger: console,
    dryRun: true,
  };

  for (const deniedOperation of ['create_memory_session', 'upsert_memory_realm'] as const) {
    const result = await operation.handler(ctx, {
      session_id: 'session-control-plane-create',
      realm_id: 'realm:control-plane-create',
      operation: deniedOperation,
      target_kind: deniedOperation === 'create_memory_session' ? 'memory_session' : 'memory_realm',
      target_id: deniedOperation === 'create_memory_session' ? 'session:new' : 'realm:new',
      source_refs: ['Source: dry-run unsupported control-plane create test'],
    }) as any;

    expect(result).toMatchObject({
      allowed: false,
      result: 'denied',
      ledger_recorded: false,
      policy_checks: {
        operation_allowed: false,
      },
    });
  }
});

test('dry_run_memory_mutation rejects unknown operations and source_refs shapes before policy evaluation', async () => {
  const operation = getOperation('dry_run_memory_mutation');
  const ctx = {
    engine: {} as any,
    config: {} as any,
    logger: console,
    dryRun: true,
  };
  const base = {
    session_id: 'session-validation',
    realm_id: 'realm:validation',
    operation: 'put_page',
    target_kind: 'page',
    target_id: 'concepts/validation',
    source_refs: ['Source: dry-run validation test'],
  };

  await expect(operation.handler(ctx, {
    ...base,
    operation: 'invented_operation',
  })).rejects.toBeInstanceOf(OperationError);
  await expect(operation.handler(ctx, {
    ...base,
    target_kind: 'source_record',
  })).rejects.toBeInstanceOf(OperationError);
  await expect(operation.handler(ctx, {
    ...base,
    source_refs: 'Source: single string is not accepted',
  })).rejects.toBeInstanceOf(OperationError);
  await expect(operation.handler(ctx, {
    ...base,
    source_refs: [],
  })).rejects.toBeInstanceOf(OperationError);
});
