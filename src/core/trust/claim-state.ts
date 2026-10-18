/**
 * Claimed sources (#5575, legacy content): which sources the owner has
 * claimed as their own notes with `gbrain trust claim-sources`
 * (trust/claim.ts). A claim lives in `sources.config` beside the
 * `sources set-trust` default it sets:
 *
 *   trust_tier          'operator_curated' (the per-source default)
 *   trust_claimed_at    when the owner confirmed the claim
 *   trust_claim_lifted_at  when the claim's backfill finished for the source
 *
 * A source is claimed while both of the first two hold and it is not a
 * connector source; `sources set-trust` to a lower tier or `--clear` drops
 * the claim. A claimed source whose lift has not finished is "pending": its
 * legacy `unknown` rows are treated as owner tier by the scan, explain and
 * review, because the lift will make them so (or lower, by their own signals).
 *
 * "Legacy" rows are the ones that existed when trust tiers and the write gate
 * arrived: ids at or below each table's max id recorded then
 * (`write_gate.scan_baseline`, migration v227; zero on a brain created
 * since). A row a writer stored as `unknown` later is not legacy, so a claim
 * never lifts it and a fresh brain never reads as unclaimed.
 */
import type { BrainEngine } from '../engine.ts';
import { CONNECTOR_SOURCE_KINDS } from '../persistence/connector-identity.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../write-gate-schema.ts';
import { OWNER_TIER_FLOOR } from './tier.ts';

export const TRUST_CLAIMED_AT_KEY = 'trust_claimed_at';
export const TRUST_CLAIM_LIFTED_AT_KEY = 'trust_claim_lifted_at';
export const TRUST_CLAIM_COMMAND = ['gbrain', 'trust', 'claim-sources'] as const;
export const TRUST_CLAIM_RESUME_COMMAND = ['gbrain', 'trust', 'claim-sources', '--resume'] as const;

const connectorList = CONNECTOR_SOURCE_KINDS.map(k => `'${k}'`).join(',');

/** SQL predicate: the `sources` row aliased `alias` is not a connector source. `alias` is a trusted alias, never caller input. */
export function notConnectorSourceSql(alias: string): string {
  return `COALESCE(${alias}.config->>'kind', '') NOT IN (${connectorList})`;
}

/** SQL predicate: the `sources` row aliased `alias` is a claimed source. */
export function claimedSourceSql(alias: string): string {
  return `(${alias}.config ? '${TRUST_CLAIMED_AT_KEY}' AND ${alias}.config->>'trust_tier' = '${OWNER_TIER_FLOOR}' AND ${notConnectorSourceSql(alias)})`;
}

/** SQL predicate: a claimed source whose lift has not finished. */
export function claimPendingSql(alias: string): string {
  return `(${claimedSourceSql(alias)} AND NOT (${alias}.config ? '${TRUST_CLAIM_LIFTED_AT_KEY}'))`;
}

export function isConnectorConfig(config: Record<string, unknown> | null | undefined): boolean {
  return (CONNECTOR_SOURCE_KINDS as readonly unknown[]).includes(config?.kind);
}

export function isClaimedConfig(config: Record<string, unknown> | null | undefined): boolean {
  return typeof config?.[TRUST_CLAIMED_AT_KEY] === 'string' && config?.trust_tier === OWNER_TIER_FLOOR && !isConnectorConfig(config);
}

/** The config after `sources set-trust`: any value but operator_curated (or --clear) ends a claim. */
export function dropClaimUnlessOwnerDefault(config: Record<string, unknown>): Record<string, unknown> {
  if (config.trust_tier === OWNER_TIER_FLOOR) return config;
  const { [TRUST_CLAIMED_AT_KEY]: _claimed, [TRUST_CLAIM_LIFTED_AT_KEY]: _lifted, ...rest } = config;
  return rest;
}

export type LegacyCeilings = Partial<Record<'pages' | 'facts' | 'takes' | 'timeline_entries', number>> | null;

/** Each table's max id when the trust migrations ran, or null (no baseline recorded: every row counts as legacy). */
export async function readLegacyCeilings(engine: Pick<BrainEngine, 'executeRaw'>): Promise<LegacyCeilings> {
  const [row] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY]);
  if (!row) return null;
  try {
    const until = (JSON.parse(row.value) as { until?: Record<string, unknown> }).until;
    if (!until || typeof until !== 'object') return null;
    const out: NonNullable<LegacyCeilings> = {};
    for (const table of ['pages', 'facts', 'takes', 'timeline_entries'] as const) {
      const n = Number(until[table]);
      out[table] = Number.isFinite(n) ? Math.trunc(n) : 0;
    }
    return out;
  } catch {
    return null;
  }
}

/** SQL predicate: the `table` row aliased `alias` is a legacy row. `alias` is a trusted alias; the ceiling is an integer. */
export function legacyRowSql(table: 'pages' | 'facts' | 'takes' | 'timeline_entries', alias: string, ceilings: LegacyCeilings): string {
  return ceilings ? `${alias}.id <= ${Math.trunc(ceilings[table] ?? 0)}` : 'TRUE';
}
