/**
 * A write the brain's engine refused (`engine_capability_missing`, the Rust engine) tells the caller which capability
 * it lacked and where, read from the refusal detail the receipt row already stores.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for a failed receipt with code `engine_capability_missing` and a stored
 *    `{ origin: 'engine_capability', member, capability, stage? }`, the error `writeResponse` throws carries
 *    `reason` = the capability and `detail` = `member=<m> capability=<c>` plus ` stage=<s>` when a stage is stored.
 *    Every other receipt keeps the reason and detail it had: no other code, no other stored origin and no pending
 *    write gains either field.
 *  - Regression: the receipt error left `reason` and `detail` undefined, so a caller (and the parity harness's
 *    capability check) could not tell which capability the write needed.
 *  - Why existing coverage misses it: the consumer test checks the stored row, never the caller's error.
 *  - Seam: hand-built receipt rows; `writeResponse` reads nothing else.
 */
import { describe, expect, test } from 'bun:test';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { writeResponse } from '../src/core/persistence/service.ts';

const row = (fields: Record<string, unknown>) => ({
  request_id: '00000000-0000-4000-8000-000000000002', state: 'failed', source_id: 'notes-example', operation: 'put_page',
  slug: 'notes/a', error_message: 'The engine does not serve this write.', created_at: new Date(0), updated_at: new Date(0), ...fields,
}) as unknown as WriteRequest;
const delivered = (r: WriteRequest): Record<string, unknown> => {
  try { writeResponse(r); } catch (error) { return error as Record<string, unknown>; }
  throw new Error('writeResponse did not throw for a failed receipt');
};
const refusal = { origin: 'engine_capability', member: 'executeRaw', capability: 'raw_sql' };

describe('a capability refusal receipt names the capability', () => {
  test('with a stored stage', () => {
    const error = delivered(row({ error_code: 'engine_capability_missing', error_detail: { ...refusal, stage: 'publication' } }));
    expect(error).toMatchObject({ code: 'engine_capability_missing', reason: 'raw_sql', detail: 'member=executeRaw capability=raw_sql stage=publication' });
  });

  test('without a stored stage', () => {
    const error = delivered(row({ error_code: 'engine_capability_missing', error_detail: refusal }));
    expect(error).toMatchObject({ reason: 'raw_sql', detail: 'member=executeRaw capability=raw_sql' });
  });

  test('a refusal stored without its detail keeps no reason and no detail', () => {
    const error = delivered(row({ error_code: 'engine_capability_missing', error_detail: null }));
    expect(error.reason).toBeUndefined();
    expect(error.detail).toBeUndefined();
  });

  test('another code with the same stored detail is unchanged', () => {
    const error = delivered(row({ error_code: 'storage_error', error_detail: { ...refusal, stage: 'publication' } }));
    expect(error.code).toBe('storage_error');
    expect(error.reason).toBeUndefined();
    expect(error.detail).toBeUndefined();
  });
});
