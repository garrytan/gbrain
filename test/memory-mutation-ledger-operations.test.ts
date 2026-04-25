import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { createMemoryMutationLedgerOperations } from '../src/core/operations-memory-mutation-ledger.ts';
import { OperationError, operations } from '../src/core/operations.ts';
import type { Operation, OperationContext } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const privilegedLedgerOperations = createMemoryMutationLedgerOperations({
  OperationError,
  allowPrivilegedLedgerRecord: () => true,
});

const disabledLedgerOperations = createMemoryMutationLedgerOperations({
  OperationError,
  allowPrivilegedLedgerRecord: () => false,
});

function getOperation(name: string, source: Operation[] = operations): Operation {
  const operation = source.find((candidate) => candidate.name === name);
  if (!operation) {
    throw new Error(`${name} operation is missing`);
  }
  return operation;
}

function getPrivilegedLedgerOperation(name: string): Operation {
  return getOperation(name, privilegedLedgerOperations);
}

async function withSqliteEngine<T>(fn: (ctx: OperationContext) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-mutation-ledger-op-'));
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    return await fn({
      engine: engine as unknown as BrainEngine,
      config: {} as any,
      logger: console,
      dryRun: false,
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('memory mutation ledger operations are registered with privileged boundary metadata', () => {
  const list = getOperation('list_memory_mutation_events');
  const record = getOperation('record_memory_mutation_event');

  expect(list.mutating).toBe(false);
  expect(list.params.limit.default).toBe(20);
  expect(list.params.offset.default).toBe(0);
  expect(list.params.operation.enum).toContain('put_page');
  expect(list.params.target_kind.enum).toContain('ledger_event');
  expect(list.params.result.enum).toContain('applied');

  expect(record.mutating).toBe(true);
  expect(record.description).toContain('privileged');
  expect(record.description).toContain('import/repair');
  expect(record.params.privileged.required).toBe(true);
  expect(record.params.privileged.description).toContain('privileged');
  expect(record.params.privileged_reason.required).toBe(true);
  expect(record.params.session_id.required).toBe(true);
  expect(record.params.realm_id.required).toBe(true);
  expect(record.params.actor.required).toBe(true);
  expect(record.params.operation.required).toBe(true);
  expect(record.params.target_kind.required).toBe(true);
  expect(record.params.target_id.required).toBe(true);
  expect(record.params.source_refs.required).toBe(true);
  expect(record.params.result.required).toBe(true);
  expect(record.params.source_ref).toBeUndefined();
  expect(record.params.mutation_dry_run.type).toBe('boolean');
});

test('record_memory_mutation_event rejects when runtime privileged ledger recording is disabled', async () => {
  const record = getOperation('record_memory_mutation_event', disabledLedgerOperations);
  const ctx = {
    engine: {} as any,
    config: {} as any,
    logger: console,
    dryRun: true,
  };

  await expect(record.handler(ctx, {
    privileged: true,
    privileged_reason: 'repair',
    session_id: 'session-a',
    realm_id: 'realm-a',
    actor: 'agent',
    operation: 'repair_memory_ledger',
    target_kind: 'ledger_event',
    target_id: 'event-a',
    source_refs: ['Source: privileged gate test'],
    result: 'applied',
  })).rejects.toBeInstanceOf(OperationError);
});

test('record_memory_mutation_event rejects missing privilege fields', async () => {
  const record = getPrivilegedLedgerOperation('record_memory_mutation_event');
  const ctx = {
    engine: {} as any,
    config: {} as any,
    logger: console,
    dryRun: true,
  };
  const base = {
    session_id: 'session-a',
    realm_id: 'realm-a',
    actor: 'agent',
    operation: 'repair_memory_ledger',
    target_kind: 'ledger_event',
    target_id: 'event-a',
    source_refs: ['Source: privilege field test'],
    result: 'applied',
  };

  await expect(record.handler(ctx, base)).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, privileged: false, privileged_reason: 'repair' })).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, privileged: true, privileged_reason: '   ' })).rejects.toBeInstanceOf(OperationError);
});

test('record_memory_mutation_event writes privileged events with normalized source refs and metadata', async () => {
  await withSqliteEngine(async (ctx) => {
    const record = getPrivilegedLedgerOperation('record_memory_mutation_event');

    const written = await record.handler(ctx, {
      privileged: true,
      privileged_reason: 'backfill import ledger from trusted archive',
      session_id: 'session-write',
      realm_id: 'realm-write',
      actor: 'importer',
      operation: 'repair_memory_ledger',
      target_kind: 'ledger_event',
      target_id: 'event-target',
      scope_id: 'scope-write',
      source_refs: [' array source ref '],
      expected_target_snapshot_hash: 'expected-hash',
      current_target_snapshot_hash: 'current-hash',
      result: 'applied',
      conflict_info: { kind: 'none' },
      metadata: { existing: true },
      redaction_visibility: 'partially_redacted',
      created_at: '2026-04-25T01:00:00.000Z',
      decided_at: '2026-04-25T01:01:00.000Z',
      applied_at: '2026-04-25T01:02:00.000Z',
    }) as any;

    expect(typeof written.id).toBe('string');
    expect(written.id.length).toBeGreaterThan(10);
    expect(written.source_refs).toEqual(['array source ref']);
    expect(written.metadata).toEqual({
      existing: true,
      privileged_reason: 'backfill import ledger from trusted archive',
    });
    expect(written.created_at.toISOString()).toBe('2026-04-25T01:00:00.000Z');

    const listed = await ctx.engine.listMemoryMutationEvents({ realm_id: 'realm-write' });
    expect(listed.map((event) => event.id)).toEqual([written.id]);
    expect(listed[0].metadata).toEqual(written.metadata);
  });
});

test('list_memory_mutation_events filters and paginates through the operation layer', async () => {
  await withSqliteEngine(async (ctx) => {
    const list = getOperation('list_memory_mutation_events');
    const record = getPrivilegedLedgerOperation('record_memory_mutation_event');
    const base = {
      privileged: true,
      privileged_reason: 'test fixture import',
      session_id: 'session-list',
      realm_id: 'realm-list',
      actor: 'agent',
      operation: 'put_page',
      target_kind: 'page',
      source_refs: ['Source: list fixture'],
      result: 'applied',
    };

    await record.handler(ctx, { ...base, id: 'event-old', target_id: 'target-a', scope_id: 'scope-a', created_at: '2026-04-25T01:00:00.000Z' });
    await record.handler(ctx, { ...base, id: 'event-middle', actor: 'human', operation: 'delete_page', target_id: 'target-b', scope_id: 'scope-a', result: 'dry_run', created_at: '2026-04-25T01:05:00.000Z' });
    await record.handler(ctx, { ...base, id: 'event-new', target_id: 'target-a', scope_id: 'scope-b', result: 'conflict', created_at: '2026-04-25T01:10:00.000Z' });

    const page = await list.handler(ctx, {
      realm_id: 'realm-list',
      created_since: '2026-04-25T01:01:00.000Z',
      created_until: '2026-04-25T01:11:00.000Z',
      limit: 1,
      offset: 1,
    }) as any[];
    expect(page.map((event) => event.id)).toEqual(['event-middle']);

    const filtered = await list.handler(ctx, {
      session_id: 'session-list',
      actor: 'agent',
      operation: 'put_page',
      target_kind: 'page',
      target_id: 'target-a',
      scope_id: 'scope-b',
      result: 'conflict',
    }) as any[];
    expect(filtered.map((event) => event.id)).toEqual(['event-new']);
  });
});

test('memory mutation ledger operations reject invalid enums timestamps and pagination', async () => {
  const list = getOperation('list_memory_mutation_events');
  const record = getPrivilegedLedgerOperation('record_memory_mutation_event');
  const ctx = {
    engine: {} as any,
    config: {} as any,
    logger: console,
    dryRun: true,
  };
  const base = {
    privileged: true,
    privileged_reason: 'repair',
    session_id: 'session-a',
    realm_id: 'realm-a',
    actor: 'agent',
    operation: 'repair_memory_ledger',
    target_kind: 'ledger_event',
    target_id: 'event-a',
    source_refs: ['Source: validation test'],
    result: 'applied',
  };

  await expect(record.handler(ctx, { ...base, operation: 'invented_operation' })).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, target_kind: 'invented_kind' })).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, result: 'invented_result' })).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, redaction_visibility: 'hidden' })).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, created_at: 'not-a-date' })).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, created_at: '2026-02-31T01:00:00.000Z' })).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, created_at: '2026-04-25T01:00:00' })).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, target_id: undefined })).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, source_refs: [] })).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, source_refs: 'single source ref' })).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, result: 'applied', mutation_dry_run: true })).rejects.toBeInstanceOf(OperationError);
  await expect(record.handler(ctx, { ...base, result: 'dry_run', mutation_dry_run: false })).rejects.toBeInstanceOf(OperationError);

  await expect(list.handler(ctx, { operation: 'invented_operation' })).rejects.toBeInstanceOf(OperationError);
  await expect(list.handler(ctx, { target_kind: 'invented_kind' })).rejects.toBeInstanceOf(OperationError);
  await expect(list.handler(ctx, { result: 'invented_result' })).rejects.toBeInstanceOf(OperationError);
  await expect(list.handler(ctx, { created_since: 'not-a-date' })).rejects.toBeInstanceOf(OperationError);
  await expect(list.handler(ctx, { created_since: '2026-02-31T01:00:00.000Z' })).rejects.toBeInstanceOf(OperationError);
  await expect(list.handler(ctx, { created_since: '2026-04-25T01:00:00' })).rejects.toBeInstanceOf(OperationError);
  await expect(list.handler(ctx, { limit: 101 })).rejects.toBeInstanceOf(OperationError);
  await expect(list.handler(ctx, { limit: -1 })).rejects.toBeInstanceOf(OperationError);
  await expect(list.handler(ctx, { offset: -1 })).rejects.toBeInstanceOf(OperationError);
});

test('record_memory_mutation_event keeps result and mutation dry-run state consistent', async () => {
  await withSqliteEngine(async (ctx) => {
    const record = getPrivilegedLedgerOperation('record_memory_mutation_event');

    const written = await record.handler(ctx, {
      privileged: true,
      privileged_reason: 'backfill dry-run ledger from trusted archive',
      session_id: 'session-mutation-dry-run',
      realm_id: 'realm-mutation-dry-run',
      actor: 'importer',
      operation: 'repair_memory_ledger',
      target_kind: 'ledger_event',
      target_id: 'event-dry-run',
      source_refs: ['Source: dry-run archive'],
      result: 'dry_run',
    }) as any;

    expect(written.result).toBe('dry_run');
    expect(written.dry_run).toBe(true);
  });
});

test('record_memory_mutation_event dry-run mode does not write', async () => {
  await withSqliteEngine(async (ctx) => {
    const record = getPrivilegedLedgerOperation('record_memory_mutation_event');
    const dryCtx = { ...ctx, dryRun: true };

    const result = await record.handler(dryCtx, {
      privileged: true,
      privileged_reason: 'preview repair',
      session_id: 'session-dry-run',
      realm_id: 'realm-dry-run',
      actor: 'agent',
      operation: 'repair_memory_ledger',
      target_kind: 'ledger_event',
      target_id: 'event-dry-run',
      source_refs: ['Source: preview repair'],
      result: 'applied',
    }) as any;

    expect(result).toMatchObject({
      dry_run: true,
      action: 'record_memory_mutation_event',
      event: {
        session_id: 'session-dry-run',
        realm_id: 'realm-dry-run',
        dry_run: false,
      },
    });
    expect(await ctx.engine.listMemoryMutationEvents({ realm_id: 'realm-dry-run' })).toEqual([]);
  });
});
