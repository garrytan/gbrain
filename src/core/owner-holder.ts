/**
 * Canonical holder string for "the brain owner," resolved in ONE place so the
 * calibration / think / doctor / emotional-weight defaults stop disagreeing.
 *
 * The default matches the consolidate facts→takes writer
 * (src/core/cycle/phases/consolidate.ts: holder:'self') and docs/takes-vs-facts.md.
 * Do NOT introduce a fourth literal — three already exist historically
 * ('garry', 'system', 'self'); this is the source of truth.
 *
 * NORMALIZATION NOTE: the brain owner may also appear under other holder
 * strings — 'brain' (propose_takes when the author asserts a claim) and
 * people/<owner> (extraction that names the owner). This resolver only selects
 * the *default* canonical owner string for reads; it does NOT merge those other
 * strings. Unifying them is owner-identity entity-resolution, tracked separately
 * (see garrytan/gbrain#2465). Until then, historical owner takes
 * under 'brain'/people-<owner> are not folded into the default profile.
 */
export const DEFAULT_OWNER_HOLDER = 'self';

export function resolveOwnerHolder(
  opts: { override?: string | null; configValue?: string | null },
): string {
  return opts.override ?? opts.configValue ?? DEFAULT_OWNER_HOLDER;
}
