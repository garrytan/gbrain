import type { TimelineBatchInput } from './engine.ts';
export type PageRef = { slug: string; source_id: string };
export function pageRefKey(r: PageRef): string { return `${r.source_id}\0${r.slug}`; }
export interface ExtractBatchFailure {
  /** Which write was lost: a link batch, a timeline batch, or the `--stale` sweep's own stamp. */
  kind: 'links' | 'timeline' | 'stamp';
  /** Rows in the lost write. */
  rows: number;
  /** Deduplicated pages the lost write represented (row endpoints plus emitting pages). */
  refs: PageRef[];
  error: unknown;
}

/**
 * One or more link/timeline/stamp writes failed after the engine's own
 * retries. Thrown AFTER safe pages were stamped; the affected pages (left
 * unstamped) stay due, and the cycle extract phase maps it to `warn` and lets
 * its stale drain retry them.
 */
export class ExtractBatchWriteError extends Error {
  readonly code = 'EXTRACT_BATCH_WRITE_FAILED';
  readonly failures: ExtractBatchFailure[];
  constructor(failures: ExtractBatchFailure[]) {
    const rows = failures.reduce((n, f) => n + f.rows, 0);
    const pages = new Set(failures.flatMap(f => f.refs.map(pageRefKey))).size;
    const kinds = [...new Set(failures.map(f => f.kind))].join('/');
    const first = failures[0]?.error;
    const firstMsg = first instanceof Error ? first.message : String(first);
    super(
      `extract: ${failures.length} ${kinds} write(s) failed (${rows} row(s)) across ${pages} page(s); ` +
      `those pages were not stamped and remain due (first error: ${firstMsg})`,
    );
    this.name = 'ExtractBatchWriteError';
    this.failures = failures;
  }
}

export function batchFailure(
  kind: ExtractBatchFailure['kind'],
  rows: number,
  refs: Iterable<PageRef>,
  error: unknown,
): ExtractBatchFailure {
  const byKey = new Map<string, PageRef>();
  for (const r of refs) byKey.set(pageRefKey(r), { slug: r.slug, source_id: r.source_id });
  return { kind, rows, refs: [...byKey.values()], error };
}

export function timelineSnapshotRefs(rows: TimelineBatchInput[]): PageRef[] {
  return rows.map(r => ({ slug: r.slug, source_id: r.source_id ?? 'default' }));
}

/** Drop every ref that appears in any failed write. */
export function withoutFailedRefs<T extends PageRef>(refs: T[], failures: ExtractBatchFailure[]): T[] {
  if (failures.length === 0) return refs;
  const failed = new Set(failures.flatMap(f => f.refs.map(pageRefKey)));
  return refs.filter(r => !failed.has(pageRefKey(r)));
}

/** Annotate a failing native write without changing its transaction/retry policy. */
export async function extractionWrite<T>(kind: ExtractBatchFailure['kind'], rows: number, refs: PageRef[], write: () => Promise<T>): Promise<T> {
  try { return await write(); }
  catch (error) {
    if ((error as { code?: unknown })?.code === 'EXTRACT_BATCH_WRITE_FAILED') throw error;
    throw new ExtractBatchWriteError([batchFailure(kind, rows, refs, error)]);
  }
}
