import { expect, test } from 'bun:test';
import { CRASH_BOUNDARIES, runReconcileCrashCase } from '../fixtures/reconcile-crash-worker.ts';

const databaseUrl = process.env.DATABASE_URL;
const enabled = true;
for (const boundary of CRASH_BOUNDARIES) {
  test.skipIf(!databaseUrl)(`Postgres reconciliation survives SIGKILL/${boundary}, activation=${enabled}`, async () => {
    const result = await runReconcileCrashCase({ kind: 'postgres', boundary, enabled, databaseUrl });
    expect(result).toMatchObject({ status: 'passed', boundary, enabled, killed_signal: 'SIGKILL',
      committed_requests: 1, added_versions: 1, normal_apply_replay: true, originals_retained: true,
      receipt_unchanged: true, recovery_cleared: true, staging_cleaned: true, topology_unchanged: true, counters_conserved: true });
    if (boundary === 'staging_flushed') expect(result.flushed_before_rename_verified).toBe(true);
    if (boundary === 'after_response') expect(result.response_read_before_kill).toBe(true);
  }, 180_000);
}
