/**
 * The ledger fingerprint of a claim recorded before fact_fingerprint_v3 (v341).
 *
 * Before v341, Postgres's gbrain_fact_fingerprint folded whitespace by the locale's `[[:space:]]`, so a claim holding a
 * character the two folds disagree on (U+0085, U+1680, ...) changed fingerprint at the upgrade while the belief events
 * recorded before it keep the old one (gbrain_fact_fingerprint_v2) in subject_key and claim_fp. Such a claim keeps the
 * old fingerprint as its ledger fingerprint, so its subject, its later-private matches and its purge redaction stay
 * those of its recorded history. PGLite's `[[:space:]]` already was the explicit list, so there both are the same.
 */
import type { BrainEngine } from '../engine.ts';
import { factFingerprintV2Sql, mayHaveLegacyFingerprint } from '../facts/withdrawal-schema.ts';

export { mayHaveLegacyFingerprint };

/**
 * Claim text to its pre-v341 fingerprint, for each claim whose v2 fingerprint differs from the current one and names an
 * event of `sourceId` that recorded this claim (its value's fact or claim has the claim's current fingerprint, so a new
 * claim never joins an older, different claim that shares the v2 fold). Claims absent keep the current fingerprint.
 */
export async function legacyClaimFingerprints(tx: Pick<BrainEngine, 'readLegacyClaimFingerprints'>, sourceId: string, claims: Iterable<string>): Promise<Map<string, string>> {
  const texts = [...new Set([...claims].filter(mayHaveLegacyFingerprint))];
  if (!texts.length) return new Map();
  const rows = await tx.readLegacyClaimFingerprints(sourceId, texts);
  return new Map(rows.map(r => [r.claim, r.fingerprint]));
}

/**
 * SQL: the subject keys of `sourceId`'s ($1) fact and take events recorded under the pre-v341 fingerprint of a claim in
 * text array `claims` (the event's value names the claim), so a purge redacts the history a claim has under its old fingerprint.
 */
export const legacySubjectKeysSql = (claims: string): string => `SELECT DISTINCT e.subject_key FROM unnest(${claims}) AS c
  CROSS JOIN LATERAL (SELECT gbrain_fact_fingerprint(c) AS fp, ${factFingerprintV2Sql('c')} AS v2) x
  JOIN belief_events e ON e.source_id = $1 AND e.claim_fp = x.v2
  WHERE x.v2 <> x.fp AND e.subject_kind IN ('fact','take') AND e.value IS NOT NULL
    AND gbrain_fact_fingerprint(COALESCE(e.value->>'fact', e.value->>'claim')) = x.fp`;
