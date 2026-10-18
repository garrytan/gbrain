/**
 * SQL fragments for the read eligibility policy (eligibility/policy.ts).
 *
 * Every builder splices only a caller-supplied table alias and constants from
 * the closed tier / reason-family vocabularies; no caller value reaches the
 * text, so they are registered as vetted builders in
 * scripts/check-engine-sql-dynamic.ts. Each returns a predicate (no leading
 * AND) that callers splice into the WHERE clause of an arm, before LIMIT.
 *
 * Chunks carry no tier: a chunk's tier is its page's tier, read through the
 * pages join every search arm already has (pageTrustFloorSql on `p`).
 */
import { QUARANTINE_KEY } from '../quarantine.ts';
import { TRUST_TIER_RANK, tiersAtOrAbove, trustRankSql, type TrustTier } from '../trust/tier.ts';
import type { ReadEligibility } from './policy.ts';

/** Write-gate reason families that make an unconfirmed row ineligible for proactive injection (CEO-20). */
export const ACTIVATION_REASON_FAMILIES = ['standing_instruction', 'override', 'exfiltration', 'credential'] as const;
/** Rows at or below this tier are subject to activation control; confirmation lifts a row above it. */
export const ACTIVATION_TIER_CEILING: TrustTier = 'agent_written';

export type EligibilityTable = 'facts' | 'takes' | 'timeline_entries' | 'pages';

const tierListSql = (tiers: readonly TrustTier[]) => tiers.map(t => `'${t}'`).join(',');

/** `alias.trust_tier` admitted by a floor; 'TRUE' without one. */
export function trustFloorSql(alias: string, floor: TrustTier | undefined): string {
  if (!floor) return 'TRUE';
  const tiers = tiersAtOrAbove(floor);
  return tiers.length === 6 ? 'TRUE' : `${alias}.trust_tier IN (${tierListSql(tiers)})`;
}

const quarantined = (pageAlias: string) => `(COALESCE(${pageAlias}.frontmatter, '{}'::jsonb) ? '${QUARANTINE_KEY}')`;

/**
 * ENG-8: a projection of a quarantined page is hidden while the page stays
 * quarantined. Facts reach their page through (source_id,
 * source_markdown_slug); takes and timeline entries through page_id. A fact
 * with no source page is never hidden by this rule.
 */
export function quarantinedProjectionHiddenSql(table: Exclude<EligibilityTable, 'pages'>, alias: string): string {
  if (table === 'facts') {
    return `NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.source_id = ${alias}.source_id AND elig_qp.slug = ${alias}.source_markdown_slug
      AND elig_qp.deleted_at IS NULL AND ${quarantined('elig_qp')})`;
  }
  return `NOT EXISTS (SELECT 1 FROM pages elig_qp WHERE elig_qp.id = ${alias}.page_id AND ${quarantined('elig_qp')})`;
}

/**
 * CEO-20: true for rows a proactive surface must not inject: tier at or below
 * agent_written and a write-gate flag receipt in an instruction family. The
 * receipt contract is the write gate's `write_gate_receipts (target_table,
 * target_id, verdict, reason_families)`; owner confirmation raises the tier,
 * which lifts the suppression without touching the receipt.
 */
export function activationSuppressedSql(table: EligibilityTable, alias: string): string {
  return `(${trustRankSql(`${alias}.trust_tier`)} <= ${TRUST_TIER_RANK[ACTIVATION_TIER_CEILING]}
    AND EXISTS (SELECT 1 FROM write_gate_receipts elig_r WHERE elig_r.target_table = '${table}' AND elig_r.target_id = ${alias}.id::text
      AND elig_r.verdict = 'flag' AND elig_r.reason_families && ARRAY[${ACTIVATION_REASON_FAMILIES.map(f => `'${f}'`).join(',')}]::text[]))`;
}

/**
 * A row a purge hid because one of its derivation inputs was purged
 * (`needs_rederive`, written by facts/derivation-inputs.ts) never surfaces,
 * even on reads that include expired or inactive rows, until a deriver
 * regenerates it.
 */
export function rederiveHiddenSql(table: EligibilityTable, alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM needs_rederive elig_nr WHERE elig_nr.derived_table = '${table}' AND elig_nr.derived_id = ${alias}.id::text)`;
}

/**
 * The whole row predicate for one projection table under a policy. Always
 * hides quarantined-page projections and rows awaiting re-derivation.
 * Gate holds never reach these tables (write_gate_holds) and purged rows are
 * deleted, so neither needs a clause here.
 */
export function projectionEligibleSql(table: Exclude<EligibilityTable, 'pages'>, alias: string, policy: ReadEligibility | undefined): string {
  const clauses = [quarantinedProjectionHiddenSql(table, alias), rederiveHiddenSql(table, alias)];
  if (policy?.floor) clauses.push(trustFloorSql(alias, policy.floor));
  if (policy?.suppressFlagged) clauses.push(`NOT ${activationSuppressedSql(table, alias)}`);
  return clauses.join(' AND ');
}

/** The page-level predicate (floor and activation) over a pages alias; 'TRUE' when the policy restricts nothing. */
export function pageEligibleSql(alias: string, policy: ReadEligibility | undefined): string {
  const clauses: string[] = [];
  if (policy?.floor) clauses.push(trustFloorSql(alias, policy.floor));
  if (policy?.suppressFlagged) clauses.push(`NOT ${activationSuppressedSql('pages', alias)}`);
  return clauses.length ? clauses.join(' AND ') : 'TRUE';
}

/**
 * Plan A5: `tp<id>:challenger|challenged` for the first pending supersede
 * proposal naming the row (as the new lower-tier row or the row it would
 * supersede), or NULL. labels.ts `parseContested` reads it back.
 */
export function contestedRefSql(table: Exclude<EligibilityTable, 'pages' | 'timeline_entries'>, alias: string): string {
  return `(SELECT 'tp' || elig_tp.id::text || ':' || CASE WHEN elig_tp.related_table = '${table}' AND elig_tp.related_id = ${alias}.id THEN 'challenger' ELSE 'challenged' END
    FROM trust_proposals elig_tp WHERE elig_tp.status = 'pending' AND elig_tp.action IN ('supersede_fact', 'supersede_take')
      AND ((elig_tp.target_table = '${table}' AND elig_tp.target_id = ${alias}.id) OR (elig_tp.related_table = '${table}' AND elig_tp.related_id = ${alias}.id))
    ORDER BY elig_tp.id LIMIT 1)`;
}
