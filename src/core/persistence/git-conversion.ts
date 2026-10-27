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
 *   - declared: database-only on purpose; nothing is written and nothing deleted.
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
 * The apply re-plans and refuses preview_changed on a different hash, adopts group by group (a crash leaves the source
 * non-strict and the rerun preview lists only what is left), clears the holds, retries or reclassifies the parked
 * effects, checks the strict level once more (an overwrite nobody accepted stops it), runs the full strict-equivalent
 * pass (SyncOpts.canonicalOverride, internal) and sets `canonical: git` last, in the transaction that records the
 * conversion. Writes can land between that pass and the flag, so it then runs one genuine strict pass and plans again:
 * only a plan with no work left is a completed conversion; otherwise the source stays strict (Git wins) and the
 * remaining categories are reported. `--to mixed` removes the flag and changes nothing else.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { loadConfig } from '../config.ts';
import { resolveSourceId } from '../source-resolver.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { inlineExportMarkdown, readExportPage, readExportWithdrawals } from '../export-snapshot.ts';
import { scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { censusGitGap, type GitGapCensus, type GitGapPage } from '../../commands/sources-git-gap.ts';
import { compareInlineExportFile, ignoredPaths } from './git-gap.ts';
import { commitThroughDoor } from './git-door.ts';
import { currentVerifiedLocalWriter, localHostId } from './identity.ts';
import { acquireWorktree, readManagedMode } from './ownership.ts';
import { resolveManagedSyncContext, type ManagedSyncContext } from './sync-discovery.ts';
import { readShadowLevel } from './sync-pass.ts';
import { clearGitHold, fileDriftSide, readGitSourceHolds, readSyncImportProvenances, type GitHoldRecord } from './sync-holds.ts';
import { readDeletionProvenance } from './sync-origin-evidence.ts';
import { retryParkedEffects } from './effect-retry.ts';
import { runPersistenceEffects } from './effects.ts';
import { faultPoint } from './fault-points.ts';
import { declarePersistenceProtocol } from './protocol.ts';
import { previewChangedError, previewHash } from './preview-approval.ts';
import { sha256 } from './digest.ts';

export const CONVERSION_GROUP_MAX = 200;
export const CONVERSION_OP = 'git-canonical-conversion';
const DOCS = 'docs/designs/GIT_CANONICAL_MEMORY.md#conversion';
const SAMPLE = 20;
const LOCK_WAIT_MS = 30_000;

export const ADOPT_STATES = ['database_ahead', 'undeclared_database_only', 'worktree_only'] as const;
export type AdoptState = typeof ADOPT_STATES[number];
export const GIT_WINS_REASONS = ['git_ahead', 'deleted_by_commit', 'held_deletion', 'held_drift_unknown'] as const;
export type GitWinsReason = typeof GIT_WINS_REASONS[number];
/** Database content the apply would discard or cannot place, by why: each must be zero before the apply runs. */
export const DISCARD_CATEGORIES = ['both_moved', 'held_drift_both', 'held_drift_unknown_differs', 'deleted_in_git', 'uncommitted_edit', 'ignored_target', 'unparseable', 'unsafe_path',
  'segmented_page', 'export_mismatch', 'git_overwrites_database'] as const;
export type DiscardCategory = typeof DISCARD_CATEGORIES[number];

interface Counted<K extends string> { count: number; by: Record<K, number>; sample: string[] }
/** `disk`: sha256 of the working-tree bytes the preview saw (HEAD's or the export's), null when the file was absent. */
export interface AdoptItem { id: string; source_id: string; slug: string; revision: string | null; path: string; state: AdoptState; disk: string | null }
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
  declared: Counted<string> & { action: 'none' };
  git_wins: Counted<GitWinsReason> & { action: 'index_committed_blob' };
  holds: Counted<string> & { action: 'clear' };
  parked_effects: { count: number; retry: number; reclassify: number; by_code: Record<string, number> };
  /** What a strict pass would import or delete that no page row loses (files with no row, removals Git committed). */
  index: { imports: number; deletes: number };
  discard: Counted<DiscardCategory>;
  /** Every item the apply still has to act on (adopt, git_wins, holds, parked retries, discard); 0 on a converted source. */
  remaining: number;
  preview_hash: string;
  apply: string[];
}

/** `settled`: paths whose Git import replaces nothing (the census reads them equal, or the plan adopts or accepts them). */
export interface GitConversionPlan { preview: GitConversionPreview; context: ManagedSyncContext; adopt: AdoptItem[]; holds: HoldItem[]; parked: ParkedItem[]; settled: Set<string>; incarnation: string }

const counted = <K extends string>(keys: readonly K[]): Counted<K> => ({ count: 0, by: Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>, sample: [] });
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

/** The context a strict pass reads, for a source whose row does not say so yet. */
const strictContext = (context: ManagedSyncContext): ManagedSyncContext => ({ ...context, source: { ...context.source, config: { ...context.source.config, canonical: 'git' } } });

/** The read-only plan of `--to git`; its preview is what the CLI prints and the apply binds to. */
export async function planGitConversion(engine: BrainEngine, sourceId: string): Promise<GitConversionPlan> {
  const context = await resolveManagedSyncContext(engine, { sourceId, noPull: true, dryRun: true });
  const pages: GitGapPage[] = [];
  const equal = new Set<string>();
  const census = await censusGitGap(engine, sourceId, { sample: 0, collect: page => { if (page.state !== 'equal') pages.push(page); else if (page.path) equal.add(page.path); } });
  if (!census.checkout || realpathSync(census.checkout) !== context.root) {
    throw opError('source_changed', `Source ${sourceId}'s registered checkout is not its owner's root, so nothing was planned.`,
      `Check the owner with gbrain sources writer status --source ${sourceId} --json, then preview again.`);
  }
  const root = context.root;
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const holdRecords = (await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? [];
  const held = new Map(holdRecords.map(hold => [hold.path, hold]));
  const preview = emptyPreview(sourceId, context, census);
  const adopt: AdoptItem[] = [], accepted = new Set<string>(), discarded = new Set<string>();
  const discard = (category: DiscardCategory, path: string) => { tally(preview.discard, category, path); discarded.add(path); };
  const gitWins = (reason: GitWinsReason, path: string) => { tally(preview.git_wins, reason, path); accepted.add(path); };
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
      case 'declared_database_only': tally(preview.declared, page.declared!, path); continue;
      case 'unparseable': discard('unparseable', path); continue;
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
  await planAdoption(engine, sourceId, root, candidates, preview, adopt, discard);
  const parked = await readParked(engine, sourceId);
  for (const item of parked) for (const code of item.codes) preview.parked_effects.by_code[`${item.kind}:${code}`] = (preview.parked_effects.by_code[`${item.kind}:${code}`] ?? 0) + 1;
  preview.parked_effects.count = parked.length;
  preview.parked_effects.retry = parked.filter(item => item.action === 'retry').length;
  preview.parked_effects.reclassify = parked.filter(item => item.action === 'reclassify').length;
  const settled = new Set([...equal, ...adopt.map(item => item.path), ...accepted]);
  await planIndex(engine, context, preview, new Set([...settled, ...held.keys(), ...discarded]), discard);
  preview.adopt.groups = Math.ceil(adopt.length / CONVERSION_GROUP_MAX);
  preview.remaining = preview.adopt.count + preview.git_wins.count + preview.holds.count + preview.parked_effects.retry + preview.discard.count;
  preview.preview_hash = previewHash({ source: sourceId, incarnation, to: 'git', strict: preview.strict, head: preview.head, states: census.states, declared: census.declared,
    adopt: adopt.map(item => [item.id, item.revision, item.path, item.state, item.disk]), git_wins: [...accepted].sort(), discard: preview.discard.by,
    holds: holds.map(hold => [hold.path, hold.code, hold.side, hold.observed_at]), parked: parked.map(item => [item.effect, item.action, item.codes]), index: preview.index });
  preview.apply = ['gbrain', 'sources', 'canonical', sourceId, '--to', 'git', '--apply', '--expect', preview.preview_hash];
  return { preview, context, adopt, holds, parked, settled, incarnation };
}

function emptyPreview(sourceId: string, context: ManagedSyncContext, census: GitGapCensus): GitConversionPreview {
  return { status: 'preview', source_id: sourceId, to: 'git', strict: context.source.config?.canonical === 'git', head: census.head, pages: census.pages, equal: census.states.equal,
    adopt: { ...counted(ADOPT_STATES), action: 'commit_through_door', groups: 0 }, declared: { ...counted<string>([]), action: 'none' },
    git_wins: { ...counted(GIT_WINS_REASONS), action: 'index_committed_blob' }, holds: { ...counted<string>([]), action: 'clear' },
    parked_effects: { count: 0, retry: 0, reclassify: 0, by_code: {} }, index: { imports: 0, deletes: 0 }, discard: counted(DISCARD_CATEGORIES), remaining: 0, preview_hash: '', apply: [] };
}

/** A hold's fate: a held deletion or an unknown-side drift goes to Git (planGitConversion discards the drift when its row differs), a both-sides drift is database content Git would discard, the rest re-screen. */
function holdItem(hold: GitHoldRecord): HoldItem {
  const side = hold.code === 'file_drift' ? fileDriftSide(hold.meta) ?? null : null;
  const action = side === 'both' ? 'blocked' : side === 'unknown' || side === 'deleted' ? 'git_wins' : 'rescreen';
  return { path: hold.path, code: hold.code, side, observed_at: hold.observed_at, action };
}

/**
 * Each adoption candidate's export bytes must read back equal under the census contract, its target must not be ignored,
 * and the working tree must hold HEAD's bytes, the export's, or nothing: an uncommitted edit is never overwritten.
 */
async function planAdoption(engine: BrainEngine, sourceId: string, root: string, candidates: Array<{ page: GitGapPage; state: AdoptState }>, preview: GitConversionPreview,
  adopt: AdoptItem[], discard: (category: DiscardCategory, path: string) => void): Promise<void> {
  if (!candidates.length) return;
  const ignored = await ignoredPaths(root, candidates.map(({ page }) => page.path!));
  const mode = await scannerSlugRootMode(engine, sourceId, root);
  const withdrawals = await readExportWithdrawals(engine, sourceId);
  for (const { page, state } of candidates) {
    const path = page.path!;
    // Fail-closed fallback: an ignored path with no file is already declared git_ignored by the census, and Git commits a
    // tracked file whatever its ignore rules say, so this fires only when reading the ignore rules fails (ignored is null).
    if (!ignored || ignored.has(path)) { discard('ignored_target', path); continue; }
    if (page.segmented) { discard('segmented_page', path); continue; }
    const snapshot = await readExportPage(engine, { ...page, source_id: sourceId }, withdrawals);
    const bytes = Buffer.from(inlineExportMarkdown(snapshot));
    if (compareInlineExportFile(bytes, scannerSourcePath(root, join(root, path), mode), snapshot).state !== 'equal') { discard('export_mismatch', path); continue; }
    const disk = diskBytes(join(root, path));
    if (page.worktree !== 'clean' && page.worktree !== 'absent' && !disk?.equals(bytes)) { discard('uncommitted_edit', path); continue; }
    adopt.push({ id: page.id, source_id: sourceId, slug: page.slug, revision: page.revision, path, state, disk: disk ? sha256(disk) : null });
    tally(preview.adopt, state, path);
  }
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
 * replace that the plan has not placed (`git_overwrites_database`). `planned`: paths already placed (equal, adopted,
 * accepted, held or counted as discard).
 */
async function planIndex(engine: BrainEngine, context: ManagedSyncContext, preview: GitConversionPreview, planned: ReadonlySet<string>,
  discard: (category: DiscardCategory, path: string) => void): Promise<void> {
  const level = await readShadowLevel(engine, { sourceId: context.sourceId, full: true, context: strictContext(context) });
  if (!level) return;
  for (const entry of level.paths) {
    if (entry.result.settled || entry.result.inFlight || (entry.result.action !== 'import' && entry.result.action !== 'delete')) continue;
    const path = sourcePath(level.scope, entry.path);
    if (planned.has(path)) continue;
    if (entry.result.gitWins) discard('git_overwrites_database', path);
    else preview.index[entry.result.action === 'import' ? 'imports' : 'deletes']++;
  }
}

export interface GitConversionResult {
  status: 'converted' | 'incomplete';
  source_id: string;
  head: string | null;
  committed: { groups: number; pages: number; commits: string[] };
  holds_cleared: number;
  parked: { retried: number; reclassified: number };
  /** The plan after the flag was set and a strict pass ran: nothing left on a completed conversion. */
  after: GitConversionPreview;
}

const blockedError = (preview: GitConversionPreview): OperationError => {
  const categories = DISCARD_CATEGORIES.filter(category => preview.discard.by[category] > 0);
  return opError('git_conversion_blocked', `Converting source ${preview.source_id} would discard database content or cannot place it (${categories.map(category => `${category} ${preview.discard.by[category]}`).join(', ')}); nothing was written.`,
    `Resolve each listed path (gbrain sources canonical ${preview.source_id} --to git --dry-run lists them), then preview again. There is no override.`,
    { reason: categories[0], docs: DOCS, detail: categories.join(','), fix: { argv: ['gbrain', 'sources', 'canonical', preview.source_id, '--to', 'git', '--dry-run', '--json'], consent: [], actor: 'user',
      requires_exclusive: false, why: 'Lists every path of each blocking category; nothing changes.',
      user_message: `Converting ${preview.source_id} to git-canonical would lose database content in ${categories.join(', ')}. Each path needs a decision before conversion can run.` } });
};

/** The apply of `--to git` (see the header). Throws preview_changed or git_conversion_blocked before writing anything. */
export async function applyGitConversion(engine: BrainEngine, sourceId: string, expect: string, opts: { noEmbed?: boolean; noExtract?: boolean } = {}): Promise<GitConversionResult> {
  const previewCommand = `gbrain sources canonical ${sourceId} --to git --dry-run`;
  const plan = await planGitConversion(engine, sourceId);
  if (plan.preview.preview_hash !== expect) throw previewChangedError(expect, previewCommand);
  if (plan.preview.discard.count) throw blockedError(plan.preview);
  const committed = await adoptGroups(engine, plan, previewCommand);
  let holdsCleared = 0;
  for (const hold of plan.holds) {
    if (await engine.transaction(tx => clearGitHold(tx, { sourceId, incarnation: plan.incarnation, path: hold.path, observedAt: hold.observed_at }))) holdsCleared++;
  }
  const parked = await settleParked(engine, sourceId, plan.parked);
  const recheck = await readShadowLevel(engine, { sourceId, full: true, context: strictContext(plan.context) });
  const preview = { ...plan.preview, discard: counted(DISCARD_CATEGORIES) };
  for (const entry of recheck?.paths ?? []) {
    const path = sourcePath(recheck!.scope, entry.path);
    if (!entry.result.settled && !entry.result.inFlight && entry.result.gitWins && !plan.settled.has(path)) tally(preview.discard, 'git_overwrites_database', path);
  }
  if (preview.discard.count) throw blockedError(preview);
  const processing = { noEmbed: opts.noEmbed, noExtract: opts.noExtract };
  const { performManagedSync } = await import('./sync-run.ts');
  passOrThrow(sourceId, await performManagedSync(engine, { sourceId, noPull: true, full: true, ...processing, canonicalOverride: 'git' }));
  await faultPoint('conversion:before_flip', { sourceId });
  await recordConversion(engine, sourceId, plan.incarnation, 'git', expect, plan.preview.head);
  passOrThrow(sourceId, await performManagedSync(engine, { sourceId, noPull: true, full: true, ...processing }));
  const after = (await planGitConversion(engine, sourceId)).preview;
  return { status: after.remaining === 0 ? 'converted' : 'incomplete', source_id: sourceId, head: after.head, committed, holds_cleared: holdsCleared, parked, after };
}

const PASS_DONE = new Set(['first_sync', 'synced', 'up_to_date']);
function passOrThrow(sourceId: string, result: { status: string; reason?: string }): void {
  if (PASS_DONE.has(result.status)) return;
  throw opError('git_conversion_incomplete', `The strict pass of source ${sourceId} ended ${result.status}${result.reason ? ` (${result.reason})` : ''}, so the conversion stopped there.`,
    `Rerun gbrain sources canonical ${sourceId} --to git --dry-run once gbrain sync status --source ${sourceId} --json shows the source idle, then apply the new hash.`,
    { docs: DOCS, detail: result.status });
}

/**
 * Writes and commits the adopted pages group by group under the worktree writer lock. A page whose revision or working
 * tree moved since the preview stops the apply (preview_changed) before anything else changes: the groups already
 * committed hold the bytes the database has, so the rerun preview reads them equal.
 */
async function adoptGroups(engine: BrainEngine, plan: GitConversionPlan, previewCommand: string): Promise<GitConversionResult['committed']> {
  const { context, adopt } = plan;
  const root = context.root;
  const commits: string[] = [];
  const withdrawals = adopt.length ? await readExportWithdrawals(engine, context.sourceId) : [];
  for (let start = 0; start < adopt.length; start += CONVERSION_GROUP_MAX) {
    const group = adopt.slice(start, start + CONVERSION_GROUP_MAX);
    const lock = await acquireWorktree(context.binding, LOCK_WAIT_MS, undefined, engine, { yieldLanes: true });
    if (!lock) throw opError('writer_busy', `The writer lock of source ${context.sourceId}'s checkout stayed busy for ${LOCK_WAIT_MS / 1000}s, so group ${start / CONVERSION_GROUP_MAX + 1} was not committed.`,
      `Run ${previewCommand} again; the groups already committed read equal, so the new plan holds only what is left.`, { retryable: true });
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
    await faultPoint('conversion:group_committed', { sourceId: context.sourceId, round: start / CONVERSION_GROUP_MAX + 1 });
  }
  return { groups: commits.length, pages: adopt.length, commits };
}

function writeAtomically(root: string, target: string, bytes: Buffer): void {
  mkdirSync(dirname(target), { recursive: true });
  if (relative(realpathSync(root), realpathSync(dirname(target))).split(sep)[0] === '..') throw opError('git_target_unsafe', `${target} resolves outside the checkout, so it was not written.`, 'Reconcile the path first.');
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
