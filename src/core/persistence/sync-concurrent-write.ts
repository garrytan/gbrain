/**
 * #6194 (D4): a managed sync import that failed `revision_conflict` because a
 * database-only write committed to the same page while the import was in
 * flight. The file (Git) and the newer database revision genuinely diverge, so
 * neither side may win silently: the file is held with code `concurrent_write`
 * and the rest of the sync continues; nothing is overwritten. The hold's fix is
 * `gbrain sources reconcile <source> <slug> --preview` (sync-holds.ts router).
 *
 * The proof is revision-linked, not admission order: the page's live revision
 * differs from the revision the import was frozen against, and the committed
 * journal request that wrote that revision (`pages.revision_write_request_id`)
 * is a non-sync request for the same source incarnation and page id. Anything
 * else (no proof) keeps the blocking failure.
 */
import type { BrainEngine } from '../engine.ts';
import { RECOVERY_VERSION } from '../markdown.ts';
import { sha256 } from './digest.ts';
import type { WriteRequest } from './model.ts';
import type { SyncIntent } from './sync-prepare.ts';
import type { HeldEntry } from './sync-screen.ts';

export interface ConcurrentWriteProof { request_id: string; operation: string; revision: string }

/** The proof that `done` failed because a non-sync write changed the page; null when it is not proven. */
export async function concurrentWriteProof(engine: Pick<BrainEngine, 'executeRaw'>, input: { sourceId: string; incarnation: string;
  pending: { pageId: number | null; intent: SyncIntent }; done: Pick<WriteRequest, 'error_code'> }): Promise<ConcurrentWriteProof | null> {
  const { pending } = input;
  if (input.done.error_code !== 'revision_conflict' || pending.intent.kind !== 'managed_sync_import' || pending.pageId === null) return null;
  const [page] = await engine.executeRaw<{ revision: string | null; writer: string | null }>(
    'SELECT knowledge_revision::text AS revision, revision_write_request_id::text AS writer FROM pages WHERE id=$1 AND source_id=$2', [pending.pageId, input.sourceId]);
  if (!page?.revision || !page.writer || page.revision === String(pending.intent.expected_revision ?? '')) return null;
  const [writer] = await engine.executeRaw<{ request_id: string; operation: string; kind: string | null; state: string; incarnation: string; page_id: number | null }>(
    `SELECT request_id::text, operation, intent->>'kind' AS kind, state, source_incarnation::text AS incarnation, page_id FROM persistence_requests WHERE id=$1::uuid`, [page.writer]);
  if (!writer || writer.state !== 'committed' || String(writer.kind ?? '').startsWith('managed_sync_')
    || writer.incarnation !== input.incarnation || Number(writer.page_id) !== pending.pageId) return null;
  return { request_id: writer.request_id, operation: writer.operation, revision: page.revision };
}

/** The `concurrent_write` hold for a proven race; location and identifiers only, never page content. */
export function concurrentWriteHold(entry: { path: string; sourcePath: string; working?: boolean }, slug: string, pageId: number,
  intent: SyncIntent, proof: ConcurrentWriteProof): HeldEntry {
  return { path: entry.path, source_path: entry.sourcePath, slug, page_id: pageId, code: 'concurrent_write',
    message: `${entry.path} changed in Git while ${proof.operation} request ${proof.request_id} wrote page ${slug} straight to the database, so the two versions diverge; neither was overwritten.`,
    upstream_version: typeof intent.content === 'string' ? sha256(intent.content) : null,
    meta: { recovery_version: RECOVERY_VERSION, competing_request_id: proof.request_id, competing_operation: proof.operation, page_revision: proof.revision,
      ...(typeof intent.blobOid === 'string' ? { blob_oid: intent.blobOid } : {}), ...(entry.working ? { working: true } : {}) } };
}
