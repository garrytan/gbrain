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
import { gitChildEnv } from '../git-env.ts';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import { digest } from '../persistence/digest.ts';
import { liveFileDrift } from '../persistence/drift-conflicts.ts';
import { reconcileCanonical } from '../persistence/reconcile-merge.ts';
import { readReconcileState } from '../persistence/reconcile-state.ts';
import { fileDriftActionVerb, fileDriftSide, holdRescreenDue, type GitHoldRecord } from '../persistence/sync-holds.ts';
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
export function fileCommitEvidence(root: string, path: string): { committed_at: string | null; uncommitted: boolean } {
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { env: gitChildEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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

/** One live page's comparison with its canonical file (read as reconcile and `repair file-drift` read it). */
export async function readDriftEvidence(engine: BrainEngine, sourceId: string, slug: string, assessmentAt: string): Promise<DriftEvidence> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  const state = await readReconcileState(engine, sourceId, slug, assessmentAt, { adoptSlugPath: !!snapshot && recordsNoFileOrigin(snapshot.page) });
  const { differs, keys } = driftDifference(reconcileCanonical(state.file, state.file.tags), reconcileCanonical(state.snapshot.page, state.snapshot.tags));
  const path = relative(state.root, state.path).split(sep).join('/');
  const file = fileCommitEvidence(state.root, path);
  const updated = state.snapshot.page.updated_at ? new Date(state.snapshot.page.updated_at).toISOString() : null;
  return { path, differs, keys, file_committed_at: file.committed_at, file_uncommitted: file.uncommitted, page_updated_at: updated, newer: newerSide(file, updated) };
}

/** Why a page newer than its file is not resolved file-wins: the paragraph a held page carries in every preview. */
export function newerPageParagraph(sourceId: string, slug: string, evidence: DriftEvidence): string {
  const what = evidence.differs === 'both' ? 'body and frontmatter' : evidence.differs === 'body' ? 'body' : `frontmatter (${evidence.keys.join(', ')})`;
  return `page ${slug} changed after its file was last committed (page updated ${evidence.page_updated_at}, ${evidence.path} committed ${evidence.file_committed_at}) and its ${what} differs, `
    + `so letting the file win would drop that database edit; it stays held for a person. Keep the page with gbrain repair file-drift --source ${sourceId} --slug ${slug} --prefer database `
    + `(rewrites the file from the page), or carry the edit into the file, commit it and run gbrain sync --source ${sourceId}.`;
}

/** One selected page, compared: a held page by its hold, any other by its slug. Never writes. */
export async function comparePage(engine: BrainEngine, sourceId: string, target: { slug: string | null; hold?: GitHoldRecord }, assessmentAt: string): Promise<ComparedPage> {
  const { slug, hold } = target;
  const item = `${sourceId}:${slug ?? hold?.path ?? ''}`;
  const side = hold ? fileDriftSide(hold.meta) : undefined;
  const held = { ...(side ? { side } : {}), ...(hold?.meta.state ? { state: hold.meta.state } : {}), ...(hold ? { path: hold.path } : {}) };
  if (side === 'deleted' && hold?.meta.state && hold.meta.state !== 'file_gone') {
    const state = hold.meta.state;
    return { item, slug, ...held, would: 'needs_human', why: `the page at ${hold.path} is deleted and the file differs (${state}); --prefer database would ${fileDriftActionVerb('deleted', state, 'database')} and --prefer file would ${fileDriftActionVerb('deleted', state, 'file')}, so a person decides` };
  }
  if (slug === null) return { item, slug, ...held, would: 'unknown', why: 'the hold names no page; the next sync re-classifies it' };
  try {
    const live = await liveFileDrift(engine, sourceId, slug);
    if (live.reason === 'canonical_file_missing') return { item, slug, ...held, would: 'needs_human',
      why: `the page has no file at the last commit, so letting the file win would delete the page; that is never the default here. Keep it with --prefer database (recreates the file), or preview --held --side deleted --state file_gone --prefer file for a deletion you intend` };
    if (live.reason === 'agrees') {
      const due = hold ? holdRescreenDue(hold, false) : false;
      return { item, slug, ...held, ...(live.path ? { path: live.path } : {}), would: hold ? 'release_hold' : 'no_drift',
        why: !hold ? 'the page and its file agree' : due ? 'the page and its file agree once gbrain\'s own normalisation is read; the next sync releases the hold with no write'
          : `the page and its file agree; gbrain repair file-drift --source ${sourceId} --slug ${slug} --prefer file previews the release` };
    }
    if (live.still_present !== true) return { item, slug, ...held, would: live.still_present === false ? 'no_drift' : 'unknown', why: live.reason };
    const { path, ...evidence } = await readDriftEvidence(engine, sourceId, slug, assessmentAt);
    const base = { item, slug, ...held, path, evidence };
    if (evidence.differs === 'none') return { ...base, would: hold ? 'release_hold' : 'no_drift', why: 'nothing differs once gbrain\'s own normalisation is read' };
    if (evidence.newer === 'file') return { ...base, would: 'prefer_file', why: `${path} was committed after the page last changed, so the file wins (Git is the parent): gbrain repair file-drift --source ${sourceId} --slug ${slug} --prefer file` };
    if (evidence.newer === 'database') return { ...base, would: 'needs_human', why: newerPageParagraph(sourceId, slug, { path, ...evidence }) };
    return { ...base, would: 'needs_human', why: evidence.file_uncommitted ? `${path} has uncommitted bytes, so which side is newer is unknown; commit or restore the file, then compare again`
      : `which side is newer is unknown (${evidence.file_committed_at ? 'the page has no update time' : `no commit holds ${path}`}); a person decides` };
  } catch (error) {
    if (!(error instanceof OperationError) || ['owner_unavailable', 'writer_registration_required'].includes(error.code)) throw error;
    return { item, slug, ...held, would: 'unknown', why: `${error.code}: ${error.message}` };
  }
}

/** The listing row of a compared page. */
export function comparedListing(page: ComparedPage): RepairListing {
  const evidence = page.evidence ? `differs: ${page.evidence.differs}${page.evidence.keys.length ? ` (${page.evidence.keys.join(', ')})` : ''}; newer: ${page.evidence.newer}; ` : '';
  return { item: page.item, class: page.would, detail: `${evidence}${page.why}` };
}
