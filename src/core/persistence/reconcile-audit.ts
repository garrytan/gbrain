import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError, type OperationContext } from '../ops/contract.ts';
import { isValidSourceId } from '../source-id.ts';
import { validateSlug } from '../utils.ts';
import { resolveSourceLocalFilePath } from '../markdown.ts';
import { recordedPathFromFileUri, scannerSlugRootMode } from '../write-through.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { submissionAuthority } from './authority.ts';
import { currentVerifiedLocalWriter, existingLocalHostId, readLocalWriter, verifyLocalWriter } from './identity.ts';
import { getWorktreeBinding } from './ownership.ts';
import { prepareFileTarget } from './page-prepare.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import { readReconcileState } from './reconcile-state.ts';
import { reconcileCanonical } from './reconcile-merge.ts';
import { classifyDrift } from './reconcile-additive.ts';
import { isDatabaseOnlyPage, slugDerivedOrigin } from './unbound-pages.ts';

export interface ReconcileAuditReport extends Record<string, unknown> {
  source_id: string;
  inspected: number;
  drifted: number;
  errors: number;
  database_only: number;
  findings: Array<{ slug: string; reason: string; suggestion: string; classification?: string;
    drift_paths?: Array<{ path: string; class: string; reason: string }>; file_modified_after_database?: boolean }>;
  classified?: Record<string, number>;
  next_after: string | null;
  complete: boolean;
  snapshot_only: true;
}

export async function auditCanonicalSource(engine: BrainEngine, sourceId: string,
  options: { limit?: number; after?: string; classify?: boolean } = {}): Promise<ReconcileAuditReport> {
  const limit = options.limit ?? 25;
  if (!isValidSourceId(sourceId) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw opError('invalid_params', 'Audit requires an explicit source and a limit from 1 to 100.',
      'Pass one registered source ID and a limit from 1 to 100 (default 25); the command in fix lists source IDs.',
      { fix: readFix('Lists the registered sources and their IDs.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
  }
  if (options.after !== undefined) {
    if (typeof options.after !== 'string') throw opError('invalid_params', 'The audit cursor must be a page slug.',
      "Pass --after exactly as the previous audit's next_after slug, or omit it to start from the first page.");
    try { validateSlug(options.after); } catch {
      throw opError('invalid_params', 'The audit cursor must be a valid page slug.',
        "Pass --after exactly as the previous audit's next_after slug, or omit it to start from the first page.");
    }
  }
  const hostId = existingLocalHostId();
  const binding = hostId ? await getWorktreeBinding(engine, sourceId, hostId) : null;
  if (!binding?.local_path || binding.owner_host_id !== hostId || binding.state !== 'active') {
    throw opError('owner_unavailable', 'Read-only drift auditing must run on the active canonical owner.',
      `Run the audit of '${sourceId}' on the host that owns its checkout; the command in fix names it. Do not claim or transfer ownership just to audit.`,
      { fix: readFix('Shows the canonical binding and owner host of this source.', { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] }) });
  }
  const root = join(binding.local_path, binding.relative_path);
  const rows = await engine.executeRaw<{ slug: string; bytes: number; source_path: string | null; source_uri: string | null; database_only_reason: string | null }>(
    `SELECT slug, source_path, source_uri, database_only_reason,
    octet_length(compiled_truth)+octet_length(COALESCE(timeline,''))+octet_length(frontmatter::text) AS bytes
    FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND page_kind='markdown' AND slug>$2
    ORDER BY slug LIMIT $3`, [sourceId, options.after ?? '', limit + 1]);
  const report: ReconcileAuditReport = { source_id: sourceId, inspected: 0, drifted: 0, errors: 0, database_only: 0, findings: [],
    next_after: rows.length > limit ? rows[limit - 1].slug : null, complete: rows.length <= limit, snapshot_only: true,
    ...(options.classify ? { classified: { structurally_additive: 0, additive_with_suggestions: 0, review_required: 0, formatting_only: 0, error: 0 } } : {}) };
  const mode = await scannerSlugRootMode(engine, sourceId, root);
  for (const candidate of rows.slice(0, limit)) {
    report.inspected++;
    if (isDatabaseOnlyPage(candidate)) {
      const origin = slugDerivedOrigin(root, candidate.slug, mode);
      if (!origin || !existsSync(origin.path)) {
        report.database_only++;
        report.findings.push({ slug: candidate.slug, reason: 'database_only',
          suggestion: 'The page is database-only (written while the source had no canonical owner) and no file exists at its slug-derived path, so there is no file to reconcile; no action is needed.' });
        continue;
      }
    }
    try {
      if (Number(candidate.bytes) > 5_000_000) throw opError('invalid_params', 'The page exceeds the bounded audit size.',
        `Page ${candidate.slug} is over 5 MB in the database, so the audit skipped it; inspect it on the canonical host.`);
      const snapshot = await engine.readPageSnapshot(candidate.slug, { sourceId });
      if (!snapshot || snapshot.sourceIncarnation !== binding.source_incarnation) throw opError('page_identity_changed', 'The page identity changed during the audit.',
        `Page ${candidate.slug} was deleted or its source replaced while the audit ran; run the audit again from this slug.`);
      const capturedPath = recordedPathFromFileUri(snapshot.page.source_uri, root);
      const path = resolveSourceLocalFilePath(root, snapshot.page.source_path, candidate.slug, mode)
        ?? (capturedPath ? join(root, capturedPath) : join(root, `${candidate.slug}.md`));
      if (!isWriteTargetContained(path, root)) throw opError('source_changed', 'The canonical path is not confined.',
        `Page ${candidate.slug} records a file outside the source checkout; preview it with sources reconcile before any write.`);
      let size = 0;
      try {
        const stat = statSync(path);
        if (!stat.isFile()) throw opError('invalid_params', 'The canonical target is not a regular file.',
          `The file for page ${candidate.slug} is not a regular file; inspect it on the canonical host.`);
        size = stat.size;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (size > 5_000_000) throw opError('invalid_params', 'The file exceeds the bounded audit size.',
        `The file for page ${candidate.slug} is over 5 MB, so the audit skipped it; inspect it on the canonical host.`);
      await prepareFileTarget(engine, { source_id: sourceId, worktree_id: binding.worktree_id, slug: candidate.slug }, snapshot, null, hostId!);
    } catch (error) {
      const reason = error instanceof OperationError ? error.code : 'storage_error';
      if (reason === 'source_changed') report.drifted++;
      else report.errors++;
      const finding: ReconcileAuditReport['findings'][number] = { slug: candidate.slug, reason,
        suggestion: reason === 'source_changed'
          ? 'Preview this exact page with sources reconcile before attempting another write.'
          : 'Inspect this page on the canonical host; no repair was attempted.' };
      if (options.classify && reason === 'source_changed') Object.assign(finding, await classifyFinding(engine, sourceId, candidate.slug, report.classified!));
      report.findings.push(finding);
    }
  }
  return report;
}

/** #5974: read-only structural classification of one drifted page; reports paths and rule outcomes, never values. */
async function classifyFinding(engine: BrainEngine, sourceId: string, slug: string, counts: Record<string, number>) {
  try {
    const state = await readReconcileState(engine, sourceId, slug);
    const classification = classifyDrift(state.file, reconcileCanonical(state.snapshot.page, state.snapshot.tags));
    const verdict = classification.verdict === 'no_drift' ? 'formatting_only' : classification.verdict;
    counts[verdict]++;
    const updated = Date.parse(String(state.snapshot.page.updated_at ?? ''));
    const suggestion = verdict === 'formatting_only' ? `Only formatting differs. Preview with gbrain sources reconcile ${sourceId} ${slug} --brain <brain> --preview; the result is the database content.`
      : verdict === 'review_required' ? `Not structurally additive. Preview gbrain sources reconcile ${sourceId} ${slug} --brain <brain> --preview --out <new file> and ask the user before deciding the review paths.`
      : `Preview gbrain sources reconcile ${sourceId} ${slug} --brain <brain> --preview --auto-additive --out <new file>${verdict === 'additive_with_suggestions' ? ', read the inserted lines, then add --accept-suggested' : ''}; apply it with a new request ID.`;
    return { classification: verdict, suggestion, drift_paths: classification.paths.map(({ path, class: kind, reason }) => ({ path, class: kind, reason })),
      ...(Number.isFinite(updated) ? { file_modified_after_database: statSync(state.path).mtimeMs > updated } : {}) };
  } catch {
    counts.error++;
    return { classification: 'error' };
  }
}

export async function runReconcileAudit(engine: BrainEngine, params: Record<string, unknown>): Promise<ReconcileAuditReport> {
  if (Object.keys(params).some(key => !['source_id', 'limit', 'after', 'classify'].includes(key)) || !isValidSourceId(params.source_id)
    || params.classify !== undefined && typeof params.classify !== 'boolean') {
    throw opError('invalid_params', 'Audit accepts only source_id, limit, after, and classify.',
      'Pass a registered source_id, and optionally limit (1 to 100), after (the previous next_after slug) and classify (true or false), with no other fields.');
  }
  const writer = currentVerifiedLocalWriter() ?? await verifyLocalWriter(engine, await readLocalWriter(engine, 'cli'));
  if (writer.remote || writer.principal.kind !== 'local_cli' || writer.grant.slugPrefixes !== null) {
    throw trustedCliRequired('A whole-source audit requires the existing trusted CLI grant without a slug-prefix restriction.');
  }
  if (!writer.grant.sourceIds.includes('*') && !writer.grant.sourceIds.includes(params.source_id)) {
    throw opError('permission_denied', 'The current CLI grant excludes this source.',
      `The CLI writer registration does not cover source '${params.source_id}'. Review its grant with the command in fix; widening it is the user's decision.`,
      { fix: readFix('Shows the CLI writer registration and the sources it grants.', { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'] }) });
  }
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived', [params.source_id]);
  if (!source) throw opError('source_changed', 'The selected source is unavailable.',
    `Source '${params.source_id}' is missing or archived. Check it with the command in fix, and restore an archived source before auditing it.`,
    { fix: readFix('Lists registered sources, archived ones included.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
  await submissionAuthority({ engine, remote: false, sourceId: params.source_id } as OperationContext,
    'put_page', params.source_id, source.incarnation, '__reconciliation_audit__');
  const report = await auditCanonicalSource(engine, params.source_id, { limit: params.limit as number | undefined, after: params.after as string | undefined,
    classify: params.classify === true });
  await submissionAuthority({ engine, remote: false, sourceId: params.source_id } as OperationContext,
    'put_page', params.source_id, source.incarnation, '__reconciliation_audit__');
  return report;
}
