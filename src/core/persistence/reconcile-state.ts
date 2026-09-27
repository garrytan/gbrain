import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrainEngine } from '../engine.ts';
import { loadConfig, loadConfigWithEngine } from '../config.ts';
import { loadOperatorLiterals } from '../content-sanity-literals.ts';
import { parseMarkdown, resolveSourceLocalFilePath } from '../markdown.ts';
import { parseDataFrontmatter } from '../data-frontmatter.ts';
import { OperationError } from '../ops/contract.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { recordedPathFromFileUri } from '../write-through.ts';
import { localHostId } from './identity.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { digest, requireUuid, sha256, stableJson } from './digest.ts';
import { reconcileCanonical, strictReconcileKeys, validateReconcileJson, type ReconcileConflict, type ReconcileDecision } from './reconcile-merge.ts';
import type { ParsedPage } from '../import-file.ts';

export interface ReconcilePins {
  brain_id: string; source_id: string; source_incarnation: string; slug: string; page_id: number;
  worktree_id: string; binding_digest: string; owner_epoch: string; revision: string;
  raw_file_hash: string; relative_path: string; policy_digest: string; withdrawals_digest: string; assessment_at: string;
}
export interface ReconcileArtifact {
  format_version: 1; preview_id: string; preconditions: ReconcilePins;
  preimages: { file_base64: string; database: PageSnapshot; stored_page: Record<string, unknown> };
  decisions: ReconcileDecision[]; conflicts: ReconcileConflict[]; result: ParsedPage; result_digest: string;
  status: 'needs_resolution' | 'ready';
}
export interface ReconcileState {
  binding: WorktreeBinding; root: string; path: string; raw: Buffer; snapshot: PageSnapshot;
  storedPage: Record<string, unknown>; file: ParsedPage; pins: ReconcilePins;
}
export async function reconcilePolicyDigest(engine: BrainEngine, sourceId: string): Promise<string> {
  const config = await loadConfigWithEngine(engine, loadConfig());
  const [source] = await engine.executeRaw('SELECT config,contextual_retrieval_mode,trust_frontmatter_overrides FROM sources WHERE id=$1', [sourceId]);
  return digest({ version: 1, config, source, literals: loadOperatorLiterals(), disabled: process.env.GBRAIN_NO_SANITY ?? null });
}
export function staleReconcile(what: string): never {
  throw new OperationError('source_changed', `Reconciliation preview is stale: ${what}.`, 'Generate a fresh preview; submit a corrected intent with a new request ID.');
}
function recordedReconcilePath(root: string, page: { slug: string; source_path?: string | null; source_uri?: string | null }): string | null {
  const path = resolveSourceLocalFilePath(root, page.source_path, page.slug);
  if (path) return path;
  const recorded = recordedPathFromFileUri(page.source_uri, root);
  return recorded ? join(root, recorded) : null;
}
export async function readReconcileState(engine: BrainEngine, sourceId: string, slug: string, assessmentAt = new Date().toISOString()): Promise<ReconcileState> {
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!binding?.local_path || binding.owner_host_id !== localHostId() || binding.state !== 'active') {
    throw new OperationError('owner_unavailable', 'Reconciliation requires the existing active owner on this host.', 'Run repair on the current owner; repair never claims or activates a source.');
  }
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  if (!snapshot || snapshot.page.deleted_at) throw new OperationError('page_not_found', 'Reconciliation requires an existing live page; use the separate restore workflow for deleted pages.');
  if (binding.source_incarnation !== snapshot.sourceIncarnation) staleReconcile('source binding incarnation');
  const [storedPage] = await engine.executeRaw<Record<string, unknown>>(`SELECT id,source_id,slug,type,title,compiled_truth,timeline,frontmatter,
    content_hash,source_path,source_kind,source_uri,ingested_via,ingested_at,knowledge_revision,deleted_at FROM pages WHERE id=$1 AND source_id=$2`, [snapshot.page.id, sourceId]);
  const root = realpathSync(join(binding.local_path, binding.relative_path));
  const recorded = recordedPathFromFileUri(snapshot.page.source_uri, root);
  const path = recordedReconcilePath(root, snapshot.page);
  if (!path || !isWriteTargetContained(path, root)) throw new OperationError('source_changed', 'The page has no unambiguous confined recorded Markdown origin.');
  let size: number;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('not an ordinary file');
    size = info.size;
  } catch { throw new OperationError('source_changed', 'The recorded canonical file is missing or is not an ordinary file; repair does not restore files.'); }
  const { readJournalLimits } = await import('./limits.ts');
  const limits = await readJournalLimits(engine);
  if (size > Math.min(limits.principalIntentBytes, limits.brainIntentBytes, limits.worktreeRecoveryBytes)) {
    throw new OperationError('request_too_large', 'The canonical file exceeds reconciliation capacity.');
  }
  const fileName = basename(path), uriName = pathToFileURL(path).pathname.split('/').pop()!;
  const candidates = await engine.executeRaw<{ slug: string; source_path: string | null; source_uri: string | null }>(
    `SELECT slug,source_path,source_uri FROM pages WHERE source_id=$1 AND id<>$2 AND (
      regexp_replace(CASE WHEN $7::boolean THEN replace(btrim(source_path),chr(92),'/') ELSE btrim(source_path) END,'^.*/','')=$3
      OR source_uri LIKE 'file:%' AND (right(source_uri,length($4::text))=$4 OR right(source_uri,length($5::text))=$5)
      OR source_uri=$6) ORDER BY id LIMIT 101`,
    [sourceId, snapshot.page.id, fileName, `/${fileName}`, `/${uriName}`, recorded ? snapshot.page.source_uri : null, process.platform === 'win32']);
  if (candidates.length > 100) throw new OperationError('source_changed', 'Too many candidate page origins to verify this exact file safely.',
    'Review the recorded source paths before retrying this exact-page reconciliation.');
  const canonicalPath = realpathSync(path);
  for (const candidate of candidates) {
    const candidatePath = recordedReconcilePath(root, candidate);
    if (!candidatePath || !isWriteTargetContained(candidatePath, root)) continue;
    let canonicalCandidate: string;
    try { canonicalCandidate = realpathSync(candidatePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new OperationError('source_changed', 'A candidate canonical file origin could not be verified.');
    }
    if (canonicalCandidate === canonicalPath) throw new OperationError('source_changed', 'Several pages claim the recorded canonical file.');
  }
  const raw = readFileSync(path), text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) throw new OperationError('invalid_params', 'The canonical file must contain valid UTF-8.');
  try { parseDataFrontmatter(text); }
  catch { throw new OperationError('invalid_params', 'Canonical file metadata cannot be parsed losslessly; repair its syntax before previewing.'); }
  const parsed = parseMarkdown(text, slug, { validate: true, expectedSlug: slug });
  const errors = parsed.errors?.filter(e => !['MISSING_OPEN', 'MISSING_CLOSE', 'EMPTY_FRONTMATTER'].includes(e.code)) ?? [];
  if (errors.length || parsed.errors?.some(e => e.code === 'MISSING_CLOSE') || parsed.slug !== slug) {
    throw new OperationError('invalid_params', 'Canonical file metadata cannot be parsed losslessly; repair its syntax before previewing.');
  }
  const pins: ReconcilePins = { brain_id: brain.brain_id, source_id: sourceId, source_incarnation: snapshot.sourceIncarnation, slug,
    page_id: snapshot.page.id, worktree_id: binding.worktree_id, binding_digest: digest({ binding, root, path: canonicalPath }), owner_epoch: String(binding.owner_epoch),
    revision: snapshot.revision, raw_file_hash: sha256(raw), relative_path: relative(root, path),
    policy_digest: await reconcilePolicyDigest(engine, sourceId), withdrawals_digest: digest(snapshot.withdrawals), assessment_at: assessmentAt };
  return { binding, root, path, raw, snapshot, storedPage, file: reconcileCanonical(parsed, parsed.tags), pins };
}
export function assertReconcilePins(expected: ReconcilePins, actual: ReconcilePins): void {
  for (const key of Object.keys(expected) as Array<keyof ReconcilePins>) if (expected[key] !== actual[key]) staleReconcile(key);
}
export function validateReconcileArtifact(value: unknown): ReconcileArtifact {
  validateReconcileJson(value);
  strictReconcileKeys(value, ['format_version', 'preview_id', 'preconditions', 'preimages', 'decisions', 'conflicts', 'result', 'result_digest', 'status']);
  strictReconcileKeys(value.preconditions, ['brain_id', 'source_id', 'source_incarnation', 'slug', 'page_id', 'worktree_id', 'binding_digest',
    'owner_epoch', 'revision', 'raw_file_hash', 'relative_path', 'policy_digest', 'withdrawals_digest', 'assessment_at']);
  strictReconcileKeys(value.preimages, ['file_base64', 'database', 'stored_page']);
  strictReconcileKeys(value.preimages.database, ['page', 'tags', 'revision', 'sourceIncarnation', 'withdrawals']);
  strictReconcileKeys(value.preimages.database.page, ['id', 'slug', 'source_id', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter',
    'content_hash', 'source_path', 'knowledge_revision', 'text_projection_revision', 'emotional_weight', 'created_at', 'updated_at', 'updated_at_iso',
    'deleted_at', 'effective_date', 'effective_date_source', 'import_filename', 'salience_touched_at', 'source_kind', 'source_uri', 'ingested_via',
    'ingested_at', 'contextual_retrieval_mode', 'corpus_generation'], ['id', 'slug', 'source_id', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter']);
  strictReconcileKeys(value.preimages.stored_page, ['id', 'source_id', 'slug', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter',
    'content_hash', 'source_path', 'source_kind', 'source_uri', 'ingested_via', 'ingested_at', 'knowledge_revision', 'deleted_at']);
  strictReconcileKeys(value.result, ['type', 'title', 'compiled_truth', 'timeline', 'frontmatter', 'tags']);
  const result = value.result;
  if (value.format_version !== 1 || typeof value.preview_id !== 'string' || !['ready', 'needs_resolution'].includes(String(value.status)) ||
    !Array.isArray(value.conflicts) || !Array.isArray(value.decisions) || !Array.isArray(value.preimages.database.tags) ||
    !Array.isArray(value.preimages.database.withdrawals) || !Array.isArray(value.result.tags) || value.result.tags.some(v => typeof v !== 'string') ||
    ['type', 'title', 'compiled_truth', 'timeline'].some(key => typeof result[key] !== 'string') ||
    value.result.frontmatter === null || typeof value.result.frontmatter !== 'object' || Array.isArray(value.result.frontmatter) ||
    typeof value.preimages.file_base64 !== 'string' ||
    digest(value.result) !== value.result_digest || typeof value.preconditions.assessment_at !== 'string' ||
    !Number.isFinite(Date.parse(value.preconditions.assessment_at)) || !Number.isSafeInteger(value.preconditions.page_id) ||
    Object.entries(value.preconditions).some(([key, v]) => key !== 'page_id' && typeof v !== 'string')) {
    throw new OperationError('invalid_params', 'Malformed or modified reconciliation artifact.');
  }
  for (const key of ['brain_id', 'source_incarnation', 'worktree_id', 'revision']) requireUuid(value.preconditions[key] as string);
  requireUuid(value.preview_id as string);
  for (const key of ['binding_digest', 'raw_file_hash', 'policy_digest', 'withdrawals_digest']) {
    if (!/^[a-f0-9]{64}$/.test(value.preconditions[key] as string)) throw new OperationError('invalid_params', 'Invalid reconciliation fingerprint.');
  }
  for (const conflict of value.conflicts as unknown[]) strictReconcileKeys(conflict, ['path', 'file', 'database']);
  for (const withdrawal of value.preimages.database.withdrawals as unknown[]) strictReconcileKeys(withdrawal, ['visibility', 'fact_hash', 'withdrawn_at']);
  return JSON.parse(stableJson(value)) as ReconcileArtifact;
}
