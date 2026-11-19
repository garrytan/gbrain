/**
 * The `code_traversal_cache` members (BrainEngine getCodeTraversalCache, putCodeTraversalCache,
 * clearCodeTraversalCache). The store keeps the rows (rust/docs/store/code-traversal-cache.md). This shell decides
 * what Postgres decides before its statement runs, so the cache module sees the same outcomes on every engine:
 *
 *  - A bind Postgres rejects throws a plain Error, which the cache module swallows (a read is a miss, a write is
 *    logged and skipped): a depth that is not an int4, a generation or `xmin_max` that is not an int8, a NUL byte in
 *    a text key, no response (`JSON.stringify` gives undefined), a lone surrogate in the response, a missing key part,
 *    and a `max_chunk_updated_at` with no digit that is not one of the words Postgres reads as a time.
 *  - A whole generation or `xmin_max` beyond 2^53 is the exact int8 the double names, as the driver binds it; the
 *    store takes it whole and the read gives it back as that number.
 *  - A `max_chunk_updated_at` with a digit that is not `Date#toISOString` shaped refuses with
 *    `engine_capability_missing`: Postgres reads many such forms (and rejects others), the store keeps only this one,
 *    and the cache only writes this one.
 *  - A lone surrogate in a text key is replaced the way the driver encodes it (U+FFFD), as the other members do.
 *
 * The response travels as the JSON `JSON.stringify` gives, parsed once here, and the store prints it back in the
 * key order of Postgres `jsonb`.
 */
import type { CodeTraversalCacheClear, CodeTraversalCacheKey, CodeTraversalCacheRow } from '../../engine-sql/code-traversal-cache.ts';
import { ensureWellFormed } from '../../text-safe.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

const INT4_MIN = -(2 ** 31);
const INT4_MAX = 2 ** 31 - 1;
/** `Date#toISOString` for a year 0001-9999: the one form of `max_chunk_updated_at` the store reads. */
const ISO_MILLIS = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/;

/** Digit-free words Postgres may read as a `timestamptz` (they refuse); any other digit-free text is a bind error. */
const PG_TIME_WORDS: ReadonlySet<string> = new Set(['epoch', 'infinity', '-infinity', '+infinity', 'now', 'today', 'tomorrow', 'yesterday', 'allballs']);

/** What Postgres says to a bind it rejects; the cache module only logs the message. */
function rejected(what: string): never {
  throw new Error(what);
}

function textKey(member: string, column: string, value: unknown): string {
  if (value === null || value === undefined) rejected(`null value in column "${column}" of relation "code_traversal_cache" violates not-null constraint`);
  if (typeof value !== 'string') refuseMember(member, `${column} is not a string`);
  if (value.includes('\0')) rejected('invalid byte sequence for encoding "UTF8": 0x00');
  return ensureWellFormed(value);
}

/** A number bound to an integer column, as the driver sends it: whole and in range. */
function wholeNumber(member: string, column: string, type: 'integer' | 'bigint', value: unknown): number {
  if (value === null || value === undefined) rejected(`null value in column "${column}" of relation "code_traversal_cache" violates not-null constraint`);
  if (typeof value !== 'number') refuseMember(member, `${column} is not a number`);
  if (!Number.isInteger(value)) rejected(`invalid input syntax for type ${type}: "${String(value)}"`);
  if (type === 'integer' && (value < INT4_MIN || value > INT4_MAX)) rejected(`value "${String(value)}" is out of range for type integer`);
  // A whole double is exact; past 2^53 it still names one int8, which the store takes whole (up to 2^63).
  if (value < -(2 ** 63) || value >= 2 ** 63) rejected(`value "${String(value)}" is out of range for type bigint`);
  return value === 0 ? 0 : value; // -0 binds as 0
}

function keyOf(member: string, key: CodeTraversalCacheKey) {
  return {
    symbol_qualified: textKey(member, 'symbol_qualified', key.symbol_qualified),
    depth: wholeNumber(member, 'depth', 'integer', key.depth),
    source_id: textKey(member, 'source_id', key.source_id),
    cluster_generation: wholeNumber(member, 'cluster_generation', 'bigint', key.cluster_generation),
  };
}

/** True when `value` holds a string or key with a lone surrogate (which `jsonb` refuses as invalid JSON text). */
function hasLoneSurrogate(value: unknown): boolean {
  if (typeof value === 'string') return !value.isWellFormed();
  if (Array.isArray(value)) return value.some(hasLoneSurrogate);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => !k.isWellFormed() || hasLoneSurrogate(v));
  }
  return false;
}

export const getCodeTraversalCache: StoreMember<[key: CodeTraversalCacheKey], CodeTraversalCacheRow | null> = async (brain, key) => {
  const sent = keyOf('getCodeTraversalCache', key);
  const row = (await storeCall({ member: 'getCodeTraversalCache' }, () => brain.getCodeTraversalCache(sent))) as CodeTraversalCacheRow | null;
  if (row === null) return null;
  // The SQL arms return the driver's Date for timestamptz and a number for the int8 (napi gives a BigInt past 2^53).
  return withDates({ ...row, cluster_generation: Number(row.cluster_generation) }, ['computed_at']);
};

export const putCodeTraversalCache: StoreMember<
  [key: CodeTraversalCacheKey, response: unknown, maxChunkUpdatedAt: string, xminMax: number],
  void
> = async (brain, key, response, maxChunkUpdatedAt, xminMax) => {
  const member = 'putCodeTraversalCache';
  const sent = keyOf(member, key);
  // The SQL binds JSON.stringify(response)::text::jsonb; undefined (no JSON form) binds NULL, a NOT NULL column.
  const text = JSON.stringify(response);
  if (text === undefined) rejected('null value in column "response_json" of relation "code_traversal_cache" violates not-null constraint');
  const parsed: unknown = JSON.parse(text);
  if (hasLoneSurrogate(parsed)) rejected('invalid input syntax for type json');
  if (typeof maxChunkUpdatedAt !== 'string') refuseMember(member, 'max_chunk_updated_at is not a string');
  if (!/\d/.test(maxChunkUpdatedAt) && !PG_TIME_WORDS.has(maxChunkUpdatedAt.trim().toLowerCase())) {
    rejected(`invalid input syntax for type timestamp with time zone: "${maxChunkUpdatedAt}"`);
  }
  if (!ISO_MILLIS.test(maxChunkUpdatedAt) || Number.isNaN(new Date(maxChunkUpdatedAt).getTime())
    || new Date(maxChunkUpdatedAt).toISOString().slice(0, 10) !== maxChunkUpdatedAt.slice(0, 10)) {
    refuseMember(member, 'max_chunk_updated_at is not an ISO timestamp');
  }
  const xmin = wholeNumber(member, 'xmin_max', 'bigint', xminMax);
  await storeCall({ member }, () => brain.putCodeTraversalCache({
    ...sent, response_json: parsed, max_chunk_updated_at: maxChunkUpdatedAt, xmin_max: xmin,
  }));
};

export const clearCodeTraversalCache: StoreMember<[opts: CodeTraversalCacheClear], number> = async (brain, opts) => {
  const member = 'clearCodeTraversalCache';
  // `allSources` wins, as in the SQL; without it a source id is the scope.
  const sourceId = opts.allSources ? null : textKey(member, 'source_id', opts.sourceId);
  return Number(await storeCall({ member }, () => brain.clearCodeTraversalCache({ sourceId })));
};
