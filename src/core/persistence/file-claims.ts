/**
 * The recorded-origin census: which other live pages of a source record the
 * same canonical file (by `source_path` in any spelling or by a `file:` URI,
 * realpath deciding). Reconcile refuses on any claimant (`reconcile-state.ts`
 * `assertSoleFileClaim`); a soft delete of a page whose file another live page
 * records keeps the file and publishes database-only (`page-prepare.ts`,
 * #6517), re-running this census under publication to revalidate the survivor.
 *
 * #6222/#6254: every page whose recorded path or file URI shares the file's
 * name is a candidate, and realpath decides each one. The census is paged
 * (100 rows per batch, keyset on id) below the source's highest page id read
 * once, so a common name like `2015-09.md` no longer refuses, and concurrent
 * imports cannot make it endless. Both name predicates match the expression
 * indexes of migration v219 (`pages_source_path_name_idx`,
 * `pages_file_uri_name_idx`): the path index normalizes backslashes, so on
 * POSIX the slash-only basename is rechecked on the rows it finds. Tombstones
 * are not claimants (#6517): a soft-deleted twin has given the file up.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrainEngine } from '../engine.ts';
import { resolveSourceLocalFilePath } from '../markdown.ts';
import { opError } from '../ops/contract.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { recordedPathFromFileUri } from '../write-through.ts';

export interface FileClaimTarget {
  sourceId: string; slug: string; pageId: number; root: string; mode: 'git-root' | 'source-root';
  path: string; canonicalPath: string; recordedUri: string | null;
  /** #6712 wave: the target file is gone (`absentCanonicalPath`), so a candidate whose recorded file is gone too claims it by path. */
  absent?: true;
}
export interface FileClaimant { id: number; slug: string }

/** A path that may not exist, canonicalized the way `isWriteTargetContained` does: its nearest existing ancestor's realpath plus the rest. */
export function absentCanonicalPath(path: string): string {
  const tail: string[] = [];
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) { tail.unshift(basename(existing)); existing = dirname(existing); }
  return join(realpathSync(existing), ...tail);
}

export function recordedReconcilePath(root: string, page: { slug: string; source_path?: string | null; source_uri?: string | null },
  mode: 'git-root' | 'source-root'): string | null {
  const path = resolveSourceLocalFilePath(root, page.source_path, page.slug, mode);
  if (path) return path;
  const recorded = recordedPathFromFileUri(page.source_uri, root);
  return recorded ? join(root, recorded) : null;
}
export interface FileClaimCandidatesWindow {
  sourceId: string; pageId: number; afterId: number; maxId: number;
  /** The target file's name. */
  fileName: string;
  /** Names a `file:` URI may end with. */
  uriNames: string[];
}
/**
 * The paged census query and its binds: $1 source, $2 the page itself, $3/$4 the id window, then the name
 * predicates. The path index normalizes backslashes, so on POSIX the indexed name is the file name after its
 * last backslash and the slash-only basename is rechecked against the file name; on Windows both separators
 * are path separators and the indexed name is the whole check. Every placeholder is referenced on every
 * platform (#6659: an unreferenced untyped bind fails with 42P18). Exported so the Postgres plan test runs
 * the exact text.
 */
export function fileClaimCandidatesQuery(window: FileClaimCandidatesWindow, platform: NodeJS.Platform = process.platform): { sql: string; params: unknown[] } {
  const { sourceId, pageId, afterId, maxId, fileName, uriNames } = window;
  const params: unknown[] = [sourceId, pageId, afterId, maxId];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const indexedName = `regexp_replace(replace(btrim(source_path), chr(92), '/'), '^.*/', '')`;
  const pathMatch = platform === 'win32'
    ? `source_path IS NOT NULL AND ${indexedName}=${bind(fileName)}`
    : `source_path IS NOT NULL AND ${indexedName}=${bind(fileName.replace(/^.*\\/s, ''))} AND regexp_replace(btrim(source_path),'^.*/','')=${bind(fileName)}`;
  const uriMatch = `source_uri LIKE 'file:%' AND regexp_replace(source_uri, '^.*/', '')=ANY(${bind(uriNames)}::text[])`;
  return {
    sql: `SELECT id,slug,source_path,source_uri FROM pages WHERE source_id=$1 AND id<>$2 AND id>$3 AND id<=$4 AND deleted_at IS NULL AND (
    (${pathMatch}) OR (${uriMatch}))
    ORDER BY id LIMIT 100`,
    params,
  };
}
/** Every other live page of the source whose recorded origin resolves to the target's canonical file, in id order. */
export async function findLiveFileClaimants(engine: BrainEngine, target: FileClaimTarget): Promise<FileClaimant[]> {
  const { sourceId, slug, root, mode, canonicalPath } = target;
  const fileName = basename(target.path), uriName = pathToFileURL(target.path).pathname.split('/').pop()!;
  const uriNames = [...new Set([fileName, uriName, ...(target.recordedUri ? [target.recordedUri.replace(/^.*\//s, '')] : [])])];
  const [ceiling] = await engine.executeRaw<{ id: number | string | null }>('SELECT max(id) AS id FROM pages WHERE source_id=$1', [sourceId]);
  const maxId = Number(ceiling?.id ?? 0);
  const claimants: FileClaimant[] = [];
  for (let afterId = 0; ;) {
    const query = fileClaimCandidatesQuery({ sourceId, pageId: target.pageId, afterId, maxId, fileName, uriNames });
    const candidates = await engine.executeRaw<{ id: number | string; slug: string; source_path: string | null; source_uri: string | null }>(
      query.sql, query.params);
    for (const candidate of candidates) {
      const candidatePath = recordedReconcilePath(root, candidate, mode);
      if (!candidatePath || !isWriteTargetContained(candidatePath, root)) continue;
      let canonicalCandidate: string;
      try { canonicalCandidate = realpathSync(candidatePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (target.absent && absentCanonicalPath(candidatePath) === canonicalPath) claimants.push({ id: Number(candidate.id), slug: candidate.slug });
          continue;
        }
        throw opError('source_changed', 'A candidate canonical file origin could not be verified.',
          `Nothing changed. Page ${candidate.slug} in '${sourceId}' records a file that could not be resolved; check that the source checkout is readable, then preview ${slug} again.`);
      }
      if (canonicalCandidate === canonicalPath) claimants.push({ id: Number(candidate.id), slug: candidate.slug });
    }
    if (candidates.length < 100) return claimants;
    afterId = Number(candidates[candidates.length - 1]!.id);
  }
}
