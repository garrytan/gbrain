/**
 * #5254 policy parsing and receipt-delivered hints, without a database.
 * Protects: an unreadable persistence.unbound_write keeps refusing (fail
 * closed), and a publication that lost its unbound precondition delivers the
 * unbound_source detail, hint and docs even though the receipt persists only
 * code and message. The Postgres e2e (test/e2e/unbound-source-postgres.test.ts)
 * covers the full lifecycle but runs only in database lanes.
 */
import { describe, expect, test } from 'bun:test';
import { OperationError } from '../src/core/ops/contract.ts';
import { writeResponse } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { decideUnboundWrite, parseUnboundWriteValue, readUnboundWritePolicy, UNBOUND_PUBLICATION_MESSAGE, UNBOUND_SOURCE_DOCS } from '../src/core/persistence/unbound-source.ts';

describe('persistence.unbound_write', () => {
  test('accepts only refuse and database_only', () => {
    expect(parseUnboundWriteValue('refuse')).toBe('refuse');
    expect(parseUnboundWriteValue('database_only')).toBe('database_only');
    expect(() => parseUnboundWriteValue('Database_Only')).toThrow('persistence.unbound_write must be one of: refuse, database_only');
  });

  test('a missing or unknown stored value keeps refusing', async () => {
    const engine = (value: string | null) => ({ getConfig: async () => value });
    expect(await readUnboundWritePolicy(engine(null))).toBe('refuse');
    expect(await readUnboundWritePolicy(engine('true'))).toBe('refuse');
    expect(await readUnboundWritePolicy(engine('database_only'))).toBe('database_only');
  });
});

// #6608: the one rule page writers and fact writers (remember, loop retirement,
// relink) apply to a write-through source with a root and no owner. remember
// used to refuse every Postgres case with the generic writer-inspection hint.
describe('decideUnboundWrite', () => {
  const engine = (kind: 'postgres' | 'pglite', config: Record<string, string> = {}) => ({
    kind,
    getConfig: async (key: string) => config[key] ?? null,
    executeRaw: async () => [{ enabled: false }],
  }) as unknown as BrainEngine;
  const input = (over: Partial<Parameters<typeof decideUnboundWrite>[1]> = {}) =>
    ({ sourceId: 'notes', sourceKind: null, fileBacked: false, path: '/srv/notes', ...over });
  const refusal = async (promise: Promise<unknown>): Promise<OperationError> => {
    try { await promise; } catch (error) { return error as OperationError; }
    throw new Error('decideUnboundWrite did not refuse');
  };
  const DATABASE_ONLY = { 'persistence.unbound_write': 'database_only' };

  test('a connector source is database-only by design on every engine, file-backed or not', async () => {
    for (const kind of ['postgres', 'pglite'] as const) {
      expect(await decideUnboundWrite(engine(kind), input({ sourceKind: 'google', fileBacked: true })))
        .toEqual({ kind: 'database_only', reason: 'connector_database' });
    }
  });

  test('PGLite claims the source automatically, whatever the policy', async () => {
    expect(await decideUnboundWrite(engine('pglite'), input({ fileBacked: true }))).toEqual({ kind: 'claim' });
    expect(await decideUnboundWrite(engine('pglite', DATABASE_ONLY), input())).toEqual({ kind: 'claim' });
  });

  test('a PGLite source activation listed database-only (#6449) follows the Postgres rule', async () => {
    const listed = { 'persistence.database_only_sources': JSON.stringify(['notes']) };
    expect((await refusal(decideUnboundWrite(engine('pglite', listed), input()))).detail).toBe('unbound_source');
    expect(await decideUnboundWrite(engine('pglite', { ...listed, ...DATABASE_ONLY }), input()))
      .toEqual({ kind: 'database_only', reason: 'unbound_source' });
  });

  test('Postgres with the opt-in writes a page without a canonical file database-only', async () => {
    expect(await decideUnboundWrite(engine('postgres', DATABASE_ONLY), input())).toEqual({ kind: 'database_only', reason: 'unbound_source' });
  });

  test('Postgres without the opt-in refuses with the opt-in named and the user asked', async () => {
    const error = await refusal(decideUnboundWrite(engine('postgres'), input()));
    expect(error.code).toBe('owner_unavailable');
    expect(error.detail).toBe('unbound_source');
    expect(error.retryable).toBe(false);
    expect(error.fix?.ask_user).toBe(true);
    expect(error.suggestion).toContain('gbrain config set persistence.unbound_write database_only');
    expect(error.suggestion).toContain('write the page as /srv/notes/<slug>.md');
  });

  test('a page with a recorded canonical file refuses even with the opt-in, and a remote caller never sees the path', async () => {
    const error = await refusal(decideUnboundWrite(engine('postgres', DATABASE_ONLY), input({ fileBacked: true, path: null })));
    expect(error.detail).toBe('unbound_source');
    expect(error.suggestion).toContain('came from a canonical file');
    expect(error.suggestion).not.toContain('gbrain config set persistence.unbound_write database_only');
    expect(error.suggestion).not.toContain('/srv/notes');
  });
});

describe('receipt-delivered unbound_source failure', () => {
  const row = (error_message: string) => ({
    request_id: '00000000-0000-4000-8000-000000000001', state: 'failed', source_id: 'notes-example',
    error_code: 'owner_unavailable', error_message, created_at: new Date(0), updated_at: new Date(0),
  }) as unknown as WriteRequest;
  const delivered = (message: string): OperationError => {
    try { writeResponse(row(message)); } catch (error) { return error as OperationError; }
    throw new Error('writeResponse did not throw for a failed receipt');
  };

  test('rebuilds detail, filled hint and docs from the persisted message', () => {
    const error = delivered(UNBOUND_PUBLICATION_MESSAGE);
    expect(error.code).toBe('owner_unavailable');
    expect(error.detail).toBe('unbound_source');
    expect(error.docs).toBe(UNBOUND_SOURCE_DOCS);
    expect(error.suggestion).toContain("Source 'notes-example' gained a canonical owner");
    expect(error.suggestion).toContain('new request_id');
  });

  test('leaves other owner_unavailable receipts unchanged', () => {
    const error = delivered('The accepted worktree ownership or source topology changed.');
    expect(error.detail).toBeUndefined();
    expect(error.suggestion).toContain('ended failed with owner_unavailable; it will not publish. Read the receipt and the current state before deciding to submit again; a new attempt needs a new request_id.');
    expect(error.suggestion).not.toContain('unbound');
  });
});
