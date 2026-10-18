/**
 * `gbrain repair ghost-pages --source <id>` (#6696 B5): soft-delete live pages
 * whose canonical file is gone (a ghost: `liveFileDrift` reason
 * `canonical_file_missing` on the owner host, `src/core/ghost-pages.ts`).
 *
 * Explicit-only, preview-bound and destructive: the preview lists every ghost
 * with its recorded canonical path and revision, binds the set to the
 * canonical owner it ran under (host, worktree, owner epoch, source
 * incarnation) and saves it under its hash; `--apply --expect <hash> --yes`
 * (the user's consent, else exit 3 / `ask_user` with nothing changed)
 * soft-deletes exactly that set. Each page is a `delete_page` with
 * `allowMissingFile`: a managed brain submits one
 * `managed_maintenance_retire_ghost_page` request per page bound to its
 * revision, and the preparer re-runs the classifier and refuses when the file
 * exists again; filesystem publication refuses a file that appeared after
 * preparation (the prepared file target expects no bytes). An unmanaged brain
 * soft-deletes in one transaction after the same recheck. A page whose file
 * came back is skipped (`file_restored`) and the result asks for a new
 * preview; any other change is `changed_since_preview`.
 *
 * #6910: a ghost whose path is a member of the source's adopted shared skillpack (`skill_paths`, code
 * `ghost_skill_pack_member`, `src/core/ghost-pages.ts`) is listed apart with its restore step and never
 * approved: the pack's own file is missing and the shared skill publisher owns it. A legacy page on a
 * reserved path that is not a pack member is an ordinary ghost (the knowledge guard lets its retirement
 * through as a database-only soft delete). A page of the approved set that an item-level guard still refuses (a
 * registry `caller` refusal such as `skill_bundle_required`) is recorded `refused` with its code
 * and the apply continues; any other error (storage, contention, owner) still stops it.
 *
 * Refuses off the owner host (`not_owner_host`), fails closed when the source
 * root is unavailable or a check is ambiguous (`ghost_storage_unknown`),
 * never lists a declared db_only page, and applies the sync mass-delete valve
 * (`ghost_mass_delete_refused` unless `GBRAIN_ALLOW_MASS_RECONCILE=1`) when the
 * ghosts are more than half of a source's file-backed pages. Soft-deleted
 * pages are purged by the autopilot purge phase after 72 h; until then
 * `gbrain restore <slug> --force` undoes one page.
 */
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { GHOST_RETIREMENT_INTENT } from '../shared-skills/knowledge-guard.ts';
import { readFix } from '../ops/op-fix.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import { maintenancePreflight, submitMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { MASS_RECONCILE_MIN_PAGES, MASS_RECONCILE_RATIO, massReconcileAllowed } from '../sync-reconcile.ts';
import { ghostPageNow, scanGhostSource, type GhostOwner, type GhostPage, type GhostSourceScan } from '../ghost-pages.ts';
import { afterCursor, REPAIR_ITEM_FAILURE_CODES, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

export const GHOST_PAGES_INTENT = GHOST_RETIREMENT_INTENT;
/** Ghosts one preview lists; a larger set is applied in rounds (preview, apply, preview again). */
export const GHOST_REPAIR_LIMIT = 1000;
export const GHOST_PURGE_FUSE_HOURS = 72;
const DOCS = 'docs/guides/repair.md#ghost-pages';
const FILE_CHANGED = 'The canonical file changed after preparation.';
/** Skill-path slugs a preview lists by name. */
const SKILL_PATH_SAMPLE = 20;
/** #6910: the stable code of a ghost on a file of the adopted shared skillpack. */
export const SKILL_PACK_MEMBER_CODE = 'ghost_skill_pack_member';
/** #6910: why such a ghost is left alone and the human step that clears it; the preview, `gbrain pages ghosts` and doctor say it. */
export const SKILL_PATH_NOTE = 'A ghost page whose path is a file of the source\'s adopted shared skillpack (skills/<name>/..., skillpack.json) is the pack\'s own file missing from the checkout; '
  + 'the shared skill publisher owns it, so this repair never removes the page. Restore the file on the owner host (git -C <source root> checkout -- <path> when it is committed; '
  + 'otherwise republish the skill with put_skill and its catalog expected_revision so the publisher writes it again); the page then stops being a ghost. These pages never block the other ghosts.';
/** The exact restore command for one pack-member ghost. */
export const skillPathRestore = (root: string | undefined, ghost: GhostPage) => `git -C ${root ?? '<source root>'} checkout -- ${ghost.path}`;
/** The `skill_paths` detail every reader prints. */
export function skillPathDetail(root: string | undefined, ghosts: GhostPage[], count = ghosts.length) {
  const sample = ghosts.slice(0, SKILL_PATH_SAMPLE);
  return { code: SKILL_PACK_MEMBER_CODE, count, slugs: sample.map(ghost => ghost.slug), owned_by: 'shared_skill_publisher',
    restore: sample.map(ghost => skillPathRestore(root, ghost)), note: SKILL_PATH_NOTE, docs: DOCS };
}

interface ApprovedGhost extends GhostPage { owner: GhostOwner; selection: string[] }
interface GhostItem extends RepairItem { ghost: GhostPage; owner: GhostOwner; hash: string; last: boolean }

export const ghostPreviewCommand = (sourceId: string) => `gbrain repair ghost-pages --source ${sourceId}`;
const previewFix = (sourceId: string) => readFix('Previews the ghost pages of the source again; writes nothing.',
  { argv: ['gbrain', 'repair', 'ghost-pages', '--source', sourceId, '--json'] });
const writerStatusFix = (sourceId: string) => readFix('Shows the source\'s canonical binding and owner host, read-only.',
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });

/** The three consequences every preview and the consent payload state. */
export const GHOST_CONSEQUENCES = {
  purge: `Soft-deleted pages are purged for good by the autopilot purge phase ${GHOST_PURGE_FUSE_HOURS} h after deletion.`,
  undo: 'Until then, undo one page with gbrain restore <slug> --force (per slug; it writes the file back).',
  keep: 'To keep a page instead, restore its file at the recorded canonical path on the owner host (from Git or a backup; gbrain has no automated file restore), then run gbrain sync for the source.',
};

/** The consent payload of `--apply --expect <hash>` (registry `consentText`). */
export const GHOST_CONSENT_TEXT = {
  what: 'Soft-delete the previewed ghost pages: live pages whose canonical file is missing on the owner host',
  why: 'The preview listed each page with its recorded canonical path and revision; no sync can import a file that is not there, so every write to these pages refuses until the file is restored or the page is removed.',
  risk: `The pages leave search and reads now. ${GHOST_CONSEQUENCES.purge} ${GHOST_CONSEQUENCES.undo} ${GHOST_CONSEQUENCES.keep.replace('To keep a page instead, ', 'To keep a page instead, do not apply: ')} A page whose file comes back before the apply is kept.`,
  user_message: `Soft-delete the previewed ghost pages? They are purged after ${GHOST_PURGE_FUSE_HOURS} h; gbrain restore <slug> --force undoes one until then`,
};

/** The sync valve (#2828) over a source's file-backed pages. */
export function massGhosts(ghosts: number, fileBacked: number): boolean {
  return fileBacked > MASS_RECONCILE_MIN_PAGES && ghosts > fileBacked * MASS_RECONCILE_RATIO;
}

const sameOwner = (a: GhostOwner | undefined, b: GhostOwner) => !!a && a.host_id === b.host_id && a.worktree_id === b.worktree_id
  && a.owner_epoch === b.owner_epoch && a.source_incarnation === b.source_incarnation;

/** `not_owner_host`: the classifier only answers on the source's canonical owner host. */
export function notOwnerHostError(sourceId: string, reason: string): OperationError {
  return opError('not_owner_host', `Ghost pages of source ${sourceId} can only be checked and removed on its canonical owner host.`,
    reason === 'not_applicable'
      ? `Source ${sourceId} has no canonical checkout, so none of its pages owns a file that could be missing; nothing was listed or changed.`
      : `This host does not own source ${sourceId}'s active canonical worktree, so it cannot tell whether a page's file is missing; nothing was listed or changed. Run ${ghostPreviewCommand(sourceId)} in a terminal on the owner host (writer status names it).`,
    { reason, fix: writerStatusFix(sourceId), docs: DOCS });
}

export function ghostScanRefusal(scan: GhostSourceScan): OperationError | null {
  if (scan.status === 'known' || scan.reason === 'mirror_read_only') return null;
  if (scan.status === 'not_applicable') return notOwnerHostError(scan.source_id, scan.reason ?? 'not_owner_host');
  return opError('ghost_storage_unknown', `Ghost pages of source ${scan.source_id} cannot be classified: ${scan.reason === 'storage_unavailable'
    ? 'its canonical root is missing or is not a readable directory' : 'a canonical path could not be read or a page check was ambiguous'}.`,
  `Nothing was listed or changed: a page is never removed while its file may only be unreadable. Inspect the source's checkout on the owner host (writer status shows its root), fix it, then preview again: ${ghostPreviewCommand(scan.source_id)}`,
  { reason: scan.reason, fix: writerStatusFix(scan.source_id), docs: DOCS });
}

export function massRefusal(sourceId: string, ghosts: number, fileBacked: number): OperationError {
  return opError('ghost_mass_delete_refused', `Refusing to soft-delete ${ghosts} of ${fileBacked} file-backed page(s) of source ${sourceId} (more than ${Math.round(MASS_RECONCILE_RATIO * 100)}%).`,
    `That many missing files almost always means the checkout is the wrong path, unmounted or half-cloned, not that the files were deleted; nothing was changed. Check the checkout on the owner host first. If removing these pages is genuinely intended, ask the user, then rerun the same apply command with GBRAIN_ALLOW_MASS_RECONCILE=1.`,
    { fix: writerStatusFix(sourceId), docs: DOCS });
}

function hashParts(scope: RepairScope, owner: GhostOwner | undefined, ghosts: GhostPage[]) {
  return { kind: 'ghost-pages-v1', brain_id: scope.brain_id, selection: { source_ids: scope.source_ids }, owner: owner ?? null, ghosts };
}

function item(ghost: GhostPage, owner: GhostOwner, hash: string, last: boolean): GhostItem {
  return { cursor: { phase: 1, id: ghost.page_id }, source_id: ghost.source_id, slug: ghost.slug, chars: 0, action: 'soft_delete:canonical_file_missing',
    ghost, owner, hash, last };
}

export const ghostPagesRepair: RepairHandler = {
  kind: 'ghost-pages',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (scope.source_ids.length !== 1) {
      throw opError('invalid_params', 'gbrain repair ghost-pages needs --source <id>.',
        'Ghost pages are checked on each source\'s own canonical owner host; name one source, e.g. gbrain repair ghost-pages --source default.',
        { fix: readFix('Lists the registered sources.', { argv: ['gbrain', 'sources', 'list', '--json'] }), docs: DOCS });
    }
    const sourceId = scope.source_ids[0]!;
    const command = ghostPreviewCommand(sourceId);
    const scan = await scanGhostSource(engine, sourceId, { candidateLimit: GHOST_REPAIR_LIMIT });
    const refusal = ghostScanRefusal(scan);
    if (refusal) throw refusal;
    const mass = massGhosts(scan.ghosts.length, scan.file_backed);
    if (!opts?.apply) {
      const skillPaths = scan.skill_paths.length;
      const hash = previewHash(hashParts(scope, scan.owner, scan.ghosts));
      if (scan.ghosts.length) await saveApprovedSet<ApprovedGhost>(engine, { command: 'ghost-pages', hash },
        scan.ghosts.map(ghost => ({ ...ghost, owner: scan.owner!, selection: scope.source_ids })));
      const warnings = [
        ...(mass ? [`${scan.ghosts.length} of ${scan.file_backed} file-backed page(s) are ghosts (more than ${Math.round(MASS_RECONCILE_RATIO * 100)}%): the apply refuses (ghost_mass_delete_refused) unless GBRAIN_ALLOW_MASS_RECONCILE=1; check the checkout first.`] : []),
        ...(scan.truncated ? [`More ghosts may exist past the first ${GHOST_REPAIR_LIMIT} checked; apply this set, then preview again.`] : []),
        ...(skillPaths ? [`${skillPaths} ghost page(s) on files of the shared skillpack are listed apart (${SKILL_PACK_MEMBER_CODE}) and not applied: ${SKILL_PATH_NOTE}`] : []),
        ...(scan.reason === 'mirror_read_only' ? [`Source ${sourceId} is a read-only mirror: its pages publish no file, so none is a ghost.`] : []),
        ...(scan.ghosts.length ? Object.values(GHOST_CONSEQUENCES) : []),
      ];
      return { warnings, items: scan.ghosts.map((ghost, index) => item(ghost, scan.owner!, hash, index === scan.ghosts.length - 1)), preview_hash: hash,
        residuals: { ghosts: scan.ghosts.length, file_backed: scan.file_backed, inspected: scan.inspected, ...(skillPaths ? { skill_paths: skillPaths } : {}) },
        listing: [...scan.ghosts.map(ghost => ({ item: `${ghost.source_id}:${ghost.slug}`, class: 'canonical_file_missing',
          detail: `file ${ghost.path} is missing; revision ${ghost.revision}` })),
        ...scan.skill_paths.map(ghost => ({ item: `${ghost.source_id}:${ghost.slug}`, class: SKILL_PACK_MEMBER_CODE,
          detail: `shared skillpack file ${ghost.path} is missing; not applied. Restore it: ${skillPathRestore(scan.root, ghost)}` }))],
        details: { purge_fuse_hours: GHOST_PURGE_FUSE_HOURS, undo: 'gbrain restore <slug> --force', keep: GHOST_CONSEQUENCES.keep, mass_delete: mass, truncated: scan.truncated, docs: DOCS,
          ...(skillPaths ? { skill_paths: skillPathDetail(scan.root, scan.skill_paths) } : {}) } };
    }
    if (!opts.expect) {
      throw opError('invalid_params', 'gbrain repair ghost-pages --apply removes only the set a preview printed.',
        `Preview first: ${command} — then, after the user agrees, run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`,
        { fix: previewFix(sourceId), docs: DOCS });
    }
    const approved = await loadApprovedSet<ApprovedGhost>(engine, { command: 'ghost-pages', hash: opts.expect, previewCommand: command,
      emptyHash: async () => previewHash(hashParts(scope, scan.owner, [])) });
    if (approved.items.some(ghost => JSON.stringify(ghost.selection) !== JSON.stringify(scope.source_ids) || !sameOwner(scan.owner, ghost.owner))) {
      throw previewChangedError(opts.expect, command);
    }
    if (massGhosts(approved.items.length, scan.file_backed) && !massReconcileAllowed()) throw massRefusal(sourceId, approved.items.length, scan.file_backed);
    const items = approved.items.map(({ selection: _selection, owner, ...ghost }, index) => item(ghost, owner, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { ghost, owner, hash, last } = entry as GhostItem;
    let outcome: RepairItemOutcome;
    try {
      outcome = await retireGhost(ctx, ghost, owner, () => repairRequestId(ctx, 'ghost-pages', ghost, ghost.revision));
    } catch (error) {
      if (!(error instanceof OperationError) || !GHOST_ITEM_REFUSALS.has(error.code)) throw error;
      outcome = { applied: false, outcome: 'refused', reason: error.code, detail: { message: error.message } };
    }
    if (last) await clearApprovedSet(ctx.engine, { command: 'ghost-pages', hash });
    return outcome;
  },
  render(details) {
    return [`  each removed page: soft-deleted, purged after ${details.purge_fuse_hours} h; undo per slug: ${details.undo}; guide: ${details.docs}`];
  },
};

/** Refusals about one ghost only; a run-wide refusal (migrations_pending, worktree_dirty, writer transfer) stops the run and keeps the approval. */
const GHOST_ITEM_REFUSALS: ReadonlySet<string> = new Set([...REPAIR_ITEM_FAILURE_CODES, 'skill_bundle_required']);

const restored = (ghost: GhostPage): RepairItemOutcome => ({ applied: false, outcome: 'file_restored', detail: { path: ghost.path },
  reason: `The canonical file ${ghost.path} exists again, so ${ghost.slug} was kept; run ${ghostPreviewCommand(ghost.source_id)} again for a new preview.` });
const changed = (reason: string): RepairItemOutcome => ({ applied: false, outcome: 'changed_since_preview', reason });

/** Whether the live page is still the approved ghost under the approved owner; otherwise the outcome that skips it. */
async function stillApproved(engine: BrainEngine, ghost: GhostPage, owner: GhostOwner): Promise<RepairItemOutcome | null> {
  const now = await ghostPageNow(engine, ghost.source_id, ghost.slug);
  if (!now.ghost) return now.reason === 'agrees' || now.reason === 'file_database_drift' ? restored(ghost) : changed(`the page is no longer a ghost (${now.reason})`);
  if (!sameOwner(now.owner, owner)) return changed('the source\'s canonical owner changed since the preview');
  if (now.ghost.revision !== ghost.revision || now.ghost.page_id !== ghost.page_id || now.ghost.path !== ghost.path) return changed('the page or its recorded canonical path changed since the preview');
  return null;
}

/** Soft-deletes one approved ghost; a managed brain submits it under `requestId()` (also `gbrain repair file-drift --prefer file` on a page whose file is gone, #6712 wave). */
export async function retireGhost(ctx: OperationContext, ghost: GhostPage, owner: GhostOwner, requestId: () => Promise<string>): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const skip = await stillApproved(engine, ghost, owner);
  if (skip) return skip;
  if (await managedPersistenceEnabled(engine)) {
    const authority = (await maintenancePreflight(engine, ghost.source_id))!;
    try {
      await submitMaintenanceIntent(engine, authority, ghost.slug, { kind: GHOST_PAGES_INTENT, expected_revision: ghost.revision, ghost, owner }, await requestId());
    } catch (error) {
      if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed'].includes(error.code)) return changed(error.message);
      if (error instanceof OperationError && error.code === 'source_changed') return restored(ghost);
      throw error;
    }
    return { applied: true, outcome: 'soft_deleted' };
  }
  const binding = await getWorktreeBinding(engine, ghost.source_id, owner.host_id);
  const file = binding?.local_path ? join(binding.local_path, binding.relative_path, ghost.path) : null;
  const result = await maintenanceTransaction(engine, async tx => {
    await tx.lockPageKeys([{ sourceId: ghost.source_id, slug: ghost.slug }]);
    const snapshot = await tx.readPageSnapshot(ghost.slug, { sourceId: ghost.source_id });
    if (!snapshot || snapshot.revision !== ghost.revision || Number(snapshot.page.id) !== ghost.page_id) return 'changed';
    if (!file || existsSync(file)) return 'restored';
    await tx.createVersion(ghost.slug, { sourceId: ghost.source_id });
    await tx.softDeletePage(ghost.slug, { sourceId: ghost.source_id });
    return 'deleted';
  });
  if (result === 'deleted') return { applied: true, outcome: 'soft_deleted' };
  return result === 'restored' ? restored(ghost) : changed('the page changed since the preview');
}

/**
 * Preparer for `managed_maintenance_retire_ghost_page`: re-runs the classifier under the approved owner, prepares a
 * `delete_page` with `allowMissingFile`, and refuses unless the prepared file target is the approved path with no
 * bytes (a file restored in between refuses here, or at filesystem publication when it appears later).
 */
export async function prepareGhostPageRetirement(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const ghost = row.intent!.ghost as GhostPage | undefined;
  const owner = row.intent!.owner as GhostOwner | undefined;
  if (!ghost || !owner || ghost.slug !== row.slug || ghost.source_id !== row.source_id || ghost.page_id !== Number(row.page_id)) {
    throw opError('invalid_params', 'The ghost page retirement intent does not name its page.',
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} does not name the ghost page it removes, so nothing changed. Preview the repair again and apply the new preview after the user agrees.`,
      { fix: previewFix(row.source_id) });
  }
  const refuse = (outcome: RepairItemOutcome) => outcome.outcome === 'file_restored'
    ? opError('source_changed', FILE_CHANGED, `The canonical file ${ghost.path} of ${row.slug} in source ${row.source_id} exists again, so request ${row.request_id} removed nothing. Preview the repair again; a restored page is kept.`,
      { detail: 'ghost_file_restored', fix: previewFix(row.source_id) })
    : opError('revision_conflict', 'The ghost page changed since the preview.',
      `Page ${row.slug} in source ${row.source_id} changed after the preview (${outcome.reason}), so request ${row.request_id} removed nothing. Preview the repair again and apply the new preview after the user agrees.`,
      { fix: previewFix(row.source_id) });
  const skip = await stillApproved(engine, ghost, owner);
  if (skip) throw refuse(skip);
  await authorizeWrite(engine, row.authority, 'delete_page', row.slug);
  const page = await preparePageMutation(engine, { ...row, operation: 'delete_page' }, config, undefined, undefined, { allowMissingFile: true });
  if (!page.file || relative(page.file.root, page.file.path).split(sep).join('/') !== ghost.path) throw refuse(changed('its canonical file target moved'));
  if (page.file.expectedBeforeHash !== null) throw refuse(restored(ghost));
  return { ...page, validate: async tx => { await page.validate?.(tx); await authorizeWrite(tx, row.authority, 'delete_page', row.slug); } };
}
