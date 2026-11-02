/**
 * G8a of git-canonical memory (docs/designs/GIT_CANONICAL_MEMORY.md, "Conversion"): the plan and apply behind
 * `gbrain sources canonical <id> --to git|mixed` (commands/sources-canonical.ts). Trusted local CLI only, managed
 * brains only, never an MCP operation.
 *
 * The preview (read-only) puts every live page of the source in one category, from the git-gap census (G1, the equality
 * contract against HEAD), the declared database-only classes (G7a), the open sync holds, the parked Git effects and the
 * level a strict pass would read (G3, sync-pass.ts readShadowLevel under a strict-classified context):
 *   - adopt: the database holds content Git does not (database_ahead, undeclared_database_only, worktree_only). The apply
 *     writes the page's export view (readExportPage, withdrawals overlaid: exactly what the census compares) to its file
 *     and commits it with commitThroughDoor, one commit per group of CONVERSION_GROUP_MAX pages, under the worktree writer
 *     lock, which is dropped between groups. No row changes: the database already holds those bytes.
 *   - declared: database-only on purpose; nothing is written and nothing deleted. A declared page whose committed file
 *     reads back equal to it (the census contract) keeps that file in HEAD and is settled: a strict import changes nothing.
 *   - withhold: a private, alias-private or lineage-private page whose row still records a file that is absent from HEAD
 *     or differs from it. The apply takes G7a's
 *     private transition: the row withholds its origin (withheld_source_path), then a committed file's removal goes
 *     through the door, so no sync reads the removal as a deletion and the page stays live; with no file at HEAD, only
 *     the row changes. Any
 *     other declared page with a committed file is a discard (git_overwrites_database), as Git's import would replace it.
 *   - git_wins: Git's verdict replaces the row and loses nothing (Git moved and the database did not; Git deleted a page
 *     the database had not edited; a held deletion; a held file_drift whose side is unknown and whose row already equals
 *     the committed file). The strict-equivalent pass applies it. An unknown-side drift whose row differs from the file
 *     would lose that edit, so it is a discard (held_drift_unknown_differs).
 *   - holds: cleared, so that pass runs Git's verdict over them (a hold at its level would settle the path).
 *   - parked Git effects: retried (retry-effects' one authorized attempt), or reclassified when Git ignores the target
 *     (in one transaction the page is stamped git_ignored, G7a's declared class, and each target stays parked as a record
 *     marked `declared: git_ignored`, so the next plan no longer lists it).
 *   - discard: database content that would be neither in Git after the apply nor declared, by category. The apply
 *     refuses (git_conversion_blocked, naming the categories) unless it is zero; there is no override.
 * The preview hash binds HEAD, the source incarnation and every planned item with its revision.
 *
 * The apply re-plans and refuses preview_changed on a different hash, adopts and withholds group by group (a crash leaves the source
 * non-strict and the rerun preview lists only what is left), retries or reclassifies the parked effects, checks the
 * strict level once more as it will read with the planned holds cleared (an overwrite nobody accepted stops it, and the
 * holds stay; a page settled as equal to its file that moved since is judged again), clears the holds, runs the full strict-equivalent
 * pass (SyncOpts.canonicalOverride, internal) and sets `canonical: git` last, in the transaction that records the
 * conversion. Writes can land between that pass and the flag, so it then runs one genuine strict pass and plans again:
 * only a plan with no work left is a completed conversion; otherwise the source stays strict (Git wins) and the
 * remaining categories are reported. `--to mixed` removes the flag and changes nothing else.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import type { Action } from '../agent-output.ts';
import { LockUnavailableError, syncLockId } from '../db-lock.ts';
import { syncOutcome } from './sync-drain.ts';
import { loadConfig } from '../config.ts';
import { resolveSourceId } from '../source-resolver.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { inlineExportMarkdown, readExportPage, readExportPages, readExportWithdrawals, type ExportSnapshot } from '../export-snapshot.ts';
import { scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { censusGitGap, type GitGapCensus, type GitGapPage } from '../../commands/sources-git-gap.ts';
import { compareInlineExportFile, ignoredPaths, readBlobs, type DeclaredClass, type ExportFileComparison } from './git-gap.ts';
import { commitThroughDoor } from './git-door.ts';
import { gitRootAhead, pushGitRoot } from './effect-git.ts';
import { DURABILITY_NOT_ENABLED_REASON, gitDurabilityPolicy } from './git-durability-policy.ts';
import { currentVerifiedLocalWriter, localHostId } from './identity.ts';
import { acquireWorktree, getWorktreeBinding, readManagedMode } from './ownership.ts';
import { inspectDurabilityCheckout } from './git-durability-administration.ts';
import { classifyGitCheckout } from '../git-checkout.ts';
import { resolveManagedSyncContext, type ManagedSyncContext } from './sync-discovery.ts';
import { readShadowLevel } from './sync-pass.ts';
import { isPrivacyClass, type PrivacyClass } from './git-declared.ts';
import { classifySyncPath } from './sync-classify.ts';
import { clearGitHold, fileDriftSide, readGitSourceHolds, readSyncImportProvenances, type GitHoldRecord } from './sync-holds.ts';
import { readDeletionProvenance } from './sync-origin-evidence.ts';
import { retryParkedEffects } from './effect-retry.ts';
import { runPersistenceEffects } from './effects.ts';
import { faultPoint } from './fault-points.ts';
import { declarePersistenceProtocol } from './protocol.ts';
import { previewChangedError, previewHash } from './preview-approval.ts';
import { sha256 } from './digest.ts';

export const CONVERSION_GROUP_MAX = 200;
/** Adoption candidates whose export view the plan reads per read-only transaction (the census's batch size). */
export const ADOPTION_BATCH = 256;
export const CONVERSION_OP = 'git-canonical-conversion';
const DOCS = 'docs/designs/GIT_CANONICAL_MEMORY.md#conversion';
const SAMPLE = 20;
const LOCK_WAIT_MS = 30_000;
const MOVED_BATCH = 10_000;

/** The steps of every apply, in order (`ConversionProgress.phase`); `strict_pass_closing` follows only when door commits landed (CLOSING_PASSES). */
export type ConversionPhase = 'adopt' | 'withhold' | 'recheck' | 'holds' | 'strict_pass_1' | 'strict_pass_2' | 'strict_pass_closing';
export const CONVERSION_PHASES: readonly ConversionPhase[] = ['adopt', 'withhold', 'recheck', 'holds', 'strict_pass_1', 'strict_pass_2'];
/**
 * Where an apply stands: its phase, the door commits it made (adoption and withholding groups), and the items the phase
 * went through of its total. In a strict pass (#7866), `total` is the paths the strict level holds (the planned page count,
 * set from the recheck's read and kept for the whole pass), `round` the pass round, `candidates` the paths that round
 * imports or deletes, `batch` of `batches` the import batch it is draining, and `scanned` the candidates of the round
 * settled so far, across its batches.
 */
export interface ConversionProgress { phase: ConversionPhase; groups_committed: number; scanned: number; total: number; round?: number; candidates?: number;
  batch?: number; batches?: number; push?: ConversionPush }
const ROUND_RESET = { round: undefined, candidates: undefined, batch: undefined, batches: undefined } as const;
/**
 * Where the push of the apply's door commits stands: `pushed`; `pending` (the commits are local and the next page write's
 * push-only effect pushes them; `code` and `notice` say why it did not land); `skipped` (`reason`: durability is off,
 * there was nothing to push, or the branch tracks no remote).
 */
export interface ConversionPush { state: 'pushed' | 'pending' | 'skipped'; reason?: string; code?: string; notice?: string }
type ConversionReporter = (patch: Partial<ConversionProgress>) => void;

export const ADOPT_STATES = ['database_ahead', 'undeclared_database_only', 'worktree_only'] as const;
export type AdoptState = typeof ADOPT_STATES[number];
export const GIT_WINS_REASONS = ['git_ahead', 'deleted_by_commit', 'held_deletion', 'held_drift_unknown'] as const;
export type GitWinsReason = typeof GIT_WINS_REASONS[number];
/** Database content the apply would discard or cannot place, by why: each must be zero before the apply runs. */
export const DISCARD_CATEGORIES = ['both_moved', 'held_drift_both', 'held_drift_unknown_differs', 'deleted_in_git', 'uncommitted_edit', 'ignored_target', 'unparseable', 'unsafe_path',
  'segmented_page', 'export_mismatch', 'git_overwrites_database', 'ignore_status_unknown'] as const;
export type DiscardCategory = typeof DISCARD_CATEGORIES[number];
/** A private, alias-private or lineage-private page whose row still records a file: committed at HEAD, or absent from it. */
export const WITHHOLD_KINDS = ['file_committed', 'file_absent'] as const;
export type WithholdKind = typeof WITHHOLD_KINDS[number];

interface Counted<K extends string> { count: number; by: Record<K, number>; sample: string[] }
/**
 * Counts behind some discard categories (outside the preview hash). git_overwrites_database: the class the path has on a
 * source that is not strict (with its sub, side or state), then the page's kind (`declared:<class>`, `live`, or
 * `tombstone_or_none`); uncommitted_edit: the working-tree state; unparseable: why the committed file cannot be read;
 * export_mismatch: each field the page's export reads back different (`unparseable:<reason>` when it does not parse);
 * ignore_status_unknown: why Git could not say whether the target is ignored (IgnoreUnknownReason).
 */
export interface DiscardDetail {
  git_overwrites_database: Record<string, Record<string, number>>;
  uncommitted_edit: Record<string, number>;
  unparseable: Record<string, number>;
  export_mismatch: Record<string, number>;
  ignore_status_unknown: Record<string, number>;
}
/** `disk`: sha256 of the working-tree bytes the preview saw (HEAD's or the export's), null when the file was absent. */
export interface AdoptItem { id: string; source_id: string; slug: string; revision: string | null; path: string; state: AdoptState; disk: string | null }
/** `disk`: sha256 of the working-tree bytes of a committed file the preview saw, null when absent from the disk. */
export interface WithholdItem { id: string; slug: string; revision: string | null; path: string; kind: WithholdKind; declared: PrivacyClass; disk: string | null }
interface HoldItem { path: string; code: string; side: string | null; observed_at: string; action: 'git_wins' | 'rescreen' | 'blocked' }
interface ParkedItem { effect: string; request: string; kind: string; codes: string[]; slugs: string[]; action: 'retry' | 'reclassify' }

export interface GitConversionPreview {
  status: 'preview';
  source_id: string;
  to: 'git';
  /** Whether the source row already says canonical: git (a rerun after an incomplete conversion). */
  strict: boolean;
  head: string | null;
  pages: number;
  equal: number;
  adopt: Counted<AdoptState> & { action: 'commit_through_door'; groups: number };
  /** `committed_equal`: declared pages whose committed file reads back equal to the page, so the file stays in HEAD. */
  declared: Counted<string> & { action: 'none'; committed_equal: number };
  git_wins: Counted<GitWinsReason> & { action: 'index_committed_blob' };
  /** G7a's private transition for a privacy-class page that still records a file: the row withholds its origin, then its file's removal is committed. */
  withhold: Counted<WithholdKind> & { action: 'commit_removal_and_withhold'; groups: number };
  /** `unplaced`: holds at a path no category above placed (a declared page, no live page), which the index check judges as the strict pass will see them. */
  holds: Counted<string> & { action: 'clear'; unplaced: { count: number; by: Record<string, number> } };
  parked_effects: { count: number; retry: number; reclassify: number; by_code: Record<string, number> };
  /** What a strict pass would import or delete that no page row loses (files with no row, removals Git committed). */
  index: { imports: number; deletes: number };
  discard: Counted<DiscardCategory> & { detail: DiscardDetail };
  /** Every item the apply still has to act on (adopt, withhold, git_wins, holds, parked retries, discard); 0 on a converted source. */
  remaining: number;
  preview_hash: string;
  apply: string[];
}

interface PageRevision { id: string; revision: string | null }
/**
 * `settled`: paths whose Git import replaces nothing (the census reads them equal, or the plan adopts, withholds or accepts
 * them); `compared`: the paths settled because the page read equal to its committed file, with the revision compared.
 */
export interface GitConversionPlan { preview: GitConversionPreview; context: ManagedSyncContext; adopt: AdoptItem[]; withhold: WithholdItem[]; holds: HoldItem[]; parked: ParkedItem[];
  settled: Set<string>; compared: Map<string, PageRevision>; incarnation: string }

const counted = <K extends string>(keys: readonly K[]): Counted<K> => ({ count: 0, by: Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>, sample: [] });
const bump = (into: Record<string, number>, key: string) => { into[key] = (into[key] ?? 0) + 1; };
const emptyDiscard = () => ({ ...counted(DISCARD_CATEGORIES), detail: { git_overwrites_database: {}, uncommitted_edit: {}, unparseable: {}, export_mismatch: {}, ignore_status_unknown: {} } as DiscardDetail });
function tally<K extends string>(into: Counted<K>, key: K, path: string): void {
  into.count++;
  into.by[key] = (into.by[key] ?? 0) + 1;
  if (into.sample.length < SAMPLE) into.sample.push(path);
}

/** The refusals before anything is read: a remote caller, an unmanaged brain. */
export async function assertConversionCaller(engine: BrainEngine, sourceId: string): Promise<void> {
  if (currentSubmissionAuthority()?.kind === 'remote_generic' || currentVerifiedLocalWriter()?.remote) {
    throw trustedCliRequired('Converting a source to or from git-canonical runs only from the trusted local CLI on the brain host.');
  }
  if (await readManagedMode(engine)) return;
  const why = 'A git-canonical source is committed to Git before the database indexes it, and only managed persistence (the writer coordinator) does that.';
  throw opError('strict_requires_managed', `Source ${sourceId} cannot become git-canonical on an unmanaged brain; nothing was read or written.`,
    'Ask the user whether to turn on managed persistence for this brain first; conversion runs only on a managed brain.',
    { why, docs: DOCS, fix: { consent: [], actor: 'user', requires_exclusive: false, why, verify: { argv: ['gbrain', 'doctor', '--json'] },
      user_message: `Source ${sourceId} can only become git-canonical on a brain with managed writes, and this brain is not managed. Should it move to managed writes first?` } });
}

/**
 * #7885: a root with no Git checkout, or one whose branch has no commit yet, has nothing to convert into. The plan refuses
 * before it reads anything, and the source keeps working as it is (the database is its record). A root it cannot read
 * (gone, unmounted, not a directory) is left to the context resolution, which owns those refusals.
 */
async function assertConversionCheckout(sourceId: string, root: string): Promise<void> {
  if (classifyGitCheckout(root) === 'unknown') return;
  let code: 'git_checkout_required' | 'git_branch_unborn';
  try { await inspectDurabilityCheckout(root); return; }
  catch (error) {
    if (!(error instanceof OperationError)) throw error;
    if (error.code === 'git_detached_head') return;
    if (error.code !== 'git_checkout_required' && error.code !== 'git_branch_unborn') throw error;
    code = error.code === 'git_checkout_required' ? 'git_checkout_required' : 'git_branch_unborn';
  }
  const state = code === 'git_checkout_required' ? 'is not inside a Git checkout' : 'is a Git checkout with no commit yet';
  const why = 'A git-canonical source commits every page to Git on top of the checkout\'s branch, so its root needs a Git checkout with a first commit.';
  throw opError(code, `Source ${sourceId}'s root ${root} ${state}, so it has nothing to convert into; nothing was read or written. The source stays usable as it is, with the database as its record.`,
    'Keep the source as it is, or make its root a Git repository with a first commit on the brain host (git init, git add -A, git commit), then preview again.',
    { why, docs: DOCS, fix: { argv: ['gbrain', 'sources', 'canonical', sourceId, '--to', 'git', '--dry-run', '--json'], consent: [], actor: 'user', requires_exclusive: false,
      why: 'Previews the conversion again once the root has a first commit; read-only.',
      user_message: `Source ${sourceId} has no Git history to convert into. It keeps working as it is. Should its folder become a Git repository with a first commit so it can be converted?` } });
}



/** The context a strict pass reads, for a source whose row does not say so yet. */
const strictContext = (context: ManagedSyncContext): ManagedSyncContext => ({ ...context, source: { ...context.source, config: { ...context.source.config, canonical: 'git' } } });

/** The read-only plan of `--to git`; its preview is what the CLI prints and the apply binds to. */
export async function planGitConversion(engine: BrainEngine, sourceId: string): Promise<GitConversionPlan> {
  const binding = await getWorktreeBinding(engine, sourceId);
  if (binding?.local_path && binding.owner_host_id === localHostId() && binding.state === 'active') await assertConversionCheckout(sourceId, resolve(binding.local_path, binding.relative_path));
  const context = await resolveManagedSyncContext(engine, { sourceId, noPull: true, dryRun: true });
  const pages: GitGapPage[] = [];
  const equal = new Map<string, PageRevision>();
  const mode = await scannerSlugRootMode(engine, sourceId, context.root);
  const exported = new ExportChecks(context.root, mode);
  const census = await censusGitGap(engine, sourceId, { sample: 0, collect: (page, snapshot) => {
    if (page.state === 'equal') { if (page.path) equal.set(page.path, { id: page.id, revision: page.revision }); return; }
    pages.push(page);
    if (snapshot && page.state === 'database_ahead' && page.path && !page.segmented) exported.add(page.id, page.path, snapshot);
  } });
  if (!census.checkout || realpathSync(census.checkout) !== context.root) {
    throw opError('source_changed', `Source ${sourceId}'s registered checkout is not its owner's root, so nothing was planned.`,
      `Check the owner with gbrain sources writer status --source ${sourceId} --json, then preview again.`);
  }
  const root = context.root;
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const holdRecords = (await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? [];
  const held = new Map(holdRecords.map(hold => [hold.path, hold]));
  const preview = emptyPreview(sourceId, context, census);
  const adopt: AdoptItem[] = [], withhold: WithholdItem[] = [], accepted = new Set<string>(), discarded = new Set<string>();
  const discard = (category: DiscardCategory, path: string) => { tally(preview.discard, category, path); discarded.add(path); };
  const gitWins = (reason: GitWinsReason, path: string) => { tally(preview.git_wins, reason, path); accepted.add(path); };
  const declaredEqual = await equalDeclaredPaths(engine, sourceId, root, mode,
    pages.filter(page => page.state === 'declared_database_only' && page.path && page.headBlob && !page.segmented));
  preview.declared.committed_equal = declaredEqual.size;
  const holds = holdRecords.map(hold => holdItem(hold));
  for (const hold of holds) {
    tally(preview.holds, hold.side ? `${hold.code}:${hold.side}` : hold.code, hold.path);
    if (hold.action === 'blocked') discard('held_drift_both', hold.path);
    else if (hold.side === 'unknown' && equal.has(hold.path)) gitWins('held_drift_unknown', hold.path);
  }

  const noFile = pages.filter(page => page.state === 'undeclared_database_only' && page.path !== null);
  const provenance = noFile.length ? await readDeletionProvenance(root, noFile.map(page => page.path!)) : new Map();
  const records = noFile.length ? await readSyncImportProvenances(engine, sourceId, incarnation, noFile.map(page => Number(page.id))) : new Map();
  const candidates: Array<{ page: GitGapPage; state: AdoptState }> = [];
  for (const page of pages) {
    const path = page.path ?? page.slug;
    const hold = page.path ? held.get(page.path) : undefined;
    const side = hold?.code === 'file_drift' ? fileDriftSide(hold.meta) ?? null : null;
    switch (page.state) {
      case 'declared_database_only': {
        tally(preview.declared, page.declared!, path);
        // A committed file equal to the page stays in HEAD (a strict import of it changes nothing). Otherwise a privacy class
        // takes G7a's private transition, and any other declared page with a committed file stays a discard (planIndex).
        if (page.path && declaredEqual.has(page.path)) continue;
        if (!isPrivacyClass(page.declared) || !page.path || (!page.headBlob && !page.recordsFile)) continue;
        if (page.worktree === 'modified') { discard('uncommitted_edit', path); bump(preview.discard.detail.uncommitted_edit, 'modified'); continue; }
        const disk = page.headBlob ? diskBytes(join(root, page.path)) : null;
        const kind: WithholdKind = page.headBlob ? 'file_committed' : 'file_absent';
        withhold.push({ id: page.id, slug: page.slug, revision: page.revision, path: page.path, kind, declared: page.declared, disk: disk ? sha256(disk) : null });
        tally(preview.withhold, kind, path);
        continue;
      }
      case 'unparseable': discard('unparseable', path); bump(preview.discard.detail.unparseable, page.unparseable ?? 'unknown'); continue;
      case 'unsafe_path': discard('unsafe_path', path); continue;
      case 'git_ahead':
        if (side === 'unknown') discard('held_drift_unknown_differs', path);
        else if (page.databaseAlsoMoved && side !== 'both') discard('both_moved', path);
        else if (!page.databaseAlsoMoved) gitWins('git_ahead', path);
        continue;
      case 'database_ahead':
        if (side === 'unknown') { discard('held_drift_unknown_differs', path); continue; }
        if (side === 'both') continue;
        candidates.push({ page, state: 'database_ahead' });
        continue;
      case 'worktree_only': candidates.push({ page, state: 'worktree_only' }); continue;
      case 'undeclared_database_only': {
        if (provenance.get(page.path!)?.kind !== 'deleted_by_commit') { candidates.push({ page, state: 'undeclared_database_only' }); continue; }
        const record = records.get(Number(page.id));
        if (side === 'deleted') gitWins('held_deletion', path);
        else if (record?.revision != null && String(record.revision) === String(page.revision)) gitWins('deleted_by_commit', path);
        else discard('deleted_in_git', path);
        continue;
      }
      default: continue;
    }
  }
  await planAdoption(engine, sourceId, root, candidates, exported, preview, adopt, discard);
  const parked = await readParked(engine, sourceId);
  for (const item of parked) for (const code of item.codes) preview.parked_effects.by_code[`${item.kind}:${code}`] = (preview.parked_effects.by_code[`${item.kind}:${code}`] ?? 0) + 1;
  preview.parked_effects.count = parked.length;
  preview.parked_effects.retry = parked.filter(item => item.action === 'retry').length;
  preview.parked_effects.reclassify = parked.filter(item => item.action === 'reclassify').length;
  const settled = new Set([...equal.keys(), ...declaredEqual, ...adopt.map(item => item.path), ...withhold.map(item => item.path), ...accepted]);
  const placed = new Set([...settled, ...discarded]);
  const unplaced = holds.filter(hold => !placed.has(hold.path));
  for (const hold of unplaced) bump(preview.holds.unplaced.by, hold.side ? `${hold.code}:${hold.side}` : hold.code);
  preview.holds.unplaced.count = unplaced.length;
  const declared = new Map(pages.flatMap(page => page.declared ? [[page.id, page.declared] as const] : []));
  await planIndex(engine, context, preview, placed, new Set(unplaced.map(hold => hold.path)), declared, discard);
  preview.adopt.groups = Math.ceil(adopt.length / CONVERSION_GROUP_MAX);
  preview.withhold.groups = Math.ceil(withhold.filter(item => item.kind === 'file_committed').length / CONVERSION_GROUP_MAX);
  preview.remaining = preview.adopt.count + preview.withhold.count + preview.git_wins.count + preview.holds.count + preview.parked_effects.retry + preview.discard.count;
  preview.preview_hash = previewHash({ source: sourceId, incarnation, to: 'git', strict: preview.strict, head: preview.head, states: census.states, declared: census.declared,
    adopt: adopt.map(item => [item.id, item.revision, item.path, item.state, item.disk]), git_wins: [...accepted].sort(),
    // ignore_status_unknown is bound only when present, so the hash of a plan with no such path is the one earlier releases gave.
    discard: preview.discard.by.ignore_status_unknown ? preview.discard.by : { ...preview.discard.by, ignore_status_unknown: undefined },
    // Bound only when present, so the hash of a plan with nothing to withhold is the one earlier releases gave.
    withhold: withhold.length ? withhold.map(item => [item.id, item.revision, item.path, item.kind, item.disk]) : undefined,
    declared_equal: declaredEqual.size ? pages.filter(page => page.path && declaredEqual.has(page.path)).map(page => [page.id, page.revision, page.path]) : undefined,
    holds: holds.map(hold => [hold.path, hold.code, hold.side, hold.observed_at]), parked: parked.map(item => [item.effect, item.action, item.codes]), index: preview.index });
  preview.apply = ['gbrain', 'sources', 'canonical', sourceId, '--to', 'git', '--apply', '--expect', preview.preview_hash];
  const compared = new Map([...equal, ...pages.flatMap(page => page.path && declaredEqual.has(page.path) ? [[page.path, { id: page.id, revision: page.revision }] as const] : [])]);
  return { preview, context, adopt, withhold, holds, parked, settled, compared, incarnation };
}

function emptyPreview(sourceId: string, context: ManagedSyncContext, census: GitGapCensus): GitConversionPreview {
  return { status: 'preview', source_id: sourceId, to: 'git', strict: context.source.config?.canonical === 'git', head: census.head, pages: census.pages, equal: census.states.equal,
    adopt: { ...counted(ADOPT_STATES), action: 'commit_through_door', groups: 0 }, declared: { ...counted<string>([]), action: 'none', committed_equal: 0 },
    git_wins: { ...counted(GIT_WINS_REASONS), action: 'index_committed_blob' }, withhold: { ...counted(WITHHOLD_KINDS), action: 'commit_removal_and_withhold', groups: 0 }, holds: { ...counted<string>([]), action: 'clear', unplaced: { count: 0, by: {} } },
    parked_effects: { count: 0, retry: 0, reclassify: 0, by_code: {} }, index: { imports: 0, deletes: 0 }, discard: emptyDiscard(), remaining: 0, preview_hash: '', apply: [] };
}

/** A hold's fate: a held deletion or an unknown-side drift goes to Git (planGitConversion discards the drift when its row differs), a both-sides drift is database content Git would discard, the rest re-screen. */
function holdItem(hold: GitHoldRecord): HoldItem {
  const side = hold.code === 'file_drift' ? fileDriftSide(hold.meta) ?? null : null;
  const action = side === 'both' ? 'blocked' : side === 'unknown' || side === 'deleted' ? 'git_wins' : 'rescreen';
  return { path: hold.path, code: hold.code, side, observed_at: hold.observed_at, action };
}

/**
 * What the adoption plan needs of a page's export view, kept instead of the view: the sha256 of its exported bytes, and
 * how those bytes read back under the census contract.
 */
class ExportChecks {
  private readonly checks = new Map<string, { digest: string; readBack: ExportFileComparison }>();
  constructor(private readonly root: string, private readonly mode: Awaited<ReturnType<typeof scannerSlugRootMode>>) {}
  add(id: string, path: string, snapshot: ExportSnapshot): void {
    const bytes = Buffer.from(inlineExportMarkdown(snapshot));
    this.checks.set(id, { digest: sha256(bytes), readBack: compareInlineExportFile(bytes, scannerSourcePath(this.root, join(this.root, path), this.mode), snapshot) });
  }
  get(id: string) { return this.checks.get(id); }
}

/**
 * Each adoption candidate's export bytes must read back equal under the census contract, its target must not be ignored,
 * and the working tree must hold HEAD's bytes, the export's, or nothing: an uncommitted edit is never overwritten. A
 * database_ahead page's export view is the one the census compared; the other candidates are read ADOPTION_BATCH at a
 * time in read-only transactions (#7617).
 */
async function planAdoption(engine: BrainEngine, sourceId: string, root: string, candidates: Array<{ page: GitGapPage; state: AdoptState }>, exported: ExportChecks,
  preview: GitConversionPreview, adopt: AdoptItem[], discard: (category: DiscardCategory, path: string) => void): Promise<void> {
  if (!candidates.length) return;
  const status = await ignoredPaths(root, candidates.map(({ page }) => page.path!))
    ?? { ignored: new Set<string>(), unknown: new Map(candidates.map(({ page }) => [page.path!, 'git_error' as const])) };
  const unread = candidates.map(({ page }) => page).filter(page => !status.ignored.has(page.path!) && !status.unknown.has(page.path!) && !page.segmented && !exported.get(page.id));
  const withdrawals = unread.length ? await readExportWithdrawals(engine, sourceId) : [];
  for (let start = 0; start < unread.length; start += ADOPTION_BATCH) {
    const batch = unread.slice(start, start + ADOPTION_BATCH);
    const snapshots = await engine.transaction(async tx => {
      await tx.executeRaw('SET TRANSACTION READ ONLY');
      return readExportPages(tx, batch.map(page => ({ ...page, source_id: sourceId })), withdrawals);
    });
    batch.forEach((page, i) => exported.add(page.id, page.path!, snapshots[i]!));
  }
  for (const { page, state } of candidates) {
    const path = page.path!;
    // A target Git cannot check (beyond a symlink, outside the checkout, a timed-out check) is never written; the census
    // declares an ignored path with no file git_ignored, so ignored_target is a path whose rules changed since it read them.
    const unknown = status.unknown.get(path);
    if (unknown) { discard('ignore_status_unknown', path); bump(preview.discard.detail.ignore_status_unknown, unknown); continue; }
    if (status.ignored.has(path)) { discard('ignored_target', path); continue; }
    if (page.segmented) { discard('segmented_page', path); continue; }
    const check = exported.get(page.id)!;
    const { readBack } = check;
    if (readBack.state !== 'equal') {
      discard('export_mismatch', path);
      for (const field of readBack.state === 'differs' ? readBack.paths : [`unparseable:${readBack.reason}`]) bump(preview.discard.detail.export_mismatch, field);
      continue;
    }
    const disk = diskBytes(join(root, path));
    if (page.worktree !== 'clean' && page.worktree !== 'absent' && !(disk && sha256(disk) === check.digest)) {
      discard('uncommitted_edit', path);
      bump(preview.discard.detail.uncommitted_edit, page.worktree ?? 'unknown');
      continue;
    }
    adopt.push({ id: page.id, source_id: sourceId, slug: page.slug, revision: page.revision, path, state, disk: disk ? sha256(disk) : null });
    tally(preview.adopt, state, path);
  }
}

/**
 * The declared pages whose committed file reads back equal to the page's export view under the census contract (#7618): a
 * strict import of that file changes nothing, so the conversion leaves the file in HEAD and the page settled. Read
 * ADOPTION_BATCH at a time in read-only transactions.
 */
async function equalDeclaredPaths(engine: BrainEngine, sourceId: string, root: string, mode: Awaited<ReturnType<typeof scannerSlugRootMode>>,
  pages: GitGapPage[]): Promise<Set<string>> {
  const equal = new Set<string>();
  if (!pages.length) return equal;
  const withdrawals = await readExportWithdrawals(engine, sourceId);
  for (let start = 0; start < pages.length; start += ADOPTION_BATCH) {
    const batch = pages.slice(start, start + ADOPTION_BATCH);
    const blobs = await readBlobs(root, batch.map(page => ({ oid: page.headBlob!, size: page.headSize ?? 0, mode: '100644' })));
    if (!blobs) throw opError('storage_error', `Git could not read committed files of source ${sourceId}'s checkout, so nothing was planned.`,
      `Check the checkout with git -C ${root} fsck, then preview again.`);
    const snapshots = await engine.transaction(async tx => {
      await tx.executeRaw('SET TRANSACTION READ ONLY');
      return readExportPages(tx, batch.map(page => ({ ...page, source_id: sourceId })), withdrawals);
    });
    batch.forEach((page, i) => {
      const comparison = compareInlineExportFile(blobs.get(page.headBlob!)!, scannerSourcePath(root, join(root, page.path!), mode), snapshots[i]!);
      if (comparison.state === 'equal') equal.add(page.path!);
    });
  }
  return equal;
}

/** A level path (Git-root relative) as the census names it (source-root relative). */
const sourcePath = (scope: string, gitPath: string) => scope && gitPath.startsWith(`${scope}/`) ? gitPath.slice(scope.length + 1) : gitPath;

function diskBytes(path: string): Buffer | null {
  try { return lstatSync(path).isFile() ? readFileSync(path) : null; } catch { return null; }
}

/** Parked Git targets of the source (the census's parked list), each effect with its action. */
async function readParked(engine: BrainEngine, sourceId: string): Promise<ParkedItem[]> {
  const rows = await engine.executeRaw<{ effect: string; request: string; kind: string; parked: Array<{ slug?: string; error_code: string }> }>(
    `SELECT e.id::text AS effect, r.request_id::text AS request, e.kind, e.data->'parked' AS parked FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE e.source_id=$1 AND jsonb_typeof(e.data->'parked')='array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.data->'parked') p WHERE p->>'declared' IS NULL)
    ORDER BY e.id`, [sourceId]);
  return rows.map(row => {
    const parked = typeof row.parked === 'string' ? JSON.parse(row.parked) as typeof row.parked : row.parked;
    const codes = parked.map(target => target.error_code);
    return { effect: row.effect, request: row.request, kind: row.kind, codes, slugs: parked.flatMap(target => target.slug ? [target.slug] : []),
      action: row.kind === 'git' && codes.every(code => code === 'git_target_ignored') ? 'reclassify' as const : 'retry' as const };
  });
}

/**
 * The level a strict pass reads (G3's reindex preview): what it imports or deletes, and every page version it would
 * replace that the plan has not placed (`git_overwrites_database`). `placed`: paths the plan already placed (equal,
 * adopted, accepted or counted as discard). A hold the plan did not place is cleared before the strict pass, so its path
 * is judged as that pass will see it, without the hold. `declared`: the census's declared class by page id.
 */
async function planIndex(engine: BrainEngine, context: ManagedSyncContext, preview: GitConversionPreview, placed: ReadonlySet<string>, unplacedHolds: ReadonlySet<string>,
  declared: ReadonlyMap<string, DeclaredClass>, discard: (category: DiscardCategory, path: string) => void): Promise<void> {
  const level = await readShadowLevel(engine, { sourceId: context.sourceId, full: true, context: strictContext(context) });
  if (!level) return;
  for (const entry of level.paths) {
    const path = sourcePath(level.scope, entry.path);
    if (placed.has(path)) continue;
    const state = unplacedHolds.has(path) ? { ...entry.state, hold: null } : entry.state;
    const result = state === entry.state ? entry.result : classifySyncPath(state, { strict: true });
    if (result.settled || result.inFlight || (result.action !== 'import' && result.action !== 'delete')) continue;
    if (!result.gitWins) { preview.index[result.action === 'import' ? 'imports' : 'deletes']++; continue; }
    discard('git_overwrites_database', path);
    const before = classifySyncPath(state);
    const detail = before.cls === result.gitWins ? before.sub ?? before.side ?? before.state : undefined;
    const kind = !state.page?.live ? 'tombstone_or_none' : declared.has(String(entry.pageId)) ? `declared:${declared.get(String(entry.pageId))}` : 'live';
    bump(preview.discard.detail.git_overwrites_database[detail ? `${result.gitWins}:${detail}` : result.gitWins] ??= {}, kind);
  }
}

export interface GitConversionResult {
  status: 'converted' | 'incomplete';
  source_id: string;
  head: string | null;
  committed: { groups: number; pages: number; commits: string[] };
  /** Privacy-class pages that now withhold their origin, and the door commits that removed their committed files. */
  withheld: { pages: number; commits: string[] };
  holds_cleared: number;
  parked: { retried: number; reclassified: number };
  /** #7644: the push of the door commits, as it stood when the apply ended. */
  push: ConversionPush;
  /** The closing strict passes that imported door commits landed after strict_pass_2 read its level (CLOSING_PASSES). */
  closing_passes: number;
  /** The plan after the flag was set and the strict passes ran: nothing left on a completed conversion. */
  after: GitConversionPreview;
}

/**
 * A live writer's door commits (`gbrain git commit-push`) that land after strict_pass_2 read its level leave the closing
 * plan with Git ahead of the database at their paths (git_wins) and nothing else. The source is git-canonical by then and
 * those commits are Git's, so an incremental strict pass imports them and loses nothing: the apply runs up to this many
 * such passes, planning again after each. Any other open item, or Git still ahead after the last one, ends incomplete.
 */
export const CLOSING_PASSES = 3;

const blockedError = (preview: GitConversionPreview): OperationError => {
  const categories = DISCARD_CATEGORIES.filter(category => preview.discard.by[category] > 0);
  return opError('git_conversion_blocked', `Converting source ${preview.source_id} would discard database content or cannot place it (${categories.map(category => `${category} ${preview.discard.by[category]}`).join(', ')}); nothing was written.`,
    `Resolve each listed path (gbrain sources canonical ${preview.source_id} --to git --dry-run lists them), then preview again. There is no override.`,
    { reason: categories[0], docs: DOCS, detail: categories.join(','), fix: { argv: ['gbrain', 'sources', 'canonical', preview.source_id, '--to', 'git', '--dry-run', '--json'], consent: [], actor: 'user',
      requires_exclusive: false, why: 'Lists every path of each blocking category; nothing changes.',
      user_message: `Converting ${preview.source_id} to git-canonical would lose database content in ${categories.join(', ')}. Each path needs a decision before conversion can run.` } });
};

/** The apply of `--to git` (see the header). Throws preview_changed or git_conversion_blocked before writing anything. */
export async function applyGitConversion(engine: BrainEngine, sourceId: string, expect: string,
  opts: { noEmbed?: boolean; noExtract?: boolean; onProgress?: (progress: ConversionProgress) => void } = {}): Promise<GitConversionResult> {
  const previewCommand = `gbrain sources canonical ${sourceId} --to git --dry-run`;
  const plan = await planGitConversion(engine, sourceId);
  if (plan.preview.preview_hash !== expect) throw previewChangedError(expect, previewCommand);
  if (plan.preview.discard.count) throw blockedError(plan.preview);
  const progress: ConversionProgress = { phase: 'adopt', groups_committed: 0, scanned: 0, total: plan.adopt.length };
  const report: ConversionReporter = patch => { Object.assign(progress, patch); opts.onProgress?.({ ...progress }); };
  report({});
  const committed = await adoptGroups(engine, plan, previewCommand, report);
  report({ phase: 'withhold', scanned: 0, total: plan.withhold.length });
  const withheld = await withholdGroups(engine, plan, previewCommand, groups => report({ scanned: progress.scanned + groups.pages, groups_committed: committed.groups + groups.commits }));
  report({ push: await pushConversion(engine, plan.context) });
  const parked = await settleParked(engine, sourceId, plan.parked);
  report({ phase: 'recheck', scanned: 0, total: 0 });
  // The planned holds are cleared only once this check passes, so a refusal keeps them: a held path is judged as the
  // strict pass will see it once its hold is cleared. A page the plan settled as equal to its file is judged again once it
  // moved since (its equality no longer holds).
  const held = new Set(plan.holds.map(hold => hold.path));
  const moved = await movedSincePlan(engine, sourceId, plan.compared);
  const recheck = await readShadowLevel(engine, { sourceId, full: true, context: strictContext(plan.context) });
  const preview = { ...plan.preview, discard: emptyDiscard() };
  for (const entry of recheck?.paths ?? []) {
    const path = sourcePath(recheck!.scope, entry.path);
    if (plan.settled.has(path) && !moved.has(path)) continue;
    const result = held.has(path) ? classifySyncPath({ ...entry.state, hold: null }, { strict: true }) : entry.result;
    if (!result.settled && !result.inFlight && result.gitWins) tally(preview.discard, 'git_overwrites_database', path);
  }
  if (preview.discard.count) throw blockedError(preview);
  report({ phase: 'holds', scanned: 0, total: plan.holds.length });
  let holdsCleared = 0;
  for (const hold of plan.holds) {
    if (await engine.transaction(tx => clearGitHold(tx, { sourceId, incarnation: plan.incarnation, path: hold.path, observedAt: hold.observed_at }))) holdsCleared++;
    report({ scanned: progress.scanned + 1 });
  }
  const processing = { noEmbed: opts.noEmbed, noExtract: opts.noExtract };
  const planned = recheck?.paths.length ?? 0;
  const pass = (phase: 'strict_pass_1' | 'strict_pass_2' | 'strict_pass_closing', total = planned) => {
    report({ phase, scanned: 0, total, ...ROUND_RESET });
    return strictPass(engine, sourceId, { sourceId, noPull: true, fullRound: phase !== 'strict_pass_closing', ...processing,
      ...(phase === 'strict_pass_1' ? { canonicalOverride: 'git' as const } : {}), onProgress: passProgress(report) });
  };
  passOrThrow(sourceId, 'strict_pass_1', await pass('strict_pass_1'), progress);
  await faultPoint('conversion:before_flip', { sourceId });
  await recordConversion(engine, sourceId, plan.incarnation, 'git', expect, plan.preview.head);
  passOrThrow(sourceId, 'strict_pass_2', await pass('strict_pass_2'), progress);
  const final = await pushConversion(engine, plan.context);
  const push = final.reason === 'nothing_to_push' ? progress.push! : final;
  report({ push });
  let after = (await planGitConversion(engine, sourceId)).preview, closing = 0;
  for (; after.strict && after.remaining > 0 && after.remaining === after.git_wins.count && closing < CLOSING_PASSES; closing++) {
    passOrThrow(sourceId, 'strict_pass_closing', await pass('strict_pass_closing', after.git_wins.count), progress);
    after = (await planGitConversion(engine, sourceId)).preview;
  }
  return { status: after.remaining === 0 ? 'converted' : 'incomplete', source_id: sourceId, head: after.head, committed, withheld, holds_cleared: holdsCleared, parked, push,
    closing_passes: closing, after };
}

/**
 * #7644: a door commit of the apply belongs to no write request, so no push-only Git effect pushes it (G2 pairs every other
 * door commit with one). Where durability applies, the apply pushes them itself under the worktree writer lock, after the
 * adoption and withhold groups and once at the end. A push that fails leaves them local and the apply goes on: the next
 * page write's push-only effect pushes the branch.
 */
async function pushConversion(engine: BrainEngine, context: ManagedSyncContext): Promise<ConversionPush> {
  const { root } = context;
  const pending = (code: string, why: string): ConversionPush => ({ state: 'pending', code,
    notice: `The conversion's door commits are committed locally, but their push did not land (${why}). Nothing retries it until the next page write, whose push sends them; to push now, run gbrain git commit-push --push-only --path ${root}.` });
  try {
    if (!(await gitDurabilityPolicy(context.binding, root)).durable) return { state: 'skipped', reason: DURABILITY_NOT_ENABLED_REASON };
    if (!(await gitRootAhead(root))) return { state: 'skipped', reason: 'nothing_to_push' };
    const lock = await acquireWorktree(context.binding, LOCK_WAIT_MS, undefined, engine, { yieldLanes: true });
    if (!lock) return pending('writer_busy', `the writer lock stayed busy for ${LOCK_WAIT_MS / 1000}s`);
    try {
      const pushed = await pushGitRoot(root);
      return pushed.push === 'committed' ? { state: 'pushed' } : { state: 'skipped', reason: pushed.reason };
    } finally { await lock.release(); }
  } catch (error) {
    return pending(error instanceof OperationError ? error.code : 'git_push_unavailable', error instanceof Error ? error.message : String(error));
  }
}

/**
 * #7866: a strict pass of the apply. It drains (sync-drain.ts) under the source's drain lease, as `gbrain sync` does: the
 * single pass (`performManagedSync`) stops `writer_pending` whenever one of its own writes outlives its 5 s wait, which on a
 * large source ended the conversion on work it had queued itself. The drain re-enters on that and stops only on its own
 * rules (no progress, contention, a blocked head), so an unrelated write that never settles still stops the apply.
 */
async function strictPass(engine: BrainEngine, sourceId: string, opts: SyncOpts): Promise<SyncResult> {
  const { withDrainLease, leaseHeldResult, readDrainHolder } = await import('./sync-lease.ts');
  const { drainManagedSync } = await import('./sync-drain.ts');
  const { withSyncTail } = await import('./sync-tail.ts');
  try {
    const drained = await withDrainLease(engine, sourceId, { holder: { kind: 'cli', id: null }, remote: false },
      signal => drainManagedSync(engine, signal ? { ...opts, signal } : opts, false));
    return await withSyncTail(engine, sourceId, drained, { signal: opts.signal });
  } catch (error) {
    if (!(error instanceof LockUnavailableError) || error.lockId !== syncLockId(sourceId)) throw error;
    return leaseHeldResult(sourceId, await readDrainHolder(engine, sourceId).catch(() => null));
  }
}

/**
 * A strict pass's progress events as the apply's (#7866): `total` stays the planned paths; a round names its candidates
 * and each import batch, and `scanned` counts the round's settled candidates across its batches.
 */
function passProgress(report: ConversionReporter): NonNullable<SyncOpts['onProgress']> {
  let base = 0;
  return event => {
    const round = event.round;
    if (round && event.phase === 'managed_sync.round_level') { base = 0; report({ ...ROUND_RESET, round: round.round, scanned: 0 }); }
    else if (round && event.phase === 'managed_sync.round_admit') report({ round: round.round, scanned: 0, candidates: (round.imports ?? 0) + (round.deletes ?? 0) });
    else if (round && event.phase === 'managed_sync.round_batch') { base = round.base ?? 0; report({ round: round.round, scanned: base, batch: round.batch, batches: round.batches }); }
    else if (event.bankedFiles !== undefined && event.phase !== 'managed_sync.level_progress' && event.phase !== 'managed_sync.legacy_swept') report({ scanned: base + event.bankedFiles });
  };
}

/** The paths of `compared` whose page has another revision than the plan compared, or is gone. */
async function movedSincePlan(engine: BrainEngine, sourceId: string, compared: Map<string, PageRevision>): Promise<Set<string>> {
  const moved = new Set<string>();
  const entries = [...compared];
  for (let start = 0; start < entries.length; start += MOVED_BATCH) {
    const batch = entries.slice(start, start + MOVED_BATCH);
    const rows = await engine.executeRaw<{ id: string; revision: string | null }>(`SELECT id::text AS id, knowledge_revision::text AS revision FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND id = ANY(string_to_array($2::text, ',')::bigint[])`, [sourceId, batch.map(([, page]) => page.id).join(',')]);
    const live = new Map(rows.map(row => [row.id, row.revision]));
    for (const [path, page] of batch) if (!live.has(page.id) || live.get(page.id) !== page.revision) moved.add(path);
  }
  return moved;
}

const PASS_DONE = new Set(['first_sync', 'synced', 'up_to_date']);
/** The operator step every git_conversion_incomplete refusal carries (#7866): preview again, verified by the source's sync status. */
export function conversionIncompleteFix(sourceId: string): Action {
  return { argv: ['gbrain', 'sources', 'canonical', sourceId, '--to', 'git', '--dry-run', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Plans the conversion again from where it stopped (the door groups already committed read equal); read-only. Apply its new hash once the source is idle.',
    verify: { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] } };
}
function passOrThrow(sourceId: string, phase: ConversionPhase, result: SyncResult, at: ConversionProgress): void {
  if (PASS_DONE.has(result.status) && syncOutcome(result) === 'synced') return;
  const stop = result.drain?.stop_reason ?? result.reason;
  const written = result.added + result.modified + result.deleted + result.renamed;
  throw opError('git_conversion_incomplete', `The ${phase} of source ${sourceId} ended ${result.status}${stop ? ` (${stop})` : ''} after ${written} page write(s), at round ${at.round ?? 0}, ${at.scanned} of ${at.candidates ?? 0} candidate(s) settled of ${at.total} planned path(s); the conversion stopped there${phase === 'strict_pass_1' ? ' and the source is still mixed' : ' and the source stays git-canonical'}.`,
    `Run gbrain sync status --source ${sourceId} --json until the source is idle, then preview again with gbrain sources canonical ${sourceId} --to git --dry-run and apply the new hash.`,
    { docs: DOCS, reason: stop ?? result.status, detail: `${result.status}${stop ? `:${stop}` : ''}`, fix: conversionIncompleteFix(sourceId) });
}

/**
 * Writes and commits the adopted pages group by group under the worktree writer lock. A page whose revision or working
 * tree moved since the preview stops the apply (preview_changed) before anything else changes: the groups already
 * committed hold the bytes the database has, so the rerun preview reads them equal.
 */
async function adoptGroups(engine: BrainEngine, plan: GitConversionPlan, previewCommand: string, report: ConversionReporter): Promise<GitConversionResult['committed']> {
  const { context, adopt } = plan;
  const root = context.root;
  const commits: string[] = [];
  const withdrawals = adopt.length ? await readExportWithdrawals(engine, context.sourceId) : [];
  for (let start = 0; start < adopt.length; start += CONVERSION_GROUP_MAX) {
    const group = adopt.slice(start, start + CONVERSION_GROUP_MAX);
    const lock = await acquireWorktree(context.binding, LOCK_WAIT_MS, undefined, engine, { yieldLanes: true });
    if (!lock) throw opError('writer_busy', `The writer lock of source ${context.sourceId}'s checkout stayed busy for ${LOCK_WAIT_MS / 1000}s, so group ${start / CONVERSION_GROUP_MAX + 1} was not committed.`,
      `Run ${previewCommand} again; the groups already committed read equal, so the new plan holds only what is left.`, { retryable: true, fix: conversionIncompleteFix(context.sourceId) });
    try {
      const files: Array<{ path: string; bytes: Buffer }> = [];
      for (const item of group) {
        const [live] = await engine.executeRaw<{ revision: string | null }>('SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1::bigint AND deleted_at IS NULL', [item.id]);
        const target = join(root, item.path);
        const disk = diskBytes(target);
        if (!live || live.revision !== item.revision || (disk ? sha256(disk) : null) !== item.disk) throw previewChangedError(plan.preview.preview_hash, previewCommand);
        files.push({ path: target, bytes: Buffer.from(inlineExportMarkdown(await readExportPage(engine, item, withdrawals))) });
      }
      for (const file of files) writeAtomically(root, file.path, file.bytes);
      const commit = await commitThroughDoor(root, files.map(file => ({ path: file.path, planned: sha256(file.bytes) })), lock);
      if (commit) commits.push(commit);
    } finally { await lock.release(); }
    report({ scanned: start + group.length, groups_committed: commits.length });
    await faultPoint('conversion:group_committed', { sourceId: context.sourceId, round: start / CONVERSION_GROUP_MAX + 1 });
  }
  return { groups: commits.length, pages: adopt.length, commits };
}

/**
 * G7a's private transition for each withheld page, mirrored from git-declared.ts `declareStrictPublication` (privacy
 * branch), which runs only inside a publication: group by group under the writer lock, a transaction stamps the class and
 * moves `source_path` to `withheld_source_path`, then the files' removal goes through the door. Stamped first, no sync
 * (the strict pass or a mixed one run before a rerun) reads the removal as the deletion of a live page; a crash between
 * the stamp and the commit leaves the file in HEAD, which a mixed sync holds and the rerun preview (which reads a withheld
 * page's file at withheld_source_path) withholds again. A page whose file is already absent from HEAD only gets the stamp,
 * CONVERSION_GROUP_MAX at a time. The stamp updates only the planned revision: a page whose revision or working tree moved
 * since the preview stops the apply (preview_changed) before its group is stamped; the groups before it stay withheld and
 * the rerun lists only what is left.
 */
async function withholdGroups(engine: BrainEngine, plan: GitConversionPlan, previewCommand: string,
  onGroup: (done: { pages: number; commits: number }) => void): Promise<GitConversionResult['withheld']> {
  const { context } = plan;
  const root = context.root;
  const commits: string[] = [];
  const stamp = (items: WithholdItem[]) => engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    for (const item of items) {
      const [stamped] = await tx.executeRaw<{ id: string }>(`UPDATE pages SET database_only_reason=$2, withheld_source_path=COALESCE(NULLIF(source_path,''), withheld_source_path),
        source_path=NULL, source_uri=NULL WHERE id=$1::bigint AND deleted_at IS NULL AND knowledge_revision::text IS NOT DISTINCT FROM $3 RETURNING id`, [item.id, item.declared, item.revision]);
      if (!stamped) throw previewChangedError(plan.preview.preview_hash, previewCommand);
    }
  });
  const committed = plan.withhold.filter(item => item.kind === 'file_committed');
  for (let start = 0; start < committed.length; start += CONVERSION_GROUP_MAX) {
    const group = committed.slice(start, start + CONVERSION_GROUP_MAX);
    const lock = await acquireWorktree(context.binding, LOCK_WAIT_MS, undefined, engine, { yieldLanes: true });
    if (!lock) throw opError('writer_busy', `The writer lock of source ${context.sourceId}'s checkout stayed busy for ${LOCK_WAIT_MS / 1000}s, so the removal of private pages' files was not committed.`,
      `Run ${previewCommand} again; the pages already withheld drop out of the plan, so the new plan holds only what is left.`, { retryable: true, fix: conversionIncompleteFix(context.sourceId) });
    try {
      for (const item of group) {
        const target = join(root, item.path);
        const disk = diskBytes(target);
        if ((disk ? sha256(disk) : null) !== item.disk) throw previewChangedError(plan.preview.preview_hash, previewCommand);
        if (disk) assertConfined(root, target, 'removed');
      }
      await stamp(group);
      await faultPoint('conversion:withhold_stamped', { sourceId: context.sourceId, round: start / CONVERSION_GROUP_MAX + 1 });
      for (const item of group) {
        const target = join(root, item.path);
        const disk = diskBytes(target);
        if (disk && sha256(disk) !== item.disk) throw previewChangedError(plan.preview.preview_hash, previewCommand);
        removeConfined(root, target);
      }
      const commit = await commitThroughDoor(root, group.map(item => ({ path: join(root, item.path), planned: null })), lock);
      if (commit) commits.push(commit);
      await faultPoint('conversion:withhold_committed', { sourceId: context.sourceId, round: start / CONVERSION_GROUP_MAX + 1 });
    } finally { await lock.release(); }
    onGroup({ pages: group.length, commits: commits.length });
  }
  const absent = plan.withhold.filter(item => item.kind === 'file_absent');
  for (let start = 0; start < absent.length; start += CONVERSION_GROUP_MAX) {
    const group = absent.slice(start, start + CONVERSION_GROUP_MAX);
    await stamp(group);
    onGroup({ pages: group.length, commits: commits.length });
  }
  return { pages: plan.withhold.length, commits };
}

function assertConfined(root: string, target: string, verb: 'removed' | 'written'): void {
  if (relative(realpathSync(root), realpathSync(dirname(target))).split(sep)[0] === '..') throw opError('git_target_unsafe', `${target} resolves outside the checkout, so it was not ${verb}.`, 'Reconcile the path first.');
}

function removeConfined(root: string, target: string): void {
  if (!diskBytes(target)) return;
  assertConfined(root, target, 'removed');
  rmSync(target);
}

function writeAtomically(root: string, target: string, bytes: Buffer): void {
  mkdirSync(dirname(target), { recursive: true });
  assertConfined(root, target, 'written');
  const temp = join(dirname(target), `.gbrain-convert-${process.pid}-${Date.now()}.tmp`);
  try { writeFileSync(temp, bytes); renameSync(temp, target); } finally { rmSync(temp, { force: true }); }
}

/** Retries each parked effect once (retry-effects' authorization) and stamps the pages of ignored targets git_ignored. */
async function settleParked(engine: BrainEngine, sourceId: string, parked: ParkedItem[]): Promise<GitConversionResult['parked']> {
  let retried = 0, reclassified = 0;
  for (const item of parked) {
    if (item.action === 'reclassify') {
      // Metadata only (G7a has no standalone declare helper): the page's declared class and the parked record change together.
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw('SELECT id FROM persistence_effects WHERE id=$1 FOR UPDATE', [item.effect]);
        await tx.executeRaw(`UPDATE pages SET database_only_reason='git_ignored' WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL AND database_only_reason IS NULL`, [sourceId, item.slugs]);
        await tx.executeRaw(`UPDATE persistence_effects SET data=jsonb_set(data,'{parked}',(SELECT jsonb_agg(p||'{"declared":"git_ignored"}'::jsonb) FROM jsonb_array_elements(data->'parked') p)),updated_at=now() WHERE id=$1`, [item.effect]);
      });
      reclassified++;
      continue;
    }
    const result = await retryParkedEffects(engine, sourceId, item.request, false, { parkedOnly: true });
    if ((result?.effects as Array<{ action?: string }> | undefined)?.some(effect => effect.action === 'retry_queued')) retried++;
  }
  if (retried) await runPersistenceEffects(engine, loadConfig() ?? { engine: engine.kind }, { hostId: localHostId(), limit: 50 });
  return { retried, reclassified };
}

/** Sets or removes the flag in the transaction that records the conversion (op_checkpoints `git-canonical-conversion`, one row per source incarnation). */
export async function recordConversion(engine: BrainEngine, sourceId: string, incarnation: string, to: 'git' | 'mixed', hash: string, head: string | null): Promise<void> {
  await engine.transaction(async tx => {
    const [updated] = await tx.executeRaw<{ id: string }>(to === 'git'
      ? `UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id=$1 AND incarnation::text=$2 RETURNING id`
      : `UPDATE sources SET config = config - 'canonical' WHERE id=$1 AND incarnation::text=$2 RETURNING id`, [sourceId, incarnation]);
    if (!updated) throw opError('source_changed', `Source ${sourceId} was replaced during the conversion, so its mode was not changed.`, `Preview again with gbrain sources canonical ${sourceId} --to ${to} --dry-run.`);
    await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
      ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
      [CONVERSION_OP, `${sourceId}:${incarnation}`, JSON.stringify([{ source_id: sourceId, incarnation, to, preview_hash: hash, head }])]);
  });
}

export interface MixedConversionPreview { status: 'preview'; source_id: string; to: 'mixed'; strict: boolean; preview_hash: string; apply: string[] }

/** `--to mixed`: the source stops being strict. Bound to the source incarnation and its current flag; nothing else is read. */
export async function planMixedConversion(engine: BrainEngine, sourceId: string): Promise<MixedConversionPreview & { incarnation: string }> {
  await resolveSourceId(engine, sourceId, undefined, { skipLocalSignals: true });
  const [source] = await engine.executeRaw<{ incarnation: string; strict: boolean }>(
    "SELECT incarnation::text AS incarnation, COALESCE(config->>'canonical','')='git' AS strict FROM sources WHERE id=$1", [sourceId]);
  const preview_hash = previewHash({ source: sourceId, incarnation: source.incarnation, to: 'mixed', strict: source.strict });
  return { status: 'preview', source_id: sourceId, to: 'mixed', strict: source.strict, preview_hash, incarnation: source.incarnation,
    apply: ['gbrain', 'sources', 'canonical', sourceId, '--to', 'mixed', '--apply', '--expect', preview_hash] };
}

/** Removes `canonical: git` in the transaction that records it; Git keeps every door commit and no row changes. */
export async function applyMixedConversion(engine: BrainEngine, sourceId: string, expect: string): Promise<{ status: 'mixed' | 'unchanged'; source_id: string }> {
  const plan = await planMixedConversion(engine, sourceId);
  if (plan.preview_hash !== expect) throw previewChangedError(expect, `gbrain sources canonical ${sourceId} --to mixed --dry-run`);
  if (!plan.strict) return { status: 'unchanged', source_id: sourceId };
  await recordConversion(engine, sourceId, plan.incarnation, 'mixed', expect, null);
  return { status: 'mixed', source_id: sourceId };
}
