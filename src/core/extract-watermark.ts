/**
 * #6954: extraction stamps `links_extracted_at` only for pages whose link and
 * timeline rows all landed. A write the engine gives up on is recorded here
 * with the pages it covered; the stamp skips those pages, so they stay due for
 * `extract --stale` and the cycle's stale drain, and the run then fails with
 * `extract_write_lost` after the other pages were stamped.
 */
import type { TimelineBatchInput } from './engine.ts';

export interface PageRef { slug: string; source_id: string }

export interface ExtractBatchFailure {
  kind: 'links' | 'timeline';
  /** Rows the lost write carried. */
  rows: number;
  /** Each page the lost write covered, once. */
  refs: PageRef[];
  error: unknown;
}

const refKey = (ref: PageRef): string => JSON.stringify([ref.source_id, ref.slug]);

function distinctRefs(refs: Iterable<PageRef>): PageRef[] {
  const byKey = new Map<string, PageRef>();
  for (const ref of refs) {
    const key = refKey(ref);
    if (!byKey.has(key)) byKey.set(key, { slug: ref.slug, source_id: ref.source_id });
  }
  return [...byKey.values()];
}

function lostWriteMessage(failures: ExtractBatchFailure[]): string {
  const refs = distinctRefs(failures.flatMap(f => f.refs));
  const rows = failures.reduce((total, f) => total + f.rows, 0);
  const kinds = [...new Set(failures.map(f => f.kind))].join('/');
  const sources = [...new Set(refs.map(r => r.source_id))];
  const cause = failures[0]?.error;
  const retry = sources.length === 1 ? `gbrain extract --stale --source-id ${sources[0]}` : 'gbrain extract --stale';
  return `extract: ${failures.length} ${kinds} write(s) failed (${rows} row(s)) across ${refs.length} page(s); `
    + `those pages were left unstamped and remain due (first error: ${cause instanceof Error ? cause.message : String(cause)}). `
    + `Retry them with: ${retry}`;
}

/** The run lost one or more writes; thrown after every other page was stamped. */
export class ExtractBatchWriteError extends Error {
  readonly code = 'extract_write_lost';
  readonly failures: ExtractBatchFailure[];
  constructor(failures: ExtractBatchFailure[]) {
    super(lostWriteMessage(failures));
    this.name = 'ExtractBatchWriteError';
    this.failures = failures;
  }
}

export function batchFailure(kind: ExtractBatchFailure['kind'], rows: number, refs: Iterable<PageRef>, error: unknown): ExtractBatchFailure {
  return { kind, rows, refs: distinctRefs(refs), error };
}

export function timelineSnapshotRefs(rows: TimelineBatchInput[]): PageRef[] {
  return rows.map(row => ({ slug: row.slug, source_id: row.source_id ?? 'default' }));
}

/** The refs no lost write covered, in their original order. */
export function withoutFailedRefs<T extends PageRef>(refs: T[], failures: ExtractBatchFailure[]): T[] {
  if (failures.length === 0) return refs;
  const lost = new Set(failures.flatMap(f => f.refs.map(refKey)));
  return refs.filter(ref => !lost.has(refKey(ref)));
}

/** Runs one write; a failure becomes an `ExtractBatchWriteError` naming its pages (an existing one passes through). */
export async function extractionWrite<T>(kind: ExtractBatchFailure['kind'], rows: number, refs: PageRef[], write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw error instanceof ExtractBatchWriteError ? error : new ExtractBatchWriteError([batchFailure(kind, rows, refs, error)]);
  }
}

/** The lost writes of one extraction run. */
export class LostWrites {
  readonly failures: ExtractBatchFailure[] = [];
  record(kind: ExtractBatchFailure['kind'], rows: number, refs: Iterable<PageRef>, error: unknown): void {
    this.failures.push(batchFailure(kind, rows, refs, error));
  }
  /** Keeps the failures of an `ExtractBatchWriteError`; false for any other error. */
  absorb(error: unknown): boolean {
    if (!(error instanceof ExtractBatchWriteError)) return false;
    this.failures.push(...error.failures);
    return true;
  }
  stampable<T extends PageRef>(refs: T[]): T[] {
    return withoutFailedRefs(refs, this.failures);
  }
  throwIfAny(): void {
    if (this.failures.length > 0) throw new ExtractBatchWriteError(this.failures);
  }
}
