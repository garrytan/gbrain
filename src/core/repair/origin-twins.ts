/**
 * `gbrain repair origin-twins --source <id>` (#6948): resolve live pages that record the same origin (`source_path`).
 *
 * Explicit-only, preview-bound, trusted local CLI on the source's owner host. The preview lists every twin group of the
 * source (the stored spelling, and the legacy `<scope>/<origin>` spelling of a scoped source-root source), each with
 * the shared verdict (`decideOriginTwins`, persistence/origin-twins.ts): verified duplicates are `resolve` items, any
 * other group is a decision listed with its reason and the commands a person uses. `--apply --expect <hash> --yes`
 * resolves exactly the approved items, one coordinated write per twin (`managed_maintenance_resolve_origin_twin`; an
 * unmanaged brain does the same in one maintenance transaction):
 *
 * - `merge` (verified duplicates, also what the sync-time heal runs): `mergeTwinInto` re-points what other pages say
 *   about the twin to the survivor, records the twin's slug as an alias, clears its origin, marks it database-only
 *   (`origin_twin`, so a restore writes no file and the purge removes none) and soft-deletes it;
 * - `detach` (a person's `--slug <keep>` choice on a held group): the other claimants forget the file and are marked
 *   `origin_twin`; they stay live with their content, links and history, so nothing is lost.
 *
 * Re-checked under both page keys (ids, slugs, revisions, both still claimants, a merge's verdict still `resolve`);
 * a moved pair is skipped `changed_since_preview`. Refused off the owner host, and when the planned twins are over
 * half of the source's file-backed pages (`GBRAIN_ALLOW_MASS_RECONCILE=1` overrides). Once no group is left in the
 * brain, the apply builds `pages_live_origin_key` (persistence/origin-index.ts).
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { realpathSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { prepareCoreGuard } from '../persistence/core-guard.ts';
import { existingLocalHostId } from '../persistence/identity.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { decideOriginTwins, ORIGIN_TWIN_REASON, readOriginClaimants, slugPathOccupied, type OriginClaimant, type OriginConflictReason, type OriginTwinVerdict } from '../persistence/origin-twins.ts';
import { mergeTwinInto, twinMergeConflicts } from '../persistence/twin-merge.ts';
import { buildOriginIndexIfClean, originTwinsRepairCommand } from '../persistence/origin-index.ts';
import { legacySyncOrigin, sameSyncOrigin, syncOriginPath, type SyncOriginScope } from '../persistence/sync-origin.ts';
import { frontmatterIdentity } from '../sync-rename-identity.ts';
import { scannerSlugRootMode } from '../write-through.ts';
import { syncGit } from '../persistence/sync-discovery.ts';
import { MASS_RECONCILE_MIN_PAGES, MASS_RECONCILE_RATIO, massReconcileAllowed } from '../sync-reconcile.ts';
import type { GhostOwner } from '../ghost-pages.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

export const ORIGIN_TWINS_INTENT = 'managed_maintenance_resolve_origin_twin';
/** Groups one preview lists; a larger set is applied in rounds (preview, apply, preview again). */
export const ORIGIN_TWINS_LIMIT = 1000;
export const ORIGIN_TWINS_PURGE_FUSE_HOURS = 72;
/** The migration that builds the index; the repair builds it the same way once the brain is clean. */
const ORIGIN_INDEX_MIGRATION = 257;
const DOCS = 'docs/guides/repair.md#origin-twins';

export interface TwinPage { page_id: number; slug: string; revision: string }
export type OriginTwinMode = 'merge' | 'detach';
/** One coordinated write: the twin gives up the origin to the survivor. */
export interface OriginTwinPair { source_id: string; source_path: string; twin_path: string; survivor: TwinPage; twin: TwinPage; mode: OriginTwinMode }
export interface OriginTwinGroup { source_id: string; source_path: string; canonical: string; claimants: Array<TwinPage & { source_path: string }>; reason: OriginConflictReason | null }

interface ApprovedPair extends OriginTwinPair { owner: GhostOwner; selection: string[] }
interface PairItem extends RepairItem { pair: OriginTwinPair; owner: GhostOwner; hash: string; last: boolean }
type OwnerContext = { ok: true; root: string; gitRoot: string; scope: SyncOriginScope; owner: GhostOwner; commit: string | null } | { ok: false; reason: 'not_applicable' | 'not_owner_host' };

const previewFix = (sourceId: string) => readFix('Previews the duplicate-origin groups of the source again; writes nothing.', { argv: ['gbrain', 'repair', 'origin-twins', '--source', sourceId, '--json'] });

/** The consent payload of `--apply --expect <hash>` (registry `consentText`). */
export const ORIGIN_TWINS_CONSENT_TEXT = {
  what: 'Resolve each previewed duplicate-origin group: the canonical page keeps the file; each other page gives it up',
  why: 'Several live pages record the same file, which held that file out of every sync; the preview listed each group with its pages, revisions and verdict.',
  risk: `A merged twin's inbound links, aliases, tags and facts others assert move to the surviving page, its slug becomes an alias, and it is soft-deleted (the file stays) and purged ${ORIGIN_TWINS_PURGE_FUSE_HOURS} h later; gbrain restore brings back its text as a database-only page, and moved references stay on the survivor. A detached page only forgets the file and stays live.`,
  user_message: `Resolve the previewed duplicate-origin groups? Merged twins are soft-deleted (the file stays) and purged after ${ORIGIN_TWINS_PURGE_FUSE_HOURS} h`,
};

/** The sync mass-delete valve (#2828) over planned twin deletions (pages, not groups). */
export function massTwins(twins: number, fileBacked: number): boolean {
  return fileBacked > MASS_RECONCILE_MIN_PAGES && twins > fileBacked * MASS_RECONCILE_RATIO;
}

const sameOwner = (a: GhostOwner | undefined, b: GhostOwner) => !!a && a.host_id === b.host_id && a.worktree_id === b.worktree_id
  && a.owner_epoch === b.owner_epoch && a.source_incarnation === b.source_incarnation;

export async function originOwnerContext(engine: BrainEngine, sourceId: string): Promise<OwnerContext> {
  const hostId = existingLocalHostId();
  const binding = await getWorktreeBinding(engine, sourceId, hostId);
  if (!binding) return { ok: false, reason: 'not_applicable' };
  if (!hostId || !binding.local_path || binding.owner_host_id !== hostId || binding.state !== 'active') return { ok: false, reason: 'not_owner_host' };
  const root = join(binding.local_path, binding.relative_path);
  let gitRoot: string;
  try { gitRoot = syncGit(root, ['rev-parse', '--show-toplevel']).trim(); } catch { return { ok: false, reason: 'not_owner_host' }; }
  const slugMode = await scannerSlugRootMode(engine, sourceId, root);
  const scope = relative(realpathSync.native(gitRoot), realpathSync.native(root)).split('\\').join('/');
  const [source] = await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]);
  return { ok: true, root, gitRoot, scope: { sourceId, root, scope, slugMode }, commit: source?.last_commit ?? null,
    owner: { host_id: hostId, worktree_id: binding.worktree_id, owner_epoch: String(binding.owner_epoch), source_incarnation: binding.source_incarnation } };
}

function ownerRefusal(sourceId: string, reason: 'not_applicable' | 'not_owner_host'): OperationError {
  return opError('not_owner_host', `Duplicate-origin groups of source ${sourceId} can only be checked and resolved on its canonical owner host.`,
    reason === 'not_applicable' ? `Source ${sourceId} has no canonical checkout bound, so its files cannot be read; nothing was listed or changed.`
      : `This host does not own source ${sourceId}'s active canonical worktree; nothing was listed or changed. Run ${originTwinsRepairCommand(sourceId)} on the owner host (writer status names it).`,
    { reason, fix: readFix('Shows the source\'s canonical binding and owner host, read-only.', { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] }), docs: DOCS });
}

/** The file's explicit frontmatter id at the last synced commit (the bytes sync screened), else the working tree; undefined when unreadable. */
export function originFileId(context: Extract<OwnerContext, { ok: true }>, origin: string): string | null | undefined {
  const gitPath = context.scope.slugMode === 'source-root' && context.scope.scope ? `${context.scope.scope}/${origin}` : origin;
  try {
    const bytes = context.commit ? syncGit(context.gitRoot, ['show', `${context.commit}:${gitPath}`]) : readFileSync(join(context.gitRoot, gitPath), 'utf8');
    return frontmatterIdentity(bytes).id;
  } catch { return undefined; }
}

/**
 * The verdict of one group of live claimants of an origin: `decideOriginTwins` over the rows and the file, then, for a
 * group it would resolve, whether any twin holds evidence the merge would lose (`twin_evidence_conflicts`).
 */
export async function originGroupVerdict(engine: BrainEngine, context: Extract<OwnerContext, { ok: true }>, origin: string, claimants: OriginClaimant[]): Promise<OriginTwinVerdict> {
  const verdict = decideOriginTwins({ sourcePath: origin, claimants, fileId: originFileId(context, origin),
    slugPathOccupied: slugPathOccupied({ root: context.root, gitRoot: context.gitRoot, slugMode: context.scope.slugMode }) });
  if (verdict.verdict !== 'resolve') return verdict;
  for (const twin of verdict.twins) {
    if ((await twinMergeConflicts(engine, verdict.survivor.id, twin.id)).length) {
      return { verdict: 'hold', canonical: verdict.canonical, reason: 'twin_evidence_conflicts', claimants: [verdict.survivor, ...verdict.twins].sort((a, b) => a.id - b.id) };
    }
  }
  return verdict;
}

export interface OriginTwinScan { owner: GhostOwner; groups: OriginTwinGroup[]; file_backed: number; truncated: boolean; context: Extract<OwnerContext, { ok: true }> }

/** Every live twin group of one source (stored spelling and legacy spelling), at most `ORIGIN_TWINS_LIMIT`. */
export async function scanOriginTwins(engine: BrainEngine, sourceId: string): Promise<OriginTwinScan> {
  const context = await originOwnerContext(engine, sourceId);
  if (!context.ok) throw ownerRefusal(sourceId, context.reason);
  const byOrigin = new Map<string, Array<{ id: number; source_path: string }>>();
  const exact = await engine.executeRaw<{ source_path: string; ids: number[]; paths: string[] }>(`SELECT source_path, array_agg(id ORDER BY id) AS ids, array_agg(source_path ORDER BY id) AS paths
    FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL GROUP BY source_path HAVING count(*) > 1 ORDER BY source_path LIMIT ${ORIGIN_TWINS_LIMIT + 1}`, [sourceId]);
  for (const row of exact) byOrigin.set(row.source_path, row.ids.map((id, i) => ({ id: Number(id), source_path: row.paths[i]! })));
  const legacyPrefix = legacySyncOrigin(context.scope, 'x') ? `${context.scope.scope}/` : null;
  if (legacyPrefix) {
    const pairs = await engine.executeRaw<{ legacy_id: number; legacy_path: string; legacy_slug: string; origin: string }>(`SELECT l.id AS legacy_id, l.source_path AS legacy_path, l.slug AS legacy_slug, o.source_path AS origin
      FROM pages l JOIN pages o ON o.source_id=l.source_id AND l.source_path = $2 || o.source_path
      WHERE l.source_id=$1 AND l.deleted_at IS NULL AND o.deleted_at IS NULL AND l.id <> o.id LIMIT ${ORIGIN_TWINS_LIMIT + 1}`, [sourceId, legacyPrefix]);
    for (const pair of pairs) {
      let same = false;
      try { same = sameSyncOrigin(pair.legacy_path, pair.origin, context.scope, pair.legacy_slug); } catch { same = true; }
      if (!same) continue;
      const group = byOrigin.get(pair.origin) ?? (await engine.executeRaw<{ id: number; source_path: string }>(
        'SELECT id, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path=$2 ORDER BY id', [sourceId, pair.origin])).map(row => ({ id: Number(row.id), source_path: row.source_path }));
      if (!group.some(page => page.id === Number(pair.legacy_id))) group.push({ id: Number(pair.legacy_id), source_path: pair.legacy_path });
      byOrigin.set(pair.origin, group);
    }
  }
  const truncated = byOrigin.size > ORIGIN_TWINS_LIMIT;
  const groups: OriginTwinGroup[] = [];
  for (const [origin, pages] of [...byOrigin].sort(([a], [b]) => a.localeCompare(b)).slice(0, ORIGIN_TWINS_LIMIT)) {
    const claimants = await readOriginClaimants(engine, sourceId, pages.map(page => page.id));
    if (claimants.length < 2) continue;
    const pathOf = new Map(pages.map(page => [page.id, page.source_path]));
    const listed = claimants.map(page => ({ page_id: page.id, slug: page.slug, revision: page.revision, source_path: pathOf.get(page.id)! }));
    let confined: string;
    try { confined = syncOriginPath(origin); } catch {
      groups.push({ source_id: sourceId, source_path: origin, canonical: '', reason: 'no_canonical_claimant', claimants: listed });
      continue;
    }
    const verdict = await originGroupVerdict(engine, context, confined, claimants);
    groups.push({ source_id: sourceId, source_path: origin, canonical: verdict.canonical, reason: verdict.verdict === 'resolve' ? null : verdict.reason, claimants: listed });
  }
  const [counted] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL', [sourceId]);
  return { owner: context.owner, groups, file_backed: Number(counted?.n ?? 0), truncated, context };
}

/** The writes a group needs: every non-survivor gives the origin to `keep` (the canonical page for a verified group). */
export function groupPairs(group: OriginTwinGroup, keep?: string): OriginTwinPair[] {
  const survivor = group.claimants.find(page => page.slug === (keep ?? group.canonical));
  if (!survivor || (!keep && group.reason)) return [];
  const mode: OriginTwinMode = group.reason ? 'detach' : 'merge';
  return group.claimants.filter(page => page !== survivor).map(twin => ({ source_id: group.source_id, source_path: group.source_path, twin_path: twin.source_path,
    survivor: { page_id: survivor.page_id, slug: survivor.slug, revision: survivor.revision }, twin: { page_id: twin.page_id, slug: twin.slug, revision: twin.revision }, mode }));
}

function decisionCommands(group: OriginTwinGroup): string[] {
  return [...group.claimants.map(page => `gbrain get --source ${group.source_id} -- '${page.slug}'`),
    `Pick the page that is ${group.source_path}'s, then: ${originTwinsRepairCommand(group.source_id)} --slug '<kept-slug>' (the others forget the file and stay live; nothing is deleted)`];
}

function hashParts(scope: RepairScope, owner: GhostOwner, pairs: OriginTwinPair[], groups: OriginTwinGroup[]) {
  return { kind: 'origin-twins-v1', brain_id: scope.brain_id, selection: { source_ids: scope.source_ids }, owner, pairs, decisions: groups.filter(group => group.reason) };
}

function item(pair: OriginTwinPair, owner: GhostOwner, hash: string, last: boolean): PairItem {
  return { cursor: { phase: 1, id: pair.twin.page_id }, source_id: pair.source_id, slug: pair.twin.slug, chars: 0, action: `${pair.mode}:origin_twin`, pair, owner, hash, last };
}

const pairLine = (p: OriginTwinPair) => p.mode === 'merge'
  ? `${p.survivor.slug} (id ${p.survivor.page_id}) keeps ${p.source_path}; twin ${p.twin.slug} (id ${p.twin.page_id}, revision ${p.twin.revision}) holds the same body and is merged into it`
  : `${p.survivor.slug} (id ${p.survivor.page_id}) keeps ${p.source_path}; ${p.twin.slug} (id ${p.twin.page_id}) forgets the file and stays live`;

export const originTwinsRepair: RepairHandler = {
  kind: 'origin-twins',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (opts?.remote === true) throw trustedCliRequired('gbrain repair origin-twins runs only from the trusted local CLI on the brain host.');
    if (scope.source_ids.length !== 1) {
      throw opError('invalid_params', 'gbrain repair origin-twins needs --source <id>.',
        'Duplicate-origin groups are checked on each source\'s own canonical owner host; name one source, e.g. gbrain repair origin-twins --source default.',
        { fix: readFix('Lists the registered sources.', { argv: ['gbrain', 'sources', 'list', '--json'] }), docs: DOCS });
    }
    const sourceId = scope.source_ids[0]!;
    const command = originTwinsRepairCommand(sourceId);
    const keep = opts?.slugs?.length ? opts.slugs : undefined;
    if (keep && keep.length !== 1) throw opError('invalid_params', 'gbrain repair origin-twins --slug names the one page that keeps a file.', `Name one slug per run: ${command} --slug '<kept-slug>'.`, { fix: previewFix(sourceId), docs: DOCS });
    const context = await originOwnerContext(engine, sourceId);
    if (!context.ok) {
      // Off the owner host (or with no checkout bound) a source that holds no twin has nothing to resolve; the index needs no checkout.
      const stored = await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL GROUP BY source_path HAVING count(*) > 1 LIMIT 1', [sourceId]);
      if (stored.length) throw ownerRefusal(sourceId, context.reason);
      const hash = previewHash({ kind: 'origin-twins-v1', brain_id: scope.brain_id, selection: { source_ids: scope.source_ids }, empty: true });
      if (!opts?.apply) return { items: [], preview_hash: hash, residuals: { groups: 0 }, warnings: [`Source ${sourceId} has no duplicate-origin group; --apply builds the pages_live_origin_key index once no source has one.`] };
      const built = await buildOriginIndexIfClean(engine, ORIGIN_INDEX_MIGRATION);
      return { items: [], preview_hash: opts.expect ?? hash, residuals: { index_present: built.state === 'present' ? 1 : 0 }, warnings: [built.state === 'pending'
        ? `pages_live_origin_key stays pending: ${built.sources.map(s => `source ${s.source_id} still has ${s.groups} group(s)`).join(', ')}.` : `pages_live_origin_key: ${built.state}.`] };
    }
    const scan = await scanOriginTwins(engine, sourceId);
    const chosen = keep ? scan.groups.filter(group => group.claimants.some(page => page.slug === keep[0])) : scan.groups;
    const pairs = chosen.flatMap(group => groupPairs(group, keep?.[0]));
    const mass = massTwins(pairs.filter(pair => pair.mode === 'merge').length, scan.file_backed);
    if (!opts?.apply) {
      const hash = previewHash(hashParts(scope, scan.owner, pairs, scan.groups));
      if (pairs.length) await saveApprovedSet<ApprovedPair>(engine, { command: 'origin-twins', hash }, pairs.map(pair => ({ ...pair, owner: scan.owner, selection: scope.source_ids })));
      const decisions = scan.groups.filter(group => group.reason && !keep);
      const warnings = [
        ...(keep && !chosen.length ? [`No duplicate-origin group of source ${sourceId} has a page ${keep[0]}.`] : []),
        ...(mass ? [`${pairs.length} twin(s) against ${scan.file_backed} file-backed page(s) (more than ${Math.round(MASS_RECONCILE_RATIO * 100)}%): the apply refuses unless GBRAIN_ALLOW_MASS_RECONCILE=1; check the source first.`] : []),
        ...(scan.truncated ? [`More groups may exist past the first ${ORIGIN_TWINS_LIMIT} listed; apply this set, then preview again.`] : []),
        ...(decisions.length ? [`${decisions.length} group(s) need a person's decision and are never resolved by this apply; each lists the commands to decide it.`] : []),
        ...(pairs.some(pair => pair.mode === 'merge') ? [ORIGIN_TWINS_CONSENT_TEXT.risk] : []),
        ...(!scan.groups.length ? ['No duplicate-origin group in this source; --apply builds the pages_live_origin_key index once no source has one.'] : []),
      ];
      return { warnings, items: pairs.map((pair, index) => item(pair, scan.owner, hash, index === pairs.length - 1)), preview_hash: hash,
        residuals: { groups: scan.groups.length, decisions: decisions.length, file_backed: scan.file_backed },
        listing: [...pairs.map(pair => ({ item: `${pair.source_id}:${pair.twin.slug}`, class: pair.mode, detail: pairLine(pair) })),
          ...decisions.map(group => ({ item: `${group.source_id}:${group.source_path}`, class: `decision:${group.reason}`,
            detail: `${group.claimants.map(page => `${page.slug} (id ${page.page_id}, revision ${page.revision})`).join(', ')} record ${group.source_path}` }))],
        details: { decisions: decisions.map(group => ({ ...group, commands: decisionCommands(group) })), mass_merge: mass, truncated: scan.truncated, purge_fuse_hours: ORIGIN_TWINS_PURGE_FUSE_HOURS, docs: DOCS } };
    }
    if (!opts.expect) {
      throw opError('invalid_params', 'gbrain repair origin-twins --apply resolves only the set a preview printed.',
        `Preview first: ${command} — then, after the user agrees, run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`, { fix: previewFix(sourceId), docs: DOCS });
    }
    const approved = await loadApprovedSet<ApprovedPair>(engine, { command: 'origin-twins', hash: opts.expect, previewCommand: command,
      emptyHash: async () => previewHash(hashParts(scope, scan.owner, [], scan.groups)) });
    if (approved.items.some(pair => JSON.stringify(pair.selection) !== JSON.stringify(scope.source_ids) || !sameOwner(scan.owner, pair.owner))) throw previewChangedError(opts.expect, command);
    if (massTwins(approved.items.filter(pair => pair.mode === 'merge').length, scan.file_backed) && !massReconcileAllowed()) {
      throw opError('origin_twin_mass_merge_refused', `Refusing to merge ${approved.items.length} duplicate-origin twin(s) of source ${sourceId}: that soft-deletes more than ${Math.round(MASS_RECONCILE_RATIO * 100)}% of its ${scan.file_backed} file-backed page(s).`,
        'That many twins at once almost always means a re-import under another slug or the wrong checkout, not a backlog; nothing was changed. If it is genuinely intended, ask the user, then rerun the same apply command with GBRAIN_ALLOW_MASS_RECONCILE=1.',
        { fix: previewFix(sourceId), docs: DOCS });
    }
    if (!approved.items.length) {
      const built = await buildOriginIndexIfClean(engine, ORIGIN_INDEX_MIGRATION);
      return { items: [], preview_hash: opts.expect, residuals: { index_present: built.state === 'present' ? 1 : 0 }, warnings: built.state === 'pending'
        ? [`pages_live_origin_key stays pending: ${built.sources.map(s => `source ${s.source_id} still has ${s.groups} group(s)`).join(', ')}.`] : [`pages_live_origin_key: ${built.state}.`] };
    }
    const items = approved.items.map(({ selection: _selection, owner, ...pair }, index) => item(pair, owner, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { pair, owner, hash, last } = entry as PairItem;
    const outcome = await resolveOriginTwin(ctx, pair, owner,
      () => repairRequestId(ctx, 'origin-twins', { source_id: pair.source_id, slug: pair.twin.slug }, `${pair.mode}:${pair.survivor.revision}:${pair.twin.revision}`));
    if (last) {
      await clearApprovedSet(ctx.engine, { command: 'origin-twins', hash });
      const built = await buildOriginIndexIfClean(ctx.engine, ORIGIN_INDEX_MIGRATION);
      ctx.logger.info(built.state === 'pending' ? `pages_live_origin_key stays pending: ${built.sources.map(s => `source ${s.source_id} still has ${s.groups} group(s)`).join(', ')}` : `pages_live_origin_key: ${built.state}`);
    }
    return outcome;
  },
  render(details) {
    const decisions = (details.decisions as Array<OriginTwinGroup & { commands: string[] }> | undefined) ?? [];
    return [...decisions.flatMap(group => [`  decision ${group.reason}: ${group.claimants.map(page => page.slug).join(', ')} record ${group.source_path}`,
      ...group.commands.map(command => `    ${command}`)]),
      `  each merged twin: soft-deleted (its file stays), purged after ${details.purge_fuse_hours} h; guide: ${details.docs}`];
  },
};

const changed = (reason: string): RepairItemOutcome => ({ applied: false, outcome: 'changed_since_preview', reason });

/** Whether the pair is still the approved one (and, for a merge, still verified duplicates); otherwise why not. */
export async function originPairNow(engine: BrainEngine, pair: OriginTwinPair, owner: GhostOwner | null): Promise<string | null> {
  const context = await originOwnerContext(engine, pair.source_id);
  if (!context.ok || (owner && !sameOwner(context.owner, owner))) return 'the source\'s canonical owner changed since the preview';
  const rows = await engine.executeRaw<{ id: number; slug: string; revision: string; source_path: string | null }>(`SELECT id, slug, knowledge_revision::text AS revision, source_path FROM pages
    WHERE source_id=$1 AND id=ANY($2::bigint[]) AND deleted_at IS NULL`, [pair.source_id, [pair.survivor.page_id, pair.twin.page_id]]);
  const survivor = rows.find(row => Number(row.id) === pair.survivor.page_id), twin = rows.find(row => Number(row.id) === pair.twin.page_id);
  if (!survivor || !twin) return 'one of the two pages was deleted or purged';
  if (survivor.slug !== pair.survivor.slug || twin.slug !== pair.twin.slug) return 'one of the two pages was renamed';
  if (String(survivor.revision) !== pair.survivor.revision || String(twin.revision) !== pair.twin.revision) return 'one of the two pages has a new revision';
  if (survivor.source_path == null || twin.source_path !== pair.twin_path) return 'a recorded origin changed';
  if (pair.mode === 'detach') return null;
  const live = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path=ANY($2::text[])',
    [pair.source_id, [...new Set([pair.source_path, pair.twin_path, survivor.source_path])]]);
  const verdict = await originGroupVerdict(engine, context, syncOriginPath(pair.source_path), await readOriginClaimants(engine, pair.source_id, live.map(row => Number(row.id))));
  if (verdict.verdict !== 'resolve') return `the group needs a decision now (${verdict.reason})`;
  return verdict.survivor.id === pair.survivor.page_id ? null : 'another page is now canonical';
}

/** Resolves one pair; a managed brain submits it under `requestId()`. Returns the receipt fields on success. */
export async function resolveOriginTwin(ctx: OperationContext, pair: OriginTwinPair, owner: GhostOwner | null, requestId: () => Promise<string>): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const moved = await originPairNow(engine, pair, owner);
  if (moved) return changed(moved);
  if (await managedPersistenceEnabled(engine)) {
    const authority = (await maintenancePreflight(engine, pair.source_id))!;
    try {
      const receipt = await submitDatabaseMaintenanceIntent(engine, authority, pair.twin.slug, { kind: ORIGIN_TWINS_INTENT, expected_revision: pair.twin.revision, pair, owner }, await requestId());
      return { applied: true, outcome: pair.mode === 'merge' ? 'merged' : 'detached', detail: receipt };
    } catch (error) {
      if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed', 'source_changed'].includes(error.code)) return changed(error.message);
      throw error;
    }
  }
  const result = await maintenanceTransaction(engine, async tx => {
    await tx.lockPageKeys([{ sourceId: pair.source_id, slug: pair.survivor.slug }, { sourceId: pair.source_id, slug: pair.twin.slug }].sort((a, b) => a.slug.localeCompare(b.slug)));
    const reason = await pairLocked(tx, pair);
    if (reason) return { reason };
    const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [pair.source_id]);
    return { receipt: await applyOriginTwin(tx, pair, source!.incarnation) };
  });
  return 'reason' in result ? changed(result.reason!) : { applied: true, outcome: pair.mode === 'merge' ? 'merged' : 'detached', detail: result.receipt };
}

/** Under the page keys: why the locked pair is no longer the approved one, or null. */
async function pairLocked(tx: BrainEngine, pair: OriginTwinPair): Promise<string | null> {
  const survivor = await tx.readPageSnapshot(pair.survivor.slug, { sourceId: pair.source_id });
  const twin = await tx.readPageSnapshot(pair.twin.slug, { sourceId: pair.source_id });
  if (!survivor || Number(survivor.page.id) !== pair.survivor.page_id || survivor.revision !== pair.survivor.revision || survivor.page.source_path == null) return 'the surviving page changed';
  if (!twin || Number(twin.page.id) !== pair.twin.page_id || twin.revision !== pair.twin.revision || twin.page.source_path !== pair.twin_path) return 'the twin changed';
  return null;
}

const DROPPED_VALUE_MAX = 1000;
/** Keys of the twin's frontmatter the survivor lacks or holds differently, with the twin's values (listed in the receipt). */
async function droppedFrontmatter(tx: BrainEngine, pair: OriginTwinPair): Promise<Record<string, unknown>> {
  const rows = await tx.executeRaw<{ id: number; frontmatter: Record<string, unknown> | string | null }>('SELECT id, frontmatter FROM pages WHERE id=ANY($1::bigint[])', [[pair.survivor.page_id, pair.twin.page_id]]);
  const of = (id: number) => { const raw = rows.find(row => Number(row.id) === id)?.frontmatter; return (typeof raw === 'string' ? JSON.parse(raw) : raw ?? {}) as Record<string, unknown>; };
  const survivor = of(pair.survivor.page_id), twin = of(pair.twin.page_id);
  return Object.fromEntries(Object.entries(twin).filter(([key, value]) => JSON.stringify(survivor[key]) !== JSON.stringify(value))
    .map(([key, value]) => { const text = JSON.stringify(value) ?? 'null'; return [key, text.length > DROPPED_VALUE_MAX ? `${text.slice(0, DROPPED_VALUE_MAX)}… (truncated; the twin's page version holds it)` : value]; }));
}

/** The write itself, inside the caller's transaction with both page keys held. */
async function applyOriginTwin(tx: BrainEngine, pair: OriginTwinPair, incarnation: string): Promise<Record<string, unknown>> {
  const restore = ['gbrain', 'restore', pair.twin.slug, '--source-id', pair.source_id];
  const base = { source_id: pair.source_id, source_path: pair.source_path, survivor_slug: pair.survivor.slug, twin_slug: pair.twin.slug };
  if (pair.mode === 'detach') {
    await tx.executeRaw('UPDATE pages SET source_path=NULL, source_uri=NULL, database_only_reason=$2 WHERE id=$1', [pair.twin.page_id, ORIGIN_TWIN_REASON]);
    return { status: 'origin_twin_detached', ...base };
  }
  const dropped = await droppedFrontmatter(tx, pair);
  const merged = await mergeTwinInto(tx, { sourceId: pair.source_id, incarnation, survivor: { page_id: pair.survivor.page_id, slug: pair.survivor.slug }, twin: { page_id: pair.twin.page_id, slug: pair.twin.slug } });
  return { status: 'origin_twin_resolved', ...base, links_moved: merged.links_moved.length, link_ids: merged.links_moved, facts_moved: merged.facts_moved.length,
    transitions_moved: merged.transitions_moved, tags_moved: merged.tags_moved, deduplicated: merged.deduplicated, dropped_frontmatter: dropped, restore_argv: restore,
    restore_note: `${restore.join(' ')} brings back ${pair.twin.slug}'s own text as a database-only page within ${ORIGIN_TWINS_PURGE_FUSE_HOURS} h; references moved to ${pair.survivor.slug} stay there. `
      + `${pair.survivor.slug}'s frontmatter comes from ${pair.source_path}, so each key in dropped_frontmatter (the twin's value) is kept only in the twin's page version; `
      + 'its free-text aliases answer for the survivor until the file is next imported. Add any of them to the file to keep them.' };
}

/**
 * Preparer for `managed_maintenance_resolve_origin_twin`, a request on the twin that also holds the survivor's key:
 * re-checks the pair, publishes no file (the file stays the survivor's), and re-checks both pages under the locks.
 */
export async function prepareOriginTwinResolve(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig): Promise<PreparedMutation> {
  const pair = row.intent!.pair as OriginTwinPair | undefined;
  const owner = (row.intent!.owner as GhostOwner | null | undefined) ?? null;
  if (!pair || pair.twin.slug !== row.slug || pair.source_id !== row.source_id || pair.twin.page_id !== Number(row.page_id) || !['merge', 'detach'].includes(pair.mode)) {
    throw opError('invalid_params', 'The origin twin intent does not name its pages.',
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} does not name the pair it resolves, so nothing changed. Preview the repair again.`, { fix: previewFix(row.source_id) });
  }
  const refuse = (reason: string) => opError('revision_conflict', 'The duplicate-origin pair changed since it was read.',
    `Pages ${pair.survivor.slug} and ${row.slug} in source ${row.source_id} changed (${reason}), so request ${row.request_id} resolved nothing. Preview the repair again.`, { fix: previewFix(row.source_id) });
  const moved = await originPairNow(engine, pair, owner);
  if (moved) throw refuse(moved);
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  const core = await prepareCoreGuard(engine, { row, snapshot: await engine.readPageSnapshot(row.slug, { sourceId: row.source_id }), incoming: null });
  const prepared: PreparedMutation = { observedRevision: pair.twin.revision, additionalPageKeys: [{ sourceId: row.source_id, slug: pair.survivor.slug }],
    ...(core ? { exclusiveSources: core.exclusiveSources } : {}),
    databaseOnlyReason: 'shared_origin',
    validate: async tx => {
      await authorizeWrite(tx, row.authority, 'submit_job', row.slug);
      const locked = await pairLocked(tx, pair);
      if (locked) throw refuse(locked);
      prepared.databaseOnlyWarning = pair.mode === 'merge'
        ? `Twin ${row.slug} is hidden; ${pair.source_path} is untouched and stays ${pair.survivor.slug}'s, which takes its inbound references; ${row.slug} resolves to it as an alias.`
        : `${row.slug} no longer records ${pair.source_path}, which stays ${pair.survivor.slug}'s; ${row.slug} stays live as a database-only page.`;
    },
    apply: async tx => applyOriginTwin(tx, pair, row.source_incarnation) };
  return prepared;
}
