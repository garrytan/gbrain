/**
 * Shared registry-enumeration helper for tests that sweep the canonical
 * operation contract (src/core/operations.ts).
 *
 * Rationale: several suites need "every op" / "every op of shape X" and each
 * used to hand-roll its own filter over the registry. One helper means one
 * definition of each enumeration, so a contract change (new op, new param)
 * updates every sweeping test through a single seam.
 *
 * This is a plain helper (not a test file): no env mutation, no mock.module,
 * no engine — safe to import from any lane.
 */
import { operations, type Operation } from '../../src/core/operations.ts';
import { jobsOperations } from '../../src/core/ops/jobs.ts';

/** The full canonical `operations` array — every op, in contract order. */
export function allOperations(): Operation[] {
  return operations;
}

/**
 * Remotely-servable read surface: non-localOnly ops with `scope: 'read'`.
 * (localOnly ops dispatch on stdio only; write/admin/agent scopes excluded.)
 */
export function readOps(): Operation[] {
  return operations.filter(op => !op.localOnly && op.scope === 'read');
}

/**
 * Jobs-cluster ops (src/core/ops/jobs.ts) that take a job `id` param — the
 * enumeration the token-redaction registry sweep ratchets over. Same
 * truthiness filter the sweep always used, so behavior is identical.
 */
export function idTakingJobsOps(): Operation[] {
  return jobsOperations.filter(o => o.params && (o.params as Record<string, unknown>).id);
}
