import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { operations } from '../src/core/operations.ts';
import type { Operation, OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hashCanonicalJson } from '../src/core/services/target-snapshot-hash-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

async function createSqliteHarness(label: string): Promise<{
  engine: SQLiteEngine;
  ctx: (dryRun?: boolean) => OperationContext;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-memory-session-${label}-`));
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  return {
    engine,
    ctx: (dryRun = false) => ({
      engine,
      config: { engine: 'sqlite', database_path: join(dir, 'brain.db') },
      logger: console,
      dryRun,
    } as unknown as OperationContext),
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(label: string): Promise<{
  engine: PGLiteEngine;
  ctx: (dryRun?: boolean) => OperationContext;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-memory-session-${label}-`));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(dir, 'brain-pglite') });
  await engine.initSchema();
  return {
    engine,
    ctx: (dryRun = false) => ({
      engine,
      config: { engine: 'pglite', database_path: join(dir, 'brain-pglite') },
      logger: console,
      dryRun,
    } as unknown as OperationContext),
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function getOperation(name: string): Operation {
  const operation = operations.find((candidate) => candidate.name === name);
  if (!operation) throw new Error(`Operation not found: ${name}`);
  return operation;
}

describe('memory session attachment operations', () => {
  test('register session and attachment operations with useful schemas', () => {
    const create = getOperation('create_memory_session');
    const get = getOperation('get_memory_session');
    const listSessions = getOperation('list_memory_sessions');
    const close = getOperation('close_memory_session');
    const attach = getOperation('attach_memory_realm_to_session');
    const list = getOperation('list_memory_session_attachments');

    expect(create.mutating).toBe(true);
    expect(create.params.id.required).toBe(true);
    expect(create.params.task_id.nullable).toBe(true);
    expect(create.params.actor_ref.nullable).toBe(true);
    expect(create.params.expires_at.nullable).toBe(true);

    expect(get.mutating).toBe(false);
    expect(get.params.id.required).toBe(true);

    expect(listSessions.mutating).toBe(false);
    expect(listSessions.params.status.enum).toEqual(['active', 'expired', 'closed']);
    expect(listSessions.params.task_id.type).toBe('string');
    expect(listSessions.params.actor_ref.type).toBe('string');
    expect(listSessions.params.realm_id.type).toBe('string');
    expect(listSessions.params.created_since.type).toBe('string');
    expect(listSessions.params.created_until.type).toBe('string');
    expect(listSessions.params.limit.default).toBe(100);
    expect(listSessions.params.offset.default).toBe(0);

    expect(close.mutating).toBe(true);
    expect(close.params.id.required).toBe(true);

    expect(attach.mutating).toBe(true);
    expect(attach.params.session_id.required).toBe(true);
    expect(attach.params.realm_id.required).toBe(true);
    expect(attach.params.access.required).toBe(true);
    expect(attach.params.access.enum).toEqual(['read_only', 'read_write']);

    expect(list.mutating).toBe(false);
    expect(list.params.limit.default).toBe(100);
    expect(list.params.offset.default).toBe(0);
  });

  test('creates a session, attaches a realm read-only, lists attachments, and closes the session', async () => {
    const harness = await createSqliteHarness('operation-flow');
    try {
      const upsertRealm = getOperation('upsert_memory_realm');
      const createSession = getOperation('create_memory_session');
      const getSession = getOperation('get_memory_session');
      const listSessions = getOperation('list_memory_sessions');
      const attachRealm = getOperation('attach_memory_realm_to_session');
      const listAttachments = getOperation('list_memory_session_attachments');
      const closeSession = getOperation('close_memory_session');

      await upsertRealm.handler(harness.ctx(), {
        id: 'realm:session-flow',
        name: 'Session Flow Realm',
        scope: 'work',
        default_access: 'read_only',
      });

      const created = await createSession.handler(harness.ctx(), {
        id: 'session-flow',
        task_id: 'task-flow',
        actor_ref: 'agent:test',
        expires_at: '2999-01-01T00:00:00.000Z',
      }) as any;
      expect(created).toMatchObject({
        id: 'session-flow',
        task_id: 'task-flow',
        status: 'active',
        actor_ref: 'agent:test',
        closed_at: null,
      });
      expect(created.created_at).toBeInstanceOf(Date);
      expect(created.expires_at.toISOString()).toBe('2999-01-01T00:00:00.000Z');

      const fetched = await getSession.handler(harness.ctx(), {
        id: 'session-flow',
      }) as any;
      expect(fetched).toMatchObject({
        id: 'session-flow',
        status: 'active',
      });
      expect(fetched.expires_at.toISOString()).toBe('2999-01-01T00:00:00.000Z');

      const attachment = await attachRealm.handler(harness.ctx(), {
        session_id: 'session-flow',
        realm_id: 'realm:session-flow',
        access: 'read_only',
        instructions: 'Use this realm as read-only context for the task.',
      }) as any;
      expect(attachment).toMatchObject({
        session_id: 'session-flow',
        realm_id: 'realm:session-flow',
        access: 'read_only',
        instructions: 'Use this realm as read-only context for the task.',
      });
      expect(attachment.attached_at).toBeInstanceOf(Date);

      const bySession = await listAttachments.handler(harness.ctx(), {
        session_id: 'session-flow',
      }) as any[];
      expect(bySession).toHaveLength(1);
      expect(bySession[0]).toMatchObject({
        session_id: 'session-flow',
        realm_id: 'realm:session-flow',
        access: 'read_only',
      });

      const byRealm = await listAttachments.handler(harness.ctx(), {
        realm_id: 'realm:session-flow',
      }) as any[];
      expect(byRealm.map((entry) => entry.session_id)).toEqual(['session-flow']);

      const sessionsByRealm = await listSessions.handler(harness.ctx(), {
        realm_id: 'realm:session-flow',
      }) as any[];
      expect(sessionsByRealm.map((entry) => entry.id)).toEqual(['session-flow']);

      const closed = await closeSession.handler(harness.ctx(), {
        id: 'session-flow',
      }) as any;
      expect(closed).toMatchObject({
        id: 'session-flow',
        status: 'closed',
      });
      expect(closed.closed_at).toBeInstanceOf(Date);

      const events = await harness.engine.listMemoryMutationEvents({
        session_id: 'session-flow',
        limit: 10,
      });
      const eventsByOperation = new Map(events.map((event) => [event.operation, event]));
      const activeSessionHash = hashCanonicalJson({
        id: 'session-flow',
        task_id: 'task-flow',
        actor_ref: 'agent:test',
        closed_at: null,
        expires_at: '2999-01-01T00:00:00.000Z',
      });
      const closedSessionHash = hashCanonicalJson({
        id: 'session-flow',
        task_id: 'task-flow',
        actor_ref: 'agent:test',
        closed_at: closed.closed_at,
        expires_at: '2999-01-01T00:00:00.000Z',
      });
      const attachmentHash = hashCanonicalJson({
        session_id: 'session-flow',
        realm_id: 'realm:session-flow',
        access: 'read_only',
        instructions: 'Use this realm as read-only context for the task.',
      });
      expect([...eventsByOperation.keys()].sort()).toEqual([
        'attach_memory_realm_to_session',
        'close_memory_session',
        'create_memory_session',
      ]);

      expect(eventsByOperation.get('create_memory_session')).toMatchObject({
        session_id: 'session-flow',
        realm_id: 'session:session-flow',
        operation: 'create_memory_session',
        target_kind: 'memory_session',
        target_id: 'session-flow',
        result: 'applied',
        dry_run: false,
        expected_target_snapshot_hash: null,
        current_target_snapshot_hash: activeSessionHash,
      });
      expect(eventsByOperation.get('create_memory_session')?.source_refs).toEqual([
        'Source: mbrain create_memory_session operation',
      ]);

      expect(eventsByOperation.get('attach_memory_realm_to_session')).toMatchObject({
        session_id: 'session-flow',
        realm_id: 'realm:session-flow',
        operation: 'attach_memory_realm_to_session',
        target_kind: 'memory_session_attachment',
        target_id: 'memory_session_attachment:v1:session-flow:realm%3Asession-flow',
        result: 'applied',
        dry_run: false,
        expected_target_snapshot_hash: null,
        current_target_snapshot_hash: attachmentHash,
        metadata: {
          access: 'read_only',
        },
      });
      expect(eventsByOperation.get('attach_memory_realm_to_session')?.source_refs).toEqual([
        'Source: mbrain attach_memory_realm_to_session operation',
      ]);

      expect(eventsByOperation.get('close_memory_session')).toMatchObject({
        session_id: 'session-flow',
        realm_id: 'session:session-flow',
        operation: 'close_memory_session',
        target_kind: 'memory_session',
        target_id: 'session-flow',
        result: 'applied',
        dry_run: false,
        expected_target_snapshot_hash: activeSessionHash,
        current_target_snapshot_hash: closedSessionHash,
      });
      expect(eventsByOperation.get('close_memory_session')?.source_refs).toEqual([
        'Source: mbrain close_memory_session operation',
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test('mutating session and attachment operations respect dry-run without writing ledger events', async () => {
    const harness = await createSqliteHarness('dry-run');
    try {
      const upsertRealm = getOperation('upsert_memory_realm');
      const createSession = getOperation('create_memory_session');
      const attachRealm = getOperation('attach_memory_realm_to_session');
      const listAttachments = getOperation('list_memory_session_attachments');
      const closeSession = getOperation('close_memory_session');

      await upsertRealm.handler(harness.ctx(), {
        id: 'realm:dry-run',
        name: 'Dry Run Realm',
        scope: 'work',
      });

      const dryCreate = await createSession.handler(harness.ctx(true), {
        id: 'session-dry-create',
        task_id: 'task-dry',
        expires_at: '2999-01-01T00:00:00.000Z',
      }) as any;
      expect(dryCreate).toMatchObject({
        action: 'create_memory_session',
        dry_run: true,
        session: {
          id: 'session-dry-create',
          task_id: 'task-dry',
          status: 'active',
        },
      });
      expect(dryCreate.session.expires_at.toISOString()).toBe('2999-01-01T00:00:00.000Z');

      await expect(attachRealm.handler(harness.ctx(), {
        session_id: 'session-dry-create',
        realm_id: 'realm:dry-run',
        access: 'read_only',
      })).rejects.toThrow();

      await createSession.handler(harness.ctx(), {
        id: 'session-dry-existing',
      });

      const dryAttach = await attachRealm.handler(harness.ctx(true), {
        session_id: 'session-dry-existing',
        realm_id: 'realm:dry-run',
        access: 'read_write',
        instructions: 'Dry-run attachment only.',
      }) as any;
      expect(dryAttach).toMatchObject({
        action: 'attach_memory_realm_to_session',
        dry_run: true,
        attachment: {
          session_id: 'session-dry-existing',
          realm_id: 'realm:dry-run',
          access: 'read_write',
          instructions: 'Dry-run attachment only.',
        },
      });

      await expect(attachRealm.handler(harness.ctx(true), {
        session_id: 'session-dry-existing',
        realm_id: 'realm:dry-run',
        access: 'read_only',
        source_refs: [],
      })).rejects.toThrow('source_refs must contain at least one provenance reference');

      expect(await listAttachments.handler(harness.ctx(), {
        session_id: 'session-dry-existing',
      })).toEqual([]);

      const dryClose = await closeSession.handler(harness.ctx(true), {
        id: 'session-dry-existing',
      }) as any;
      expect(dryClose).toMatchObject({
        action: 'close_memory_session',
        dry_run: true,
        session: {
          id: 'session-dry-existing',
          status: 'closed',
        },
      });
      const activeAfterDryClose = await (harness.engine as any).getMemorySession('session-dry-existing');
      expect(activeAfterDryClose).toMatchObject({
        id: 'session-dry-existing',
        status: 'active',
        closed_at: null,
      });

      await closeSession.handler(harness.ctx(), {
        id: 'session-dry-existing',
      });

      const dryRunTargetIds = [
        'session-dry-create',
        'memory_session_attachment:v1:session-dry-existing:realm%3Adry-run',
      ];
      for (const target_id of dryRunTargetIds) {
        expect(await harness.engine.listMemoryMutationEvents({
          target_id,
          result: 'dry_run',
        })).toEqual([]);
      }
      expect(await harness.engine.listMemoryMutationEvents({
        operation: 'attach_memory_realm_to_session' as any,
        target_id: 'memory_session_attachment:v1:session-dry-existing:realm%3Adry-run',
      })).toEqual([]);
      expect(await harness.engine.listMemoryMutationEvents({
        operation: 'close_memory_session' as any,
        target_id: 'session-dry-existing',
      })).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  test('expired sessions are returned effectively expired and cannot be attached or closed again', async () => {
    const harness = await createSqliteHarness('expired-session');
    try {
      const upsertRealm = getOperation('upsert_memory_realm');
      const createSession = getOperation('create_memory_session');
      const getSession = getOperation('get_memory_session');
      const listSessions = getOperation('list_memory_sessions');
      const attachRealm = getOperation('attach_memory_realm_to_session');
      const listAttachments = getOperation('list_memory_session_attachments');
      const closeSession = getOperation('close_memory_session');

      await upsertRealm.handler(harness.ctx(), {
        id: 'realm:expired-session',
        name: 'Expired Session Realm',
        scope: 'work',
      });
      await createSession.handler(harness.ctx(), {
        id: 'session-expired',
        task_id: 'task-expired',
        actor_ref: 'agent:expired',
        expires_at: '2000-01-01T00:00:00.000Z',
      });

      const dryCreateExpired = await createSession.handler(harness.ctx(true), {
        id: 'session-expired-dry-run',
        task_id: 'task-expired',
        actor_ref: 'agent:expired',
        expires_at: '2000-01-01T00:00:00.000Z',
      }) as any;
      expect(dryCreateExpired).toMatchObject({
        action: 'create_memory_session',
        dry_run: true,
        session: {
          id: 'session-expired-dry-run',
          status: 'expired',
        },
      });

      const fetched = await getSession.handler(harness.ctx(), {
        id: 'session-expired',
      }) as any;
      expect(fetched).toMatchObject({
        id: 'session-expired',
        status: 'expired',
        task_id: 'task-expired',
        actor_ref: 'agent:expired',
        closed_at: null,
      });
      expect(fetched.expires_at.toISOString()).toBe('2000-01-01T00:00:00.000Z');

      const expired = await listSessions.handler(harness.ctx(), {
        status: 'expired',
        task_id: 'task-expired',
        actor_ref: 'agent:expired',
      }) as any[];
      expect(expired.map((entry) => entry.id)).toEqual(['session-expired']);

      const active = await listSessions.handler(harness.ctx(), {
        status: 'active',
        task_id: 'task-expired',
      }) as any[];
      expect(active).toEqual([]);

      await expect(attachRealm.handler(harness.ctx(true), {
        session_id: 'session-expired',
        realm_id: 'realm:expired-session',
        access: 'read_only',
      })).rejects.toThrow('memory session is expired: session-expired');

      await expect(attachRealm.handler(harness.ctx(), {
        session_id: 'session-expired',
        realm_id: 'realm:expired-session',
        access: 'read_write',
      })).rejects.toThrow('memory session is expired: session-expired');

      await expect(harness.engine.attachMemoryRealmToSession({
        session_id: 'session-expired',
        realm_id: 'realm:expired-session',
        access: 'read_only',
      })).rejects.toThrow('Memory session is expired: session-expired');

      const closeExpired = await closeSession.handler(harness.ctx(), {
        id: 'session-expired',
      }) as any;
      expect(closeExpired).toMatchObject({
        id: 'session-expired',
        status: 'expired',
        closed_at: null,
      });

      expect(await listAttachments.handler(harness.ctx(), {
        session_id: 'session-expired',
      })).toEqual([]);
      expect(await harness.engine.listMemoryMutationEvents({
        operation: 'close_memory_session' as any,
        target_id: 'session-expired',
      })).toEqual([]);
      expect(await harness.engine.listMemoryMutationEvents({
        operation: 'attach_memory_realm_to_session' as any,
        target_id: 'memory_session_attachment:v1:session-expired:realm%3Aexpired-session',
      })).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test('list session status filters return rows matching the requested status under app clock skew', async () => {
    const harness = await createSqliteHarness('list-session-clock-skew');
    const originalDateNow = Date.now;
    try {
      const createSession = getOperation('create_memory_session');
      const listSessions = getOperation('list_memory_sessions');

      await createSession.handler(harness.ctx(), {
        id: 'session-clock-skew-active',
        expires_at: '2999-01-01T00:00:00.000Z',
      });
      await createSession.handler(harness.ctx(), {
        id: 'session-clock-skew-expired',
        expires_at: '2000-01-01T00:00:00.000Z',
      });

      Date.now = () => Date.parse('3000-01-01T00:00:00.000Z');
      const active = await listSessions.handler(harness.ctx(), {
        status: 'active',
      }) as any[];
      expect(active.map((entry) => [entry.id, entry.status])).toContainEqual([
        'session-clock-skew-active',
        'active',
      ]);

      Date.now = () => Date.parse('1999-01-01T00:00:00.000Z');
      const expired = await listSessions.handler(harness.ctx(), {
        status: 'expired',
      }) as any[];
      expect(expired.map((entry) => [entry.id, entry.status])).toContainEqual([
        'session-clock-skew-expired',
        'expired',
      ]);
    } finally {
      Date.now = originalDateNow;
      await harness.cleanup();
    }
  });

  test('list sessions filters by effective status, realm, actor, task, created window, and pagination', async () => {
    const harness = await createSqliteHarness('list-session-filters');
    try {
      const upsertRealm = getOperation('upsert_memory_realm');
      const createSession = getOperation('create_memory_session');
      const attachRealm = getOperation('attach_memory_realm_to_session');
      const listSessions = getOperation('list_memory_sessions');

      await upsertRealm.handler(harness.ctx(), {
        id: 'realm:list-a',
        name: 'List Realm A',
        scope: 'work',
      });
      await upsertRealm.handler(harness.ctx(), {
        id: 'realm:list-b',
        name: 'List Realm B',
        scope: 'personal',
      });

      await createSession.handler(harness.ctx(), {
        id: 'session-list-active-a',
        task_id: 'task-list',
        actor_ref: 'agent:list',
      });
      await createSession.handler(harness.ctx(), {
        id: 'session-list-active-b',
        task_id: 'task-list',
        actor_ref: 'agent:list',
      });
      await createSession.handler(harness.ctx(), {
        id: 'session-list-expired',
        task_id: 'task-list',
        actor_ref: 'agent:list',
        expires_at: '2000-01-01T00:00:00.000Z',
      });
      await createSession.handler(harness.ctx(), {
        id: 'session-list-other-actor',
        task_id: 'task-list',
        actor_ref: 'agent:other',
      });

      await attachRealm.handler(harness.ctx(), {
        session_id: 'session-list-active-a',
        realm_id: 'realm:list-a',
        access: 'read_only',
      });
      await attachRealm.handler(harness.ctx(), {
        session_id: 'session-list-active-b',
        realm_id: 'realm:list-b',
        access: 'read_only',
      });

      const activeForRealm = await listSessions.handler(harness.ctx(), {
        status: 'active',
        task_id: 'task-list',
        actor_ref: 'agent:list',
        realm_id: 'realm:list-a',
      }) as any[];
      expect(activeForRealm.map((entry) => entry.id)).toEqual(['session-list-active-a']);

      const expiredForTask = await listSessions.handler(harness.ctx(), {
        status: 'expired',
        task_id: 'task-list',
      }) as any[];
      expect(expiredForTask.map((entry) => entry.id)).toEqual(['session-list-expired']);

      const allInWindow = await listSessions.handler(harness.ctx(), {
        created_since: '1999-01-01T00:00:00.000Z',
        created_until: '2999-01-01T00:00:00.000Z',
        limit: 2,
        offset: 1,
      }) as any[];
      expect(allInWindow).toHaveLength(2);
      expect(allInWindow.map((entry) => entry.created_at instanceof Date)).toEqual([true, true]);

      await expect(listSessions.handler(harness.ctx(), {
        status: 'revoked',
      })).rejects.toThrow('status must be one of: active, expired, closed');

      await expect(listSessions.handler(harness.ctx(), {
        created_since: 'not-a-date',
      })).rejects.toThrow('created_since must be a valid ISO timestamp');
    } finally {
      await harness.cleanup();
    }
  });

  test('PGLite session operations enforce effective expiry and realm filters', async () => {
    const harness = await createPgliteHarness('pglite-expiry-flow');
    try {
      const upsertRealm = getOperation('upsert_memory_realm');
      const createSession = getOperation('create_memory_session');
      const attachRealm = getOperation('attach_memory_realm_to_session');
      const listSessions = getOperation('list_memory_sessions');

      await upsertRealm.handler(harness.ctx(), {
        id: 'realm:pglite-session-flow',
        name: 'PGLite Session Flow Realm',
        scope: 'work',
      });
      await createSession.handler(harness.ctx(), {
        id: 'session-pglite-active',
        actor_ref: 'agent:pglite',
        expires_at: '2999-01-01T00:00:00.000Z',
      });
      await createSession.handler(harness.ctx(), {
        id: 'session-pglite-expired',
        actor_ref: 'agent:pglite',
        expires_at: '2000-01-01T00:00:00.000Z',
      });

      await attachRealm.handler(harness.ctx(), {
        session_id: 'session-pglite-active',
        realm_id: 'realm:pglite-session-flow',
        access: 'read_only',
      });

      const activeByRealm = await listSessions.handler(harness.ctx(), {
        status: 'active',
        realm_id: 'realm:pglite-session-flow',
      }) as any[];
      expect(activeByRealm.map((entry) => [entry.id, entry.status])).toEqual([
        ['session-pglite-active', 'active'],
      ]);

      const expired = await listSessions.handler(harness.ctx(), {
        status: 'expired',
        actor_ref: 'agent:pglite',
      }) as any[];
      expect(expired.map((entry) => [entry.id, entry.status])).toEqual([
        ['session-pglite-expired', 'expired'],
      ]);

      await expect(attachRealm.handler(harness.ctx(), {
        session_id: 'session-pglite-expired',
        realm_id: 'realm:pglite-session-flow',
        access: 'read_write',
      })).rejects.toThrow('memory session is expired: session-pglite-expired');
    } finally {
      await harness.cleanup();
    }
  }, 10_000);

  test('create rejects invalid expires_at before storage', async () => {
    const harness = await createSqliteHarness('invalid-expiry');
    try {
      const createSession = getOperation('create_memory_session');

      await expect(createSession.handler(harness.ctx(true), {
        id: 'session-invalid-expiry-dry',
        expires_at: 'not-a-date',
      })).rejects.toThrow('expires_at must be a valid ISO timestamp');

      await expect(createSession.handler(harness.ctx(), {
        id: 'session-invalid-expiry-real',
        expires_at: '2026-02-30T00:00:00.000Z',
      })).rejects.toThrow('expires_at must be a valid ISO timestamp');

      expect(await harness.engine.getMemorySession('session-invalid-expiry-real')).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test('attach rejects missing and closed sessions in dry-run and real modes', async () => {
    const harness = await createSqliteHarness('attach-validation');
    try {
      const upsertRealm = getOperation('upsert_memory_realm');
      const createSession = getOperation('create_memory_session');
      const attachRealm = getOperation('attach_memory_realm_to_session');
      const listAttachments = getOperation('list_memory_session_attachments');
      const closeSession = getOperation('close_memory_session');

      await upsertRealm.handler(harness.ctx(), {
        id: 'realm:attach-validation',
        name: 'Attach Validation Realm',
        scope: 'work',
      });

      await expect(attachRealm.handler(harness.ctx(true), {
        session_id: 'missing-session',
        realm_id: 'realm:attach-validation',
        access: 'read_only',
      })).rejects.toThrow('memory session not found: missing-session');

      await createSession.handler(harness.ctx(), {
        id: 'session-attach-validation',
      });
      await closeSession.handler(harness.ctx(), {
        id: 'session-attach-validation',
      });

      await expect(attachRealm.handler(harness.ctx(true), {
        session_id: 'session-attach-validation',
        realm_id: 'realm:attach-validation',
        access: 'read_only',
      })).rejects.toThrow('memory session is closed: session-attach-validation');

      await expect(attachRealm.handler(harness.ctx(), {
        session_id: 'session-attach-validation',
        realm_id: 'realm:attach-validation',
        access: 'read_write',
      })).rejects.toThrow('memory session is closed: session-attach-validation');

      expect(await listAttachments.handler(harness.ctx(), {
        session_id: 'session-attach-validation',
      })).toEqual([]);
      expect(await harness.engine.listMemoryMutationEvents({
        operation: 'attach_memory_realm_to_session' as any,
        target_id: 'memory_session_attachment:v1:session-attach-validation:realm%3Aattach-validation',
      })).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test('close is idempotent without duplicate ledger events and duplicate create is rejected consistently', async () => {
    const harness = await createSqliteHarness('session-idempotency');
    try {
      const createSession = getOperation('create_memory_session');
      const closeSession = getOperation('close_memory_session');

      await createSession.handler(harness.ctx(), {
        id: 'session-idempotent',
      });

      await expect(createSession.handler(harness.ctx(true), {
        id: 'session-idempotent',
      })).rejects.toThrow('memory session already exists: session-idempotent');
      await expect(createSession.handler(harness.ctx(), {
        id: 'session-idempotent',
      })).rejects.toThrow('memory session already exists: session-idempotent');

      const firstClose = await closeSession.handler(harness.ctx(), {
        id: 'session-idempotent',
      }) as any;
      const secondClose = await closeSession.handler(harness.ctx(), {
        id: 'session-idempotent',
      }) as any;

      expect(firstClose).toMatchObject({
        id: 'session-idempotent',
        status: 'closed',
      });
      expect(secondClose).toMatchObject({
        id: 'session-idempotent',
        status: 'closed',
      });
      expect(secondClose.closed_at.toISOString()).toBe(firstClose.closed_at.toISOString());
      expect(await harness.engine.listMemoryMutationEvents({
        operation: 'close_memory_session' as any,
        target_id: 'session-idempotent',
      })).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  test('direct engine attach does not insert when session closes before the insert statement', async () => {
    const harness = await createSqliteHarness('direct-attach-race');
    try {
      await harness.engine.upsertMemoryRealm({
        id: 'realm:direct-attach-race',
        name: 'Direct Attach Race Realm',
        scope: 'work',
      });
      await harness.engine.createMemorySession({
        id: 'session-direct-attach-race',
      });

      const db = (harness.engine as any).database;
      const originalRun = db.run.bind(db);
      let injectedClose = false;
      db.run = (sql: string, ...args: unknown[]) => {
        if (!injectedClose && sql.includes('INSERT INTO memory_session_attachments')) {
          injectedClose = true;
          originalRun(`
            UPDATE memory_sessions
            SET status = 'closed',
                closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = 'session-direct-attach-race'
          `);
        }
        return originalRun(sql, ...args);
      };

      await expect(harness.engine.attachMemoryRealmToSession({
        session_id: 'session-direct-attach-race',
        realm_id: 'realm:direct-attach-race',
        access: 'read_only',
      })).rejects.toThrow('Memory session is closed: session-direct-attach-race');

      expect(await harness.engine.listMemorySessionAttachments({
        session_id: 'session-direct-attach-race',
      })).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });
});
