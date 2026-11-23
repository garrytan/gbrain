/**
 * The BrainEngine reads shadow mode mirrors (plan PR S1, the read half of S2).
 *
 * An explicit allowlist: a member is mirrored only when it is listed here, so a new engine member is never mirrored
 * by accident. `exact` reads must match exactly, order included. `ranked` reads (searches) report `order_diff` when
 * both engines return the same rows in another order. Writes are not mirrored in this phase.
 */
import type { BrainEngine } from '../core/engine.ts';

export type ShadowReadKind = 'exact' | 'ranked';

export const SHADOW_READ_MEMBERS = {
  getPage: 'exact',
  listPages: 'exact',
  findPages: 'exact',
  resolveSlugs: 'exact',
  resolveSlugWithAlias: 'exact',
  getChunks: 'exact',
  getLinks: 'exact',
  getBacklinks: 'exact',
  getTags: 'exact',
  getTimeline: 'exact',
  listFactsByEntity: 'exact',
  getStats: 'exact',
  searchKeyword: 'ranked',
  searchKeywordChunks: 'ranked',
  countKeywordPages: 'exact',
  searchTitles: 'ranked',
  searchVector: 'ranked',
  findByTitleFuzzy: 'ranked',
  searchTakes: 'ranked',
  searchTakesVector: 'ranked',
} as const satisfies Partial<Record<keyof BrainEngine, ShadowReadKind>>;

export type ShadowReadMember = keyof typeof SHADOW_READ_MEMBERS;

export function isShadowReadMember(prop: PropertyKey): prop is ShadowReadMember {
  return typeof prop === 'string' && Object.prototype.hasOwnProperty.call(SHADOW_READ_MEMBERS, prop);
}

/** Members that hand the caller a transaction-bound engine; the wrapper wraps that engine too. */
export const SHADOW_TRANSACTION_MEMBERS = ['transaction', 'transactionDirect'] as const satisfies readonly (keyof BrainEngine)[];
