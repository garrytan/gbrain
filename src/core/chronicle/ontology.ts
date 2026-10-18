// v0.42.x — Life Chronicle (#2390) ontology helpers (Phase B.10).
// The ontology rides the `facts` table; these are the deterministic bits the
// engine methods (mergeOntologyFact / getOntology / …) lean on.
import { computeContentHash } from '../ingestion/types.ts';
import { trustRankSql } from '../trust/tier.ts';

/**
 * Deterministic dedup key for an ontology value. Normalized (trim + lowercase +
 * NFKC via computeContentHash) so "Advisor" and "advisor " dedup, and a crash
 * retry produces the same key — NO timestamp, so retries are idempotent.
 */
export function valueHash(value: string): string {
  return computeContentHash(value.trim().toLowerCase()).slice(0, 16);
}

// Seed lexicon: canonicalize common dimension-name drift at WRITE time so the
// open world doesn't fragment into role/job_role/position/title for one concept.
const DIMENSION_ALIASES: Record<string, string> = {
  job_role: 'role', position: 'role', title: 'role', job_title: 'role',
  relationship: 'relation', rel: 'relation',
  risk_appetite: 'risk_tolerance',
  comms_style: 'communication_style', communication: 'communication_style',
  employer_name: 'employer', company: 'employer', org: 'employer',
};

const KNOWN_DIMENSIONS = new Set<string>([
  'role', 'relation', 'risk_tolerance', 'decision_style', 'communication_style',
  'reliability', 'expertise', 'affect', 'location', 'employer',
]);

/** Normalize a dimension name (case/space/hyphen + alias lexicon). */
export function normalizeDimension(name: string): string {
  const n = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return DIMENSION_ALIASES[n] ?? n;
}

/**
 * A dimension is "novel" (→ quarantine) when it's neither a seed dimension nor
 * an alias of one. Quarantined observations are stored but excluded from
 * current-value resolution + context loading until confirmed, so an LLM
 * hallucination can't silently shape agent context.
 */
export function isNovelDimension(normalized: string): boolean {
  return !KNOWN_DIMENSIONS.has(normalized);
}

/**
 * A same-value observation dated BEFORE the current open value's start is an
 * earlier stint (possibly separated from the current one by another value),
 * not a corroboration of the current one: mergeOntologyFact stores it as a
 * live row so as-of reads see it, exactly like a backdated observation of a
 * different value. Undated observations are never backdated.
 */
export function isBackdatedObservation(validFrom: string | null, currentValidFrom: string | Date | null | undefined): boolean {
  return validFrom != null && currentValidFrom != null
    && new Date(validFrom).getTime() < new Date(currentValidFrom).getTime();
}

/**
 * #5575 A5: a new observation closes the current open stint only when its
 * writer is at least as trusted as that stint (the transaction's declared
 * tier, `unknown` when undeclared). Appended to the closing UPDATE in both
 * engines; a guarded stint stays open and the caller files a contested proposal.
 */
export const ONTOLOGY_SUPERSEDE_GUARD = ` AND ${trustRankSql('trust_tier')} <= ${trustRankSql(`COALESCE(NULLIF(current_setting('gbrain.write_trust_tier', true), ''), 'unknown')`)}`;
