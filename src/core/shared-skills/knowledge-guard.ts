import { isAbsolute, relative, resolve, sep } from 'node:path';
import { viewedEngine } from '../persistence/switches.ts';
import { fileURLToPath } from 'node:url';
import { OperationError } from '../ops/contract.ts';
import { isRelativeFileUri, resolveSourceLocalFilePath, sourceGitScope } from '../markdown.ts';
import { screeningPath } from '../persistence/screening-paths.ts';
import { localHostId } from '../persistence/identity.ts';
import type { SqlEngine, WriteRequest } from '../persistence/model.ts';
import { canonicalFilesystemPath } from '../persistence/root-registry.ts';

export type KnowledgePublicationTarget = Pick<WriteRequest, 'source_id' | 'source_incarnation' | 'slug' | 'target_kind'> & Partial<Pick<WriteRequest, 'intent' | 'operation'>>;
export interface KnowledgePublicationFile { path: string; root: string; expectedBeforeHash?: string | null }

/** The maintenance intent that soft-deletes an approved ghost page (`gbrain repair ghost-pages`, `file-drift --prefer file`). */
export const GHOST_RETIREMENT_INTENT = 'managed_maintenance_retire_ghost_page';

interface PackRoot {
  source_id: string;
  source_incarnation: string;
  source_root: string | null;
  worktree_root: string | null;
  relative_path: string | null;
}

function reserved(path: string): boolean {
  const normalized = path.split(sep).join('/').toLowerCase();
  return normalized === 'skills' || normalized.startsWith('skills/') || normalized === 'skillpack.json';
}

function reject(): never {
  throw new OperationError('skill_bundle_required', 'Knowledge writes cannot change the canonical shared skillpack.',
    'Use put_skill with the catalog expected_revision and complete approved file bundle; an existing pack requires host-authorized adoptSharedSkillpack adoption. Imported skill text remains knowledge data, not published instructions.');
}

/**
 * #6910: whether a source-relative path is a member of the source's adopted shared skillpack: `skillpack.json`, a file of a
 * live skill's current revision, or a path under a live skill's `skills/<name>/` directory.
 */
export async function sharedPackMember(engine: SqlEngine, sourceId: string, sourceIncarnation: string, paths: string[]): Promise<boolean> {
  const normalized = paths.map(path => path.split(sep).join('/'));
  if (normalized.some(path => path.toLowerCase() === 'skillpack.json')) return true;
  const [row] = await engine.executeRaw<{ member: boolean }>(`SELECT EXISTS (SELECT 1 FROM shared_skill_heads h
      JOIN shared_skill_revisions r ON r.source_id=h.source_id AND r.source_incarnation=h.source_incarnation AND r.pack_id=h.pack_id AND r.name=h.name AND r.revision=h.revision
      WHERE h.source_id=$1 AND h.source_incarnation=$2::uuid AND NOT h.deleted AND (
        EXISTS (SELECT 1 FROM jsonb_array_elements(r.files) f WHERE f->>'path' = ANY($3::text[]))
        OR EXISTS (SELECT 1 FROM unnest($3::text[]) p WHERE starts_with(p, 'skills/' || h.name || '/')))) AS member`, [sourceId, sourceIncarnation, normalized]);
  return row?.member === true;
}

/**
 * #6910: the retirement of an approved ghost page that is not a pack member changes no pack file: its file is already gone and
 * the prepared target expects no bytes (filesystem publication refuses a file that appears), so it is a database-only soft
 * delete of a legacy knowledge page. A pack member's page stays refused.
 */
async function retiresNonMemberGhost(engine: SqlEngine, row: KnowledgePublicationTarget, preparedFile?: KnowledgePublicationFile): Promise<boolean> {
  const ghost = row.intent?.kind === GHOST_RETIREMENT_INTENT ? row.intent.ghost as { path?: unknown } | undefined : undefined;
  if (typeof ghost?.path !== 'string' || (preparedFile && preparedFile.expectedBeforeHash !== null)) return false;
  return !(await sharedPackMember(engine, row.source_id, row.source_incarnation, [ghost.path, `${row.slug}.md`]));
}

/**
 * #7345: the retention purge of an expired tombstone that is not a pack member and expects no file bytes is a database-only
 * hard delete of a legacy knowledge page, as #6910's ghost retirement is a database-only soft delete. A pack member's
 * tombstone, or one whose file is still on disk (the purge would remove it), stays refused.
 */
async function purgesNonMemberTombstone(engine: SqlEngine, row: KnowledgePublicationTarget, preparedFile?: KnowledgePublicationFile): Promise<boolean> {
  if (row.operation !== 'delete_page' || row.intent?.purge !== true || row.intent.retention !== true || (preparedFile && preparedFile.expectedBeforeHash !== null)) return false;
  const [tombstone] = await engine.executeRaw<{ source_path: string | null }>(
    'SELECT source_path FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NOT NULL', [row.source_id, row.slug]);
  if (!tombstone) return false;
  return !(await sharedPackMember(engine, row.source_id, row.source_incarnation, [...(tombstone.source_path ? [tombstone.source_path] : []), `${row.slug}.md`]));
}

const packsInTransaction = new WeakMap<object, Promise<PackRoot[]>>();
/** Engines (the connection owner, not a transaction view of it) whose schema has shared_skill_packs; migrations never drop it. */
const packTablePresent = new WeakSet<object>();
function connectionOwner(engine: object): object {
  let owner = viewedEngine(engine);
  while (Object.hasOwn(owner, '_pageTransaction') && (owner as { _pageTransaction?: boolean })._pageTransaction === true) owner = Object.getPrototypeOf(owner);
  return owner;
}
/** The shared skillpack roots; #5984: read once per transaction engine. */
function sharedPacks(engine: SqlEngine): Promise<PackRoot[]> {
  const read = async () => {
    const owner = connectionOwner(engine);
    if (!packTablePresent.has(owner)) {
      const [schema] = await engine.executeRaw<{ present: boolean }>("SELECT to_regclass('shared_skill_packs') IS NOT NULL AS present");
      if (!schema?.present) return [];
      packTablePresent.add(owner);
    }
    return engine.executeRaw<PackRoot>(`SELECT p.source_id,p.source_incarnation,s.local_path AS source_root,
      h.local_path AS worktree_root,b.relative_path FROM shared_skill_packs p
      JOIN sources s ON s.id=p.source_id AND s.incarnation=p.source_incarnation
      LEFT JOIN persistence_source_bindings b ON b.source_id=p.source_id AND b.source_incarnation=p.source_incarnation
      LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid`, [localHostId()]);
  };
  if ((engine as { _pageTransaction?: boolean })._pageTransaction !== true) return read();
  let cached = packsInTransaction.get(engine);
  if (!cached) { cached = read(); packsInTransaction.set(engine, cached); }
  return cached;
}

/** A transaction that changes shared_skill_packs re-reads them for its later knowledge writes. */
export function forgetSharedPacks(engine: SqlEngine): void { packsInTransaction.delete(engine); }

export async function assertKnowledgePublicationAllowed(
  engine: SqlEngine,
  row: KnowledgePublicationTarget,
  preparedFile?: KnowledgePublicationFile,
): Promise<void> {
  if (row.target_kind === 'skill_bundle') return;
  const packs = await sharedPacks(engine);
  if (!packs.length) return;
  if (await retiresNonMemberGhost(engine, row, preparedFile) || await purgesNonMemberTombstone(engine, row, preparedFile)) return;
  const ownPack = packs.find(pack => pack.source_id === row.source_id && pack.source_incarnation === row.source_incarnation);
  if (ownPack && reserved(row.slug)) reject();
  const roots = [...new Set(packs.flatMap(pack => [
    ...(pack.source_root ? [pack.source_root] : []),
    ...(pack.worktree_root !== null && pack.relative_path !== null ? [resolve(pack.worktree_root, pack.relative_path)] : []),
  ]))].map(root => screeningPath(`pack-root\0${root}`, () => canonicalFilesystemPath(root)));
  const paths = preparedFile ? [preparedFile.path] : [];
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1 AND incarnation=$2::uuid', [row.source_id, row.source_incarnation]);
  const sourceRoots = [...new Set([...(source?.local_path ? [source.local_path] : []), ...(preparedFile ? [preparedFile.root] : []),
    ...(ownPack?.worktree_root !== null && ownPack?.worktree_root !== undefined && ownPack.relative_path !== null
      ? [resolve(ownPack.worktree_root, ownPack.relative_path)] : [])])];
  const aliases = await engine.executeRaw<{ source_path: string | null; source_uri: string | null }>(
    'SELECT source_path,source_uri FROM pages WHERE source_id=$1 AND slug=$2', [row.source_id, row.slug]);
  for (const root of sourceRoots) {
    paths.push(resolve(root, `${row.slug}.md`));
    for (const alias of aliases) {
      if (alias.source_path) {
        paths.push(resolve(root, alias.source_path));
        const recorded = resolveSourceLocalFilePath(root, alias.source_path, row.slug, undefined, screeningPath(`git-scope\0${root}`, () => sourceGitScope(root)));
        if (recorded) paths.push(recorded);
      }
      if (alias.source_uri?.startsWith('file:') && !isRelativeFileUri(alias.source_uri)) {
        try { paths.push(fileURLToPath(alias.source_uri)); } catch {
          // An unresolved alias must still fail closed, but it does not prove
          // that this ordinary page is part of a shared skillpack.
          const error = new OperationError('invalid_source_uri',
            'The page has a stored file source_uri that cannot be resolved to a local filesystem path. Have the source owner inspect and repair the stored source_uri before retrying.',
            `On the brain host, inspect the stored source_uri of page ${row.slug} in source ${row.source_id} and replace it with an absolute file URI or clear it, then retry the knowledge write with a new request_id. Shared skillpack protection remains enabled.`);
          error.detail = 'invalid_source_uri';
          throw error;
        }
      }
    }
  }
  for (const path of paths) {
    const target = canonicalFilesystemPath(path);
    for (const root of roots) {
      const rel = relative(root, target);
      if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && reserved(rel)) reject();
    }
  }
}
