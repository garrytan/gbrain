/**
 * A published put_page in a fresh source whose chunks have no vector and whose embedding effect is queued but not
 * due for an hour, so a test decides when (and whether) the effect runs. Call it under a GBRAIN_HOME the test owns.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { installPageProjection, readProjectionSnapshot } from '../../src/core/page-state/projections.ts';

export async function pendingEmbedPage(engine: BrainEngine, chunks: readonly string[], slug = 'page'): Promise<{ sourceId: string; effectId: string; pageId: number }> {
  await registerLocalWriter(engine, 'cli');
  const sourceId = `embed-pending-${randomUUID()}`;
  const [source] = await engine.executeRaw<{ incarnation: string }>('INSERT INTO sources(id,name) VALUES($1,$1) RETURNING incarnation', [sourceId]);
  const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId,
    logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', sourceId, source!.incarnation, slug);
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
    sourceIncarnation: source!.incarnation, slug, requestId: randomUUID(), callerIntent: { body: chunks.join(' ') }, intent: { body: chunks.join(' ') } });
  const row = (await claimNextWrite(engine, localHostId()))!;
  await publishMutation(engine, row, { observedRevision: null, apply: async tx => {
    await tx.putPage(slug, { type: 'note', title: 'Example', compiled_truth: chunks.join(' '), timeline: '', frontmatter: {} }, { sourceId }); return {};
  } }, localHostId());
  const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
  await installPageProjection(engine, prepared, chunks.map((chunk_text, chunk_index) => ({ chunk_index, chunk_source: 'compiled_truth' as const, chunk_text })), { seal: true });
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE request_id=$1::uuid", [row.id]);
  const [effect] = await engine.executeRaw<{ id: string }>("SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [row.id]);
  return { sourceId, effectId: effect!.id, pageId: prepared.snapshot.page.id };
}
