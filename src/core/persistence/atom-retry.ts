import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { atomRetryInputKey, managedAtomSession, publishManagedAtoms, readAtomOrigin, resumeManagedAtoms, type AtomIntent, type ManagedAtomRetirement } from './atom-maintenance.ts';
import { isWriteReceipt } from './types.ts';

const receiptFix = (requestId: string): Action => readFix('Reads the atom request\'s durable receipt: its state, outcome and error, read-only.',
  { argv: ['gbrain', 'write-request', '--', requestId] });
const drainFix = (sourceId: string): Action => ({
  argv: ['gbrain', 'dream', '--drain', '--source', sourceId, '--json'], consent: ['paid'], actor: 'agent', requires_exclusive: false,
  why: `Re-reads source ${sourceId}'s current content and extracts its atom backlog under a new run; extraction calls the configured LLM.`,
});
const pageFix = (sourceId: string, slug: string): Action => readFix(`Shows which page holds ${slug} in source ${sourceId} now, with its revision, read-only.`,
  { argv: ['gbrain', 'get', '--source', sourceId, '--', slug] });

export async function retryManagedAtomBatch(engine: BrainEngine, sourceId: string, requestId: string, retryId: string): Promise<Record<string, unknown>> {
  const { withRefreshingLock } = await import('../db-lock.ts');
  const { cycleLockIdFor } = await import('../cycle.ts');
  return withRefreshingLock(engine, cycleLockIdFor(sourceId), async () => {
    const session = await managedAtomSession(engine, sourceId, { requestId, retryId });
    if (!session?.retry) throw opError('invalid_params', 'Explicit atom retry requires a managed source.',
      `Source ${sourceId} is not under managed persistence, so retained atom batch ${requestId} cannot be retried there; nothing was started. Run the ordinary atom drain for the source instead (it calls the configured LLM, so confirm the spend).`,
      { fix: drainFix(sourceId) });
    const retry = session.retry;
    const origin = retry.origin;
    const item = origin.kind === 'page'
      ? { kind: 'page' as const, slug: origin.locator, content: (await engine.readPageSnapshot(origin.locator, { sourceId }))?.page.compiled_truth ?? '', contentHash: origin.contentHash }
      : { kind: 'transcript' as const, filePath: origin.locator, content: readFileSync(origin.locator, 'utf8'), contentHash: origin.contentHash };
    const current = await readAtomOrigin(engine, session, item);
    // The retry runs against the current origin (its revision and visibility);
    // only a change to the input the run key covers refuses it.
    if (atomRetryInputKey(session, current) !== atomRetryInputKey(session, origin)) throw opError('source_changed', 'The original atom input changed; this retry cannot reuse it.',
      `The ${origin.kind} that atom request ${requestId} extracted from in source ${sourceId} has changed since, so its retained batch no longer applies; nothing was started. Run a fresh atom drain, which extracts from the current content.`,
      { fix: drainFix(sourceId) });
    if (await resumeManagedAtoms(engine, session, current)) return { status: 'completed', replayed: true, model_rerun: false };
    const checkpoint = retry.expectedCheckpoint as Array<{ failure?: string }> | null;
    if (checkpoint && !checkpoint[0]?.failure) return { status: 'completed', replayed: true, model_rerun: false };
    const saved = retry.rows.filter(row => row.intent?.kind === 'managed_atom_page');
    const deleted = retry.rows.filter(row => row.intent?.kind === 'managed_atom_delete');
    if (saved.length || deleted.length) {
      const atoms: Parameters<typeof publishManagedAtoms>[3] = [];
      for (const row of saved) {
        const p = row.intent as AtomIntent;
        const target = await engine.readPageSnapshot(row.slug, { sourceId, includeDeleted: true });
        const revision = row.state === 'committed' ? row.outcome?.revision : p.expected_revision ?? null;
        if (typeof revision !== 'string' && (row.state === 'committed' || revision !== null)) throw opError('storage_error', 'The retained atom publication revision is unavailable.',
          `The receipt of atom page ${row.slug} (request ${row.request_id}) no longer records the revision it published against, so the retry cannot republish it; nothing was published. Read the batch's receipt, then run a fresh atom drain for source ${sourceId}.`,
          { fix: receiptFix(requestId) });
        const pageId = row.state === 'committed' ? row.page_id ?? target?.page.id ?? null : row.page_id;
        if ((target?.page.id ?? null) !== pageId || (target?.revision ?? null) !== revision) {
          throw opError('page_identity_changed', 'An atom target changed independently of the failed publication.',
            `Atom page ${row.slug} in source ${sourceId} was edited, created, deleted or replaced after request ${requestId} failed, so republishing would overwrite that change; nothing was published. Read the page, then run a fresh atom drain if its atoms still need extracting.`,
            { fix: pageFix(sourceId, row.slug) });
        }
        if (typeof p.content !== 'string') throw opError('storage_error', 'The retained atom publication content is unavailable.',
          `The receipt of atom page ${row.slug} (request ${row.request_id}) no longer holds its content (the retained payload expired), so the retry cannot republish it; nothing was published. Read the batch's receipt, then run a fresh atom drain for source ${sourceId}.`,
          { fix: receiptFix(requestId) });
        atoms.push({ slug: row.slug, content: p.content, links: p.links ?? [], expectedTarget: { pageId, revision } });
      }
      const retirements: ManagedAtomRetirement[] = [];
      for (const row of deleted) {
        const p = row.intent as AtomIntent;
        const target = await engine.readPageSnapshot(row.slug, { sourceId, includeDeleted: true });
        const revision = row.state === 'committed' ? row.outcome?.revision : p.expected_revision;
        if (typeof revision !== 'string' || row.page_id === null || !target ||
          target.page.id !== row.page_id || target.revision !== revision || Boolean(target.page.deleted_at) !== (row.state === 'committed')) {
          throw opError('page_identity_changed', 'An atom retirement target changed independently of the failed publication.',
            `Atom page ${row.slug} in source ${sourceId}, which request ${requestId} was retiring, was edited, restored or replaced after the failure, so retiring it now would discard that change; nothing was published. Read the page and decide with the user whether it should still be retired.`,
            { fix: pageFix(sourceId, row.slug) });
        }
        retirements.push({ slug: row.slug, pageId: row.page_id, revision });
      }
      const receipts = await publishManagedAtoms(engine, session, current, atoms, undefined, retirements);
      return { status: 'completed', model_rerun: false, write_requests: receipts };
    }
    if (!retry.rows.some(row => row.outcome?.failure)) throw opError('invalid_params', 'This failed batch has no malformed extraction to retry.',
      `Atom batch ${requestId} in source ${sourceId} did not fail on malformed model output, so a model rerun cannot fix it; nothing was started. Read its receipt for the recorded error and fix that cause instead.`,
      { fix: receiptFix(requestId) });
    const { runPhaseExtractAtoms } = await import('../cycle/extract-atoms.ts');
    const result = await runPhaseExtractAtoms(engine, { sourceId, _managedRetry: { requestId, retryId },
      _pages: item.kind === 'page' ? [item] : [], _transcripts: item.kind === 'transcript' ? [item] : [] });
    if (result.status !== 'ok') {
      const receipts = Array.isArray(result.details?.write_requests) ? result.details.write_requests.filter(isWriteReceipt) : [];
      const receipt = receipts.at(-1);
      const pending = receipt && ['queued', 'running', 'recovering'].includes(receipt.state);
      const inspected = receipt?.request_id ?? requestId;
      const error = opError(pending ? 'write_pending' : 'extraction_failed', 'The explicit atom retry did not complete; inspect its retained receipt before approving another attempt.',
        pending
          ? `The retry's atom write ${inspected} in source ${sourceId} is still queued or running and may still commit. Inspect its receipt and wait for it to settle; do not approve another attempt meanwhile.`
          : `The retry of atom batch ${requestId} in source ${sourceId} ran the model again and failed. Read the receipt for the recorded error before asking the user to approve another paid attempt.`,
        { fix: receiptFix(inspected) });
      if (receipt) error.writeRequest = receipt;
      throw error;
    }
    return { ...result, model_rerun: true };
  }, { ttlMinutes: 5 });
}
