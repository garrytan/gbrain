/**
 * What every store-backed member shares: reaching the open store, refusing options the store cannot answer exactly,
 * and mapping the store's rejections (store-errors.ts).
 */
import type { Capability } from '../../engine-capabilities.ts';
import { RetryAbortError } from '../../retry.ts';
import { capabilityMissing } from '../errors.ts';
import { RUST_ENGINE_MEMBERS } from '../members.ts';
import { mapStoreError, type StoreErrorContext } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { getFtsLanguage } from '../../fts-language.ts';

/** A member implemented on the store: `brain` first, then the arguments of the BrainEngine member it serves. */
export type StoreMember<Args extends unknown[], R> = (brain: StoreBrain, ...args: Args) => Promise<R>;

/** The capability a member belongs to in the Rust member table. */
function memberCapability(member: string): Capability {
  const cls = (RUST_ENGINE_MEMBERS as Record<string, string>)[member];
  return cls as Capability;
}

/**
 * The options of `member` the store reads. An option the member declares but the store cannot honour exactly (a
 * privacy filter, a temporal policy, a keyset page) refuses with `engine_capability_missing` instead of being ignored,
 * so a caller never gets rows a different engine would have filtered. Options in `ignored` change nothing on this
 * engine (a cancellation signal, an audit label). Any other key refuses too: a new option must be handled on purpose.
 */
export function takeOptions(member: string, opts: object | undefined, supported: readonly string[], ignored: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (opts === undefined || opts === null) return out;
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined) continue;
    if (supported.includes(key)) out[key] = value;
    else if (ignored.includes(key) || value === false) continue;
    else throw capabilityMissing(memberCapability(member), `${member} (option ${key})`);
  }
  return out;
}

/** Refuses a member whose arguments need something the store does not have. */
/** The text search configurations the store ports (keyword/stem.rs, keyword/stem_german.rs). */
const STORE_FTS_CONFIGS = ['english', 'german'] as const;

/**
 * The configuration `GBRAIN_FTS_LANGUAGE` names, for a member that parses text at query time: `english` or `german`.
 * Any other configuration refuses, because the store has no Snowball port for it.
 */
export function storeFtsConfig(member: string, what = 'the text search configuration'): 'english' | 'german' {
  const config = getFtsLanguage();
  if ((STORE_FTS_CONFIGS as readonly string[]).includes(config)) return config as 'english' | 'german';
  return refuseMember(member, `no Snowball port for ${what} ${config}`);
}

export function refuseMember(member: string, what: string): never {
  throw capabilityMissing(memberCapability(member), `${member} (${what})`);
}

/** Runs one store call and maps a rejection. `ctx` names the page and source for the errors that need them. */
/**
 * Refuses a member when the brain's config makes PGLite read another vector column than `embedding`, the one vector
 * column the store keeps. The embedding members and getStats/getHealth call it. `search_embedding_column =
 * embedding_image` is not refused: PGLite's active column is then `embedding` whatever `embedding_columns` holds
 * (resolveWriteColumnFromConfigRows in search/embedding-column.ts).
 */
export async function requireTextColumn(brain: StoreBrain, member: string): Promise<void> {
  if (await brain.getConfig('search_embedding_column') === 'embedding_image') return;
  for (const key of ['search_embedding_column', 'embedding_columns']) {
    if (await brain.getConfig(key)) refuseMember(member, `config ${key} selects another embedding column`);
  }
}

export async function storeCall<T>(ctx: StoreErrorContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapStoreError(error, ctx);
  }
}

/**
 * A batch write that was cancelled before it started does nothing and throws `RetryAbortError`, as PGLite's retry
 * wrapper does (it checks the signal before every attempt). A call already inside the store is not interrupted:
 * PGLite does not interrupt one either, and the store commits or rolls back as a whole.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RetryAbortError();
}

/**
 * The source ids of a scope that can name a source: a non-empty string. The store reads an empty `sourceId` as "no
 * scope" and widens the read to every source, while PGLite's `source_id = ''` matches nothing, so an adapter that
 * forwards a scope for PGLite's `?? 'default'` reads must drop these first. An id that is dropped names no source, so a
 * scope that had ids and lost them all answers as an empty scope would (nothing), never as an unscoped one.
 */
export function namedSourceIds(ids: readonly unknown[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
}
