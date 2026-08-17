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
  Verdict,
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
 *
 * v0.34 / Lane A2: extended with verdict-aware mapping. The new verdicts
 * (temporal_supersession, temporal_regression, temporal_evolution,
 * negation_artifact) have their own resolution_kinds — the v1 four-kind
 * mapping only applies to `verdict === 'contradiction'`. The probe still
 * NEVER auto-mutates; the new kinds render paste-ready commands or
 * informational lines just like the old ones.
 */
export function classifyResolution(
  pair: ContradictionPair,
  judgeHint: ResolutionKind | null,
  verdict: Verdict = 'contradiction',
): ResolutionKind {
  // Verdict-driven routing for the new (non-contradiction) verdicts. The
  // judge hint can still override when it specifies something compatible
  // with the new verdict's scope.
  if (verdict === 'temporal_supersession') {
    return judgeHint === 'flag_for_review' || judgeHint === 'log_timeline_change'
      ? judgeHint
      : 'temporal_supersede';
  }
  if (verdict === 'temporal_regression') {
    // Always flag — no auto-mutation, just surface to the user. A future
    // founder-scorecard surface (Phase 4) consumes the flagged set.
    return 'flag_for_review';
  }
  if (verdict === 'temporal_evolution') {
    return judgeHint === 'flag_for_review' ? 'flag_for_review' : 'log_timeline_change';
  }
  if (verdict === 'negation_artifact') {
    // Informational — the data is correct; the judge misread a negation.
    // Operator action is to wait for the next prompt_version bump.
    return 'flag_for_review';
  }
  // verdict === 'contradiction' (or no_contradiction, which shouldn't reach
  // this fn — runner filters before calling pairToFinding) falls through to
  // the v1 mapping below.
  if (pair.kind === 'intra_page_chunk_take') {
    if (pair.b.take_id !== null) return 'takes_supersede';
    if (pair.a.take_id !== null) return 'takes_supersede';
    return 'manual_review';
  }
  if (judgeHint === 'dream_synthesize') {
    return judgeHint;
  }
  // gbrain#4169: `takes mark-debate` is documented but NOT implemented (the
  // CLI dispatch falls through to the list path and treats "mark-debate" as
  // a slug — tracked with #4102). Minting the kind would lie to JSON
  // consumers about an available action; route to manual_review until the
  // subcommand exists. The enum member stays for legacy stored rows.
  if (judgeHint === 'takes_mark_debate') {
    return 'manual_review';
  }
  if (judgeHint === 'takes_supersede' || judgeHint === 'manual_review') {
    return judgeHint;
  }
  if (isCuratedEntitySlug(pair.a.slug) || isCuratedEntitySlug(pair.b.slug)) {
    return 'dream_synthesize';
  }
  return 'manual_review';
}

/**
 * POSIX single-quote escaping for untrusted text (claim text AND slugs)
 * rendered into a paste-ready command (gbrain#4169): wrap in single quotes;
 * embedded single quotes become the `'\''` splice. Newlines collapse to
 * spaces — a resolution command is one line by contract. Slugs are quoted
 * too: validateSlug leaves shell metacharacters unblocked and remote MCP
 * writers can mint slugs, so an unquoted slug reaches the operator's shell.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/\s+/g, ' ').trim().replace(/'/g, `'\\''`)}'`;
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
      // gbrain#4169: --row takes the PER-PAGE row_num (take_id is the global
      // PK and never resolves), and `takes supersede` REQUIRES --claim — the
      // replacement text. classifyResolution picks an ACTION, not a winner:
      // in a chunk-vs-take pair the chunk side is arbitrary prose, so
      // auto-filling --claim from it would fabricate a take. Render the
      // correctly-addressed command with an explicit placeholder the
      // operator fills in.
      const takeSide = pair.b.take_id !== null ? pair.b : (pair.a.take_id !== null ? pair.a : pair.a);
      const rowNum = takeSide.take_row_num ?? '<row>';
      return `gbrain takes supersede ${shellQuote(takeSide.slug)} --row ${rowNum} --claim '<replacement claim — see contradiction report>'`;
    }
    case 'dream_synthesize': {
      const curatedSide = isCuratedEntitySlug(pair.a.slug)
        ? pair.a
        : (isCuratedEntitySlug(pair.b.slug) ? pair.b : pair.a);
      return `gbrain dream --phase synthesize --slug ${shellQuote(curatedSide.slug)}`;
    }
    case 'takes_mark_debate': {
      // gbrain#4169: this subcommand does not exist (tracked with #4102) —
      // new classifications route to manual_review; this branch only renders
      // for LEGACY stored rows, and must not emit a command that fails.
      const takeSide = pair.b.take_id !== null ? pair.b : (pair.a.take_id !== null ? pair.a : pair.a);
      const rowNum = takeSide.take_row_num ?? '<row>';
      return `# manual review: mark-as-debate is not implemented yet (#4102); take at ${takeSide.slug} row ${rowNum}`;
    }
    case 'temporal_supersede': {
      // v0.34 / Lane A2: pick the newer-dated side as the survivor; render a
      // supersede command on the older-dated side. If both sides have takes
      // we prefer the take that's NOT on the newer page. Falls back to a
      // hint with both slugs when the dates can't be ordered.
      const aDate = pair.a.effective_date;
      const bDate = pair.b.effective_date;
      if (aDate && bDate) {
        const olderSide = aDate < bDate ? pair.a : pair.b;
        const newerSide = aDate < bDate ? pair.b : pair.a;
        const newerDate = aDate < bDate ? bDate : aDate;
        if (olderSide.take_id !== null && olderSide.take_row_num !== null) {
          // gbrain#4169: temporal supersession has a REAL winner (the
          // newer-dated side). When that side is itself a take, its claim is
          // the unambiguous replacement — paste-ready, shell-escaped. When
          // the newer side is a chunk, its text is arbitrary prose:
          // correctly-addressed command with an explicit placeholder.
          const claim = newerSide.take_id !== null
            ? shellQuote(newerSide.text)
            : `'<replacement claim — see contradiction report>'`;
          return `gbrain takes supersede ${shellQuote(olderSide.slug)} --row ${olderSide.take_row_num} --claim ${claim} --since ${newerDate}`;
        }
        return `# temporal_supersession: ${olderSide.slug} (${aDate < bDate ? aDate : bDate}) superseded by ${newerDate}`;
      }
      return `# temporal_supersession: ${pair.a.slug} vs ${pair.b.slug} (date order unclear)`;
    }
    case 'log_timeline_change': {
      // v0.34 / Lane A2: timeline-writer subcommand is deferred (see plan
      // TODOs). Render a hint pointing at the future command shape so the
      // operator can paste a follow-up note manually for now.
      const aDate = pair.a.effective_date ?? '<date-a>';
      const bDate = pair.b.effective_date ?? '<date-b>';
      return `# temporal_evolution: ${pair.a.slug} (${aDate}) → ${pair.b.slug} (${bDate}); record in timeline when the gbrain timeline writer lands`;
    }
    case 'flag_for_review': {
      // v0.34 / Lane A2: informational; covers temporal_regression and
      // negation_artifact. The flag itself surfaces in trends; no command.
      return `# flag_for_review: ${pair.a.slug} vs ${pair.b.slug}`;
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
  verdict: Verdict = 'contradiction',
): ResolutionProposal {
  const kind = classifyResolution(pair, judgeHint, verdict);
  return {
    resolution_kind: kind,
    resolution_command: renderResolutionCommand(pair, kind),
  };
}

/**
 * Promote a ContradictionPair + JudgeVerdict to a ContradictionFinding by
 * filling in verdict/severity/axis/confidence + resolution proposal. Used
 * by the runner aggregation pass.
 *
 * v0.34 / Lane A2: threads the new `verdict: Verdict` enum into the finding
 * shape and the resolution classifier so the new verdicts route correctly.
 */
export function pairToFinding(
  pair: ContradictionPair,
  verdict: JudgeVerdict,
): ContradictionFinding {
  const prop = proposeResolution(pair, verdict.resolution_kind, verdict.verdict);
  return {
    ...pair,
    verdict: verdict.verdict,
    severity: verdict.severity,
    axis: verdict.axis,
    confidence: verdict.confidence,
    resolution_kind: prop.resolution_kind,
    resolution_command: prop.resolution_command,
  };
}
