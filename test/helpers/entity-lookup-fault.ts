/**
 * A BrainEngine whose entity lookup reads throw: a Proxy over a real engine that fails exactly one of the three reads
 * `selectEntityCandidates` makes (the alias arm, the arm-2 exact title / slug read, the alias hydrate read) and answers
 * every other call from the real engine. The lookup SQL is told apart by its text, so a change to the lookup that moves
 * a read must move the matcher here.
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
}

const ARM2 = /lower\(title\) = \$2/;
const HYDRATE = /AND slug = ANY\(\$2::text\[\]\)/;

export function entityLookupFault(engine: BrainEngine, fault: EntityLookupFault): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') {
        return async (sql: string, params?: unknown[]) => {
          if (fault.arm2 && ARM2.test(sql)) throw fault.arm2();
          if (fault.hydrate && HYDRATE.test(sql)) throw fault.hydrate();
          return target.executeRaw(sql, params);
        };
      }
      if (prop === 'resolveAliases' && fault.aliases) {
        return async () => { throw fault.aliases!(); };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
