/**
 * GBRA-75 wave 10: the managed import's per-page reads, batched.
 *
 * `readImportSnapshots` reads the snapshots of a run of pages exactly as
 * `readPageSnapshot(slug, { sourceId, includeDeleted: true })` returns each one
 * (soft-deleted rows included), in as few `readPageSnapshotsBatch` statements as
 * its byte cap allows; a page a statement does not find is absent (null), as
 * the single read at that moment answers. The admission screen reads its batch with it.
 *
 * `importGroupReads` serves a claimed import group's preparation, whose members
 * prepare concurrently and publish together (group-publish.ts
 * `preparationReads`): each member's own snapshot read comes from one batch read
 * for the group, once, and the members' `findDuplicatePage` calls that arrive
 * together are answered by one `findDuplicatePages` statement, entry for entry
 * what each single call returns. As with every preparation read, publication
 * re-checks what it relies on under its locks. A failed batch read falls back to
 * each member's own read, so a member sees the outcome its single read would give.
 */
import type { BrainEngine, PageSnapshot } from '../engine.ts';
import { pageSnapshotKey } from '../page-snapshot-batch.ts';

type DuplicateInput = { hash: string; frontmatterId?: string | null; excludeSlug?: string };
type Duplicate = { slug: string; id: number } | null;

/** How long the first queued duplicate lookup waits for the group's other members before it is sent. */
export const DUPLICATE_BATCH_WINDOW_MS = 2;

export async function readImportSnapshots(engine: BrainEngine, refs: ReadonlyArray<{ slug: string; sourceId: string }>): Promise<Map<string, PageSnapshot>> {
  const out = new Map<string, PageSnapshot>();
  for (let start = 0; start < refs.length;) {
    const { snapshots, covered } = await engine.readPageSnapshotsBatch(refs.slice(start), { includeDeleted: true, absentIsNull: true });
    for (const [key, snapshot] of snapshots) out.set(key, snapshot);
    start += Math.max(1, covered);
  }
  return out;
}

export interface ImportGroupReads {
  /** A member's first `{ sourceId, includeDeleted: true }` read of its own page, from the group's batch; undefined for any other read. */
  snapshot(slug: string, opts: unknown): Promise<PageSnapshot | null> | undefined;
  findDuplicate(sourceId: string, opts: DuplicateInput): Promise<Duplicate>;
}

export function importGroupReads(engine: BrainEngine, rows: ReadonlyArray<{ slug: string; source_id: string }>): ImportGroupReads {
  const refs = rows.map(row => ({ slug: row.slug, sourceId: row.source_id }));
  const unread = new Set(refs.map(ref => pageSnapshotKey(ref.sourceId, ref.slug)));
  let batch: Promise<Map<string, PageSnapshot>> | undefined;
  let queue: Array<{ sourceId: string; input: DuplicateInput; resolve: (value: Duplicate) => void; reject: (error: unknown) => void }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = rows.length;
  const single = (sourceId: string, input: DuplicateInput) => engine.findDuplicatePage ? engine.findDuplicatePage(sourceId, input) : Promise.resolve(null);
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const sent = queue;
    queue = [];
    for (const sourceId of new Set(sent.map(entry => entry.sourceId))) {
      const entries = sent.filter(entry => entry.sourceId === sourceId);
      const answered = entries.length > 1 && engine.findDuplicatePages ? engine.findDuplicatePages(sourceId, entries.map(entry => entry.input)) : Promise.reject(new Error('single'));
      answered.then(found => entries.forEach((entry, i) => entry.resolve(found[i] ?? null)),
        () => { for (const entry of entries) single(entry.sourceId, entry.input).then(entry.resolve, entry.reject); });
    }
  };
  return {
    snapshot(slug, opts) {
      const read = opts as { sourceId?: unknown; includeDeleted?: unknown } | undefined;
      if (!read || Object.keys(read).length !== 2 || read.includeDeleted !== true || typeof read.sourceId !== 'string') return undefined;
      const key = pageSnapshotKey(read.sourceId, slug);
      if (!unread.delete(key)) return undefined;
      batch ??= readImportSnapshots(engine, refs);
      return batch.then(snapshots => snapshots.get(key) ?? null, () => engine.readPageSnapshot(slug, { sourceId: read.sourceId as string, includeDeleted: true }));
    },
    findDuplicate(sourceId, input) {
      return new Promise<Duplicate>((resolve, reject) => {
        queue.push({ sourceId, input, resolve, reject });
        waiting = Math.max(0, waiting - 1);
        if (waiting === 0) flush();
        else timer ??= setTimeout(flush, DUPLICATE_BATCH_WINDOW_MS);
      });
    },
  };
}
