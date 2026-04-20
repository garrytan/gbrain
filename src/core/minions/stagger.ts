/**
 * Deterministic stagger slots.
 *
 * Jobs sharing a stagger_key (e.g., "social-radar", "x-ingest") get a
 * minute-offset between 0 and 59 computed from the key itself. Same key →
 * same slot, always. Different keys → different slots (collision rate
 * proportional to 1/60).
 *
 * Used by MinionQueue.add(): jobs with a stagger_key get a deterministic
 * release offset before they become claimable. Queue runtime may layer an
 * additional small per-minute spread on top to avoid same-key herd release.
 *
 * Not a general-purpose hash. FNV-1a is tiny, deterministic across
 * runtimes, and enough distinguishing entropy for 60 buckets.
 */

const FNV_OFFSET = 0x811c9dc5 >>> 0;
const FNV_PRIME = 0x01000193;

/** Minutes offset in [0, 59] for the given stagger key. */
export function staggerMinuteOffset(key: string): number {
  if (!key || typeof key !== 'string') return 0;
  let h = FNV_OFFSET;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h % 60;
}

/** Seconds offset — same thing scaled for convenience. */
export function staggerSecondOffset(key: string): number {
  return staggerMinuteOffset(key) * 60;
}
