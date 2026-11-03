/**
 * What a gbrain before GBRA-190 G4 left for a `forget`: the withdrawal committed database-first in the request's own
 * transaction (ledger row, expiries, chunk invalidation) with withdrawal-mirror, git and embedding effects queued to
 * strike and commit the page files afterwards (recordFactWithdrawal with `requestId`). A current forget publishes the
 * struck files first and queues no mirror; the effect only drains rows like these, so tests of that drain seed them here.
 */
import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { recordFactWithdrawal } from '../../src/core/facts/withdrawal.ts';
import { requestAttribution } from '../../src/core/persistence/attribution.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { admitWriteInTransaction, completeWrite } from '../../src/core/persistence/journal.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { initializeLocalPersistence, requestPrincipalForContext } from '../../src/core/persistence/page-mutations.ts';

export async function legacyForget(ctx: OperationContext, id: number): Promise<WriteRequest> {
  const sourceId = ctx.sourceId ?? 'default';
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  const [fact] = await ctx.engine.executeRaw<{ slug: string }>(
    "SELECT COALESCE(source_markdown_slug, entity_slug, 'memory/unattributed') AS slug FROM facts WHERE id=$1 AND source_id=$2", [id, sourceId]);
  if (!fact) throw new Error(`legacyForget: no fact #${id} in source ${sourceId}`);
  return ctx.engine.transaction(async tx => {
    const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    const authority = await submissionAuthority({ ...ctx, engine: tx }, 'forget', sourceId, source!.incarnation, fact.slug);
    const callerIntent = { id: String(id) };
    const row = await admitWriteInTransaction(tx, { principal, operation: 'forget', sourceId, sourceIncarnation: source!.incarnation,
      slug: fact.slug, requestId: randomUUID(), callerIntent, intent: { ...callerIntent, reason: null }, authority });
    return withCoordinatedWrite(tx, [sourceId], async () => {
      await recordFactWithdrawal(tx, id, sourceId, ctx.remote !== false, { requestId: row.id });
      return completeWrite(tx, row, 'committed', { id: String(id), expired: true, reason: null, protocol_version: 1, persistence: { mode: 'database' } });
    }, requestAttribution(row));
  });
}
