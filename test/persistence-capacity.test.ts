/**
 * #5470: configurable receipt retention, a compaction candidate filter that
 * cannot be starved by receipts with unfinished effects, the 80% cumulative
 * capacity warning, refusal hints naming the exact key, and defaults that
 * carry the reported workload for a year. Postgres arm: test/e2e/w5-persistence-postgres.test.ts.
 */
import { expect, test } from 'bun:test';
import { DEFAULT_JOURNAL_LIMITS } from '../src/core/persistence/model.ts';
import { JOURNAL_CONFIG_KEYS } from '../src/core/persistence/limits.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { capacityWarnsAndRefusalNamesTheKey, compactionSkipsUnfinishedReceipts } from './helpers/w5-scenarios.ts';

test('every journal config key is registered for `gbrain config set`', () => {
  expect(JOURNAL_CONFIG_KEYS).toHaveLength(11);
  for (const key of JOURNAL_CONFIG_KEYS) expect(KNOWN_CONFIG_KEYS).toContain(key);
});

test('cumulative principal and brain defaults carry 600 admissions a day for at least a year', () => {
  const perDay = 600, windowDays = 30, reserved = 16_384, retained = 4096;
  const bytesDays = (limit: number) => windowDays + (limit - perDay * windowDays * reserved) / (perDay * retained);
  expect(DEFAULT_JOURNAL_LIMITS.principalLifetimeIds / perDay).toBeGreaterThanOrEqual(365);
  expect(DEFAULT_JOURNAL_LIMITS.brainLifetimeIds / perDay).toBeGreaterThanOrEqual(365);
  expect(bytesDays(DEFAULT_JOURNAL_LIMITS.principalTerminalBytes)).toBeGreaterThanOrEqual(365);
  expect(bytesDays(DEFAULT_JOURNAL_LIMITS.brainTerminalBytes)).toBeGreaterThanOrEqual(365);
});

test('configured retention compacts receipts past a backlog of unfinished effects', () => compactionSkipsUnfinishedReceipts(), 180_000);
test('doctor warns at 80% of a cumulative cap and the refusal names the key and a value', () => capacityWarnsAndRefusalNamesTheKey(), 120_000);

test('the one-year capacity hint uses the sampled interval, not a one-day floor', async () => {
  const { oneYearCapacity } = await import('../src/core/persistence/limits.ts');
  const engine = { executeRaw: async (sql: string) => sql.includes('persistence_requests') ? [{ admissions: 1000, age_seconds: 8640 }] : [] };
  expect(await oneYearCapacity(engine as never, 'principal:local_cli:example', 'LifetimeIds', 250_000, 250_000)).toBe(250_000 + 10_000 * 365);
});

test('doctor emits one command per brain-wide key with the largest value any principal needs', async () => {
  const { checkPersistenceCapacity } = await import('../src/commands/doctor/checks/persistence-capacity.ts');
  const counter = (key: string) => ({ key, outstanding_count: '0', intent_bytes: '0', lifetime_ids: '9', terminal_bytes: '0', recovery_bytes: '0' });
  const engine = { executeRaw: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM persistence_counters')) return [counter('principal:local_cli:fast'), counter('principal:local_cli:slow')];
    if (sql.includes("LIKE 'persistence.limits.%'")) return [{ key: 'persistence.limits.principal_lifetime_ids', value: '10' }];
    if (sql.includes('persistence_requests')) return [{ admissions: 1000, age_seconds: params[1] === 'fast' ? 8640 : 864_000 }];
    return [];
  } };
  const check = await checkPersistenceCapacity(engine as never);
  expect(check.status).toBe('warn');
  expect((check.details as { commands: string[] }).commands).toEqual(['gbrain config set persistence.limits.principal_lifetime_ids 3650009']);
});
