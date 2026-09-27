import { describe, expect, test } from 'bun:test';
import { CRASH_BOUNDARIES, runValidation } from '../../scripts/persistence/validate.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres process-separated journal concurrency', () => {
  test('isolated database verifies competing principals, publication boundaries and durable recovery', async () => {
    const result = await runValidation({ engine: 'postgres', databaseUrl: url, schedules: 50, operations: 64, seed: 5105 });
    expect(result.status).toBe('passed'); expect(result.full_gate).toBe(false);
    expect(CRASH_BOUNDARIES).toHaveLength(8);
    expect(result.crash_cases.map((entry: { boundary: string }) => entry.boundary)).toEqual([...CRASH_BOUNDARIES]);
    expect(result.crash_cases.find((entry: { boundary: string }) => entry.boundary === 'staging_flushed').flushed_before_rename_verified).toBe(true);
    expect(result.crash_cases.find((entry: { boundary: string }) => entry.boundary === 'staging_flushed').unexpected_staging_preserved).toBe(true);
    expect(result.crash_cases.find((entry: { boundary: string }) => entry.boundary === 'after_response').response_read_before_kill).toBe(true);
    expect(Object.values(result.schedules.cases)).toEqual(Array(10).fill(5));
    expect(Object.values(result.schedules.boundaries)).toEqual(Array(5).fill(1));
    expect(result.soak.owner_processes).toBe(2); expect(result.soak.producer_processes).toBe(4);
    expect(result.soak.verified).toBe(64);
  }, 120_000);
});
