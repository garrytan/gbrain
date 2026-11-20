/**
 * The byte-ordered page, mention and fact-pool reads (src/core/engine-sql/collate-page-reads.ts), served from the store's
 * page, link, alias and fact records (rust/crates/gbrain-store/src/collate_reads.rs, rust/docs/store/collate_reads.md).
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 *
 * `listPoolEntityPairs` and `listPoolUnbackedKeys` send the pool as `PoolArgs` (pool-args.ts), so the store applies the pool's whole
 * read policy exactly as `listFactsForRelevance` does; a pool whose policy the store cannot read refuses with
 * `engine_capability_missing`.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { poolArgs } from './pool-args.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function text(member: string, name: string, value: string): string {
  if (value.includes('\0')) refuseMember(member, `${name} with a NUL byte`);
  return value;
}

export const listPageTypePairs: Member<'listPageTypePairs'> = async (brain) =>
  storeCall({ member: 'listPageTypePairs' }, () => brain.listPageTypePairs()) as never;

export const countPagesWithMentionLinks: Member<'countPagesWithMentionLinks'> = async (brain) =>
  Number(await storeCall({ member: 'countPagesWithMentionLinks' }, () => brain.countPagesWithMentionLinks()));

export const listGazetteerSourceIds: Member<'listGazetteerSourceIds'> = async (brain) =>
  storeCall({ member: 'listGazetteerSourceIds' }, () => brain.listGazetteerSourceIds()) as never;

export const listGazetteerPages: Member<'listGazetteerPages'> = async (brain, types, handleKeys) => {
  const member = 'listGazetteerPages';
  return storeCall({ member }, () => brain.listGazetteerPages(types.map(t => text(member, 'type', t)), handleKeys.map(k => text(member, 'handle key', k)))) as never;
};

export const listGazetteerAliasRows: Member<'listGazetteerAliasRows'> = async (brain, types) => {
  const member = 'listGazetteerAliasRows';
  return storeCall({ member }, () => brain.listGazetteerAliasRows(types.map(t => text(member, 'type', t)))) as never;
};

export const listStaleMentionPages: Member<'listStaleMentionPages'> = async (brain, limit) =>
  storeCall({ member: 'listStaleMentionPages' }, () => brain.listStaleMentionPages(limit)) as never;

export const listStaleMentionLinks: Member<'listStaleMentionLinks'> = async (brain, limit) =>
  storeCall({ member: 'listStaleMentionLinks' }, () => brain.listStaleMentionLinks(limit)) as never;

export const listPoolEntityPairs: Member<'listPoolEntityPairs'> = async (brain, scope, filters) => {
  const member = 'listPoolEntityPairs';
  const pool = poolArgs(member, scope, filters);
  return storeCall({ member }, () => brain.listPoolEntityPairs(pool)) as never;
};

export const listPoolUnbackedKeys: Member<'listPoolUnbackedKeys'> = async (brain, scope, keys, limit) => {
  const member = 'listPoolUnbackedKeys';
  if (!keys.length) return [];
  const pool = poolArgs(member, scope, undefined);
  return storeCall({ member }, () => brain.listPoolUnbackedKeys(pool, keys.map(k => text(member, 'key', k)), limit)) as never;
};
