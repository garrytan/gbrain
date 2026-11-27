/**
 * The reads a fact purge's request finders (persistence/intent-redaction.ts findRequestsCarrying and
 * findRequestsHoldingStagings) and its verification probes (facts/purge-verify.ts) make. Each function runs the
 * statement its caller ran through `executeRaw`, with the same text and parameters, on the engine's own `executeRaw`;
 * only its home moved. The texts live in facts/purge-plan-statements.ts. The inventory probes (`countPurgeProbe`,
 * `listPurgeProbeItems`) are built there from the deletion inventory's own table and column names; the caller's needles
 * are parameters. The receipt's store probes (slug-keyed, fact-reference, fingerprint, claim-text, segment-text,
 * request and effect-payload) are built in engine-sql/purge-verify.ts and run through the same two members. The plan's
 * other reads are engine-sql/facts-purge.ts members.
 */
import { boundedCountSql, probeItemsSql, purgeProbeSelect, REQUESTS_CARRYING_SQL, REQUESTS_HOLDING_STAGINGS_SQL, type PurgeProbe as InventoryProbe } from '../facts/purge-plan-statements.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { purgeStoreProbeSelect, type EffectPayloadProbe, type PurgeStoreProbe } from './purge-verify.ts';

/** A purge verification probe: an inventory probe (facts/purge-plan-statements.ts) or a receipt store probe (engine-sql/purge-verify.ts). */
export type PurgeProbe = InventoryProbe | PurgeStoreProbe;
/** A probe whose rows name themselves: a named inventory probe or the effect-payload probe. */
export type PurgeItemsProbe = (InventoryProbe & { kind: 'named' }) | EffectPayloadProbe;

function probeSelect(probe: PurgeProbe): { sql: string; params: unknown[] } | null {
  return probe.kind === 'table' || probe.kind === 'named' ? purgeProbeSelect(probe) : purgeStoreProbeSelect(probe);
}

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
  const select = probeSelect(probe);
  if (!select) return 0;
  const [row] = await raw<{ n: number }>(boundedCountSql(select.sql, rows), select.params);
  return Number(row?.n ?? 0);
}

/** probeNamedRows and the effect-payload report: the first 20 rows a named or effect-payload probe lists, in item order. */
export async function listPurgeProbeItems(raw: EngineRawRead, probe: PurgeItemsProbe): Promise<string[]> {
  const select = probeSelect(probe);
  if (!select) return [];
  return (await raw<{ item: string }>(probeItemsSql(select.sql), select.params)).map(row => row.item);
}
