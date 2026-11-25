/**
 * Typed members for reads that once ran through executeRaw behind a catch that turned any error, a Rust engine's
 * capability refusal included, into a quiet default (docs/research/rust-refusal-swallow-triage.tsv, lane 15 rows). Each
 * member's SQL is the statement its caller sent; the Rust store serves the same member, so a Rust brain answers instead
 * of refusing. `BrainEngine` extends this interface.
 */
import type * as SchemaDetectSql from '../engine-sql/schema-detect.ts';
import type * as AccessReadLogSql from '../engine-sql/access-read-log.ts';

export interface SurfacedReadMembers {
  /** Live pages of any source whose source path starts with `prefix`, LIKE semantics (schema-pack lint extractable_empty_corpus). */
  countLivePagesAtPathPrefix(prefix: string): Promise<number>;
  /** Untyped live pages under a path prefix, in `sourceId` when given: the count and the first ten slugs by byte (schema-pack sync). */
  probeUntypedPathPrefix(prefix: string, sourceId?: string): ReturnType<typeof SchemaDetectSql.probeUntypedPathPrefix>;
  /** Deletes the cached search results of `sourceId`, or every cached result when omitted; the rows deleted (schema-pack mutate). */
  invalidateQueryCacheRows(sourceId?: string): Promise<number>;
  /** Whether one of `memberIds` carries the labelled-only grant and is not the configured owner (access/labelled-only.ts labelledOnlyFor). */
  hasLabelledOnlyMemberAmong(memberIds: readonly string[]): Promise<boolean>;
  // The access read log (engine-sql/access-read-log.ts): the batched insert and prune of access/read-log.ts, and the
  // reads of `gbrain access log` and `gbrain access who-read`.
  /** Appends a batch of logged reads. */
  insertAccessReadLogRows(rows: readonly AccessReadLogSql.ReadLogRow[]): Promise<void>;
  /** Deletes the rows older than `days`, then the rows beyond the newest `maxRows` by id. */
  pruneAccessReadLog(days: number, maxRows: number): Promise<void>;
  /** The logged reads since `since`, newest first, at most `limit`; with `member`, its reads and the audiences naming it. */
  readAccessReadLog(query: { since: string; member: string | null; limit: number }): Promise<AccessReadLogSql.AccessReadLogEntryRow[]>;
  /** Every stored page with this slug (in `sourceId` when given), soft-deleted ones too, by source id in byte order. */
  listAccessReadPageRefs(slug: string, sourceId: string | null): Promise<Array<{ id: number; source_id: string; slug: string }>>;
  /** The logged reads that returned one of `pageIds` since `since`, newest first, at most `limit`. */
  readAccessReadsOfPages(query: { pageIds: readonly number[]; since: string; limit: number }): Promise<AccessReadLogSql.AccessReadLogEntryRow[]>;
  /** Who read one of `pageIds` since `since`, with the read count and the last read, latest reader first. */
  tallyAccessReadsOfPages(query: { pageIds: readonly number[]; since: string }): Promise<AccessReadLogSql.AccessReadTallyRow[]>;
}
