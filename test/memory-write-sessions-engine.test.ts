import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

interface EngineHarness {
  label: string;
  engine: BrainEngine;
  cleanup: () => Promise<void>;
}

const ENGINE_COLD_START_BUDGET_MS = 30_000;

async function createSqliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-write-session-sqlite-'));
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();

  return {
    label: 'sqlite',
    engine: engine as unknown as BrainEngine,
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-write-session-pglite-'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dir });
  await engine.initSchema();

  return {
    label: 'pglite',
    engine: engine as unknown as BrainEngine,
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let counter = 0;

function nextPrefix(label: string): string {
  counter += 1;
  return `memory-write-session:${label}:${Date.now()}:${counter}`;
}

async function expectMemoryWriteSessionsEngine(engine: BrainEngine, prefix: string): Promise<void> {
  const openOld = `${prefix}:open-old`;
  const openNew = `${prefix}:open-new`;
  const expired = `${prefix}:expired`;
  const scopedElsewhere = `${prefix}:elsewhere`;
  const stringDate = `${prefix}:string-date`;
  const sourceRefs = ['Source: User, direct message, 2026-06-25 12:00 KST'];

  const created = await (engine as any).createMemoryWriteSession({
    id: openOld,
    route_decision_id: `${prefix}:route-old`,
    scope_id: 'workspace:default',
    actor: 'agent:router',
    memory_session_id: 'memory-session:1',
    target_slug: 'concepts/write-session-engine',
    target_object_type: 'curated_note',
    expected_content_hash: 'a'.repeat(64),
    source_refs: sourceRefs,
    route_decision: 'canonical_write_allowed',
    intended_operation: 'put_page',
    route_reasons: ['canonical_write_allowed'],
    missing_requirements: [],
    governance_metadata: { reason: 'test' },
    created_at: new Date('2026-06-25T01:00:00.000Z'),
    expires_at: new Date(Date.now() + 120_000),
  });

  expect(created).toMatchObject({
    id: openOld,
    route_decision_id: `${prefix}:route-old`,
    status: 'open',
    scope_id: 'workspace:default',
    actor: 'agent:router',
    memory_session_id: 'memory-session:1',
    target_slug: 'concepts/write-session-engine',
    target_object_type: 'curated_note',
    expected_content_hash: 'a'.repeat(64),
    source_refs: sourceRefs,
    route_decision: 'canonical_write_allowed',
    intended_operation: 'put_page',
    route_reasons: ['canonical_write_allowed'],
    missing_requirements: [],
    governance_metadata: { reason: 'test' },
    consumed_at: null,
    consumed_by_event_id: null,
    status_reason: null,
  });
  expect(created.created_at).toBeInstanceOf(Date);
  expect(created.expires_at).toBeInstanceOf(Date);
  expect(created.updated_at).toBeInstanceOf(Date);

  await (engine as any).createMemoryWriteSession({
    id: openNew,
    route_decision_id: `${prefix}:route-new`,
    scope_id: 'workspace:default',
    actor: 'agent:router',
    target_slug: 'concepts/write-session-engine',
    target_object_type: 'curated_note',
    expected_content_hash: null,
    source_refs: sourceRefs,
    route_decision: 'canonical_write_allowed',
    intended_operation: 'put_page',
    route_reasons: ['canonical_write_allowed'],
    missing_requirements: [],
    governance_metadata: {},
    created_at: new Date('2026-06-25T01:05:00.000Z'),
    expires_at: new Date(Date.now() + 120_000),
  });
  await (engine as any).createMemoryWriteSession({
    id: expired,
    route_decision_id: `${prefix}:route-expired`,
    scope_id: 'workspace:default',
    actor: 'agent:router',
    target_slug: 'concepts/write-session-expired',
    target_object_type: 'curated_note',
    expected_content_hash: null,
    source_refs: sourceRefs,
    route_decision: 'canonical_write_allowed',
    intended_operation: 'put_page',
    route_reasons: ['canonical_write_allowed'],
    missing_requirements: [],
    governance_metadata: {},
    created_at: new Date('2026-06-25T01:10:00.000Z'),
    expires_at: new Date('2000-01-01T00:00:00.000Z'),
  });
  await (engine as any).createMemoryWriteSession({
    id: scopedElsewhere,
    route_decision_id: `${prefix}:route-elsewhere`,
    scope_id: 'personal:default',
    actor: 'agent:router',
    target_slug: 'concepts/write-session-elsewhere',
    target_object_type: 'curated_note',
    expected_content_hash: null,
    source_refs: sourceRefs,
    route_decision: 'canonical_write_allowed',
    intended_operation: 'put_page',
    route_reasons: ['canonical_write_allowed'],
    missing_requirements: [],
    governance_metadata: {},
    expires_at: new Date(Date.now() + 120_000),
  });
  await (engine as any).createMemoryWriteSession({
    id: stringDate,
    route_decision_id: `${prefix}:route-string-date`,
    scope_id: 'workspace:default',
    actor: 'agent:router',
    target_slug: 'concepts/write-session-string-date',
    target_object_type: 'curated_note',
    expected_content_hash: null,
    source_refs: sourceRefs,
    route_decision: 'canonical_write_allowed',
    intended_operation: 'put_page',
    route_reasons: ['canonical_write_allowed'],
    missing_requirements: [],
    governance_metadata: {},
    created_at: '06/25/2026 01:15:00 UTC',
    expires_at: '01/01/2099 00:00:00 UTC',
  });

  expect((await (engine as any).getMemoryWriteSession(expired)).status).toBe('expired');
  const stringDateSession = await (engine as any).getMemoryWriteSession(stringDate);
  expect(stringDateSession).toMatchObject({
    id: stringDate,
    status: 'open',
  });
  expect(stringDateSession.created_at.toISOString()).toBe('2026-06-25T01:15:00.000Z');
  expect(stringDateSession.expires_at.toISOString()).toBe('2099-01-01T00:00:00.000Z');
  expect((await (engine as any).listMemoryWriteSessions({ status: 'open', scope_id: 'workspace:default' })).map((row: any) => row.id)).toEqual([
    stringDate,
    openNew,
    openOld,
  ]);
  expect((await (engine as any).listMemoryWriteSessions({ status: 'expired', scope_id: 'workspace:default' })).map((row: any) => row.id)).toEqual([
    expired,
  ]);
	  expect((await (engine as any).listMemoryWriteSessions({ target_slug: 'concepts/write-session-engine' })).map((row: any) => row.id)).toEqual([
	    openNew,
	    openOld,
	  ]);
	  expect((await (engine as any).listMemoryWriteSessions({
	    scope_id: 'workspace:default',
	    created_until: '06/25/2026 01:06:00 UTC',
	  })).map((row: any) => row.id)).toEqual([
	    openNew,
	    openOld,
	  ]);
	  expect((await (engine as any).listMemoryWriteSessions({
	    scope_id: 'workspace:default',
	    created_since: '06/25/2026 01:06:00 UTC',
	  })).map((row: any) => row.id)).toEqual([
	    stringDate,
	    expired,
	  ]);

	  const consumed = await (engine as any).consumeMemoryWriteSession(openOld, {
    status: 'applied',
    consumed_by_event_id: 'mutation:open-old',
    status_reason: 'put_page_applied',
  });
  expect(consumed).toMatchObject({
    id: openOld,
    status: 'applied',
    consumed_by_event_id: 'mutation:open-old',
    status_reason: 'put_page_applied',
  });
  expect(consumed.consumed_at).toBeInstanceOf(Date);
  expect(await (engine as any).consumeMemoryWriteSession(openOld, {
    status: 'abandoned',
    status_reason: 'second_consume',
  })).toBeNull();

  await expect((engine as any).createMemoryWriteSession({
    id: `${prefix}:blank-target`,
    route_decision_id: `${prefix}:route-blank-target`,
    scope_id: 'workspace:default',
    actor: 'agent:router',
    target_slug: '   ',
    target_object_type: 'curated_note',
    expected_content_hash: null,
    source_refs: sourceRefs,
    route_decision: 'canonical_write_allowed',
    intended_operation: 'put_page',
    expires_at: new Date(Date.now() + 120_000),
  })).rejects.toThrow(/target_slug/i);
  await expect((engine as any).createMemoryWriteSession({
    id: `${prefix}:empty-source-refs`,
    route_decision_id: `${prefix}:route-empty-source-refs`,
    scope_id: 'workspace:default',
    actor: 'agent:router',
    target_slug: 'concepts/write-session-invalid',
    target_object_type: 'curated_note',
    expected_content_hash: null,
    source_refs: [],
    route_decision: 'canonical_write_allowed',
    intended_operation: 'put_page',
    expires_at: new Date(Date.now() + 120_000),
  })).rejects.toThrow(/source_refs/i);
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  const timeoutMs = createHarness === createPgliteHarness
    ? ENGINE_COLD_START_BUDGET_MS
    : undefined;

  test(`${createHarness.name} persists and consumes memory write sessions`, async () => {
    const harness = await createHarness();
    try {
      await expectMemoryWriteSessionsEngine(harness.engine, nextPrefix(harness.label));
    } finally {
      await harness.cleanup();
    }
  }, timeoutMs);
}
