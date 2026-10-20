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
import { SAFE_FENCE_SQL } from '../page-state/projections.ts';
import { STORED_TIMELINE_SQL, TAKE_COLLISIONS_SQL } from './canonical-projections.ts';
import { SYNC_ORIGIN_PAGES_SQL } from './sync-origin.ts';
import { registerSliceView } from './slice-memo.ts';

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

/** `reread`: a member's later reads of its page are answered from the batch too (the read-only screen, which publishes nothing). */
export function importGroupReads(engine: BrainEngine, rows: ReadonlyArray<{ slug: string; source_id: string }>, mode: { reread?: boolean } = {}): ImportGroupReads {
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
      if (!(mode.reread ? unread.has(key) : unread.delete(key))) return undefined;
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

const flattened = new Map<string, string>();
/** A statement's whitespace-normalized text, remembered for the (bounded) set of statements a screen sends. */
const flat = (sql: string) => {
  let text = flattened.get(sql);
  if (text === undefined) {
    if (flattened.size >= 1024) flattened.clear();
    text = sql.replace(/\s+/g, ' ').trim();
    flattened.set(sql, text);
  }
  return text;
};
const ORIGIN = flat(SYNC_ORIGIN_PAGES_SQL), TIMELINE = flat(STORED_TIMELINE_SQL), TAKES = flat(TAKE_COLLISIONS_SQL), FENCE = flat(SAFE_FENCE_SQL);

/**
 * GBRA-108: the legacy sweep's screen (sync-convergence.ts) prepares a slice of pages one after another, and each
 * preparation reads its own page's origin claimants, timeline rows, take collisions and safe-chunk fence. Here each kind
 * is read once for the slice (the first call sends it) and every call it covers is answered row for row as its own
 * statement would answer: the origin read is the same statement over the slice's paths, filtered to the call's; a page
 * with no stored takes has no collision; the timeline and fence reads are their statements over the slice's page ids.
 * A call the slice read does not cover (another page or path, a page with takes rows, a caller's signal) runs its own
 * statement, and a failed slice read falls back to each call's own.
 */
export function sliceReads(engine: BrainEngine, slice: { sourceId: string; pageIds: readonly number[]; origins: readonly string[] }): BrainEngine {
  const ids = new Set(slice.pageIds.map(String)), origins = new Set(slice.origins);
  const batches = new Map<string, Promise<Map<string, unknown[]>>>();
  const once = (kind: string, read: () => Promise<Map<string, unknown[]>>) => {
    let batch = batches.get(kind);
    if (!batch) { batch = read(); batches.set(kind, batch); }
    return batch;
  };
  const byKey = <R extends Record<string, unknown>>(rows: R[], key: keyof R, strip = false) => {
    const out = new Map<string, unknown[]>();
    for (const row of rows) {
      const { [key]: k, ...rest } = row;
      const list = out.get(String(k)) ?? [];
      list.push(strip ? rest : row);
      out.set(String(k), list);
    }
    return out;
  };
  const pageIds = [...ids].map(Number);
  const answer = (kind: string, sql: string, params: unknown[]): Promise<unknown[]> | undefined => {
    if (kind === ORIGIN) {
      const wanted = params[1] as unknown;
      if (params[0] !== slice.sourceId || !Array.isArray(wanted) || !wanted.every(path => origins.has(path as string))) return undefined;
      return once(kind, async () => new Map([['*', await engine.executeRaw(SYNC_ORIGIN_PAGES_SQL, [slice.sourceId, [...origins]])]]))
        .then(rows => rows.get('*')!.filter(row => wanted.includes((row as { source_path: string }).source_path)));
    }
    const id = String(params[0]);
    if (!ids.has(id)) return undefined;
    if (kind === TIMELINE) return once(kind, async () => byKey(await engine.executeRaw<Record<string, unknown>>(
      'SELECT page_id,id,date::text AS date,source,summary,detail FROM timeline_entries WHERE page_id=ANY($1::bigint[]) AND event_page_id IS NULL ORDER BY page_id,date,id', [pageIds]), 'page_id', true))
      .then(rows => rows.get(id) ?? []);
    if (kind === FENCE) return once(kind, async () => byKey(await engine.executeRaw<Record<string, unknown>>(
      "SELECT id,chunker_version FROM pages WHERE id=ANY($1::bigint[]) AND deleted_at IS NULL AND body_storage IS DISTINCT FROM 'segmented'", [pageIds]), 'id', true))
      .then(rows => rows.get(id) ?? []);
    return once(kind, async () => byKey(await engine.executeRaw<Record<string, unknown>>('SELECT DISTINCT page_id FROM takes WHERE page_id=ANY($1::bigint[])', [pageIds]), 'page_id'))
      .then(rows => rows.has(id) ? engine.executeRaw(sql, params) : []);
  };
  return registerSliceView(new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) => {
      const kind = flat(sql);
      const answered = !opts?.signal && params && [ORIGIN, TIMELINE, TAKES, FENCE].includes(kind) ? answer(kind, sql, params) : undefined;
      return answered ? answered.catch(() => target.executeRaw(sql, params, opts)) : target.executeRaw(sql, params, opts);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }));
}
