/**
 * #7108: the timed-out-migration advice picks one fix per case, and
 * `apply-migrations --statement-timeout` sets the migration budget for its own
 * run only. Recording and clearing on a real migration are covered on Postgres
 * in test/e2e/migration-v221-batched-backfill-7108.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationTimeoutAdvice } from '../src/core/migration-timeout-advice.ts';
import { migrationStatementTimeoutMs, type MigrationTimeoutRecord } from '../src/core/migration-timeout.ts';
import { applyMigrations } from '../src/commands/apply-migrations.ts';
import { withEnv } from './helpers/with-env.ts';

const verify = { argv: ['gbrain', 'doctor', '--only', 'schema_version', '--json'] };
const record = (over: Partial<MigrationTimeoutRecord>): MigrationTimeoutRecord =>
  ({ version: 221, name: 'chunk_embedding_pending_since', batched: true, idle_pids: [], at: '2026-10-20T00:00:00.000Z', ...over });

describe('#7108 migration timeout advice', () => {
  test('a migration that timed out unbatched and now has a prelude: rerun, no consent needed', () => {
    const { message, fix } = migrationTimeoutAdvice(record({ batched: false }), verify);
    expect(message).toContain('committed batches');
    expect(fix.ask_user).toBeUndefined();
    expect(fix.argv).toEqual(['gbrain', 'apply-migrations', '--yes']);
  });

  test('idle sessions were open: ask the user, check them with doctor --locks before ending any', () => {
    const { message, fix } = migrationTimeoutAdvice(record({ idle_pids: [4242] }), verify);
    expect(message).toContain('4242');
    expect(message).toContain('may hold locks');
    expect(fix.ask_user).toBe(true);
    expect(fix.user_message).toContain('foresights doctor --locks');
    expect(fix.argv).toEqual(['gbrain', 'apply-migrations', '--yes']);
  });

  test('nothing open: ask the user for one run with a longer budget', () => {
    const { fix } = migrationTimeoutAdvice(record({}), verify);
    expect(fix.ask_user).toBe(true);
    expect(fix.argv).toEqual(['gbrain', 'apply-migrations', '--yes', '--statement-timeout', '120']);
    expect(fix.verify).toEqual(verify);
  });

  test('a migration with no prelude that timed out unbatched gets the same advice as a batched one', () => {
    expect(migrationTimeoutAdvice(record({ version: 153, name: 'verified_text_projection_activation', batched: false }), verify).fix.argv)
      .toContain('--statement-timeout');
  });
});

describe('#7108 apply-migrations --statement-timeout', () => {
  test('the budget applies to that run only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-7108-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await applyMigrations(['--statement-timeout', '0', '--list']);
        expect(migrationStatementTimeoutMs()).toBe(600_000);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
