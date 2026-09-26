import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperationError } from '../ops/contract.ts';
import { resolveSourceLocalFilePath } from '../markdown.ts';
import { localHostId } from '../persistence/identity.ts';
import type { SqlEngine, WriteRequest } from '../persistence/model.ts';
import { canonicalFilesystemPath } from '../persistence/root-registry.ts';

export type KnowledgePublicationTarget = Pick<WriteRequest, 'source_id' | 'source_incarnation' | 'slug' | 'target_kind'>;
export interface KnowledgePublicationFile { path: string; root: string; }

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

export async function assertKnowledgePublicationAllowed(
  engine: SqlEngine,
  row: KnowledgePublicationTarget,
  preparedFile?: KnowledgePublicationFile,
): Promise<void> {
  if (row.target_kind === 'skill_bundle') return;
  const [schema] = await engine.executeRaw<{ present: boolean }>("SELECT to_regclass('shared_skill_packs') IS NOT NULL AS present");
  if (!schema?.present) return;
  const packs = await engine.executeRaw<PackRoot>(`SELECT p.source_id,p.source_incarnation,s.local_path AS source_root,
    h.local_path AS worktree_root,b.relative_path FROM shared_skill_packs p
    JOIN sources s ON s.id=p.source_id AND s.incarnation=p.source_incarnation
    LEFT JOIN persistence_source_bindings b ON b.source_id=p.source_id AND b.source_incarnation=p.source_incarnation
    LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid`, [localHostId()]);
  if (!packs.length) return;
  const ownPack = packs.find(pack => pack.source_id === row.source_id && pack.source_incarnation === row.source_incarnation);
  if (ownPack && reserved(row.slug)) reject();
  const roots = [...new Set(packs.flatMap(pack => [
    ...(pack.source_root ? [pack.source_root] : []),
    ...(pack.worktree_root !== null && pack.relative_path !== null ? [resolve(pack.worktree_root, pack.relative_path)] : []),
  ]))].map(root => canonicalFilesystemPath(root));
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
        const recorded = resolveSourceLocalFilePath(root, alias.source_path, row.slug);
        if (recorded) paths.push(recorded);
      }
      if (alias.source_uri?.startsWith('file:')) {
        try { paths.push(fileURLToPath(alias.source_uri)); } catch {
          // An unresolved alias must still fail closed, but it does not prove
          // that this ordinary page is part of a shared skillpack.
          throw new OperationError('invalid_source_uri',
            'The page has a stored file source_uri that cannot be resolved to a local filesystem path.',
            'Have the source owner inspect and repair the stored source_uri before retrying the knowledge write. Shared skillpack protection remains enabled.');
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
