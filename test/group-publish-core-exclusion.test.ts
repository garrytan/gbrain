import { describe, expect, test } from 'bun:test';
import { groupable } from '../src/core/persistence/group-publish.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import type { PreparedMutation } from '../src/core/persistence/coordinator.ts';

const batchRow = { operation: 'put_page', target_kind: 'page', intent: { page_batch: { id: 'b1' } } } as unknown as WriteRequest;
const syncRow = { operation: 'submit_job', target_kind: 'page', intent: { kind: 'managed_sync_import', group: 'g1' } } as unknown as WriteRequest;
const prepared = (extra: Partial<PreparedMutation> = {}) => ({ observedRevision: null, validate: async () => {}, apply: async () => ({}), ...extra }) as unknown as PreparedMutation;

describe('group publication never carries core-locked writes', () => {
  test('a put_pages batch member groups unless it locks core sources', () => {
    expect(groupable(batchRow, prepared())).toBe(true);
    expect(groupable(batchRow, prepared({ exclusiveSources: ['default'] }))).toBe(false);
  });
  test('a managed sync member groups unless it locks core sources', () => {
    expect(groupable(syncRow, prepared())).toBe(true);
    expect(groupable(syncRow, prepared({ exclusiveSources: ['alpha', 'default'] }))).toBe(false);
  });
});
