import { closeSync, createReadStream, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page } from '../types.ts';
import { ownerGateInput, ownerImportTrust } from '../trust/channel.ts';
import { importCodeFile, importFromContent, importImageFile, isImageFilePath, MAX_IMAGE_BYTES, verifyPageReadable } from '../import-file.ts';
import { parseMarkdown, parseMarkdownHead, serializePageToMarkdown } from '../markdown.ts';
import { applyInference } from '../frontmatter-inference.ts';
import { getCompanyBrainProfile } from '../company-brain/profile.ts';
import { hasMalformedPathSegment, isCodeFilePath, slugifyCodePath, slugifyPath } from '../sync.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { contentRefusalError, importSizeLimit, screenImportContent, type ContentRefusal } from '../import-screen.ts';
import { fenceWhere } from '../fence-repair/refusal.ts';
import { pageFencesNormalized } from '../fence-repair/report.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { assertPageRevision } from '../page-state/types.ts';
import { sealImportedPage, sealPageTextProjection } from '../page-state/projections.ts';
import { materializedSnapshot, sealSegmentedPage } from './segmented-apply.ts';
import { withoutBody } from '../page-body/page-shape.ts';
import { importStreamedMarkdownFile, type StreamedPreparedImport } from '../page-body/streamed-import.ts';
import { FRONTMATTER_HEAD_MAX_BYTES, readPageBodyPolicy, type PageBodyPolicy } from '../page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { getWorktreeBinding } from './ownership.ts';
import { isCanonicalImageRead } from './canonical-image-input.ts';
import { localHostId } from './identity.ts';
import { sha256 } from './digest.ts';
import { screeningPath } from './screening-paths.ts';
import { isReservedSkillBundlePath } from '../skill-reserved-paths.ts';
import { prepareCanonicalProjections } from './canonical-projections.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { bindOrigin } from './origin-guard.ts';
import { segmentedOutcome } from './searchable.ts';
import { isQuarantined } from '../quarantine.ts';

export type ImportPack = { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string>; aliases?: ReadonlyArray<string> }> };
/** A Markdown file over the single-string ceiling, journaled by reference: the preparer streams and verifies it (Wave B). */
export interface ManagedImportBodyRef { kind: 'input_file'; input_path: string; sha256: string; bytes: number }
/** `content` (the normalized file) or `body_ref` (a file over the single-string ceiling, never held in the journal). */
export interface ManagedImportIntent extends Record<string, unknown> {
  kind: 'managed_file_import'; slug: string; content?: string; body_ref?: ManagedImportBodyRef; sourcePath: string; path?: string;
  inputPath: string; inputHash: string; targetHash: string | null;
  ownerEpoch: string; expected_revision?: string; noEmbed: boolean; activePack?: ImportPack;
}

const reimportFix = (inputPath: string, sourceId: string): Action => ({
  argv: ['gbrain', 'import', inputPath, '--source', sourceId], consent: [], actor: 'agent', requires_exclusive: false,
  why: `Re-reads the file as it is now and imports it into source ${sourceId} under a new request through its canonical owner.`,
});
/** A Markdown file over the single-string ceiling imports only from its place in the source root: the user moves it there, then imports it. */
const moveIntoSourceFix = (inputPath: string, target: string, sourceId: string): Action => ({
  argv: ['gbrain', 'import', target, '--source', sourceId], consent: [], actor: 'user', requires_exclusive: false,
  user_message: `Move ${inputPath} to ${target}, inside source ${sourceId}'s root, then run this command.`,
  why: `A file over the single-string import limit imports only from its place inside the source root, since its canonical file is never rewritten; this imports it from ${target}.`,
});
/** The refusal of a Markdown file over the single-string ceiling imported from outside its source root: the message itself names the move. */
function outsideRootTooLarge(inputPath: string, target: string, sourceId: string, bytes: number, suggestion: string, fix: Action = moveIntoSourceFix(inputPath, target, sourceId)): OperationError {
  return opError('invalid_params', `File too large (${bytes} bytes, max ${PAGE_MAX_BYTES}): a file over the single-string import limit imports only from its place inside the source root. Move it to ${target} and import it there.`,
    suggestion, { fix });
}
const receiptFix = (row: WriteRequest): Action => readFix('Reads the import request\'s durable receipt: its state and recorded error, read-only.',
  { argv: ['gbrain', 'write-request', '--', row.request_id] });
const ownerStatusFix = (sourceId: string): Action => readFix(`Shows source ${sourceId}'s canonical owner and its state, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });

export function readImportBytes(path: string): Buffer {
  if (realpathSync(path) !== resolve(path) || !lstatSync(path).isFile()) {
    throw opError('source_changed', 'Managed import refuses symlinked files or ancestors. Use the real source path.',
      `${path} is a symlink or sits under one, so it was not imported. Import the file at its real location (or copy it into the source) instead.`);
  }
  const maxBytes = isImageFilePath(path) ? MAX_IMAGE_BYTES : importSizeLimit(path);
  if (lstatSync(path).size > maxBytes) throw opError('invalid_params', `File too large (max ${maxBytes} bytes).`,
    `${basename(path)} is over the ${maxBytes}-byte import limit and was not imported. Files under the limit import normally; leave this one out of the import, or split it into files under the limit.`);
  return readFileSync(path);
}

/** #5988: the typed import refusal; the wire `error` stays `invalid_params` as before. */
function managedImportRefusal(refusal: ContentRefusal, sourcePath: string): OperationError {
  const suggestion = refusal.code === 'invalid_fence'
    ? `Edit ${fenceWhere(refusal.fence)} in ${sourcePath} as the message says (the rest of the page is fine), then import it again.`
    : refusal.code === 'frontmatter_slug_conflict'
    ? `In ${sourcePath}, remove the frontmatter slug or set it to the path-derived slug (the path decides the slug), or move the file to the path that matches its slug, then import again.`
    : refusal.code === 'file_too_large' ? `${sourcePath} is over the size limit the message names and was not imported. Every page under the limit imports and is searchable; leave this file out of the import, or split it into files under the limit.`
    : refusal.code === 'content_rejected' ? `Remove the matched junk from ${sourcePath}, then import it again.`
    : refusal.code === 'write_gate_rejected' ? `The write gate refuses ${sourcePath} (external instruction-like content under write_gate.external_mode=reject); tell the user, the decision is theirs.`
    : `Fix line ${refusal.line ?? '?'} of ${sourcePath}${refusal.key ? ` (key "${refusal.key}")` : ''}: one line per key with its whole value quoted. Run gbrain frontmatter validate on the file to see every problem, then import it again.`;
  return contentRefusalError(refusal, suggestion, { legacy_error: 'invalid_params' });
}

/** The source-relative path refusals every managed import makes before reading the file. */
function managedImportPathChecks(sourcePath: string): void {
  if (isAbsolute(sourcePath) || sourcePath.split(/[\\/]/).some(part => part === '..') || hasMalformedPathSegment(sourcePath)) {
    throw opError('invalid_params', 'The import path must be a well-formed source-relative path.',
      `${JSON.stringify(sourcePath)} is absolute, climbs out with "..", or has a malformed segment, so it was not imported. Rename the file or import it from inside the source root.`);
  }
  if (isReservedSkillBundlePath(sourcePath)) {
    throw opError('skill_bundle_required', 'Import cannot publish skill paths. Use the shared skill publisher.',
      `${sourcePath} is a reserved skill path, so import skipped it. Publish skills with put_skill (CLI: gbrain put-skill) and the catalog expected_revision; skill text imported as knowledge is never published as instructions.`);
  }
}

export function managedImportContent(sourcePath: string, bytes: Buffer, activePack?: ImportPack): { slug: string; content: string } {
  managedImportPathChecks(sourcePath);
  if (isImageFilePath(sourcePath)) return { slug: sourcePath.replaceAll('\\', '/').toLowerCase(), content: bytes.toString('base64') };
  let content = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (isCodeFilePath(sourcePath)) return { slug: slugifyCodePath(sourcePath), content };
  if (!/\.mdx?$/i.test(sourcePath)) throw opError('invalid_params', 'Managed import supports Markdown, code and supported image files.',
    `${sourcePath} is not a Markdown (.md, .mdx), code or supported image file, so it was not imported. Convert it to Markdown or leave it out.`);
  const screen = screenImportContent({ content, path: sourcePath, byteLength: bytes.length, expectedSlug: slugifyPath(sourcePath), fences: 'coordinated',
    slugConflictMessage: (found, expected) => `Frontmatter slug "${found}" does not match path-derived slug "${expected}".` });
  if (screen.status === 'refused') throw managedImportRefusal(screen.refusal, sourcePath);
  content = applyInference(sourcePath, content).content;
  const parsed = parseMarkdown(content, sourcePath, { ...(activePack ? { activePack } : {}) });
  const expected = slugifyPath(sourcePath);
  const slug = parsed.slug || expected;
  if (!slug) throw opError('invalid_params', 'The filename produces no usable slug; add a slug in frontmatter.',
    `Rename ${sourcePath} to a name with letters or digits, or add a slug: line to its frontmatter, then import again.`);
  return { slug, content };
}

/**
 * Wave B: the admission identity of a Markdown file over the single-string
 * ceiling (decision 4), or null when the file takes the ordinary path (within
 * the limit, not Markdown, or segmented storage off). The bytes are hashed as a
 * stream and only the frontmatter head is parsed for the slug; the preparer
 * re-derives both and refuses a mismatch. Such a file imports only from its own
 * place in the canonical root (`input === target`), since its canonical file is
 * never rewritten.
 */
export async function managedStreamedIdentity(sourcePath: string, input: string, target: string, policy: PageBodyPolicy, sourceId: string):
  Promise<{ slug: string; bodyRef: ManagedImportBodyRef } | null> {
  if (!policy.segmented || !/\.mdx?$/i.test(sourcePath)) return null;
  if (realpathSync(input) !== resolve(input) || !lstatSync(input).isFile()) return null;
  const bytes = lstatSync(input).size;
  if (bytes <= importSizeLimit(input) || bytes > policy.maxBytes) return null;
  managedImportPathChecks(sourcePath);
  if (target !== input) throw outsideRootTooLarge(input, target, sourceId, bytes,
    `${basename(input)} is over the single-string import limit, so it imports only from its place inside the source root (its canonical file is never rewritten). Move it into the source and import it there.`);
  const hash = createHash('sha256');
  for await (const part of createReadStream(input)) hash.update(part);
  const head = Buffer.alloc(Math.min(FRONTMATTER_HEAD_MAX_BYTES, bytes));
  const fd = openSync(input, 'r');
  try { readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
  const declared = parseMarkdownHead(head.toString('utf8').replace(/^\uFEFF/, '')).frontmatter.slug;
  const slug = typeof declared === 'string' && declared ? declared : slugifyPath(sourcePath);
  if (!slug) throw opError('invalid_params', 'The filename produces no usable slug; add a slug in frontmatter.',
    `Rename ${sourcePath} to a name with letters or digits, or add a slug: line to its frontmatter, then import again.`);
  return { slug, bodyRef: { kind: 'input_file', input_path: input, sha256: hash.digest('hex'), bytes } };
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
      const other = screeningPath(`source-root\0${candidate}`, () => existsSync(candidate) ? realpathSync(candidate) : resolve(candidate));
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

/**
 * `screen`: the no-op screen of an unadmitted request (import-mutations.ts), whose caller just checked the
 * paths and read the input bytes and page snapshot it passes. The preparer then skips its own first path check,
 * the input re-normalization and the snapshot re-read: `validate` re-runs every path and byte check last, and the
 * no-op kernel re-checks the page revision, so a skip still rests on all of them; anything else is admitted
 * and prepared again in full by its publication.
 */
export async function prepareManagedImportMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig,
  screen?: { snapshot: PageSnapshot | null }): Promise<PreparedMutation> {
  const p = row.intent as ManagedImportIntent | null;
  if (row.authority.remote || row.principal_kind !== 'local_cli') throw trustedCliRequired('Filesystem import requires a trusted local CLI writer.');
  const bodyRef = p?.body_ref;
  const refValid = !!bodyRef && bodyRef.kind === 'input_file' && bodyRef.input_path === p!.inputPath && typeof bodyRef.sha256 === 'string' && Number.isSafeInteger(bodyRef.bytes);
  if (!p || p.kind !== 'managed_file_import' || (typeof p.content === 'string' ? bodyRef !== undefined : !refValid) || typeof p.inputPath !== 'string' || typeof p.sourcePath !== 'string') {
    throw opError('invalid_params', 'The durable file import intent is incomplete.',
      `Import request ${row.request_id} in source ${row.source_id} has no complete file intent, so it published nothing. Read its receipt, then import the file again with gbrain import --source ${row.source_id}.`,
      { fix: receiptFix(row) });
  }
  const binding = await getWorktreeBinding(engine, row.source_id);
  if (!row.worktree_id || !binding?.local_path || String(binding.owner_epoch) !== p.ownerEpoch) throw opError('owner_unavailable', 'Managed file import requires its accepted canonical owner.',
    `Source ${row.source_id}'s canonical owner changed or went away after import request ${row.request_id} was accepted, so it published nothing. Check the owner, then import ${p.sourcePath} again on the host that owns the source.`,
    { fix: ownerStatusFix(row.source_id) });
  const root = join(binding.local_path, binding.relative_path);
  const readOnlyImage = row.authority.databaseOnlyReason === 'disabled_by_config' && isCanonicalImageRead(p as unknown as Record<string, unknown>, root);
  if (row.authority.databaseOnlyReason === 'disabled_by_config' && !readOnlyImage) throw opError('invalid_params',
    'With disk write-back disabled, image import must read its existing canonical file.',
    'Place the image in its accepted source root and import that exact path; the importer will not copy or rewrite files while disk write-back is disabled.');
  const physicalPath = p.path ?? p.sourcePath;
  if (isAbsolute(physicalPath) || physicalPath.split(/[\\/]/).some(part => part === '..') || /(^|[\\/])skills([\\/]|$)/i.test(physicalPath)) {
    throw opError('invalid_params', 'The canonical import path must be source-relative knowledge, not a skill path.',
      `Import request ${row.request_id} targets ${JSON.stringify(physicalPath)} in source ${row.source_id}, which is absolute, climbs out with "..", or is a skill path; it published nothing. Import knowledge files from inside the source root and publish skills with put_skill.`,
      { fix: receiptFix(row) });
  }
  const path = resolve(root, physicalPath);
  const checkPlacement = async (tx: BrainEngine) => {
    const current = await getWorktreeBinding(tx, row.source_id);
    if (!current || current.worktree_id !== row.worktree_id || String(current.owner_epoch) !== p.ownerEpoch) throw opError('owner_unavailable', 'The import owner changed.',
      `Source ${row.source_id}'s canonical owner changed while import request ${row.request_id} was prepared, so it published nothing. Check the owner, then import ${p.sourcePath} again on the host that owns the source.`,
      { fix: ownerStatusFix(row.source_id) });
    await assertImportPaths(tx, row.source_id, root, p.inputPath, path);
    await assertKnowledgePublicationAllowed(tx, row, { root, path });
  };
  if (bodyRef) return prepareStreamedManagedImport(engine, row, { ...p, body_ref: bodyRef }, path, checkPlacement, screen);
  const content = p.content!;
  const checkPaths = async (tx: BrainEngine) => {
    await checkPlacement(tx);
    if (sha256(readImportBytes(p.inputPath)) !== p.inputHash) throw opError('source_changed', 'The input file changed after import admission.',
      `${p.sourcePath} was edited after import request ${row.request_id} was accepted, so the request published nothing. Import it again to publish the current bytes.`,
      { fix: reimportFix(p.inputPath, row.source_id) });
    if ((existsSync(path) ? sha256(readImportBytes(path)) : null) !== p.targetHash) throw opError('source_changed', 'The canonical file changed after import admission.',
      `The canonical copy of ${p.sourcePath} in source ${row.source_id} changed after import request ${row.request_id} was accepted, so it was not overwritten. Review that file, then import again if the import should still replace it.`,
      { fix: reimportFix(p.inputPath, row.source_id) });
  };
  if (!screen) await checkPaths(engine);
  const normalized = screen ? { slug: row.slug, content } : managedImportContent(p.sourcePath, readImportBytes(p.inputPath), p.activePack);
  if (normalized.slug !== row.slug || normalized.content !== content) throw opError('source_changed', 'The frozen file identity no longer matches the import.',
    `${p.sourcePath} now normalizes to different content or slug than import request ${row.request_id} accepted for ${row.slug}, so it published nothing. Import it again to publish the current file.`,
    { fix: reimportFix(p.inputPath, row.source_id) });
  const source = { sourceId: row.source_id };
  const snapshot = await materializedSnapshot(engine, screen ? screen.snapshot : await engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true }));
  assertImportBaseSnapshot(row, p, snapshot);
  let prepared: (Omit<PreparedContentImport, 'parsedPage'> & { parsedPage?: PreparedContentImport['parsedPage'] }) | undefined;
  const prepare = async (value: NonNullable<typeof prepared>) => { prepared = value; return value.result; };
  const code = isCodeFilePath(p.sourcePath);
  const image = isImageFilePath(p.sourcePath);
  const imageBytes = image ? Buffer.from(content, 'base64') : undefined;
  const result = image
    ? await importImageFile(engine, p.inputPath, p.sourcePath, { ...source, noEmbed: p.noEmbed, bytes: imageBytes, prepare })
    : code
    ? await importCodeFile(engine, p.sourcePath, content, { ...source, noEmbed: true, prepare })
    : await importFromContent(engine, row.slug, content, { ...source, noEmbed: true, remote: false, preserveGateMarkers: true, prepare, fences: 'coordinated', boundedChunkWrites: true, writeGate: await ownerGateInput(engine, row, parseMarkdown(content, row.slug).frontmatter, p.sourcePath),
      coordinated: true, existingSnapshot: snapshot, activePack: p.activePack, sourcePath: p.sourcePath, filename: basename(p.sourcePath, '.md'), allowEmptyOverwrite: true,
      segmentedOwner: { kind: 'import', principalKind: row.principal_kind, principalId: row.principal_id, baseRevision: snapshot?.revision ?? null } });
  if (!prepared && result.refusal?.code === 'invalid_fence') throw managedImportRefusal(result.refusal, p.sourcePath);
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
  const rendered = imageBytes ?? (code ? content : serializePageToMarkdown({
    ...(snapshot ? withoutBody(snapshot.page) : { id: 0, slug: row.slug, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }), ...ready.parsedPage,
  } as Page, tags));
  const project = code || image ? undefined : await prepareCanonicalProjections(engine, ready.parsedPage!, row.slug, row.source_id, snapshot, 'file');
  const mutation: PreparedMutation = { observedRevision: ready.observedRevision, noop: ready.noop && p.targetHash === sha256(rendered),
    trust: await ownerImportTrust(engine, row, ready.parsedPage?.frontmatter, p.sourcePath), deferEmbedding: image || p.noEmbed, validate: async tx => { await checkPaths(tx); await ready.validate(tx); },
    ...(ready.afterCommit ? { afterCommit: ready.afterCommit } : {}),
    ...(readOnlyImage ? {} : { file: { root, path, content: rendered, expectedBeforeHash: p.targetHash } }),
    apply: async tx => {
      const applied = await ready.apply(tx);
      await bindOrigin(tx, { sourceId: row.source_id, slug: row.slug, sourcePath: p.sourcePath });
      if (project) {
        // The coordinator proved the base revision under its page guard (importFromContent `coordinated`); this is the
        // one read of the page after its last page write (the projections and the seal leave its revision unchanged):
        // read-back check, projection target, seal input and the receipt's postimage.
        const final = await tx.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
        const live = final && final.page.deleted_at == null ? final : null;
        if (!ready.noop) {
          await verifyPageReadable(tx, row.slug, ready.contentHash!, row.source_id, 'importFromContent', live?.page ?? null);
          await project(tx, final?.page.id);
          if (applied?.segmented) { if (applied.segmented.complete && live) await sealSegmentedPage(tx, Number(live.page.id)); }
          else if (applied?.chunkerSeal !== undefined) await sealImportedPage(tx, row.slug, row.source_id, live, applied.chunkerSeal, applied.pageId);
          else if (live && !applied?.projectionPending) await sealPageTextProjection(tx, row.slug, row.source_id, live);
        }
        mutation.postimage = final;
      } else if (!ready.noop && !image && !applied?.projectionPending) await sealPageTextProjection(tx, row.slug, row.source_id);
      // #6188: the canonical file is written from the normalized page; the outcome reports what Tier 1 rewrote.
      return { ...result, parsedPage: undefined, imported_file: true, source_id: row.source_id,
        ...(ready.noop ? {} : segmentedOutcome(applied?.segmented, isQuarantined(ready.parsedPage?.frontmatter ?? {}))), fences_normalized: result.fences_normalized?.length
        ? pageFencesNormalized({ sourceId: row.source_id, slug: row.slug, fixes: result.fences_normalized, writer: row.principal_kind, path: p.sourcePath, remote: false }) : undefined };
    } };
  return mutation;
}

/** The admitted page is still the import's base: its revision, its id and the file it maps to. */
function assertImportBaseSnapshot(row: WriteRequest, p: ManagedImportIntent, snapshot: PageSnapshot | null): void {
  assertPageRevision(snapshot, { expectedRevision: p.expected_revision ?? null }); // null: admitted against an absent page; still a revision_conflict if one appeared (#5385)
  if ((snapshot?.page.id ?? null) !== row.page_id || snapshot?.page.source_path && snapshot.page.source_path !== p.sourcePath) {
    throw opError('page_identity_changed', 'The imported path no longer names the accepted page.',
      `Page ${row.slug} in source ${row.source_id} was replaced, removed, or now maps to a different file than ${p.sourcePath}, so import request ${row.request_id} published nothing. Read the page before importing the file again.`,
      { fix: readFix(`Shows which page holds ${row.slug} in source ${row.source_id} now, with its source path and revision.`,
        { argv: ['gbrain', 'get', '--source', row.source_id, '--', row.slug] }) });
  }
}

/**
 * Wave B: a Markdown file over the single-string ceiling, admitted by reference
 * (`body_ref`). It is imported only from its own place in the canonical root,
 * since the canonical file is never rewritten; the preparer streams it through
 * the segmented import, which verifies the admitted sha256 on its first pass,
 * and the publication is database-only. With the switch off by now, or the
 * file over this brain's ceiling, it refuses as before admission would have.
 */
async function prepareStreamedManagedImport(engine: BrainEngine, row: WriteRequest, p: ManagedImportIntent & { body_ref: ManagedImportBodyRef }, path: string,
  checkPlacement: (tx: BrainEngine) => Promise<void>, screen?: { snapshot: PageSnapshot | null }): Promise<PreparedMutation> {
  const ref = p.body_ref;
  const tooLarge = (why: string) => opError('invalid_params', `File too large (max ${PAGE_MAX_BYTES} bytes).`,
    `${p.sourcePath} is ${ref.bytes} bytes, over the single-string import limit, and ${why}, so import request ${row.request_id} published nothing.`,
    { fix: receiptFix(row) });
  if (resolve(p.inputPath) !== path) throw outsideRootTooLarge(p.inputPath, path, row.source_id, ref.bytes,
    `${p.sourcePath} is over the single-string import limit, and a file this size is imported only from its place inside source ${row.source_id}'s root (its canonical file is never rewritten), so import request ${row.request_id} published nothing. Move it into the source and import it there.`);
  const policy = await readPageBodyPolicy(engine);
  if (!policy.segmented || ref.bytes > policy.maxBytes) throw tooLarge(`segmented page storage (pages.segmented_storage) is off or the file is over pages.max_bytes`);
  await checkPlacement(engine);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size !== ref.bytes) throw opError('source_changed', 'The input file changed after import admission.',
    `${p.sourcePath} was edited after import request ${row.request_id} was accepted, so the request published nothing. Import it again to publish the current bytes.`,
    { fix: reimportFix(p.inputPath, row.source_id) });
  const snapshot = screen ? screen.snapshot : await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  assertImportBaseSnapshot(row, p, snapshot);
  let ready: StreamedPreparedImport | undefined;
  const result = await importStreamedMarkdownFile(engine, path, p.sourcePath, { sourceId: row.source_id, noEmbed: true, ...(p.activePack ? { activePack: p.activePack } : {}),
    coordinated: { snapshot, sha256: ref.sha256, prepare: async value => { ready = value; return value.result; },
      owner: { kind: 'import', principalKind: row.principal_kind, principalId: row.principal_id, baseRevision: snapshot?.revision ?? null } } }, stat, policy);
  if (!ready) throw opError('invalid_params', result.error ?? 'The file could not be prepared.',
    `${p.sourcePath} was rejected while preparing import request ${row.request_id} for source ${row.source_id}; nothing was published. Fix the file content or frontmatter named in the message, then import it again.`,
    { fix: reimportFix(p.inputPath, row.source_id) });
  const prepared: StreamedPreparedImport = ready;
  if (prepared.slug !== row.slug || prepared.observedRevision !== (snapshot?.revision ?? null)) throw opError('revision_conflict', 'The import identity changed during preparation.',
    `Page ${row.slug} in source ${row.source_id} changed while import request ${row.request_id} was prepared, so it published nothing. Import ${p.sourcePath} again against the current page.`,
    { fix: reimportFix(p.inputPath, row.source_id) });
  const mutation: PreparedMutation = { observedRevision: prepared.observedRevision, noop: prepared.noop,
    trust: await ownerImportTrust(engine, row, prepared.frontmatter, p.sourcePath), deferEmbedding: p.noEmbed,
    validate: async tx => { await checkPlacement(tx); await prepared.validate(tx); },
    ...(prepared.afterCommit ? { afterCommit: prepared.afterCommit } : {}),
    apply: async tx => {
      const applied = await prepared.apply(tx);
      mutation.postimage = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
      return { ...result, imported_file: true, source_id: row.source_id, ...segmentedOutcome(applied?.segmented, isQuarantined(prepared.frontmatter)) };
    } };
  return mutation;
}
