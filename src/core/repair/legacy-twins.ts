/**
 * `gbrain repair legacy-twins --source <id>` (#6885): converge the page pairs older syncs forked before #6857.
 *
 * A pair is a legacy page (live, no recorded origin, not database-only, a slug the current `slugifyPath` folds
 * differently: an older gbrain imported the file under its raw name) and its twin (live, the folded slug, recording
 * the file as its origin). Since #6727 sync imports a never-forked file into the legacy page; already forked pairs
 * stay forked, and soft-deleting the twin by hand withdraws the file because no other live page records it.
 *
 * Explicit-only, preview-bound and destructive. The preview (read-only, bounded like the ghost-page scan) lists
 * every pair with both ids, slugs and revisions, the recorded path and whether the two pages hold the same content,
 * bound to the canonical owner it ran under; a pair it does not merge on its own is listed as a decision with the
 * commands a person uses to decide (two-sided content, several legacy candidates for one twin, a twin whose file is
 * missing or differs from it, withdrawn claims on the twin, a file at the twin's slug path, a twin row the merge would
 * lose). `--apply --expect <hash>
 * --yes` merges exactly the approved pairs, one coordinated write per pair (`managed_maintenance_merge_legacy_twin`
 * on the twin, holding the legacy page's key too; an unmanaged brain does the same in one maintenance transaction):
 *
 *   1. the legacy page records the file as its origin, keeping its id, slug, links, timeline, versions and aliases;
 *   2. the shared twin merge (#6948, persistence/twin-merge.ts `mergeTwinInto`, the one `gbrain repair origin-twins`
 *      uses) moves the twin's links in every role and their dated transitions (links between the pair stay), timeline
 *      rows, raw data, file attachments, user-added tags, slug aliases and facts other pages assert about it to the
 *      legacy page, and the twin's slug becomes a `slug_aliases` row for it. A twin row that would land on a legacy row
 *      saying something different is a decision (`twin_evidence_conflicts`), never dropped;
 *   3. the twin's sync import record moves to the legacy page with its post-write revision, so the next sync sees
 *      the file and the page both unchanged (the classifier's `matched`) instead of an unproven drift;
 *   4. the twin is soft-deleted as a shared origin: the file is untouched. Its tombstone forgets the file
 *      (`source_path` and `source_uri` cleared, marked `origin_twin` so a restore writes no file), so the 72 h
 *      retention purge removes it database-only instead of
 *      refusing it forever as a page whose file another live page records; a pair whose twin slug path holds a
 *      file is a decision, so that purge has no file to compare or remove.
 *
 * Kept on the twin (they go with it when it is purged, and come back if it is restored): its import-owned tags, chunks and
 * embeddings, page versions, the facts and takes its own body projects and its derived per-page state. Both pages
 * hold the same content, so the legacy page already has the same projections.
 *
 * Apply re-checks each pair against the approved one (ids, slugs, revisions, recorded path, owner, same content,
 * the file still agreeing with the twin) and skips a moved pair `changed_since_preview`. Refuses off the owner
 * host (`not_owner_host`), when the checkout cannot be read (`legacy_twins_storage_unknown`) and, under the sync
 * mass-delete valve, when the pairs are more than half of the source's file-backed pages
 * (`legacy_twin_mass_merge_refused` unless `GBRAIN_ALLOW_MASS_RECONCILE=1`). Trusted local CLI only.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import { isOpPageSlug } from '../ops/context.ts';
import { resolveSourceLocalFilePath } from '../markdown.ts';
import { slugifyPath } from '../sync.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { prepareCoreGuard } from '../persistence/core-guard.ts';
import { existingLocalHostId } from '../persistence/identity.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { liveFileDrift } from '../persistence/drift-conflicts.ts';
import { maintenancePreflight, submitMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { readSyncImportProvenance, recordSyncImportProvenance } from '../persistence/sync-holds.ts';
import { bindOrigin } from '../persistence/origin-guard.ts';
import { mergeTwinInto, twinMergeConflicts } from '../persistence/twin-merge.ts';
import { MASS_RECONCILE_MIN_PAGES, MASS_RECONCILE_RATIO, massReconcileAllowed } from '../sync-reconcile.ts';
import type { GhostOwner } from '../ghost-pages.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

export const LEGACY_TWINS_INTENT = 'managed_maintenance_merge_legacy_twin';
/** Pairs and decisions one preview lists; a larger set is applied in rounds (preview, apply, preview again). */
export const LEGACY_TWINS_LIMIT = 1000;
/** Pages without a recorded origin the scan reads per source. */
export const LEGACY_TWINS_SCAN_LIMIT = 250_000;
export const LEGACY_TWINS_PURGE_FUSE_HOURS = 72;
const BATCH = 10_000;
const DOCS = 'docs/guides/repair.md#legacy-twins';

export interface TwinPage { page_id: number; slug: string; revision: string }
export interface LegacyTwinPair { source_id: string; legacy: TwinPage; twin: TwinPage; path: string; import_record: boolean }
export type TwinDecisionReason = 'content_differs' | 'several_legacy' | 'file_missing' | 'file_drift' | 'file_unverified' | 'twin_slug_path_occupied'
  | 'legacy_records_file_uri' | 'twin_has_withdrawals' | 'twin_slug_unwritable' | 'twin_evidence_conflicts';
export interface LegacyTwinDecision { source_id: string; reason: TwinDecisionReason; twin: TwinPage; legacy: TwinPage[]; path: string; commands: string[] }

interface ApprovedPair extends LegacyTwinPair { owner: GhostOwner; selection: string[] }
interface PairItem extends RepairItem { pair: LegacyTwinPair; owner: GhostOwner; hash: string; last: boolean }
interface PageRow { id: number | string; slug: string; revision: string; content_hash: string | null; source_path: string | null; source_uri: string | null }
type OwnerContext = { ok: true; root: string; owner: GhostOwner } | { ok: false; status: 'unknown' | 'not_applicable'; reason: string };

export const legacyTwinsPreviewCommand = (sourceId: string) => `gbrain repair legacy-twins --source ${sourceId}`;
const previewFix = (sourceId: string) => readFix('Previews the legacy twin pairs of the source again; writes nothing.',
  { argv: ['gbrain', 'repair', 'legacy-twins', '--source', sourceId, '--json'] });
const writerStatusFix = (sourceId: string) => readFix('Shows the source\'s canonical binding and owner host, read-only.',
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });

/** The consent payload of `--apply --expect <hash>` (registry `consentText`). */
export const LEGACY_TWINS_CONSENT_TEXT = {
  what: 'Merge each previewed legacy twin pair onto its legacy page and soft-delete the twin',
  why: 'The preview listed each pair with both pages, their revisions and the file the twin records; both pages hold the same content, so the legacy page (its id, links, timeline and history) takes over the file and the twin stops duplicating it.',
  risk: `The legacy page records the file; the twin's links, timeline rows and aliases move to it and the twin's slug becomes an alias of it. The twin is soft-deleted (the file stays) and purged by the autopilot purge phase ${LEGACY_TWINS_PURGE_FUSE_HOURS} h later. Restoring the twin brings back a page that records no file; its moved rows stay on the legacy page.`,
  user_message: `Merge the previewed legacy twin pairs onto their legacy pages? Each twin is soft-deleted (its file stays) and purged after ${LEGACY_TWINS_PURGE_FUSE_HOURS} h`,
};

/** The sync valve (#2828) over a source's file-backed pages. */
export function massTwins(pairs: number, fileBacked: number): boolean {
  return fileBacked > MASS_RECONCILE_MIN_PAGES && pairs > fileBacked * MASS_RECONCILE_RATIO;
}

const sameOwner = (a: GhostOwner | undefined, b: GhostOwner) => !!a && a.host_id === b.host_id && a.worktree_id === b.worktree_id
  && a.owner_epoch === b.owner_epoch && a.source_incarnation === b.source_incarnation;
const page = (row: PageRow): TwinPage => ({ page_id: Number(row.id), slug: row.slug, revision: String(row.revision) });

async function ownerContext(engine: BrainEngine, sourceId: string): Promise<OwnerContext> {
  const hostId = existingLocalHostId();
  const binding = await getWorktreeBinding(engine, sourceId, hostId);
  if (!binding) return { ok: false, status: 'not_applicable', reason: 'not_applicable' };
  if (!hostId || !binding.local_path || binding.owner_host_id !== hostId || binding.state !== 'active') return { ok: false, status: 'not_applicable', reason: 'not_owner_host' };
  const root = join(binding.local_path, binding.relative_path);
  try {
    if (!statSync(root).isDirectory()) return { ok: false, status: 'unknown', reason: 'storage_unavailable' };
  } catch {
    return { ok: false, status: 'unknown', reason: 'storage_unavailable' };
  }
  return { ok: true, root, owner: { host_id: hostId, worktree_id: binding.worktree_id, owner_epoch: String(binding.owner_epoch), source_incarnation: binding.source_incarnation } };
}

function ownerRefusal(sourceId: string, context: Extract<OwnerContext, { ok: false }>): OperationError {
  if (context.status === 'unknown') return opError('legacy_twins_storage_unknown', `Legacy twin pairs of source ${sourceId} cannot be checked: its canonical root is missing or is not a readable directory.`,
    `Nothing was listed or changed: whether a twin's file is still there is only known from the checkout. Inspect the source's checkout on the owner host (writer status shows its root), fix it, then preview again: ${legacyTwinsPreviewCommand(sourceId)}`,
    { reason: context.reason, fix: writerStatusFix(sourceId), docs: DOCS });
  return opError('not_owner_host', `Legacy twin pairs of source ${sourceId} can only be checked and merged on its canonical owner host.`,
    context.reason === 'not_applicable'
      ? `Source ${sourceId} has no canonical checkout, so no page records a file a twin could share; nothing was listed or changed.`
      : `This host does not own source ${sourceId}'s active canonical worktree, so it cannot check the files the twins record; nothing was listed or changed. Run ${legacyTwinsPreviewCommand(sourceId)} in a terminal on the owner host (writer status names it).`,
    { reason: context.reason, fix: writerStatusFix(sourceId), docs: DOCS });
}

export function massRefusal(sourceId: string, pairs: number, fileBacked: number): OperationError {
  return opError('legacy_twin_mass_merge_refused', `Refusing to merge ${pairs} legacy twin pair(s) of source ${sourceId}: that soft-deletes more than ${Math.round(MASS_RECONCILE_RATIO * 100)}% of its ${fileBacked} file-backed page(s).`,
    'That many twins at once almost always means the source was re-imported under another slug fold or the wrong checkout is bound, not a backlog of forked pairs; nothing was changed. Check the source and its checkout on the owner host first. If merging these pairs is genuinely intended, ask the user, then rerun the same apply command with GBRAIN_ALLOW_MASS_RECONCILE=1.',
    { fix: writerStatusFix(sourceId), docs: DOCS });
}

/** What a person runs to decide a pair the repair does not merge on its own. */
function decisionCommands(sourceId: string, reason: TwinDecisionReason, twin: TwinPage, legacy: TwinPage[]): string[] {
  const show = [twin, ...legacy].map(p => `gbrain get --source ${sourceId} -- '${p.slug}'`);
  const preview = legacyTwinsPreviewCommand(sourceId);
  switch (reason) {
    case 'content_differs': return [...show, `Keep the legacy page: make its content and the twin's the same (edit the file and sync, or edit the legacy page), then run ${preview}.`,
      `Keep the twin instead: gbrain delete '${legacy[0]!.slug}' --source-id ${sourceId} (its id, links and history go with it).`];
    case 'several_legacy': return [...show, `Keep one legacy page: soft-delete the others with gbrain delete '<slug>' --source-id ${sourceId}, then run ${preview}.`];
    case 'file_missing': return [`gbrain repair ghost-pages --source ${sourceId} (the twin's file is gone: restore it from Git and sync, or remove the twin), then run ${preview}.`];
    case 'file_drift': return [`gbrain repair file-drift --source ${sourceId} --slug ${twin.slug} --prefer file (or --prefer database), then run ${preview}.`];
    case 'file_unverified': return [`gbrain sources writer status --source ${sourceId} --json (check the checkout), then run ${preview}.`];
    case 'twin_slug_path_occupied': return [`A file exists at the twin's own slug path (${twin.slug}.md), which the twin's purge would compare or remove: rename or remove that file and commit, sync, then run ${preview}.`];
    case 'legacy_records_file_uri': return [...show, `The legacy page records a file URI of its own; decide which file it belongs to with gbrain sources reconcile ${sourceId} '${legacy[0]!.slug}' --brain host --preview.`];
    case 'twin_has_withdrawals': return [...show, `Claims were forgotten on ${twin.slug}: forget the same claims on '${legacy[0]!.slug}' (gbrain forget), or soft-delete the twin by hand, then run ${preview}.`];
    case 'twin_slug_unwritable': return show;
    case 'twin_evidence_conflicts': return [...show, `The twin holds a link, relationship date, timeline entry or raw data row the legacy page holds differently, which the merge would lose: make them agree (or soft-delete the twin by hand), then run ${preview}.`];
  }
}

/** One pair's verdict: null when it merges, else the decision that holds it. */
async function pairVerdict(engine: BrainEngine, root: string, sourceId: string, twin: PageRow, legacy: PageRow[]): Promise<TwinDecisionReason | null> {
  if (legacy.length > 1) return 'several_legacy';
  const only = legacy[0]!;
  if (!isOpPageSlug(twin.slug)) return 'twin_slug_unwritable';
  if (only.source_uri?.startsWith('file:')) return 'legacy_records_file_uri';
  if (!twin.content_hash || twin.content_hash !== only.content_hash) return 'content_differs';
  const drift = await liveFileDrift(engine, sourceId, twin.slug);
  if (drift.reason === 'canonical_file_missing') return 'file_missing';
  if (drift.reason === 'file_database_drift') return 'file_drift';
  if (drift.reason !== 'agrees') return 'file_unverified';
  if (existsSync(resolveSourceLocalFilePath(root, undefined, twin.slug, undefined) ?? join(root, `${twin.slug}.md`))) return 'twin_slug_path_occupied';
  const [withdrawn] = await engine.executeRaw('SELECT 1 FROM fact_withdrawals WHERE source_id=$1 AND subject=$2 LIMIT 1', [sourceId, twin.slug]);
  if (withdrawn) return 'twin_has_withdrawals';
  return (await twinMergeConflicts(engine, Number(only.id), Number(twin.id))).length ? 'twin_evidence_conflicts' : null;
}

export interface LegacyTwinScan { owner: GhostOwner; root: string; pairs: LegacyTwinPair[]; decisions: LegacyTwinDecision[]; file_backed: number; inspected: number; truncated: boolean }

const PAGE_COLUMNS = 'id, slug, knowledge_revision::text AS revision, content_hash, source_path, source_uri';

/**
 * Every pair of one source, in legacy page id order: pages without a recorded origin (and no database-only stamp)
 * whose slug folds differently are read in id batches (at most `LEGACY_TWINS_SCAN_LIMIT`), and the live pages at
 * their folded slugs that record a file are their twins. At most `LEGACY_TWINS_LIMIT` pairs and decisions.
 */
export async function scanLegacyTwins(engine: BrainEngine, sourceId: string): Promise<LegacyTwinScan> {
  const context = await ownerContext(engine, sourceId);
  if (!context.ok) throw ownerRefusal(sourceId, context);
  const byFold = new Map<string, PageRow[]>();
  let inspected = 0, truncated = false, after = 0;
  for (;;) {
    const rows = await engine.executeRaw<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND COALESCE(btrim(source_path), '')='' AND database_only_reason IS NULL AND id > $2 ORDER BY id LIMIT ${BATCH}`, [sourceId, after]);
    for (const row of rows) {
      if (inspected >= LEGACY_TWINS_SCAN_LIMIT) { truncated = true; break; }
      inspected++;
      const folded = slugifyPath(row.slug);
      if (folded !== row.slug) byFold.set(folded, [...byFold.get(folded) ?? [], row]);
    }
    if (rows.length < BATCH || truncated) break;
    after = Number(rows[rows.length - 1]!.id);
  }
  const pairs: LegacyTwinPair[] = [], decisions: LegacyTwinDecision[] = [];
  const folds = [...byFold.keys()];
  for (let i = 0; i < folds.length && !(pairs.length + decisions.length >= LEGACY_TWINS_LIMIT); i += BATCH) {
    const twins = await engine.executeRaw<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND slug=ANY($2::text[]) AND COALESCE(btrim(source_path), '')<>'' ORDER BY id `, [sourceId, folds.slice(i, i + BATCH)]);
    for (const twin of twins) {
      if (pairs.length + decisions.length >= LEGACY_TWINS_LIMIT) { truncated = true; break; }
      const legacy = byFold.get(twin.slug)!;
      const reason = await pairVerdict(engine, context.root, sourceId, twin, legacy);
      if (reason) {
        decisions.push({ source_id: sourceId, reason, twin: page(twin), legacy: legacy.map(page), path: twin.source_path!, commands: decisionCommands(sourceId, reason, page(twin), legacy.map(page)) });
        continue;
      }
      const record = await readSyncImportProvenance(engine, sourceId, context.owner.source_incarnation, Number(twin.id));
      pairs.push({ source_id: sourceId, legacy: page(legacy[0]!), twin: page(twin), path: twin.source_path!, import_record: record !== null });
    }
  }
  pairs.sort((a, b) => a.legacy.page_id - b.legacy.page_id);
  const [counted] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND COALESCE(btrim(source_path), '')<>''`, [sourceId]);
  return { owner: context.owner, root: context.root, pairs, decisions, file_backed: Number(counted?.n ?? 0), inspected, truncated };
}

function hashParts(scope: RepairScope, owner: GhostOwner, pairs: LegacyTwinPair[], decisions: LegacyTwinDecision[]) {
  return { kind: 'legacy-twins-v1', brain_id: scope.brain_id, selection: { source_ids: scope.source_ids }, owner, pairs,
    decisions: decisions.map(({ commands: _commands, ...decision }) => decision) };
}

function item(pair: LegacyTwinPair, owner: GhostOwner, hash: string, last: boolean): PairItem {
  return { cursor: { phase: 1, id: pair.legacy.page_id }, source_id: pair.source_id, slug: pair.twin.slug, chars: 0, action: 'merge:legacy_twin', pair, owner, hash, last };
}

const pairLine = (p: LegacyTwinPair) => `legacy ${p.legacy.slug} (id ${p.legacy.page_id}, revision ${p.legacy.revision}) takes over ${p.path} from twin ${p.twin.slug} (id ${p.twin.page_id}, revision ${p.twin.revision}); content matches`
  + (p.import_record ? '' : '; the twin has no sync import record, so the next sync compares the file with the legacy page again');

export const legacyTwinsRepair: RepairHandler = {
  kind: 'legacy-twins',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (opts?.remote === true) throw trustedCliRequired('gbrain repair legacy-twins runs only from the trusted local CLI on the brain host.');
    if (scope.source_ids.length !== 1) {
      throw opError('invalid_params', 'gbrain repair legacy-twins needs --source <id>.',
        'Legacy twin pairs are checked on each source\'s own canonical owner host; name one source, e.g. gbrain repair legacy-twins --source default.',
        { fix: readFix('Lists the registered sources.', { argv: ['gbrain', 'sources', 'list', '--json'] }), docs: DOCS });
    }
    const sourceId = scope.source_ids[0]!;
    const command = legacyTwinsPreviewCommand(sourceId);
    const scan = await scanLegacyTwins(engine, sourceId);
    const mass = massTwins(scan.pairs.length, scan.file_backed);
    if (!opts?.apply) {
      const hash = previewHash(hashParts(scope, scan.owner, scan.pairs, scan.decisions));
      if (scan.pairs.length) await saveApprovedSet<ApprovedPair>(engine, { command: 'legacy-twins', hash },
        scan.pairs.map(pair => ({ ...pair, owner: scan.owner, selection: scope.source_ids })));
      const warnings = [
        ...(mass ? [`${scan.pairs.length} pair(s) against ${scan.file_backed} file-backed page(s) (more than ${Math.round(MASS_RECONCILE_RATIO * 100)}%): the apply refuses (legacy_twin_mass_merge_refused) unless GBRAIN_ALLOW_MASS_RECONCILE=1; check the source first.`] : []),
        ...(scan.truncated ? [`More pairs may exist past the first ${LEGACY_TWINS_LIMIT} listed; apply this set, then preview again.`] : []),
        ...(scan.decisions.length ? [`${scan.decisions.length} pair(s) need a person's decision and are never merged by the apply; each lists the commands to decide it.`] : []),
        ...(scan.pairs.length ? [LEGACY_TWINS_CONSENT_TEXT.risk] : []),
      ];
      return { warnings, items: scan.pairs.map((pair, index) => item(pair, scan.owner, hash, index === scan.pairs.length - 1)), preview_hash: hash,
        residuals: { pairs: scan.pairs.length, decisions: scan.decisions.length, file_backed: scan.file_backed, inspected: scan.inspected },
        listing: [...scan.pairs.map(pair => ({ item: `${pair.source_id}:${pair.legacy.slug}`, class: 'merge', detail: pairLine(pair) })),
          ...scan.decisions.map(decision => ({ item: `${decision.source_id}:${decision.twin.slug}`, class: `decision:${decision.reason}`,
            detail: `twin ${decision.twin.slug} (id ${decision.twin.page_id}) records ${decision.path}; legacy ${decision.legacy.map(p => `${p.slug} (id ${p.page_id})`).join(', ')}` }))],
        details: { decisions: scan.decisions, mass_merge: mass, truncated: scan.truncated, purge_fuse_hours: LEGACY_TWINS_PURGE_FUSE_HOURS, docs: DOCS } };
    }
    if (!opts.expect) {
      throw opError('invalid_params', 'gbrain repair legacy-twins --apply merges only the set a preview printed.',
        `Preview first: ${command} — then, after the user agrees, run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`,
        { fix: previewFix(sourceId), docs: DOCS });
    }
    const approved = await loadApprovedSet<ApprovedPair>(engine, { command: 'legacy-twins', hash: opts.expect, previewCommand: command,
      emptyHash: async () => previewHash(hashParts(scope, scan.owner, [], scan.decisions)) });
    if (approved.items.some(pair => JSON.stringify(pair.selection) !== JSON.stringify(scope.source_ids) || !sameOwner(scan.owner, pair.owner))) {
      throw previewChangedError(opts.expect, command);
    }
    if (massTwins(approved.items.length, scan.file_backed) && !massReconcileAllowed()) throw massRefusal(sourceId, approved.items.length, scan.file_backed);
    const items = approved.items.map(({ selection: _selection, owner, ...pair }, index) => item(pair, owner, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { pair, owner, hash, last } = entry as PairItem;
    const outcome = await mergeLegacyTwin(ctx, pair, owner,
      () => repairRequestId(ctx, 'legacy-twins', { source_id: pair.source_id, slug: pair.twin.slug }, `${pair.legacy.revision}:${pair.twin.revision}`));
    if (last) await clearApprovedSet(ctx.engine, { command: 'legacy-twins', hash });
    return outcome;
  },
  render(details) {
    const decisions = (details.decisions as LegacyTwinDecision[] | undefined) ?? [];
    return [...decisions.flatMap(decision => [`  decision ${decision.reason}: twin ${decision.twin.slug} records ${decision.path}; legacy ${decision.legacy.map(p => p.slug).join(', ')}`,
      ...decision.commands.map(command => `    ${command}`)]),
      `  each merged twin: soft-deleted (its file stays), purged after ${details.purge_fuse_hours} h; guide: ${details.docs}`];
  },
};

const changed = (reason: string): RepairItemOutcome => ({ applied: false, outcome: 'changed_since_preview', reason });

/** Whether the pair is still the approved one under the approved owner; otherwise why not. */
async function pairNow(engine: BrainEngine, pair: LegacyTwinPair, owner: GhostOwner): Promise<string | null> {
  const context = await ownerContext(engine, pair.source_id);
  if (!context.ok || !sameOwner(context.owner, owner)) return 'the source\'s canonical owner changed since the preview';
  const rows = await engine.executeRaw<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages
    WHERE source_id=$1 AND id=ANY($2::bigint[]) AND deleted_at IS NULL AND database_only_reason IS NULL`, [pair.source_id, [pair.legacy.page_id, pair.twin.page_id]]);
  const legacy = rows.find(row => Number(row.id) === pair.legacy.page_id), twin = rows.find(row => Number(row.id) === pair.twin.page_id);
  if (!legacy || !twin) return 'one of the two pages was deleted, purged or stamped database-only';
  if (legacy.slug !== pair.legacy.slug || twin.slug !== pair.twin.slug) return 'one of the two pages was renamed';
  if (String(legacy.revision) !== pair.legacy.revision || String(twin.revision) !== pair.twin.revision) return 'one of the two pages has a new revision';
  if ((legacy.source_path ?? '').trim() || twin.source_path !== pair.path) return 'a recorded origin changed';
  const reason = await pairVerdict(engine, context.root, pair.source_id, twin, [legacy]);
  return reason ? `the pair needs a decision now (${reason})` : null;
}

/** Merges one approved pair; a managed brain submits it under `requestId()`. */
export async function mergeLegacyTwin(ctx: OperationContext, pair: LegacyTwinPair, owner: GhostOwner, requestId: () => Promise<string>): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const moved = await pairNow(engine, pair, owner);
  if (moved) return changed(moved);
  if (await managedPersistenceEnabled(engine)) {
    const authority = (await maintenancePreflight(engine, pair.source_id))!;
    try {
      await submitMaintenanceIntent(engine, authority, pair.twin.slug, { kind: LEGACY_TWINS_INTENT, expected_revision: pair.twin.revision, pair, owner }, await requestId());
    } catch (error) {
      if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed', 'source_changed'].includes(error.code)) return changed(error.message);
      throw error;
    }
    return { applied: true, outcome: 'merged' };
  }
  const locked = await maintenanceTransaction(engine, async tx => {
    await tx.lockPageKeys([{ sourceId: pair.source_id, slug: pair.legacy.slug }, { sourceId: pair.source_id, slug: pair.twin.slug }]);
    const reason = await pairLocked(tx, pair);
    if (reason) return reason;
    const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [pair.source_id]);
    await applyTwinMerge(tx, pair, source!.incarnation);
    return null;
  });
  return locked ? changed(locked) : { applied: true, outcome: 'merged' };
}

/** Under the page keys: why the locked pair is no longer the approved one, or null. */
async function pairLocked(tx: BrainEngine, pair: LegacyTwinPair): Promise<string | null> {
  const legacy = await tx.readPageSnapshot(pair.legacy.slug, { sourceId: pair.source_id });
  const twin = await tx.readPageSnapshot(pair.twin.slug, { sourceId: pair.source_id });
  if (!legacy || Number(legacy.page.id) !== pair.legacy.page_id || legacy.revision !== pair.legacy.revision || (legacy.page.source_path ?? '').trim()) return 'the legacy page changed';
  if (!twin || Number(twin.page.id) !== pair.twin.page_id || twin.revision !== pair.twin.revision || twin.page.source_path !== pair.path) return 'the twin changed';
  return null;
}

/**
 * The merge itself, inside the caller's transaction with both page keys held: the shared twin merge (#6948,
 * persistence/twin-merge.ts) moves what other pages and the twin's own rows say about the twin to the legacy page and
 * soft-deletes the twin with its recorded origin cleared; then the legacy page records the file and the twin's import
 * record follows with the legacy page's post-write revision.
 */
async function applyTwinMerge(tx: BrainEngine, pair: LegacyTwinPair, incarnation: string): Promise<Record<string, unknown>> {
  const { source_id: sourceId, legacy, twin } = pair;
  const [twinRow] = await tx.executeRaw<{ source_uri: string | null }>('SELECT source_uri FROM pages WHERE id=$1', [twin.page_id]);
  const record = await readSyncImportProvenance(tx, sourceId, incarnation, twin.page_id);
  const merged = await mergeTwinInto(tx, { sourceId, incarnation, survivor: legacy, twin });
  await bindOrigin(tx, { sourceId, pageId: legacy.page_id, sourcePath: pair.path });
  await tx.executeRaw('UPDATE pages SET source_uri=COALESCE(source_uri, $2) WHERE id=$1', [legacy.page_id, twinRow?.source_uri ?? null]);
  if (record) {
    const [now] = await tx.executeRaw<{ revision: string }>('SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1', [legacy.page_id]);
    await recordSyncImportProvenance(tx, { ...record, page_id: legacy.page_id, revision: now!.revision });
  }
  return { status: 'merged', legacy_slug: legacy.slug, twin_slug: twin.slug, source_id: sourceId, links_moved: merged.links_moved.length, facts_moved: merged.facts_moved.length,
    import_record_moved: record !== null };
}

/**
 * Preparer for `managed_maintenance_merge_legacy_twin`, a request on the twin that also holds the legacy page's key:
 * re-checks the pair under the approved owner, publishes no file (the file already holds both pages' content and
 * stays), and re-checks both pages under the publication locks before the merge.
 */
export async function prepareLegacyTwinMerge(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig): Promise<PreparedMutation> {
  const pair = row.intent!.pair as LegacyTwinPair | undefined;
  const owner = row.intent!.owner as GhostOwner | undefined;
  if (!pair || !owner || pair.twin.slug !== row.slug || pair.source_id !== row.source_id || pair.twin.page_id !== Number(row.page_id)) {
    throw opError('invalid_params', 'The legacy twin merge intent does not name its pages.',
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} does not name the pair it merges, so nothing changed. Preview the repair again and apply the new preview after the user agrees.`,
      { fix: previewFix(row.source_id) });
  }
  const refuse = (reason: string) => opError('revision_conflict', 'The legacy twin pair changed since the preview.',
    `Pages ${pair.legacy.slug} and ${row.slug} in source ${row.source_id} changed after the preview (${reason}), so request ${row.request_id} merged nothing. Preview the repair again and apply the new preview after the user agrees.`,
    { fix: previewFix(row.source_id) });
  const moved = await pairNow(engine, pair, owner);
  if (moved) throw refuse(moved);
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  const core = await prepareCoreGuard(engine, { row, snapshot: await engine.readPageSnapshot(row.slug, { sourceId: row.source_id }), incoming: null });
  const prepared: PreparedMutation = { observedRevision: pair.twin.revision, additionalPageKeys: [{ sourceId: row.source_id, slug: pair.legacy.slug }],
    ...(core ? { exclusiveSources: core.exclusiveSources } : {}),
    databaseOnlyReason: 'shared_origin',
    validate: async tx => {
      await authorizeWrite(tx, row.authority, 'submit_job', row.slug);
      const locked = await pairLocked(tx, pair);
      if (locked) throw refuse(locked);
      prepared.databaseOnlyWarning = `Twin ${row.slug} is hidden; ${pair.path} is untouched and now recorded by ${pair.legacy.slug}, which keeps its id, links and history; ${row.slug} resolves to it as an alias.`;
    },
    apply: async tx => applyTwinMerge(tx, pair, row.source_incarnation) };
  return prepared;
}
