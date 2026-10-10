/**
 * #5988 legacy (unmanaged) sync holds. A file whose content gbrain refuses
 * deterministically (unreadable or ambiguous frontmatter, a frontmatter slug
 * naming another page, over-size, an operator content reject) is held in the
 * shared Git hold store instead of failing the run: it stays out of
 * `failedFiles` and the #1939 auto-skip streak, never gates the bookmark, and
 * is re-screened on later runs until it imports, is deleted, or a newer gbrain
 * can read it. `sync.holds=fail` keeps today's fail-closed behavior, and
 * company-brain sources never hold (their approved manifest keeps blocking).
 */
import { createHash, randomUUID } from 'crypto';
import { importFenceTally } from '../../core/fence-repair/report.ts';
import { recordSyncRunTrend } from '../../core/fence-repair/census-store.ts';
import { existsSync, lstatSync } from 'fs';
import { join } from 'path';
import type { SyncResult } from '../sync.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { serr } from '../../core/console-prefix.ts';
import { currentCompanyBrainSync } from '../../core/company-brain/profile.ts';
import { RECOVERY_VERSION } from '../../core/frontmatter-recovery.ts';
import { MAX_FILE_SIZE, contentRefusalFromReceipt, isContentRefusal, type ContentRefusal } from '../../core/import-screen.ts';
import { slugConflictHoldMessage, type ImportResult } from '../../core/import-file.ts';
import { classifyImportHold, parseMarkdown } from '../../core/markdown.ts';
import { readSourceFileSync } from '../../core/minions/source-filesystem.ts';
import { maintenanceTransaction } from '../../core/persistence/attribution.ts';
import type { SyncRename } from '../../core/persistence/sync-discovery.ts';
import {
  addRecovered, buildHoldReport, clearGitHold, clearGitHoldRetryPaths, gitHoldItem, holdRescreenDue, readGitHoldRetryPaths, readGitSourceHolds,
  readSyncHoldPolicy, recoveredReport, writeGitHold, type GitHoldCode, type GitHoldItem, type GitHoldRecord, type GitHoldReason, type SyncHoldPolicy,
} from '../../core/persistence/sync-holds.ts';
import { DEFAULT_SOURCE_ID, hasMalformedPathSegment, isCodeFilePath, resolveSlugForPath, sanitizePathForDisplay, slugifyPath } from '../../core/sync.ts';
import type { SyncActivePack } from './sync-run.ts';
import { isPathContained } from '../../core/path-confine.ts';

/** The file at a repo-relative path from git or a hold row, or null when it is missing or resolves outside the source root. */
function fileUnderRoot(root: string, path: string): string | null {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- path is a repo-relative path from git or a hold row; isPathContained realpaths both sides and rejects anything outside root
  const filePath = join(root, path);
  return isPathContained(filePath, root) ? filePath : null;
}

export interface LegacyHolds {
  readonly sourceId: string;
  readonly incarnation: string;
  readonly runId: string;
  /** The run's start: every hold it writes or clears is conditional on it. */
  readonly observedAt: string;
  readonly policy: SyncHoldPolicy;
  /** New holds may be written; false under `sync.holds=fail`, where content refusals fail the run as before. */
  readonly active: boolean;
  /** Holds outstanding when the run started, by path. */
  readonly existing: ReadonlyMap<string, GitHoldRecord>;
  readonly retryPaths: ReadonlySet<string>;
  /** Held paths this run re-screens though Git did not touch them. */
  readonly rescreen: string[];
  /** Held paths whose file is gone or no longer synced: cleared when the run settles. */
  readonly gone: string[];
  /** Retry requests this run took into its manifest. */
  readonly retryTaken: string[];
  /** Paths held this run; their failure-ledger rows resolve. */
  readonly heldPaths: string[];
  readonly recoveredPaths: string[];
  readonly counts: { screened: number; commentValues: number };
  /** #6188: fences Tier 1 normalized, and fences stored as written with issues (T5). */
  readonly fences: ReturnType<typeof importFenceTally>;
}

export type HoldScreen = { refusal: ContentRefusal | null; upstreamVersion: string | null };

/** The run's hold state, or null when holds do not apply (company-brain source, no source row). */
export async function openLegacyHolds(engine: BrainEngine, sourceId: string | undefined): Promise<LegacyHolds | null> {
  if (currentCompanyBrainSync(sourceId)) return null;
  const id = sourceId ?? DEFAULT_SOURCE_ID;
  const [row] = await engine.executeRaw<{ incarnation: string | null }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]).catch(() => []);
  if (!row?.incarnation) return null;
  const policy = await readSyncHoldPolicy(engine);
  const listed = await readGitSourceHolds(engine, { sourceIds: [id] });
  const retry = await readGitHoldRetryPaths(engine, id, row.incarnation);
  return {
    sourceId: id, incarnation: row.incarnation, runId: `legacy-${randomUUID()}`, observedAt: new Date().toISOString(), policy,
    active: policy.mode === 'hold', existing: new Map((listed[0]?.holds ?? []).map(record => [record.path, record])), retryPaths: new Set(retry),
    rescreen: [], gone: [], retryTaken: [], heldPaths: [], recoveredPaths: [], counts: { screened: 0, commentValues: 0 }, fences: importFenceTally(id),
  };
}

/** sha256 of the exact string legacy import reads (BOM stripped), or null when the file is over the size limit. */
function readImportContent(filePath: string): { content: string; upstreamVersion: string } | null {
  if (lstatSync(filePath).size > MAX_FILE_SIZE) return null;
  const content = readSourceFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  return { content, upstreamVersion: createHash('sha256').update(content).digest('hex') };
}

function currentVersion(filePath: string): string | null | undefined {
  try { return readImportContent(filePath)?.upstreamVersion ?? null; } catch { return undefined; }
}

/**
 * Picks the held paths this run re-screens though Git did not touch them:
 * changed bytes, or what the shared `holdRescreenDue` predicate names (a
 * retry request, an older frontmatter reader or fence screen, and holds whose
 * verdict depends on database state or the working tree). A held file that is
 * gone or no longer synced clears.
 * `selected` is null for a path outside this run's scope (left alone).
 */
export function planHoldRescreen(holds: LegacyHolds, input: { root: string; touched: ReadonlySet<string>; selected: (path: string) => boolean | null }): void {
  for (const path of holds.retryPaths) if (!holds.existing.has(path)) holds.retryTaken.push(path);
  for (const [path, record] of holds.existing) {
    if (input.touched.has(path)) {
      if (holds.retryPaths.has(path)) holds.retryTaken.push(path);
      continue;
    }
    const selected = input.selected(path);
    if (selected === null) continue;
    const filePath = fileUnderRoot(input.root, path);
    if (!selected || !filePath) {
      holds.gone.push(path);
      if (holds.retryPaths.has(path)) holds.retryTaken.push(path);
      continue;
    }
    if (!holds.active) continue;
    const due = holdRescreenDue(record, holds.retryPaths.has(path)) || currentVersion(filePath) !== record.upstream_version;
    if (!due) continue;
    holds.rescreen.push(path);
    if (holds.retryPaths.has(path)) holds.retryTaken.push(path);
  }
}

/**
 * The legacy import's content screen, read-only: the size, frontmatter and
 * slug checks `importFromFile` applies, for a rename destination before any
 * page moves and for dry runs. Code files and malformed names screen by size only.
 */
export function screenLegacyFile(filePath: string, relPath: string, activePack?: SyncActivePack): HoldScreen {
  let read: ReturnType<typeof readImportContent>;
  try {
    if (lstatSync(filePath).isSymbolicLink()) return { refusal: null, upstreamVersion: null };
    read = readImportContent(filePath);
  } catch {
    return { refusal: null, upstreamVersion: null };
  }
  if (!read) return { refusal: { code: 'file_too_large', message: `File too large (${lstatSync(filePath).size} bytes, max ${MAX_FILE_SIZE}).` }, upstreamVersion: null };
  if (hasMalformedPathSegment(relPath) || isCodeFilePath(relPath)) return { refusal: null, upstreamVersion: read.upstreamVersion };
  const parsed = parseMarkdown(read.content, relPath, { validate: true, ...(activePack ? { activePack } : {}) });
  const refusal = classifyImportHold(parsed, { expectedSlug: slugifyPath(relPath) || null, slugConflictMessage: (_found, expected) => slugConflictHoldMessage(relPath, expected) });
  return { refusal, upstreamVersion: read.upstreamVersion };
}

/**
 * The content refusal behind an import outcome; transient and conflict errors return null and keep failing.
 * #6188 (T5): legacy sync never holds for a fence; a fence refusal keeps today's outcome.
 */
export function legacyRefusal(result: Pick<ImportResult, 'status' | 'error' | 'refusal'>): ContentRefusal | null {
  if (result.status === 'imported') return null;
  if (result.refusal) return result.refusal.code === 'invalid_fence' ? null : result.refusal;
  const error = result.error ?? '';
  if (/^Content rejected by sanity gate: /.test(error)) return { code: 'content_rejected', message: error };
  if (/^purged_content: /.test(error)) return { code: 'purged_content', message: error };
  if (/^Refused by the write gate: /.test(error)) return { code: 'write_gate_rejected', message: error };
  const typed = isContentRefusal('invalid_params', error) ? contentRefusalFromReceipt('invalid_params', error) : null;
  if (!typed || typed.code === 'invalid_fence') return null;
  const { suggestion: _suggestion, ...refusal } = typed;
  return { ...refusal, message: error };
}

/** Records a hold for `path` (keeping a pending rename's identity) and reports it on stderr. */
export async function recordLegacyHold(engine: BrainEngine, holds: LegacyHolds, input: {
  path: string; refusal: Pick<ContentRefusal, 'message' | 'key' | 'line'> & { code: GitHoldCode; reason?: GitHoldReason };
  upstreamVersion: string | null; renameFrom?: SyncRename;
}): Promise<void> {
  const { path, refusal } = input;
  const renameFrom = input.renameFrom ?? holds.existing.get(path)?.meta.rename_from;
  const derived = resolveSlugForPath(path) || null;
  const [page] = renameFrom ? [] : await engine.executeRaw<{ id: number | string; slug: string }>(
    `SELECT id, slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND (source_path=$2 OR slug=$3)
      ORDER BY (source_path=$2) DESC LIMIT 1`, [holds.sourceId, path, derived ?? '']);
  await engine.transaction(tx => writeGitHold(tx, {
    source_id: holds.sourceId, incarnation: holds.incarnation, path, source_path: path,
    slug: renameFrom?.slug ?? page?.slug ?? derived, page_id: renameFrom ? renameFrom.pageId : page ? Number(page.id) : null,
    code: refusal.code, message: refusal.message, upstream_version: input.upstreamVersion, observed_at: holds.observedAt,
    run_id: holds.runId, mode: 'legacy',
    meta: { ...(refusal.reason ? { reason: refusal.reason } : {}), ...(refusal.key ? { key: refusal.key } : {}),
      ...(refusal.line !== undefined ? { line: refusal.line } : {}), recovery_version: RECOVERY_VERSION, ...(renameFrom ? { rename_from: renameFrom } : {}) },
  }));
  holds.heldPaths.push(path);
  serr(`  Held ${sanitizePathForDisplay(path)} (${refusal.code}${refusal.reason ? `/${refusal.reason}` : ''}): not imported, the sync continues.`);
}

/** Holds the refused import result of `path`; false when it is not a content refusal (or holds are off). */
export async function holdRefusedImport(engine: BrainEngine, holds: LegacyHolds | null, path: string, filePath: string,
  result: Pick<ImportResult, 'status' | 'error' | 'refusal'>): Promise<boolean> {
  const refusal = holds?.active ? legacyRefusal(result) : null;
  if (!holds || !refusal) return false;
  try {
    const upstreamVersion = refusal.code === 'file_too_large' || !existsSync(filePath) ? null : readImportContent(filePath)?.upstreamVersion ?? null;
    await recordLegacyHold(engine, holds, { path, refusal, upstreamVersion });
    return true;
  } catch (e) {
    serr(`  Could not record the hold for ${sanitizePathForDisplay(path)} (${e instanceof Error ? e.message : String(e)}); it counts as a failure this run.`);
    return false;
  }
}

/** Bookkeeping for a screened import: the escalation denominator and the recovered-frontmatter tally. */
export function noteScreenedImport(holds: LegacyHolds | null, path: string, result: Pick<ImportResult, 'status' | 'frontmatter_recovery' | 'fences_normalized' | 'fence_issues'>): void {
  if (!holds) return;
  holds.counts.screened++;
  holds.fences.note(path, result);
  if (result.status !== 'imported' || !result.frontmatter_recovery) return;
  if (result.frontmatter_recovery.quoted) holds.recoveredPaths.push(path);
  if (result.frontmatter_recovery.comment_value) holds.counts.commentValues++;
}

/** Clears `path`'s hold after its import, no-op or deletion committed. */
export async function clearLegacyHold(engine: BrainEngine, holds: LegacyHolds | null, path: string): Promise<void> {
  if (!holds?.existing.has(path) || holds.heldPaths.includes(path)) return;
  await engine.transaction(tx => clearGitHold(tx, { sourceId: holds.sourceId, incarnation: holds.incarnation, path, observedAt: holds.observedAt }));
}

/** End of run: clear holds of gone files and of `paths` (deleted or renamed away), and drop the retry requests taken. */
export async function settleLegacyHolds(engine: BrainEngine, holds: LegacyHolds | null, paths: string[] = []): Promise<void> {
  if (!holds) return;
  for (const path of new Set([...holds.gone, ...paths])) await clearLegacyHold(engine, holds, path);
  await clearGitHoldRetryPaths(engine, holds.sourceId, holds.incarnation, [...new Set(holds.retryTaken)]);
}

/** The hold and recovered-frontmatter fields of the run's result. */
export async function legacyHoldFields(engine: BrainEngine, holds: LegacyHolds | null): Promise<Partial<SyncResult>> {
  if (!holds) return {};
  const report = await buildHoldReport(engine, { sourceId: holds.sourceId, incarnation: holds.incarnation, runId: holds.runId, remote: false,
    policy: holds.policy, screened: holds.counts.screened });
  const recovered = holds.recoveredPaths.length || holds.counts.commentValues
    ? recoveredReport(holds.sourceId, addRecovered(undefined, { paths: holds.recoveredPaths, commentValues: holds.counts.commentValues })) : undefined;
  const fences = holds.fences.fields();
  const normalized = fences.fences_normalized;
  if (normalized) await recordSyncRunTrend(engine, { sourceId: holds.sourceId, runId: holds.runId, day: new Date().toISOString().slice(0, 10), count: normalized.count,
    byClass: normalized.by_class as Record<string, number>, writers: Object.fromEntries(normalized.writers.map(w => [w.writer, w.count])) });
  return { ...report, ...(recovered ? { recovered_frontmatter: recovered } : {}), ...fences };
}

/** Dry run: the files this run would hold, read-only (no hold row is written or changed). */
export async function wouldHoldFields(engine: BrainEngine, holds: LegacyHolds | null, root: string, paths: string[], activePack?: SyncActivePack): Promise<Partial<SyncResult>> {
  if (!holds?.active) return { dry_run: true };
  const now = new Date().toISOString();
  const refused: Array<{ path: string; screen: HoldScreen & { refusal: ContentRefusal } }> = [];
  for (const path of new Set(paths)) {
    const filePath = fileUnderRoot(root, path);
    if (!filePath) continue;
    const screen = screenLegacyFile(filePath, path, activePack);
    if (screen.refusal) refused.push({ path, screen: screen as HoldScreen & { refusal: ContentRefusal } });
  }
  const pages = refused.length ? await engine.executeRaw<{ id: number | string; slug: string; source_path: string }>(
    'SELECT id, slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path = ANY($2::text[])',
    [holds.sourceId, refused.map(entry => entry.path)]) : [];
  const pageByPath = new Map(pages.map(page => [page.source_path, page]));
  const items: GitHoldItem[] = refused.map(({ path, screen }) => {
    const page = pageByPath.get(path);
    const { refusal } = screen;
    return gitHoldItem({ version: 1, source_id: holds.sourceId, incarnation: holds.incarnation, path, source_path: path,
      slug: page?.slug ?? (resolveSlugForPath(path) || null), page_id: page ? Number(page.id) : null, code: refusal.code, message: refusal.message,
      upstream_version: screen.upstreamVersion, observed_at: now, held_at: holds.existing.get(path)?.held_at ?? now, updated_at: now, run_id: null, mode: 'legacy',
      meta: { ...(refusal.reason ? { reason: refusal.reason } : {}), ...(refusal.key ? { key: refusal.key } : {}),
        ...(refusal.line !== undefined ? { line: refusal.line } : {}), recovery_version: RECOVERY_VERSION } });
  });
  return { dry_run: true, would_hold: items.slice(0, holds.policy.cap), would_hold_count: items.length };
}

/**
 * Folds the holds into the run's manifest: a held rename destination that is
 * re-screened (or touched by Git) becomes a rename from its recorded origin,
 * so the page moves with its id once the file imports; a rename away from a
 * held destination (`a -> b (held) -> c`) carries the original origin forward.
 */
export function applyHoldsToManifest(holds: LegacyHolds | null, filtered: { added: string[]; modified: string[]; renamed: Array<{ from: string; to: string }> }): void {
  if (!holds?.active) return;
  const pending = (path: string) => holds.existing.get(path)?.meta.rename_from;
  for (const rename of filtered.renamed) {
    const origin = pending(rename.from);
    if (!origin) continue;
    holds.gone.push(rename.from);
    rename.from = origin.sourcePath;
  }
  for (const list of [filtered.added, filtered.modified, holds.rescreen]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const origin = pending(list[i]!);
      if (!origin) continue;
      filtered.renamed.push({ from: origin.sourcePath, to: list[i]! });
      list.splice(i, 1);
    }
  }
}

/** The rename a hold on `to` (or on an earlier destination of the same origin) still owes. */
function pendingRename(holds: LegacyHolds, from: string, to: string): SyncRename | undefined {
  return holds.existing.get(to)?.meta.rename_from
    ?? [...holds.existing.values()].find(record => record.meta.rename_from?.sourcePath === from)?.meta.rename_from;
}

async function currentPage(engine: BrainEngine, sourceId: string, where: { id: number } | { slug: string }): Promise<{ id: number; slug: string; revision: string } | undefined> {
  const [row] = await engine.executeRaw<{ id: number | string; slug: string; revision: string }>(
    `SELECT id, slug, knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND ${'id' in where ? 'id=$2' : 'slug=$2'}`,
    [sourceId, 'id' in where ? where.id : where.slug]);
  return row ? { id: Number(row.id), slug: row.slug, revision: row.revision } : undefined;
}

/**
 * E13: screens a rename destination before the old page's slug or origin
 * moves. True when the destination is held: the old page keeps its slug and
 * origin, and the hold records the rename so the page moves with its id once
 * the file imports. A pending rename whose old page changed since stays held
 * as `rename_held` instead of overwriting those changes.
 */
export async function holdRenameDestination(engine: BrainEngine, holds: LegacyHolds | null,
  input: { from: string; to: string; filePath: string; oldSlug: string | undefined; activePack?: SyncActivePack }): Promise<boolean> {
  if (!holds?.active || !existsSync(input.filePath)) return false;
  const pending = pendingRename(holds, input.from, input.to);
  const screen = screenLegacyFile(input.filePath, input.to, input.activePack);
  if (screen.refusal) {
    const page = pending || input.oldSlug === undefined ? undefined : await currentPage(engine, holds.sourceId, { slug: input.oldSlug });
    const renameFrom = pending ?? (page ? { sourcePath: input.from, slug: page.slug, pageId: page.id, revision: page.revision } : undefined);
    await recordLegacyHold(engine, holds, { path: input.to, refusal: screen.refusal, upstreamVersion: screen.upstreamVersion, renameFrom });
    return true;
  }
  if (!pending) return false;
  const current = await currentPage(engine, holds.sourceId, { id: pending.pageId });
  if (!current || (current.slug === pending.slug && current.revision === pending.revision)) return false;
  await holdChangedRename(engine, holds, input.to, pending, screen.upstreamVersion);
  return true;
}

/** Holds a rename destination whose old page changed after the rename was recorded: moving it would overwrite those changes. */
async function holdChangedRename(engine: BrainEngine, holds: LegacyHolds, to: string, renameFrom: SyncRename, upstreamVersion: string | null): Promise<void> {
  await recordLegacyHold(engine, holds, { path: to, upstreamVersion, renameFrom, refusal: { code: 'rename_held', reason: 'rename_source_changed',
    message: `${to} is a rename of page ${renameFrom.slug}, which changed after the rename was recorded, so the page was not moved onto the new file.` } });
}

/**
 * Full sync: a held rename destination that now screens clean moves its page
 * (same id) before the walk imports it. One whose old page changed since is
 * held as `rename_held` (the walk skips it), never imported as a second page.
 */
export async function moveHeldRenames(engine: BrainEngine, holds: LegacyHolds | null, root: string): Promise<void> {
  if (!holds?.active) return;
  for (const record of holds.existing.values()) {
    const origin = record.meta.rename_from;
    const filePath = fileUnderRoot(root, record.path);
    if (!origin || !filePath) continue;
    const screen = screenLegacyFile(filePath, record.path);
    if (screen.refusal) continue;
    const current = await currentPage(engine, holds.sourceId, { id: origin.pageId });
    if (!current) continue;
    if (current.slug !== origin.slug || current.revision !== origin.revision) {
      await holdChangedRename(engine, holds, record.path, origin, screen.upstreamVersion);
      continue;
    }
    try {
      await maintenanceTransaction(engine, async tx => {
        if (await tx.updateSlug(origin.slug, resolveSlugForPath(record.path), { sourceId: holds.sourceId }) === 0) return;
        await tx.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2 AND source_id=$3', [record.path, origin.pageId, holds.sourceId]);
      });
    } catch { /* the walk imports the file as an ordinary add; the old page stays until a full walk proves it gone */ }
  }
}

/**
 * Full sync is authoritative for the tree it walked: a held path it walked
 * without holding or failing (imported, unchanged or no longer refused), or
 * whose file is gone, clears; every retry request was re-screened.
 */
export async function settleFullSyncHolds(engine: BrainEngine, holds: LegacyHolds | null, input: { root: string; walked: ReadonlySet<string>; failed: ReadonlySet<string> }): Promise<void> {
  if (!holds) return;
  for (const path of holds.existing.keys()) {
    if (input.failed.has(path)) continue;
    if (input.walked.has(path) || !fileUnderRoot(input.root, path)) await clearLegacyHold(engine, holds, path);
  }
  holds.retryTaken.push(...holds.retryPaths);
  await settleLegacyHolds(engine, holds);
}

/** Origins of pages a held rename still owes; a full walk never deletes them. */
export async function heldRenameOrigins(engine: BrainEngine, sourceId: string): Promise<Set<string>> {
  const listed = await readGitSourceHolds(engine, { sourceIds: [sourceId] });
  return new Set((listed[0]?.holds ?? []).flatMap(record => record.meta.rename_from ? [record.meta.rename_from.sourcePath] : []));
}
