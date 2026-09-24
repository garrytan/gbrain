import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { importFromContent, type ParsedPage } from '../import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, restoreHiddenFactRows } from '../facts-fence.ts';
import { OperationError } from '../ops/contract.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { sameCanonicalImport } from '../page-state/import-guard.ts';
import { transferLegacyAtomPageState } from '../cycle/extract-atoms-page-state.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { authorizeStoredRequest } from './authority.ts';
import { prepareCanonicalProjections } from './canonical-projections.ts';
import { preserveProtectedTakes } from './protected-takes.ts';
import { digest, sha256 } from './digest.ts';
import { mergeReconcile, reconcileCanonical, type ReconcileDecision } from './reconcile-merge.ts';
import { stabilizeSafetyAssessments } from './reconcile-safety.ts';
import { assertReconcilePins, readReconcileState, staleReconcile, validateReconcileArtifact, type ReconcileState } from './reconcile-state.ts';
import { verifyReconcileBackup } from './reconcile-backup.ts';

function preservePrivateFacts(incoming: string, stored: string): string {
  const next = parseFactsFence(incoming), prior = parseFactsFence(stored);
  if (next.warnings.length || prior.warnings.length) throw new OperationError('invalid_params', 'Fact fences must parse losslessly before reconciliation.');
  for (const fact of prior.facts.filter(f => f.visibility !== 'world')) {
    if (next.facts.some(f => f.claim === fact.claim && (f.visibility !== fact.visibility || f.rowNum === fact.rowNum && digest(f) !== digest(fact)))) {
      throw new OperationError('permission_denied', 'Reconciliation cannot modify protected private facts; use the scoped fact workflow.');
    }
  }
  const merged = restoreHiddenFactRows(next, prior);
  return merged ? replaceOrInsertFactsFence(incoming, renderFactsTable(merged.merged)) : incoming;
}
export async function prepareReconcileResult(engine: BrainEngine, state: ReconcileState, decisions: ReconcileDecision[]) {
  const merged = mergeReconcile(state.file, reconcileCanonical(state.snapshot.page, state.snapshot.tags), decisions);
  if (merged.conflicts.length) return { ...merged, ready: undefined };
  const result = merged.result;
  for (const key of ['compiled_truth', 'timeline'] as const) {
    result[key] = preservePrivateFacts(preserveProtectedTakes(result[key], state.snapshot.page[key] ?? ''), state.snapshot.page[key] ?? '');
  }
  const content = serializePageToMarkdown({ ...state.snapshot.page, ...result }, result.tags);
  let ready: PreparedContentImport | undefined;
  const imported = await importFromContent(engine, state.pins.slug, content, {
    sourceId: state.pins.source_id, sourcePath: state.snapshot.page.source_path ?? undefined,
    filename: basename(state.path).replace(/\.mdx?$/i, ''), noEmbed: true, remote: false, allowEmptyOverwrite: true,
    prepareFrontmatter: page => stabilizeSafetyAssessments(page.frontmatter, state.snapshot.page.frontmatter, state.pins.assessment_at),
    prepare: async prepared => { ready = prepared; return prepared.result; },
  });
  if (!ready || ready.slug !== state.pins.slug) throw new OperationError('invalid_params', imported.error ?? 'Reconciliation cannot change page identity or deduplicate to another page.');
  if (ready.observedRevision !== state.snapshot.revision) staleReconcile('revision changed during policy assessment');
  const resolved = reconcileCanonical(ready.parsedPage, [...new Set([...state.snapshot.tags, ...ready.parsedPage.tags])]);
  const project = prepareCanonicalProjections(resolved, state.pins.slug, state.pins.source_id);
  return { ...merged, result: resolved, ready, project };
}

export async function prepareReconcileMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig): Promise<PreparedMutation> {
  if (row.operation !== 'put_page' || row.intent?.kind !== 'canonical_reconcile' || row.authority.remote !== false || row.authority.principal.kind !== 'local_cli') {
    throw new OperationError('permission_denied', 'Canonical reconciliation requires trusted local administration.');
  }
  await authorizeStoredRequest(engine, row);
  const artifact = validateReconcileArtifact(row.intent.preview);
  const reference = row.intent.backup_reference;
  if (typeof reference !== 'string') throw new OperationError('storage_error', 'Reconciliation has no retained preimages.');
  verifyReconcileBackup(reference, artifact);
  if (artifact.status !== 'ready' || artifact.preconditions.source_id !== row.source_id || artifact.preconditions.slug !== row.slug || artifact.preconditions.page_id !== row.page_id) {
    throw new OperationError('invalid_params', 'The reconciliation artifact does not name the accepted page.');
  }
  const state = await readReconcileState(engine, row.source_id, row.slug, artifact.preconditions.assessment_at);
  assertReconcilePins(artifact.preconditions, state.pins);
  const prepared = await prepareReconcileResult(engine, state, artifact.decisions);
  if (!prepared.ready || digest(prepared.result) !== artifact.result_digest) staleReconcile('canonical policy result changed');
  const content = serializePageToMarkdown({ ...state.snapshot.page, ...prepared.result }, prepared.result.tags);
  const ready = prepared.ready;
  return {
    observedRevision: state.snapshot.revision,
    file: { path: state.path, root: state.root, content, expectedBeforeHash: state.pins.raw_file_hash },
    noop: ready.noop && sha256(content) === state.pins.raw_file_hash,
    validate: async tx => {
      await authorizeStoredRequest(tx, row, true);
      assertReconcilePins(artifact.preconditions, (await readReconcileState(tx, row.source_id, row.slug, artifact.preconditions.assessment_at)).pins);
      verifyReconcileBackup(reference, artifact);
    },
    apply: async tx => {
      await ready.apply(tx);
      if (!ready.noop) { await prepared.project!(tx); await sealPageTextProjection(tx, row.slug, row.source_id); }
      const final = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id });
      const scanStateTransferred = final ? await transferLegacyAtomPageState(tx, state.snapshot, final) : false;
      const file = parseMarkdown(readFileSync(state.path, 'utf8'), row.slug);
      if (!sameCanonicalImport(final, prepared.result) || digest(reconcileCanonical(file, file.tags)) !== artifact.result_digest) {
        throw new OperationError('storage_error', 'Reconciliation canonical readback did not match the reviewed result.');
      }
      return { status: 'reconciled', source_id: row.source_id, slug: row.slug, backup_reference: reference,
        result_digest: artifact.result_digest, database_changed: !ready.noop, file_changed: sha256(content) !== state.pins.raw_file_hash,
        scan_state_transferred: scanStateTransferred };
    },
  };
}
