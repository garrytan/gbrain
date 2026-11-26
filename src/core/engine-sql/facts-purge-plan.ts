/**
 * The reads a fact purge's request finders (persistence/intent-redaction.ts findRequestsCarrying and
 * findRequestsHoldingStagings) and its verification probes (facts/purge-verify.ts) make. Each function runs the
 * statement its caller ran through `executeRaw`, with the same text and parameters, on the engine's own `executeRaw`;
 * only its home moved. The texts live in facts/purge-plan-statements.ts. The inventory probes (`countPurgeProbe`,
 * `listPurgeProbeItems`) are built there from the deletion inventory's own table and column names; the caller's needles
 * are parameters. The plan's other reads are engine-sql/facts-purge.ts members.
 */
import { boundedCountSql, probeItemsSql, purgeProbeSelect, REQUESTS_CARRYING_SQL, REQUESTS_HOLDING_STAGINGS_SQL, type PurgeProbe } from '../facts/purge-plan-statements.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { PurgeProbe } from '../facts/purge-plan-statements.ts';

/** The claim's needles a request scan matches: lowercased, JSON-escaped lowercased, and the folded reason. */
export interface PurgeClaimNeedles { sourceId: string; claimLower: string; claimJson: string; reason: string }
export interface PurgeRequestTarget { id: string; principal_kind: string; principal_id: string }

/** findRequestsCarrying: the source's requests whose stored text carries the claim, up to `limit`. */
export async function listRequestsCarryingClaim(raw: EngineRawRead, q: PurgeClaimNeedles & { limit: number }): Promise<PurgeRequestTarget[]> {
  return raw<PurgeRequestTarget>(REQUESTS_CARRYING_SQL, [q.sourceId, q.claimLower, q.claimJson, q.reason, q.limit]);
}

/** findRequestsHoldingStagings: the source's unfinished requests that publish one of `stagingIds`. */
export async function listRequestsHoldingStagings(raw: EngineRawRead, sourceId: string, stagingIds: readonly string[]): Promise<PurgeRequestTarget[]> {
  return raw<PurgeRequestTarget>(REQUESTS_HOLDING_STAGINGS_SQL, [sourceId, [...stagingIds]]);
}

/** boundedCount: the rows `probe` finds, at most `rows + 1`. */
export async function countPurgeProbe(raw: EngineRawRead, probe: PurgeProbe, rows: number): Promise<number> {
  const select = purgeProbeSelect(probe);
  if (!select) return 0;
  const [row] = await raw<{ n: number }>(boundedCountSql(select.sql, rows), select.params);
  return Number(row?.n ?? 0);
}

/** probeNamedRows: the first 20 rows a named probe lists. */
export async function listPurgeProbeItems(raw: EngineRawRead, probe: PurgeProbe & { kind: 'named' }): Promise<string[]> {
  const select = purgeProbeSelect(probe);
  if (!select) return [];
  return (await raw<{ item: string }>(probeItemsSql(select.sql), select.params)).map(row => row.item);
}
