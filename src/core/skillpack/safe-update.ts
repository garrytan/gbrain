/**
 * skillpack/safe-update.ts — `gbrain skillpack reference <name>|--all --update-untouched`.
 *
 * Takes upstream on installed skills the user never edited, one whole skill
 * at a time. A skill's closure is every file under its bundle dir plus any
 * shared dependency it lacks; paired sources outside the skills root are
 * never written (they are reported).
 *
 * Classification, per file (the install's recorded base always wins):
 *   unchanged    already equals the bundle
 *   absent       missing and gbrain never recorded it (a new file)
 *   untouched    equals its recorded base
 *   local_edits  differs from its recorded base (even when it equals a past
 *                release), or has no base and matches no released version,
 *                or was deleted after gbrain recorded it
 *   historical   no base, equals a released version (needs --accept-historical)
 *   no_history   no base, and the released-version history has no entry
 * A skill is updatable only when it is not pinned, the history verified,
 * and every changed file is absent, untouched, or historical with
 * --accept-historical. Anything else skips the whole skill with a reason.
 *
 * Commit protocol: stage the closure in the skills root and validate it,
 * write the journal (update-journal.ts), back up each file, rehash it right
 * before its rename (abandon the skill on any change since classification),
 * then run conformance, the trigger check and the resolver check. A conflict,
 * an error or a failed check rolls back the files already renamed that still
 * hold the update's bytes. Bases are recorded only after a skill commits.
 * The caller holds the workspace writer lock; state writes take the shared
 * state lock (state.ts updateState), so the order is always workspace, state.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';

import { bundledSkillSlugs, enumerateScaffoldEntries, loadBundleManifest, type BundleManifest } from './bundle.ts';
import { loadVerifiedSkillsLockHistory, type VerifiedSkillsLockHistory } from '../skills-integrity.ts';
import { loadState, updateState, withSkillBases, type InstalledSkillRecord } from './state.ts';
import { unifiedDiff } from './diff-text.ts';
import { redactFindings } from '../secret-scan.ts';
import { parseSkillFrontmatter } from '../skill-frontmatter.ts';
import { loadSkillTriggerIndex } from '../skill-trigger-index.ts';
import { checkResolvable, type ResolvableIssue } from '../check-resolvable.ts';
import { OperationError } from '../ops/contract.ts';
import { confinedSkillChildWrite } from './writer-guard.ts';
import {
  backupFile, backupsRoot, hashTarget, newJournalId, pendingJournals, planRestore, pruneJournals, readJournal, sha256, undoFile, writeJournal,
  type Journal, type JournalFile, type JournalSkill, type RestorePlanFile,
} from './update-journal.ts';

export const DIFF_LINE_CAP = 200;
const STAGE_PREFIX = '.gbrain-skillpack-stage-';

export type FileState = 'unchanged' | 'absent' | 'untouched' | 'historical' | 'local_edits' | 'no_history';
export type SkipReason = 'pinned' | 'history_unverified' | 'unsafe_target' | 'local_edits' | 'no_history' | 'historical_only';

export interface ClassifiedFile {
  rel: string;
  source: string;
  post: string;
  pre: string | null;
  base: string | null;
  sharedDep: boolean;
  state: FileState;
}

export interface SkillOutcome {
  slug: string;
  result: 'updated' | 'would_update' | 'current' | 'skipped' | 'failed' | 'not_installed';
  reason?: SkipReason;
  pinned: boolean;
  /** Files the update writes (or would write). */
  changes: string[];
  /** Files with no base that match only a released version. */
  historical: string[];
  notes: string[];
  diffs?: Array<{ rel: string; diff: string; truncated: boolean }>;
  /** On failure: files this run renamed, and those it could not roll back because they changed again. */
  touched?: string[];
  rollback_skipped?: string[];
  failure?: string;
  files: ClassifiedFile[];
}

export interface UpdateResult {
  dry_run: boolean;
  skills_root: string;
  history: { verified: boolean; reason?: string };
  journal: string | null;
  pending_journals: string[];
  summary: Record<SkillOutcome['result'], number>;
  skills: SkillOutcome[];
  restore_command: string | null;
}

export interface UpdateOptions {
  gbrainRoot: string;
  /** Absolute skills root (see skillsRootKey). */
  skillsRoot: string;
  /** Skill slugs, or null for every bundled skill. */
  slugs: string[] | null;
  dryRun?: boolean;
  acceptHistorical?: boolean;
  noDiff?: boolean;
  statePath?: string;
  backups?: string;
  /** Post-rename checks; returns problems (empty = pass). Defaults to conformance + triggers + resolver. */
  validate?: (skillsRoot: string, slug: string) => string[];
  hooks?: { beforeRename?: (rel: string) => void; afterRename?: (rel: string) => void };
}

/** The key a skills root (or a file under it) is recorded under: the realpath of its deepest existing ancestor plus the rest. */
export function skillsRootKey(dir: string): string {
  const missing: string[] = [];
  let current = resolve(dir);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(dir);
      missing.push(basename(current));
      current = parent;
    }
  }
}

function fileState(pre: string | null, post: string, base: string | null, history: VerifiedSkillsLockHistory, rel: string): FileState {
  if (pre === post) return 'unchanged';
  if (base !== null) return pre === base ? 'untouched' : 'local_edits';
  if (pre === null) return 'absent';
  const released = history.ok ? history.history.files[rel] : undefined;
  if (!released?.length) return 'no_history';
  return released.includes(pre) ? 'historical' : 'local_edits';
}

function boundedRedactedDiff(local: Buffer, bundle: Buffer, rel: string): { diff: string; truncated: boolean } {
  if (local.includes(0) || bundle.includes(0)) return { diff: `Binary file ${rel} differs (local ${local.length} B, bundle ${bundle.length} B).\n`, truncated: false };
  const text = redactFindings(unifiedDiff(local.toString('utf-8'), bundle.toString('utf-8'), { oldPath: `a/${rel}`, newPath: `b/${rel}` })).text;
  const lines = text.split('\n');
  if (lines.length <= DIFF_LINE_CAP) return { diff: text, truncated: false };
  return { diff: lines.slice(0, DIFF_LINE_CAP).join('\n') + `\n... ${lines.length - DIFF_LINE_CAP} more line(s)\n`, truncated: true };
}

export interface ClassifyContext {
  gbrainRoot: string;
  skillsRoot: string;
  manifest: BundleManifest;
  history: VerifiedSkillsLockHistory;
  records: Record<string, InstalledSkillRecord>;
  acceptHistorical: boolean;
  noDiff: boolean;
}

export function classifySkill(ctx: ClassifyContext, slug: string): SkillOutcome {
  const record = ctx.records[slug];
  const files: ClassifiedFile[] = [];
  const notes: string[] = [];
  let unsafe: string | null = null;
  for (const entry of enumerateScaffoldEntries({ gbrainRoot: ctx.gbrainRoot, skillSlug: slug, manifest: ctx.manifest })) {
    if (entry.pairedSource) {
      notes.push(`paired source ${entry.relWorkspaceTarget} lives outside the skills root and is never written here; compare it with gbrain skillpack reference ${slug}`);
      continue;
    }
    const rel = entry.relWorkspaceTarget.replace(/^skills\//, '');
    let pre: string | null;
    try {
      pre = hashTarget(confinedSkillChildWrite(ctx.skillsRoot, rel, { dryRun: true }));
    } catch (err) {
      unsafe = `${rel}: ${(err as Error).message}`;
      continue;
    }
    if (entry.sharedDep && pre !== null) continue;
    const post = sha256(readFileSync(entry.source));
    const base = record?.files[rel] ?? null;
    files.push({ rel, source: entry.source, post, pre, base, sharedDep: entry.sharedDep, state: fileState(pre, post, base, ctx.history, rel) });
  }
  if (unsafe) notes.push(unsafe);
  const outcome: SkillOutcome = {
    slug, result: 'current', pinned: record?.pinned === true, changes: [], historical: files.filter(f => f.state === 'historical').map(f => f.rel), notes, files,
  };
  const skillMd = files.find(f => f.rel === `${slug}/SKILL.md`);
  if (!record && skillMd?.pre === null) return { ...outcome, result: 'not_installed', historical: [] };
  const changed = files.filter(f => f.state !== 'unchanged');
  outcome.changes = changed.map(f => f.rel);
  if (changed.length === 0 && !unsafe) return outcome;
  const reason: SkipReason | undefined = outcome.pinned ? 'pinned'
    : !ctx.history.ok ? 'history_unverified'
    : unsafe ? 'unsafe_target'
    : changed.some(f => f.state === 'local_edits') ? 'local_edits'
    : changed.some(f => f.state === 'no_history') ? 'no_history'
    : outcome.historical.length && !ctx.acceptHistorical ? 'historical_only'
    : undefined;
  if (!reason) return { ...outcome, result: 'would_update' };
  outcome.result = 'skipped';
  outcome.reason = reason;
  if (!ctx.noDiff && reason !== 'pinned') {
    outcome.diffs = changed.filter(f => f.pre !== null).map(f => ({
      rel: f.rel, ...boundedRedactedDiff(readFileSync(join(ctx.skillsRoot, f.rel)), readFileSync(f.source), f.rel),
    }));
  }
  return outcome;
}

function issueKey(issue: ResolvableIssue): string {
  return `${issue.type}|${issue.skill}|${issue.message}`;
}

function mentionsSkill(issue: ResolvableIssue, slug: string): boolean {
  return issue.skill === slug || issue.skill.includes(`${slug}/`) || issue.skill.split(/,\s*/).includes(slug);
}

/**
 * Conformance, trigger and resolver checks. Built before the first rename:
 * resolver errors present then are the baseline and do not count against a
 * skill (a resolver that cannot run at all is not checked).
 */
export function defaultValidator(skillsRoot: string): (root: string, slug: string) => string[] {
  let baseline: Set<string> | null;
  try {
    baseline = new Set(checkResolvable(skillsRoot).errors.map(issueKey));
  } catch {
    baseline = null;
  }
  return (root, slug) => {
    const problems: string[] = [];
    const content = readFileSync(join(root, slug, 'SKILL.md'), 'utf-8');
    const fm = content.startsWith('---') ? parseSkillFrontmatter(content) : null;
    if (!fm?.name) problems.push(`conformance: ${slug}/SKILL.md has no frontmatter with a name`);
    if (fm?.triggers?.length && !loadSkillTriggerIndex(root).some(e => e.skillPath === `${slug}/SKILL.md` || e.skillPath.endsWith(`/${slug}/SKILL.md`))) {
      problems.push(`trigger check: ${slug} declares triggers but the trigger index does not route to it`);
    }
    if (baseline !== null) {
      try {
        for (const issue of checkResolvable(root).errors) {
          if (mentionsSkill(issue, slug) && !baseline!.has(issueKey(issue))) problems.push(`resolver check: ${issue.message}`);
        }
      } catch (err) {
        problems.push(`resolver check failed: ${(err as Error).message}`);
      }
    }
    return problems;
  };
}

function removeStaleStages(skillsRoot: string): void {
  if (!existsSync(skillsRoot)) return;
  for (const name of readdirSync(skillsRoot)) {
    if (name.startsWith(STAGE_PREFIX)) rmSync(join(skillsRoot, name), { recursive: true, force: true });
  }
}

interface ApplyContext {
  opts: UpdateOptions;
  journal: Journal;
  backups: string;
  validate: (root: string, slug: string) => string[];
}

function rollback(ctx: ApplyContext, renamed: JournalFile[]): string[] {
  const left: string[] = [];
  for (const file of [...renamed].reverse()) {
    try {
      if (!undoFile(ctx.journal.id, ctx.opts.skillsRoot, file, ctx.backups)) left.push(file.rel);
    } catch {
      left.push(file.rel);
    }
  }
  return left;
}

async function applySkill(ctx: ApplyContext, outcome: SkillOutcome, js: JournalSkill): Promise<SkillOutcome> {
  const { skillsRoot } = ctx.opts;
  const changed = outcome.files.filter(f => f.state !== 'unchanged');
  const fail = (failure: string, status: JournalSkill['status'], renamed: JournalFile[] = []): SkillOutcome => {
    const rollbackSkipped = renamed.length ? rollback(ctx, renamed) : [];
    js.status = status;
    js.reason = failure;
    writeJournal(ctx.journal, ctx.backups);
    return { ...outcome, result: 'failed', failure, touched: renamed.map(f => f.rel), rollback_skipped: rollbackSkipped };
  };
  mkdirSync(skillsRoot, { recursive: true });
  const stage = mkdtempSync(join(skillsRoot, STAGE_PREFIX));
  try {
    const staged: string[] = [];
    for (const [i, f] of changed.entries()) {
      const bytes = readFileSync(f.source);
      if (sha256(bytes) !== f.post) return fail(`bundle file ${f.rel} changed during the run`, 'abandoned');
      if (f.rel === `${outcome.slug}/SKILL.md` && !parseSkillFrontmatter(bytes.toString('utf-8'))?.name) {
        return fail(`staged ${f.rel} has no frontmatter with a name`, 'abandoned');
      }
      const path = join(stage, String(i));
      writeFileSync(path, bytes);
      staged.push(path);
    }
    const fresh = loadState({ statePath: ctx.opts.statePath }).roots?.[skillsRoot]?.[outcome.slug];
    if (fresh?.pinned || changed.some(f => (fresh?.files[f.rel] ?? null) !== f.base)) {
      return fail('the skill was pinned or its recorded base changed since classification', 'abandoned');
    }
    js.status = 'applying';
    writeJournal(ctx.journal, ctx.backups);
    try {
      for (const file of js.files) {
        if (file.pre !== null) file.backup = backupFile(ctx.journal.id, file.rel, join(skillsRoot, file.rel), file.pre, ctx.backups);
      }
    } catch (err) {
      return fail(`changed since classification: ${(err as Error).message}`, 'abandoned');
    }
    writeJournal(ctx.journal, ctx.backups);
    const renamed: JournalFile[] = [];
    try {
      for (const [i, file] of js.files.entries()) {
        ctx.opts.hooks?.beforeRename?.(file.rel);
        const target = confinedSkillChildWrite(skillsRoot, file.rel);
        if (hashTarget(target) !== file.pre) return fail(`${file.rel} changed since classification`, 'rolled_back', renamed);
        mkdirSync(dirname(target), { recursive: true });
        renameSync(staged[i]!, target);
        renamed.push(file);
        ctx.opts.hooks?.afterRename?.(file.rel);
      }
      const problems = ctx.validate(skillsRoot, outcome.slug);
      if (problems.length) return fail(problems.join('; '), 'rolled_back', renamed);
    } catch (err) {
      return fail((err as Error).message, 'rolled_back', renamed);
    }
    js.status = 'committed';
    writeJournal(ctx.journal, ctx.backups);
    const bases = Object.fromEntries(outcome.files.filter(f => !f.sharedDep).map(f => [f.rel, f.post]));
    await updateState(state => ({ state: withSkillBases(state, skillsRoot, { [outcome.slug]: bases }), result: null }), { statePath: ctx.opts.statePath });
    return { ...outcome, result: 'updated' };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function summarize(skills: SkillOutcome[]): UpdateResult['summary'] {
  const summary = { updated: 0, would_update: 0, current: 0, skipped: 0, failed: 0, not_installed: 0 };
  for (const s of skills) summary[s.result]++;
  return summary;
}

/** Run the update (or, with dryRun, the preview). The caller holds the workspace writer lock for opts.skillsRoot. */
export async function runSkillpackUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const backups = opts.backups ?? backupsRoot();
  const manifest = loadBundleManifest(opts.gbrainRoot);
  const slugs = opts.slugs ?? bundledSkillSlugs(manifest);
  const history = loadVerifiedSkillsLockHistory(join(opts.gbrainRoot, 'skills'));
  const pending = pendingJournals({ root: backups, skillsRoot: opts.skillsRoot }).map(j => j.id);
  if (pending.length && !opts.dryRun) {
    throw new OperationError('skillpack_update_incomplete',
      `An earlier skillpack update of ${opts.skillsRoot} did not finish (backup ${pending[0]}); nothing was changed now.`,
      `Put the interrupted skills back with gbrain skillpack restore ${pending[0]} (it refuses files you changed since; name them with --skip), then run the update again.`);
  }
  const ctx: ClassifyContext = {
    gbrainRoot: opts.gbrainRoot, skillsRoot: opts.skillsRoot, manifest, history,
    records: loadState({ statePath: opts.statePath }).roots?.[opts.skillsRoot] ?? {},
    acceptHistorical: opts.acceptHistorical === true, noDiff: opts.noDiff === true,
  };
  const outcomes = slugs.map(slug => classifySkill(ctx, slug));
  const base = {
    dry_run: opts.dryRun === true, skills_root: opts.skillsRoot,
    history: history.ok ? { verified: true } : { verified: false, reason: history.reason },
    pending_journals: pending,
  };
  const updatable = outcomes.filter(o => o.result === 'would_update');
  if (opts.dryRun || updatable.length === 0) {
    return { ...base, journal: null, summary: summarize(outcomes), skills: outcomes, restore_command: null };
  }
  removeStaleStages(opts.skillsRoot);
  const journal: Journal = {
    schema_version: 'gbrain-skillpack-journal-v1', id: newJournalId(), status: 'pending', skills_root: opts.skillsRoot,
    created_at: new Date().toISOString(), pid: process.pid,
    skills: updatable.map(o => ({
      slug: o.slug, status: 'planned',
      files: o.files.filter(f => f.state !== 'unchanged').map(f => ({ rel: f.rel, pre: f.pre, post: f.post, base_before: f.base, backup: null })),
    })),
  };
  writeJournal(journal, backups);
  const apply: ApplyContext = { opts, journal, backups, validate: opts.validate ?? defaultValidator(opts.skillsRoot) };
  const results: SkillOutcome[] = [];
  for (const outcome of outcomes) {
    const js = journal.skills.find(s => s.slug === outcome.slug);
    results.push(js ? await applySkill(apply, outcome, js) : outcome);
  }
  journal.status = 'complete';
  writeJournal(journal, backups);
  pruneJournals(backups);
  const failed = results.some(r => r.result === 'failed');
  return { ...base, journal: journal.id, summary: summarize(results), skills: results, restore_command: failed ? `gbrain skillpack restore ${journal.id}` : null };
}

export interface RestoreResult {
  id: string;
  skills_root: string;
  files: RestorePlanFile[];
}

/** Put back every applied file of journal `id` that still holds the update's bytes. The caller holds the workspace lock for the journal's root. */
export async function runSkillpackRestore(opts: { id: string; skip?: string[]; statePath?: string; backups?: string }): Promise<RestoreResult> {
  const backups = opts.backups ?? backupsRoot();
  const journal = readJournal(opts.id, backups);
  const plan = planRestore(journal, new Set(opts.skip ?? []));
  const conflicts = plan.filter(f => f.action === 'conflict').map(f => f.rel);
  if (conflicts.length) {
    throw new OperationError('skillpack_restore_conflict',
      `Refusing to restore ${opts.id}: ${conflicts.length} file(s) changed after the update: ${conflicts.join(', ')}. Nothing was restored.`,
      `Keep your later edits and restore the rest with gbrain skillpack restore ${opts.id} ${conflicts.map(c => `--skip ${c}`).join(' ')}.`);
  }
  const byRel = new Map(journal.skills.flatMap(s => s.files.map(f => [f.rel, f] as const)));
  for (const item of plan) {
    if (item.action !== 'restore' && item.action !== 'remove') continue;
    if (!undoFile(journal.id, journal.skills_root, byRel.get(item.rel)!, backups)) {
      throw new OperationError('skillpack_restore_conflict', `${item.rel} changed while it was being restored.`,
        `Run gbrain skillpack restore ${opts.id} again, adding --skip ${item.rel} to keep the newer edit.`);
    }
  }
  const putBack = new Set(plan.filter(f => f.action !== 'skipped').map(f => `${f.slug}\u0000${f.rel}`));
  await updateState(state => {
    const root = { ...(state.roots?.[journal.skills_root] ?? {}) };
    for (const skill of journal.skills) {
      const record = root[skill.slug];
      if (!record) continue;
      const files = { ...record.files };
      for (const file of skill.files) {
        if (!putBack.has(`${skill.slug}\u0000${file.rel}`)) continue;
        if (file.base_before === null) delete files[file.rel];
        else files[file.rel] = file.base_before;
      }
      root[skill.slug] = { ...record, files };
    }
    return { state: { ...state, roots: { ...state.roots, [journal.skills_root]: root } }, result: null };
  }, { statePath: opts.statePath });
  for (const skill of journal.skills) if (skill.status === 'applying' || skill.status === 'committed') skill.status = 'restored';
  journal.status = 'restored';
  writeJournal(journal, backups);
  removeStaleStages(journal.skills_root);
  pruneJournals(backups);
  return { id: journal.id, skills_root: journal.skills_root, files: plan };
}

/** Pin or unpin `slug` under `skillsRoot`. A pinned skill is never updated by --update-untouched. Returns whether anything changed. */
export async function setSkillPinned(skillsRoot: string, slug: string, pinned: boolean, opts: { statePath?: string } = {}): Promise<boolean> {
  return updateState(state => {
    const root = { ...(state.roots?.[skillsRoot] ?? {}) };
    const record = root[slug];
    if ((record?.pinned === true) === pinned) return { state: null, result: false };
    const { pinned: _old, ...rest } = record ?? { files: {}, recorded_at: new Date().toISOString() };
    root[slug] = pinned ? { ...rest, pinned: true } : rest;
    return { state: { ...state, roots: { ...state.roots, [skillsRoot]: root } }, result: true };
  }, { statePath: opts.statePath });
}

/** A file a scaffold considered: written now, or already present. */
export interface ScaffoldedFile {
  source?: string;
  target: string;
  outcome: 'wrote_new' | 'skipped_existing';
  sharedDep: boolean;
  pairedSource?: boolean;
}

/**
 * Record the install's base for each skill file a scaffold wrote, or found
 * byte-identical to the bundle. Shared dependencies, paired sources and
 * pre-existing files that differ are not recorded (they are not gbrain's
 * install). Without a `source` (the harness bridge's rendered files), the
 * written bytes on disk are the base.
 */
export async function recordScaffoldBases(skillsRoot: string, files: readonly ScaffoldedFile[], opts: { statePath?: string } = {}): Promise<void> {
  const root = skillsRootKey(skillsRoot);
  const bases: Record<string, Record<string, string>> = {};
  for (const f of files) {
    if (f.sharedDep || f.pairedSource || (!f.source && f.outcome !== 'wrote_new')) continue;
    const rel = relative(root, skillsRootKey(f.target)).split(sep).join('/');
    if (!rel || rel.startsWith('..') || !rel.includes('/')) continue;
    const current = hashTarget(f.target);
    const expected = f.source ? sha256(readFileSync(f.source)) : current;
    if (current === null || current !== expected) continue;
    (bases[rel.split('/')[0]!] ??= {})[rel] = current;
  }
  if (Object.keys(bases).length === 0) return;
  await updateState(state => ({ state: withSkillBases(state, root, bases), result: null }), opts);
}
