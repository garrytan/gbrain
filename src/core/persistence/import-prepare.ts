import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page } from '../types.ts';
import { importCodeFile, importFromContent, importImageFile, isImageFilePath, MAX_FILE_SIZE, MAX_IMAGE_BYTES } from '../import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { applyInference } from '../frontmatter-inference.ts';
import { getCompanyBrainProfile } from '../company-brain/profile.ts';
import { hasMalformedPathSegment, isCodeFilePath, slugifyCodePath, slugifyPath } from '../sync.ts';
import { OperationError } from '../ops/contract.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { assertPageRevision } from '../page-state/types.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { getWorktreeBinding } from './ownership.ts';
import { localHostId } from './identity.ts';
import { sha256 } from './digest.ts';
import { prepareCanonicalProjections } from './canonical-projections.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';

export type ImportPack = { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string>; aliases?: ReadonlyArray<string> }> };
export interface ManagedImportIntent extends Record<string, unknown> {
  kind: 'managed_file_import'; slug: string; content: string; sourcePath: string; path?: string;
  inputPath: string; inputHash: string; targetHash: string | null;
  ownerEpoch: string; expected_revision?: string; noEmbed: boolean; activePack?: ImportPack;
}

export function readImportBytes(path: string): Buffer {
  if (realpathSync(path) !== resolve(path) || !lstatSync(path).isFile()) {
    throw new OperationError('source_changed', 'Managed import refuses symlinked files or ancestors. Use the real source path.');
  }
  const maxBytes = isImageFilePath(path) ? MAX_IMAGE_BYTES : MAX_FILE_SIZE;
  if (lstatSync(path).size > maxBytes) throw new OperationError('invalid_params', `File too large (max ${maxBytes} bytes).`);
  return readFileSync(path);
}

export function managedImportContent(sourcePath: string, bytes: Buffer, activePack?: ImportPack): { slug: string; content: string } {
  if (isAbsolute(sourcePath) || sourcePath.split(/[\\/]/).some(part => part === '..') || hasMalformedPathSegment(sourcePath)) {
    throw new OperationError('invalid_params', 'The import path must be a well-formed source-relative path.');
  }
  if (/(^|\/)skills(\/|$)/i.test(sourcePath.replaceAll('\\', '/')) || /(^|\/)skillpack\.json$/i.test(sourcePath)) {
    throw new OperationError('skill_bundle_required', 'Import cannot publish skill paths. Use the shared skill publisher.');
  }
  if (isImageFilePath(sourcePath)) return { slug: sourcePath.replaceAll('\\', '/').toLowerCase(), content: bytes.toString('base64') };
  let content = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (isCodeFilePath(sourcePath)) return { slug: slugifyCodePath(sourcePath), content };
  if (!/\.mdx?$/i.test(sourcePath)) throw new OperationError('invalid_params', 'Managed import supports Markdown, code and supported image files.');
  const original = parseMarkdown(content, sourcePath, { validate: true });
  const invalid = original.errors?.find(error => error.code === 'YAML_PARSE');
  if (invalid) throw new OperationError('invalid_params', `Invalid YAML frontmatter: ${invalid.message}`);
  content = applyInference(sourcePath, content).content;
  const parsed = parseMarkdown(content, sourcePath, { validate: true, ...(activePack ? { activePack } : {}) });
  const expected = slugifyPath(sourcePath);
  if (expected && parsed.slug !== expected && slugifyPath(parsed.slug) !== expected) {
    throw new OperationError('invalid_params', `Frontmatter slug "${parsed.slug}" does not match path-derived slug "${expected}".`);
  }
  const slug = parsed.slug || expected;
  if (!slug) throw new OperationError('invalid_params', 'The filename produces no usable slug; add a slug in frontmatter.');
  return { slug, content };
}

export async function assertImportPaths(engine: BrainEngine, sourceId: string, root: string, input: string, target: string): Promise<void> {
  if (await getCompanyBrainProfile(engine, sourceId)) throw new OperationError('profile_incompatible', 'Company-brain sources require approved committed ingestion and never accept ordinary import writeback.');
  if (!isWriteTargetContained(target, root)) throw new OperationError('source_changed', 'The import target escapes its canonical source root.');
  const sources = await engine.executeRaw<{ id: string; local_path: string | null; worktree_path: string | null; relative_path: string | null }>(
    `SELECT s.id,s.local_path,h.local_path AS worktree_path,b.relative_path FROM sources s
      LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
      LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid WHERE NOT s.archived`, [localHostId()]);
  for (const source of sources) {
    if (source.id === sourceId) continue;
    const roots = [source.local_path, source.worktree_path && source.relative_path !== null ? join(source.worktree_path, source.relative_path) : null];
    for (const candidate of roots) {
      if (!candidate) continue;
      const other = existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);
      for (const path of [input, target]) {
        const rel = relative(other, path);
        if (rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) {
          throw new OperationError('source_changed', 'The import path belongs to a different registered source. Select that source explicitly.');
        }
      }
    }
  }
}

export async function prepareManagedImportMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent as ManagedImportIntent | null;
  if (row.authority.remote || row.principal_kind !== 'local_cli') throw new OperationError('permission_denied', 'Filesystem import requires a trusted local CLI writer.');
  if (!p || p.kind !== 'managed_file_import' || typeof p.content !== 'string' || typeof p.inputPath !== 'string' || typeof p.sourcePath !== 'string') {
    throw new OperationError('invalid_params', 'The durable file import intent is incomplete.');
  }
  const binding = await getWorktreeBinding(engine, row.source_id);
  if (!row.worktree_id || !binding?.local_path || String(binding.owner_epoch) !== p.ownerEpoch) throw new OperationError('owner_unavailable', 'Managed file import requires its accepted canonical owner.');
  const root = join(binding.local_path, binding.relative_path);
  const physicalPath = p.path ?? p.sourcePath;
  if (isAbsolute(physicalPath) || physicalPath.split(/[\\/]/).some(part => part === '..') || /(^|[\\/])skills([\\/]|$)/i.test(physicalPath)) {
    throw new OperationError('invalid_params', 'The canonical import path must be source-relative knowledge, not a skill path.');
  }
  const path = resolve(root, physicalPath);
  const checkPaths = async (tx: BrainEngine) => {
    const current = await getWorktreeBinding(tx, row.source_id);
    if (!current || current.worktree_id !== row.worktree_id || String(current.owner_epoch) !== p.ownerEpoch) throw new OperationError('owner_unavailable', 'The import owner changed.');
    await assertImportPaths(tx, row.source_id, root, p.inputPath, path);
    await assertKnowledgePublicationAllowed(tx, row, { root, path });
    if (sha256(readImportBytes(p.inputPath)) !== p.inputHash) throw new OperationError('source_changed', 'The input file changed after import admission.');
    if ((existsSync(path) ? sha256(readImportBytes(path)) : null) !== p.targetHash) throw new OperationError('source_changed', 'The canonical file changed after import admission.');
  };
  await checkPaths(engine);
  const normalized = managedImportContent(p.sourcePath, readImportBytes(p.inputPath), p.activePack);
  if (normalized.slug !== row.slug || normalized.content !== p.content) throw new OperationError('source_changed', 'The frozen file identity no longer matches the import.');
  const source = { sourceId: row.source_id };
  const snapshot = await engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
  assertPageRevision(snapshot, p.expected_revision ? { expectedRevision: p.expected_revision } : {});
  if ((snapshot?.page.id ?? null) !== row.page_id || snapshot?.page.source_path && snapshot.page.source_path !== p.sourcePath) {
    throw new OperationError('page_identity_changed', 'The imported path no longer names the accepted page.');
  }
  let prepared: (Omit<PreparedContentImport, 'parsedPage'> & { parsedPage?: PreparedContentImport['parsedPage'] }) | undefined;
  const prepare = async (value: NonNullable<typeof prepared>) => { prepared = value; return value.result; };
  const code = isCodeFilePath(p.sourcePath);
  const image = isImageFilePath(p.sourcePath);
  const imageBytes = image ? Buffer.from(p.content, 'base64') : undefined;
  const result = image
    ? await importImageFile(engine, p.inputPath, p.sourcePath, { ...source, noEmbed: p.noEmbed, bytes: imageBytes, prepare })
    : code
    ? await importCodeFile(engine, p.sourcePath, p.content, { ...source, noEmbed: true, prepare })
    : await importFromContent(engine, row.slug, p.content, { ...source, noEmbed: true, remote: false, prepare,
      activePack: p.activePack, sourcePath: p.sourcePath, filename: basename(p.sourcePath, '.md'), allowEmptyOverwrite: true });
  if (!prepared) throw new OperationError('invalid_params', result.error ?? 'The file could not be prepared.');
  const ready = prepared;
  if (ready.slug !== row.slug || ready.observedRevision !== (snapshot?.revision ?? null)) throw new OperationError('revision_conflict', 'The import identity changed during preparation.');
  if (!image && !ready.parsedPage) throw new OperationError('invalid_params', 'The text import lost its prepared page.');
  const tags = [...new Set([...(snapshot?.tags ?? []), ...(ready.parsedPage?.tags ?? [])])].sort();
  const rendered = imageBytes ?? (code ? p.content : serializePageToMarkdown({
    ...(snapshot?.page ?? { id: 0, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }), ...ready.parsedPage,
  } as Page, tags));
  const project = code || image ? undefined : prepareCanonicalProjections(ready.parsedPage!, row.slug, row.source_id);
  return { observedRevision: ready.observedRevision, noop: ready.noop && p.targetHash === sha256(rendered),
    deferEmbedding: image || p.noEmbed, validate: checkPaths,
    file: { root, path, content: rendered, expectedBeforeHash: p.targetHash },
    apply: async tx => {
      await ready.apply(tx);
      await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2 AND source_path IS DISTINCT FROM $3', [row.source_id, row.slug, p.sourcePath]);
      if (!ready.noop && project) await project(tx);
      if (!ready.noop && !image) await sealPageTextProjection(tx, row.slug, row.source_id);
      return { ...result, parsedPage: undefined, imported_file: true, source_id: row.source_id };
    } };
}
