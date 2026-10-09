/**
 * #5988 `managed_file_repair`: the owner-internal intent `gbrain repair
 * frontmatter --apply` publishes on a managed brain. One coordinated write
 * replaces a canonical file with the exact bytes the operator approved and
 * imports them through the same screen, preparation and canonical projections
 * a managed sync import uses, in the same publication: a held new file gets
 * its page, a held modified file updates its page, a held renamed file moves
 * its page (same id) through `renameFrom`, and the path's hold clears in the
 * publishing transaction. Every file write queues the Git target effect a
 * page write queues.
 *
 * Bindings: the file write is conditional on the sha256 the preview read
 * (`beforeHash`; anything else is `changed_since_preview` and nothing is
 * written), the import on the page revision the preview read, and the whole
 * publication on the canonical result digest the preview showed (file bytes
 * plus resulting page fields). The `file_database_drift` guard ordinary
 * `put_page` applies does not run here: this intent replaces divergent bytes
 * only under that hash binding. A repaired file whose import would need a
 * canonical overlay (retained tags, a withdrawal, sanitization) is refused,
 * never written with the overlay bypassed.
 *
 * A fence repair (`gbrain repair fences`) carries its `FenceRepairReceipt` in
 * the intent (`fenceRepair`): the preparer refuses a malformed receipt or one
 * whose before/after sha256 are not the previewed and the written bytes, the
 * receipt rides the publication outcome as `fence_repair`, the file's Git
 * commit takes `fenceRepairCommitSubject`, and every refusal routes to
 * `gbrain repair fences` instead of `gbrain repair frontmatter`.
 *
 * Trusted local CLI only: admission refuses remote and delegated callers, the
 * `put_page` reserved-field gate refuses the kind from MCP, and the preparer
 * refuses any request whose authority is remote. Every path is confined to
 * the source root and walked component by component with `lstat`, so a
 * symlinked directory or file is never written through.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { ParsedPage } from '../import-file.ts';
import { importFromContent } from '../import-file.ts';
import { ContentSanityBlockError } from '../content-sanity.ts';
import { loadImportSanityConfig, type ContentRefusal, type ImportSanityConfig } from '../import-screen.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { parseMarkdown, resolveParsedSubtype, type ParseOpts } from '../markdown.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { assertPageRevision, type PageSnapshot } from '../page-state/types.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { VERSION } from '../../version.ts';
import { parseFenceRepairReceipt, type FenceRepairReceipt } from '../fence-repair/receipt.ts';
import { prepareCanonicalProjections } from './canonical-projections.ts';
import { digest, sha256 } from './digest.ts';
import { currentVerifiedLocalWriter, localHostId } from './identity.ts';
import { getWorktreeBinding } from './ownership.ts';
import { checkOwner, ownerUnavailableError } from './owner-refusal.ts';
import { loadRepairBusySet, repairBusy, repairBusyError } from './repair-busy.ts';
import { submitPageMutation } from './page-mutations.ts';
import { clearGitHold, recordSyncImportProvenance } from './sync-holds.ts';
import { screenSyncImport } from './sync-prepare.ts';
import type { SyncRename } from './sync-discovery.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import { fenceRepairCommit } from './effect-model.ts';
import type { WriteRequest } from './model.ts';

export interface ManagedFileRepairIntent extends Record<string, unknown> {
  kind: 'managed_file_repair';
  slug: string;
  /** Source-root-relative file path (the hold key). */
  path: string;
  /** The page origin the file maps to. */
  sourcePath: string;
  /** The exact repaired file, written byte for byte (UTF-8). */
  content: string;
  /** sha256 of the file bytes the preview read. */
  beforeHash: string;
  /** Digest of the canonical page result the preview showed. */
  resultDigest: string;
  ownerEpoch: string;
  expected_revision?: string;
  /** A held renamed file: the page it moves, bound to the revision the preview read. */
  renameFrom?: SyncRename;
  noEmbed: boolean;
  /** A fence repair's receipt (location and hashes only). */
  fenceRepair?: FenceRepairReceipt;
}

/** The repair command a refusal names (D6 router): a fence repair's, or the frontmatter repair's. */
export type FileRepairKind = 'frontmatter' | 'fences';

const ownerStatusFix = (sourceId: string): Action => readFix(`Shows source ${sourceId}'s canonical owner and its state, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
const previewFix = (sourceId: string, kind: FileRepairKind): Action => ({ argv: ['gbrain', 'repair', kind, '--source', sourceId], consent: [], actor: 'agent',
  requires_exclusive: false, why: `Previews the ${kind === 'fences' ? 'fence' : 'frontmatter'} repair of source ${sourceId} again from the files as they are now; nothing is written.` });

function changedSincePreview(sourceId: string, path: string, why: string, kind: FileRepairKind) {
  return opError('changed_since_preview', `${path} changed since its repair was previewed: ${why}.`,
    `Nothing was written for ${path}. Preview again with gbrain repair ${kind} --source ${sourceId}, review the new proposal, and approve its new hash.`,
    { fix: previewFix(sourceId, kind) });
}

/**
 * The well-formed fence repair receipt of a repair request, or undefined for
 * a frontmatter repair. Refuses (`invalid_params`, nothing written) a
 * malformed receipt or one whose hashes are not the previewed bytes
 * (`beforeHash`) and the bytes it writes (`content`).
 */
function checkedFenceRepair(input: { fenceRepair?: unknown; beforeHash: string; content: string; path: string }, sourceId: string): FenceRepairReceipt | undefined {
  if (input.fenceRepair === undefined) return undefined;
  const refuse = (why: string): never => { throw opError('invalid_params', `The fence repair receipt for ${input.path} ${why}, so nothing was written.`,
    `gbrain repair fences builds this receipt from the bytes it previewed and writes; this one does not describe them. Preview again with gbrain repair fences --source ${sourceId} and apply its new plan; if the apply refuses the same way, tell the user and include gbrain doctor --json.`,
    { fix: previewFix(sourceId, 'fences') }); };
  const receipt = parseFenceRepairReceipt(input.fenceRepair);
  if (!receipt) return refuse('is malformed');
  if (receipt.before_sha256 !== input.beforeHash) return refuse('does not name the previewed file bytes');
  if (receipt.after_sha256 !== sha256(Buffer.from(input.content, 'utf8'))) return refuse('does not name the repaired file bytes');
  return receipt;
}

/**
 * The absolute target of a source-relative repair path. Refuses an absolute
 * or climbing path, a target outside the root, and any symlink on the way
 * (each component below the root is `lstat`ed); the target must be a file.
 */
export function confinedRepairTarget(root: string, path: string, sourceId: string, kind: FileRepairKind = 'frontmatter'): string {
  const refuse = (why: string): never => { throw opError('source_changed', `The repair target ${JSON.stringify(path)} ${why}, so nothing was written.`,
    `gbrain repair ${kind} writes only regular files inside source ${sourceId}'s root, never through a symlink. Replace the link with the real file (or leave it out), then preview again.`,
    { fix: ownerStatusFix(sourceId) }); };
  if (!path || path.includes('\0') || isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..' || part === '')) refuse('is not a confined source-relative path');
  const target = resolve(root, path);
  if (!isWriteTargetContained(target, root)) refuse('resolves outside the source root');
  let current = resolve(root);
  for (const part of path.split(/[\\/]/)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch { return refuse('does not exist'); }
    if (stat.isSymbolicLink()) refuse(`is or sits under a symlink (${current.slice(resolve(root).length + 1).split(sep).join('/')})`);
  }
  if (!lstatSync(target).isFile()) refuse('is not a regular file');
  return target;
}

/** sha256 of the file as it is now (hex). */
export function fileSha256(path: string): string {
  return sha256(readFileSync(path));
}

/** The canonical page fields a publication stores; what the preview hash binds besides the bytes. */
export function canonicalRepairFields(page: Pick<ParsedPage, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>, tags: string[]) {
  return { type: page.type, title: page.title, body: page.compiled_truth, timeline: page.timeline ?? '', frontmatter: page.frontmatter, tags: [...new Set(tags)].sort() };
}

export interface RepairPublicationInput {
  sourceId: string; slug: string; sourcePath: string; path: string; root: string;
  /** The repaired file as written (a BOM, if any, is stripped for the import as sync strips it). */
  content: string;
  snapshot: PageSnapshot | null;
  /** The page the import is prepared against: the rename source for a renamed file, else `snapshot`. */
  base: PageSnapshot | null;
  activePack?: ParseOpts['activePack'];
  sanity?: ImportSanityConfig;
}

export type RepairPublication =
  | { status: 'refused'; refusal: ContentRefusal }
  /** Importing these bytes would store something other than the file says (retained tags, a withdrawal, sanitization). */
  | { status: 'overlay' }
  | { status: 'ready'; ready: PreparedContentImport; digest: string; fields: ReturnType<typeof canonicalRepairFields>; renamedType?: string };

/**
 * What publishing `content` would store, computed exactly as a managed sync
 * import prepares it, without writing anything. Shared by the preview (whose
 * hash binds `digest`) and the preparer (which refuses a different result).
 */
export async function prepareRepairPublication(engine: BrainEngine, input: RepairPublicationInput): Promise<RepairPublication> {
  const content = input.content.replace(/^\uFEFF/, '');
  const renamed = !!input.base && input.base.page.slug !== input.slug;
  const { screen, parsedInput } = screenSyncImport({ content, rawHash: sha256(content), lineEndingOnly: false, slug: input.slug, sourcePath: input.sourcePath,
    path: input.path, root: input.root, snapshot: input.snapshot, base: input.base, renamed, activePack: input.activePack, ...(input.sanity ? { sanity: input.sanity } : {}) });
  if (screen.status === 'refused') return { status: 'refused', refusal: screen.refusal };
  let prepared: PreparedContentImport | undefined;
  let result;
  try {
    result = await importFromContent(engine, renamed ? input.base!.page.slug : input.slug, content, { sourceId: input.sourceId, noEmbed: true, remote: false, preserveGateMarkers: true,
      activePack: input.activePack, filename: basename(input.sourcePath).replace(/\.mdx?$/i, ''), sourcePath: input.sourcePath, allowEmptyOverwrite: true,
      prepare: async value => { prepared = value; return value.result; } });
  } catch (error) {
    if (error instanceof ContentSanityBlockError) return { status: 'refused', refusal: { code: 'content_rejected', message: error.message } };
    throw error;
  }
  if (!prepared) return { status: 'refused', refusal: result.refusal ?? { code: 'invalid_frontmatter', reason: 'yaml_parse', message: result.error ?? 'The file could not be prepared.' } };
  const parsed = parseMarkdown(content, `${input.slug}.md`, { activePack: input.activePack });
  resolveParsedSubtype(parsed, input.base?.page);
  const renamedType = renamed && parsedInput.typeExplicit !== true ? parsedInput.type : undefined;
  const tags = [...new Set([...(input.base?.tags ?? []), ...prepared.parsedPage.tags])].sort();
  const fields = canonicalRepairFields({ ...prepared.parsedPage, type: renamedType ?? prepared.parsedPage.type }, tags);
  if (digest(canonicalRepairFields(parsed, parsed.tags)) !== digest(fields)) return { status: 'overlay' };
  return { status: 'ready', ready: prepared, digest: digest(fields), fields, ...(renamedType ? { renamedType } : {}) };
}

/** The schema pack and content-sanity settings a repair preview and its publication both read, so their results agree. */
export async function repairScreenConfig(engine: BrainEngine, sourceId: string): Promise<Pick<RepairPublicationInput, 'activePack' | 'sanity'>> {
  const activePack = (await loadActivePackForEngine(engine, { remote: false, sourceId }).catch(() => null))?.manifest;
  return { ...(activePack ? { activePack } : {}), sanity: await loadImportSanityConfig(engine) };
}

function assertTrustedRepairCaller(ctx: Pick<OperationContext, 'remote'>): void {
  const caller = currentSubmissionAuthority();
  if (ctx.remote !== false || (caller && caller.kind !== 'application') || currentVerifiedLocalWriter()?.remote) {
    throw trustedCliRequired('A managed file repair requires the trusted local CLI.');
  }
}

/**
 * The active local owner's canonical root of a source, or an `owner_unavailable` refusal whose reason names the
 * condition (owner-refusal.ts). `remote` (default true) keeps the local identity path out of the text.
 */
export async function managedRepairRoot(engine: BrainEngine, sourceId: string, kind: FileRepairKind = 'frontmatter', opts: { remote?: boolean } = {}): Promise<{ root: string; ownerEpoch: string; incarnation: string }> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const binding = await getWorktreeBinding(engine, sourceId);
  const hostId = localHostId();
  const owner = checkOwner(binding, source?.incarnation ?? '', hostId);
  if (owner.reason) throw ownerUnavailableError({ sourceId, reason: owner.reason, binding, incarnation: source?.incarnation ?? '', hostId, remote: opts.remote !== false, work: `the ${kind} repair` });
  return { root: join(owner.binding.local_path, owner.binding.relative_path), ownerEpoch: String(owner.binding.owner_epoch), incarnation: owner.binding.source_incarnation };
}

/**
 * Admits and waits for one `managed_file_repair` write. Refuses before
 * admission when the caller is not the trusted local CLI, the path is not a
 * confined regular file, the file no longer has the previewed bytes, or a
 * write in flight or an unfinished sync's frozen manifest names the path or
 * page (`sync_in_progress`, #6278: the plan's busy check is repeated here
 * because a sync can start while a repair waits on its model call).
 */
export interface ManagedFileRepairInput {
  sourceId: string; requestId: string; slug: string; path: string; sourcePath: string; content: string;
  beforeHash: string; resultDigest: string; expected_revision?: string; renameFrom?: SyncRename; noEmbed: boolean;
  /** Set by `gbrain repair fences`: the write's receipt, and its refusals route there. */
  fenceRepair?: FenceRepairReceipt;
}

export async function submitManagedFileRepair(ctx: OperationContext, input: ManagedFileRepairInput): Promise<Record<string, unknown>> {
  assertTrustedRepairCaller(ctx);
  const kind: FileRepairKind = input.fenceRepair !== undefined ? 'fences' : 'frontmatter';
  checkedFenceRepair(input, input.sourceId);
  const { root, ownerEpoch, incarnation } = await managedRepairRoot(ctx.engine, input.sourceId, kind, { remote: false });
  const target = confinedRepairTarget(root, input.path, input.sourceId, kind);
  if (fileSha256(target) !== input.beforeHash) throw changedSincePreview(input.sourceId, input.path, 'the file bytes differ from the previewed hash', kind);
  const busy = await loadRepairBusySet(ctx.engine, input.sourceId, incarnation);
  if (repairBusy(busy, { path: input.path, sourcePath: input.sourcePath, slug: input.slug }) || (input.renameFrom && repairBusy(busy, { sourcePath: input.renameFrom.sourcePath, slug: input.renameFrom.slug }))) {
    throw repairBusyError(busy, input.sourceId, input.path);
  }
  const { sourceId, requestId, expected_revision, ...rest } = input;
  const params: Record<string, unknown> = { ...rest, kind: 'managed_file_repair', ownerEpoch, source_id: sourceId, request_id: requestId,
    ...(expected_revision ? { expected_revision } : {}) };
  return submitPageMutation({ ...ctx, sourceId }, { operation: 'put_page', params, waitMs: 30_000, managedFileImport: true });
}

export async function prepareManagedFileRepairMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent as ManagedFileRepairIntent | null;
  const kind: FileRepairKind = p?.fenceRepair !== undefined ? 'fences' : 'frontmatter';
  if (row.authority.remote || row.principal_kind !== 'local_cli') throw trustedCliRequired('A managed file repair requires a trusted local CLI writer.');
  if (!p || p.kind !== 'managed_file_repair' || typeof p.content !== 'string' || typeof p.path !== 'string' || typeof p.sourcePath !== 'string'
    || typeof p.beforeHash !== 'string' || typeof p.resultDigest !== 'string') {
    throw opError('invalid_params', 'The durable file repair intent is incomplete.',
      `Repair request ${row.request_id} in source ${row.source_id} has no complete intent, so it published nothing. Preview the repair again: gbrain repair ${kind} --source ${row.source_id}.`,
      { fix: previewFix(row.source_id, kind) });
  }
  const fenceRepair = checkedFenceRepair(p, row.source_id);
  const binding = await getWorktreeBinding(engine, row.source_id);
  if (!row.worktree_id || !binding?.local_path || String(binding.owner_epoch) !== p.ownerEpoch) throw opError('owner_unavailable', 'A managed file repair requires its accepted canonical owner.',
    `Source ${row.source_id}'s canonical owner changed or went away after repair request ${row.request_id} was accepted, so it published nothing. Check the owner, then preview the repair again on the host that owns the source.`,
    { fix: ownerStatusFix(row.source_id) });
  const root = join(binding.local_path, binding.relative_path);
  const bytes = Buffer.from(p.content, 'utf8');
  const fileChanges = sha256(bytes) !== p.beforeHash;
  const checkFile = () => {
    const target = confinedRepairTarget(root, p.path, row.source_id, kind);
    if (fileSha256(target) !== p.beforeHash) throw changedSincePreview(row.source_id, p.path, 'the file bytes differ from the previewed hash', kind);
    return target;
  };
  const target = checkFile();
  const source = { sourceId: row.source_id };
  const snapshot = await engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
  assertPageRevision(snapshot, p.expected_revision ? { expectedRevision: p.expected_revision } : {});
  if ((snapshot?.page.id ?? null) !== row.page_id || (snapshot?.page.source_path != null && snapshot.page.source_path !== p.sourcePath)) {
    throw opError('page_identity_changed', 'The repaired path no longer names the previewed page.',
      `Page ${row.slug} in source ${row.source_id} was replaced, removed, or now maps to a different file than ${p.sourcePath}, so repair request ${row.request_id} published nothing. Preview the repair again.`,
      { fix: previewFix(row.source_id, kind) });
  }
  const moved = p.renameFrom && p.renameFrom.slug !== row.slug ? p.renameFrom : undefined;
  const assertRenameSource = async (tx: BrainEngine) => {
    if (!moved) return null;
    const previous = await tx.readPageSnapshot(moved.slug, { ...source, includeDeleted: true });
    if (previous?.page.id !== moved.pageId || previous.revision !== moved.revision || previous.page.deleted_at != null) {
      throw changedSincePreview(row.source_id, p.path, `page ${moved.slug}, which it was renamed from, changed or was deleted`, kind);
    }
    return previous;
  };
  const base = moved ? await assertRenameSource(engine) : snapshot;
  const screenConfig = await repairScreenConfig(engine, row.source_id);
  const publication = await prepareRepairPublication(engine, { sourceId: row.source_id, slug: row.slug, sourcePath: p.sourcePath, path: p.path, root,
    content: p.content, snapshot, base, ...screenConfig });
  if (publication.status === 'refused') throw changedSincePreview(row.source_id, p.path, `the repaired content now refuses to import (${publication.refusal.code})`, kind);
  if (publication.status === 'overlay') throw changedSincePreview(row.source_id, p.path, 'importing it would now store a canonical overlay instead of the file as written', kind);
  if (publication.digest !== p.resultDigest) throw changedSincePreview(row.source_id, p.path, 'the page it would publish differs from the previewed result', kind);
  const ready = publication.ready;
  const project = await prepareCanonicalProjections(engine, ready.parsedPage, row.slug, row.source_id, base, 'file');
  const importContent = p.content.replace(/^\uFEFF/, '');
  const importOptions = { ...source, noEmbed: true, remote: false, preserveGateMarkers: true, activePack: screenConfig.activePack, filename: basename(p.sourcePath).replace(/\.mdx?$/i, ''), sourcePath: p.sourcePath, allowEmptyOverwrite: true };
  return { observedRevision: snapshot?.revision ?? null, noop: ready.noop && !fileChanges && !moved, contentUnchanged: ready.noop && !fileChanges && !moved,
    deferEmbedding: p.noEmbed, ...(moved ? { additionalPageKeys: [{ sourceId: row.source_id, slug: moved.slug }] } : {}),
    ...(fileChanges ? { file: { root, path: target, content: bytes, expectedBeforeHash: p.beforeHash, ...(fenceRepair ? { commit: fenceRepairCommit(p.path, fenceRepair.classes) } : {}) } } : {}),
    validate: async tx => {
      const current = await getWorktreeBinding(tx, row.source_id);
      if (!current || current.worktree_id !== row.worktree_id || String(current.owner_epoch) !== p.ownerEpoch) throw opError('owner_unavailable', 'The repair owner changed.',
        `Source ${row.source_id}'s canonical owner changed while repair request ${row.request_id} was prepared, so it published nothing. Check the owner, then preview the repair again.`,
        { fix: ownerStatusFix(row.source_id) });
      checkFile();
      await assertRenameSource(tx);
      await ready.validate(tx);
    },
    apply: async tx => {
      let applied = ready;
      if (moved) {
        if (await tx.updateSlug(moved.slug, row.slug, source) !== 1) throw changedSincePreview(row.source_id, p.path, `page ${moved.slug} could not move to ${row.slug}`, kind);
        if (publication.renamedType) await tx.executeRaw('UPDATE pages SET type=$3 WHERE source_id=$1 AND slug=$2', [row.source_id, row.slug, publication.renamedType]);
        let movedImport: PreparedContentImport | undefined;
        await importFromContent(tx, row.slug, importContent, { ...importOptions, prepare: async value => { movedImport = value; return value.result; } });
        if (!movedImport || movedImport.slug !== row.slug) throw changedSincePreview(row.source_id, p.path, `page ${moved.slug} could not be prepared at ${row.slug}`, kind);
        await movedImport.validate(tx);
        applied = movedImport;
      }
      await applied.apply(tx);
      await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2 AND source_path IS DISTINCT FROM $3', [row.source_id, row.slug, p.sourcePath]);
      if (!applied.noop) { await project(tx); await sealPageTextProjection(tx, row.slug, row.source_id); }
      const holdCleared = await clearGitHold(tx, { sourceId: row.source_id, incarnation: row.source_incarnation, path: p.path, observedAt: new Date().toISOString() });
      const [page] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [row.source_id, row.slug]);
      if (page) await recordSyncImportProvenance(tx, { source_id: row.source_id, incarnation: row.source_incarnation, page_id: Number(page.id), origin: p.sourcePath,
        raw_sha256: sha256(importContent), gbrain_version: VERSION });
      return { status: moved ? 'renamed' : applied.noop ? 'skipped' : snapshot ? 'updated' : 'created', slug: row.slug, source_id: row.source_id,
        chunks: applied.result.chunks, imported_file: true, file_repaired: fileChanges, hold_cleared: holdCleared, ...(moved ? { renamed_from: moved.slug } : {}),
        ...(fenceRepair ? { fence_repair: fenceRepair } : {}) };
    } };
}
