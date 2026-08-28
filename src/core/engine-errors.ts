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
