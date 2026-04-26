import { describe, expect, test } from 'bun:test';
import { OperationError, operations } from '../src/core/operations.ts';
import { allocateSqliteBrain } from './scenarios/helpers.ts';

const STALE_HASH = 'a'.repeat(64);

const content = `---
type: concept
title: Read Only Realm Test
---

This write should be blocked.

---

- 2026-04-25 | Test evidence.
`;

const citedContent = `---
type: concept
title: Read Write Realm Test
---

This write should be allowed. [Source: Memory session access policy test, 2026-04-25 12:00 PM KST]

---

- 2026-04-25 | Test evidence. [Source: Memory session access policy test, 2026-04-25 12:00 PM KST]
`;

function operation(name: string) {
  const found = operations.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Operation not found: ${name}`);
  return found;
}

function ctx(handle: Awaited<ReturnType<typeof allocateSqliteBrain>>) {
  return {
    engine: handle.engine,
    config: {},
    logger: console,
    dryRun: false,
  } as any;
}

describe('memory session access policy', () => {
  test('put_page rejects writes to a read-only attached realm when memory_session_id is supplied', async () => {
    const handle = await allocateSqliteBrain('session-access-policy');
    const upsertRealm = operation('upsert_memory_realm');
    const createSession = operation('create_memory_session');
    const attach = operation('attach_memory_realm_to_session');
    const put = operation('put_page');

    try {
      await upsertRealm.handler(ctx(handle), {
        id: 'project:readonly',
        name: 'Read Only Project',
        scope: 'work',
        default_access: 'read_only',
      });
      await createSession.handler(ctx(handle), {
        id: 'session-readonly',
      });
      await attach.handler(ctx(handle), {
        session_id: 'session-readonly',
        realm_id: 'project:readonly',
        access: 'read_only',
      });

      await expect(put.handler(ctx(handle), {
        slug: 'concepts/readonly-realm-test',
        content,
        memory_session_id: 'session-readonly',
        realm_id: 'project:readonly',
      })).rejects.toThrow(/read-only/i);
    } finally {
      await handle.teardown();
    }
  });

  test('put_page reports missing realm_id for memory_session_id as an OperationError', async () => {
    const handle = await allocateSqliteBrain('session-access-policy-missing-realm');
    const createSession = operation('create_memory_session');
    const put = operation('put_page');

    try {
      await createSession.handler(ctx(handle), {
        id: 'session-missing-realm',
      });

      let error: unknown;
      try {
        await put.handler(ctx(handle), {
          slug: 'concepts/missing-realm-test',
          content,
          memory_session_id: 'session-missing-realm',
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('invalid_params');
      expect((error as Error).message).toMatch(/requires realm_id/i);
      expect(await handle.engine.getPage('concepts/missing-realm-test')).toBeNull();
    } finally {
      await handle.teardown();
    }
  });

  test('put_page allows writes to a read-write attached realm when memory_session_id is supplied', async () => {
    const handle = await allocateSqliteBrain('session-access-policy-read-write');
    const upsertRealm = operation('upsert_memory_realm');
    const createSession = operation('create_memory_session');
    const attach = operation('attach_memory_realm_to_session');
    const put = operation('put_page');

    try {
      await upsertRealm.handler(ctx(handle), {
        id: 'project:read-write',
        name: 'Read Write Project',
        scope: 'work',
        default_access: 'read_only',
      });
      await createSession.handler(ctx(handle), {
        id: 'session-read-write',
      });
      await attach.handler(ctx(handle), {
        session_id: 'session-read-write',
        realm_id: 'project:read-write',
        access: 'read_write',
      });

      const result = await put.handler(ctx(handle), {
        slug: 'concepts/read-write-realm-test',
        content: citedContent,
        memory_session_id: 'session-read-write',
        realm_id: 'project:read-write',
      }) as any;

      expect(result.status).toBe('created_or_updated');
      expect(await handle.engine.getPage('concepts/read-write-realm-test')).toMatchObject({
        slug: 'concepts/read-write-realm-test',
      });
    } finally {
      await handle.teardown();
    }
  });

  test('put_page rejects writes authorized by a closed session with a read-write attachment', async () => {
    const handle = await allocateSqliteBrain('session-access-policy-closed');
    const upsertRealm = operation('upsert_memory_realm');
    const createSession = operation('create_memory_session');
    const attach = operation('attach_memory_realm_to_session');
    const closeSession = operation('close_memory_session');
    const put = operation('put_page');

    try {
      await upsertRealm.handler(ctx(handle), {
        id: 'project:closed-session',
        name: 'Closed Session Project',
        scope: 'work',
        default_access: 'read_only',
      });
      await createSession.handler(ctx(handle), {
        id: 'session-closed-policy',
      });
      await attach.handler(ctx(handle), {
        session_id: 'session-closed-policy',
        realm_id: 'project:closed-session',
        access: 'read_write',
      });
      await closeSession.handler(ctx(handle), {
        id: 'session-closed-policy',
      });

      let error: unknown;
      try {
        await put.handler(ctx(handle), {
          slug: 'concepts/closed-session-policy-test',
          content: citedContent,
          memory_session_id: 'session-closed-policy',
          realm_id: 'project:closed-session',
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('invalid_params');
      expect((error as Error).message).toMatch(/not active/i);
      expect(await handle.engine.getPage('concepts/closed-session-policy-test')).toBeNull();
    } finally {
      await handle.teardown();
    }
  });

  test('put_page rejects writes authorized by an expired session with a read-write attachment', async () => {
    const handle = await allocateSqliteBrain('session-access-policy-expired');
    const upsertRealm = operation('upsert_memory_realm');
    const createSession = operation('create_memory_session');
    const attach = operation('attach_memory_realm_to_session');
    const put = operation('put_page');

    try {
      await upsertRealm.handler(ctx(handle), {
        id: 'project:expired-session',
        name: 'Expired Session Project',
        scope: 'work',
        default_access: 'read_only',
      });
      await createSession.handler(ctx(handle), {
        id: 'session-expired-policy',
        expires_at: '2999-01-01T00:00:00.000Z',
      });
      await attach.handler(ctx(handle), {
        session_id: 'session-expired-policy',
        realm_id: 'project:expired-session',
        access: 'read_write',
      });
      (handle.engine as any).database.run(`
        UPDATE memory_sessions
        SET expires_at = '2000-01-01T00:00:00.000Z'
        WHERE id = 'session-expired-policy'
      `);

      let error: unknown;
      try {
        await put.handler(ctx(handle), {
          slug: 'concepts/expired-session-policy-test',
          content: citedContent,
          memory_session_id: 'session-expired-policy',
          realm_id: 'project:expired-session',
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('invalid_params');
      expect((error as Error).message).toMatch(/not active/i);
      expect(await handle.engine.getPage('concepts/expired-session-policy-test')).toBeNull();
    } finally {
      await handle.teardown();
    }
  });

  test('put_page denies authorization before content hash precondition handling', async () => {
    const handle = await allocateSqliteBrain('session-access-policy-before-precondition');
    const upsertRealm = operation('upsert_memory_realm');
    const createSession = operation('create_memory_session');
    const attach = operation('attach_memory_realm_to_session');
    const put = operation('put_page');
    const sessionId = 'put-page-denied-before-precondition';
    const slug = 'concepts/authorization-before-precondition';

    try {
      await put.handler(ctx(handle), {
        slug,
        content: citedContent,
      });
      await upsertRealm.handler(ctx(handle), {
        id: 'project:denied-before-precondition',
        name: 'Denied Before Precondition Project',
        scope: 'work',
        default_access: 'read_only',
      });
      await createSession.handler(ctx(handle), {
        id: 'session-denied-before-precondition',
      });
      await attach.handler(ctx(handle), {
        session_id: 'session-denied-before-precondition',
        realm_id: 'project:denied-before-precondition',
        access: 'read_only',
      });

      let error: unknown;
      try {
        await put.handler(ctx(handle), {
          slug,
          content: citedContent,
          expected_content_hash: STALE_HASH,
          session_id: sessionId,
          source_refs: ['Source: denied authorization precondition test'],
          memory_session_id: 'session-denied-before-precondition',
          realm_id: 'project:denied-before-precondition',
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('invalid_params');
      expect((error as Error).message).toMatch(/read-only/i);
      expect(await handle.engine.listMemoryMutationEvents({ session_id: sessionId })).toEqual([]);
    } finally {
      await handle.teardown();
    }
  });

  test('put_page checks memory session access inside the page write transaction', async () => {
    const handle = await allocateSqliteBrain('session-access-policy-transaction');
    const upsertRealm = operation('upsert_memory_realm');
    const createSession = operation('create_memory_session');
    const attach = operation('attach_memory_realm_to_session');
    const put = operation('put_page');
    const originalGetMemorySession = handle.engine.getMemorySession.bind(handle.engine);
    const originalTransaction = handle.engine.transaction.bind(handle.engine);
    let insideTransaction = false;

    handle.engine.getMemorySession = async (id: string) => {
      if (!insideTransaction) throw new Error('getMemorySession called outside transaction');
      return originalGetMemorySession(id);
    };
    handle.engine.transaction = async (fn: any) => originalTransaction(async (tx) => {
      const wasInside = insideTransaction;
      insideTransaction = true;
      try {
        return await fn(tx);
      } finally {
        insideTransaction = wasInside;
      }
    });

    try {
      await upsertRealm.handler(ctx(handle), {
        id: 'project:transaction-policy',
        name: 'Transaction Policy Project',
        scope: 'work',
        default_access: 'read_only',
      });
      await createSession.handler(ctx(handle), {
        id: 'session-transaction-policy',
      });
      await attach.handler(ctx(handle), {
        session_id: 'session-transaction-policy',
        realm_id: 'project:transaction-policy',
        access: 'read_write',
      });

      await expect(put.handler(ctx(handle), {
        slug: 'concepts/transaction-policy-test',
        content: citedContent,
        memory_session_id: 'session-transaction-policy',
        realm_id: 'project:transaction-policy',
      })).resolves.toMatchObject({
        status: 'created_or_updated',
      });
    } finally {
      await handle.teardown();
    }
  });
});
