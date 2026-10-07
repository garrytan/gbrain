/**
 * When an extracted fact happened: the extractor's own date, then the
 * caller's event time (`validFrom`), then the source turn's time (`turnAt`;
 * #6159: a session-corpus file's write time). Undefined lets the writer fall
 * back to now. `turnAt` is not part of the managed facts batch key, so using
 * it never re-keys a batch already tried.
 */
export function factEventTime(fact: { valid_from?: Date | null }, ctx: { validFrom?: Date; turnAt?: Date }): Date | undefined {
  return fact.valid_from ?? ctx.validFrom ?? ctx.turnAt;
}
