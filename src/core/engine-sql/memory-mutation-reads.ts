/**
 * The reads `remember` and `forget` (src/core/persistence/memory-mutations.ts) ran through `executeRaw` before they had
 * typed members. Each function keeps the statement text its call site ran, so PGLite and Postgres answer exactly as
 * before (test/memory-mutation-reads-sql-pin.test.ts pins the Postgres text); a Rust brain answers from its store
 * (rust/crates/gbrain-store/src/facts/memory_reads.rs).
 *
 * - `readSourceWriteRow`: the source row a memory write admits against (incarnation, archived, checkout, kind, role).
 * - `readSourceLocalPath`: a source's checkout path, for the missing-entity-page notice.
 * - `readFactEntitySlug`: the entity a fact is keyed under, for a member's withdrawal of a shared fact about itself.
 * - `hasLiveFileBackedPage`: whether a live page among the struck slugs has a file, so forget must strike it there.
 * - `factReadableUnder`: whether the caller reads a fact (the member withdrawal check), under the caller's visibility,
 *   read eligibility and, optionally, the private-provenance policy.
 * - `readRemoteForgetTier`: the stored tier of the world fact a remote forget targets
 *   (guardRemoteForget, src/core/trust/supersede-handlers.ts), optionally under the remote provenance floor.
 * - `readForgetTarget`: the fact a forget names (src/core/persistence/forget-prepare.ts) under the caller's visibility,
 *   optionally under the remote provenance floor, or on a member's own page; locked FOR UPDATE with `lock`.
 * - `isFactEntityUnbacked`, `readLinkedFactCopies` and `hasHiddenFactCopy`: whether a forget's withdrawal reaches other
 *   copies of the claim (refuseForgetReachingOtherCopies, src/core/persistence/forget-prepare.ts).
 * - `ownerReachesFact`: whether the brain owner's own credential reaches a fact (forget-prepare.ts, GST-2346 D1).
 * - `readFactWithdrawalClaim`: the claim a withdrawal of a fact changes (planFactWithdrawal, src/core/facts/withdrawal.ts);
 *   `lock` reads it FOR UPDATE (recordFactWithdrawal's row lock).
 */
import type { BrainEngine } from '../engine.ts';
import { renderFragment, type SqlFragment } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

async function rows<T>(exec: Raw, fragment: SqlFragment): Promise<T[]> {
  const { text, params } = renderFragment(fragment);
  return exec.executeRaw<T>(text, params);
}
