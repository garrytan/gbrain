/**
 * The reads a page purge's receipt and verification make on the brain's own tables (BrainEngine relationExists and
 * readDerivationPurgeState; SQL in engine-sql/purge-receipt.ts; rust/docs/store/pages.md, "The page purge's receipt reads").
 *
 * Answered here, without a store call, because the store keeps keyspaces, not SQL relations:
 * - `relationExists` answers true for a relation the graduation inventory lists (a table or a view; an optional `public.` prefix
 *   and the unquoted capital spelling read as to_regclass reads them) and false for any other name. The inventory names every
 *   relation a brain keeps, the query cache among them, so the purge receipt names no missing cache here, as on a brain whose
 *   cache holds no row (`clearQueryCache` answers 0 for the same reason). A quoted or other-schema name answers false.
 * - `readDerivationPurgeState` answers null: the store records no derivation sweep (no `page_segment_derivation_purges` rows and no
 *   derivation edges for one to walk, as `listDerivedRows` answers an empty list), so a purge has none to report as pending or
 *   stalled.
 */
import type { BrainEngine } from '../../engine.ts';
import { GRADUATION_INVENTORY } from '../../persistence/graduation-inventory.ts';
import type { StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

let relations: ReadonlySet<string> | null = null;

/** The relation name as to_regclass folds it: an optional `public.` prefix dropped, an unquoted name lowercased; null for a name that is quoted or has another qualifier. */
function foldRelationName(table: string): string | null {
  const bare = table.startsWith('public.') ? table.slice('public.'.length) : table;
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(bare) ? bare.toLowerCase() : null;
}

export const relationExists: Member<'relationExists'> = async (_brain, table) => {
  relations ??= new Set(GRADUATION_INVENTORY.entries.map(e => e.relation));
  const name = foldRelationName(table);
  return name !== null && relations.has(name);
};

export const readDerivationPurgeState: Member<'readDerivationPurgeState'> = async () => null;
