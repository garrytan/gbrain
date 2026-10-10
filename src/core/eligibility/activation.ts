/**
 * Activation control for proactive surfaces (#5575: CEO-20, DX-10, DX-13).
 *
 * Facts, takes, timeline entries and pages at `agent_written` or lower that
 * carry a write-gate flag in an instruction family (standing_instruction,
 * override, exfiltration, credential) are never injected by a proactive
 * surface (hook turn context, context engine, context_pack, volunteer and
 * retrieval reflex, core and hot-memory delivery) until the owner confirms
 * them, which raises their tier above `agent_written`. Explicit reads
 * (query, search, recall, get_page) still return them, labeled
 * "unconfirmed, agent-written". Deterministic: one indexed query per table,
 * zero model calls. `trust.agent_activation=allow` opts out.
 *
 * Proactive surfaces partition their candidates here (after ranking, before
 * rendering) so they can say how much they withheld: the suppression notice
 * carries a count and the review command, never the content.
 */
import type { BrainEngine } from '../engine.ts';
import type { Notice } from '../agent-output.ts';
import { admitsTrust, storedTrustTier, type TrustTier } from '../trust/tier.ts';
import { activationSuppressedSql, type EligibilityTable } from './sql.ts';
import type { ReadEligibility } from './policy.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

export interface ActivationRef { table: EligibilityTable; id: number }

export interface ActivationVerdict {
  /** Row tier, for labels. */
  tier: TrustTier;
  /** Below the effective read floor (never shown, not counted as suppressed). */
  belowFloor: boolean;
  /** Withheld by activation control (counted in the suppression notice). */
  suppressed: boolean;
  /**
   * Carries an instruction-family write-gate flag the owner has not confirmed, whatever the policy:
   * under `trust.agent_activation=allow` (the default) a kept row is injected with the
   * "unconfirmed, agent-written" label, so it never reaches proactive context unlabeled.
   */
  unconfirmed: boolean;
}

const TABLE_SQL: Readonly<Record<EligibilityTable, string>> = {
  facts: 'facts', takes: 'takes', timeline_entries: 'timeline_entries', pages: 'pages',
};

/** Tier and suppression state for each referenced row; rows that no longer exist are absent. */
export async function activationVerdicts(engine: Exec, refs: readonly ActivationRef[], policy: ReadEligibility): Promise<Map<string, ActivationVerdict>> {
  const out = new Map<string, ActivationVerdict>();
  const byTable = new Map<EligibilityTable, number[]>();
  for (const r of refs) if (Number.isFinite(r.id)) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r.id]);
  for (const [table, ids] of byTable) {
    const rows = await engine.executeRaw<{ id: number | string; trust_tier: string; flagged: boolean }>(
      `SELECT a.id, a.trust_tier, ${activationSuppressedSql(table, 'a')} AS flagged FROM ${TABLE_SQL[table]} a WHERE a.id = ANY($1::bigint[])`, [[...new Set(ids)]]);
    for (const row of rows) {
      const tier = storedTrustTier(row.trust_tier);
      const flagged = row.flagged === true;
      out.set(`${table}:${Number(row.id)}`, {
        tier,
        belowFloor: policy.floor ? !admitsTrust(tier, policy.floor) : false,
        suppressed: policy.suppressFlagged === true && flagged,
        unconfirmed: flagged,
      });
    }
  }
  return out;
}

export interface ActivationPartition<T> {
  /** `unconfirmed`: the kept row carries an unconfirmed instruction-family flag; render its label. */
  kept: Array<{ item: T; tier: TrustTier; unconfirmed: boolean }>;
  /** Items activation control withheld (authorized for an explicit read, not for injection). */
  withheld: number;
}

/**
 * Splits proactive candidates into what may be injected and how many were
 * withheld. An item whose row cannot be read is dropped (fail-closed: a
 * proactive surface never injects what it could not check). Order is kept.
 */
export async function partitionForActivation<T>(
  engine: Exec, items: readonly T[], refOf: (item: T) => ActivationRef, policy: ReadEligibility,
): Promise<ActivationPartition<T>> {
  if (items.length === 0) return { kept: [], withheld: 0 };
  let verdicts: Map<string, ActivationVerdict>;
  try { verdicts = await activationVerdicts(engine, items.map(refOf), policy); }
  catch { return { kept: [], withheld: 0 }; }
  const kept: ActivationPartition<T>['kept'] = [];
  let withheld = 0;
  for (const item of items) {
    const ref = refOf(item);
    const v = verdicts.get(`${ref.table}:${ref.id}`);
    if (!v || v.belowFloor) continue;
    if (v.suppressed) { withheld++; continue; }
    kept.push({ item, tier: v.tier, unconfirmed: v.unconfirmed });
  }
  return { kept, withheld };
}

/** The command that lists every unconfirmed item for the owner (DX-7 `gbrain trust review`). */
export const TRUST_REVIEW_COMMAND = ['gbrain', 'trust', 'review'] as const;

/** DX-10: the structured suppression notice. A count and the review command; never the withheld content. */
export function activationSuppressionNotice(withheld: number, surface: string): Notice | null {
  if (withheld <= 0) return null;
  return {
    code: 'memory_suppressed',
    kind: 'info',
    why: `${withheld} unconfirmed agent-written ${withheld === 1 ? 'memory was' : 'memories were'} not used in ${surface} because ${withheld === 1 ? 'it reads' : 'they read'} like instructions. They stay searchable; the owner reviews them with gbrain trust review.`,
    fix: { argv: [...TRUST_REVIEW_COMMAND], consent: [], actor: 'user', requires_exclusive: false,
      why: 'Lists unconfirmed agent-written memories with the command to confirm or drop each; only the owner can confirm.' },
  };
}

/** The wire form proactive results carry alongside their text (DX-10). */
export interface SuppressionSummary { withheld: number; review: string }
export function suppressionSummary(withheld: number): SuppressionSummary | undefined {
  return withheld > 0 ? { withheld, review: TRUST_REVIEW_COMMAND.join(' ') } : undefined;
}

export interface PageKey { source_id: string; slug: string }

/**
 * Page variant for surfaces that hold (source_id, slug) rather than ids
 * (retrieval reflex pointers, volunteered pages): verdicts per live page
 * key, with the label fields. Missing pages are absent (callers drop them).
 */
export async function pageActivationVerdicts(engine: Exec, keys: readonly PageKey[], policy: ReadEligibility):
  Promise<Map<string, ActivationVerdict & { origin: unknown }>> {
  const out = new Map<string, ActivationVerdict & { origin: unknown }>();
  if (keys.length === 0) return out;
  const rows = await engine.executeRaw<{ source_id: string; slug: string; trust_tier: string; write_origin: unknown; flagged: boolean }>(
    `SELECT a.source_id, a.slug, a.trust_tier, a.write_origin, ${activationSuppressedSql('pages', 'a')} AS flagged FROM pages a
      WHERE a.deleted_at IS NULL AND (a.source_id, a.slug) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
    [keys.map(k => k.source_id), keys.map(k => k.slug)]);
  for (const row of rows) {
    const tier = storedTrustTier(row.trust_tier);
    const flagged = row.flagged === true;
    out.set(pageKey(row), { tier, origin: row.write_origin, belowFloor: policy.floor ? !admitsTrust(tier, policy.floor) : false,
      suppressed: policy.suppressFlagged === true && flagged, unconfirmed: flagged });
  }
  return out;
}

export const pageKey = (k: PageKey) => `${k.source_id}\u0000${k.slug}`;
