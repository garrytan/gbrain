import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrainEngine } from '../engine.ts';
import { loadConfig, loadConfigWithEngine } from '../config.ts';
import { loadOperatorLiterals } from '../content-sanity-literals.ts';
import { parseMarkdown, resolveSourceLocalFilePath } from '../markdown.ts';
import { parseDataFrontmatter } from '../data-frontmatter.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { recordedPathFromFileUri, scannerSlugRootMode } from '../write-through.ts';
import { localHostId } from './identity.ts';
import { isDatabaseOnlyPage, slugDerivedOrigin } from './unbound-pages.ts';
import { isUnboundSourcePage } from './unbound-source.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { digest, requireUuid, sha256, stableJson } from './digest.ts';
import { reconcileCanonical, strictReconcileKeys, validateReconcileJson, type ReconcileConflict, type ReconcileDecision } from './reconcile-merge.ts';
import type { ParsedPage } from '../import-file.ts';
import type { AutoDecision } from './reconcile-additive.ts';

export interface ReconcilePins {
  brain_id: string; source_id: string; source_incarnation: string; slug: string; page_id: number;
  worktree_id: string; binding_digest: string; owner_epoch: string; revision: string;
  raw_file_hash: string; relative_path: string; policy_digest: string; withdrawals_digest: string; assessment_at: string;
}
export interface ReconcileArtifact {
  /** 2 when the preview carries #5974 automatic decisions. */
  format_version: 1 | 2; preview_id: string; preconditions: ReconcilePins;
  preimages: { file_base64: string; database: PageSnapshot; stored_page: Record<string, unknown> };
  decisions: ReconcileDecision[]; conflicts: ReconcileConflict[]; result: ParsedPage; result_digest: string;
  status: 'needs_resolution' | 'ready';
  auto_decisions?: AutoDecision[];
}
export interface ReconcileState {
  binding: WorktreeBinding; root: string; path: string; raw: Buffer; snapshot: PageSnapshot;
  storedPage: Record<string, unknown>; file: ParsedPage; pins: ReconcilePins;
  /** `slug_derived`: a database-only page matched to the canonical file at its slug path. */
  origin: 'recorded' | 'slug_derived';
  /** The `source_path` apply records for a `slug_derived` origin. */
  originSourcePath: string | null;
}
/**
 * Cycle bookkeeping that `cycle.ts` stamps into `sources.config` after every
 * successful source cycle. It is not reconcile policy, so it stays out of the
 * policy digest: otherwise an autopilot cycle between preview and apply made
 * every reconcile preview stale.
 */
const CYCLE_STAMP_KEYS = ['last_source_cycle_at', 'last_full_cycle_at'];

export async function reconcilePolicyDigest(engine: BrainEngine, sourceId: string): Promise<string> {
  const config = await loadConfigWithEngine(engine, loadConfig());
  const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT config,contextual_retrieval_mode,trust_frontmatter_overrides FROM sources WHERE id=$1', [sourceId]);
  let sourceConfig = row?.config;
  if (typeof sourceConfig === 'string') {
    try { sourceConfig = JSON.parse(sourceConfig); } catch { /* digest the raw text */ }
  }
  if (sourceConfig && typeof sourceConfig === 'object' && !Array.isArray(sourceConfig)) {
    sourceConfig = Object.fromEntries(Object.entries(sourceConfig).filter(([key]) => !CYCLE_STAMP_KEYS.includes(key)));
  }
  const source = row ? { ...row, config: sourceConfig } : row;
  return digest({ version: 1, config, source, literals: loadOperatorLiterals(), disabled: process.env.GBRAIN_NO_SANITY ?? null });
}
export function staleReconcile(what: string): never {
  throw new OperationError('source_changed', `Reconciliation preview is stale: ${what}.`, 'Generate a fresh preview; submit a corrected intent with a new request ID.');
}
function recordedReconcilePath(root: string, page: { slug: string; source_path?: string | null; source_uri?: string | null },
  mode: 'git-root' | 'source-root'): string | null {
  const path = resolveSourceLocalFilePath(root, page.source_path, page.slug, mode);
  if (path) return path;
  const recorded = recordedPathFromFileUri(page.source_uri, root);
  return recorded ? join(root, recorded) : null;
}
/**
 * The paged census query of {@link assertSoleFileClaim}: $1 source, $2 the page itself, $3/$4 the id
 * window, $5 the file name, $6 its name after the last backslash (POSIX) or the name (Windows), $7 the
 * file-URI names. Exported so the Postgres plan test runs the exact text.
 */
export function fileClaimCandidatesSql(platform: NodeJS.Platform = process.platform): string {
  const pathMatch = platform === 'win32'
    ? `source_path IS NOT NULL AND regexp_replace(replace(btrim(source_path), chr(92), '/'), '^.*/', '')=$6`
    : `source_path IS NOT NULL AND regexp_replace(replace(btrim(source_path), chr(92), '/'), '^.*/', '')=$6 AND regexp_replace(btrim(source_path),'^.*/','')=$5`;
  return `SELECT id,slug,source_path,source_uri FROM pages WHERE source_id=$1 AND id<>$2 AND id>$3 AND id<=$4 AND (
    (${pathMatch}) OR (source_uri LIKE 'file:%' AND regexp_replace(source_uri, '^.*/', '')=ANY($7::text[])))
    ORDER BY id LIMIT 100`;
}
/**
 * Refuses when another page of the source records the reconciled file as its own.
 *
 * #6222/#6254: every page whose recorded path or file URI shares the file's
 * name is a candidate, and realpath decides each one. The census is paged
 * (100 rows per batch, keyset on id) below the source's highest page id read
 * once, so a common name like `2015-09.md` no longer refuses, and concurrent
 * imports cannot make it endless; preparation re-reads this state inside the
 * coordinated write. Both name predicates match the expression indexes of
 * migration v219 (`pages_source_path_name_idx`, `pages_file_uri_name_idx`):
 * the path index normalizes backslashes, so on POSIX the slash-only basename
 * is rechecked on the rows it finds.
 */
async function assertSoleFileClaim(engine: BrainEngine, target: { sourceId: string; slug: string; pageId: number; root: string;
  mode: 'git-root' | 'source-root'; path: string; canonicalPath: string; recordedUri: string | null }): Promise<void> {
  const { sourceId, slug, root, mode, canonicalPath } = target;
  const fileName = basename(target.path), uriName = pathToFileURL(target.path).pathname.split('/').pop()!;
  const indexedName = fileName.replace(/^.*\\/s, '');
  const uriNames = [...new Set([fileName, uriName, ...(target.recordedUri ? [target.recordedUri.replace(/^.*\//s, '')] : [])])];
  const [ceiling] = await engine.executeRaw<{ id: number | string | null }>('SELECT max(id) AS id FROM pages WHERE source_id=$1', [sourceId]);
  const maxId = Number(ceiling?.id ?? 0);
  for (let afterId = 0; ;) {
    const candidates = await engine.executeRaw<{ id: number | string; slug: string; source_path: string | null; source_uri: string | null }>(
      fileClaimCandidatesSql(),
      [sourceId, target.pageId, afterId, maxId, fileName, process.platform === 'win32' ? fileName : indexedName, uriNames]);
    for (const candidate of candidates) {
      const candidatePath = recordedReconcilePath(root, candidate, mode);
      if (!candidatePath || !isWriteTargetContained(candidatePath, root)) continue;
      let canonicalCandidate: string;
      try { canonicalCandidate = realpathSync(candidatePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw opError('source_changed', 'A candidate canonical file origin could not be verified.',
          `Nothing changed. Page ${candidate.slug} in '${sourceId}' records a file that could not be resolved; check that the source checkout is readable, then preview ${slug} again.`);
      }
      if (canonicalCandidate === canonicalPath) throw opError('source_changed', 'Several pages claim the recorded canonical file.',
        `Nothing changed. Pages ${slug} and ${candidate.slug} in '${sourceId}' both record the same file, so reconcile cannot tell which owns it; decide with the user which page owns the file before reconciling either.`);
    }
    if (candidates.length < 100) return;
    afterId = Number(candidates[candidates.length - 1]!.id);
  }
}
export async function readReconcileState(engine: BrainEngine, sourceId: string, slug: string, assessmentAt = new Date().toISOString()): Promise<ReconcileState> {
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!binding?.local_path || binding.owner_host_id !== localHostId() || binding.state !== 'active') {
    throw new OperationError('owner_unavailable', 'Reconciliation requires the existing active owner on this host.', 'Run repair on the current owner; repair never claims or activates a source.');
  }
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  if (!snapshot || snapshot.page.deleted_at) throw opError('page_not_found', 'Reconciliation requires an existing live page; use the separate restore workflow for deleted pages.',
    `Page ${slug} in '${sourceId}' is deleted or missing; nothing changed. If it was deleted by mistake, restore it (gbrain restore, within the 72-hour window) and then preview it again.`,
    { fix: readFix('Shows whether the page exists or is soft-deleted in this source.', { argv: ['gbrain', 'get', '--source', sourceId, '--include-deleted', '--', slug] }) });
  if (binding.source_incarnation !== snapshot.sourceIncarnation) staleReconcile('source binding incarnation');
  const [storedPage] = await engine.executeRaw<Record<string, unknown>>(`SELECT id,source_id,slug,type,title,compiled_truth,timeline,frontmatter,
    content_hash,source_path,source_kind,source_uri,ingested_via,ingested_at,knowledge_revision,deleted_at FROM pages WHERE id=$1 AND source_id=$2`, [snapshot.page.id, sourceId]);
  const root = realpathSync(join(binding.local_path, binding.relative_path));
  const recorded = recordedPathFromFileUri(snapshot.page.source_uri, root);
  const mode = await scannerSlugRootMode(engine, sourceId, root);
  const recordedPath = recordedReconcilePath(root, snapshot.page, mode);
  const derived = !recordedPath && isDatabaseOnlyPage({ ...snapshot.page,
    database_only_reason: await isUnboundSourcePage(engine, sourceId, slug) ? 'unbound_source' : null }) ? slugDerivedOrigin(root, slug, mode) : null;
  const origin = derived ? 'slug_derived' : 'recorded';
  const path = recordedPath ?? derived?.path ?? null;
  if (!path || !isWriteTargetContained(path, root)) throw opError('source_changed', 'The page has no unambiguous confined recorded Markdown origin.',
    `Page ${slug} in '${sourceId}' records no Markdown file inside the source checkout, so there is nothing to reconcile it against; nothing changed. Check its recorded source path with the command in fix.`,
    { fix: readFix('Shows the page and its recorded source path.', { argv: ['gbrain', 'get', '--source', sourceId, '--', slug] }) });
  let size: number;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('not an ordinary file');
    size = info.size;
  } catch {
    throw opError('source_changed', 'The recorded canonical file is missing or is not an ordinary file; repair does not restore files.',
      `Nothing changed. Restore the canonical file of ${slug} in '${sourceId}' as a regular file (for example from git), then preview the page again.`);
  }
  const { readJournalLimits } = await import('./limits.ts');
  const limits = await readJournalLimits(engine);
  if (size > Math.min(limits.principalIntentBytes, limits.brainIntentBytes, limits.worktreeRecoveryBytes)) {
    throw opError('request_too_large', 'The canonical file exceeds reconciliation capacity.',
      `Nothing changed. The canonical file of ${slug} in '${sourceId}' is larger than the journal's request and recovery limits; tell the user the page needs a manual edit of that file.`);
  }
  const canonicalPath = realpathSync(path);
  await assertSoleFileClaim(engine, { sourceId, slug, pageId: snapshot.page.id, root, mode, path, canonicalPath,
    recordedUri: recorded ? snapshot.page.source_uri ?? null : null });
  const raw = readFileSync(path), text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) throw opError('invalid_params', 'The canonical file must contain valid UTF-8.',
    `Nothing changed. Re-save the canonical file of ${slug} in '${sourceId}' as UTF-8, then preview the page again.`);
  try { parseDataFrontmatter(text); }
  catch {
    throw opError('invalid_params', 'Canonical file metadata cannot be parsed losslessly; repair its syntax before previewing.',
      `Nothing changed. Fix the frontmatter of the canonical file of ${slug} in '${sourceId}' (quote values containing ': ', close the --- block), then preview the page again.`);
  }
  // Preserve a terminal .md in the page key while parsing the canonical Markdown.
  const parsed = parseMarkdown(text, `${slug}.md`, { validate: true, expectedSlug: slug });
  const errors = parsed.errors?.filter(e => !['MISSING_OPEN', 'MISSING_CLOSE', 'EMPTY_FRONTMATTER'].includes(e.code)) ?? [];
  if (errors.length || parsed.errors?.some(e => e.code === 'MISSING_CLOSE') || parsed.slug !== slug) {
    throw opError('invalid_params', 'Canonical file metadata cannot be parsed losslessly; repair its syntax before previewing.',
      `Nothing changed. Fix the frontmatter of the canonical file of ${slug} in '${sourceId}' (close the --- block, keep its slug), then preview the page again.`);
  }
  const pins: ReconcilePins = { brain_id: brain.brain_id, source_id: sourceId, source_incarnation: snapshot.sourceIncarnation, slug,
    page_id: snapshot.page.id, worktree_id: binding.worktree_id, binding_digest: digest({ binding, root, path: canonicalPath }), owner_epoch: String(binding.owner_epoch),
    revision: snapshot.revision, raw_file_hash: sha256(raw), relative_path: relative(root, path),
    policy_digest: await reconcilePolicyDigest(engine, sourceId), withdrawals_digest: digest({ withdrawals: snapshot.withdrawals, global_purges: snapshot.globalPurges ?? null }), assessment_at: assessmentAt };
  return { binding, root, path, raw, snapshot, storedPage, file: reconcileCanonical(parsed, parsed.tags), pins, origin, originSourcePath: derived?.sourcePath ?? null };
}
export function assertReconcilePins(expected: ReconcilePins, actual: ReconcilePins): void {
  for (const key of Object.keys(expected) as Array<keyof ReconcilePins>) if (expected[key] !== actual[key]) staleReconcile(key);
}
export function validateReconcileArtifact(value: unknown): ReconcileArtifact {
  validateReconcileJson(value);
  const v2 = (value as Record<string, unknown> | null)?.format_version === 2;
  strictReconcileKeys(value, ['format_version', 'preview_id', 'preconditions', 'preimages', 'decisions', 'conflicts', 'result', 'result_digest', 'status',
    ...(v2 ? ['auto_decisions'] : [])], ['format_version', 'preview_id', 'preconditions', 'preimages', 'decisions', 'conflicts', 'result', 'result_digest', 'status',
    ...(v2 ? ['auto_decisions'] : [])]);
  if (v2) {
    if (!Array.isArray(value.auto_decisions) || !value.auto_decisions.length || value.auto_decisions.length > 1000) throw opError('invalid_params', 'Malformed automatic reconciliation decisions.',
      'Re-run the same reconcile preview with --auto-additive to recreate the file instead of editing it by hand.');
    for (const entry of value.auto_decisions as unknown[]) {
      strictReconcileKeys(entry, ['path', 'rule', 'rule_version', 'evidence_digest']);
      if (typeof entry.path !== 'string' || typeof entry.rule !== 'string' || !Number.isSafeInteger(entry.rule_version)
        || typeof entry.evidence_digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.evidence_digest)) {
        throw opError('invalid_params', 'Malformed automatic reconciliation decisions.',
      'Re-run the same reconcile preview with --auto-additive to recreate the file instead of editing it by hand.');
      }
    }
  }
  strictReconcileKeys(value.preconditions, ['brain_id', 'source_id', 'source_incarnation', 'slug', 'page_id', 'worktree_id', 'binding_digest',
    'owner_epoch', 'revision', 'raw_file_hash', 'relative_path', 'policy_digest', 'withdrawals_digest', 'assessment_at']);
  strictReconcileKeys(value.preimages, ['file_base64', 'database', 'stored_page']);
  // globalPurges is optional here so an artifact written before the '*' purge marker validates and then reads stale (assertPreimages).
  strictReconcileKeys(value.preimages.database, ['page', 'tags', 'revision', 'sourceIncarnation', 'withdrawals', 'globalPurges'],
    ['page', 'tags', 'revision', 'sourceIncarnation', 'withdrawals']);
  if (value.preimages.database.globalPurges !== undefined) strictReconcileKeys(value.preimages.database.globalPurges, ['count', 'latest', 'world_only']);
  strictReconcileKeys(value.preimages.database.page, ['id', 'slug', 'source_id', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter',
    'content_hash', 'source_path', 'knowledge_revision', 'text_projection_revision', 'emotional_weight', 'created_at', 'updated_at', 'updated_at_iso',
    'deleted_at', 'effective_date', 'effective_date_source', 'import_filename', 'salience_touched_at', 'source_kind', 'source_uri', 'ingested_via',
    'ingested_at', 'contextual_retrieval_mode', 'corpus_generation'], ['id', 'slug', 'source_id', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter']);
  strictReconcileKeys(value.preimages.stored_page, ['id', 'source_id', 'slug', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter',
    'content_hash', 'source_path', 'source_kind', 'source_uri', 'ingested_via', 'ingested_at', 'knowledge_revision', 'deleted_at']);
  strictReconcileKeys(value.result, ['type', 'title', 'compiled_truth', 'timeline', 'frontmatter', 'tags']);
  const result = value.result;
  if (value.format_version !== 1 && !v2 || typeof value.preview_id !== 'string' || !['ready', 'needs_resolution'].includes(String(value.status)) ||
    !Array.isArray(value.conflicts) || !Array.isArray(value.decisions) || !Array.isArray(value.preimages.database.tags) ||
    !Array.isArray(value.preimages.database.withdrawals) || !Array.isArray(value.result.tags) || value.result.tags.some(v => typeof v !== 'string') ||
    ['type', 'title', 'compiled_truth', 'timeline'].some(key => typeof result[key] !== 'string') ||
    value.result.frontmatter === null || typeof value.result.frontmatter !== 'object' || Array.isArray(value.result.frontmatter) ||
    typeof value.preimages.file_base64 !== 'string' ||
    digest(value.result) !== value.result_digest || typeof value.preconditions.assessment_at !== 'string' ||
    !Number.isFinite(Date.parse(value.preconditions.assessment_at)) || !Number.isSafeInteger(value.preconditions.page_id) ||
    Object.entries(value.preconditions).some(([key, v]) => key !== 'page_id' && typeof v !== 'string')) {
    throw opError('invalid_params', 'Malformed or modified reconciliation artifact.',
      'Pass the preview file exactly as reconcile wrote it with --out; change it only through --decisions. If it was edited, make a fresh preview.');
  }
  for (const key of ['brain_id', 'source_incarnation', 'worktree_id', 'revision']) requireUuid(value.preconditions[key] as string);
  requireUuid(value.preview_id as string);
  for (const key of ['binding_digest', 'raw_file_hash', 'policy_digest', 'withdrawals_digest']) {
    if (!/^[a-f0-9]{64}$/.test(value.preconditions[key] as string)) {
      throw opError('invalid_params', 'Invalid reconciliation fingerprint.',
        'Pass the preview file exactly as reconcile wrote it with --out; if it was edited, make a fresh preview.');
    }
  }
  for (const conflict of value.conflicts as unknown[]) strictReconcileKeys(conflict, ['path', 'file', 'database']);
  for (const withdrawal of value.preimages.database.withdrawals as unknown[]) strictReconcileKeys(withdrawal, ['visibility', 'fact_hash', 'withdrawn_at', 'purged'], ['visibility', 'fact_hash', 'withdrawn_at']);
  return JSON.parse(stableJson(value)) as ReconcileArtifact;
}
