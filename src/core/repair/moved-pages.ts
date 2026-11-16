/**
 * `gbrain repair moved-pages --source <id> [--slug <old-slug>]...` (GST-2584): fold a page left behind by a file that moved
 * into the page the moved file imported as.
 *
 * Sync follows a move only when it happens. When the old page's deletion was held (a managed source holds `file_gone`
 * for a page it cannot prove unchanged), the new path imports as a fresh page and nothing pairs the two again; neither
 * side of `repair file-drift` carries the old page (`--prefer file` drops its links, facts, timeline and versions,
 * `--prefer database` writes a stale duplicate back). This repair pairs them on proof read from Git
 * (persistence/moved-pages.ts): the old path's last committed content is the moved file's content at the move, and the old
 * page still holds it. Exactly one page may descend from it; anything else is listed with its reason and kept.
 *
 * Explicit-only, preview-bound, trusted local CLI on the source's owner host. `--apply --expect <hash> --yes` folds exactly
 * the previewed pairs, one coordinated maintenance write per pair (`managed_maintenance_fold_moved_page`; an unmanaged
 * brain does the same in one maintenance transaction), re-checking the proof and both pages under their keys:
 * `mergeTwinInto` moves links in every role, relationship dates, timeline, raw data, files, user tags, aliases and facts
 * to the moved page, records the old slug as an alias and soft-deletes the old page (database-only, restorable for
 * ${MOVED_PAGES_PURGE_FUSE_HOURS} h); its saved versions move too, and its `file_gone` hold is cleared. No file is written.
 * A repo-less brain has no file that could move, so the preview lists nothing.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import { shellQuote } from '../agent-output.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { prepareCoreGuard } from '../persistence/core-guard.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { mergeTwinInto } from '../persistence/twin-merge.ts';
import { readMovedPage, type MovedEvidence, type MovedHeldReason, type MovedPageRef } from '../persistence/moved-pages.ts';
import { readDeletionProvenance } from '../persistence/sync-origin-evidence.ts';
import { clearGitHold, movedPagesPreviewArgv } from '../persistence/sync-holds.ts';
import { ghostPageNamed, ghostPageNow, scanGhostSource, sourceContext, type GhostOwner } from '../ghost-pages.ts';
import { MASS_RECONCILE_MIN_PAGES, MASS_RECONCILE_RATIO, massReconcileAllowed } from '../sync-reconcile.ts';
import { ghostScanRefusal, GHOST_PURGE_FUSE_HOURS, GHOST_REPAIR_LIMIT } from './ghost-pages.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

export const MOVED_PAGES_INTENT = 'managed_maintenance_fold_moved_page';
export const MOVED_PAGES_PURGE_FUSE_HOURS = GHOST_PURGE_FUSE_HOURS;
const DOCS = 'docs/guides/repair.md#moved-pages';

/** One coordinated write: the old page folds into the page its file moved to. */
export interface MovedPair { source_id: string; old: MovedPageRef; survivor: MovedPageRef; old_blob: string; move_commit: string; evidence: MovedEvidence; evidence_commit: string; observed_at: string }
interface HeldPage { source_id: string; slug: string; path: string; reason: MovedHeldReason; detail: string; candidates?: string[] }
interface ApprovedPair extends MovedPair { owner: GhostOwner; selection: string[] }
interface PairItem extends RepairItem { pair: MovedPair; owner: GhostOwner; hash: string; last: boolean }

const previewArgv = (sourceId: string) => [...movedPagesPreviewArgv(sourceId), '--json'];
const previewFix = (sourceId: string) => readFix('Previews the pages of the source whose file moved again; writes nothing.', { argv: previewArgv(sourceId) });
const sameOwner = (a: GhostOwner | undefined, b: GhostOwner) => !!a && a.host_id === b.host_id && a.worktree_id === b.worktree_id
  && a.owner_epoch === b.owner_epoch && a.source_incarnation === b.source_incarnation;

/** The consent payload of `--apply --expect <hash>` (registry `consentText`). */
export const MOVED_PAGES_CONSENT_TEXT = {
  what: 'Fold each previewed page whose file moved into the page the moved file imported as',
  why: 'Each old page was left behind when its file moved while its deletion was held; Git shows the moved file started from exactly what the old page still holds, so folding it loses no edit.',
  risk: `The old page's links in every role, relationship dates, timeline, raw data, files, user tags, aliases, facts and saved versions move to the moved page, its slug becomes an alias, its hold is cleared, and it is soft-deleted and purged ${MOVED_PAGES_PURGE_FUSE_HOURS} h later; gbrain restore brings back its text as a database-only page until then, and moved references stay on the moved page. No file is written.`,
  user_message: `Fold the previewed pages whose file moved into their moved pages? Each old page is soft-deleted and purged after ${MOVED_PAGES_PURGE_FUSE_HOURS} h`,
};

function hashParts(scope: RepairScope, slugs: string[] | undefined, owner: GhostOwner, pairs: MovedPair[], held: HeldPage[]) {
  return { kind: 'moved-pages-v1', brain_id: scope.brain_id, selection: { source_ids: scope.source_ids, slugs: slugs ?? null }, owner,
    pairs: pairs.map(({ observed_at: _observedAt, ...pair }) => pair), held: held.map(page => ({ slug: page.slug, reason: page.reason })) };
}

function item(pair: MovedPair, owner: GhostOwner, hash: string, last: boolean): PairItem {
  return { cursor: { phase: 1, id: pair.old.page_id }, source_id: pair.source_id, slug: pair.old.slug, chars: 0, action: 'fold:moved_page', pair, owner, hash, last };
}

const pairLine = (p: MovedPair) => `${p.old.slug} (id ${p.old.page_id}, revision ${p.old.revision}) folds into ${p.survivor.slug} (id ${p.survivor.page_id}): ${p.old.path} moved to ${p.survivor.path} `
  + `(${p.evidence === 'same_commit' ? `commit ${p.move_commit.slice(0, 12)}` : `first commit ${p.evidence_commit.slice(0, 12)} of ${p.survivor.path}`}, blob ${p.old_blob.slice(0, 12)})`;

export const movedPagesRepair: RepairHandler = {
  kind: 'moved-pages',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (opts?.remote === true) throw trustedCliRequired('gbrain repair moved-pages runs only from the trusted local CLI on the brain host.');
    if (scope.source_ids.length !== 1) {
      throw opError('invalid_params', 'gbrain repair moved-pages needs --source <id>.',
        'Moved files are read from each source\'s own canonical checkout; name one source, e.g. gbrain repair moved-pages --source default.',
        { fix: readFix('Lists the registered sources.', { argv: ['gbrain', 'sources', 'list', '--json'] }), docs: DOCS });
    }
    const sourceId = scope.source_ids[0]!;
    const command = shellQuote(movedPagesPreviewArgv(sourceId));
    const slugs = opts?.slugs?.length ? [...new Set(opts.slugs)].sort() : undefined;
    const scan = await scanGhostSource(engine, sourceId, { candidateLimit: GHOST_REPAIR_LIMIT });
    if (scan.status === 'not_applicable' && scan.reason === 'not_applicable') {
      const hash = previewHash({ kind: 'moved-pages-v1', brain_id: scope.brain_id, selection: { source_ids: scope.source_ids, slugs: slugs ?? null }, empty: true });
      return { items: [], preview_hash: opts?.expect ?? hash, residuals: { moved: 0 },
        warnings: [`Source ${sourceId} has no canonical checkout bound (a repo-less source), so no file of it can have moved; nothing to fold.`] };
    }
    const refusal = ghostScanRefusal(scan);
    if (refusal) throw refusal;
    const owner = scan.owner!, root = scan.root!;
    const named = slugs ? await Promise.all(slugs.map(slug => ghostPageNamed(engine, sourceId, slug))) : [];
    const ghosts = slugs ? named.filter(ghost => ghost !== null) : scan.ghosts.slice(0, GHOST_REPAIR_LIMIT);
    const provenance = await readDeletionProvenance(root, ghosts.map(ghost => ghost.path));
    const observedAt = new Date().toISOString();
    const pairs: MovedPair[] = [], held: HeldPage[] = [];
    const found: MovedPair[] = [];
    for (const ghost of ghosts) {
      const old: MovedPageRef = { page_id: ghost.page_id, slug: ghost.slug, revision: ghost.revision, path: ghost.path };
      const verdict = await readMovedPage(engine, { sourceId, root, old, provenance: provenance.get(ghost.path) ?? { kind: 'unknown' } });
      if (verdict.verdict === 'moved') found.push({ source_id: sourceId, old, survivor: verdict.survivor, old_blob: verdict.old_blob, move_commit: verdict.move_commit,
        evidence: verdict.evidence, evidence_commit: verdict.evidence_commit, observed_at: observedAt });
      else held.push({ source_id: sourceId, slug: ghost.slug, path: ghost.path, reason: verdict.reason, detail: verdict.detail, ...(verdict.candidates ? { candidates: verdict.candidates } : {}) });
    }
    for (const pair of found) {
      const claims = found.filter(other => other.survivor.page_id === pair.survivor.page_id);
      if (claims.length === 1) { pairs.push(pair); continue; }
      held.push({ source_id: sourceId, slug: pair.old.slug, path: pair.old.path, reason: 'shared_survivor', candidates: [pair.survivor.slug],
        detail: `${claims.map(other => other.old.path).join(', ')} all moved to ${pair.survivor.path} by their content, so which one it is is a person's decision` });
    }
    const missing = slugs?.filter(slug => !ghosts.some(ghost => ghost.slug === slug)) ?? [];
    const mass = scan.file_backed > MASS_RECONCILE_MIN_PAGES && pairs.length > scan.file_backed * MASS_RECONCILE_RATIO;
    if (!opts?.apply) {
      const hash = previewHash(hashParts(scope, slugs, owner, pairs, held));
      if (pairs.length) await saveApprovedSet<ApprovedPair>(engine, { command: 'moved-pages', hash }, pairs.map(pair => ({ ...pair, owner, selection: scope.source_ids })));
      const warnings = [
        ...(missing.length ? [`Not a live page whose file is gone in source ${sourceId}, so nothing to fold: ${missing.join(', ')}.`] : []),
        ...(mass ? [`${pairs.length} fold(s) against ${scan.file_backed} file-backed page(s) (more than ${Math.round(MASS_RECONCILE_RATIO * 100)}%): the apply refuses unless GBRAIN_ALLOW_MASS_RECONCILE=1; check the source first.`] : []),
        ...((scan.truncated || scan.ghosts.length > ghosts.length) && !slugs ? [`More pages whose file is gone may exist past the first ${GHOST_REPAIR_LIMIT} checked; apply this set, or name pages with --slug (repair file-drift --held lists each moved page's command), then preview again.`] : []),
        ...(held.length ? [`${held.length} page(s) whose file is gone are not proven moved and are never folded by this apply; each lists why.`] : []),
        ...(pairs.length ? [MOVED_PAGES_CONSENT_TEXT.risk] : []),
        ...(!scan.ghosts.length ? [`Source ${sourceId} has no live page whose file is gone; nothing to fold.`] : []),
      ];
      return { warnings, items: pairs.map((pair, index) => item(pair, owner, hash, index === pairs.length - 1)), preview_hash: hash,
        residuals: { held: held.length, ...Object.fromEntries([...new Set(held.map(page => page.reason))].map(reason => [reason, held.filter(page => page.reason === reason).length])) },
        listing: [...pairs.map(pair => ({ item: `${pair.source_id}:${pair.old.slug}`, class: 'moved_to', detail: pairLine(pair) })),
          ...held.map(page => ({ item: `${page.source_id}:${page.slug}`, class: `held:${page.reason}`, detail: page.detail }))],
        details: { pairs, held, mass_fold: mass, truncated: scan.truncated, purge_fuse_hours: MOVED_PAGES_PURGE_FUSE_HOURS, docs: DOCS } };
    }
    if (!opts.expect) {
      throw opError('invalid_params', 'gbrain repair moved-pages --apply folds only the set a preview printed.',
        `Preview first: ${command} — then, after the user agrees, run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`, { fix: previewFix(sourceId), docs: DOCS });
    }
    const approved = await loadApprovedSet<ApprovedPair>(engine, { command: 'moved-pages', hash: opts.expect, previewCommand: command,
      emptyHash: async () => previewHash(hashParts(scope, slugs, owner, [], held)) });
    if (approved.items.some(pair => JSON.stringify(pair.selection) !== JSON.stringify(scope.source_ids) || !sameOwner(owner, pair.owner))) throw previewChangedError(opts.expect, command);
    if (scan.file_backed > MASS_RECONCILE_MIN_PAGES && approved.items.length > scan.file_backed * MASS_RECONCILE_RATIO && !massReconcileAllowed()) {
      throw opError('moved_pages_mass_fold_refused', `Refusing to fold ${approved.items.length} moved page(s) of source ${sourceId}: that soft-deletes more than ${Math.round(MASS_RECONCILE_RATIO * 100)}% of its ${scan.file_backed} file-backed page(s).`,
        'That many moved pages at once almost always means a re-import under other paths or the wrong checkout, not a backlog; nothing was changed. If it is genuinely intended, ask the user, then rerun the same apply command with GBRAIN_ALLOW_MASS_RECONCILE=1.',
        { fix: previewFix(sourceId), docs: DOCS });
    }
    const items = approved.items.map(({ selection: _selection, owner: pairOwner, ...pair }, index) => item(pair, pairOwner, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { pair, owner, hash, last } = entry as PairItem;
    const outcome = await foldMovedPage(ctx, pair, owner,
      () => repairRequestId(ctx, 'moved-pages', { source_id: pair.source_id, slug: pair.old.slug }, `fold:${pair.survivor.revision}:${pair.old.revision}`));
    if (last) await clearApprovedSet(ctx.engine, { command: 'moved-pages', hash });
    return outcome;
  },
  render(details) {
    const held = (details.held as HeldPage[] | undefined) ?? [];
    return [...held.map(page => `  kept ${page.slug} (${page.reason}): ${page.detail}`),
      `  each folded page: soft-deleted, purged after ${details.purge_fuse_hours} h; guide: ${details.docs}`];
  },
};

const changed = (reason: string): RepairItemOutcome => ({ applied: false, outcome: 'changed_since_preview', reason });

/** Whether the pair is still the approved one and still proven moved; otherwise why not. */
export async function movedPairNow(engine: BrainEngine, pair: MovedPair, owner: GhostOwner | null): Promise<string | null> {
  const now = await ghostPageNow(engine, pair.source_id, pair.old.slug);
  if (!now.ghost) return `${pair.old.slug} is no longer a live page whose file is gone (${now.reason})`;
  if (owner && !sameOwner(now.owner, owner)) return 'the source\'s canonical owner changed since the preview';
  if (now.ghost.page_id !== pair.old.page_id || now.ghost.revision !== pair.old.revision || now.ghost.path !== pair.old.path) return `${pair.old.slug} has a new revision or recorded path`;
  const [survivor] = await engine.executeRaw<{ slug: string; revision: string; source_path: string | null }>(`SELECT slug, knowledge_revision::text AS revision, source_path FROM pages
    WHERE source_id=$1 AND id=$2 AND deleted_at IS NULL`, [pair.source_id, pair.survivor.page_id]);
  if (!survivor) return `${pair.survivor.slug} was deleted or purged`;
  if (survivor.slug !== pair.survivor.slug || String(survivor.revision) !== pair.survivor.revision || survivor.source_path !== pair.survivor.path) return `${pair.survivor.slug} has a new revision, slug or recorded path`;
  const context = await sourceContext(engine, pair.source_id);
  if (!context.ok) return 'the source\'s canonical checkout cannot be read';
  const verdict = await readMovedPage(engine, { sourceId: pair.source_id, root: context.root, old: pair.old });
  if (verdict.verdict !== 'moved') return `it is not proven moved any more (${verdict.reason}: ${verdict.detail})`;
  return verdict.survivor.page_id === pair.survivor.page_id && verdict.old_blob === pair.old_blob ? null : 'another page is now the moved one';
}

/** Under both page keys: why the locked pair is no longer the approved one, or null; the old file must still be gone. */
async function pairLocked(tx: BrainEngine, pair: MovedPair): Promise<string | null> {
  const rows = await tx.executeRaw<{ id: number; slug: string; revision: string; source_path: string | null }>(`SELECT id, slug, knowledge_revision::text AS revision, source_path FROM pages
    WHERE source_id=$1 AND id=ANY($2::int[]) AND deleted_at IS NULL`, [pair.source_id, [pair.old.page_id, pair.survivor.page_id]]);
  for (const page of [pair.old, pair.survivor]) {
    const row = rows.find(candidate => Number(candidate.id) === page.page_id);
    if (!row || row.slug !== page.slug || String(row.revision) !== page.revision || row.source_path !== page.path) return `${page.slug} changed`;
  }
  const now = await ghostPageNow(tx, pair.source_id, pair.old.slug);
  return now.ghost ? null : `${pair.old.path} is back or no longer gone (${now.reason})`;
}

/** The write itself, inside the caller's transaction with both page keys held. */
async function applyFold(tx: BrainEngine, pair: MovedPair, incarnation: string): Promise<Record<string, unknown>> {
  const merged = await mergeTwinInto(tx, { sourceId: pair.source_id, incarnation, survivor: { page_id: pair.survivor.page_id, slug: pair.survivor.slug },
    twin: { page_id: pair.old.page_id, slug: pair.old.slug } });
  const versions = await tx.executeRaw('UPDATE page_versions SET page_id=$2 WHERE page_id=$1 RETURNING id', [pair.old.page_id, pair.survivor.page_id]);
  const holdCleared = await clearGitHold(tx, { sourceId: pair.source_id, incarnation, path: pair.old.path, observedAt: pair.observed_at });
  const restore = ['gbrain', 'restore', pair.old.slug, '--source-id', pair.source_id];
  return { status: 'moved_page_folded', source_id: pair.source_id, old_slug: pair.old.slug, old_path: pair.old.path, survivor_slug: pair.survivor.slug, survivor_path: pair.survivor.path,
    move_commit: pair.move_commit, old_blob: pair.old_blob, evidence: pair.evidence, links_moved: merged.links_moved.length, link_ids: merged.links_moved, facts_moved: merged.facts_moved.length,
    transitions_moved: merged.transitions_moved, tags_moved: merged.tags_moved, versions_moved: versions.length, deduplicated: merged.deduplicated, hold_cleared: holdCleared, restore_argv: restore,
    restore_note: `${restore.join(' ')} brings back ${pair.old.slug}'s own text as a database-only page within ${MOVED_PAGES_PURGE_FUSE_HOURS} h; references and versions moved to ${pair.survivor.slug} stay there.` };
}

/** Folds one pair; a managed brain submits it under `requestId()`. Returns the receipt fields on success. */
export async function foldMovedPage(ctx: OperationContext, pair: MovedPair, owner: GhostOwner | null, requestId: () => Promise<string>): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const moved = await movedPairNow(engine, pair, owner);
  if (moved) return changed(moved);
  if (await managedPersistenceEnabled(engine)) {
    const authority = (await maintenancePreflight(engine, pair.source_id))!;
    try {
      const receipt = await submitDatabaseMaintenanceIntent(engine, authority, pair.old.slug, { kind: MOVED_PAGES_INTENT, expected_revision: pair.old.revision, pair, owner }, await requestId());
      return { applied: true, outcome: 'folded', detail: receipt };
    } catch (error) {
      if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed', 'source_changed'].includes(error.code)) return changed(error.message);
      throw error;
    }
  }
  const result = await maintenanceTransaction(engine, async tx => {
    await tx.lockPageKeys([{ sourceId: pair.source_id, slug: pair.survivor.slug }, { sourceId: pair.source_id, slug: pair.old.slug }].sort((a, b) => a.slug.localeCompare(b.slug)));
    const reason = await pairLocked(tx, pair);
    if (reason) return { reason };
    const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [pair.source_id]);
    return { receipt: await applyFold(tx, pair, source!.incarnation) };
  });
  return 'reason' in result ? changed(result.reason!) : { applied: true, outcome: 'folded', detail: result.receipt };
}

/**
 * Preparer for `managed_maintenance_fold_moved_page`, a request on the old page that also holds the moved page's key:
 * re-checks the proof and both pages, publishes no file (the old file is gone, the moved file stays as it is), and
 * re-checks both pages under the locks.
 */
export async function prepareMovedPageFold(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig): Promise<PreparedMutation> {
  const pair = row.intent!.pair as MovedPair | undefined;
  const owner = (row.intent!.owner as GhostOwner | null | undefined) ?? null;
  if (row.authority.remote || !pair || pair.old?.slug !== row.slug || pair.source_id !== row.source_id || pair.old.page_id !== Number(row.page_id) || !pair.survivor) {
    throw opError('invalid_params', 'The moved-page fold intent does not name its pages.',
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} does not name the pair it folds, so nothing changed. Preview the repair again.`, { fix: previewFix(row.source_id) });
  }
  const refuse = (reason: string) => opError('revision_conflict', 'The moved-page pair changed since it was read.',
    `Pages ${row.slug} and ${pair.survivor.slug} in source ${row.source_id} changed (${reason}), so request ${row.request_id} folded nothing. Preview the repair again.`, { fix: previewFix(row.source_id) });
  const moved = await movedPairNow(engine, pair, owner);
  if (moved) throw refuse(moved);
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  const core = await prepareCoreGuard(engine, { row, snapshot: await engine.readPageSnapshot(row.slug, { sourceId: row.source_id }), incoming: null });
  const prepared: PreparedMutation = { observedRevision: pair.old.revision, additionalPageKeys: [{ sourceId: row.source_id, slug: pair.survivor.slug }],
    ...(core ? { exclusiveSources: core.exclusiveSources } : {}),
    databaseOnlyReason: 'origin_twin',
    validate: async tx => {
      await authorizeWrite(tx, row.authority, 'submit_job', row.slug);
      const locked = await pairLocked(tx, pair);
      if (locked) throw refuse(locked);
      prepared.databaseOnlyWarning = `${row.slug} is folded into ${pair.survivor.slug} and hidden; ${pair.survivor.path} is untouched, and ${row.slug} resolves to ${pair.survivor.slug} as an alias.`;
    },
    apply: async tx => applyFold(tx, pair, row.source_incarnation) };
  return prepared;
}
