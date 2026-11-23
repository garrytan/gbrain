/**
 * Typed members for reads that once ran through executeRaw behind a catch that turned any error, a Rust engine's
 * capability refusal included, into a quiet default (docs/research/rust-refusal-swallow-triage.tsv, lane 15 rows). Each
 * member's SQL is the statement its caller sent; the Rust store serves the same member, so a Rust brain answers instead
 * of refusing. `BrainEngine` extends this interface.
 */
import type * as SchemaDetectSql from '../engine-sql/schema-detect.ts';
import type * as UnscopedReachSql from '../engine-sql/unscoped-read-reach.ts';

export interface SurfacedReadMembers {
  /** Live pages of any source whose source path starts with `prefix`, LIKE semantics (schema-pack lint extractable_empty_corpus). */
  countLivePagesAtPathPrefix(prefix: string): Promise<number>;
  /** Untyped live pages under a path prefix, in `sourceId` when given: the count and the first ten slugs by byte (schema-pack sync). */
  probeUntypedPathPrefix(prefix: string, sourceId?: string): ReturnType<typeof SchemaDetectSql.probeUntypedPathPrefix>;
  /** Deletes the cached search results of `sourceId`, or every cached result when omitted; the rows deleted (schema-pack mutate). */
  invalidateQueryCacheRows(sourceId?: string): Promise<number>;
  /** Whether one of `memberIds` carries the labelled-only grant and is not the configured owner (access/labelled-only.ts labelledOnlyFor). */
  hasLabelledOnlyMemberAmong(memberIds: readonly string[]): Promise<boolean>;
  /** Whether an empty unscoped remote read is refused `sources_not_readable`: nothing it reads in its sources, a page elsewhere (sources-not-readable.ts). */
  readUnscopedReadRefusal(query: UnscopedReachSql.UnscopedReachQuery): Promise<boolean>;
}
