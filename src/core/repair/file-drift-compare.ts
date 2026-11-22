/**
 * GST-2568: `gbrain repair file-drift` with a selection and no `--prefer`: a read-only comparison of each selected page
 * with its file that needs no winner. Per page it reports what differs (frontmatter, body, both, or nothing once gbrain's
 * own normalisation is read: `none`), which side is newer by the evidence gbrain has (the file's last commit time at HEAD,
 * the page's `updated_at`), and what a repair would do. It writes nothing: no artifact, no approved set, no hold change.
 *
 * Git is the parent, so a newer file is the side a repair takes (`--prefer file`). A page that changed after its file's
 * last commit and differs from it is never resolved file-wins in bulk (`newerPageParagraph`): `--prefer file` lists
 * it `kept_newer_page` and leaves its hold for a person, and a page whose file is gone is never resolved by deleting it
 * here either; both are `needs_human` with the reason.
 */
import { execFileSync } from '../spawn.ts';
import { GIT_READ_ENV, gitChildEnv } from '../git-env.ts';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import { digest } from '../persistence/digest.ts';
import { liveFileDrift, type LiveDrift } from '../persistence/drift-conflicts.ts';
import { classifyDrift } from '../persistence/reconcile-additive.ts';
import { sha256 } from '../persistence/digest.ts';
import { reconcileCanonical } from '../persistence/reconcile-merge.ts';
import { readReconcileState } from '../persistence/reconcile-state.ts';
import { DRIFT_HISTORY_DEPTH, DRIFT_HISTORY_VERSIONS } from '../persistence/sync-classify.ts';
import { pathBlobHistories } from '../persistence/sync-git-stream.ts';
import { fileDriftActionVerb, fileDriftSide, holdRescreenDue, type GitHoldRecord } from '../persistence/sync-holds.ts';
import { fileMatchesSnapshot } from '../persistence/page-prepare.ts';
import { recordsNoFileOrigin } from '../persistence/unbound-pages.ts';
import { OperationError } from '../ops/contract.ts';
import type { RepairListing } from './core.ts';

export type DriftDifference = 'none' | 'frontmatter' | 'body' | 'both';
export type NewerSide = 'file' | 'database' | 'unknown';
export interface DriftEvidence { path: string; differs: DriftDifference; keys: string[]; file_committed_at: string | null; file_uncommitted: boolean;
  page_updated_at: string | null; newer: NewerSide }
export type CompareVerdict = 'release_hold' | 'no_drift' | 'prefer_file' | 'needs_human' | 'unknown';
export interface ComparedPage { item: string; slug: string | null; path?: string; would: CompareVerdict; why: string; evidence?: Omit<DriftEvidence, 'path'>; side?: string; state?: string }

/** What differs between the file's page (as an import over the stored page reads it) and the database page: the body, and the frontmatter keys (title, type and tags included). */
export function driftDifference(file: ParsedPage, database: ParsedPage): { differs: DriftDifference; keys: string[] } {
  const body = (file.compiled_truth ?? '') !== (database.compiled_truth ?? '') || (file.timeline ?? '') !== (database.timeline ?? '');
  const keys = (['title', 'type'] as const).filter(key => file[key] !== database[key]) as string[];
  if (digest([...file.tags].sort()) !== digest([...database.tags].sort())) keys.push('tags');
  for (const key of [...new Set([...Object.keys(file.frontmatter), ...Object.keys(database.frontmatter)])].sort()) {
    if (digest(file.frontmatter[key] ?? null) !== digest(database.frontmatter[key] ?? null)) keys.push(key);
  }
  return { differs: body ? (keys.length ? 'both' : 'body') : keys.length ? 'frontmatter' : 'none', keys };
}

/** The file's last commit time at HEAD and whether its working-tree bytes differ from HEAD; a Git failure reads as no evidence. */
export interface CommitEvidence { committed_at: string | null; uncommitted: boolean }
export function fileCommitEvidence(root: string, path: string): CommitEvidence {
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { env: gitChildEnv(GIT_READ_ENV), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return { committed_at: git(['log', '-1', '--format=%cI', 'HEAD', '--', path]) || null, uncommitted: git(['status', '--porcelain', '--', path]) !== '' };
  } catch { return { committed_at: null, uncommitted: false }; }
}

/**
 * The newer side: the page when it was updated after the file's last commit, the file when it was committed after the
 * page's update; unknown without a commit time, with uncommitted bytes, without an update time, or within the same second
 * (a commit time has whole seconds, so an update in that second may come before or after it).
 */
export function newerSide(file: { committed_at: string | null; uncommitted: boolean }, pageUpdatedAt: string | null): NewerSide {
  if (!file.committed_at || file.uncommitted || !pageUpdatedAt) return 'unknown';
  const page = Math.floor(Date.parse(pageUpdatedAt) / 1000), committed = Math.floor(Date.parse(file.committed_at) / 1000);
  return page > committed ? 'database' : page < committed ? 'file' : 'unknown';
}

/**
 * Whole-class (file-drift-class.ts): the commit evidence of many paths in one Git read: one `git log` naming each path's last
 * commit at HEAD and one `git status` for uncommitted bytes. Git prints paths from the repository top, so a source bound to a
 * subdirectory is matched through its prefix. A path the read did not settle, or every path when Git fails, is left out, and the
 * caller reads it alone.
 */
export function fileCommitEvidenceBatch(root: string, paths: readonly string[]): Map<string, CommitEvidence> {
  if (!paths.length) return new Map();
  const git = (args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { env: gitChildEnv(GIT_READ_ENV), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  try {
    const prefix = git(['rev-parse', '--show-prefix']).trim();
    const byTop = new Map(paths.map(path => [prefix + path, { committed_at: null as string | null, uncommitted: false }]));
    let at: string | null = null;
    for (const line of git(['log', '--format=%x01%cI', '--name-only', 'HEAD', '--', ...paths]).split('\n')) {
      if (line.startsWith('\u0001')) { at = line.slice(1).trim() || null; continue; }
      const entry = byTop.get(line);
      if (entry && entry.committed_at === null) entry.committed_at = at;
    }
    for (const record of git(['status', '--porcelain', '-z', '--', ...paths]).split('\0')) {
      const entry = record.length > 3 ? byTop.get(record.slice(3)) : undefined;
      if (entry) entry.uncommitted = true;
    }
    return new Map(paths.flatMap(path => { const entry = byTop.get(prefix + path)!; return entry.committed_at === null ? [] : [[path, entry] as const]; }));
  } catch { return new Map(); }
}

/** One live page's comparison with its canonical file (read as reconcile and `repair file-drift` read it); `commit` is the file's evidence when a batch already read it. */
export async function readDriftEvidence(engine: BrainEngine, sourceId: string, slug: string, assessmentAt: string, commit?: (path: string) => CommitEvidence | undefined): Promise<DriftEvidence> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  const state = await readReconcileState(engine, sourceId, slug, assessmentAt, { adoptSlugPath: !!snapshot && recordsNoFileOrigin(snapshot.page) });
  const { differs, keys } = driftDifference(reconcileCanonical(state.file, state.file.tags), reconcileCanonical(state.snapshot.page, state.snapshot.tags));
  const path = relative(state.root, state.path).split(sep).join('/');
  const file = commit?.(path) ?? fileCommitEvidence(state.root, path);
  const updated = state.snapshot.page.updated_at ? new Date(state.snapshot.page.updated_at).toISOString() : null;
  return { path, differs, keys, file_committed_at: file.committed_at, file_uncommitted: file.uncommitted, page_updated_at: updated, newer: newerSide(file, updated) };
}

/**
 * GST-3328: the blob of the earlier version of its file a side-`unknown` page still holds, read as sync's screen reads it
 * (the DRIFT_HISTORY_VERSIONS versions before the file at HEAD, from the commits that changed it): only Git moved since, so a
 * re-screen of its hold imports the file. Null when none matches or Git cannot tell.
 */
async function earlierVersionHeld(engine: BrainEngine, sourceId: string, slug: string): Promise<string | null> {
  try {
    const state = await readReconcileState(engine, sourceId, slug);
    const git = (args: string[]) => execFileSync('git', ['-C', state.root, ...args], { env: gitChildEnv(GIT_READ_ENV), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    // The same read sync's screen takes (sync-pass-run.ts readDriftHistories: the Git top level and a path from it), so
    // the two always compare the same versions, a source rooted in a subdirectory of its checkout included.
    const top = git(['rev-parse', '--show-toplevel']).trim();
    const path = git(['rev-parse', '--show-prefix']).trim() + relative(state.root, state.path).split(sep).join('/');
    const head = git(['rev-parse', '--verify', 'HEAD']).trim();
    let atHead: string | null = null;
    try { atHead = git(['rev-parse', '--verify', '--quiet', `HEAD:${path}`]).trim() || null; } catch { /* not at HEAD */ }
    const versions = [...new Set((await pathBlobHistories(top, head, [path], DRIFT_HISTORY_DEPTH)).get(path) ?? [])].filter(oid => oid !== atHead).slice(0, DRIFT_HISTORY_VERSIONS);
    for (const oid of versions) if (await fileMatchesSnapshot(engine, slug, git(['cat-file', 'blob', oid]), state.snapshot, state.importPath).catch(() => false)) return oid;
    return null;
  } catch { return null; }
}

/** Why a page newer than its file is not resolved file-wins: the paragraph a held page carries in every preview. */
export function newerPageParagraph(sourceId: string, slug: string, evidence: DriftEvidence): string {
  const what = evidence.differs === 'both' ? 'body and frontmatter' : evidence.differs === 'body' ? 'body' : `frontmatter (${evidence.keys.join(', ')})`;
  return `page ${slug} changed after its file was last committed (page updated ${evidence.page_updated_at}, ${evidence.path} committed ${evidence.file_committed_at}) and its ${what} differs, `
    + `so letting the file win may drop a database edit; it stays held for a person. updated_at also moves on gbrain's own writes (a retype), so read both sides first. `
    + `To keep the file, preview gbrain repair file-drift --source ${sourceId} --slug ${slug} --prefer file. To keep the page, preview it with --prefer database instead (its apply would rewrite the file from the page and needs the user's consent), or carry the edit into the file, commit it and run gbrain sync --source ${sourceId}.`;
}

/**
 * GST-2869 / whole-class: what settles a read-only mirror's differing held pages. The whole-class preview lists every held page of
 * the side whose file is newer for one approval and its apply imports each file into its page database-only (no file is written);
 * a page edited in gbrain after its file stays held for a person.
 */
export function mirrorDriftRoute(sourceId: string, side = 'unknown'): string {
  return `this source is a read-only mirror: gbrain repair file-drift --source ${sourceId} --held --side ${side} --prefer file --whole-class previews every held page of that side whose file is newer for one approval, `
    + `and its apply imports each file into its page database-only (nothing is written to the checkout); a page edited in gbrain after its file was committed stays held for a person (kept_newer_page)`;
}

/**
 * What settles a read-only mirror's held deleted page whose file differs. The mirror never removes its file, so a tombstone_edited
 * page names keeping the deletion first (recorded on the hold, nothing written) and making the source writable second; a
 * purged_differs page has no deletion to keep, so it names only the writable route. Never a --prefer file preview.
 */
export function mirrorDeletedRoute(sourceId: string, state: string): string {
  const writable = `the user makes the source writable (gbrain sources mirror-writable ${sourceId}) and picks a side`;
  if (state !== 'tombstone_edited') return `this source is a read-only mirror, so its file can't be removed; to settle the page ${writable}`;
  return `this source is a read-only mirror: to keep the deletion, preview gbrain repair file-drift --source ${sourceId} --held --side deleted --state tombstone_edited --prefer database `
    + `(the apply records the kept deletion on the hold and writes nothing); to bring the page back from its file instead, ${writable}`;
}

/**
 * The live drift of a page, as every held file-drift read takes it (the comparison, the window preview, the whole-class walk and its
 * apply). GST-2843: a read-only mirror never writes its files, so `liveFileDrift` calls every mirror page database-only; a held page of
 * side both, unknown or database whose file sync still imports is compared with that file instead, and only a gone file stays
 * database-only.
 */
export async function heldLiveDrift(engine: BrainEngine, sourceId: string, slug: string, target: { hold?: GitHoldRecord | null; mirror?: boolean }): Promise<LiveDrift> {
  const live = await liveFileDrift(engine, sourceId, slug);
  const side = target.hold ? fileDriftSide(target.hold.meta) : undefined;
  if (target.mirror !== true || !target.hold || side === 'deleted' || live.still_present !== false || live.reason !== 'database_only') return live;
  try {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    const state = await readReconcileState(engine, sourceId, slug, undefined, { adoptSlugPath: !!snapshot && recordsNoFileOrigin(snapshot.page) });
    const agrees = classifyDrift(state.file, reconcileCanonical(state.snapshot.page, state.snapshot.tags)).verdict === 'no_drift';
    return { still_present: !agrees, reason: agrees ? 'agrees' : 'file_database_drift', db_revision: state.snapshot.revision,
      path: relative(state.root, state.path).split(sep).join('/'), file_hash: sha256(state.raw) };
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    if (error.detail === 'canonical_file_missing') return live;
    return typeof error.detail === 'string' ? { still_present: null, reason: error.detail } : { still_present: null, reason: error.code, message: error.message };
  }
}

/** One selected page, compared: a held page by its hold, any other by its slug. Never writes. */
export async function comparePage(engine: BrainEngine, sourceId: string, target: { slug: string | null; hold?: GitHoldRecord; mirror?: boolean }, assessmentAt: string): Promise<ComparedPage> {
  const { slug, hold } = target;
  const item = `${sourceId}:${slug ?? hold?.path ?? ''}`;
  const side = hold ? fileDriftSide(hold.meta) : undefined;
  const held = { ...(side ? { side } : {}), ...(hold?.meta.state ? { state: hold.meta.state } : {}), ...(hold ? { path: hold.path } : {}) };
  if (side === 'deleted' && hold?.meta.state && hold.meta.state !== 'file_gone') {
    const state = hold.meta.state;
    return { item, slug, ...held, would: 'needs_human', why: target.mirror ? `the page at ${hold.path} is deleted and the file differs (${state}), so a person decides; ${mirrorDeletedRoute(sourceId, state)}`
      : `the page at ${hold.path} is deleted and the file differs (${state}); --prefer database would ${fileDriftActionVerb('deleted', state, 'database')} and --prefer file would ${fileDriftActionVerb('deleted', state, 'file')}, so a person decides` };
  }
  if (slug === null) return { item, slug, ...held, would: 'unknown', why: 'the hold names no page; the next sync re-classifies it' };
  try {
    const live = await heldLiveDrift(engine, sourceId, slug, target);
    if (live.reason === 'canonical_file_missing') return { item, slug, ...held, would: 'needs_human',
      why: `the page has no file at the last commit, so letting the file win would delete the page; that is never the default here. Keep it with --prefer database (recreates the file), or preview --held --side deleted --state file_gone --prefer file for a deletion you intend` };
    if (live.reason === 'agrees') {
      const due = hold ? holdRescreenDue(hold, false) : false;
      return { item, slug, ...held, ...(live.path ? { path: live.path } : {}), would: hold ? 'release_hold' : 'no_drift',
        why: !hold ? 'the page and its file agree' : due ? 'the page and its file agree once gbrain\'s own normalisation is read; the next sync releases the hold with no write'
          : `the page and its file agree; gbrain repair file-drift --source ${sourceId} --slug ${slug} --prefer file previews the release` };
    }
    const mirrorHeld = !!hold && side !== 'deleted' && target.mirror === true;
    if (live.still_present !== true) return { item, slug, ...held, would: live.still_present === false ? 'no_drift' : 'unknown', why: live.message ? `${live.reason}: ${live.message}` : live.reason };
    const { path, ...evidence } = await readDriftEvidence(engine, sourceId, slug, assessmentAt);
    const base = { item, slug, ...held, path, evidence };
    if (evidence.differs === 'none') return { ...base, would: hold ? 'release_hold' : 'no_drift', why: 'nothing differs once gbrain\'s own normalisation is read' };
    const earlier = side === 'unknown' ? await earlierVersionHeld(engine, sourceId, slug) : null;
    if (earlier) return { ...base, would: 'prefer_file', why: `page ${slug} equals ${path} at blob ${earlier.slice(0, 12)}, an earlier version, so only the file moved since (Git is the parent): `
      + `gbrain sources retry-held ${sourceId} re-screens it and the next gbrain sync --source ${sourceId} --no-pull imports the file, with no repair`
      + (evidence.file_uncommitted ? `; ${path} also has uncommitted bytes, so sync holds it worktree_dirty until they are committed or restored` : '') };
    if (evidence.newer === 'file') return { ...base, would: 'prefer_file', why: mirrorHeld ? `${path} was committed after the page last changed, so the file wins (Git is the parent); ${mirrorDriftRoute(sourceId, side)}`
      : `${path} was committed after the page last changed, so the file wins (Git is the parent): gbrain repair file-drift --source ${sourceId} --slug ${slug} --prefer file` };
    if (evidence.newer === 'database') return { ...base, would: 'needs_human', why: mirrorHeld ? `page ${slug} changed after ${path} was last committed (page updated ${evidence.page_updated_at}, file committed ${evidence.file_committed_at}), so a person decides which side to keep; ${mirrorDriftRoute(sourceId, side)}`
      : newerPageParagraph(sourceId, slug, { path, ...evidence }) };
    return { ...base, would: 'needs_human', why: evidence.file_uncommitted ? `${path} has uncommitted bytes, so which side is newer is unknown; commit or restore the file, then compare again`
      : `which side is newer is unknown (${evidence.file_committed_at ? 'the page has no update time' : `no commit holds ${path}`}); a person decides` };
  } catch (error) {
    if (!(error instanceof OperationError) || ['owner_unavailable', 'writer_registration_required'].includes(error.code)) throw error;
    return { item, slug, ...held, would: 'unknown', why: `${error.code}: ${error.message}` };
  }
}

/**
 * How many non-blank lines of `losing` the `winning` text does not carry, each line counted as often as it repeats: what
 * a repair that keeps `winning` drops from the side it overwrites. Trailing spaces are ignored; nothing else is.
 */
export function linesNotCarried(losing: string, winning: string): number {
  const kept = new Map<string, number>();
  for (const line of winning.split('\n')) { const key = line.trimEnd(); if (key.trim()) kept.set(key, (kept.get(key) ?? 0) + 1); }
  let lost = 0;
  for (const line of losing.split('\n')) {
    const key = line.trimEnd();
    if (!key.trim()) continue;
    const left = kept.get(key) ?? 0;
    if (left) kept.set(key, left - 1); else lost++;
  }
  return lost;
}

/** The listing row of a compared page. */
export function comparedListing(page: ComparedPage): RepairListing {
  const evidence = page.evidence ? `differs: ${page.evidence.differs}${page.evidence.keys.length ? ` (${page.evidence.keys.join(', ')})` : ''}; newer: ${page.evidence.newer}; ` : '';
  return { item: page.item, class: page.would, detail: `${evidence}${page.why}` };
}
