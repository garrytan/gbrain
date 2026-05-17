/**
 * v0.36.0.0 (T9 / E3) — calibration-aware contradictions.
 *
 * The v0.32.6 contradictions probe surfaces pairs of takes/chunks that
 * conflict across time. E3: cross-reference each finding against the
 * user's active calibration profile so the operator sees WHICH bias
 * pattern (if any) the contradiction fits.
 *
 * Pure functions only. No DB writes, no LLM calls. The probe runner
 * imports tagFindingWithCalibration() and applies it to each finding
 * before emitting. When no profile exists, the helper returns null and
 * the runner emits the unchanged finding (regression R2 — no calibration
 * profile → contradictions output is byte-identical to v0.32.6).
 */

import type { ContradictionFinding } from './types.ts';
import type { CalibrationProfileRow } from '../../commands/calibration.ts';

/**
 * The bias-tag context the runner can splice into the output. Keep this
 * shape forward-compatible — additive only.
 */
export interface CalibrationJoinTag {
  /** The active bias tag this contradiction matches (kebab-case slug). */
  bias_tag: string;
  /** One-line explanation surface for the operator. */
  context: string;
}

/**
 * Tag a finding with the bias context if it matches an active pattern.
 * Returns null when no calibration profile is present OR no tags match.
 *
 * Match heuristic (v0.36.0.0 ship-state):
 *  - Each bias tag has a structure like 'over-confident-geography' or
 *    'late-on-macro-tech' — axis-then-domain.
 *  - We compute a domain hint from the finding's pair members (slug
 *    prefix + holder + verdict). The finding matches a tag when the
 *    domain hint substring appears in the tag.
 *  - Match is fuzzy by design; the contradictions probe doesn't have
 *    structured domain metadata yet, and the bias tags are kebab-case
 *    slugs that need a textual surface. Future v0.37+: structured
 *    domain on takes (Hindsight-style enum) tightens this.
 */
export function tagFindingWithCalibration(
  finding: ContradictionFinding,
  profile: CalibrationProfileRow | null,
): CalibrationJoinTag | null {
  if (!profile || profile.active_bias_tags.length === 0) return null;
  const hint = computeDomainHint(finding).toLowerCase();
  if (!hint) return null;
  for (const tag of profile.active_bias_tags) {
    if (tag.toLowerCase().includes(hint)) {
      return {
        bias_tag: tag,
        context: buildBiasContextString(tag, finding, profile),
      };
    }
  }
  return null;
}

/**
 * Compute a domain hint from a finding's pair members. Uses slug prefixes
 * (people/, companies/, deals/, daily/, ...) + holder + verdict text.
 * Pure; deterministic.
 */
export function computeDomainHint(finding: ContradictionFinding): string {
  // Slug-prefix → axis-domain candidates. Ordered by specificity.
  const candidates: string[] = [];
  for (const member of [finding.a, finding.b]) {
    const slug = member.slug.toLowerCase();
    // Pull the kebab-cased segment most likely to match a bias-tag domain.
    if (slug.startsWith('wiki/companies/') || slug.startsWith('companies/')) candidates.push('hiring', 'market-timing');
    if (slug.startsWith('wiki/people/') || slug.startsWith('people/')) candidates.push('founder-behavior', 'hiring');
    if (slug.startsWith('wiki/deals/') || slug.startsWith('deals/')) candidates.push('market-timing');
    if (slug.startsWith('wiki/macro') || slug.includes('/macro/') || slug.includes('macro-')) candidates.push('macro');
    if (slug.startsWith('wiki/geography') || slug.includes('/geography/') || slug.includes('geography-')) candidates.push('geography');
    if (slug.startsWith('wiki/tactics') || slug.includes('/tactics/') || slug.includes('tactics-')) candidates.push('tactics');
    if (slug.startsWith('wiki/ai/') || slug.includes('/ai-') || slug.includes('-ai-')) candidates.push('ai');
  }
  // Holder hint: 'world' takes vs 'people/...' takes give different bias surfaces.
  for (const member of [finding.a, finding.b]) {
    if (member.holder && member.holder.startsWith('people/')) candidates.push('founder-behavior');
  }
  // Return the first candidate (most specific match shown first).
  return candidates[0] ?? '';
}

/** One-line operator-facing string. */
export function buildBiasContextString(
  tag: string,
  finding: ContradictionFinding,
  profile: CalibrationProfileRow,
): string {
  const brierStr = profile.brier !== null ? ` (Brier ${profile.brier.toFixed(2)})` : '';
  return (
    `This contradiction fits your active bias pattern "${tag}"${brierStr}. ` +
    `Verdict: ${finding.verdict}; severity: ${finding.severity}. ` +
    `Consider reviewing both sides through the lens of that pattern.`
  );
}
