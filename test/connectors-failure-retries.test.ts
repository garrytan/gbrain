/** Failed chat archives stay recoverable without full-history traffic. Existing
 * checkpoint coverage only had failures inside the list window. Removing the
 * retained-ID retry queue regresses these caps and edit/recovery contracts.
 * Pure selection tests need no new production test seam.
 */
import { describe, expect, test } from 'bun:test';
import { FAILURE_RETRY_LIMIT, selectConversationFetches } from '../src/core/connectors/failures.ts';
import type { ConversationFailure } from '../src/core/connectors/failures.ts';

const OLD = '2026-07-01T00:00:00.000Z';
const NEW = '2026-08-01T00:00:00.000Z';
const NOW = Date.parse(NEW);

describe('bounded conversation recovery', () => {
  test('due quarantines are capped and rotate after attempted failures while new work still progresses', () => {
    const failed: Record<string, ConversationFailure> = Object.fromEntries(
      Array.from({ length: FAILURE_RETRY_LIMIT + 2 }, (_, i) => [`old-${String(i).padStart(2, '0')}`, { attempts: 3, updatedAt: OLD }]));
    const stubs = [{ id: 'new', updatedAt: NEW }];
    const first = selectConversationFetches(stubs, {}, failed, false, NOW);
    expect(first.pending).toHaveLength(FAILURE_RETRY_LIMIT + 1);
    expect(first.pending.at(-1)?.id).toBe('new');
    for (const stub of first.pending.slice(0, FAILURE_RETRY_LIMIT)) failed[stub.id].nextRetryAt = '2026-08-02T00:00:00.000Z';
    const next = selectConversationFetches(stubs, {}, failed, false, NOW);
    expect(next.pending.map(s => s.id)).toEqual(['old-10', 'old-11', 'new']);
  });

  test('listed failures share the cap with unseen failures and never double-fetch', () => {
    const failed: Record<string, ConversationFailure> = Object.fromEntries(
      Array.from({ length: FAILURE_RETRY_LIMIT + 1 }, (_, i) => [`c-${i}`, { attempts: 3, updatedAt: OLD }]));
    const stubs = Object.keys(failed).map(id => ({ id, updatedAt: OLD }));
    const { pending } = selectConversationFetches(stubs, {}, failed, false, NOW);
    expect(pending).toHaveLength(FAILURE_RETRY_LIMIT);
    expect(new Set(pending.map(s => s.id)).size).toBe(FAILURE_RETRY_LIMIT);
  });

  test('an edit or explicit full retry bypasses quarantine backoff, not unchanged successful history', () => {
    const failed = { old: { attempts: 3, updatedAt: OLD, nextRetryAt: '2026-08-02T00:00:00.000Z' } };
    const stubs = [{ id: 'old', updatedAt: NEW }, { id: 'ok', updatedAt: OLD }];
    expect(selectConversationFetches(stubs, { ok: OLD }, failed, false, NOW)).toEqual({ pending: [stubs[0]], skippedUnchanged: 1 });
    expect(selectConversationFetches([{ id: 'old', updatedAt: OLD }], {}, failed, true, NOW).pending).toHaveLength(1);
  });
});
