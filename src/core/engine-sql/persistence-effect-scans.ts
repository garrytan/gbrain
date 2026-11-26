/**
 * Effect scans: one SQL implementation for both engines (Rust engine persistence, write journal lane).
 *
 * The reads the effect worker's pass (persistence/effects.ts `runEffectPass`) sent through `executeRaw` before it claims
 * effects: the requests whose parked mirror targets only wait on the segmented writer gate
 * (persistence/segmented-mirror-gate.ts `resumeGatedMirrors`), and the effects with a recovery due
 * (persistence/effect-recovery-scan.ts `selectEffectRecoveries`), and the claim's candidate read
 * (persistence/effect-journal.ts `claimPersistenceEffect`), a write receipt's read of its effects (`readRequestEffects`), and the
 * stale and failed embedding effects `gbrain repair embedding-effects` settles (`listEmbeddingCandidates`). Each text is the one its caller has always sent, byte
 * for byte, written out in full so this module imports no persistence code; the codes it matches arrive as arguments.
 * Decisions stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';

/**
 * `readRequestEffects`, every kind: $1 request id. The text `publicEffectsForRequest` (persistence/effect-journal.ts) has always
 * sent, with the kind order pinned to `COLLATE "C"` so it never follows the database's locale.
 */
export const REQUEST_EFFECTS_SQL = 'SELECT kind,state,error_code,outcome,recovery IS NOT NULL AS recovering FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind COLLATE "C"';

/** `readRequestEffects`, the Git effect: $1 request id. The text `gitReceiptState` (persistence/effect-journal.ts) has always sent. */
export const REQUEST_GIT_EFFECT_SQL = `SELECT state,error_code,outcome,recovery IS NOT NULL AS recovering FROM persistence_effects WHERE request_id=$1::uuid AND kind='git' ORDER BY id DESC LIMIT 1`;

/** One effect of a request as its receipt reads it: the stored state, error code and outcome, and whether a recovery is open. */
export interface RequestEffectState { kind: string; state: string; error_code: string | null; outcome: Record<string, unknown> | null; recovering: boolean }

/**
 * The effects of journal request `requestId` as its receipt reads them, in kind order, or only its Git effect when
 * `kind` is `'git'` (`gitReceiptState`). A request id that is not a uuid refuses, as `::uuid` does.
 */
export async function readRequestEffects(exec: LegacyUnscopedRead, requestId: string, kind?: 'git'): Promise<RequestEffectState[]> {
  if (kind === 'git') {
    const rows = await exec.executeRaw<Omit<RequestEffectState, 'kind'>>(REQUEST_GIT_EFFECT_SQL, [requestId]);
    return rows.map(row => ({ kind: 'git', ...row }));
  }
  return exec.executeRaw<RequestEffectState>(REQUEST_EFFECTS_SQL, [requestId]);
}
