import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

async function createSqliteHarness(label: string): Promise<{
  engine: SQLiteEngine;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-memory-realm-${label}-`));
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  return {
    engine,
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function getOperation(name: string) {
  const operation = operations.find((entry) => entry.name === name);
  if (!operation) throw new Error(`Operation not found: ${name}`);
  return operation;
}

describe('memory realms engine', () => {
  test('SQLite upserts and lists active realms by scope', async () => {
    const harness = await createSqliteHarness('engine');
    try {
      const work = await harness.engine.upsertMemoryRealm({
        id: 'realm:work',
        name: 'Work Realm',
        scope: 'work',
      });
      await harness.engine.upsertMemoryRealm({
        id: 'realm:personal',
        name: 'Personal Realm',
        scope: 'personal',
        default_access: 'read_write',
      });
      await harness.engine.upsertMemoryRealm({
        id: 'realm:archived-work',
        name: 'Archived Work Realm',
        scope: 'work',
        archived_at: '2026-04-25T01:00:00.000Z',
      });

      expect(work).toMatchObject({
        id: 'realm:work',
        name: 'Work Realm',
        description: '',
        scope: 'work',
        default_access: 'read_only',
        retention_policy: 'retain',
        export_policy: 'private',
        agent_instructions: '',
        archived_at: null,
      });
      expect(work.created_at).toBeInstanceOf(Date);
      expect(work.updated_at).toBeInstanceOf(Date);

      expect((await harness.engine.getMemoryRealm('realm:work'))?.id).toBe('realm:work');
      expect(await harness.engine.getMemoryRealm('realm:missing')).toBeNull();
      expect((await harness.engine.listMemoryRealms({ scope: 'work' })).map((realm) => realm.id)).toEqual([
        'realm:work',
      ]);
      expect((await harness.engine.listMemoryRealms({
        scope: 'work',
        include_archived: true,
      })).map((realm) => realm.id).sort()).toEqual([
        'realm:archived-work',
        'realm:work',
      ]);
      expect((await harness.engine.listMemoryRealms({ scope: 'personal' })).map((realm) => realm.id)).toEqual([
        'realm:personal',
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test('SQLite update preserves omitted optional fields on archived realms', async () => {
    const harness = await createSqliteHarness('preserve-archived-update');
    try {
      const archivedAt = '2026-04-25T01:00:00.000Z';
      await harness.engine.upsertMemoryRealm({
        id: 'realm:archived-preserve',
        name: 'Archived Preserve Realm',
        description: 'original description',
        scope: 'work',
        default_access: 'read_write',
        retention_policy: 'retain-for-review',
        export_policy: 'restricted',
        agent_instructions: 'Keep this realm archived until review completes.',
        archived_at: archivedAt,
      });

      const updated = await harness.engine.upsertMemoryRealm({
        id: 'realm:archived-preserve',
        name: 'Archived Preserve Realm Renamed',
        scope: 'work',
      });

      expect(updated).toMatchObject({
        id: 'realm:archived-preserve',
        name: 'Archived Preserve Realm Renamed',
        description: 'original description',
        scope: 'work',
        default_access: 'read_write',
        retention_policy: 'retain-for-review',
        export_policy: 'restricted',
        agent_instructions: 'Keep this realm archived until review completes.',
      });
      expect(updated.archived_at?.toISOString()).toBe(archivedAt);
      expect((await harness.engine.listMemoryRealms({ scope: 'work' })).map((realm) => realm.id)).toEqual([]);
      expect((await harness.engine.listMemoryRealms({
        scope: 'work',
        include_archived: true,
      })).map((realm) => realm.id)).toEqual(['realm:archived-preserve']);
    } finally {
      await harness.cleanup();
    }
  });

  test('SQLite upsert preserves optional fields without reading existing realm through getMemoryRealm', async () => {
    const harness = await createSqliteHarness('preserve-without-js-read');
    try {
      const archivedAt = '2026-04-25T01:00:00.000Z';
      await harness.engine.upsertMemoryRealm({
        id: 'realm:no-stale-read',
        name: 'No Stale Read Realm',
        description: 'description before concurrent update',
        scope: 'work',
        default_access: 'read_write',
        retention_policy: 'retain-for-review',
        export_policy: 'restricted',
        agent_instructions: 'Preserve these instructions atomically.',
        archived_at: archivedAt,
      });

      const originalGetMemoryRealm = harness.engine.getMemoryRealm.bind(harness.engine);
      const getMemoryRealmCalls: string[] = [];
      harness.engine.getMemoryRealm = async (id: string) => {
        getMemoryRealmCalls.push(id);
        throw new Error('getMemoryRealm should not be called during upsertMemoryRealm');
      };

      let updated: Awaited<ReturnType<SQLiteEngine['upsertMemoryRealm']>>;
      try {
        updated = await harness.engine.upsertMemoryRealm({
          id: 'realm:no-stale-read',
          name: 'No Stale Read Realm Renamed',
          scope: 'personal',
        });
      } finally {
        harness.engine.getMemoryRealm = originalGetMemoryRealm;
      }

      expect(getMemoryRealmCalls).toEqual([]);
      expect(updated).toMatchObject({
        id: 'realm:no-stale-read',
        name: 'No Stale Read Realm Renamed',
        description: 'description before concurrent update',
        scope: 'personal',
        default_access: 'read_write',
        retention_policy: 'retain-for-review',
        export_policy: 'restricted',
        agent_instructions: 'Preserve these instructions atomically.',
      });
      expect(updated.archived_at?.toISOString()).toBe(archivedAt);
    } finally {
      await harness.cleanup();
    }
  });

  test('SQLite engine rejects invalid archived_at strings before storage', async () => {
    const harness = await createSqliteHarness('invalid-archived-at');
    try {
      await expect(harness.engine.upsertMemoryRealm({
        id: 'realm:bad-archive-date',
        name: 'Bad Archive Date Realm',
        scope: 'work',
        archived_at: 'not-a-date',
      })).rejects.toThrow(/archived_at|timestamp|date/i);
      expect(await harness.engine.getMemoryRealm('realm:bad-archive-date')).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test('SQLite engine rejects calendar-invalid archived_at strings before storage', async () => {
    const harness = await createSqliteHarness('calendar-invalid-archived-at');
    try {
      await expect(harness.engine.upsertMemoryRealm({
        id: 'realm:calendar-invalid-archive-date',
        name: 'Calendar Invalid Archive Date Realm',
        scope: 'work',
        archived_at: '2026-02-31T00:00:00.000Z',
      })).rejects.toThrow(/archived_at|timestamp|date/i);
      expect(await harness.engine.getMemoryRealm('realm:calendar-invalid-archive-date')).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});

describe('memory realm operations', () => {
  test('upsert_memory_realm exposes nullable archived_at schema metadata', () => {
    const upsert = getOperation('upsert_memory_realm');
    expect(upsert.params.archived_at).toMatchObject({
      type: 'string',
      nullable: true,
    });
  });

  test('upsert_memory_realm respects dry-run and validates enum fields', async () => {
    const harness = await createSqliteHarness('operations');
    try {
      const upsert = getOperation('upsert_memory_realm');
      const list = getOperation('list_memory_realms');

      const preview = await upsert.handler({
        engine: harness.engine,
        config: { engine: 'sqlite' },
        dryRun: true,
      } as any, {
        id: 'realm:dry-run',
        name: 'Dry Run Realm',
        scope: 'work',
      });
      expect(preview).toMatchObject({
        action: 'upsert_memory_realm',
        dry_run: true,
        realm: {
          id: 'realm:dry-run',
          name: 'Dry Run Realm',
          scope: 'work',
          default_access: 'read_only',
        },
      });
      expect(await harness.engine.getMemoryRealm('realm:dry-run')).toBeNull();

      await expect(upsert.handler({
        engine: harness.engine,
        config: { engine: 'sqlite' },
        dryRun: false,
      } as any, {
        id: 'realm:invalid-scope',
        name: 'Invalid Scope Realm',
        scope: 'outside',
      })).rejects.toThrow(/scope/i);

      const created = await upsert.handler({
        engine: harness.engine,
        config: { engine: 'sqlite' },
        dryRun: false,
      } as any, {
        id: 'realm:operation',
        name: 'Operation Realm',
        scope: 'mixed',
        default_access: 'read_write',
      });
      expect(created).toMatchObject({
        id: 'realm:operation',
        scope: 'mixed',
        default_access: 'read_write',
      });

      const listed = await list.handler({
        engine: harness.engine,
        config: { engine: 'sqlite' },
        dryRun: false,
      } as any, {
        scope: 'mixed',
      });
      expect(listed).toMatchObject([
        {
          id: 'realm:operation',
          scope: 'mixed',
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test('upsert_memory_realm dry-run previews existing realm merge and writes no ledger', async () => {
    const harness = await createSqliteHarness('dry-run-existing-merge');
    try {
      const upsert = getOperation('upsert_memory_realm');
      const archivedAt = '2026-04-25T01:00:00.000Z';

      await harness.engine.upsertMemoryRealm({
        id: 'realm:dry-run-existing',
        name: 'Existing Dry Run Realm',
        description: 'existing dry-run description',
        scope: 'work',
        default_access: 'read_write',
        retention_policy: 'retain-for-review',
        export_policy: 'restricted',
        agent_instructions: 'Keep dry-run previews aligned with real updates.',
        archived_at: archivedAt,
      });

      const preview = await upsert.handler({
        engine: harness.engine,
        config: { engine: 'sqlite' },
        dryRun: true,
      } as any, {
        id: 'realm:dry-run-existing',
        name: 'Existing Dry Run Realm Renamed',
        scope: 'personal',
      });

      expect(preview).toMatchObject({
        action: 'upsert_memory_realm',
        dry_run: true,
        realm: {
          id: 'realm:dry-run-existing',
          name: 'Existing Dry Run Realm Renamed',
          description: 'existing dry-run description',
          scope: 'personal',
          default_access: 'read_write',
          retention_policy: 'retain-for-review',
          export_policy: 'restricted',
          agent_instructions: 'Keep dry-run previews aligned with real updates.',
        },
      });
      expect((preview as any).realm.archived_at?.toISOString()).toBe(archivedAt);
      expect(await harness.engine.listMemoryMutationEvents({
        operation: 'upsert_memory_realm' as any,
        target_kind: 'memory_realm' as any,
        target_id: 'realm:dry-run-existing',
      })).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test('upsert_memory_realm dry-run normalizes offset archived_at like a real write', async () => {
    const harness = await createSqliteHarness('dry-run-offset-archived-at');
    try {
      const upsert = getOperation('upsert_memory_realm');
      const archivedAt = '2026-04-25T01:00:00+02:00';
      const expectedArchivedAt = '2026-04-24T23:00:00.000Z';

      const preview = await upsert.handler({
        engine: harness.engine,
        config: { engine: 'sqlite' },
        dryRun: true,
      } as any, {
        id: 'realm:dry-run-offset-archive-date',
        name: 'Dry Run Offset Archive Date Realm',
        scope: 'work',
        archived_at: archivedAt,
      });

      expect((preview as any).realm.archived_at).toBeInstanceOf(Date);
      expect((preview as any).realm.archived_at?.toISOString()).toBe(expectedArchivedAt);
      expect(await harness.engine.getMemoryRealm('realm:dry-run-offset-archive-date')).toBeNull();

      const written = await upsert.handler({
        engine: harness.engine,
        config: { engine: 'sqlite' },
        dryRun: false,
      } as any, {
        id: 'realm:dry-run-offset-archive-date',
        name: 'Dry Run Offset Archive Date Realm',
        scope: 'work',
        archived_at: archivedAt,
      });

      expect((written as any).archived_at).toBeInstanceOf(Date);
      expect((written as any).archived_at?.toISOString()).toBe(expectedArchivedAt);
    } finally {
      await harness.cleanup();
    }
  });

  test('upsert_memory_realm rejects calendar-invalid archived_at strings before storage', async () => {
    const harness = await createSqliteHarness('operation-calendar-invalid-archived-at');
    try {
      const upsert = getOperation('upsert_memory_realm');

      await expect(upsert.handler({
        engine: harness.engine,
        config: { engine: 'sqlite' },
        dryRun: true,
      } as any, {
        id: 'realm:operation-calendar-invalid-archive-date',
        name: 'Operation Calendar Invalid Archive Date Realm',
        scope: 'work',
        archived_at: '2026-02-31T00:00:00.000Z',
      })).rejects.toThrow(/archived_at|timestamp|date/i);
      expect(await harness.engine.getMemoryRealm('realm:operation-calendar-invalid-archive-date')).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test('upsert_memory_realm records an applied ledger event and dry-run records none', async () => {
    const harness = await createSqliteHarness('operation-ledger');
    try {
      const upsert = getOperation('upsert_memory_realm');

      await upsert.handler({
        engine: harness.engine,
        config: { engine: 'sqlite' },
        dryRun: false,
      } as any, {
        id: 'realm:ledger',
        name: 'Ledger Realm',
        scope: 'work',
        default_access: 'read_write',
      });

      const events = await harness.engine.listMemoryMutationEvents({
        operation: 'upsert_memory_realm' as any,
        target_kind: 'memory_realm' as any,
        target_id: 'realm:ledger',
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        operation: 'upsert_memory_realm',
        target_kind: 'memory_realm',
        target_id: 'realm:ledger',
        realm_id: 'realm:ledger',
        scope_id: 'work',
        result: 'applied',
        dry_run: false,
        actor: 'mbrain:memory_control_plane',
      });
      expect(events[0].source_refs).toEqual(['Source: mbrain upsert_memory_realm operation']);
      expect(events[0].metadata).toMatchObject({
        action: 'upsert',
        realm_scope: 'work',
        realm_default_access: 'read_write',
      });

      await upsert.handler({
        engine: harness.engine,
        config: { engine: 'sqlite' },
        dryRun: true,
      } as any, {
        id: 'realm:dry-ledger',
        name: 'Dry Ledger Realm',
        scope: 'personal',
      });

      expect(await harness.engine.listMemoryMutationEvents({
        operation: 'upsert_memory_realm' as any,
        target_kind: 'memory_realm' as any,
        target_id: 'realm:dry-ledger',
      })).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });
});
