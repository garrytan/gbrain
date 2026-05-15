/**
 * eval-contradictions/auto-supersession — M7 resolution proposal generator.
 *
 * For each contradiction finding, classify into a resolution kind and emit
 * a paste-ready CLI command. The probe NEVER auto-applies; the user runs
 * the command themselves. The proposal is descriptive, not directive.
 *
 * Classification logic (deterministic, no LLM):
 *
 *   intra_page_chunk_take pair  → takes_supersede if the take is newer
 *                                  (`since_date` or take row vs chunk),
 *                                  else manual_review.
 *   cross_slug_chunks pair      → dream_synthesize if both sides cite the
 *                                  same canonical-page slug-prefix
 *                                  (companies/, people/, etc.) and one is
 *                                  bulk-tier,
 *                                  → takes_mark_debate if the judge's
 *                                  resolution_kind hinted that direction
 *                                  (e.g., two opinion-shaped pairs), else
 *                                  manual_review.
 *
 * The orchestrator may override these with the judge's `resolution_kind`
 * field when present — the judge has signal we don't.
 */

import type {
  ContradictionFinding,
  ContradictionPair,
  JudgeVerdict,
  ResolutionKind,
} from './types.ts';

export interface ResolutionProposal {
  resolution_kind: ResolutionKind;
  resolution_command: string;
}

const CURATED_ENTITY_PREFIXES = ['companies/', 'people/', 'deals/', 'projects/'];

function isCuratedEntitySlug(slug: string): boolean {
  return CURATED_ENTITY_PREFIXES.some((p) => slug.toLowerCase().startsWith(p));
}

/**
 * Choose a resolution kind for the pair. The judge's hint (when present)
 * wins for cross_slug pairs because it has semantic context this rule-based
 * pass doesn't. For intra_page pairs we trust the structural heuristic since
 * the judge can't see take_id metadata directly.
 */
export function classifyResolution(
  pair: ContradictionPair,
  judgeHint: ResolutionKind | null,
): ResolutionKind {
  if (pair.kind === 'intra_page_chunk_take') {
    // One side is a take (b, by convention in the runner). If the take is
    // active and the chunk text is older, supersede makes sense. We default
    // to takes_supersede; if context is ambiguous the user can pick manual.
    if (pair.b.take_id !== null) return 'takes_supersede';
    if (pair.a.take_id !== null) return 'takes_supersede';
    return 'manual_review';
  }
  // cross_slug: judge hint wins if it's specific.
  if (judgeHint === 'dream_synthesize' || judgeHint === 'takes_mark_debate') {
    return judgeHint;
  }
  if (judgeHint === 'takes_supersede' || judgeHint === 'manual_review') {
    return judgeHint;
  }
  // Structural fallback: if either side is a curated entity page, propose
  // a synthesize run on the curated slug to reconcile.
  if (isCuratedEntitySlug(pair.a.slug) || isCuratedEntitySlug(pair.b.slug)) {
    return 'dream_synthesize';
  }
  return 'manual_review';
}

/**
 * Render the paste-ready CLI command for the chosen resolution. Operator
 * runs this verbatim; the command may itself prompt for confirmation.
 */
export function renderResolutionCommand(
  pair: ContradictionPair,
  kind: ResolutionKind,
): string {
  switch (kind) {
    case 'takes_supersede': {
      // Prefer the slug of the take side (intra_page) or the curated side.
      const takeSide = pair.b.take_id !== null ? pair.b : (pair.a.take_id !== null ? pair.a : pair.a);
      const takeId = takeSide.take_id ?? '<row>';
      return `gbrain takes supersede ${takeSide.slug} --row ${takeId}`;
    }
    case 'dream_synthesize': {
      const curatedSide = isCuratedEntitySlug(pair.a.slug)
        ? pair.a
        : (isCuratedEntitySlug(pair.b.slug) ? pair.b : pair.a);
      return `gbrain dream --phase synthesize --slug ${curatedSide.slug}`;
    }
    case 'takes_mark_debate': {
      const takeSide = pair.b.take_id !== null ? pair.b : (pair.a.take_id !== null ? pair.a : pair.a);
      const takeId = takeSide.take_id ?? '<row>';
      return `gbrain takes mark-debate ${takeSide.slug} --row ${takeId}`;
    }
    case 'manual_review':
    default:
      return `# manual review: ${pair.a.slug} vs ${pair.b.slug}`;
  }
}

/** Convenience: classify + render in one step. */
export function proposeResolution(
  pair: ContradictionPair,
  judgeHint: ResolutionKind | null,
): ResolutionProposal {
  const kind = classifyResolution(pair, judgeHint);
  return {
    resolution_kind: kind,
    resolution_command: renderResolutionCommand(pair, kind),
  };
}

/**
 * Promote a ContradictionPair + JudgeVerdict to a ContradictionFinding by
 * filling in severity/axis/confidence + resolution proposal. Used by the
 * runner aggregation pass.
 */
export function pairToFinding(
  pair: ContradictionPair,
  verdict: JudgeVerdict,
): ContradictionFinding {
  const prop = proposeResolution(pair, verdict.resolution_kind);
  return {
    ...pair,
    severity: verdict.severity,
    axis: verdict.axis,
    confidence: verdict.confidence,
    resolution_kind: prop.resolution_kind,
    resolution_command: prop.resolution_command,
  };
}
