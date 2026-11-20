/**
 * The read-command statements the exact-phrase scan ran through `executeRaw` before it had a typed member. The
 * statement keeps the text its call site ran, byte for byte (scripts/sql-move-check.mjs holds it to that). The scan
 * batch, the held-fence and snippet reads and the rank statements splice visibility predicates into their text and stay
 * at their call sites.
 */

/** The engine's own `executeRaw` (the member runs on the connection the caller's engine holds). */
export type EngineRawRead = <R = Record<string, unknown>>(sql: string, params?: unknown[], opts?: { timeoutMs?: number; jitOff?: boolean }) => Promise<R[]>;

/** The first live page after `afterPageId` in id order, in any source, or null. */
export async function nextLivePageAfter(raw: EngineRawRead, afterPageId: number): Promise<{ id: number; slug: string; source_id: string } | null> {
  const [next] = await raw<{ id: number; slug: string; source_id: string }>(
    'SELECT id, slug, source_id FROM pages WHERE id > $1::int AND deleted_at IS NULL ORDER BY id LIMIT 1', [afterPageId]);
  return next ?? null;
}
