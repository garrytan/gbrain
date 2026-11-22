/**
 * When an extracted fact happened: the extractor's own date, then the
 * caller's event time (`validFrom`), then the source turn's time (`turnAt`;
 * #6159: a session-corpus file's write time). If all three are absent, the
 * event time is unknown. `turnAt` is not part of the managed facts batch key.
 */
export function factEventTime(fact: { valid_from?: Date | null }, ctx: { validFrom?: Date; turnAt?: Date }): Date | undefined {
  return fact.valid_from ?? ctx.validFrom ?? ctx.turnAt;
}
