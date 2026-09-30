import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operations, resolveRequestedScope, type OperationContext } from '../src/core/operations.ts';
import { BRAIN_TOOL_ALLOWLIST, buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  return { engine: {} as any, config: {} as any, logger: console as any, dryRun: false,
    remote: true, sourceId: 'source-a', ...overrides };
}

describe('operation authorization boundaries', () => {
  test('scalar and empty-array remote grants reject an explicit foreign source', () => {
    for (const remote of [true, undefined]) {
      for (const allowedSources of [undefined, []]) {
        const ctx = context({ remote, auth: { allowedSources } as any });
        expect(() => resolveRequestedScope(ctx, 'source-b')).toThrow(/granted sources/);
        expect(resolveRequestedScope(ctx, 'source-a')).toEqual({ sourceId: 'source-a' });
      }
    }
  });

  test('unqualified reads retain the scalar default and local explicit routing', () => {
    expect(resolveRequestedScope(context(), undefined)).toEqual({ sourceId: 'source-a' });
    expect(resolveRequestedScope(context({ remote: false }), 'source-b')).toEqual({ sourceId: 'source-b' });
  });

  describe('forget_fact with a durable source-scoped remote grant', () => {
    let engine: PGLiteEngine;
    const op = operations.find(op => op.name === 'forget_fact')!;
    const clientId = 'authorization-boundary-client';
    const caller = () => context({ engine, config: { engine: 'pglite', embedding_disabled: true },
      auth: { token: 'synthetic-token', clientId, principal: { kind: 'oauth_client', id: clientId },
        sourceId: 'source-a', scopes: ['read', 'write'], allowedOperations: ['forget_fact'] } });

    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('source-a','Source A'),('source-b','Source B')");
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,allowed_operations)
        VALUES($1,'Authorization boundary fixture','read write','source-a',$2)`, [clientId, ['forget_fact']]);
    }, 60_000);
    afterAll(async () => { await engine.disconnect(); });

    test.each([['source-b', 'world'], ['source-a', 'private']] as const)(
      'cannot expire a %s/%s fact', async (sourceId, visibility) => {
        const claim = 'Protected fixture memory';
        const fact = await engine.insertFact({ fact: claim, source: 'test', visibility }, { source_id: sourceId });
        const requestId = randomUUID();
        await expect(op.handler(caller(), { id: fact.id, request_id: requestId })).rejects.toMatchObject({ code: 'fact_not_found' });
        expect(await engine.executeRaw('SELECT expired_at FROM facts WHERE id=$1', [fact.id])).toEqual([{ expired_at: null }]);
        expect(await engine.executeRaw(`SELECT fact_hash FROM fact_withdrawals
          WHERE source_id=$1 AND visibility=$2 AND fact_hash=gbrain_fact_fingerprint($3)`,
          [sourceId, visibility, claim])).toEqual([]);
        expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [requestId])).toEqual([]);
      });

    test('the same grant can withdraw a world-visible fact in its source', async () => {
      const fact = await engine.insertFact({ fact: 'Allowed fixture memory', source: 'test', visibility: 'world' }, { source_id: 'source-a' });
      await expect(op.handler(caller(), { id: fact.id })).resolves.toMatchObject({ id: fact.id, expired: true, state: 'committed' });
      const [stored] = await engine.executeRaw<{ expired_at: unknown }>('SELECT expired_at FROM facts WHERE id=$1', [fact.id]);
      expect(stored?.expired_at).not.toBeNull();
      expect(await engine.executeRaw('SELECT fact_hash FROM fact_withdrawals WHERE source_id=$1', ['source-a'])).toHaveLength(1);
    });
  });

  test('delegated registry contains no attachments or local-only operations', () => {
    const tools = buildBrainTools({ engine: {} as any, config: {} as any, subagentId: 7 });
    expect(tools.some(tool => ['brain_file_list', 'brain_file_url'].includes(tool.name))).toBe(false);
    for (const op of operations.filter(op => BRAIN_TOOL_ALLOWLIST.has(op.name))) {
      expect(op.localOnly).not.toBe(true);
    }
  });
});
