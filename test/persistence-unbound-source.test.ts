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
import { parseUnboundWriteValue, readUnboundWritePolicy, UNBOUND_PUBLICATION_MESSAGE, UNBOUND_SOURCE_DOCS } from '../src/core/persistence/unbound-source.ts';

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
    expect(error.suggestion).toBe('Inspect this receipt before submitting a new request_id.');
  });
});
