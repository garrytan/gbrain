/**
 * Recovery record versions this binary reads, and the refusal of every other version. A recovery record a newer gbrain
 * wrote (a version not listed here) is refused `recovery_version_unsupported` before any of its fields is read: it is
 * never misread, rewritten (`upgradeRecoveryStaging`), cleared, or its staged files removed, so the binary that wrote it
 * finishes it once this host is upgraded. v0.60.290.0, which predates this check, reads a version 2 withdrawal-mirror
 * record (`after: null`) as a version 1 record and fails every attempt with an untyped TypeError
 * (`effect_unavailable`); `segmented-mirror-gate.ts` keeps this release from writing one while such a binary is seen.
 */
import { opError, type OperationError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';

/** `persistence_effects.recovery` (effect-model.ts `EffectRecovery`): 1 embeds the file, 2 names a streamed stage. */
export const EFFECT_RECOVERY_VERSIONS: readonly number[] = [1, 2];
/** `persistence_requests.recovery` (model.ts `RecoveryRecord`): 1 one file, 2 a shared-skill bundle. */
export const REQUEST_RECOVERY_VERSIONS: readonly number[] = [1, 2];

export type RecoveryTable = 'persistence_requests' | 'persistence_effects';
const KNOWN: Record<RecoveryTable, readonly number[]> = { persistence_requests: REQUEST_RECOVERY_VERSIONS, persistence_effects: EFFECT_RECOVERY_VERSIONS };

/** True unless the record names a version this binary does not know (an absent record, or one with no version, is not refused). */
export function recoveryVersionKnown(table: RecoveryTable, record: unknown): boolean {
  if (record === null || record === undefined) return true;
  const version = (record as { version?: unknown }).version;
  return version === undefined || (typeof version === 'number' && KNOWN[table].includes(version));
}

/** The upgrade fix: only a newer gbrain on the canonical owner host reads the record. */
export function recoveryUpgradeFix(sourceId: string | null): Action {
  return { argv: ['gbrain', 'upgrade'], consent: [], actor: 'host_admin', requires_exclusive: false,
    why: 'A newer gbrain wrote this recovery record; only a gbrain that knows its version can finish it.',
    user_message: `Run gbrain upgrade on the host that owns ${sourceId ? `source ${sourceId}'s` : 'the source\'s'} canonical worktree, and restart its serve, sync or worker processes; the upgraded writer finishes the recovery. Do not delete the record or its staged files.`,
    verify: { argv: ['gbrain', 'sources', 'writer', 'status', ...(sourceId ? ['--source', sourceId] : []), '--json'] } };
}

export function recoveryVersionUnsupported(table: RecoveryTable, record: unknown, sourceId: string | null): OperationError {
  const version = JSON.stringify((record as { version?: unknown } | null)?.version ?? null);
  const what = table === 'persistence_effects' ? 'withdrawal-mirror effect' : 'write request';
  return opError('recovery_version_unsupported', `A newer gbrain wrote this ${what}'s recovery record (version ${version}); this gbrain cannot read it.`,
    `The ${what} recovery record${sourceId ? ` of source ${sourceId}` : ''} has version ${version}, which this gbrain does not know, so it left the record, its staged files and the canonical file untouched; writes on that worktree wait for it. Tell the user to upgrade gbrain on the owner host (fix); the upgraded writer finishes the recovery.`,
    { fix: recoveryUpgradeFix(sourceId) });
}

/** Refuses a record of a version this binary does not read; call before reading, rewriting or clearing it. */
export function assertRecoveryVersion(table: RecoveryTable, record: unknown, sourceId: string | null): void {
  if (!recoveryVersionKnown(table, record)) throw recoveryVersionUnsupported(table, record, sourceId);
}
