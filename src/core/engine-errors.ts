/**
 * Typed engine errors shared by both engine implementations. Lives outside
 * engine.ts (the interface module) for the same circular-import reason as
 * engine-constants.ts.
 *
 * #4109: the graph mutations (addLink / addTimelineEntry) resolve their page
 * endpoints inside the mutation statement, so a miss must identify WHICH
 * endpoint failed. The operations layer reclassifies these misses into the
 * caller-facing error envelope (permission_denied vs page_not_found) by
 * `instanceof` — never by message-prefix matching, which silently stops
 * firing when a message is reworded. The message is built HERE so both
 * engines stay in lockstep parity by construction.
 */

/** Which page reference a mutation failed to resolve. `page` = single-slug ops. */
export type PageMissEndpoint = 'from' | 'to' | 'page';

export class PageMissingError extends Error {
  constructor(
    public readonly operation: 'addLink' | 'addTimelineEntry',
    public readonly endpoint: PageMissEndpoint,
    public readonly slug: string,
    public readonly sourceId: string,
  ) {
    super(
      operation === 'addTimelineEntry'
        ? `addTimelineEntry failed: page "${slug}" (source=${sourceId}) not found`
        : `addLink failed: ${endpoint} page "${slug}" (source=${sourceId}) not found`,
    );
    this.name = 'PageMissingError';
  }
}

/**
 * `purgeDeletedPages(olderThanHours)` refuses an age that is not a finite number of hours, 0 or more (NaN, a negative
 * number, ±Infinity), before it reads or deletes anything. Every engine refuses the same inputs with this error, code
 * `invalid_argument`: an age that is not a number used to turn into 0 hours and hard-delete every soft-deleted page.
 */
export class PurgeAgeError extends Error {
  readonly code = 'invalid_argument';
  constructor(public readonly olderThanHours: number) {
    super(`purgeDeletedPages: the age must be a finite number of hours, 0 or more; got ${olderThanHours}. Nothing was purged.`);
    this.name = 'PurgeAgeError';
  }
}

/** Throws {@link PurgeAgeError} unless `olderThanHours` is a finite number ≥ 0. */
export function assertPurgeAge(olderThanHours: number): void {
  if (typeof olderThanHours !== 'number' || !Number.isFinite(olderThanHours) || olderThanHours < 0) {
    throw new PurgeAgeError(olderThanHours);
  }
}

/**
 * A read whose trust floor (`minTrust`, a policy `floor`) names no trust tier. Every engine refuses it with this error,
 * code `invalid_argument`, before it builds a statement (an empty tier list is not valid SQL: `trust_tier IN ()`).
 * The message is the Rust store's.
 */
export class TrustFloorError extends Error {
  readonly code = 'invalid_argument';
  constructor(public readonly floor: unknown) {
    super(`minTrust: "${String(floor)}" names no trust tier`);
    this.name = 'TrustFloorError';
  }
}
