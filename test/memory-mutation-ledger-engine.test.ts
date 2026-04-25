import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

interface EngineHarness {
  label: string;
  engine: BrainEngine;
  cleanup: () => Promise<void>;
}

const ENGINE_COLD_START_BUDGET_MS = 30_000;

async function createSqliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mutation-ledger-sqlite-'));
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();

  return {
    label: 'sqlite',
    engine,
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mutation-ledger-pglite-'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dir });
  await engine.initSchema();

  return {
    label: 'pglite',
    engine,
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let counter = 0;

function nextPrefix(label: string): string {
  counter += 1;
  return `memory-mutation-ledger:${label}:${Date.now()}:${counter}`;
}

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((row) => row.id);
}

async function expectMemoryMutationLedgerEngine(engine: BrainEngine, prefix: string): Promise<void> {
  const sessionA = `${prefix}:session-a`;
  const sessionB = `${prefix}:session-b`;
  const realmA = `${prefix}:realm-a`;
  const realmB = `${prefix}:realm-b`;
  const scopeA = `${prefix}:scope-a`;
  const scopeB = `${prefix}:scope-b`;
  const targetA = `${prefix}:target-a`;
  const targetB = `${prefix}:target-b`;
  const eventOld = `${prefix}:event-old`;
  const eventMiddle = `${prefix}:event-middle`;
  const eventTieA = `${prefix}:event-tie-a`;
  const eventTieB = `${prefix}:event-tie-b`;
  const eventDefault = `${prefix}:event-defaults`;
  const eventEmptyScope = `${prefix}:event-empty-scope`;

  const created = await engine.createMemoryMutationEvent({
    id: eventOld,
    session_id: sessionA,
    realm_id: realmA,
    actor: 'agent',
    operation: 'put_page',
    target_kind: 'page',
    target_id: targetA,
    scope_id: scopeA,
    source_refs: ['[Source: User, direct message, 2026-04-25 12:00 PM KST]'],
    expected_target_snapshot_hash: 'expected-old',
    current_target_snapshot_hash: 'current-old',
    result: 'applied',
    conflict_info: { kind: 'none' },
    dry_run: false,
    metadata: { note: 'old', attempts: 1 },
    redaction_visibility: 'visible',
    created_at: new Date('2026-04-25T01:00:00.000Z'),
    decided_at: '2026-04-25T01:01:00.000Z',
    applied_at: new Date('2026-04-25T01:02:00.000Z'),
  });

  expect(created.id).toBe(eventOld);
  expect(created.source_refs).toEqual(['[Source: User, direct message, 2026-04-25 12:00 PM KST]']);
  expect(created.conflict_info).toEqual({ kind: 'none' });
  expect(created.metadata).toEqual({ note: 'old', attempts: 1 });
  expect(created.dry_run).toBe(false);
  expect(created.created_at).toBeInstanceOf(Date);
  expect(created.created_at.toISOString()).toBe('2026-04-25T01:00:00.000Z');
  expect(created.decided_at?.toISOString()).toBe('2026-04-25T01:01:00.000Z');
  expect(created.applied_at?.toISOString()).toBe('2026-04-25T01:02:00.000Z');

  await engine.createMemoryMutationEvent({
    id: eventMiddle,
    session_id: sessionA,
    realm_id: realmA,
    actor: 'human',
    operation: 'delete_page',
    target_kind: 'page',
    target_id: targetB,
    scope_id: scopeA,
    source_refs: ['[Source: User, dry-run preview, 2026-04-25 12:05 PM KST]'],
    result: 'dry_run',
    dry_run: true,
    metadata: { note: 'middle' },
    redaction_visibility: 'partially_redacted',
    created_at: new Date('2026-04-25T01:05:00.000Z'),
  });
  await engine.createMemoryMutationEvent({
    id: eventTieA,
    session_id: sessionA,
    realm_id: realmA,
    actor: 'agent',
    operation: 'put_page',
    target_kind: 'page',
    target_id: targetA,
    scope_id: scopeB,
    source_refs: ['[Source: User, conflict fixture, 2026-04-25 12:10 PM KST]'],
    result: 'conflict',
    conflict_info: { reason: 'hash_mismatch' },
    created_at: new Date('2026-04-25T01:10:00.000Z'),
  });
  await engine.createMemoryMutationEvent({
    id: eventTieB,
    session_id: sessionB,
    realm_id: realmB,
    actor: 'agent',
    operation: 'record_personal_episode',
    target_kind: 'personal_episode',
    target_id: targetB,
    scope_id: scopeB,
    source_refs: ['[Source: User, personal episode fixture, 2026-04-25 12:10 PM KST]'],
    result: 'failed',
    created_at: new Date('2026-04-25T01:10:00.000Z'),
  });
  await engine.createMemoryMutationEvent({
    id: eventEmptyScope,
    session_id: sessionA,
    realm_id: realmA,
    actor: 'agent',
    operation: 'sync_memory_artifact',
    target_kind: 'page',
    target_id: `${prefix}:empty-scope-target`,
    scope_id: '',
    source_refs: ['[Source: User, empty scope fixture, 2026-04-25 12:12 PM KST]'],
    result: 'applied',
    created_at: new Date('2026-04-25T01:12:00.000Z'),
  });

  const beforeDefaultCreate = Date.now();
  const defaulted = await engine.createMemoryMutationEvent({
    id: eventDefault,
    session_id: sessionA,
    realm_id: realmA,
    actor: 'agent',
    operation: 'record_memory_mutation_event',
    target_kind: 'ledger_event',
    target_id: `${prefix}:default-target`,
    source_refs: ['[Source: User, default fixture, 2026-04-25 12:13 PM KST]'],
    result: 'staged_for_review',
  });
  const afterDefaultCreate = Date.now();
  expect(defaulted.target_id).toBe(`${prefix}:default-target`);
  expect(defaulted.scope_id).toBeNull();
  expect(defaulted.source_refs).toEqual(['[Source: User, default fixture, 2026-04-25 12:13 PM KST]']);
  expect(defaulted.expected_target_snapshot_hash).toBeNull();
  expect(defaulted.current_target_snapshot_hash).toBeNull();
  expect(defaulted.conflict_info).toBeNull();
  expect(defaulted.dry_run).toBe(false);
  expect(defaulted.metadata).toEqual({});
  expect(defaulted.redaction_visibility).toBe('visible');
  expect(defaulted.decided_at).toBeNull();
  expect(defaulted.applied_at).toBeNull();
  expect(defaulted.created_at.getTime()).toBeGreaterThanOrEqual(beforeDefaultCreate - 1_000);
  expect(defaulted.created_at.getTime()).toBeLessThanOrEqual(afterDefaultCreate + 1_000);

  expect(ids(await engine.listMemoryMutationEvents({ realm_id: realmA }))).toEqual([
    eventDefault,
    eventEmptyScope,
    eventTieA,
    eventMiddle,
    eventOld,
  ]);
  expect(ids(await engine.listMemoryMutationEvents({ session_id: sessionA, operation: 'put_page' }))).toEqual([
    eventTieA,
    eventOld,
  ]);
  expect(ids(await engine.listMemoryMutationEvents({ actor: 'human' }))).toEqual([eventMiddle]);
  expect(ids(await engine.listMemoryMutationEvents({ target_kind: 'page', target_id: targetA }))).toEqual([
    eventTieA,
    eventOld,
  ]);
  expect(ids(await engine.listMemoryMutationEvents({ scope_id: scopeB }))).toEqual([
    eventTieB,
    eventTieA,
  ]);
  expect(ids(await engine.listMemoryMutationEvents({ result: 'conflict' }))).toEqual([eventTieA]);
  expect(ids(await engine.listMemoryMutationEvents({ scope_id: '' }))).toEqual([eventEmptyScope]);
  expect(ids(await engine.listMemoryMutationEvents({
    realm_id: realmA,
    created_since: new Date('2026-04-25T01:04:00.000Z'),
    created_until: new Date('2026-04-25T01:11:00.000Z'),
  }))).toEqual([
    eventTieA,
    eventMiddle,
  ]);
  expect(ids(await engine.listMemoryMutationEvents({
    scope_id: scopeB,
    limit: 1,
    offset: 1,
  }))).toEqual([eventTieA]);
  expect(await engine.listMemoryMutationEvents({ realm_id: realmA, limit: 0 })).toEqual([]);
  await expect(engine.listMemoryMutationEvents({ limit: -1 })).rejects.toThrow(/limit/i);
  await expect(engine.listMemoryMutationEvents({ limit: 1.5 })).rejects.toThrow(/limit/i);
  await expect(engine.listMemoryMutationEvents({ offset: -1 })).rejects.toThrow(/offset/i);
  await expect(engine.listMemoryMutationEvents({ offset: 1.5 })).rejects.toThrow(/offset/i);

  await expect(engine.createMemoryMutationEvent({
    id: `${prefix}:missing-target`,
    session_id: sessionA,
    realm_id: realmA,
    actor: 'agent',
    operation: 'put_page',
    target_kind: 'page',
    source_refs: ['[Source: User, invalid fixture, 2026-04-25 12:20 PM KST]'],
    result: 'applied',
  } as any)).rejects.toThrow(/target_id/i);
  await expect(engine.createMemoryMutationEvent({
    id: `${prefix}:empty-target`,
    session_id: sessionA,
    realm_id: realmA,
    actor: 'agent',
    operation: 'put_page',
    target_kind: 'page',
    target_id: '   ',
    source_refs: ['[Source: User, invalid fixture, 2026-04-25 12:21 PM KST]'],
    result: 'applied',
  })).rejects.toThrow(/target_id/i);
  await expect(engine.createMemoryMutationEvent({
    id: `${prefix}:missing-source-refs`,
    session_id: sessionA,
    realm_id: realmA,
    actor: 'agent',
    operation: 'put_page',
    target_kind: 'page',
    target_id: targetA,
    result: 'applied',
  } as any)).rejects.toThrow(/source_refs/i);
  await expect(engine.createMemoryMutationEvent({
    id: `${prefix}:empty-source-refs`,
    session_id: sessionA,
    realm_id: realmA,
    actor: 'agent',
    operation: 'put_page',
    target_kind: 'page',
    target_id: targetA,
    source_refs: [],
    result: 'applied',
  })).rejects.toThrow(/source_refs/i);
  await expect(engine.createMemoryMutationEvent({
    id: `${prefix}:blank-source-ref`,
    session_id: sessionA,
    realm_id: realmA,
    actor: 'agent',
    operation: 'put_page',
    target_kind: 'page',
    target_id: targetA,
    source_refs: ['   '],
    result: 'applied',
  })).rejects.toThrow(/source_refs/i);
  await expect(engine.createMemoryMutationEvent({
    id: `${prefix}:dry-run-result-mismatch`,
    session_id: sessionA,
    realm_id: realmA,
    actor: 'agent',
    operation: 'put_page',
    target_kind: 'page',
    target_id: targetA,
    source_refs: ['[Source: User, invalid fixture, 2026-04-25 12:22 PM KST]'],
    result: 'dry_run',
    dry_run: false,
  })).rejects.toThrow(/dry_run/i);
  await expect(engine.createMemoryMutationEvent({
    id: `${prefix}:applied-result-mismatch`,
    session_id: sessionA,
    realm_id: realmA,
    actor: 'agent',
    operation: 'put_page',
    target_kind: 'page',
    target_id: targetA,
    source_refs: ['[Source: User, invalid fixture, 2026-04-25 12:23 PM KST]'],
    result: 'applied',
    dry_run: true,
  })).rejects.toThrow(/dry_run/i);
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  const timeoutMs = createHarness === createPgliteHarness
    ? ENGINE_COLD_START_BUDGET_MS
    : undefined;

  test(`${createHarness.name} persists and lists memory mutation events`, async () => {
    const harness = await createHarness();
    try {
      await expectMemoryMutationLedgerEngine(harness.engine, nextPrefix(harness.label));
    } finally {
      await harness.cleanup();
    }
  }, timeoutMs);
}

test('sqlite surfaces memory mutation ledger operation and result constraint errors', async () => {
  const harness = await createSqliteHarness();
  try {
    await expect(harness.engine.createMemoryMutationEvent({
      id: `${nextPrefix(harness.label)}:invalid-operation`,
      session_id: 'constraint-session',
      realm_id: 'constraint-realm',
      actor: 'agent',
      operation: 'invented_operation' as any,
      target_kind: 'page',
      target_id: 'constraint-target',
      source_refs: ['Source: sqlite constraint invalid operation'],
      result: 'applied',
    })).rejects.toThrow();
    await expect(harness.engine.createMemoryMutationEvent({
      id: `${nextPrefix(harness.label)}:invalid-result`,
      session_id: 'constraint-session',
      realm_id: 'constraint-realm',
      actor: 'agent',
      operation: 'put_page',
      target_kind: 'page',
      target_id: 'constraint-target',
      source_refs: ['Source: sqlite constraint invalid result'],
      result: 'approved' as any,
    })).rejects.toThrow();
  } finally {
    await harness.cleanup();
  }
});

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  test('postgres persists and lists memory mutation events', async () => {
    const engine = new PostgresEngine();
    const prefix = nextPrefix('postgres');
    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      await expectMemoryMutationLedgerEngine(engine, prefix);
    } finally {
      await cleanupPostgresMutationEvents(engine, prefix).catch(() => undefined);
      await engine.disconnect().catch(() => undefined);
    }
  }, 20_000);
} else {
  test.skip('postgres memory mutation ledger engine skipped: DATABASE_URL is not configured', () => {});
}

async function cleanupPostgresMutationEvents(engine: PostgresEngine, prefix: string): Promise<void> {
  if (!(engine as any)._sql) {
    return;
  }
  await engine.sql`
    DELETE FROM memory_mutation_events
    WHERE id LIKE ${`${prefix}:%`}
  `;
}
