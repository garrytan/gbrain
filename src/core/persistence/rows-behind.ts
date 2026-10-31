/**
 * #8071: rows a managed sync's checkpoint moved past. `sources.last_commit` says every file of the source is imported as of
 * that commit; a sync that advanced it without importing a changed file (and recorded the file as imported) leaves the
 * row on an older version with no hold, and every later sync reports the source up to date. Landing checks see a live,
 * unheld row and pass.
 *
 * `scanRowsBehind` compares each live Markdown page of a managed source with its file at the checkpoint commit, read
 * from Git (never the working tree, never the import record's word): the export view against the committed blob
 * (git-gap.ts `compareInlineExportFile`; a page stored in segments by streamed hash, `compareSegmentedExportBlob`), and a
 * differing row is confirmed by the importer itself (`prepareRepairPublication`, no writes): a row the import of the
 * checkpoint bytes would leave unchanged is current. Direction comes from the page's import record: a row whose revision
 * is the one its last sync import produced (the database has not moved since) is `behind`; one the database moved since
 * is `database_moved` and not reported (file-drift's territory); one with no record (or a record without a revision) is
 * `unproven`, listed apart. Not reported either: held paths (the hold already says it), paths with no blob at the
 * checkpoint, non-Markdown pages, declared database-only pages, paths sync does not read (`not_eligible`: outside the
 * source's scope, matched by `sync.exclude`, hidden, outside the sync strategy or a reserved skillpack path), and paths
 * that changed between the checkpoint and HEAD (the next sync imports them).
 *
 * Bounded: the checkpoint tree is listed once (and HEAD's only when it differs), pages are read in id batches of
 * ROWS_BEHIND_BATCH in read-only transactions, and a blob over the sync read bound (SYNC_READ_BOUND, the page ceiling) is
 * never read: its row is reported with the `file_too_large` refusal sync would hold it with. #8093: a batch's committed
 * blobs and export pages are read and compared in chunks of at most ROWS_BEHIND_BATCH_BYTES (one blob when a single one
 * is larger), each chunk's buffers dropped once it is compared, and the differing rows keep at most that many bytes for
 * their confirmation (the rest re-read their blob there). The deadline is checked before the per-source tree reads,
 * before each batch and before each row's content comparison and confirmation (`complete: false`; `pages` and
 * `counts` cover the rows decided before `stopped_at`, the page id the scan stopped at); no chunk is read after it
 * passes. The confirmation's screen config and the export withdrawals are read once the first batch starts. `confirmUnproven: false` (doctor) counts rows with no import record
 * from the content comparison alone, without running the importer's confirmation.
 * Applies only on the owner host of a managed source with a checkout and a checkpoint; everything else, a repo-less
 * brain included, is `not_applicable` with its reason. Read-only. Readers: doctor `sync_rows_behind_checkpoint` and
 * `gbrain repair rows-behind`.
 */
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { readExportPages, readExportWithdrawals, type ExportWithdrawal } from '../export-snapshot.ts';
import { canonicalPath, sourceContext } from '../ghost-pages.ts';
import { privatePagesFilterFragment, readHonorAliases } from '../search/private-visibility.ts';
import { scannerSourcePath } from '../write-through.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import { compareInlineExportFile, compareSegmentedExportBlob, declaredDatabaseOnly, readBlobs, readHeadTree, type ExportFileComparison, type TreeBlob } from './git-gap.ts';
import { prepareRepairPublication, repairScreenConfig } from './file-repair.ts';
import { SYNC_READ_BOUND } from './sync-blobs.ts';
import { heldGitPaths, readSyncImportProvenances } from './sync-holds.ts';
import { loadSyncEligibility } from './sync-discovery.ts';
import { METAFILE_HEAD_BYTES } from '../sync.ts';
import { isSourceDbOnlySlug } from './source-storage.ts';

export const ROWS_BEHIND_BATCH = 256;
/** #8093: the committed-blob bytes one chunk of a batch reads, and the bytes the batch's differing rows keep for confirmation. */
export const ROWS_BEHIND_BATCH_BYTES = 64 * 1024 * 1024;
/** Rows one scan lists per class; counts go on past it (`truncated`). */
export const ROWS_BEHIND_LIST_LIMIT = 1000;
export const ROWS_BEHIND_DOCS = 'docs/guides/repair.md#rows-behind';

/** Why a row is not reported, counted per scan. */
export type RowsBehindSkip = 'held' | 'database_moved' | 'changed_after_checkpoint' | 'no_file_at_checkpoint' | 'not_markdown' | 'declared_database_only'
  | 'not_regular_file' | 'unsafe_path' | 'not_eligible' | 'unconfirmed' | 'current';

export interface RowBehind {
  slug: string;
  page_id: number;
  /** The page revision the scan read; a repair is bound to it. */
  revision: string;
  /** Source-root-relative file path (the hold key). */
  path: string;
  /** The page's recorded origin. */
  source_path: string;
  /** The file's blob at the checkpoint and its size. */
  blob: string;
  size: number;
  /** `recorded`: the page's import record holds this revision; `none`: no record proves the database did not move. */
  record: 'recorded' | 'none';
  /** The import of the checkpoint file is refused (sync would hold it): the code, reason and message a hold carries. */
  refusal?: { code: string; reason?: string; key?: string; line?: number; message: string };
  /** The import would keep page data the file does not carry, so it cannot be applied as the exact file bytes. */
  overlay?: true;
  /** The digest of the page the import of the checkpoint bytes publishes (`prepareRepairPublication`). */
  digest?: string;
}

export interface RowsBehindScan {
  source_id: string;
  status: 'known' | 'unknown' | 'not_applicable';
  reason?: string;
  checkpoint: string | null;
  head: string | null;
  /** False when the deadline stopped the scan; the counts cover the pages decided before `stopped_at`. */
  complete: boolean;
  /** The page id the deadline stopped the scan at (not compared), or null. */
  stopped_at: number | null;
  /** Live file-backed pages decided. */
  pages: number;
  behind: RowBehind[];
  unproven: RowBehind[];
  /** More rows than ROWS_BEHIND_LIST_LIMIT in a class; `behind_count` / `unproven_count` keep counting. */
  truncated: boolean;
  behind_count: number;
  unproven_count: number;
  counts: Partial<Record<RowsBehindSkip, number>>;
}

type Key = { id: string; slug: string; source_id: string; source_path: string; source_uri: string | null; withheld_source_path: string | null; type: string;
  frontmatter: unknown; database_only_reason: string | null; segmented: boolean; lineage_private: boolean; revision: string };

const empty = (sourceId: string, status: RowsBehindScan['status'], reason?: string): RowsBehindScan => ({ source_id: sourceId, status, ...(reason ? { reason } : {}),
  checkpoint: null, head: null, complete: status !== 'unknown', stopped_at: null, pages: 0, behind: [], unproven: [], truncated: false, behind_count: 0, unproven_count: 0, counts: {} });

const isMarkdown = (path: string) => /\.mdx?$/i.test(path);

export async function scanRowsBehind(engine: BrainEngine, sourceId: string,
  opts: { deadlineAt?: number; confirmUnproven?: boolean; now?: () => number; batchBytes?: number } = {}): Promise<RowsBehindScan> {
  if (!(await managedPersistenceEnabled(engine))) return empty(sourceId, 'not_applicable', 'not_managed');
  const context = await sourceContext(engine, sourceId);
  if (!context.ok) return empty(sourceId, context.status, context.reason);
  const [source] = await engine.executeRaw<{ last_commit: string | null; config: Record<string, unknown> | null }>('SELECT last_commit, config FROM sources WHERE id=$1', [sourceId]);
  if (!source?.last_commit) return empty(sourceId, 'not_applicable', 'no_checkpoint');
  const root = context.root;
  try { isSourceDbOnlySlug(root, '', 'refuse'); } catch { return empty(sourceId, 'unknown', 'invalid_source_config'); }
  const now = opts.now ?? Date.now;
  const late = () => opts.deadlineAt !== undefined && now() >= opts.deadlineAt;
  if (late()) return { ...empty(sourceId, 'known'), checkpoint: source.last_commit, complete: false };
  const checkpoint = await readHeadTree(root, source.last_commit);
  if (!checkpoint?.commit) return { ...empty(sourceId, 'unknown', 'checkpoint_unreadable'), checkpoint: source.last_commit };
  const headRead = await readHeadTree(root, 'HEAD');
  const head = headRead?.commit === checkpoint.commit ? checkpoint : headRead;
  if (!head) return { ...empty(sourceId, 'unknown', 'head_unreadable'), checkpoint: checkpoint.commit };
  await readHonorAliases(engine);
  const scope = relative(checkpoint.gitRoot, realpathSync(root)).split(sep).join('/');
  const gitPath = (rel: string) => scope ? `${scope}/${rel}` : rel;
  const { eligible, metafileHeads } = await loadSyncEligibility(engine, { root, gitRoot: checkpoint.gitRoot, sourceId, source: { last_commit: source.last_commit, config: source.config ?? {} } });
  const policy = { mirror: false, databaseOnlySource: false, dbOnly: (slug: string) => isSourceDbOnlySlug(root, slug, 'refuse'), ignored: new Set<string>() };
  const scan: RowsBehindScan = { ...empty(sourceId, 'known'), checkpoint: checkpoint.commit, head: head.commit };
  const count = (why: RowsBehindSkip) => { scan.counts[why] = (scan.counts[why] ?? 0) + 1; };
  const batchBytes = opts.batchBytes ?? ROWS_BEHIND_BATCH_BYTES;
  let screen: Awaited<ReturnType<typeof repairScreenConfig>> | undefined;
  let withdrawals: ExportWithdrawal[] | undefined;
  const incarnation = context.owner.source_incarnation;
  for (let cursor = '0'; ;) {
    if (late()) { scan.complete = false; break; }
    const exportWithdrawals = withdrawals ??= await readExportWithdrawals(engine, sourceId);
    let stop: number | null = null;
    const skipped: Array<[number, RowsBehindSkip]> = [];
    const skip = (id: string, why: RowsBehindSkip) => { skipped.push([Number(id), why]); };
    let ids: number[] = [];
    const candidates: Array<{ key: Key; rel: string; blob: TreeBlob; record: RowBehind['record']; content: Buffer | null; compared: ExportFileComparison | null }> = [];
    const done = await engine.transaction(async tx => {
      await tx.executeRaw('SET TRANSACTION READ ONLY');
      const batch = await tx.executeRaw<Key>(`SELECT id::text, slug, source_id, source_path, source_uri, withheld_source_path, type, frontmatter, database_only_reason,
          body_storage='segmented' AS segmented, knowledge_revision::text AS revision, NOT ${privatePagesFilterFragment('pages')} AS lineage_private
        FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL AND pages.id > $2::bigint ORDER BY pages.id LIMIT ${ROWS_BEHIND_BATCH}`, [sourceId, cursor]);
      if (!batch.length) return true;
      cursor = batch[batch.length - 1]!.id;
      ids = batch.map(key => Number(key.id));
      const listed: Array<{ key: Key; rel: string; blob: TreeBlob }> = [];
      for (const key of batch) {
        const path = canonicalPath(context, key);
        if (!path) { skip(key.id, 'unsafe_path'); continue; }
        const rel = relative(root, path).split(sep).join('/');
        if (rel.startsWith('../') || rel === '..') { skip(key.id, 'unsafe_path'); continue; }
        if (!isMarkdown(rel)) { skip(key.id, 'not_markdown'); continue; }
        const frontmatter = typeof key.frontmatter === 'string' ? JSON.parse(key.frontmatter) : key.frontmatter;
        if (declaredDatabaseOnly({ ...key, frontmatter }, rel, policy)) { skip(key.id, 'declared_database_only'); continue; }
        const blob = checkpoint.blobs.get(gitPath(rel));
        if (!blob) { skip(key.id, 'no_file_at_checkpoint'); continue; }
        if (blob.mode !== '100644' && blob.mode !== '100755') { skip(key.id, 'not_regular_file'); continue; }
        listed.push({ key, rel, blob });
      }
      metafileHeads.prime(listed.filter(row => row.blob.size <= METAFILE_HEAD_BYTES).map(row => ({ path: gitPath(row.rel), oid: row.blob.oid, size: row.blob.size })));
      const rows = listed.filter(row => {
        if (eligible(gitPath(row.rel))) return true;
        skip(row.key.id, 'not_eligible');
        return false;
      });
      if (!rows.length) return batch.length < ROWS_BEHIND_BATCH;
      const held = await heldGitPaths(tx, sourceId, incarnation, rows.map(row => row.rel));
      const records = await readSyncImportProvenances(tx, sourceId, incarnation, rows.map(row => Number(row.key.id)));
      const compare: typeof rows = [];
      for (const row of rows) {
        if (held.has(row.rel)) { skip(row.key.id, 'held'); continue; }
        const record = records.get(Number(row.key.id));
        if (record?.revision != null && String(record.revision) !== row.key.revision) { skip(row.key.id, 'database_moved'); continue; }
        if (head !== checkpoint && head.blobs.get(gitPath(row.rel))?.oid !== row.blob.oid) { skip(row.key.id, 'changed_after_checkpoint'); continue; }
        compare.push(row);
      }
      const blobBytes = (row: (typeof compare)[number]) => row.blob.size > SYNC_READ_BOUND || row.key.segmented ? 0 : row.blob.size;
      let kept = 0;
      for (let start = 0; start < compare.length && stop === null;) {
        let end = start, total = 0;
        while (end < compare.length && (end === start || total + blobBytes(compare[end]!) <= batchBytes)) total += blobBytes(compare[end++]!);
        const chunk = compare.slice(start, end);
        start = end;
        const readable = chunk.filter(row => row.blob.size <= SYNC_READ_BOUND);
        const bytes = await readBlobs(root, readable.filter(row => !row.key.segmented).map(row => row.blob));
        if (!bytes) throw new Error(`Git could not read committed files of source ${sourceId} at ${checkpoint.commit}`);
        const snapshots = await readExportPages(tx, readable.map(row => row.key), exportWithdrawals);
        const byId = new Map(snapshots.map(snapshot => [String(snapshot.page.id), snapshot]));
        for (const row of chunk) {
          if (late()) { stop = Number(row.key.id); break; }
          const recordState: RowBehind['record'] = records.get(Number(row.key.id))?.revision != null ? 'recorded' : 'none';
          if (row.blob.size > SYNC_READ_BOUND) { candidates.push({ ...row, record: recordState, content: null, compared: null }); continue; }
          const snapshot = byId.get(row.key.id);
          if (!snapshot) continue;
          const compared = row.key.segmented ? await compareSegmentedExportBlob(tx, snapshot, exportWithdrawals, row.blob, checkpoint.format)
            : compareInlineExportFile(bytes.get(row.blob.oid)!, scannerSourcePath(root, `${root}/${row.rel}`, context.mode), snapshot);
          if (compared.state === 'equal') { skip(row.key.id, 'current'); continue; }
          const content = bytes.get(row.blob.oid) ?? null;
          const keep = content !== null && kept + content.length <= batchBytes;
          if (keep) kept += content.length;
          candidates.push({ ...row, record: recordState, content: keep ? content : null, compared });
        }
      }
      return batch.length < ROWS_BEHIND_BATCH;
    });
    for (const candidate of candidates) {
      if (stop !== null && Number(candidate.key.id) >= stop) break;
      if (late()) { stop = Number(candidate.key.id); break; }
      const row = candidate.record === 'none' && opts.confirmUnproven === false ? unconfirmedRow(candidate)
        : await confirm(engine, sourceId, root, screen ??= await repairScreenConfig(engine, sourceId), candidate);
      if (typeof row === 'string') { count(row); continue; }
      const list = row.record === 'recorded' ? scan.behind : scan.unproven;
      if (row.record === 'recorded') scan.behind_count++; else scan.unproven_count++;
      if (list.length < ROWS_BEHIND_LIST_LIMIT) list.push(row); else scan.truncated = true;
    }
    for (const [id, why] of skipped) if (stop === null || id < stop) count(why);
    scan.pages += stop === null ? ids.length : ids.filter(id => id < stop!).length;
    if (stop !== null) { scan.complete = false; scan.stopped_at = stop; break; }
    if (done) break;
  }
  return scan;
}

/** The hold fields of an import refusal (`prepareRepairPublication`'s `refused` status). */
export function rowRefusal(refusal: { code: string; message: string }): NonNullable<RowBehind['refusal']> {
  const { code, message } = refusal;
  const reason = 'reason' in refusal ? refusal.reason : undefined;
  const where = refusal as { key?: string; line?: number };
  return { code, message, ...(reason ? { reason: String(reason) } : {}), ...(where.key ? { key: where.key } : {}), ...(where.line !== undefined ? { line: where.line } : {}) };
}

/** A row with no import record, counted from the content comparison alone (doctor: no importer confirmation). */
function unconfirmedRow(candidate: { key: Key; rel: string; blob: TreeBlob; record: RowBehind['record'] }): RowBehind {
  const { key, rel, blob, record } = candidate;
  return { slug: key.slug, page_id: Number(key.id), revision: key.revision, path: rel, source_path: key.source_path, blob: blob.oid, size: blob.size, record,
    ...(blob.size > SYNC_READ_BOUND ? { refusal: tooLarge(blob.size) } : {}) };
}

const tooLarge = (size: number) => ({ code: 'file_too_large', message: `File too large (${size} bytes; the sync read bound is the ${SYNC_READ_BOUND}-byte page ceiling), so it was not read.` });

/**
 * A differing row confirmed by the importer: what the import of the checkpoint bytes would do to it. `current` when the
 * import is a no-op (the row holds that version after all); `unconfirmed` when the confirmation cannot run or the page
 * moved while it was read (never repaired; the next scan reads it again).
 */
async function confirm(engine: BrainEngine, sourceId: string, root: string, screen: Awaited<ReturnType<typeof repairScreenConfig>>,
  candidate: { key: Key; rel: string; blob: TreeBlob; record: RowBehind['record']; content: Buffer | null }): Promise<RowBehind | 'current' | 'unconfirmed'> {
  const { key, rel, blob, record } = candidate;
  const base: RowBehind = { slug: key.slug, page_id: Number(key.id), revision: key.revision, path: rel, source_path: key.source_path, blob: blob.oid, size: blob.size, record };
  if (candidate.content === null && blob.size > SYNC_READ_BOUND) {
    return { ...base, refusal: tooLarge(blob.size) };
  }
  const bytes = candidate.content ?? (await readBlobs(root, [{ oid: blob.oid, size: blob.size, mode: blob.mode }]))?.get(blob.oid) ?? null;
  const content = bytes?.toString('utf8') ?? null;
  if (content === null || !Buffer.from(content).equals(bytes!)) return 'unconfirmed';
  try {
    const snapshot = await engine.readPageSnapshot(key.slug, { sourceId, includeDeleted: true });
    if (!snapshot || String(snapshot.page.id) !== key.id || snapshot.revision !== key.revision) return 'unconfirmed';
    const publication = await prepareRepairPublication(engine, { sourceId, slug: key.slug, sourcePath: key.source_path, path: rel, root, content, snapshot, base: snapshot, ...screen });
    if (publication.status === 'refused') return { ...base, refusal: rowRefusal(publication.refusal) };
    if (publication.status === 'overlay') return publication.noop ? 'current' : { ...base, overlay: true };
    return publication.ready.noop ? 'current' : { ...base, digest: publication.digest };
  } catch {
    return 'unconfirmed';
  }
}
