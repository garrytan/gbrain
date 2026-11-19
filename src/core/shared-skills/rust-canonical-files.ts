/**
 * The canonical skill files of one Rust publication (rust/docs/store/shared-skill-members.md, "Publication"). They are
 * staged inside the store transaction and renamed over their paths after it commits. This module is apart from
 * rust-publication.ts because the persistence protocol loads that one, and the bundle file helpers must stay off the
 * protocol's static import graph.
 */
import { unlinkSync } from 'node:fs';
import { prepareBundleFiles, publishStagedBundleFile, stageBundleFile, type MutationFile } from '../persistence/bundle-files.ts';
import type { FileRecoveryRecord, WriteRequest } from '../persistence/model.ts';

/**
 * The canonical files of one Rust publication, staged under the source root before its store transaction commits:
 * each file is checked against the hash it was prepared with, then written to a temporary sibling and fsynced. A
 * deleted file stages nothing.
 */
export function stageRustCanonicalFiles(files: MutationFile[], row: WriteRequest): FileRecoveryRecord[] {
  if (!files.length) return [];
  const { record } = prepareBundleFiles(files, files[0]!.root, '0', row.execution_token ?? row.request_id, row);
  try {
    for (let index = 0; index < files.length; index++) stageBundleFile(files[index]!, record.files[index]!);
  } catch (error) { discardRustStaging(record.files); throw error; }
  return record.files;
}

/** After the commit: rename each staged file over its canonical path (a deleted file is unlinked), then fsync its directory. */
export function publishRustCanonicalFiles(records: FileRecoveryRecord[]): void {
  for (const record of records) publishStagedBundleFile(record);
}

/** Removes the staging files a rolled-back publication left; a staging file already renamed or never written is skipped. */
export function discardRustStaging(records: FileRecoveryRecord[]): void {
  for (const record of records) {
    const path = record.staging?.publication?.path;
    if (path) try { unlinkSync(path); } catch { /* already renamed or never staged */ }
  }
}
