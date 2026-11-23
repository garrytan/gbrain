/**
 * The managed sync run's journal reads, each byte for byte the statement its caller sent before it became a member
 * (pinned by test/engine-sql-caller-raw-sql-pins.test.ts):
 *  - `readAdmittedWriteRequests`: the rows a principal admitted under the named request ids
 *    (persistence/sync-admitted.ts `readAdmitted`, one read per admitting principal), optionally only committed ones;
 *  - `readPageRevisionWriter` and `readRevisionWriterRequest`: a page's live revision and the journal request that
 *    wrote it, the two reads of the `concurrent_write` proof (persistence/sync-concurrent-write.ts).
 * Each runs on the engine's own `executeRaw`, so inside `transaction()` it reads on the transaction's connection. A
 * Rust brain serves all three from its store (rust/crates/gbrain-store/src/persistence/sync_run_reads.rs).
 */
import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from '../persistence/model.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

const ADMITTED_ALL = 'SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[])';
const ADMITTED_COMMITTED = "SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[]) AND state='committed'";

/** A page's live revision and the `persistence_requests.id` that wrote it (`pages.revision_write_request_id`). */
export interface PageRevisionWriter { revision: string | null; writer: string | null }

/** The columns of the request that wrote a page's revision; `kind` is `intent->>'kind'`, `page_id` the driver's bigint. */
export interface RevisionWriterRequest {
  request_id: string; operation: string; kind: string | null; state: string; incarnation: string; page_id: number | string | null;
}

/** The principal's request rows under `requestIds` (each request at most once); only the committed ones when `committedOnly`. */
export function readAdmittedWriteRequests(raw: Raw, principalKind: string, principalId: string, requestIds: readonly string[], committedOnly: boolean): Promise<WriteRequest[]> {
  return raw.executeRaw<WriteRequest>(committedOnly ? ADMITTED_COMMITTED : ADMITTED_ALL, [principalKind, principalId, [...requestIds]]);
}

/** Page `pageId` of source `sourceId`: its live revision and the request that wrote it, or null when the page is absent. */
export async function readPageRevisionWriter(raw: Raw, pageId: number, sourceId: string): Promise<PageRevisionWriter | null> {
  const [row] = await raw.executeRaw<PageRevisionWriter>(
    'SELECT knowledge_revision::text AS revision, revision_write_request_id::text AS writer FROM pages WHERE id=$1 AND source_id=$2', [pageId, sourceId]);
  return row ?? null;
}

/** The journal request whose row id is `id` (a `pages.revision_write_request_id`), projected to the proof's columns. */
export async function readRevisionWriterRequest(raw: Raw, id: string): Promise<RevisionWriterRequest | null> {
  const [row] = await raw.executeRaw<RevisionWriterRequest>(
    `SELECT request_id::text, operation, intent->>'kind' AS kind, state, source_incarnation::text AS incarnation, page_id FROM persistence_requests WHERE id=$1::uuid`, [id]);
  return row ?? null;
}
