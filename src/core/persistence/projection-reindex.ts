import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { loadConfig } from '../config.ts';
import { readProjectionSnapshot, preparePageProjection, installPageProjection, installPageEmbeddings, retryProjectionConflict } from '../page-state/projections.ts';
import { PageRevisionConflictError } from '../page-state/types.ts';
import { embedBatchWithBackoff } from '../embed-retry.ts';
import { submissionAuthority } from './authority.ts';
import { currentVerifiedLocalWriter, registerLocalWriter } from './identity.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from './ownership.ts';
import { admitWrite } from './journal.ts';
import { waitForWrite, writeResponse } from './service.ts';
import { maintenancePublishWaitMs } from './maintenance-wait.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';

const pageFix = (sourceId: string, slug: string): Action => readFix(`Shows code page ${slug} in source ${sourceId} as stored now, with its revision, read-only.`,
  { argv: ['gbrain', 'get', '--source', sourceId, '--', slug] });
const previewFix = (sourceId: string): Action => readFix(`Previews which code pages of source ${sourceId} still need reindexing and the embedding cost, without changing anything.`,
  { argv: ['gbrain', 'reindex-code', '--source', sourceId, '--dry-run', '--json'] });

export async function prepareCodeReindex(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  if (row.authority.remote || row.intent?.kind !== 'code_projection_reindex') throw trustedCliRequired('Code reindex requires trusted local authority.');
  const prepared = await readProjectionSnapshot(engine, row.slug, row.source_id, { allowUnsealed: true });
  if (!prepared || prepared.pageKind !== 'code' || prepared.snapshot.revision !== row.intent.expected_revision
    || prepared.snapshot.sourceIncarnation !== row.source_incarnation || prepared.snapshot.page.id !== row.page_id) {
    throw opError('revision_conflict', 'The code projection changed after reindex admission.',
      `Code page ${row.slug} in source ${row.source_id} changed or was replaced after reindex request ${row.request_id} was admitted, so nothing was reindexed. Run gbrain reindex-code --source ${row.source_id} again; it reads the current revision.`,
      { fix: pageFix(row.source_id, row.slug) });
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
  if (!snapshot || snapshot.pageKind !== 'code') throw opError('source_changed', 'The selected code page is unavailable.',
    `${slug} in source ${sourceId} is no longer a code page (it was deleted, renamed or replaced after it was selected), so it was not reindexed. The preview in fix lists what still needs reindexing.`,
    { fix: previewFix(sourceId) });
  let result: { status: 'imported' | 'skipped'; chunks: number };
  if (await managedPersistenceEnabled(engine)) {
    const verified = currentVerifiedLocalWriter();
    if (verified?.remote) throw trustedCliRequired('Code reindex requires a local CLI writer.');
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
    const done = await waitForWrite(engine, row, loadConfig() ?? { engine: engine.kind }, maintenancePublishWaitMs());
    writeResponse(done);
    result = done.outcome as typeof result;
  } else if (!opts.force && snapshot.snapshot.page.text_projection_revision === snapshot.snapshot.revision) {
    result = { status: 'skipped', chunks: 0 };
  } else {
    // The loser of a race with another installer (the resident projection rebuild) re-reads and prepares again.
    let attempt = 0;
    result = await retryProjectionConflict(async () => {
      const prepared = attempt++ === 0 ? snapshot : await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true });
      if (!prepared || prepared.snapshot.revision !== snapshot.snapshot.revision || prepared.snapshot.page.id !== snapshot.snapshot.page.id
        || prepared.snapshot.sourceIncarnation !== snapshot.snapshot.sourceIncarnation) throw new PageRevisionConflictError(snapshot.snapshot.revision, prepared?.snapshot.revision ?? null);
      if (!opts.force && prepared.snapshot.page.text_projection_revision === prepared.snapshot.revision) return { status: 'skipped' as const, chunks: 0 };
      const projection = await preparePageProjection(prepared);
      await installPageProjection(engine, prepared, projection.chunks, { seal: true, preserveEmbeddings: true, code: projection.code });
      return { status: 'imported' as const, chunks: projection.chunks.length };
    });
  }
  if (!opts.noEmbed && result.status === 'imported') {
    const prepared = await readProjectionSnapshot(engine, slug, sourceId);
    if (!prepared) throw opError('revision_conflict', 'Code changed before embedding preparation.',
      `Code page ${slug} in source ${sourceId} changed after its text was reindexed, so no vectors were computed; the reindexed text is committed. Run gbrain reindex-code --source ${sourceId} again to embed the current revision.`,
      { fix: previewFix(sourceId) });
    const chunks = prepared.chunks.filter(c => c.embedding_is_null);
    if (chunks.length) {
      if (prepared.embeddingColumn.embeddingModel && prepared.embeddingColumn.embeddingModel !== prepared.embeddingModel) {
        throw opError('embedding_model_mismatch', 'The configured provider does not match the active embedding column. Text recovery is complete; configure the matching model before embedding.',
          `This brain's active embedding column holds ${prepared.embeddingColumn.embeddingModel} vectors, but the configured model is ${prepared.embeddingModel ?? 'unset'}, so code page ${slug} in source ${sourceId} was reindexed as text only. Check the embedding setup with the command in fix; choosing the model (or migrating the brain's embeddings) is the user's decision.`,
          { fix: readFix('Reports the brain\'s embedding provider, model, dimensions and active vector column, read-only.', { argv: ['gbrain', 'doctor', '--only', 'embeddings', '--json'] }) });
      }
      const vectors = await embedBatchWithBackoff(chunks.map(c => c.chunk_text));
      const installed = await installPageEmbeddings(engine, prepared, chunks.map((c, i) => ({
        chunk_index: c.chunk_index, chunk_text: c.chunk_text, chunk_source: c.chunk_source,
        model: prepared.embeddingModel ?? undefined, embedding: vectors[i] })));
      if (!installed) throw opError('revision_conflict', 'Code changed while embedding; text remains queued or searchable without new vectors.',
        `Code page ${slug} in source ${sourceId} changed while its vectors were computed, so they were discarded. Run gbrain reindex-code --source ${sourceId} again to embed the current revision.`,
        { fix: previewFix(sourceId) });
    }
  }
  return result;
}
