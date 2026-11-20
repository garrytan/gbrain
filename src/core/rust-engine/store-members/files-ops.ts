/**
 * The readable file list `file_list` runs and the file walk `files verify` runs (src/core/engine-sql/collate-page-reads.ts, files-by-path.ts), served from the store's `files`
 * records (rust/crates/gbrain-store/src/raw_files/ops.rs, rust/docs/store/raw_files.md).
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 *
 * The read sends the caller's page policy when `excludePrivate` is true (`storePagePolicy`); PGLite renders
 * `privatePagesFilterForCaller` over the file's page, and the store applies it to the page by id and to every page
 * at the file's slug. A caller whose policy the store cannot read refuses with `engine_capability_missing`.
 */
import type { BrainEngine } from '../../engine.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

type Row = Record<string, unknown>;

function text(member: string, name: string, value: string): string {
  if (value.includes('\0')) refuseMember(member, `${name} with a NUL byte`);
  return value;
}

/** The store policy of a readable read, null when it hides nothing. */
function policy(member: string, excludePrivate: boolean): unknown {
  return storePagePolicy(member, excludePrivate, { callerReaders: true }) ?? null;
}

export const listReadableFileRows: Member<'listReadableFileRows'> = async (brain, slug, excludePrivate) => {
  const member = 'listReadableFileRows';
  const rows = await storeCall({ member }, () => brain.listReadableFiles(slug === undefined ? undefined : text(member, 'slug', slug), policy(member, excludePrivate)));
  return (rows as Row[]).map(row => withDates(row, ['created_at']));
};

/** `files verify`: the store sorts `storage_path` by bytes, as `COLLATE "C"` does; the limit is a whole number the store checks. */
export const listFilesByStoragePath: Member<'listFilesByStoragePath'> = async (brain, limit) => {
  const rows = await storeCall({ member: 'listFilesByStoragePath' }, () => brain.listFilesByPath(limit));
  return (rows as Row[]).map(row => withDates(row, ['created_at']));
};
