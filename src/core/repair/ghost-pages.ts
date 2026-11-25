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
 * GST-3637: only a ghost whose file a commit deleted is ever approved (`ghostBacking`). A ghost whose file no commit ever held
 * (`ghost_never_committed`), whose file HEAD still holds (`ghost_worktree_only`) or whose deletion Git cannot place
 * (`ghost_history_unknown`) is listed apart with its restore route, like a page written after its file
 * (`database_ahead_of_file`), and the soft-delete itself refuses each.
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
import { nativeFileTarget } from '../persistence/native-file-target.ts';
import { clearDeletionHold, readSyncImportProvenance } from '../persistence/sync-holds.ts';
import { readRevisionAttestations } from '../persistence/sync-pass.ts';
import { blobBeforeDeletion, readDeletionProvenance, type DeletionProvenance } from '../persistence/sync-origin-evidence.ts';
import { syncGit } from '../persistence/sync-discovery.ts';
import { readMoveCandidates, readMovedPage, type MoveCandidate, type MovedPageVerdict } from '../persistence/moved-pages.ts';
import { maintenancePreflight, submitMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { MASS_RECONCILE_MIN_PAGES, MASS_RECONCILE_RATIO, massReconcileAllowed } from '../sync-reconcile.ts';
import { ghostPageNow, scanGhostSource, UNRESOLVABLE_PATH_CODE, type GhostOwner, type GhostPage, type GhostSourceScan, type UnresolvablePage } from '../ghost-pages.ts';
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
/** #7736: why a page whose recorded path names no file inside its source is left alone; the preview, `gbrain pages ghosts` and doctor say it. */
export const UNRESOLVABLE_NOTE = 'A page whose recorded file path names no file inside its source (an absolute path, a path with .., or NUL) is never treated as a ghost or removed: '
  + 'gbrain cannot tell whether its file exists. Read it with gbrain pages status <slug> --source <id> --json; the page stays as it is.';
/** The `unresolvable` detail every reader prints. */
export const unresolvableDetail = (count: number, samples: UnresolvablePage[]) => ({ code: UNRESOLVABLE_PATH_CODE, count, samples, note: UNRESOLVABLE_NOTE, docs: DOCS });
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
      const provenance = await readDeletionProvenance(scan.root!, scan.ghosts.map(ghost => ghost.path));
      const kept: Array<{ ghost: GhostPage; code: GhostKeptCode }> = [], ghosts: GhostPage[] = [];
      for (const ghost of scan.ghosts) {
        const backing = await ghostBacking(engine, ghost, scan.owner!, provenance.get(ghost.path));
        if (backing === 'file_backed') ghosts.push(ghost); else kept.push({ ghost, code: backing });
      }
      const moves = await readGhostMoves(engine, sourceId, scan.root!, [...ghosts, ...kept.filter(entry => entry.code === DATABASE_AHEAD_CODE).map(entry => entry.ghost)], provenance);
      const moved: Array<{ ghost: GhostPage; move: GhostMove; code: GhostMoveCode }> = [];
      for (const ghost of [...ghosts]) {
        const move = moves.get(ghost.page_id), code = move && moveCode(move);
        if (!move || !code) continue;
        ghosts.splice(ghosts.indexOf(ghost), 1);
        moved.push({ ghost, move, code });
      }
      const movedTo = moved.filter(entry => entry.code === MOVED_TO_CODE).length, unproven = moved.length - movedTo;
      const aheadMatched = kept.filter(entry => entry.code === DATABASE_AHEAD_CODE && moveCode(moves.get(entry.ghost.page_id)) === MOVED_TO_CODE).length;
      const aheadCount = kept.filter(entry => entry.code === DATABASE_AHEAD_CODE).length;
      const keptCount = (code: GhostKeptCode) => kept.filter(entry => entry.code === code).length;
      const keptResiduals = Object.fromEntries(GHOST_KEPT_CODES.flatMap(code => keptCount(code) ? [[GHOST_KEPT_RESIDUAL[code], keptCount(code)]] : []));
      const hash = previewHash(hashParts(scope, scan.owner, ghosts));
      if (ghosts.length) await saveApprovedSet<ApprovedGhost>(engine, { command: 'ghost-pages', hash },
        ghosts.map(ghost => ({ ...ghost, owner: scan.owner!, selection: scope.source_ids })));
      const warnings = [
        ...(mass ? [`${scan.ghosts.length} of ${scan.file_backed} file-backed page(s) are ghosts (more than ${Math.round(MASS_RECONCILE_RATIO * 100)}%): the apply refuses (ghost_mass_delete_refused) unless GBRAIN_ALLOW_MASS_RECONCILE=1; check the checkout first.`] : []),
        ...(scan.truncated ? [`More ghosts may exist past the first ${GHOST_REPAIR_LIMIT} checked; apply this set, then preview again.`] : []),
        ...(skillPaths ? [`${skillPaths} ghost page(s) on files of the shared skillpack are listed apart (${SKILL_PACK_MEMBER_CODE}) and not applied: ${SKILL_PATH_NOTE}`] : []),
        ...(scan.unresolvable_count ? [`${scan.unresolvable_count} page(s) record a file path that names no file inside the source; they are listed apart (${UNRESOLVABLE_PATH_CODE}) and not applied: ${UNRESOLVABLE_NOTE}`] : []),
        ...(movedTo ? [`${movedTo} ghost page(s) moved to another page that holds every line of them; they are listed apart (${MOVED_TO_CODE}) and not applied: fold each into its moved page with the gbrain repair moved-pages command its line names, which previews first.`] : []),
        ...(unproven ? [`${unproven} ghost page(s) have a file in HEAD that Git renamed them to, that holds or started from their last committed content, or whose move Git could not read, but no fold is proven to lose nothing; they are listed apart (${MOVE_UNPROVEN_CODE}) and not applied.`] : []),
        ...GHOST_KEPT_CODES.flatMap(code => keptCount(code) ? [`${keptCount(code)} ghost page(s) ${GHOST_KEPT_WARNING[code]}; they are listed apart (${code}) and not applied.`] : []),
        ...(aheadCount ? [`Move evidence for ${DATABASE_AHEAD_CODE}: ${aheadMatched} matched (a moved page holds every line, including the database edit), ${aheadCount - aheadMatched} unmatched.`] : []),
        ...(scan.reason === 'mirror_read_only' ? [`Source ${sourceId} is a read-only mirror: its pages publish no file, so none is a ghost.`] : []),
        ...(ghosts.length ? Object.values(GHOST_CONSEQUENCES) : []),
      ];
      return { warnings, items: ghosts.map((ghost, index) => item(ghost, scan.owner!, hash, index === ghosts.length - 1)), preview_hash: hash,
        residuals: { ghosts: ghosts.length, file_backed: scan.file_backed, inspected: scan.inspected, ...(skillPaths ? { skill_paths: skillPaths } : {}), ...keptResiduals,
          ...(movedTo ? { moved_to: movedTo } : {}), ...(unproven ? { move_unproven: unproven } : {}),
          ...(aheadCount ? { database_ahead_matched: aheadMatched, database_ahead_unmatched: aheadCount - aheadMatched } : {}),
          ...(scan.unresolvable_count ? { unresolvable: scan.unresolvable_count } : {}) },
        listing: [...ghosts.map(ghost => ({ item: `${ghost.source_id}:${ghost.slug}`, class: 'canonical_file_missing',
          detail: `file ${ghost.path} is missing; revision ${ghost.revision}` })),
        ...moved.map(({ ghost, move, code }) => ({ item: `${ghost.source_id}:${ghost.slug}`, class: code, detail: ghostMoveDetail(ghost, move) })),
        ...kept.map(({ ghost, code }) => ({ item: `${ghost.source_id}:${ghost.slug}`, class: code,
          detail: code === DATABASE_AHEAD_CODE ? `${ghostKeptDetail(code, ghost, scan.root)}. ${moveEvidence(ghost, moves.get(ghost.page_id))}` : ghostKeptDetail(code, ghost, scan.root) })),
        ...scan.skill_paths.map(ghost => ({ item: `${ghost.source_id}:${ghost.slug}`, class: SKILL_PACK_MEMBER_CODE,
          detail: `shared skillpack file ${ghost.path} is missing; not applied. Restore it: ${skillPathRestore(scan.root, ghost)}` })),
        ...scan.unresolvable.map(page => ({ item: `${page.source_id}:${page.slug}`, class: UNRESOLVABLE_PATH_CODE,
          detail: `recorded path ${page.source_path} names no file inside the source; not applied` }))],
        details: { purge_fuse_hours: GHOST_PURGE_FUSE_HOURS, undo: 'gbrain restore <slug> --force', keep: GHOST_CONSEQUENCES.keep, mass_delete: mass, truncated: scan.truncated, docs: DOCS,
          ...(skillPaths ? { skill_paths: skillPathDetail(scan.root, scan.skill_paths) } : {}),
          ...(scan.unresolvable_count ? { unresolvable: unresolvableDetail(scan.unresolvable_count, scan.unresolvable) } : {}) } };
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
    await primeGhostMoves(engine, sourceId, scan.root!, approved.items.map(({ selection: _selection, owner: _owner, ...ghost }) => ghost));
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

export const DATABASE_AHEAD_CODE = 'database_ahead_of_file';
/** GST-3637: a ghost whose file no commit ever held; the page holds the only copy of its content. */
export const NEVER_COMMITTED_CODE = 'ghost_never_committed';
/** GST-3637: a ghost whose file HEAD still holds; only the working tree lost it. */
export const WORKTREE_ONLY_CODE = 'ghost_worktree_only';
/** GST-3637: a ghost whose deletion Git cannot place (no Git checkout, a shallow history, a failed history read). */
export const HISTORY_UNKNOWN_CODE = 'ghost_history_unknown';
/** A ghost a proven move pairs with a live page that holds every line of it: folded by repair moved-pages, never soft-deleted here. */
export const MOVED_TO_CODE = 'moved_to';
/** A ghost Git renamed, or whose last committed content a file in HEAD holds, without a fold proven to lose nothing: kept. */
export const MOVE_UNPROVEN_CODE = 'move_unproven';
export const GHOST_KEPT_CODES = [DATABASE_AHEAD_CODE, NEVER_COMMITTED_CODE, WORKTREE_ONLY_CODE, HISTORY_UNKNOWN_CODE] as const;
export type GhostKeptCode = typeof GHOST_KEPT_CODES[number];
const GHOST_KEPT_RESIDUAL: Record<GhostKeptCode, string> = { database_ahead_of_file: 'database_ahead', ghost_never_committed: 'never_committed', ghost_worktree_only: 'worktree_only', ghost_history_unknown: 'history_unknown' };
const GHOST_KEPT_WARNING: Record<GhostKeptCode, string> = {
  database_ahead_of_file: 'were written in the database after their file last held them, so each holds the only copy of that content',
  ghost_never_committed: 'record a file no commit ever held, so each holds the only copy of its content',
  ghost_worktree_only: 'lost their file in the working tree only (HEAD still holds it), so Git can restore each',
  ghost_history_unknown: 'record a file whose deletion Git cannot place, so each may hold the only copy of its content',
};
const recreateFile = (ghost: GhostPage) => `gbrain repair file-drift --source ${ghost.source_id} --slug ${ghost.slug} --prefer database`;
export const databaseAheadDetail = (ghost: GhostPage) => `file ${ghost.path} is gone, but page ${ghost.slug} was written in the database after the file last held it, so it holds the only copy of that content; not soft-deleted. Recreate the file from the page with ${recreateFile(ghost)}, or keep the page as it is`;

/** Why a ghost is kept, and the route that resolves it; every reader of a kept ghost prints this. */
/** A ghost's move read: Git could not read where it went (`unread`), or its candidates and the moved-pages verdict; `shared` when another ghost of the same read moved to the same page. */
type GhostMove = { unread: true } | { unread?: false; candidates: MoveCandidate[]; verdict: MovedPageVerdict; shared?: boolean };
type GhostMoveCode = typeof MOVED_TO_CODE | typeof MOVE_UNPROVEN_CODE;

export const movedPagesCommand = (ghost: GhostPage) => `gbrain repair moved-pages --source ${ghost.source_id} --slug ${ghost.slug}`;

/**
 * Why a ghost is kept from soft-delete for its move, or null: `moved_to` when a proven move pairs it with a live page that
 * holds every line of it (and no other ghost of the read claims that page), `move_unproven` when Git could not read where it
 * went, or a file in HEAD (imported or not) that Git renamed it to, that holds or started from its last committed content, or
 * that has its name and that Git added between the old file's add and its deletion, exists without a proven fold. A
 * same-name file Git does not link to it does not keep it.
 */
function moveCode(move: GhostMove | undefined): GhostMoveCode | null {
  if (!move) return null;
  if (move.unread || move.shared) return MOVE_UNPROVEN_CODE;
  if (move.verdict.verdict === 'moved') return MOVED_TO_CODE;
  return move.candidates.some(candidate => candidate.match !== 'same_file_name' || candidate.linked !== false) ? MOVE_UNPROVEN_CODE : null;
}

/** The move read for each committed-deletion ghost with a candidate or an unreadable history: one candidate read per call, then the moved-pages verdict per ghost on the history that read walked. */
async function readGhostMoves(engine: BrainEngine, sourceId: string, root: string, ghosts: GhostPage[], provenance: Map<string, DeletionProvenance>): Promise<Map<number, GhostMove>> {
  const read = await readMoveCandidates(engine, { sourceId, root, ghosts: ghosts.map(ghost => ({ page_id: ghost.page_id, path: ghost.path, deletion: provenance.get(ghost.path) ?? { kind: 'unknown' } })) });
  const moves = new Map<number, GhostMove>();
  for (const ghost of ghosts) {
    if (read.unread.has(ghost.page_id)) { moves.set(ghost.page_id, { unread: true }); continue; }
    const candidates = read.found.get(ghost.page_id);
    if (!candidates) continue;
    const verdict = await readMovedPage(engine, { sourceId, root, old: { page_id: ghost.page_id, slug: ghost.slug, revision: ghost.revision, path: ghost.path }, provenance: provenance.get(ghost.path), candidates, history: read.history });
    moves.set(ghost.page_id, { candidates, verdict });
  }
  const survivors = [...moves.values()].flatMap(move => !move.unread && move.verdict.verdict === 'moved' ? [move.verdict.survivor.page_id] : []);
  for (const move of moves.values()) {
    if (!move.unread && move.verdict.verdict === 'moved' && survivors.filter(id => id === (move.verdict as { survivor: { page_id: number } }).survivor.page_id).length > 1) move.shared = true;
  }
  return moves;
}

/** Move reads of one apply run, keyed by checkout root and HEAD: a read depends on Git only once candidates are named, so one HEAD shares it. */
const runMoves = { checkout: '', moves: new Map<string, GhostMove | undefined>() };
const headOf = (root: string) => { try { return syncGit(root, ['rev-parse', 'HEAD']).trim(); } catch { return null; } };
/** HEAD of the ghost's checkout under its owner's binding, or null. */
async function ghostCheckoutHead(engine: BrainEngine, ghost: GhostPage, owner: GhostOwner): Promise<string | null> {
  const binding = await getWorktreeBinding(engine, ghost.source_id, owner.host_id);
  return binding?.local_path ? headOf(join(binding.local_path, binding.relative_path)) : null;
}
const moveKey = (ghost: GhostPage) => `${ghost.page_id}:${ghost.revision}:${ghost.path}`;

/** Reads the moves of every ghost an apply is about to retire in one pass, so each item's veto reuses it at the same HEAD. */
async function primeGhostMoves(engine: BrainEngine, sourceId: string, root: string, ghosts: GhostPage[]): Promise<void> {
  const head = headOf(root);
  if (!head || !ghosts.length) return;
  const moves = await readGhostMoves(engine, sourceId, root, ghosts, await readDeletionProvenance(root, ghosts.map(ghost => ghost.path)));
  runMoves.checkout = `${root}\0${head}`;
  runMoves.moves = new Map(ghosts.map(ghost => [moveKey(ghost), moves.get(ghost.page_id)]));
}

/** Reads the moves of `ghosts` (one source, one owner) in one pass, so each one's `ghostMoveVeto` at this HEAD reuses it. */
export async function primeGhostMoveVetoes(engine: BrainEngine, ghosts: GhostPage[], owner: GhostOwner): Promise<void> {
  if (!ghosts.length) return;
  const binding = await getWorktreeBinding(engine, ghosts[0]!.source_id, owner.host_id);
  if (binding?.local_path) await primeGhostMoves(engine, ghosts[0]!.source_id, join(binding.local_path, binding.relative_path), ghosts);
}

/**
 * Whether the ghost's move keeps it from soft-delete now: the soft-delete's own check (ghost-pages, file-drift --prefer file
 * and the managed preparer), so an approval saved before a move, or before this check, cannot remove it.
 */
export async function ghostMoveVeto(engine: BrainEngine, ghost: GhostPage, owner: GhostOwner): Promise<(RepairItemOutcome & { reason: GhostMoveCode; detail: { message: string; unread?: true } }) | null> {
  const binding = await getWorktreeBinding(engine, ghost.source_id, owner.host_id);
  if (!binding?.local_path) return null;
  const root = join(binding.local_path, binding.relative_path);
  const head = headOf(root);
  const cached = head !== null && runMoves.checkout === `${root}\0${head}` && runMoves.moves.has(moveKey(ghost));
  const move = cached ? runMoves.moves.get(moveKey(ghost))
    : (await readGhostMoves(engine, ghost.source_id, root, [ghost], await readDeletionProvenance(root, [ghost.path]))).get(ghost.page_id);
  const code = moveCode(move);
  return code ? { applied: false, outcome: 'refused', reason: code, detail: { message: ghostMoveDetail(ghost, move!), ...(move!.unread ? { unread: true as const } : {}) } } : null;
}

const candidateList = (move: { candidates: MoveCandidate[] }) => move.candidates.map(candidate => `${candidate.slug ?? 'no page yet'} (${candidate.path}, ${candidate.match})`).join(', ');

function ghostMoveDetail(ghost: GhostPage, move: GhostMove): string {
  if (move.unread) return `file ${ghost.path} is gone, and Git could not read whether it moved (the HEAD listing or the history read failed); not soft-deleted. Preview again, or decide with the user`;
  if (move.verdict.verdict === 'moved' && move.shared) return `file ${ghost.path} is gone and page ${ghost.slug} ${move.verdict.detail}, but another ghost moved to ${move.verdict.survivor.slug} too (shared_survivor), so which one moved is a person's decision; not soft-deleted`;
  if (move.verdict.verdict === 'moved') return `file ${ghost.path} is gone and page ${ghost.slug} ${move.verdict.detail}; not soft-deleted. Fold it into ${move.verdict.survivor.slug}, preview first: ${movedPagesCommand(ghost)}`;
  return `file ${ghost.path} is gone, and ${candidateList(move)} looks like where it went, but the fold is held (${move.verdict.reason}: ${move.verdict.detail}); not soft-deleted. Decide with the user`;
}

/** Move evidence for a database_ahead_of_file ghost: matched when a moved page holds every line of it, edit included. */
function moveEvidence(ghost: GhostPage, move: GhostMove | undefined): string {
  if (!move) return 'Move evidence: unmatched; no file in HEAD looks like where it went';
  if (move.unread) return 'Move evidence: unmatched; Git could not read whether it moved';
  if (moveCode(move) === MOVED_TO_CODE && move.verdict.verdict === 'moved') return `Move evidence: matched; page ${ghost.slug} ${move.verdict.detail}. Fold it, preview first: ${movedPagesCommand(ghost)}`;
  return `Move evidence: unmatched; ${candidateList(move)} looks like where it went, but ${move.verdict.verdict === 'held' ? move.verdict.detail : `another ghost moved to ${move.verdict.survivor.slug} too`}`;
}

export function ghostKeptDetail(code: GhostKeptCode, ghost: GhostPage, root?: string): string {
  if (code === DATABASE_AHEAD_CODE) return databaseAheadDetail(ghost);
  if (code === NEVER_COMMITTED_CODE) return `file ${ghost.path} is gone and no commit ever held it, so page ${ghost.slug} holds the only copy of its content; not soft-deleted. `
    + `Write the file from the page with ${recreateFile(ghost)}, then commit it and sync the source, or keep the page as it is`;
  if (code === WORKTREE_ONLY_CODE) return `file ${ghost.path} is deleted in the working tree only: HEAD still holds it; not soft-deleted. `
    + `Restore it with git -C '${root ?? '<source root>'}' checkout HEAD -- '${ghost.path}' and sync the source; if the removal is intended, commit the deletion, sync, then preview again`;
  return `Git could not say which commit deleted ${ghost.path} (the source is not a Git checkout, its history is shallow, or the history read failed), so page ${ghost.slug} may hold the only copy of its content; not soft-deleted. `
    + `Write the file from the page with ${recreateFile(ghost)}; in a shallow clone, fetch the full history (git fetch --unshallow) and preview again; `
    + `in a folder that is not a Git checkout, delete the page by hand (gbrain delete ${ghost.slug}) if its removal is intended`;
}

/**
 * Whether a ghost may be soft-deleted (`file_backed`), or why it is kept. GST-3637: only a file a commit deleted can be
 * removed, since only then does Git still hold what the file held: a file no commit ever held leaves the page as the only
 * copy (`ghost_never_committed`), a file HEAD still holds was lost from the working tree only (`ghost_worktree_only`),
 * and a deletion Git cannot place is kept too (`ghost_history_unknown`). A committed deletion counts only when the live
 * revision is file-backed: the revision sync last imported from the file (the import record; an import of working-tree
 * bytes counts only when the deleting commit's parent held those bytes, else the page holds the only copy of them:
 * `ghost_never_committed`), or one a committed sync
 * write or a Git-published write produced (the attestation sync's own deletion proof reads). Any other revision of a
 * recorded page was written in the database after its file last held it (`database_ahead_of_file`). A page with no
 * import record is judged against the date of the commit that deleted its file. `provenance` is the path's deletion
 * provenance when the caller already read it.
 */
export async function ghostBacking(engine: BrainEngine, ghost: GhostPage, owner: GhostOwner, provenance?: DeletionProvenance): Promise<'file_backed' | GhostKeptCode> {
  const binding = await getWorktreeBinding(engine, ghost.source_id, owner.host_id);
  if (!binding?.local_path) return HISTORY_UNKNOWN_CODE;
  const root = join(binding.local_path, binding.relative_path);
  const deletion = provenance ?? (await readDeletionProvenance(root, [ghost.path])).get(ghost.path);
  if (deletion?.kind === 'never_committed') return NEVER_COMMITTED_CODE;
  if (deletion?.kind === 'deletion_uncommitted') return WORKTREE_ONLY_CODE;
  if (deletion?.kind !== 'deleted_by_commit') return HISTORY_UNKNOWN_CODE;
  const record = await readSyncImportProvenance(engine, ghost.source_id, owner.source_incarnation, ghost.page_id);
  const recorded = record?.revision;
  if (recorded === ghost.revision) {
    if (!record!.working) return 'file_backed';
    const deleted = await blobBeforeDeletion(root, deletion.commit, ghost.path);
    return deleted !== null && (deleted === record!.blob_oid || deleted === record!.disk_blob_oid) ? 'file_backed' : NEVER_COMMITTED_CODE;
  }
  const page = (await engine.listRepairScanPages(ghost.source_id, { ids: [ghost.page_id] })).find(row => row.revision === ghost.revision);
  if (!page) return DATABASE_AHEAD_CODE;
  const [hit] = page.request_id ? await readRevisionAttestations(engine, ghost.source_id, owner.source_incarnation,
    [{ pageId: ghost.page_id, requestId: page.request_id, revision: ghost.revision, sourcePath: page.source_path ?? ghost.path }]) : [];
  if (hit && (hit.arm1 || hit.attested_hash !== null)) return 'file_backed';
  if (recorded !== undefined) return DATABASE_AHEAD_CODE;
  return Number(page.updated_ms) <= Date.parse(deletion.date) ? 'file_backed' : DATABASE_AHEAD_CODE;
}

/** Whether `ghostBacking` lets the ghost be soft-deleted (sync's held-deletion proof and file-drift --prefer file read it). */
export async function ghostFileBacked(engine: BrainEngine, ghost: GhostPage, owner: GhostOwner, provenance?: DeletionProvenance): Promise<boolean> {
  return await ghostBacking(engine, ghost, owner, provenance) === 'file_backed';
}

/** Whether the live page is still the approved ghost under the approved owner, with a file-backed revision; otherwise the outcome that skips it. */
async function stillApproved(engine: BrainEngine, ghost: GhostPage, owner: GhostOwner): Promise<RepairItemOutcome | null> {
  const now = await ghostPageNow(engine, ghost.source_id, ghost.slug);
  if (!now.ghost) return ['agrees', 'file_database_drift', 'recorded_file_present'].includes(now.reason) ? restored(ghost) : changed(`the page is no longer a ghost (${now.reason})`);
  if (!sameOwner(now.owner, owner)) return changed('the source\'s canonical owner changed since the preview');
  if (now.ghost.revision !== ghost.revision || now.ghost.page_id !== ghost.page_id || now.ghost.path !== ghost.path) return changed('the page or its recorded canonical path changed since the preview');
  const backing = await ghostBacking(engine, ghost, owner);
  if (backing !== 'file_backed') return { applied: false, outcome: 'refused', reason: backing, detail: { message: ghostKeptDetail(backing, ghost) } };
  return await ghostMoveVeto(engine, ghost, owner);
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
 * bytes (a file restored in between refuses here, or at filesystem publication when it appears later). #7736: a page
 * whose approved path is a recorded non-Markdown file is prepared at its slug path, which must hold no bytes either.
 * #7967: its file target is then moved to the recorded file, still expecting no bytes, so filesystem publication refuses
 * a recorded file restored after preparation and the door commits the recorded file's removal (on a git-canonical
 * source HEAD drops it with the page), never a removal of `<slug>.md`.
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
  const head = await ghostCheckoutHead(engine, ghost, owner);
  const skip = await stillApproved(engine, ghost, owner);
  if (skip) throw refuse(skip);
  await authorizeWrite(engine, row.authority, 'delete_page', row.slug);
  const page = await preparePageMutation(engine, { ...row, operation: 'delete_page' }, config, undefined, undefined, { allowMissingFile: true });
  const target = page.file ? relative(page.file.root, page.file.path).split(sep).join('/') : null;
  // #7736: a code or image page's write target is its slug path (prepareFileTarget resolves Markdown paths only), not the
  // recorded file the classifier just found missing again; that target must expect no bytes like any other.
  const recordedFile = !/\.mdx?$/i.test(ghost.path) && target === `${ghost.slug}.md`;
  if (!page.file || (target !== ghost.path && !recordedFile)) throw refuse(changed('its canonical file target moved'));
  if (page.file.expectedBeforeHash !== null) throw refuse(restored(ghost));
  const file = recordedFile ? { ...page.file, path: nativeFileTarget(page.file.root, join(page.file.root, ghost.path)) } : page.file;
  return { ...page, file, validate: async tx => {
    await page.validate?.(tx);
    await authorizeWrite(tx, row.authority, 'delete_page', row.slug);
    // A commit since the preparer's move check can show the file moved: the check runs again before the delete is published.
    if (head !== null && await ghostCheckoutHead(tx, ghost, owner) === head) return;
    const veto = await ghostMoveVeto(tx, ghost, owner);
    if (veto) throw refuse(veto);
  },
    // GBRA-133: the soft delete is the decision a held deletion of this file waited for, so its hold clears with it.
    apply: async (tx, preimage) => {
      const outcome = await page.apply(tx, preimage);
      return await clearDeletionHold(tx, { sourceId: row.source_id, incarnation: row.source_incarnation, path: ghost.path }) ? { ...outcome, hold_cleared: true } : outcome;
    } };
}
