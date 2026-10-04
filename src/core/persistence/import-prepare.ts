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
import { OperationError, opError } from '../ops/contract.ts';
import { yamlLocator } from './page-identity.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { assertPageRevision } from '../page-state/types.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { getWorktreeBinding } from './ownership.ts';
import { localHostId } from './identity.ts';
import { sha256 } from './digest.ts';
import { isReservedSkillBundlePath } from '../skill-reserved-paths.ts';
import { prepareCanonicalProjections } from './canonical-projections.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';

export type ImportPack = { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string>; aliases?: ReadonlyArray<string> }> };
export interface ManagedImportIntent extends Record<string, unknown> {
  kind: 'managed_file_import'; slug: string; content: string; sourcePath: string; path?: string;
  inputPath: string; inputHash: string; targetHash: string | null;
  ownerEpoch: string; expected_revision?: string; noEmbed: boolean; activePack?: ImportPack;
}

const reimportFix = (inputPath: string, sourceId: string): Action => ({
  argv: ['gbrain', 'import', inputPath, '--source', sourceId], consent: [], actor: 'agent', requires_exclusive: false,
  why: `Re-reads the file as it is now and imports it into source ${sourceId} under a new request through its canonical owner.`,
});
const receiptFix = (row: WriteRequest): Action => readFix('Reads the import request\'s durable receipt: its state and recorded error, read-only.',
  { argv: ['gbrain', 'write-request', '--', row.request_id] });
const ownerStatusFix = (sourceId: string): Action => readFix(`Shows source ${sourceId}'s canonical owner and its state, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });

export function readImportBytes(path: string): Buffer {
  if (realpathSync(path) !== resolve(path) || !lstatSync(path).isFile()) {
    throw opError('source_changed', 'Managed import refuses symlinked files or ancestors. Use the real source path.',
      `${path} is a symlink or sits under one, so it was not imported. Import the file at its real location (or copy it into the source) instead.`);
  }
  const maxBytes = isImageFilePath(path) ? MAX_IMAGE_BYTES : MAX_FILE_SIZE;
  if (lstatSync(path).size > maxBytes) throw opError('invalid_params', `File too large (max ${maxBytes} bytes).`,
    `${basename(path)} is over the ${maxBytes}-byte import limit and was not imported. Split it into smaller files or leave it out of the import.`);
  return readFileSync(path);
}

export function managedImportContent(sourcePath: string, bytes: Buffer, activePack?: ImportPack): { slug: string; content: string } {
  if (isAbsolute(sourcePath) || sourcePath.split(/[\\/]/).some(part => part === '..') || hasMalformedPathSegment(sourcePath)) {
    throw opError('invalid_params', 'The import path must be a well-formed source-relative path.',
      `${JSON.stringify(sourcePath)} is absolute, climbs out with "..", or has a malformed segment, so it was not imported. Rename the file or import it from inside the source root.`);
  }
  if (isReservedSkillBundlePath(sourcePath)) {
    throw opError('skill_bundle_required', 'Import cannot publish skill paths. Use the shared skill publisher.',
      `${sourcePath} is a reserved skill path, so import skipped it. Publish skills with put_skill (CLI: gbrain put-skill) and the catalog expected_revision; skill text imported as knowledge is never published as instructions.`);
  }
  if (isImageFilePath(sourcePath)) return { slug: sourcePath.replaceAll('\\', '/').toLowerCase(), content: bytes.toString('base64') };
  let content = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (isCodeFilePath(sourcePath)) return { slug: slugifyCodePath(sourcePath), content };
  if (!/\.mdx?$/i.test(sourcePath)) throw opError('invalid_params', 'Managed import supports Markdown, code and supported image files.',
    `${sourcePath} is not a Markdown (.md, .mdx), code or supported image file, so it was not imported. Convert it to Markdown or leave it out.`);
  const original = parseMarkdown(content, sourcePath, { validate: true });
  const invalid = original.errors?.find(error => error.code === 'YAML_PARSE');
  if (invalid) {
    throw opError('invalid_params', `Invalid YAML frontmatter${yamlLocator(invalid.message)} in ${sourcePath}.`,
      `Quote frontmatter values that contain ": " or start with a special character in ${sourcePath}, then run the import again.`);
  }
  content = applyInference(sourcePath, content).content;
  const parsed = parseMarkdown(content, sourcePath, { validate: true, ...(activePack ? { activePack } : {}) });
  const expected = slugifyPath(sourcePath);
  if (expected && parsed.slug !== expected && slugifyPath(parsed.slug) !== expected) {
    throw opError('invalid_params', `Frontmatter slug "${parsed.slug}" does not match path-derived slug "${expected}".`,
      `In ${sourcePath}, set the frontmatter slug to "${expected}" or remove it (the path decides the slug), or move the file to the path that matches "${parsed.slug}", then import again.`);
  }
  const slug = parsed.slug || expected;
  if (!slug) throw opError('invalid_params', 'The filename produces no usable slug; add a slug in frontmatter.',
    `Rename ${sourcePath} to a name with letters or digits, or add a slug: line to its frontmatter, then import again.`);
  return { slug, content };
}

export async function assertImportPaths(engine: BrainEngine, sourceId: string, root: string, input: string, target: string): Promise<void> {
  if (await getCompanyBrainProfile(engine, sourceId)) throw opError('profile_incompatible', 'Company-brain sources require approved committed ingestion and never accept ordinary import writeback.',
    `Source ${sourceId} ingests only committed content under its approved company-brain profile. Commit the file to that source's repository and sync it, or import it into a different source.`,
    { fix: { argv: ['gbrain', 'sync', '--no-pull', '--source', sourceId], consent: [], actor: 'agent', requires_exclusive: false,
      why: `Imports source ${sourceId}'s committed checkout through its approved ingestion; uncommitted files are not read.`,
      verify: { argv: ['gbrain', 'sources', 'status', '--json'] } } });
  if (!isWriteTargetContained(target, root)) throw opError('source_changed', 'The import target escapes its canonical source root.',
    `The file would land outside source ${sourceId}'s canonical root (a symlinked directory or a path with ".."), so nothing was imported. Import it from a real path inside the source.`,
    { fix: ownerStatusFix(sourceId) });
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
          throw opError('source_changed', 'The import path belongs to a different registered source. Select that source explicitly.',
            `${path === input ? 'The file' : 'Its target'} sits inside source ${source.id}'s root, not ${sourceId}'s; nothing was imported. Import it into ${source.id} with --source ${source.id}.`,
            { fix: { argv: ['gbrain', 'import', input, '--source', source.id], consent: [], actor: 'agent', requires_exclusive: false,
              why: `Imports the file into source ${source.id}, which owns its path.` } });
        }
      }
    }
  }
}

export async function prepareManagedImportMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent as ManagedImportIntent | null;
  if (row.authority.remote || row.principal_kind !== 'local_cli') throw trustedCliRequired('Filesystem import requires a trusted local CLI writer.');
  if (!p || p.kind !== 'managed_file_import' || typeof p.content !== 'string' || typeof p.inputPath !== 'string' || typeof p.sourcePath !== 'string') {
    throw opError('invalid_params', 'The durable file import intent is incomplete.',
      `Import request ${row.request_id} in source ${row.source_id} has no complete file intent, so it published nothing. Read its receipt, then import the file again with gbrain import --source ${row.source_id}.`,
      { fix: receiptFix(row) });
  }
  const binding = await getWorktreeBinding(engine, row.source_id);
  if (!row.worktree_id || !binding?.local_path || String(binding.owner_epoch) !== p.ownerEpoch) throw opError('owner_unavailable', 'Managed file import requires its accepted canonical owner.',
    `Source ${row.source_id}'s canonical owner changed or went away after import request ${row.request_id} was accepted, so it published nothing. Check the owner, then import ${p.sourcePath} again on the host that owns the source.`,
    { fix: ownerStatusFix(row.source_id) });
  const root = join(binding.local_path, binding.relative_path);
  const physicalPath = p.path ?? p.sourcePath;
  if (isAbsolute(physicalPath) || physicalPath.split(/[\\/]/).some(part => part === '..') || /(^|[\\/])skills([\\/]|$)/i.test(physicalPath)) {
    throw opError('invalid_params', 'The canonical import path must be source-relative knowledge, not a skill path.',
      `Import request ${row.request_id} targets ${JSON.stringify(physicalPath)} in source ${row.source_id}, which is absolute, climbs out with "..", or is a skill path; it published nothing. Import knowledge files from inside the source root and publish skills with put_skill.`,
      { fix: receiptFix(row) });
  }
  const path = resolve(root, physicalPath);
  const checkPaths = async (tx: BrainEngine) => {
    const current = await getWorktreeBinding(tx, row.source_id);
    if (!current || current.worktree_id !== row.worktree_id || String(current.owner_epoch) !== p.ownerEpoch) throw opError('owner_unavailable', 'The import owner changed.',
      `Source ${row.source_id}'s canonical owner changed while import request ${row.request_id} was prepared, so it published nothing. Check the owner, then import ${p.sourcePath} again on the host that owns the source.`,
      { fix: ownerStatusFix(row.source_id) });
    await assertImportPaths(tx, row.source_id, root, p.inputPath, path);
    await assertKnowledgePublicationAllowed(tx, row, { root, path });
    if (sha256(readImportBytes(p.inputPath)) !== p.inputHash) throw opError('source_changed', 'The input file changed after import admission.',
      `${p.sourcePath} was edited after import request ${row.request_id} was accepted, so the request published nothing. Import it again to publish the current bytes.`,
      { fix: reimportFix(p.inputPath, row.source_id) });
    if ((existsSync(path) ? sha256(readImportBytes(path)) : null) !== p.targetHash) throw opError('source_changed', 'The canonical file changed after import admission.',
      `The canonical copy of ${p.sourcePath} in source ${row.source_id} changed after import request ${row.request_id} was accepted, so it was not overwritten. Review that file, then import again if the import should still replace it.`,
      { fix: reimportFix(p.inputPath, row.source_id) });
  };
  await checkPaths(engine);
  const normalized = managedImportContent(p.sourcePath, readImportBytes(p.inputPath), p.activePack);
  if (normalized.slug !== row.slug || normalized.content !== p.content) throw opError('source_changed', 'The frozen file identity no longer matches the import.',
    `${p.sourcePath} now normalizes to different content or slug than import request ${row.request_id} accepted for ${row.slug}, so it published nothing. Import it again to publish the current file.`,
    { fix: reimportFix(p.inputPath, row.source_id) });
  const source = { sourceId: row.source_id };
  const snapshot = await engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
  assertPageRevision(snapshot, p.expected_revision ? { expectedRevision: p.expected_revision } : {});
  if ((snapshot?.page.id ?? null) !== row.page_id || snapshot?.page.source_path && snapshot.page.source_path !== p.sourcePath) {
    throw opError('page_identity_changed', 'The imported path no longer names the accepted page.',
      `Page ${row.slug} in source ${row.source_id} was replaced, removed, or now maps to a different file than ${p.sourcePath}, so import request ${row.request_id} published nothing. Read the page before importing the file again.`,
      { fix: readFix(`Shows which page holds ${row.slug} in source ${row.source_id} now, with its source path and revision.`,
        { argv: ['gbrain', 'get', '--source', row.source_id, '--', row.slug] }) });
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
  if (!prepared) throw opError('invalid_params', result.error ?? 'The file could not be prepared.',
    `${p.sourcePath} was rejected while preparing import request ${row.request_id} for source ${row.source_id}; nothing was published. Fix the file content or frontmatter named in the message, then import it again.`,
    { fix: reimportFix(p.inputPath, row.source_id) });
  const ready = prepared;
  if (ready.slug !== row.slug || ready.observedRevision !== (snapshot?.revision ?? null)) throw opError('revision_conflict', 'The import identity changed during preparation.',
    `Page ${row.slug} in source ${row.source_id} changed while import request ${row.request_id} was prepared, so it published nothing. Import ${p.sourcePath} again against the current page.`,
    { fix: reimportFix(p.inputPath, row.source_id) });
  if (!image && !ready.parsedPage) throw opError('invalid_params', 'The text import lost its prepared page.',
    `Preparing ${p.sourcePath} for import request ${row.request_id} in source ${row.source_id} produced no page, so nothing was published. Read the receipt and report it to the user if importing the file again fails the same way.`,
    { fix: receiptFix(row) });
  const tags = [...new Set([...(snapshot?.tags ?? []), ...(ready.parsedPage?.tags ?? [])])].sort();
  const rendered = imageBytes ?? (code ? p.content : serializePageToMarkdown({
    ...(snapshot?.page ?? { id: 0, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }), ...ready.parsedPage,
  } as Page, tags));
  const project = code || image ? undefined : await prepareCanonicalProjections(engine, ready.parsedPage!, row.slug, row.source_id, snapshot, 'file');
  return { observedRevision: ready.observedRevision, noop: ready.noop && p.targetHash === sha256(rendered),
    deferEmbedding: image || p.noEmbed, validate: async tx => { await checkPaths(tx); await ready.validate(tx); },
    file: { root, path, content: rendered, expectedBeforeHash: p.targetHash },
    apply: async tx => {
      await ready.apply(tx);
      await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2 AND source_path IS DISTINCT FROM $3', [row.source_id, row.slug, p.sourcePath]);
      if (!ready.noop && project) await project(tx);
      if (!ready.noop && !image) await sealPageTextProjection(tx, row.slug, row.source_id);
      return { ...result, parsedPage: undefined, imported_file: true, source_id: row.source_id };
    } };
}
