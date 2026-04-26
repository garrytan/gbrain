import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { allocateSqliteBrain } from './scenarios/helpers.ts';

const content = `---
type: concept
title: Read Only Realm Test
---

This write should be blocked.

---

- 2026-04-25 | Test evidence.
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
});
