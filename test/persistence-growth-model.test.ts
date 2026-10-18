/**
 * #6696 (A2): the default cumulative caps give an autopilot brain at 5,000
 * admissions a day at least 365 days on every scope and resource, by the
 * growth model in docs/guides/concurrent-writes.md#growth-model: request ids
 * grow by the admission rate; receipt bytes hold the admission reservation
 * through the retention window and their compacted size after, with the
 * model's allowance for bulk days and carried-in receipts held aside.
 */
import { expect, test } from 'bun:test';
import { DEFAULT_JOURNAL_LIMITS } from '../src/core/persistence/model.ts';
import { DEFAULT_RECEIPT_RETENTION_DAYS, RETAINED_RECEIPT_BYTES } from '../src/core/persistence/limits.ts';
import { RECEIPT_RESERVATION_FLOOR } from '../src/core/persistence/receipt-bytes.ts';

const PER_DAY = 5_000;
/** Three 22,074-admission bulk days in one window, and 74,982 carried-in receipts at 16,383 bytes (the model's figures). */
const BULK_BYTES = 3 * 22_074 * RECEIPT_RESERVATION_FLOOR;
const CARRIED_BYTES = 1_228_424_148;

function idDays(limit: number): number { return limit / PER_DAY; }
function byteDays(limit: number): number {
  const window = PER_DAY * RECEIPT_RESERVATION_FLOOR * DEFAULT_RECEIPT_RETENTION_DAYS;
  const left = limit - BULK_BYTES - CARRIED_BYTES - window;
  return left < 0 ? 0 : DEFAULT_RECEIPT_RETENTION_DAYS + left / (PER_DAY * RETAINED_RECEIPT_BYTES);
}

test('the default caps cover at least 365 days at 5,000 admissions a day on every scope and resource', () => {
  const days = {
    principal_lifetime_ids: idDays(DEFAULT_JOURNAL_LIMITS.principalLifetimeIds),
    brain_lifetime_ids: idDays(DEFAULT_JOURNAL_LIMITS.brainLifetimeIds),
    principal_terminal_bytes: byteDays(DEFAULT_JOURNAL_LIMITS.principalTerminalBytes),
    brain_terminal_bytes: byteDays(DEFAULT_JOURNAL_LIMITS.brainTerminalBytes),
  };
  for (const [key, value] of Object.entries(days)) expect({ key, enough: value >= 365 }).toEqual({ key, enough: true });
  expect(DEFAULT_JOURNAL_LIMITS.principalLifetimeIds).toBeGreaterThanOrEqual(2_000_000);
});
