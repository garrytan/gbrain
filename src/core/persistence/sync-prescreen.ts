/**
 * #6712 PR 1 (L1): the content-addressed discovery prescreen and the drift baseline of each frozen import.
 *
 * Import provenance (sync-holds.ts) records, per page, the bytes the last publish left on disk (`disk_blob_oid`), the
 * page revision it wrote (`revision`) and the parser fingerprint (`parser`). Discovery compares them with the pinned
 * tree (one `ls-tree`) and the frozen page revision, for every Git import of an existing page:
 *
 * - **prescreened**: the file is the recorded disk blob, the page is still at the recorded revision and the fingerprint
 *   is this binary's. The entry is only a candidate: the run sends it to the guarded no-op kernel's bounded checks
 *   (`waivePrescreenedRun`), and only those skip it durably; any mismatch there imports it as before. Bypassed under
 *   `--full`.
 * - **no baseline concern**: the page is still at the recorded revision (only the file or the parser changed), so the
 *   import cannot overwrite a database-only edit.
 * - **drift** (`entry.drift`): the page moved since the record and the file did not (`database`), or both moved
 *   (`both`), or there is no usable record (`unknown`: none, one written before PR 0, or a partial one). `database` and
 *   `both` are guarded in every discovery: a Git delta proves the file changed, never that the page did not (#6712: an
 *   incremental sync published a committed edit over a database-only `put_page`). `unknown` is guarded in a tree walk
 *   (first sync, `--full`, an unreachable checkpoint, a re-discovery), where no Git delta says the file is the side that
 *   changed. A `both` entry whose page still holds what the recorded disk blob imports (the database changed only what an
 *   import keeps: tags, links) imports (sync-screen.ts `driftBaselineContent`). A page whose current revision a
 *   committed managed-sync request of this incarnation wrote, or whose writer's write-through wrote to its file
 *   (`pages.revision_write_request_id`, `fileBackedRevisions`), has no database-only edit to protect and is not guarded. A guarded entry is imported only when the freeze proves the import changes
 *   nothing (`sameContentAtOrigin`); otherwise it is held `file_drift` (sync-run.ts `driftHold`).
 * - Under `storage.keep_db` prefixes a drifted page is not held: its entry leaves the manifest (nothing imported) and is
 *   recorded as a drift candidate the keep_db worker reconciles from the database (`liveFileDrift` confirms the file
 *   and the database still differ; an entry where they agree stays, and its import is a no-op).
 */
import { realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { isKeepDbSlug, loadStorageConfig } from '../storage-config.ts';
import { readSyncImportProvenances, syncImportParserFor, type SyncImportParser, type SyncImportProvenance } from './sync-holds.ts';
import { pinnedWindowBlock, readTreeBlobs, seedPinnedWindow, type TreeBlob } from './sync-blobs.ts';
import { syncOriginPath } from './sync-origin.ts';
import { liveFileDrift, recordDriftSkip } from './drift-conflicts.ts';
import type { SyncDiscovery, SyncEntry } from './sync-discovery.ts';

/** Which side moved since the page's last recorded import (`unknown`: no usable record). */
export type SyncDriftSide = 'database' | 'both' | 'unknown';

/** Provenance rows read per statement. */
const PROVENANCE_CHUNK = 5000;

/** Whether a recorded parser fingerprint is this binary's for the page (the prescreen and its kernel run both check it). */
export const sameParser = (a: SyncImportParser | null | undefined, b: SyncImportParser) => !!a && a.parser_version === b.parser_version
  && a.markdown_chunker === b.markdown_chunker && (a.schema_pack ?? null) === b.schema_pack;

/** The drift side of one entry from its record and pinned blob, or null when nothing needs guarding (`prescreened`: a kernel candidate). */
export function classifyBaseline(entry: Pick<SyncEntry, 'revision' | 'sourcePath'>, record: SyncImportProvenance | undefined, blob: TreeBlob | undefined,
  expected: SyncImportParser, input: { full: boolean; treeWalk: boolean }): 'prescreened' | SyncDriftSide | null {
  const complete = !!record?.disk_blob_oid && record.revision != null;
  const fileSame = complete && !!blob && record!.disk_blob_oid === blob.oid;
  const databaseSame = complete && String(record!.revision) === String(entry.revision);
  if (fileSame && databaseSame && !input.full && sameParser(record!.parser, expected) && syncOriginPath(record!.origin) === syncOriginPath(entry.sourcePath)) return 'prescreened';
  if (databaseSame) return null;
  if (fileSame) return 'database';
  if (complete) return 'both';
  return input.treeWalk ? 'unknown' : null;
}

/**
 * Marks the frozen manifest's prescreen candidates (`prescreened`) and guarded imports (`drift`), and moves the drifted
 * entries under `storage.keep_db` prefixes to the keep_db worker. `held` paths (an active hold) are left to their
 * re-screen. Runs after identities are frozen; a company-brain manifest is never prescreened.
 */
export async function prescreenSyncEntries(engine: BrainEngine, discovered: SyncDiscovery,
  input: { full: boolean; treeWalk: boolean; noSchemaPack: boolean; dryRun: boolean; held: ReadonlyMap<string, { code: string }> }): Promise<void> {
  if (discovered.companyPlan) return;
  const candidates = discovered.entries.filter(entry => entry.action === 'import' && !entry.working && entry.pageId != null && entry.revision != null
    && !entry.renameFrom && !entry.renameHeld);
  if (!candidates.length) return;
  const nativeRoot = realpathSync.native(discovered.root), nativeGitRoot = realpathSync.native(discovered.gitRoot);
  const gitPathOf = (entry: SyncEntry) => relative(nativeGitRoot, join(nativeRoot, entry.path)).split(sep).join('/');
  // One listing answers the candidates and seeds the run's first pinned window (the manifest's first block of committed
  // imports), so the prescreen adds no `ls-tree` to the run.
  const block = pinnedWindowBlock(0), first = discovered.entries.slice(block.start, block.end).filter(entry => entry.action === 'import' && !entry.working).map(gitPathOf);
  const blobs = readTreeBlobs(discovered.gitRoot, discovered.target, [...new Set([...first, ...candidates.map(gitPathOf)])]);
  seedPinnedWindow(discovered.gitRoot, discovered.target, first, blobs);
  const records = new Map<number, SyncImportProvenance>();
  for (let i = 0; i < candidates.length; i += PROVENANCE_CHUNK) {
    const read = await readSyncImportProvenances(engine, discovered.sourceId, discovered.incarnation, candidates.slice(i, i + PROVENANCE_CHUNK).map(entry => Number(entry.pageId)));
    for (const [id, record] of read) records.set(id, record);
  }
  const pack = input.noSchemaPack ? null : await loadActivePackForEngine(engine, { remote: false, sourceId: discovered.sourceId }).catch(() => null);
  const guarded: SyncEntry[] = [];
  for (const entry of candidates) {
    const hold = input.held.get(entry.path);
    const side = classifyBaseline(entry, records.get(Number(entry.pageId)), blobs.get(gitPathOf(entry)), syncImportParserFor(entry.sourcePath, pack?.identity ?? null),
      { full: input.full || !!hold, treeWalk: input.treeWalk || hold?.code === 'file_drift' });
    if (side === 'prescreened') entry.prescreened = true;
    else if (side) { entry.drift = side; if (side === 'both') entry.driftBaseline = records.get(Number(entry.pageId))!.disk_blob_oid!; guarded.push(entry); }
  }
  if (!guarded.length) return;
  const backed = await fileBackedRevisions(engine, discovered, guarded.map(entry => Number(entry.pageId)));
  const drifted = guarded.filter(entry => backed.has(Number(entry.pageId)) ? (delete entry.drift, delete entry.driftBaseline, false) : true);
  await releaseKeepDbDrift(engine, discovered, drifted, input.dryRun);
}

/**
 * `file_drift` holds whose page moved since the hold recorded it (another database write, a reconcile, a repair): each
 * is re-screened like a hold whose file changed. One read for the source's drift holds.
 */
export async function movedDriftHolds(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string,
  holds: ReadonlyArray<{ path: string; code: string; page_id: number | null; meta: { page_revision?: string } }>): Promise<Set<string>> {
  const drift = holds.filter(hold => hold.code === 'file_drift' && hold.page_id !== null);
  if (!drift.length) return new Set();
  const rows = await engine.executeRaw<{ id: number | string; revision: string | null }>('SELECT id, knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::bigint[])',
    [sourceId, drift.map(hold => hold.page_id)]);
  const revisions = new Map(rows.map(row => [Number(row.id), row.revision]));
  return new Set(drift.filter(hold => (revisions.get(Number(hold.page_id)) ?? null) !== (hold.meta.page_revision ?? null)).map(hold => hold.path));
}

/**
 * Pages whose current revision has no database-only edit to protect: a committed managed-sync request of this
 * incarnation wrote it (the file was its input), or its writer's publication wrote that revision to the page's own
 * origin file (write-through: a `git` effect with the written bytes' hash, whatever its state). Either way the file held
 * the page at that revision, so a file that differs now changed in Git afterwards.
 */
async function fileBackedRevisions(engine: BrainEngine, discovered: Pick<SyncDiscovery, 'sourceId' | 'incarnation'>, pageIds: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  for (let i = 0; i < pageIds.length; i += PROVENANCE_CHUNK) {
    const rows = await engine.executeRaw<{ id: number | string }>(`SELECT p.id FROM pages p JOIN persistence_requests r ON r.id=p.revision_write_request_id
      WHERE p.source_id=$1 AND p.id=ANY($2::bigint[]) AND r.state='committed' AND r.source_id=p.source_id AND (
        r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND r.source_incarnation::text=$3 AND (r.page_id IS NULL OR r.page_id=p.id)
        OR EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='git' AND e.revision=p.knowledge_revision
          AND e.data->>'expected_hash' IS NOT NULL AND (e.data->>'relative_path'=p.source_path OR right(e.data->>'relative_path', length(p.source_path)+1)='/'||p.source_path)))`, [discovered.sourceId, pageIds.slice(i, i + PROVENANCE_CHUNK), discovered.incarnation]);
    for (const row of rows) out.add(Number(row.id));
  }
  return out;
}

/**
 * `storage.keep_db`: a drifted page under its prefixes is reconciled from the database by the keep_db worker, never
 * imported or held by sync. Its entry leaves the manifest and is recorded as a drift candidate while the file and the
 * database still differ (or the check cannot tell); where they agree the entry stays and imports as a no-op.
 */
async function releaseKeepDbDrift(engine: BrainEngine, discovered: SyncDiscovery, drifted: SyncEntry[], dryRun: boolean): Promise<void> {
  if (!drifted.length) return;
  let keepDb: string[] = [];
  try { keepDb = loadStorageConfig(discovered.root)?.keep_db ?? []; } catch { return; }
  const released = new Set<SyncEntry>();
  for (const entry of drifted.filter(entry => keepDb.length && isKeepDbSlug(entry.slug!, keepDb))) {
    const live = await liveFileDrift(engine, discovered.sourceId, entry.slug!);
    if (live.still_present === false) { delete entry.drift; continue; }
    if (!dryRun) await recordDriftSkip(engine, discovered.sourceId, entry.slug!, { file_hash: live.file_hash ?? null, db_revision: live.db_revision ?? entry.revision ?? null });
    released.add(entry);
  }
  if (released.size) discovered.entries = discovered.entries.filter(entry => !released.has(entry));
}
