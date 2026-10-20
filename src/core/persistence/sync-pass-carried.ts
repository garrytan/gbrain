/**
 * #6712 PR 4b: a pass's page requests that outlive it. A pass that stops while its imports or deletions are still open
 * (`writer_pending`, a timeout, a block) records them in the pass row (`obligations.pending_requests`, at most
 * `OPEN_AT_STAMP_CAP`, with the earlier passes' still open). The next pass reports each one that committed as its own
 * import, whoever published it and whenever (before the pass, or during it before its level read saw the path open), as the
 * cursor engine counted a pending write it resumed. A request still open at the pass's first triage names an in-flight path,
 * so the pass waits on it (sync-pass-run.ts `awaitInFlight`) and counts it there; each id is counted once and then dropped.
 */
import type { BrainEngine } from '../engine.ts';
import { OPEN_AT_STAMP_CAP } from './sync-pass-row.ts';

export type CarriedCounts = { added: number; modified: number; deleted: number; renamed: number; chunks: number };

/** The page requests to carry past a stop: this pass's still open, and the carried ones still open. */
export async function openPassRequests(engine: Pick<BrainEngine, 'executeRaw'>, input: { sourceId: string; passId: string; carried: readonly string[] }): Promise<string[]> {
  const rows = await engine.executeRaw<{ id: string }>(`SELECT id::text AS id FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering')
      AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND (intent->>'passId'=$2 OR id=ANY($3::uuid[])) ORDER BY sequence LIMIT $4`,
    [input.sourceId, input.passId, [...input.carried], OPEN_AT_STAMP_CAP]);
  return rows.map(row => row.id);
}

/** Of the carried `ids`: the committed ones counted as the drain counts a commit (sync-run.ts `countCommitted`), and those still open. */
export async function settleCarried(engine: Pick<BrainEngine, 'executeRaw'>, ids: readonly string[]): Promise<{ counts: CarriedCounts; open: string[] }> {
  const counts: CarriedCounts = { added: 0, modified: 0, deleted: 0, renamed: 0, chunks: 0 }, open: string[] = [];
  const rows = await engine.executeRaw<{ id: string; state: string; kind: string | null; renamed: boolean; status: string | null; noop: boolean; chunks: number | null }>(
    `SELECT id::text AS id, state, intent->>'kind' AS kind, intent ? 'renameFrom' AS renamed, outcome->>'status' AS status,
      COALESCE((outcome->>'noop')::boolean, false) AS noop, (outcome->>'chunks')::int AS chunks FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence`, [[...ids]]);
  for (const row of rows) {
    if (['queued', 'running', 'recovering'].includes(row.state)) { open.push(row.id); continue; }
    if (row.state !== 'committed') continue;
    counts.chunks += Number(row.chunks ?? 0);
    if (row.noop) continue;
    if (row.kind === 'managed_sync_delete') counts.deleted++;
    else if (row.renamed) counts.renamed++;
    else if (row.status === 'created') counts.added++;
    else counts.modified++;
  }
  return { counts, open };
}
