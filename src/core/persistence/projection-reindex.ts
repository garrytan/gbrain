import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { loadConfig } from '../config.ts';
import { readProjectionSnapshot, preparePageProjection, installPageProjection, installPageEmbeddings } from '../page-state/projections.ts';
import { embedBatchWithBackoff } from '../embed-retry.ts';
import { submissionAuthority } from './authority.ts';
import { currentVerifiedLocalWriter, registerLocalWriter } from './identity.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from './ownership.ts';
import { admitWrite } from './journal.ts';
import { waitForWrite, writeResponse } from './service.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';

export async function prepareCodeReindex(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  if (row.authority.remote || row.intent?.kind !== 'code_projection_reindex') throw new OperationError('permission_denied', 'Code reindex requires trusted local authority.');
  const prepared = await readProjectionSnapshot(engine, row.slug, row.source_id, { allowUnsealed: true });
  if (!prepared || prepared.pageKind !== 'code' || prepared.snapshot.revision !== row.intent.expected_revision
    || prepared.snapshot.sourceIncarnation !== row.source_incarnation || prepared.snapshot.page.id !== row.page_id) {
    throw new OperationError('revision_conflict', 'The code projection changed after reindex admission.');
  }
  const noop = row.intent.force !== true && prepared.snapshot.page.text_projection_revision === prepared.snapshot.revision;
  const projection = noop ? undefined : await preparePageProjection(prepared);
  return { observedRevision: prepared.snapshot.revision, noop, deferEmbedding: true, apply: async tx => {
    if (projection) await installPageProjection(tx, prepared, projection.chunks, { seal: true, preserveEmbeddings: true, code: projection.code });
    return { status: noop ? 'skipped' : 'imported', chunks: projection?.chunks.length ?? 0, noop };
  } };
}

export async function reindexCodeProjection(engine: BrainEngine, slug: string, sourceId: string,
  opts: { force?: boolean; noEmbed?: boolean } = {}): Promise<{ status: 'imported' | 'skipped'; chunks: number }> {
  const snapshot = await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true });
  if (!snapshot || snapshot.pageKind !== 'code') throw new OperationError('source_changed', 'The selected code page is unavailable.');
  let result: { status: 'imported' | 'skipped'; chunks: number };
  if (await managedPersistenceEnabled(engine)) {
    const verified = currentVerifiedLocalWriter();
    if (verified?.remote) throw new OperationError('permission_denied', 'Code reindex requires a local CLI writer.');
    if (!verified) await registerLocalWriter(engine, 'cli');
    const authority = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext,
      'submit_job', sourceId, snapshot.snapshot.sourceIncarnation, slug);
    const binding = await getWorktreeBinding(engine, sourceId);
    if (!binding) authority.databaseOnlyReason = 'no_repo_configured';
    const intent = { kind: 'code_projection_reindex', expected_revision: snapshot.snapshot.revision, force: opts.force === true };
    const row = await admitWrite(engine, { requestId: randomUUID(), operation: 'submit_job', sourceId,
      sourceIncarnation: snapshot.snapshot.sourceIncarnation, slug, pageId: snapshot.snapshot.page.id,
      principal: authority.principal, authority, callerIntent: intent, intent,
      worktreeId: binding?.worktree_id, topologyGeneration: binding?.topology_generation });
    const done = await waitForWrite(engine, row, loadConfig() ?? { engine: engine.kind }, 5000);
    writeResponse(done);
    result = done.outcome as typeof result;
  } else if (!opts.force && snapshot.snapshot.page.text_projection_revision === snapshot.snapshot.revision) {
    result = { status: 'skipped', chunks: 0 };
  } else {
    const projection = await preparePageProjection(snapshot);
    await installPageProjection(engine, snapshot, projection.chunks, { seal: true, preserveEmbeddings: true, code: projection.code });
    result = { status: 'imported', chunks: projection.chunks.length };
  }
  if (!opts.noEmbed && result.status === 'imported') {
    const prepared = await readProjectionSnapshot(engine, slug, sourceId);
    if (!prepared) throw new OperationError('revision_conflict', 'Code changed before embedding preparation.');
    const chunks = prepared.chunks.filter(c => c.embedding_is_null);
    if (chunks.length) {
      if (prepared.embeddingColumn.embeddingModel && prepared.embeddingColumn.embeddingModel !== prepared.embeddingModel) {
        throw new OperationError('embedding_model_mismatch', 'The configured provider does not match the active embedding column. Text recovery is complete; configure the matching model before embedding.');
      }
      const vectors = await embedBatchWithBackoff(chunks.map(c => c.chunk_text));
      const installed = await installPageEmbeddings(engine, prepared, chunks.map((c, i) => ({
        chunk_index: c.chunk_index, chunk_text: c.chunk_text, chunk_source: c.chunk_source,
        model: prepared.embeddingModel ?? undefined, embedding: vectors[i] })));
      if (!installed) throw new OperationError('revision_conflict', 'Code changed while embedding; text remains queued or searchable without new vectors.');
    }
  }
  return result;
}
