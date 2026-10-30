/**
 * #7214: when a fact replaces another, the retired fact's validity interval ends where the replacement's begins.
 * That holds only when the replacement starts after the retired fact and before any end the retired fact already
 * has; a backdated replacement leaves the interval as it was (null means: keep the stored valid_until).
 */
export function supersededValidUntil(retired: { valid_from: Date | string; valid_until?: Date | string | null }, replacementFrom: Date): Date | null {
  const next = replacementFrom.getTime();
  const until = retired.valid_until == null ? null : new Date(retired.valid_until).getTime();
  return next > new Date(retired.valid_from).getTime() && (until === null || until > next) ? replacementFrom : null;
}
