/**
 * #6188 fence repair I/O: which sources this host may repair, reading one
 * candidate's current bytes, and the four write-back paths.
 *
 * Sources. On a managed brain a source with a canonical checkout is repaired
 * only on its active owner host (`owner_unavailable` elsewhere, with the
 * condition as its reason: persistence/owner-refusal.ts), and a candidate a
 * write in flight or an unfinished sync's frozen manifest still names is
 * `sync_in_progress` (persistence/repair-busy.ts); every other candidate is
 * repaired while the sync runs (#6278). A legacy (unmanaged) source writes
 * its recorded checkout. A read-only mirror is repaired in the database
 * only.
 *
 * Write-back (spec section 12 step 7):
 *   - managed: `managed_file_repair` writes the exact repaired bytes bound to
 *     the before-hash and page revision, imports them, clears the hold and
 *     commits through the Git effect (subject from the receipt's classes);
 *   - legacy (T2): the confined path is re-read and must still hash to the
 *     read bytes (`changed_since_read`), is backed up, written, imported
 *     (restored from the backup if the import refuses) and an "uncommitted
 *     fence repair" notice records the commit step;
 *   - db: a revision-bound put_page of the page with its repaired sections;
 *   - mirror: the same put_page (database-only by the mirror rule), and the
 *     path's hold is cleared.
 * Every write carries the location-only receipt (actor fence-repair).
 */
import { copyFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../engine.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { gbrainPath } from '../config.ts';
import { createFrontmatterBackup, makeFrontmatterBackupRunId } from '../brain-writer.ts';
import { importFromFile } from '../import-file.ts';
import { screenFenceCtx } from '../import-screen.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { resolveSlugForPath } from '../sync.ts';
import { sha256 } from '../persistence/digest.ts';
import { localHostId } from '../persistence/identity.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from '../persistence/ownership.ts';
import { checkOwner, ownerRefusal, type OwnerRefusal } from '../persistence/owner-refusal.ts';
import { loadRepairBusySet, type RepairBusySet } from '../persistence/repair-busy.ts';
import { sourceMirrorReadOnly } from '../persistence/mirror-read-only.ts';
import { isSourceDbOnlySlug } from '../persistence/source-storage.ts';
import { confinedRepairTarget, prepareRepairPublication, repairScreenConfig, submitManagedFileRepair } from '../persistence/file-repair.ts';
import { clearGitHold, readGitHold, type GitHoldRecord } from '../persistence/sync-holds.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { repairRequestId } from '../repair/core.ts';
import { clearCandidateParts } from './census-store.ts';
import { legacyCommitStep, recordUncommittedFenceRepair } from './uncommitted.ts';
import type { FenceRepairReceipt } from './receipt.ts';
import type { FenceCtx, FencePage } from './types.ts';

export type FenceRepairMode = 'managed' | 'legacy' | 'db' | 'mirror';

export interface FenceSource {
  id: string;
  incarnation: string;
  managed: boolean;
  mirror: boolean;
  /** The checkout this host reads and (unless a mirror) writes; null when the source has none here. */
  root: string | null;
  /** Managed brain: why this host may not write the source's checkout (another owner, a transfer or clone in progress, an incomplete registration); null when it may. */
  owner: OwnerRefusal | null;
  /** Managed brain: the paths and slugs in-flight writes and unfinished sync manifests name (every candidate while `unknown`). */
  busy: RepairBusySet;
  activePack?: Awaited<ReturnType<typeof repairScreenConfig>>['activePack'];
}

function inGit(root: string): boolean {
  try { execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/**
 * This host's view of one source for fence repair; null when the source is gone or archived. `remote` (default
 * true, the fail-closed reading of an unknown caller) keeps local paths out of the owner refusal's text.
 */
export async function loadFenceSource(engine: BrainEngine, sourceId: string, opts: { remote?: boolean } = {}): Promise<FenceSource | null> {
  const [row] = await engine.executeRaw<{ id: string; incarnation: string; local_path: string | null }>(
    'SELECT id, incarnation::text AS incarnation, local_path FROM sources WHERE id=$1 AND archived IS NOT TRUE', [sourceId]);
  if (!row) return null;
  const managed = await managedPersistenceEnabled(engine);
  const mirror = await sourceMirrorReadOnly(engine, sourceId);
  let root: string | null = null;
  let owner: OwnerRefusal | null = null;
  if (managed) {
    const binding = await getWorktreeBinding(engine, sourceId);
    // A source with no binding at all has no checkout anywhere: it is repaired in the database (db mode), not refused.
    if (binding) {
      const hostId = localHostId();
      const checked = checkOwner(binding, row.incarnation, hostId);
      if (checked.reason) owner = ownerRefusal({ sourceId, reason: checked.reason, binding, incarnation: row.incarnation, hostId, remote: opts.remote !== false, work: 'fence repair' });
      else root = join(checked.binding.local_path, checked.binding.relative_path);
    }
  } else {
    const local = row.local_path ?? (sourceId === 'default' ? await engine.getConfig('sync.repo_path') : null);
    root = local && existsSync(local) ? local : null;
  }
  const busy: RepairBusySet = managed ? await loadRepairBusySet(engine, sourceId, row.incarnation) : { paths: new Set(), slugs: new Set(), unknown: null };
  const config = await repairScreenConfig(engine, sourceId);
  return { id: row.id, incarnation: row.incarnation, managed, mirror, root, owner, busy, ...(config.activePack ? { activePack: config.activePack } : {}) };
}

/** One candidate's current bytes: a working-tree file, or a stored page. */
export interface FenceTarget {
  mode: FenceRepairMode;
  sourceId: string;
  /** The census key (page slug, or `path:<file>`). */
  key: string;
  slug: string;
  path: string | null;
  sourcePath: string | null;
  page: FencePage;
  /** The file's text (file targets). */
  content: string | null;
  /** sha256 of the file bytes, or of the page's two sections. */
  before: string;
  snapshot: PageSnapshot | null;
  hold: GitHoldRecord | null;
  ctx: FenceCtx;
}

/** sha256 a stored page's fence sections are bound by (the census uses the same). */
export function pageSha(page: FencePage): string {
  return sha256(`${page.compiled_truth ?? ''}\u0000${page.timeline ?? ''}`);
}

export type TargetRead = { ok: true; target: FenceTarget } | { ok: false; reason: 'gone' | 'not_utf8' | 'unsafe_path' };

/** Reads a candidate as it is now. A held or walked file is read from the checkout; anything else is read from the page store. */
export async function readFenceTarget(engine: BrainEngine, src: FenceSource, cand: { key: string; path: string | null }): Promise<TargetRead> {
  const hold = cand.path ? await readGitHold(engine, src.id, src.incarnation, cand.path) : null;
  const holdSlug = hold?.slug ?? (cand.key.startsWith('path:') ? null : cand.key);
  if (cand.path && src.root) {
    const abs = join(src.root, cand.path);
    if (existsSync(abs)) {
      try { confinedRepairTarget(src.root, cand.path, src.id, 'fences'); } catch (error) {
        if (error instanceof OperationError) return { ok: false, reason: 'unsafe_path' };
        throw error;
      }
      const bytes = readFileSync(abs);
      const content = bytes.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(bytes)) return { ok: false, reason: 'not_utf8' };
      const sourcePath = hold?.source_path ?? cand.path;
      const [byOrigin] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND source_path=$2 AND deleted_at IS NULL LIMIT 1', [src.id, sourcePath]);
      const slug = byOrigin?.slug ?? holdSlug ?? resolveSlugForPath(sourcePath);
      const dbOnly = src.managed && isSourceDbOnlySlug(src.root, slug, 'not_db_only');
      if (!dbOnly) {
        const parsed = parseMarkdown(content, cand.path, src.activePack ? { activePack: src.activePack } : undefined);
        return { ok: true, target: { mode: src.mirror ? 'mirror' : src.managed ? 'managed' : 'legacy', sourceId: src.id, key: cand.key, slug, path: cand.path, sourcePath,
          page: { compiled_truth: parsed.compiled_truth, timeline: parsed.timeline ?? '' }, content, before: sha256(bytes),
          snapshot: await engine.readPageSnapshot(slug, { sourceId: src.id, includeDeleted: true }), hold, ctx: screenFenceCtx(parsed, src.activePack) } };
      }
    }
  }
  const slug = holdSlug;
  const snapshot = slug ? await engine.readPageSnapshot(slug, { sourceId: src.id }) : null;
  if (!snapshot || snapshot.page.deleted_at) return { ok: false, reason: 'gone' };
  const page = { compiled_truth: snapshot.page.compiled_truth ?? '', timeline: snapshot.page.timeline ?? '' };
  return { ok: true, target: { mode: src.mirror ? 'mirror' : 'db', sourceId: src.id, key: cand.key, slug: snapshot.page.slug, path: null,
    sourcePath: snapshot.page.source_path ?? null, page, content: null, before: pageSha(page), snapshot, hold,
    ctx: screenFenceCtx({ type: snapshot.page.type as never, frontmatter: (snapshot.page.frontmatter ?? {}) as Record<string, unknown> }, src.activePack) } };
}

function indexesOf(lines: readonly string[], needle: readonly string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i + needle.length <= lines.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length && match; j++) match = lines[i + j] === needle[j];
    if (match) hits.push(i);
  }
  return hits;
}

/**
 * The file with each repaired section spliced back in place: per section the
 * changed line range (common prefix and suffix kept), located in the file by
 * that range plus the fewest context lines that make it unique. Null when
 * the range cannot be located once, or when the result does not parse back
 * to exactly the repaired sections.
 */
export function spliceFileSections(content: string, path: string, before: FencePage, after: FencePage): string | null {
  let lines = content.split('\n');
  for (const field of ['compiled_truth', 'timeline'] as const) {
    if ((before[field] ?? '') === (after[field] ?? '')) continue;
    const b = (before[field] ?? '').split('\n');
    const a = (after[field] ?? '').split('\n');
    let head = 0;
    while (head < b.length && head < a.length && b[head] === a[head]) head++;
    let tail = 0;
    while (tail < b.length - head && tail < a.length - head && b[b.length - 1 - tail] === a[a.length - 1 - tail]) tail++;
    const removed = b.slice(head, b.length - tail);
    const added = a.slice(head, a.length - tail);
    let placed = false;
    for (let k = 0; !placed; k++) {
      const pre = b.slice(Math.max(0, head - k), head);
      const post = b.slice(b.length - tail, Math.min(b.length, b.length - tail + k));
      const needle = [...pre, ...removed, ...post];
      const hits = needle.length ? indexesOf(lines, needle) : [];
      if (hits.length === 1) {
        lines = [...lines.slice(0, hits[0]! + pre.length), ...added, ...lines.slice(hits[0]! + pre.length + removed.length)];
        placed = true;
      } else if (!hits.length && needle.length) return null;
      else if (head - k <= 0 && b.length - tail + k >= b.length) return null;
    }
  }
  const out = lines.join('\n');
  const parsed = parseMarkdown(out, path);
  if (parsed.compiled_truth.trim() !== (after.compiled_truth ?? '').trim() || (parsed.timeline ?? '').trim() !== (after.timeline ?? '').trim()) return null;
  return out;
}

export type WriteOutcome =
  | { ok: true; detail: Record<string, unknown>; after_sha256: string }
  | { ok: false; reason: string; message: string };

/** The receipt fields the writer completes (hashes) from what the caller decided (tier, classes, model, spend). */
export type ReceiptParts = Omit<FenceRepairReceipt, 'before_sha256' | 'after_sha256'>;

/** Writes one repaired candidate through its mode's path. Trusted local callers only (the caller checks `ctx.remote === false`). */
export async function writeFenceRepair(ctx: OperationContext, src: FenceSource, target: FenceTarget, after: FencePage, parts: ReceiptParts, opts: { embed: boolean }): Promise<WriteOutcome> {
  const engine = ctx.engine;
  const local = { ...ctx, remote: false, sourceId: src.id } as OperationContext;
  const clearCensus = async () => {
    await clearCandidateParts(engine, { sourceId: src.id, incarnation: src.incarnation }, 'page', [target.key]);
    await clearCandidateParts(engine, { sourceId: src.id, incarnation: src.incarnation }, 'file', [target.key]);
  };
  const fileContent = target.content !== null && target.path ? spliceFileSections(target.content, target.path, target.page, after) : null;
  if (target.content !== null && fileContent === null) {
    return { ok: false, reason: 'unparseable', message: `gbrain could not place the repaired fence back into ${target.path}; edit the fence there by hand.` };
  }
  if (target.mode === 'managed') {
    const receipt: FenceRepairReceipt = { ...parts, before_sha256: target.before, after_sha256: sha256(Buffer.from(fileContent!, 'utf8')) };
    const config = await repairScreenConfig(engine, src.id);
    const publication = await prepareRepairPublication(engine, { sourceId: src.id, slug: target.slug, sourcePath: target.sourcePath!, path: target.path!, root: src.root!,
      content: fileContent!, snapshot: target.snapshot, base: target.snapshot, ...config });
    if (publication.status === 'refused') return { ok: false, reason: publication.refusal.code === 'invalid_fence' ? 'still_invalid' : publication.refusal.code,
      message: `Importing the repaired ${target.path} would be refused (${publication.refusal.code}), so nothing was written.` };
    if (publication.status === 'overlay') return { ok: false, reason: 'canonical_overlay',
      message: `Importing the repaired ${target.path} would keep page data the file does not carry (tags added outside the file, a withdrawal or sanitized text), so nothing was written. Edit the fence in the file by hand.` };
    try {
      const outcome = await submitManagedFileRepair(local, { sourceId: src.id,
        requestId: await repairRequestId(local, 'fences', { source_id: src.id, slug: target.slug }, `${receipt.before_sha256}:${receipt.after_sha256}`),
        slug: target.slug, path: target.path!, sourcePath: target.sourcePath!, content: fileContent!, beforeHash: target.before, resultDigest: publication.digest,
        ...(target.snapshot && !target.snapshot.page.deleted_at ? { expected_revision: target.snapshot.revision } : {}), noEmbed: !opts.embed, fenceRepair: receipt });
      await clearCensus();
      const persistence = outcome.persistence as { git_state?: string } | undefined;
      return { ok: true, after_sha256: receipt.after_sha256, detail: { mode: 'managed', path: target.path, imported: outcome.status, hold_cleared: outcome.hold_cleared === true,
        committed: persistence?.git_state ?? 'not_requested' } };
    } catch (error) {
      if (error instanceof OperationError && ['changed_since_preview', 'revision_conflict', 'page_identity_changed', 'source_changed'].includes(error.code)) {
        return { ok: false, reason: 'changed_since_read', message: `${target.path} changed while it was being repaired; the next run reads it again.` };
      }
      if (error instanceof OperationError && error.code === 'sync_in_progress') return { ok: false, reason: 'sync_in_progress', message: error.message };
      throw error;
    }
  }
  if (target.mode === 'legacy') {
    const root = src.root!;
    let abs: string;
    try { abs = confinedRepairTarget(root, target.path!, src.id, 'fences'); } catch (error) {
      if (error instanceof OperationError) return { ok: false, reason: 'unsafe_path', message: `${target.path} is a symlink, sits under one, or resolves outside the source root; gbrain never writes through one.` };
      throw error;
    }
    if (sha256(readFileSync(abs)) !== target.before) return { ok: false, reason: 'changed_since_read', message: `${target.path} changed after the repair read it, so nothing was written.` };
    const receipt: FenceRepairReceipt = { ...parts, before_sha256: target.before, after_sha256: sha256(Buffer.from(fileContent!, 'utf8')) };
    const backup = createFrontmatterBackup(abs, { sourcePath: root, backupRoot: gbrainPath('backups', 'fences', makeFrontmatterBackupRunId()) });
    writeFileSync(abs, fileContent!);
    const imported = await importFromFile(engine, abs, target.sourcePath ?? target.path!, { sourceId: src.id, noEmbed: !opts.embed });
    if (imported.status === 'error' || imported.refusal) {
      copyFileSync(backup, abs);
      return { ok: false, reason: 'still_invalid', message: `The repaired ${target.path} did not import (${imported.refusal?.code ?? 'error'}), so the file was restored from its backup.` };
    }
    if (target.hold) await clearGitHold(engine, { sourceId: src.id, incarnation: src.incarnation, path: target.path!, observedAt: new Date().toISOString() });
    await clearCensus();
    const commitStep = inGit(root) ? legacyCommitStep(root, target.path!, receipt.classes) : null;
    if (commitStep) await recordUncommittedFenceRepair(engine, { source_id: src.id, incarnation: src.incarnation, path: target.path!, root, repaired_at: new Date().toISOString(),
      backup, commit_step: commitStep, receipt });
    return { ok: true, after_sha256: receipt.after_sha256, detail: { mode: 'legacy', path: target.path, backup, imported: imported.status, fence_repair: receipt,
      ...(commitStep ? { committed: 'commit_step', commit_step: commitStep } : { committed: 'not_in_git' }) } };
  }
  const snapshot = target.snapshot;
  const content = fileContent ?? (snapshot ? serializePageToMarkdown({ ...snapshot.page, compiled_truth: after.compiled_truth, timeline: after.timeline }, snapshot.tags) : null);
  if (content === null) return { ok: false, reason: 'changed_since_read', message: `${target.slug} is gone.` };
  const receipt: FenceRepairReceipt = { ...parts, before_sha256: target.before, after_sha256: fileContent !== null ? sha256(Buffer.from(fileContent, 'utf8')) : pageSha(after) };
  try {
    const outcome = await submitPageMutation(local, { operation: 'put_page', params: { slug: target.slug, source_id: src.id, content,
      ...(snapshot && !snapshot.page.deleted_at ? { expected_revision: snapshot.revision } : {}),
      request_id: await repairRequestId(local, 'fences', { source_id: src.id, slug: target.slug }, `${receipt.before_sha256}:${receipt.after_sha256}`), fence_repair: receipt } });
    if (target.mode === 'mirror' && target.hold) await clearGitHold(engine, { sourceId: src.id, incarnation: src.incarnation, path: target.hold.path, observedAt: new Date().toISOString() });
    await clearCensus();
    return { ok: true, after_sha256: receipt.after_sha256, detail: { mode: target.mode, slug: target.slug, ...(target.path ? { path: target.path } : {}), status: outcome.status,
      ...(target.mode === 'mirror' ? { storage: 'database_only' } : {}) } };
  } catch (error) {
    if (error instanceof OperationError && ['revision_conflict', 'changed_since_preview', 'source_changed'].includes(error.code)) {
      return { ok: false, reason: 'changed_since_read', message: `${target.slug} changed while it was being repaired; the next run reads it again.` };
    }
    throw error;
  }
}

/** True when the path is a regular file in the checkout (not a link). */
export function checkoutFileExists(root: string, path: string): boolean {
  try { return lstatSync(join(root, path)).isFile(); } catch { return false; }
}
