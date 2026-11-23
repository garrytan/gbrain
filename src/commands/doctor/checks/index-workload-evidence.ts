import { z } from 'zod';
import { gbrainPath } from '../../../core/config.ts';
import { readPrivateAuditJson } from '../audit/private-audit-json.ts';
import { digest } from '../../../core/persistence/digest.ts';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^[1-9][0-9]{0,9}$/);
const location = z.strictObject({
  cluster_system_identifier: z.string().regex(/^[0-9]{1,20}$/),
  database_oid: oid,
  postgres_major: z.number().int(),
});
const identity = z.strictObject({
  name: z.string().min(1).max(63),
  index_oid: oid,
  table_oid: oid,
  index_filenode: oid,
  table_filenode: oid,
  definition_sha256: sha256,
});
const historical = z.strictObject({
  kind: z.literal('recorded_scan'),
  observed_at: z.iso.datetime({ offset: true }),
  scans: z.number().int().positive(),
  snapshot_sha256: sha256,
  lineage_sha256: sha256,
});
const workload = z.strictObject({
  kind: z.literal('workload'),
  observed_at: z.iso.datetime({ offset: true }),
  workload_id: z.string().regex(/^[a-z][a-z0-9_-]{2,79}$/),
  selected_by_planner: z.literal(true),
  equivalent_results: z.literal(true),
  plan_sha256: sha256,
});
const evidence = z.strictObject({
  version: z.literal(1),
  location,
  indexes: z.array(z.strictObject({
    index: identity,
    proof: z.discriminatedUnion('kind', [historical, workload]),
  })).min(1).max(1000),
});

export type IndexAuditIdentity = z.infer<typeof identity>;
export type IndexAuditLocation = z.infer<typeof location>;
export type IndexWorkloadEvidence = z.infer<typeof evidence>;

export function readIndexWorkloadEvidence(): IndexWorkloadEvidence | null {
  try {
    return evidence.parse(readPrivateAuditJson(gbrainPath('doctor', 'index-workload-evidence.json'), 2 * 1024 * 1024));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function reconcileIndexWorkloadEvidence(
  pending: readonly IndexAuditIdentity[], live: IndexAuditLocation | null, retained: IndexWorkloadEvidence | null, now = Date.now(),
): { open: IndexAuditIdentity[]; proven: number; receipt?: string } {
  if (!retained || !live || digest(live) !== digest(retained.location)) return { open: [...pending], proven: 0 };
  const claimed = new Map<string, string>();
  for (const { index, proof } of retained.indexes) {
    if (claimed.has(index.index_oid) || Date.parse(proof.observed_at) > now) {
      throw new Error('Expected one past observation per index');
    }
    claimed.set(index.index_oid, digest(index));
  }
  const open = pending.filter(index => digest(index) !== claimed.get(index.index_oid));
  return { open, proven: pending.length - open.length, receipt: digest(retained) };
}
