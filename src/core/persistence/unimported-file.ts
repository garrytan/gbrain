/**
 * GST-2579: a database-wins repair must not silently discard a file edit sync never imported. A reconcile result that
 * takes the database copy over the file's own value at a path (take_database, delete or set_value on what the file
 * says) overwrites the canonical file; when the file's bytes are not ones gbrain imported or wrote, that overwrite
 * drops an edit nobody saw: another writer's commit that sync has not imported yet, or an uncommitted edit.
 *
 * The bytes count as known only when the database itself held the version they render: the bytes the page's last
 * recorded import read or left on disk (sync's import record: raw_sha256, disk_sha256, written in the publication that
 * stored them), the blob a sync adopted into that record for the revision the page held then (blob_oid, disk_blob_oid,
 * written only while the page was at that revision), or bytes a Git effect of one of the page's own writes put in that file (expected_hash) for a revision the
 * page has held, live or in its version history. gbrain's own writer commit over a database row that never took that
 * revision (the Git commit landed and the row did not) is newer, as is anything else, including a page with no import
 * record and no write of its own: a wrong "newer" keeps a hold, a wrong "known" loses an edit. Git only describes the
 * newer bytes (the commit that holds them, or that they are uncommitted); it never decides that they are known, and
 * neither does who made the commit.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { digest, gitBlobOid } from './digest.ts';
import type { ReconcileDecision } from './reconcile-merge.ts';
import type { AutoDecision } from './reconcile-additive.ts';
import { ABSENT_FILE_HASH, type ReconcileState } from './reconcile-state.ts';
import { readSyncImportProvenance } from './sync-holds.ts';
import { headBlob, lastCommitOf } from './pending-import.ts';

/** A canonical file whose bytes gbrain never imported or wrote, and what Git says about them. */
export interface UnimportedFile {
  path: string;
  /**
   * unimported_commit: HEAD holds the bytes and sync imported other bytes. uncommitted_edit: HEAD holds other bytes.
   * no_import_record: sync recorded no import of the page and gbrain never wrote the file. unknown: Git could not say
   * whether the bytes are committed. unimported_delete: a commit deleted the file and its live page still holds the
   * content (a held file_gone deletion); recreating the file from the page undoes that commit.
   */
  reason: 'unimported_commit' | 'uncommitted_edit' | 'no_import_record' | 'unknown' | 'unimported_delete';
  /** The newest commit that touched the file, when HEAD holds exactly these bytes; for unimported_delete the deleting commit (null when Git could not name it). */
  commit: { sha: string; author: string; date: string } | null;
}

function valueAt(page: unknown, path: string): { has: boolean; value?: unknown } {
  return path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')).reduce<{ has: boolean; value?: unknown }>((at, key) =>
    at.has && at.value !== null && typeof at.value === 'object' && !Array.isArray(at.value) && Object.hasOwn(at.value, key)
      ? { has: true, value: (at.value as Record<string, unknown>)[key] } : { has: false }, { has: true, value: page });
}

/** The decided paths (automatic additive ones excepted) whose result drops what the file says there. */
export function discardedFilePaths(file: unknown, database: unknown, decisions: readonly ReconcileDecision[], auto: readonly AutoDecision[] = []): string[] {
  const automatic = new Set(auto.map(decision => decision.path));
  return decisions.filter(decision => {
    if (automatic.has(decision.path) || decision.action === 'take_file') return false;
    const own = valueAt(file, decision.path);
    if (decision.action === 'delete') return own.has;
    const kept = decision.action === 'take_database' ? valueAt(database, decision.path) : { has: true, value: decision.value };
    return own.has !== kept.has || digest(own.value ?? null) !== digest(kept.value ?? null);
  }).map(decision => decision.path);
}

/**
 * Whether a Git effect of one of the page's own writes put exactly these bytes in its file for a revision the page has
 * held: its live revision, or one its version history keeps.
 */
async function gbrainWroteHeldBytes(engine: BrainEngine, pins: ReconcileState['pins']): Promise<boolean> {
  const rows = await engine.executeRaw<{ found: number }>(`SELECT 1 AS found FROM persistence_requests r
    JOIN persistence_effects e ON e.request_id=r.id AND e.kind='git' AND e.revision IS NOT NULL
    JOIN pages p ON p.id=$4 AND p.source_id=r.source_id
    WHERE r.source_id=$1 AND r.slug=$2 AND e.data->>'expected_hash'=$3
      AND (e.revision=p.knowledge_revision OR EXISTS (SELECT 1 FROM page_versions v WHERE v.page_id=p.id AND v.knowledge_revision=e.revision))
    LIMIT 1`, [pins.source_id, pins.slug, pins.raw_file_hash, Number(pins.page_id)]);
  return rows.length > 0;
}

/** The canonical file of a reconcile state when its bytes are not ones gbrain imported or wrote; null when they are, or when the file is absent. */
export async function unimportedFile(engine: BrainEngine, state: Pick<ReconcileState, 'root' | 'path' | 'raw' | 'pins'>): Promise<UnimportedFile | null> {
  const { pins } = state;
  if (pins.raw_file_hash === ABSENT_FILE_HASH) return null;
  const record = await readSyncImportProvenance(engine, pins.source_id, pins.source_incarnation, Number(pins.page_id));
  if (record && (record.raw_sha256 === pins.raw_file_hash || record.disk_sha256 === pins.raw_file_hash)) return null;
  if (record && [record.blob_oid, record.disk_blob_oid].some(oid => oid && gitBlobOid(state.raw, oid.length === 64 ? 'sha256' : 'sha1') === oid)) return null;
  if (await gbrainWroteHeldBytes(engine, pins)) return null;
  const path = pins.relative_path.split('\\').join('/');
  const head = await headBlob(state.root, state.path);
  const committed = head !== null && gitBlobOid(state.raw, head.length === 64 ? 'sha256' : 'sha1') === head;
  const commit = committed ? await lastCommitOf(state.root, state.path) : null;
  if (!record) return { path, reason: 'no_import_record', commit };
  return { path, reason: committed ? 'unimported_commit' : head === null ? 'unknown' : 'uncommitted_edit', commit };
}

/** What a database-wins write over the file would discard, in words. */
export function unimportedFileText(file: UnimportedFile): string {
  if (file.reason === 'uncommitted_edit') return `an uncommitted edit of ${file.path}`;
  if (file.reason === 'unimported_delete') return file.commit ? `the delete of ${file.path} in commit ${file.commit.sha.slice(0, 12)} by ${file.commit.author} on ${file.commit.date}, which sync has not applied to the page`
    : `the delete of ${file.path} (Git could not name the deleting commit), which sync has not applied to the page`;
  if (file.reason === 'unknown') return `the current bytes of ${file.path}, which no import or gbrain write recorded`;
  const commit = file.commit ? `commit ${file.commit.sha.slice(0, 12)} by ${file.commit.author} on ${file.commit.date}` : 'the newest edit';
  return `${commit} to ${file.path}, which sync ${file.reason === 'no_import_record' ? 'never recorded importing' : 'has not imported'}`;
}

/**
 * The refusal of a reconcile that would write the database copy over an unimported file edit (sources reconcile,
 * writer_reconcile_preview and writer_reconcile_apply). Nothing was written.
 */
export function unimportedFileRefusal(sourceId: string, slug: string, file: UnimportedFile, paths: readonly string[]) {
  return opError('source_changed', `Reconciling ${slug} would overwrite ${unimportedFileText(file)}.`,
    `Nothing was written. The resolution takes the database copy over what the file says at ${paths.join(', ')}. Decide take_file for those paths to keep the file's edit; `
    + `if the user decides the edit should be discarded, preview gbrain repair file-drift --source ${sourceId} --slug ${slug} --prefer database, which names the edit and needs their consent before it overwrites the file.`,
    { detail: 'unimported_file_edit', fix: readFix(`Previews the database-wins repair of ${slug}, read-only: it names the edit it would discard.`,
      { argv: ['gbrain', 'repair', 'file-drift', '--source', sourceId, '--slug', slug, '--prefer', 'database'] }) });
}
