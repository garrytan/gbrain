/**
 * `gbrain repair file-drift --source <id> --held --side unknown|database|both --prefer file --whole-class`:
 * settle one whole class of held `file_drift` pages with one approval. A `--held` preview covers one window of 200 pages; a
 * large read-only mirror holds thousands, so approving it window by window was not practical.
 *
 * The preview walks every window of the source's held pages of the side (keyset reads in held-path order, one batched Git
 * read of the window's commit evidence), runs each page through the same live read, newer-side rule and reconcile preparation
 * as a window preview, and writes one manifest with the private artifact writer (`repair-previews/file-drift/class-<hash>.json`):
 * per page its slug, path, page revision, file blob (sha256 of the file's bytes), hold code, side, upstream version and the
 * lines the page holds that its file does not carry, plus the gbrain, file-drift and reconcile versions and the mirror flag.
 * A run that stops early (deadline, kill) leaves a partial manifest (`complete: false`) and prints its resume command; only a
 * complete manifest prints an apply command, and only it is saved for approval. Kept out of the class, each with its next step:
 *   - `kept_newer_page`: the page changed in gbrain after its file's last commit; it is never replaced in bulk.
 *   - `kept_protected_parts`: on a read-only mirror, letting the file win would append gbrain's protected parts to the file,
 *     and the checkout is never written, so the page stays held.
 *
 * The apply of a complete manifest (`--apply --expect <hash> --yes`) is not part of this change: the CLI refuses it for now.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { configDir } from '../config.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import { shellQuote } from '../agent-output.ts';
import { VERSION } from '../../version.ts';
import { digest, stableJson } from '../persistence/digest.ts';
import { previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { assertReconcileOutputPath } from '../persistence/reconcile-backup.ts';
import { authorizeReconcile } from '../persistence/reconcile.ts';
import { canonicalFilesystemPath } from '../persistence/root-registry.ts';
import { sourceMirrorReadOnly } from '../persistence/mirror-read-only.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { journalLimitKey, readJournalLimits } from '../persistence/limits.ts';
import { FILE_DRIFT_VERSION, fileDriftSide, GIT_HOLD_OP, type GitHoldRecord } from '../persistence/sync-holds.ts';
import type { ProgressReporter } from '../progress.ts';
import { fileCommitEvidenceBatch, heldLiveDrift, readDriftEvidence, type CommitEvidence } from './file-drift-compare.ts';
import { artifactDirectory, asLocalCli, HELD_WINDOW_PAGES, keptProtectedPartsDetail, prepareDriftPage, selectedByGlobs, writeArtifact } from './file-drift.ts';
import type { RepairScope } from './core.ts';

/** The window a whole-class walk and its apply step by; tests make it small. */
export const classWindow = { pages: HELD_WINDOW_PAGES };
export const CLASS_SIDES = ['unknown', 'database', 'both'] as const;
const CLASS_TOP = 50;
const RECONCILE_ARTIFACT_VERSION = 1;
const CURSOR_PREFIX = 'c1.';
const APPROVAL_PREFIX = 'class:';

export interface ClassSelection { sourceId: string; side: string; only: string[]; skip: string[] }
/** One page of the class: what its apply is bound to (never a timestamp) and the lines it drops. */
export interface ClassPin { slug: string; path: string; revision: string; file_blob: string; hold_code: string; side: string; upstream_version: string | null; lost_lines: number }
interface Kept { slug: string; path: string; next: string }
export interface ClassManifest { format_version: 1; kind: 'file-drift-class'; gbrain_version: string; file_drift_version: number; reconcile_version: number;
  mirror: boolean; brain_id: string; source_id: string; side: string; only: string[]; skip: string[]; complete: boolean; after: string | null; windows: number;
  pages: ClassPin[]; residual: { kept_newer_page: Kept[]; kept_protected_parts: Kept[] }; other: Record<string, number>; backup_bytes: number }
/** `details.class_manifest`: exactly the seven fields the output and `--json` carry. */
export interface ClassManifestSummary { path: string; hash: string; complete: boolean; pages: number; lost_lines_total: number;
  top: Array<{ slug: string; path: string; lost_lines: number }>; residual: { kept_newer_page: { count: number; next: string }; kept_protected_parts: { count: number; next: string } } }
export interface ClassPreviewResult { none: boolean; class_manifest?: ClassManifestSummary; other: Record<string, number>; resume_command?: string; apply_command?: string; card?: string[] }

const argvSelection = (sel: ClassSelection) => [...sel.only.flatMap(glob => ['--only', glob]), ...sel.skip.flatMap(glob => ['--skip', glob])];
export const classPreviewArgv = (sel: ClassSelection, cursor?: string) =>
  ['gbrain', 'repair', 'file-drift', '--source', sel.sourceId, '--held', '--side', sel.side, ...argvSelection(sel), '--prefer', 'file', '--whole-class', ...(cursor ? ['--cursor', cursor] : [])];
const classApplyArgv = (sel: ClassSelection, hash: string) => [...classPreviewArgv(sel), '--apply', '--expect', hash, '--yes'];
const compareArgv = (sel: ClassSelection) => ['gbrain', 'repair', 'file-drift', '--source', sel.sourceId, '--held', '--side', sel.side, ...argvSelection(sel), '--json'];
const manifestPath = (hash: string) => join(artifactDirectory(), `class-${hash}.json`);
/** The hash binds what the class is (its pins, residual and walk), never `backup_bytes`: that estimate moves when a background text projection lands. */
const manifestHash = ({ backup_bytes: _estimate, ...manifest }: ClassManifest) => previewHash({ kind: 'file-drift-class-v1', manifest });

/** The whole-class refusals of a selection the CLI parsed; nothing was read or written when one throws. */
export function assertWholeClassSelection(opts: { held?: boolean; side?: string; state?: string; provenance?: string; prefer?: string; slugs?: string[]; requests?: string[]; allDrifted?: boolean; sourceId?: string }): void {
  if (opts.slugs?.length || opts.requests?.length || opts.allDrifted) throw opError('invalid_params', '--whole-class settles the held pages of one side; it does not take --slug, --request or --all-drifted.',
    'Drop --slug, --request and --all-drifted, and select the class with --held --side unknown|database|both --prefer file --whole-class; a single page is previewed with --slug and no --whole-class.');
  if (!opts.held) throw opError('invalid_params', '--whole-class needs --held.', 'Select the class with --held --side unknown|database|both --prefer file --whole-class.');
  const source = opts.sourceId ?? '<source>';
  if (opts.prefer === 'database' || opts.side === 'deleted' || opts.state || opts.provenance) {
    throw opError('whole_class_prefer_unsupported', `--whole-class settles only --prefer file on side unknown, database or both${opts.side === 'deleted' ? '; deleted-side holds need a decision per state' : ''}.`,
      `Nothing was previewed. Preview this selection one window at a time instead: gbrain repair file-drift --source ${source} --held --side ${opts.side ?? '<side>'}${opts.state ? ` --state ${opts.state}` : ''}${opts.provenance ? ` --provenance ${opts.provenance}` : ''} --prefer ${opts.prefer ?? 'database'}`,
      { fix: readFix('Lists the held files of this source with their side and state, read-only.', { argv: ['gbrain', 'sources', 'status', source, '--json'] }) });
  }
  if (!opts.side || !(CLASS_SIDES as readonly string[]).includes(opts.side)) throw opError('invalid_params', '--whole-class needs --side unknown, database or both.',
    `Name the side: gbrain repair file-drift --source ${source} --held --side unknown --prefer file --whole-class (gbrain sources status ${source} --json lists each held file's side).`);
  if (opts.prefer !== 'file') throw opError('invalid_params', '--whole-class needs --prefer file.', `Add --prefer file: gbrain repair file-drift --source ${source} --held --side ${opts.side} --prefer file --whole-class`);
}

function readManifest(hash: string): ClassManifest | null {
  try {
    const path = manifestPath(hash);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as ClassManifest;
  } catch { return null; }
}


function removeManifest(hash: string | null | undefined): void {
  if (!hash) return;
  try { unlinkSync(manifestPath(hash)); } catch { /* already gone */ }
}

function summary(manifest: ClassManifest, hash: string, path: string): ClassManifestSummary {
  const sel = { sourceId: manifest.source_id, side: manifest.side, only: manifest.only, skip: manifest.skip };
  return { path, hash, complete: manifest.complete, pages: manifest.pages.length, lost_lines_total: manifest.pages.reduce((sum, page) => sum + page.lost_lines, 0),
    top: [...manifest.pages].sort((a, b) => b.lost_lines - a.lost_lines || (a.slug < b.slug ? -1 : 1)).slice(0, CLASS_TOP).map(({ slug, path: file, lost_lines }) => ({ slug, path: file, lost_lines })),
    residual: { kept_newer_page: { count: manifest.residual.kept_newer_page.length, next: shellQuote(compareArgv(sel)) },
      kept_protected_parts: { count: manifest.residual.kept_protected_parts.length, next: shellQuote(compareArgv(sel)) } } };
}

/** The data-loss gate card of a complete manifest: what the apply replaces, how much, and how it comes back. */
export function classCard(manifest: ClassManifest, s: ClassManifestSummary, applyCommand: string): string[] {
  const largest = s.top[0];
  return ['DATA CHANGE: confirmation required',
    `What: replace ${s.pages} held page(s) of source ${manifest.source_id} (held file drift, side ${manifest.side}) with their upstream files${manifest.mirror ? ', database-only: this read-only mirror\'s checkout is never written' : ''}`,
    `Count: ${s.pages} page(s); kept held: ${s.residual.kept_newer_page.count} edited in gbrain after their file (kept_newer_page), ${s.residual.kept_protected_parts.count} needing protected parts in the file (kept_protected_parts)`,
    `Lost lines: ${s.lost_lines_total} line(s) the replaced pages hold and their files do not carry${largest ? ` (most: ${largest.slug}, ${largest.lost_lines})` : ''}; details.class_manifest.top lists the 50 largest`,
    'Recoverable:',
    '  - each replaced page is saved as a page version first: gbrain history <slug> lists it and gbrain revert <slug> <version_id> restores it',
    '  - reconcile keeps a private backup of each replaced copy under the gbrain config directory (reconciliation-previews)',
    'What would be lost: a large page\'s older versions are pruned on their own policy; once its version is pruned, the replaced text survives only in the private backup.',
    `Proceed only after the user says yes: ${applyCommand}`];
}

function backupDirectoryUse(): { bytes: number; count: number } {
  const directory = join(canonicalFilesystemPath(configDir()), 'reconciliation-previews');
  let bytes = 0, count = 0;
  if (!existsSync(directory)) return { bytes, count };
  for (const name of readdirSync(directory)) {
    if (name === '.capacity.lock') continue;
    try { const stat = lstatSync(join(directory, name)); if (stat.isFile()) { bytes += stat.size; count++; } } catch { /* removed meanwhile */ }
  }
  return { bytes, count };
}

/** H1: the reconcile backups the apply would retain must fit the brain's recovery-bytes limit; nothing is written otherwise. */
async function assertClassCapacity(engine: BrainEngine, needed: number, pages: number): Promise<void> {
  const limits = await readJournalLimits(engine);
  const existing = backupDirectoryUse();
  const key = journalLimitKey('brainRecoveryBytes');
  if (existing.bytes + needed <= limits.brainRecoveryBytes && existing.count + pages <= limits.brainLifetimeIds) return;
  const countOver = existing.count + pages > limits.brainLifetimeIds;
  throw opError('class_capacity_exceeded', `The whole-class apply would retain ${existing.bytes + needed} bytes of reconcile backups (${needed} for this class, ${existing.bytes} already retained), over the limit of ${limits.brainRecoveryBytes} bytes (${key})${countOver ? `, or more than ${limits.brainLifetimeIds} retained backups` : ''}.`,
    `Nothing was written. Raising ${key} is the user's call (gbrain config set ${key} <bytes>); or settle a smaller class with --only / --skip.`,
    { fix: readFix(`Shows the recovery-bytes limit in effect (${key}), read-only.`, { argv: ['gbrain', 'config', 'get', key] }) });
}

/**
 * The whole-class preview: every window of the selected held pages, one manifest. Trusted local CLI only. Returns `none` when
 * the source holds no `file_drift` page (a repo-less brain never does).
 */
export async function previewFileDriftClass(engine: BrainEngine, scope: RepairScope, sel: ClassSelection,
  opts: { remote?: boolean; cursor?: string; deadline?: number; progress?: ProgressReporter } = {}): Promise<ClassPreviewResult> {
  if (opts.remote !== false) throw trustedCliRequired('gbrain repair file-drift --whole-class runs only for the trusted local CLI on the brain host.');
  assertWholeClassSelection({ held: true, side: sel.side, prefer: 'file', sourceId: sel.sourceId });
  const resumed = opts.cursor ? resumeManifest(scope, sel, opts.cursor) : null;
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sel.sourceId]);
  const [held] = source ? await engine.executeRaw<{ n: number | string }>(`SELECT count(*) AS n FROM op_checkpoints h
    WHERE h.op=$1 AND h.completed_keys->0->>'source_id'=$2 AND h.completed_keys->0->>'incarnation'=$3 AND h.completed_keys->0->>'code'='file_drift'`, [GIT_HOLD_OP, sel.sourceId, source.incarnation]) : [];
  if (!resumed && Number(held?.n ?? 0) === 0) return { none: true, other: {} };
  await assertReconcileOutputPath(engine, sel.sourceId, artifactDirectory());
  const mirror = await sourceMirrorReadOnly(engine, sel.sourceId);
  const manifest: ClassManifest = resumed?.manifest ?? { format_version: 1, kind: 'file-drift-class', gbrain_version: VERSION, file_drift_version: FILE_DRIFT_VERSION,
    reconcile_version: RECONCILE_ARTIFACT_VERSION, mirror, brain_id: scope.brain_id, source_id: sel.sourceId, side: sel.side, only: sel.only, skip: sel.skip,
    complete: false, after: null, windows: 0, pages: [], residual: { kept_newer_page: [], kept_protected_parts: [] }, other: {}, backup_bytes: 0 };
  const count = (key: string) => { manifest.other[key] = (manifest.other[key] ?? 0) + 1; };
  const binding = await getWorktreeBinding(engine, sel.sourceId);
  const root = binding?.local_path ? join(binding.local_path, binding.relative_path) : null;
  let partial: string | null = resumed?.hash ?? null;
  const written: string[] = [];
  const assessmentAt = new Date().toISOString();
  const startWindows = manifest.windows;
  await asLocalCli(engine, async () => {
    for (;;) {
      if (manifest.windows > startWindows && opts.deadline !== undefined && Date.now() >= opts.deadline) break;
      const rows = await engine.executeRaw<{ record: GitHoldRecord }>(`SELECT h.completed_keys->0 AS record FROM op_checkpoints h
        WHERE h.op=$1 AND h.completed_keys->0->>'source_id'=$2 AND h.completed_keys->0->>'incarnation'=$3 AND h.completed_keys->0->>'code'='file_drift'
          AND ($4::text IS NULL OR (h.completed_keys->0->>'path') COLLATE "C" > $4::text)
        ORDER BY (h.completed_keys->0->>'path') COLLATE "C" LIMIT $5`, [GIT_HOLD_OP, sel.sourceId, source!.incarnation, manifest.after, classWindow.pages]);
      if (!rows.length) { manifest.complete = true; break; }
      const targets = rows.map(row => row.record).filter(hold => fileDriftSide(hold.meta) === sel.side && selectedByGlobs(hold.path, sel));
      const evidence = root ? fileCommitEvidenceBatch(root, targets.map(hold => hold.path)) : new Map<string, CommitEvidence>();
      opts.progress?.start('repair.file_drift.whole_class', targets.length);
      for (const hold of targets) {
        opts.progress?.tick(1, hold.slug ?? hold.path);
        const kept = await classifyPage(engine, sel, hold, mirror, assessmentAt, path => evidence.get(path));
        if ('pin' in kept) { manifest.pages.push(kept.pin); manifest.backup_bytes += kept.bytes; }
        else if (kept.kept === 'kept_newer_page' || kept.kept === 'kept_protected_parts') manifest.residual[kept.kept].push({ slug: kept.slug, path: hold.path, next: kept.next });
        else count(kept.kept);
      }
      opts.progress?.finish();
      manifest.after = rows[rows.length - 1]!.record.path;
      manifest.windows++;
      try { await assertClassCapacity(engine, manifest.backup_bytes, manifest.pages.length); }
      catch (error) { for (const hash of written) removeManifest(hash); throw error; }
      if (rows.length < classWindow.pages) { manifest.complete = true; break; }
      const next = manifestHash(manifest);
      writeArtifact(`class-${next}`, manifest);
      written.push(next);
      if (partial && partial !== next) removeManifest(partial);
      partial = next;
      process.stderr.write(`[repair] whole-class preview: ${manifest.windows} window(s) read, ${manifest.pages.length} page(s) in the class; to resume after a stop: ${shellQuote(classPreviewArgv(sel, CURSOR_PREFIX + next))}\n`);
    }
  });
  const hash = manifestHash(manifest);
  const path = writeArtifact(`class-${hash}`, manifest);
  if (partial && partial !== hash) removeManifest(partial);
  const s = summary(manifest, hash, path);
  if (!manifest.complete) return { none: false, class_manifest: s, other: manifest.other, resume_command: shellQuote(classPreviewArgv(sel, CURSOR_PREFIX + hash)) };
  await saveApprovedSet(engine, { command: 'file-drift', hash: APPROVAL_PREFIX + hash }, manifest.pages);
  const applyCommand = shellQuote(classApplyArgv(sel, hash));
  return { none: false, class_manifest: s, other: manifest.other, apply_command: applyCommand, card: classCard(manifest, s, applyCommand) };
}

function resumeManifest(scope: RepairScope, sel: ClassSelection, cursor: string): { manifest: ClassManifest; hash: string } {
  const hash = cursor.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length) : '';
  const manifest = /^[0-9a-f]{64}$/.test(hash) ? readManifest(hash) : null;
  if (!manifest || manifest.complete || manifestHash(manifest) !== hash || manifest.brain_id !== scope.brain_id || manifest.source_id !== sel.sourceId || manifest.side !== sel.side
    || digest([manifest.only, manifest.skip]) !== digest([sel.only, sel.skip])) {
    throw opError('invalid_params', `--cursor ${cursor} is not the resume cursor of a partial whole-class preview of this selection.`,
      `Nothing was previewed. Start the preview again without --cursor: ${shellQuote(classPreviewArgv(sel))}`);
  }
  return { manifest, hash };
}

type Classified = { pin: ClassPin; bytes: number } | { kept: string; slug: string; next: string };

/** One held page through the live read, the newer-side rule and the reconcile preparation, as the window preview reads it. */
async function classifyPage(engine: BrainEngine, sel: ClassSelection, hold: GitHoldRecord, mirror: boolean, assessmentAt: string,
  commit: (path: string) => CommitEvidence | undefined): Promise<Classified> {
  const slug = hold.slug;
  if (slug === null) return { kept: 'no_page', slug: hold.path, next: '' };
  try {
    await authorizeReconcile(engine, sel.sourceId, slug);
    const live = await heldLiveDrift(engine, sel.sourceId, slug, { hold, mirror });
    if (live.reason === 'canonical_file_missing') return { kept: 'side_changed', slug, next: '' };
    if (live.still_present !== true) return { kept: live.reason === 'agrees' ? 'release_hold' : live.still_present === false ? 'no_drift' : `unknown_${live.reason}`, slug, next: '' };
    const evidence = await readDriftEvidence(engine, sel.sourceId, slug, assessmentAt, commit);
    if (evidence.newer === 'database' && evidence.differs !== 'none') {
      return { kept: 'kept_newer_page', slug, next: `page ${slug} changed after ${evidence.path} was last committed; preview it alone: gbrain repair file-drift --source ${sel.sourceId} --slug ${slug} --prefer file (or --prefer database)` };
    }
    const page = await prepareDriftPage(engine, sel.sourceId, slug, 'file', assessmentAt);
    if (mirror && page.file_appended) return { kept: 'kept_protected_parts', slug, next: keptProtectedPartsDetail(sel.sourceId, slug) };
    if (page.discards) return { kept: 'kept_newer_file', slug, next: '' };
    return { pin: { slug, path: hold.path, revision: page.preview.preconditions.revision, file_blob: page.preview.preconditions.raw_file_hash, hold_code: hold.code,
      side: fileDriftSide(hold.meta) ?? '', upstream_version: hold.upstream_version ?? null, lost_lines: page.lost_lines }, bytes: Buffer.byteLength(stableJson(page.preview)) + 1024 };
  } catch (error) {
    if (!(error instanceof OperationError) || ['owner_unavailable', 'writer_registration_required'].includes(error.code)) throw error;
    return { kept: `refused_${error.code}`, slug, next: '' };
  }
}
