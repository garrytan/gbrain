/**
 * `gbrain repair frontmatter` (#5988): finds every file and page a broken
 * frontmatter block left behind and fixes what it can without guessing.
 *
 * Scope: the Git-visible `.md`/`.mdx` files of each source plus every Git
 * hold row, and (database side) pages whose body begins with an embedded
 * frontmatter block or whose title was derived from the slug while the file
 * names one. Per file it proposes one minimal line-level change, in two
 * classes:
 *
 *   - safe: quoting a value ingestion already reads (`recoverFrontmatter`
 *     `quote`), stripping NUL bytes, swapping the outer quotes of a nested
 *     quoted value. Every parsed value stays exactly what ingestion read.
 *   - interpretive: folding unquoted continuation lines into a value,
 *     resolving a duplicated key to the later line, quoting an unclosed
 *     `[`/`{`, quoting a `#`-leading title, inserting a missing closing
 *     fence, removing a frontmatter `slug:` that names another page,
 *     re-importing a page from its canonical file, and re-binding a held
 *     rename to the old page's current revision.
 *
 * The default set is safe only; `--include-ambiguous` adds interpretive
 * changes and changes the preview hash. `--only <path>` / `--skip <path>`
 * select files and are bound into the hash too. Every change must leave a
 * file that strict-parses with no hold, and its publication result (the
 * exact bytes plus the page fields an import would store, bound to the page
 * revision) is hashed; a file whose import would need a canonical overlay,
 * or that no rule fixes, is `needs_review` with the exact manual fix and is
 * never written.
 *
 * Explicit-only and preview-bound: `--apply --expect <hash>` (destructive
 * consent: `--yes`) re-derives each approved change from the file as it is
 * and applies it only when the file bytes, the proposal and the page still
 * match (`changed_since_preview` otherwise). Managed sources publish through
 * the owner-internal `managed_file_repair` intent (exact bytes, import, hold
 * clear and Git target effect in one coordinated write); legacy sources back
 * the file up, write it, import it, clear its hold, and print the commit
 * step. An apply refuses while an unfinished managed sync cursor still names
 * a selected file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { shellQuote, type Action } from '../agent-output.ts';
import { autoFixFrontmatter, createFrontmatterBackup, makeFrontmatterBackupRunId, repairRecoverableFrontmatter } from '../brain-writer.ts';
import { classifyImportHold, parseMarkdown, type ContentHold, type ParsedMarkdown } from '../markdown.ts';
import { MAX_FILE_SIZE, type ContentRefusal } from '../import-screen.ts';
import { importFromFile } from '../import-file.ts';
import { resolveSlugForPath } from '../sync.ts';
import { isReservedSkillBundlePath } from '../skill-reserved-paths.ts';
import { digest, sha256 } from '../persistence/digest.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { clearGitHold, readGitSourceHolds, type GitHoldRecord } from '../persistence/sync-holds.ts';
import { fenceWhere } from '../fence-repair/refusal.ts';
import type { SyncRename } from '../persistence/sync-discovery.ts';
import { canonicalRepairFields, confinedRepairTarget, managedRepairRoot, prepareRepairPublication, repairScreenConfig, submitManagedFileRepair } from '../persistence/file-repair.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';

type Mode = 'managed' | 'legacy';
type RepairClass = 'safe' | 'interpretive';
interface Selection { source_ids: string[]; include_ambiguous: boolean; only: string[]; skip: string[] }
interface SourceRoot { sourceId: string; incarnation: string; mode: Mode; root: string }

/** One approved change: everything the hash binds, never a raw frontmatter value. */
interface ApprovedRepair {
  source_id: string; mode: Mode; path: string; source_path: string; slug: string; class: RepairClass; fixes: string[];
  before: string; after: string; chars: number; page_id: number | null; revision: string | null; result_digest: string; rename_from?: SyncRename;
}
interface ApprovedSetItem extends ApprovedRepair { selection: Selection }
interface FrontmatterItem extends RepairItem { repair: ApprovedRepair; selection: Selection; hash: string; last: boolean }

export interface NeedsReview {
  source_id: string; path: string; code: string; reason?: string; key?: string; line?: number;
  /** The exact manual fix: the line to edit, or what to do with the file. */
  resolution: string;
  /** `imported_before_hold`: a page exists from a gbrain that imported this file before it was held. */
  flag?: string;
}
interface FileDiff { source_id: string; path: string; class: RepairClass; fixes: string[]; diff: string; selected: boolean }
export interface FrontmatterPreviewDetails {
  counts: { safe: number; interpretive: number; interpretive_pending: number; needs_review: number };
  samples: Partial<Record<RepairClass, FileDiff>>;
  diffs: FileDiff[];
  needs_review: NeedsReview[];
  next_actions: Action[];
}

const REPAIRABLE = new Set(['YAML_PARSE', 'NULL_BYTES', 'NESTED_QUOTES', 'MISSING_CLOSE']);
const RESCUE_KEYS = new Set(['title', 'name', 'description', 'summary']);

function previewArgv(scope: RepairScope, selection: Pick<Selection, 'only' | 'skip'>, includeAmbiguous: boolean): string[] {
  return ['gbrain', 'repair', 'frontmatter', ...(scope.source_ids.length === 1 ? ['--source', scope.source_ids[0]!] : []),
    ...selection.only.flatMap(path => ['--only', path]), ...selection.skip.flatMap(path => ['--skip', path]), ...(includeAmbiguous ? ['--include-ambiguous'] : [])];
}

/** Single-hunk unified diff of the changed line range. */
export function lineDiff(path: string, before: string, after: string): string {
  const a = before.split('\n'), b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(head, a.length - tail), added = b.slice(head, b.length - tail);
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${head + 1},${removed.length} +${head + 1},${added.length} @@`,
    ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join('\n');
}

/** What ingestion reads from the file: the values a safe change must keep (NUL bytes aside). */
function reading(content: string, path: string): string {
  const parsed = parseMarkdown(content.replace(/\x00/g, ''), path, { validate: true });
  return JSON.stringify([parsed.frontmatter, parsed.title, parsed.type, parsed.tags]);
}

interface SlugContext { expectedSlug: string; slugExempt: (declared: string) => boolean }

function inspect(content: string, path: string, ctx: SlugContext, byteLength: number): { parsed: ParsedMarkdown; errors: string[]; hold: ContentHold | null; recovered: number; comments: number } {
  const parsed = parseMarkdown(content, path, { validate: true });
  return { parsed, errors: [...new Set((parsed.errors ?? []).filter(error => REPAIRABLE.has(error.code)).map(error => error.code))],
    hold: classifyImportHold(parsed, { ...ctx, byteLength, maxBytes: MAX_FILE_SIZE }),
    recovered: (parsed.warnings ?? []).filter(w => w.code === 'FRONTMATTER_RECOVERED').length,
    comments: (parsed.warnings ?? []).filter(w => w.code === 'FRONTMATTER_COMMENT_VALUE' && RESCUE_KEYS.has(w.key)).length };
}

/** Strict-parses with no YAML error and earns no hold: the gate every change must pass. */
function clean(content: string, path: string, ctx: SlugContext): boolean {
  const found = inspect(content, path, ctx, Buffer.byteLength(content));
  return found.errors.length === 0 && found.hold === null;
}

interface Candidates { safe: { content: string; fixes: string[] } | null; interpretive: { content: string; fixes: string[] } | null }

/** The safe and the interpretive rewrite of one file, each kept only when it passes the gate. */
export function frontmatterCandidates(content: string, path: string, ctx: SlugContext): Candidates {
  const found = inspect(content, path, ctx, Buffer.byteLength(content));
  const has = (code: string) => found.errors.includes(code);
  let safe = content;
  const safeFixes: string[] = [];
  if (has('NULL_BYTES')) { safe = safe.replace(/\x00/g, ''); safeFixes.push('Stripped null bytes'); }
  if (has('NESTED_QUOTES') && !has('MISSING_CLOSE')) {
    const swapped = autoFixFrontmatter(safe);
    if (swapped.fixes.every(fix => fix.code === 'NESTED_QUOTES')) { safe = swapped.content; safeFixes.push(...swapped.fixes.map(fix => fix.description)); }
  }
  const quoted = repairRecoverableFrontmatter(safe);
  safe = quoted.content;
  safeFixes.push(...quoted.fixes.map(fix => fix.description));
  const safeOk = safe !== content && clean(safe, path, ctx) && reading(safe, path) === reading(content, path);
  let interpretive = content.replace(/\x00/g, '');
  const interpretiveFixes = has('NULL_BYTES') ? ['Stripped null bytes'] : [];
  const slugConflict = found.hold?.code === 'frontmatter_slug_conflict';
  if (has('NESTED_QUOTES') || has('MISSING_CLOSE') || slugConflict) {
    const fixed = autoFixFrontmatter(interpretive, slugConflict ? { filePath: path } : undefined);
    interpretive = fixed.content;
    interpretiveFixes.push(...fixed.fixes.map(fix => fix.description));
  }
  const rescued = repairRecoverableFrontmatter(interpretive, { includeAmbiguous: true });
  interpretive = rescued.content;
  interpretiveFixes.push(...rescued.fixes.map(fix => fix.description));
  const interpretiveOk = interpretive !== content && interpretive !== (safeOk ? safe : content) && clean(interpretive, path, ctx);
  return { safe: safeOk ? { content: safe, fixes: safeFixes } : null, interpretive: interpretiveOk ? { content: interpretive, fixes: interpretiveFixes } : null };
}

/** The exact manual fix for a file no rule repairs. */
function resolution(hold: Pick<ContentRefusal, 'code' | 'reason' | 'key' | 'line' | 'fence'> | null, path: string, sourceId: string): string {
  if (!hold) return `Edit the frontmatter of ${path} by hand (one line per key, the whole value quoted), then preview again.`;
  const where = `${hold.line !== undefined ? `line ${hold.line}` : 'the frontmatter'}${hold.key ? ` (key "${hold.key}")` : ''} of ${path}`;
  switch (hold.code) {
    // #6188: frontmatter repair never rewrites a fence; the fence repair does.
    case 'invalid_fence': return `${path}: ${fenceWhere(hold.fence)} is malformed (${hold.fence?.reason ?? hold.reason ?? 'invalid_fence'}), and frontmatter repair does not change fences. `
      + `Preview its repair with gbrain repair fences --source ${sourceId} --only ${path} (read-only; it names the exact edit when gbrain will not repair it).`;
    case 'file_too_large': return `Split ${path} into files under ${MAX_FILE_SIZE} bytes and commit, or leave it out of the source with sync.exclude.`;
    case 'frontmatter_slug_conflict': return `Remove the slug: line of ${path} (the path decides the slug), or move the file to the path its slug names.`;
    case 'content_rejected': return `Remove the junk the content-sanity gate matched in ${path}, or ask the user whether junk_disposition should stay reject.`;
    case 'purged_content': return `${path} carries purged page content; delete or edit it and commit, or the owner clears the tombstone with gbrain pages unpurge.`;
    case 'write_gate_rejected': return `The write gate refused ${path} as external instruction-like content; ask the user whether to edit it or whether write_gate.external_mode should stay reject.`;
    case 'rename_held': return `Re-run the preview with --include-ambiguous to re-bind the rename of ${path} to the current page, or restore the old file name.`;
    case 'parser_regression': return `This is a gbrain bug: report the gbrain version, ${path} and the code; upgrade or pin the last good version.`;
    default: return hold.reason === 'ambiguous_protected_key' ? `Write ${where} on one line with one quoted value; gbrain never guesses who may read a page or where it came from.`
      : hold.reason === 'ambiguous_identity_key' ? `Keep exactly one line for ${where}; gbrain never guesses which page a file is.`
      : `Fix ${where} by hand: one line per key, the whole value quoted on that line.`;
  }
}

/** The managed owner root, or the legacy checkout, of each source in scope; others are residuals. */
async function sourceRoots(engine: BrainEngine, scope: RepairScope, residuals: Record<string, number>, warnings: string[]): Promise<SourceRoot[]> {
  const managed = await managedPersistenceEnabled(engine);
  const rows = await engine.executeRaw<{ id: string; incarnation: string; local_path: string | null }>(
    'SELECT id, incarnation::text AS incarnation, local_path FROM sources WHERE id = ANY($1::text[]) ORDER BY id', [scope.source_ids]);
  const roots: SourceRoot[] = [];
  for (const row of rows) {
    if (managed) {
      try { roots.push({ sourceId: row.id, incarnation: row.incarnation, mode: 'managed', root: (await managedRepairRoot(engine, row.id)).root }); }
      catch (error) {
        if (!(error instanceof OperationError)) throw error;
        residuals.owner_elsewhere = (residuals.owner_elsewhere ?? 0) + 1;
        warnings.push(`Source ${row.id}: this host is not its active canonical owner; run the preview on the owner host (gbrain sources writer status --source ${row.id}).`);
      }
      continue;
    }
    const root = row.local_path ?? (row.id === 'default' ? await engine.getConfig('sync.repo_path') : null);
    if (root && existsSync(root)) roots.push({ sourceId: row.id, incarnation: row.incarnation, mode: 'legacy', root });
  }
  return roots;
}

/** Git-visible Markdown under the root (tracked and untracked, ignored files excluded); a plain walk outside Git. */
function markdownFiles(root: string): string[] {
  let paths: string[];
  try {
    paths = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean);
  } catch {
    paths = (readdirSync(root, { recursive: true }) as string[]).map(path => path.split('\\').join('/'));
  }
  return [...new Set(paths)].filter(path => /\.mdx?$/i.test(path) && !path.split('/').some(part => part.startsWith('.')) && !isReservedSkillBundlePath(path)).sort();
}

interface PageRow { id: number; slug: string; source_path: string; revision: string; title: string; head: string }

async function pagesByOrigin(engine: BrainEngine, sourceId: string): Promise<Map<string, PageRow>> {
  const rows = await engine.executeRaw<PageRow>(`SELECT id, slug, source_path, knowledge_revision::text AS revision, title, left(compiled_truth, 400) AS head
    FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL`, [sourceId]);
  return new Map(rows.map(row => [row.source_path, { ...row, id: Number(row.id) }]));
}

/** #4526: a body that begins with its own frontmatter block. */
const EMBEDDED_BLOCK = /^\s*---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?[A-Za-z_][\w-]*:[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** The title parseMarkdown falls back to when a file names none: the humanized slug. */
function slugTitle(slug: string): string {
  const name = slug.split('/').pop() ?? '';
  return name.replace(/[-_]/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase()) || 'Untitled';
}

/** Database-side damage worth a re-import from the canonical file. */
function pageDamage(page: PageRow | undefined, content: string): string | null {
  if (!page) return null;
  if (EMBEDDED_BLOCK.test(page.head)) return 'its stored body begins with an embedded frontmatter block';
  const titleLine = /^---[^\n]*\n[\s\S]*?^title:[ \t]*\S/m.test(content.replace(/^\uFEFF/, ''));
  if (titleLine && page.title === slugTitle(page.slug)) return 'its stored title was derived from the slug although the file names a title';
  return null;
}

interface Analysis {
  proposal?: { content: string; fixes: string[]; class: RepairClass; rename_from?: SyncRename; reimport?: string };
  pending?: { content: string; fixes: string[] };
  review?: NeedsReview;
}

interface FileContext { engine: BrainEngine; src: SourceRoot; includeAmbiguous: boolean; pages: Map<string, PageRow> }

/** One file's proposal, pending interpretation, or manual fix; null when it needs nothing. */
async function analyzeFile(ctx: FileContext, path: string, hold: GitHoldRecord | undefined): Promise<Analysis | null> {
  const { src, includeAmbiguous } = ctx;
  const abs = join(src.root, path);
  const review = (code: string, text: string, extra: Partial<NeedsReview> = {}): Analysis => ({ review: { source_id: src.sourceId, path, code, resolution: text, ...extra } });
  if (!existsSync(abs)) return hold ? review(hold.code, `${path} is gone; the next gbrain sync --source ${src.sourceId} --no-pull clears its hold.`) : null;
  try { confinedRepairTarget(src.root, path, src.sourceId); } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return hold ? review(hold.code, `${path} is a symlink, sits under one, or resolves outside the source root; gbrain never writes through one. Replace it with the real file, then preview again.`) : null;
  }
  const size = lstatSync(abs).size;
  if (size > MAX_FILE_SIZE) return review('file_too_large', resolution({ code: 'file_too_large' }, path, src.sourceId));
  const bytes = readFileSync(abs);
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) return review(hold?.code ?? 'invalid_frontmatter', `${path} is not valid UTF-8, so gbrain will not rewrite it; re-save it as UTF-8, then preview again.`);
  const sourcePath = hold?.source_path ?? path;
  const page = ctx.pages.get(sourcePath);
  const slugCtx: SlugContext = { expectedSlug: resolveSlugForPath(sourcePath), slugExempt: declared => page?.source_path === sourcePath && declared === page.slug };
  const found = inspect(content, path, slugCtx, size);
  const heldBefore = hold && hold.page_id !== null && ['ambiguous_protected_key', 'ambiguous_identity_key'].includes(hold.meta.reason ?? '')
    ? { flag: 'imported_before_hold' } : {};
  let renameFrom = hold?.meta.rename_from;
  let rebind = hold?.code === 'rename_held';
  if (renameFrom) {
    const old = await ctx.engine.readPageSnapshot(renameFrom.slug, { sourceId: src.sourceId });
    if (!old || old.page.id !== renameFrom.pageId) { renameFrom = undefined; rebind = false; }
    else if (old.revision !== renameFrom.revision) { renameFrom = { ...renameFrom, revision: old.revision }; rebind = true; }
  }
  const problem = found.errors.length > 0 || found.hold !== null || found.recovered > 0 || found.comments > 0;
  const damage = !problem && !hold ? pageDamage(page, content) : null;
  if (!problem && !hold && !damage) return null;
  if (damage) {
    const body = parseMarkdown(content, path).compiled_truth;
    if (EMBEDDED_BLOCK.test(body)) return review('embedded_frontmatter', `${path} itself carries a second frontmatter block at the top of its body; merge the two blocks by hand, then preview again.`);
    const reimport = { content, fixes: [`Re-import ${path}: ${damage}`], class: 'interpretive' as const, reimport: damage };
    return includeAmbiguous ? { proposal: reimport } : { pending: reimport };
  }
  const candidates = frontmatterCandidates(content, path, slugCtx);
  const unchanged = found.hold === null && !found.errors.length ? { content, fixes: [] as string[] } : null;
  if (rebind) {
    const base = candidates.interpretive ?? candidates.safe ?? unchanged;
    if (!base) return review(found.hold?.code ?? hold!.code, resolution(found.hold, path, src.sourceId));
    const proposal = { content: base.content, fixes: [...base.fixes, `Re-bind the rename of ${path} to page ${renameFrom!.slug} at its current revision`], class: 'interpretive' as const, rename_from: renameFrom };
    return includeAmbiguous ? { proposal } : { pending: proposal };
  }
  const withRename = renameFrom ? { rename_from: renameFrom } : {};
  if (includeAmbiguous && candidates.interpretive) return { proposal: { ...candidates.interpretive, class: 'interpretive', ...withRename } };
  if (candidates.safe) return { proposal: { ...candidates.safe, class: 'safe', ...withRename }, ...(candidates.interpretive ? { pending: candidates.interpretive } : {}) };
  if (candidates.interpretive) return { pending: candidates.interpretive };
  if (hold && unchanged) return { proposal: { content, fixes: [`Import ${path} as it is now`], class: 'safe', ...withRename } };
  if (!found.hold && !hold && !found.errors.length) return null;
  const blocking = found.hold ?? (hold ? { code: hold.code as ContentRefusal['code'], reason: hold.meta.reason as ContentRefusal['reason'], key: hold.meta.key, line: hold.meta.line,
    fence: hold.meta.fence, message: hold.message } : null);
  return review(blocking?.code ?? 'invalid_frontmatter', resolution(blocking, path, src.sourceId), {
    ...(blocking?.reason ? { reason: blocking.reason } : {}), ...(blocking?.key ? { key: blocking.key } : {}), ...(blocking?.line !== undefined ? { line: blocking.line } : {}), ...heldBefore });
}

interface Prepared { approved: ApprovedRepair; content: string; original: string }

/** Binds a proposal to its publication result; a refusal or an overlay makes it `needs_review`. */
async function bindProposal(ctx: FileContext, path: string, hold: GitHoldRecord | undefined, proposal: NonNullable<Analysis['proposal']>,
  screenConfig: Awaited<ReturnType<typeof repairScreenConfig>>): Promise<Prepared | NeedsReview> {
  const { engine, src } = ctx;
  const sourcePath = hold?.source_path ?? path;
  const page = ctx.pages.get(sourcePath);
  const slug = page?.slug ?? (proposal.rename_from ? resolveSlugForPath(sourcePath) : hold?.slug ?? resolveSlugForPath(sourcePath));
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: src.sourceId, includeDeleted: true });
  const base: PageSnapshot | null = proposal.rename_from ? await engine.readPageSnapshot(proposal.rename_from.slug, { sourceId: src.sourceId, includeDeleted: true }) : snapshot;
  const publication = await prepareRepairPublication(engine, { sourceId: src.sourceId, slug, sourcePath, path, root: src.root, content: proposal.content,
    snapshot, base, ...screenConfig });
  if (publication.status === 'refused') return { source_id: src.sourceId, path, code: publication.refusal.code, ...(publication.refusal.reason ? { reason: publication.refusal.reason } : {}),
    ...(publication.refusal.line !== undefined ? { line: publication.refusal.line } : {}), resolution: resolution(publication.refusal, path, src.sourceId) };
  if (publication.status === 'overlay') return { source_id: src.sourceId, path, code: 'canonical_overlay',
    resolution: `Importing the repaired ${path} would keep page data the file does not carry (tags added outside the file, a withdrawal or sanitized text), so it is not written. Edit the file by hand to carry them (gbrain get --source ${src.sourceId} -- ${slug} shows the page), then preview again.` };
  if (proposal.reimport && snapshot && digest(canonicalRepairFields(snapshot.page, snapshot.tags)) === publication.digest) {
    return { source_id: src.sourceId, path, code: 'embedded_frontmatter', resolution: `The page of ${path} already matches its file; nothing to re-import.` };
  }
  const original = readFileSync(join(src.root, path));
  return { content: proposal.content, original: original.toString('utf8'), approved: { source_id: src.sourceId, mode: src.mode, path, source_path: sourcePath, slug, class: proposal.class, fixes: proposal.fixes,
    before: sha256(original), after: sha256(Buffer.from(proposal.content, 'utf8')), chars: proposal.content.length, page_id: snapshot?.page.id ?? null, revision: snapshot?.revision ?? null,
    result_digest: publication.digest, ...(proposal.rename_from ? { rename_from: proposal.rename_from } : {}) } };
}

interface ScanResult { prepared: Prepared[]; pending: FileDiff[]; review: NeedsReview[]; unknownOnly: string[] }

/** Analyzes every selected file of every source and binds each proposal. */
async function scan(engine: BrainEngine, scope: RepairScope, selection: Selection, residuals: Record<string, number>, warnings: string[]): Promise<ScanResult> {
  const out: ScanResult = { prepared: [], pending: [], review: [], unknownOnly: [] };
  const seen = new Set<string>();
  for (const src of await sourceRoots(engine, scope, residuals, warnings)) {
    const holds = new Map(((await readGitSourceHolds(engine, { sourceIds: [src.sourceId] }))[0]?.holds ?? []).map(hold => [hold.path, hold]));
    const ctx: FileContext = { engine, src, includeAmbiguous: selection.include_ambiguous, pages: await pagesByOrigin(engine, src.sourceId) };
    const screenConfig = await repairScreenConfig(engine, src.sourceId);
    const paths = [...new Set([...markdownFiles(src.root), ...holds.keys()])].sort()
      .filter(path => (!selection.only.length || selection.only.includes(path)) && !selection.skip.includes(path));
    for (const path of paths) {
      seen.add(path);
      const hold = holds.get(path);
      const analysis = await analyzeFile(ctx, path, hold);
      if (!analysis) continue;
      if (analysis.review) out.review.push(analysis.review);
      if (analysis.pending) {
        const before = readFileSync(join(src.root, path), 'utf8');
        out.pending.push({ source_id: src.sourceId, path, class: 'interpretive', fixes: analysis.pending.fixes, diff: lineDiff(path, before, analysis.pending.content), selected: false });
      }
      if (!analysis.proposal) continue;
      const bound = await bindProposal(ctx, path, hold, analysis.proposal, screenConfig);
      if ('approved' in bound) out.prepared.push(bound);
      else out.review.push(bound);
    }
  }
  out.unknownOnly = selection.only.filter(path => !seen.has(path));
  return out;
}

/** E9: an unfinished managed sync cursor that still names one of these paths. */
async function unfinishedSyncPath(engine: BrainEngine, sourceId: string, paths: Set<string>): Promise<string | null> {
  const cursors = await engine.executeRaw<{ run_id: string; index: number | string | null }>(`SELECT completed_keys->0->>'runId' AS run_id, completed_keys->0->>'index' AS index
    FROM op_checkpoints WHERE op='managed-sync' AND COALESCE(completed_keys->0->>'done','false')<>'true' AND completed_keys->0->>'sourceId'=$1`, [sourceId]);
  for (const cursor of cursors) {
    const [manifest] = await engine.executeRaw<{ completed_keys: Array<{ path?: string; sourcePath?: string }> }>(
      "SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [cursor.run_id]);
    const named = (manifest?.completed_keys ?? []).slice(Number(cursor.index ?? 0)).find(entry => paths.has(entry.path ?? '') || paths.has(entry.sourcePath ?? ''));
    if (named) return named.path ?? named.sourcePath ?? null;
  }
  return null;
}

function item(repair: ApprovedRepair, selection: Selection, hash: string, index: number, last: boolean): FrontmatterItem {
  return { cursor: { phase: 1, id: index + 1 }, source_id: repair.source_id, slug: repair.slug, chars: repair.chars, action: `${repair.class}:${repair.path}`, repair, selection, hash, last };
}

function sameSelection(a: Selection, b: Selection): boolean {
  return digest(a) === digest(b);
}

export const frontmatterRepair: RepairHandler = {
  kind: 'frontmatter',
  outcomeItemsLimit: 1000,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const selection: Selection = { source_ids: scope.source_ids, include_ambiguous: opts?.includeAmbiguous === true, only: [...(opts?.only ?? [])].sort(), skip: [...(opts?.skip ?? [])].sort() };
    const preview = previewArgv(scope, selection, selection.include_ambiguous);
    if (opts?.apply) {
      if (!opts.expect) {
        throw opError('invalid_params', 'gbrain repair frontmatter --apply writes only the set a preview printed.',
          `Preview first: ${shellQuote(preview)} — show the user the per-file diffs, then run the apply command it prints (with --yes --expect <preview-hash>).`);
      }
      const approved = await loadApprovedSet<ApprovedSetItem>(engine, { command: 'frontmatter', hash: opts.expect, previewCommand: shellQuote(preview) });
      if (approved.items.some(entry => !sameSelection(entry.selection, selection))) throw previewChangedError(opts.expect, shellQuote(preview));
      for (const sourceId of new Set(approved.items.map(entry => entry.source_id))) {
        const named = await unfinishedSyncPath(engine, sourceId, new Set(approved.items.filter(entry => entry.source_id === sourceId).flatMap(entry => [entry.path, entry.source_path])));
        if (named) throw opError('sync_in_progress', `Source ${sourceId} has an unfinished managed sync that still names ${named}, so the repair wrote nothing.`,
          `Finish that sync first: gbrain sync --source ${sourceId} --no-pull — then preview the repair again (${shellQuote(preview)}) and approve its new hash.`,
          { fix: { argv: ['gbrain', 'sync', '--source', sourceId, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false,
            why: `Finishes source ${sourceId}'s unfinished sync cursor, which would otherwise race the repair of a file it still names.` } });
      }
      const items = approved.items.map(({ selection: chosen, ...repair }, index) => item(repair, chosen, opts.expect!, index, index === approved.items.length - 1));
      return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
    }
    const residuals: Record<string, number> = {};
    const warnings: string[] = [];
    const found = await scan(engine, scope, selection, residuals, warnings);
    for (const path of found.unknownOnly) warnings.push(`--only ${path}: no such Markdown file or hold in scope; check the source-relative path.`);
    const sources = await engine.executeRaw<{ id: string; incarnation: string }>('SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
    const approvedItems = found.prepared.map(entry => entry.approved);
    const hash = previewHash({ kind: 'frontmatter-v1', brain_id: scope.brain_id, sources, selection, items: approvedItems });
    if (approvedItems.length) await saveApprovedSet<ApprovedSetItem>(engine, { command: 'frontmatter', hash }, approvedItems.map(entry => ({ ...entry, selection })));
    const diffs: FileDiff[] = [
      ...found.prepared.map(entry => ({ source_id: entry.approved.source_id, path: entry.approved.path, class: entry.approved.class, fixes: entry.approved.fixes,
        diff: lineDiff(entry.approved.path, entry.original, entry.content), selected: true })),
      ...found.pending,
    ];
    const counts = { safe: approvedItems.filter(entry => entry.class === 'safe').length, interpretive: approvedItems.filter(entry => entry.class === 'interpretive').length,
      interpretive_pending: diffs.filter(entry => !entry.selected).length, needs_review: found.review.length };
    for (const review of found.review) residuals[`needs_review:${review.code}`] = (residuals[`needs_review:${review.code}`] ?? 0) + 1;
    if (counts.interpretive_pending) residuals.interpretive_pending = counts.interpretive_pending;
    const listing: RepairListing[] = [
      ...diffs.map(entry => ({ item: `${entry.source_id}:${entry.path}`, class: entry.selected ? entry.class : 'interpretive_pending', detail: entry.fixes.join('; ') })),
      ...found.review.map(entry => ({ item: `${entry.source_id}:${entry.path}`, class: 'needs_review', detail: `${entry.code}${entry.reason ? `/${entry.reason}` : ''}: ${entry.resolution}` })),
    ];
    const applyArgv = [...preview, '--apply', '--expect', hash, '--yes'];
    const next_actions: Action[] = [];
    if (approvedItems.length) next_actions.push({ argv: applyArgv, consent: ['destructive'], actor: 'agent', requires_exclusive: false, plan_hash: hash, preview_argv: preview,
      why: `Writes exactly the ${approvedItems.length} previewed file change(s) (${counts.safe} safe, ${counts.interpretive} interpretive) and imports them; a file that changed since this preview is skipped.`,
      user_message: `Repair the frontmatter of ${approvedItems.length} file(s) exactly as the preview showed? Each file is rewritten on disk (only the lines shown change) and imported again.`,
      verify: { argv: ['gbrain', 'sources', 'status', ...(scope.source_ids.length === 1 ? [scope.source_ids[0]!] : []), '--json'] } });
    if (!selection.include_ambiguous && counts.interpretive_pending) next_actions.push({ argv: previewArgv(scope, selection, true), consent: [], actor: 'agent', requires_exclusive: false,
      why: `${counts.interpretive_pending} file(s) need an interpretation (folded lines, duplicate keys, a #-leading title, a slug line, a re-import or a rename re-bind); this preview shows each exact proposal for approval and writes nothing.` });
    const details: FrontmatterPreviewDetails = { counts, samples: Object.fromEntries((['safe', 'interpretive'] as const).flatMap(cls => {
      const sample = diffs.find(entry => entry.class === cls && (entry.selected || cls === 'interpretive'));
      return sample ? [[cls, sample]] : [];
    })), diffs, needs_review: found.review, next_actions };
    return { items: approvedItems.map((repair, index) => item(repair, selection, hash, index, index === approvedItems.length - 1)), preview_hash: hash, residuals, listing,
      ...(warnings.length ? { warnings } : {}), details: details as unknown as Record<string, unknown> };
  },
  async apply(ctx, entry, opts): Promise<RepairItemOutcome> {
    const { repair, selection, hash, last } = entry as FrontmatterItem;
    try { return await applyRepair(ctx, repair, selection, opts?.embed === true); }
    finally { if (last) await clearApprovedSet(ctx.engine, { command: 'frontmatter', hash }); }
  },
  render(details, opts) {
    const d = details as unknown as FrontmatterPreviewDetails;
    const lines = [`  classes: safe=${d.counts.safe}, interpretive=${d.counts.interpretive}, interpretive (needs --include-ambiguous)=${d.counts.interpretive_pending}, needs_review=${d.counts.needs_review}`];
    const shown = opts.diff ? d.diffs : Object.values(d.samples);
    for (const diff of shown) lines.push(`  ${diff.selected ? diff.class : 'interpretive, not selected'}: ${diff.source_id}:${diff.path}`, ...diff.diff.split('\n').map(line => `    ${line}`));
    if (!opts.diff && d.diffs.length > shown.length) lines.push(`  (one sample diff per class; --diff or --json shows all ${d.diffs.length})`);
    for (const review of d.needs_review) lines.push(`  needs_review ${review.source_id}:${review.path} [${review.code}${review.reason ? `/${review.reason}` : ''}${review.line !== undefined ? ` line ${review.line}` : ''}]${review.flag ? ` (${review.flag})` : ''}: ${review.resolution}`);
    for (const action of d.next_actions) lines.push(`  next: ${shellQuote(action.argv!)}${action.consent.length ? ' (asks the user first: destructive)' : ''}`);
    return lines;
  },
};

async function rootFor(engine: BrainEngine, repair: ApprovedRepair): Promise<string> {
  if (repair.mode === 'managed') return (await managedRepairRoot(engine, repair.source_id)).root;
  const [row] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [repair.source_id]);
  const root = row?.local_path ?? (repair.source_id === 'default' ? await engine.getConfig('sync.repo_path') : null);
  if (!root) throw opError('source_changed', `Source ${repair.source_id} has no local checkout any more, so nothing was written.`, 'Preview the repair again on the host that holds the checkout.');
  return root;
}

/** Re-derives one approved change from the file as it is and applies it only when everything still matches. */
async function applyRepair(ctx: OperationContext, repair: ApprovedRepair, selection: Selection, embed: boolean): Promise<RepairItemOutcome> {
  const changed = (reason: string): RepairItemOutcome => ({ applied: false, outcome: 'changed_since_preview', reason, detail: { path: repair.path } });
  const root = await rootFor(ctx.engine, repair);
  const target = join(root, repair.path);
  if (!existsSync(target) || sha256(readFileSync(target)) !== repair.before) return changed(`${repair.path} changed on disk since the preview`);
  const src: SourceRoot = { sourceId: repair.source_id, incarnation: '', mode: repair.mode, root };
  const holds = (await readGitSourceHolds(ctx.engine, { sourceIds: [repair.source_id] }))[0]?.holds ?? [];
  const hold = holds.find(entry => entry.path === repair.path);
  const fileCtx: FileContext = { engine: ctx.engine, src, includeAmbiguous: selection.include_ambiguous, pages: await pagesByOrigin(ctx.engine, repair.source_id) };
  const analysis = await analyzeFile(fileCtx, repair.path, hold);
  if (!analysis?.proposal) return changed('the file no longer needs this change');
  const bound = await bindProposal(fileCtx, repair.path, hold, analysis.proposal, await repairScreenConfig(ctx.engine, repair.source_id));
  if (!('approved' in bound)) return { applied: false, outcome: 'needs_review', reason: bound.resolution, detail: { path: repair.path, code: bound.code } };
  const now = bound.approved;
  if (now.after !== repair.after || now.class !== repair.class || now.revision !== repair.revision || now.result_digest !== repair.result_digest || now.slug !== repair.slug) {
    return changed('the proposal or the page it publishes differs from the preview');
  }
  if (repair.mode === 'managed') {
    try {
      const outcome = await submitManagedFileRepair({ ...ctx, remote: false }, { sourceId: repair.source_id, requestId: await repairRequestId(ctx, 'frontmatter', repair, `${repair.before}:${repair.after}`),
        slug: repair.slug, path: repair.path, sourcePath: repair.source_path, content: bound.content, beforeHash: repair.before, resultDigest: repair.result_digest,
        ...(repair.revision ? { expected_revision: repair.revision } : {}), ...(repair.rename_from ? { renameFrom: repair.rename_from } : {}), noEmbed: !embed });
      const persistence = outcome.persistence as { git_state?: string } | undefined;
      return { applied: true, outcome: 'repaired', detail: { path: repair.path, written: repair.before !== repair.after, imported: outcome.status, hold_cleared: outcome.hold_cleared === true,
        committed: persistence?.git_state ?? 'not_requested' } };
    } catch (error) {
      if (error instanceof OperationError && ['changed_since_preview', 'revision_conflict', 'page_identity_changed'].includes(error.code)) return changed(error.message);
      // #6278: a sync that started since the preview and still names the file is refused at admission, not written.
      if (error instanceof OperationError && (error.code === 'source_changed' || error.code === 'sync_in_progress')) return { applied: false, outcome: 'refused', reason: error.message, detail: { path: repair.path } };
      throw error;
    }
  }
  confinedRepairTarget(root, repair.path, repair.source_id);
  let backup: string | undefined;
  if (repair.before !== repair.after) {
    backup = createFrontmatterBackup(target, { sourcePath: root, runId: makeFrontmatterBackupRunId() });
    writeFileSync(target, bound.content);
  }
  if (repair.rename_from) {
    const from = repair.rename_from;
    await maintenanceTransaction(ctx.engine, async tx => {
      if (await tx.updateSlug(from.slug, repair.slug, { sourceId: repair.source_id }) === 1) {
        await tx.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2 AND source_id=$3', [repair.source_path, from.pageId, repair.source_id]);
      }
    });
  }
  const imported = await importFromFile(ctx.engine, target, repair.source_path, { sourceId: repair.source_id, noEmbed: !embed });
  const ok = imported.status !== 'error' && !imported.refusal;
  const holdCleared = ok && await clearGitHold(ctx.engine, { sourceId: repair.source_id, incarnation: (await ctx.engine.executeRaw<{ incarnation: string }>(
    'SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [repair.source_id]))[0]!.incarnation, path: repair.path, observedAt: new Date().toISOString() });
  return { applied: ok, outcome: ok ? 'repaired' : 'import_refused', ...(ok ? {} : { reason: imported.error ?? 'the import refused the repaired file' }),
    detail: { path: repair.path, written: repair.before !== repair.after, ...(backup ? { backup } : {}), imported: imported.status, hold_cleared: holdCleared,
      committed: 'commit_step', commit_step: `git -C ${shellQuote([root])} add -- ${shellQuote([repair.path])} && git -C ${shellQuote([root])} commit -m ${shellQuote([`fix(frontmatter): repair ${repair.path}`])}` } };
}
