/**
 * A BrainEngine whose entity lookup reads throw: a Proxy over a real engine that fails exactly one of the reads
 * `selectEntityCandidates` makes (the alias arm, the arm-2 exact title / slug read, the alias hydrate read, the variant
 * arm's reads) and answers every other call from the real engine. The arm-2 and hydrate reads and the retirement hop
 * are typed members (`readEntityCardRows`, `readRetirementHop`), failed by member name so every engine, the Rust one
 * included, takes the fault; the variant arm's candidate and redirect reads are still raw SQL, told apart by their
 * text, so a change to the lookup that moves a read must move the matcher here.
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
  /** The name-variant arm's candidate read over `pages` (`probe_hits`). */
  variants?: () => Error;
  /** The variant arm's follow-the-retirement read (`followRetirement`, one `SELECT ... AS retired` per candidate). */
  retirement?: () => Error;
  /** The variant arm's fetch of a redirect target its candidate read did not return. */
  redirect?: () => Error;
}

const VARIANTS = /probe_hits/;
const REDIRECT = /AND slug = \$2/;

export function entityLookupFault(engine: BrainEngine, fault: EntityLookupFault): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') {
        return async (sql: string, params?: unknown[]) => {
          if (fault.variants && VARIANTS.test(sql)) throw fault.variants();
          if (fault.redirect && REDIRECT.test(sql)) throw fault.redirect();
          return target.executeRaw(sql, params);
        };
      }
      if (prop === 'readEntityCardRows' && (fault.arm2 || fault.hydrate)) {
        return async (sourceId: string, match: { titleLc?: string; slugs: readonly string[] }, opts?: { excludePrivate?: boolean }) => {
          // The exact title / slug / slug-suffix read carries `titleLc`; the alias hydrate read is by slugs alone.
          const fail = match.titleLc !== undefined ? fault.arm2 : fault.hydrate;
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
