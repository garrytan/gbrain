import { describe, expect, test } from 'bun:test';
import { reconcileIndexWorkloadEvidence, type IndexWorkloadEvidence } from '../src/commands/doctor/checks/index-workload-evidence.ts';
import { digest } from '../src/core/persistence/digest.ts';

describe('index workload evidence', () => {
  const now = Date.parse('2026-01-04T00:00:00Z');
  const index = {
    name: 'rare_job_idx', index_oid: '3512', table_oid: '3500', index_filenode: '3512', table_filenode: '3500',
    definition_sha256: 'd'.repeat(64),
  };
  const location = { cluster_system_identifier: '748310338751', database_oid: '16384', postgres_major: 17 };
  const retained: IndexWorkloadEvidence = {
    version: 1, location, indexes: [{ index, proof: {
      kind: 'recorded_scan', observed_at: '2026-01-02T00:00:00Z', scans: 3,
      snapshot_sha256: 'e'.repeat(64), lineage_sha256: 'f'.repeat(64),
    } }],
  };

  test('requires the same cluster, database, PostgreSQL major and physical index', () => {
    const replacement = { ...index, index_filenode: '3513' };
    expect(reconcileIndexWorkloadEvidence([index, replacement], location, retained, now)).toMatchObject({
      open: [replacement], proven: 1, receipt: digest(retained),
    });
    expect(reconcileIndexWorkloadEvidence([index], { ...location, database_oid: '16385' }, retained, now).proven).toBe(0);
    expect(reconcileIndexWorkloadEvidence([index], { ...location, postgres_major: 18 }, retained, now).proven).toBe(0);
    expect(reconcileIndexWorkloadEvidence([index], null, retained, now).proven).toBe(0);
    expect(() => reconcileIndexWorkloadEvidence([index], location, retained, now - 4 * 86_400_000)).toThrow();
    expect(() => reconcileIndexWorkloadEvidence([index], location, { ...retained, indexes: [...retained.indexes, ...retained.indexes] }, now)).toThrow();
  });
});
