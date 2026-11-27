/**
 * A BrainEngine whose entity lookup reads throw: a Proxy over a real engine that fails exactly one of the reads
 * `selectEntityCandidates` makes (the alias arm, the arm-2 exact title / slug read, the alias hydrate read, the variant
 * arm's reads) and answers every other call from the real engine. The arm-2 and hydrate reads and the retirement hop
 * are typed members (`readEntityCardRows`, `readRetirementHop`), and so are the variant arm's candidate reads
 * (`listNameVariantCandidates`, `listVisibleNameVariantCandidates`, `listNameVariantCardCandidates`) and its redirect
 * read (`readVisibleVariantPages`, or `readEntityCardRows` by slugs in the card projection). Each is failed by member name, so every engine, the Rust one included, takes the
 * fault; a change to the lookup that moves a read must move the member named here.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

/** Raw text of the injected failure; tests assert it never reaches a wire answer. */
export const FAULT_MESSAGE = 'permission denied for table injected_entity_lookup';

export interface EntityLookupFault {
  /** The exact title / exact slug / slug-suffix read over `pages`. */
  arm2?: () => Error;
  /** `engine.resolveAliases`. */
  aliases?: () => Error;
  /** The read that hydrates alias-resolved slugs arm 2 did not fetch. */
  hydrate?: () => Error;
  /** The name-variant arm's candidate read (`probe_hits`), in each projection. */
  variants?: () => Error;
  /** The variant arm's follow-the-retirement read (`followRetirement`, one `SELECT ... AS retired` per candidate). */
  retirement?: () => Error;
  /** The variant arm's fetch of a redirect target its candidate read did not return (`readVisibleVariantPages`, or `readEntityCardRows` by slugs for a card). */
  redirect?: () => Error;
}

/** The variant arm's candidate reads, one per projection (`entity-variants.ts` `resolveNameVariant`). */
const VARIANT_READS = new Set<PropertyKey>(['listNameVariantCandidates', 'listVisibleNameVariantCandidates', 'listNameVariantCardCandidates']);

export function entityLookupFault(engine: BrainEngine, fault: EntityLookupFault): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (fault.variants && VARIANT_READS.has(prop)) {
        return async () => { throw fault.variants!(); };
      }
      if (prop === 'readVisibleVariantPages' && fault.redirect) {
        return async () => { throw fault.redirect!(); };
      }
      if (prop === 'readEntityCardRows' && (fault.arm2 || fault.hydrate || fault.redirect)) {
        return async (sourceId: string, match: { titleLc?: string; slugs: readonly string[] }, opts?: { excludePrivate?: boolean }) => {
          // The exact title / slug / slug-suffix read carries `titleLc`. A read by slugs alone is the alias hydrate read,
          // or, in the card projection, the variant arm's redirect read.
          const fail = match.titleLc !== undefined ? fault.arm2 : fault.hydrate ?? fault.redirect;
          if (fail) throw fail();
          return target.readEntityCardRows(sourceId, match as never, opts);
        };
      }
      if (prop === 'readRetirementHop' && fault.retirement) {
        return async () => { throw fault.retirement!(); };
      }
      if (prop === 'resolveAliases' && fault.aliases) {
        return async () => { throw fault.aliases!(); };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
