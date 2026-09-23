import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { managedAtomSession, publishManagedAtoms, readAtomOrigin, resumeManagedAtoms, type AtomIntent } from './atom-maintenance.ts';
import { digest } from './digest.ts';
import { isWriteReceipt } from './types.ts';

export async function retryManagedAtomBatch(engine: BrainEngine, sourceId: string, requestId: string, retryId: string): Promise<Record<string, unknown>> {
  const { withRefreshingLock } = await import('../db-lock.ts');
  const { cycleLockIdFor } = await import('../cycle.ts');
  return withRefreshingLock(engine, cycleLockIdFor(sourceId), async () => {
    const session = await managedAtomSession(engine, sourceId, { requestId, retryId });
    if (!session?.retry) throw new OperationError('invalid_params', 'Explicit atom retry requires a managed source.');
    const retry = session.retry;
    const origin = retry.origin;
    const item = origin.kind === 'page'
      ? { kind: 'page' as const, slug: origin.locator, content: (await engine.readPageSnapshot(origin.locator, { sourceId }))?.page.compiled_truth ?? '', contentHash: origin.contentHash }
      : { kind: 'transcript' as const, filePath: origin.locator, content: readFileSync(origin.locator, 'utf8'), contentHash: origin.contentHash };
    const current = await readAtomOrigin(engine, session, item);
    if (digest(current) !== digest(origin)) throw new OperationError('source_changed', 'The original atom input changed; this retry cannot reuse it.');
    if (await resumeManagedAtoms(engine, session, current)) return { status: 'completed', replayed: true, model_rerun: false };
    const checkpoint = retry.expectedCheckpoint as Array<{ failure?: string }> | null;
    if (checkpoint && !checkpoint[0]?.failure) return { status: 'completed', replayed: true, model_rerun: false };
    const saved = retry.rows.filter(row => row.intent?.kind === 'managed_atom_page');
    if (saved.length) {
      const atoms: Parameters<typeof publishManagedAtoms>[3] = [];
      for (const row of saved) {
        const p = row.intent as AtomIntent;
        const target = await engine.readPageSnapshot(row.slug, { sourceId, includeDeleted: true });
        const revision = row.state === 'committed' ? row.outcome?.revision : p.expected_revision ?? null;
        if (typeof revision !== 'string' && (row.state === 'committed' || revision !== null)) throw new OperationError('storage_error', 'The retained atom publication revision is unavailable.');
        const pageId = row.state === 'committed' ? row.page_id ?? target?.page.id ?? null : row.page_id;
        if ((target?.page.id ?? null) !== pageId || (target?.revision ?? null) !== revision) {
          throw new OperationError('page_identity_changed', 'An atom target changed independently of the failed publication.');
        }
        if (typeof p.content !== 'string') throw new OperationError('storage_error', 'The retained atom publication content is unavailable.');
        atoms.push({ slug: row.slug, content: p.content, links: p.links ?? [], expectedTarget: { pageId, revision } });
      }
      const receipts = await publishManagedAtoms(engine, session, current, atoms);
      return { status: 'completed', model_rerun: false, write_requests: receipts };
    }
    if (!retry.rows.some(row => row.outcome?.failure)) throw new OperationError('invalid_params', 'This failed batch has no malformed extraction to retry.');
    const { runPhaseExtractAtoms } = await import('../cycle/extract-atoms.ts');
    const result = await runPhaseExtractAtoms(engine, { sourceId, _managedRetry: { requestId, retryId },
      _pages: item.kind === 'page' ? [item] : [], _transcripts: item.kind === 'transcript' ? [item] : [] });
    if (result.status !== 'ok') {
      const receipts = Array.isArray(result.details?.write_requests) ? result.details.write_requests.filter(isWriteReceipt) : [];
      const receipt = receipts.at(-1);
      const pending = receipt && ['queued', 'running', 'recovering'].includes(receipt.state);
      const error = new OperationError(pending ? 'write_pending' : 'extraction_failed', 'The explicit atom retry did not complete; inspect its retained receipt before approving another attempt.');
      if (receipt) error.writeRequest = receipt;
      throw error;
    }
    return { ...result, model_rerun: true };
  }, { ttlMinutes: 5 });
}
