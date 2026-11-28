/**
 * #7214, GBRA-574 A3: when a fact replaces another, where the retired fact's validity interval ends. It ends where the
 * replacement begins when that falls inside the retired window (after its valid_from, before its stored end or now);
 * otherwise it ends at its stored end or now, whichever is earlier, so a backdated or future-dated replacement never
 * leaves a retired fact open-ended. It never ends before the retired fact's own valid_from (a fact dated after now). A
 * retired fact with no event date (#10288) has no lower bound; a replacement with none ends it at its stored end or now.
 * The one rule every supersession writer applies (engine insertFact and expireFact, managed remember and extraction,
 * the unmanaged fence remember, proposal accept), at write time only; no stored row is rewritten. engine-sql/facts.ts
 * states it in SQL for insertFact and expireFact.
 */
export function supersededValidUntil(retired: { valid_from: Date | string | null; valid_until?: Date | string | null }, replacementFrom: Date | null, now = new Date()): Date {
  const from = retired.valid_from == null ? null : new Date(retired.valid_from);
  const end = retired.valid_until == null ? now : new Date(retired.valid_until);
  if (replacementFrom && (from === null || replacementFrom.getTime() > from.getTime()) && replacementFrom.getTime() < end.getTime()) return replacementFrom;
  const earlier = end.getTime() < now.getTime() ? end : now;
  return from !== null && earlier.getTime() < from.getTime() ? from : earlier;
}
