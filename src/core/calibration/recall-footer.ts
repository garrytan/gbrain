/**
 * v0.36.1.0 (T16) — calibration footer for `gbrain recall` morning pulse.
 *
 * Pure formatter. Given an active calibration profile, returns the
 * conversational block to prepend or append to the recall output:
 *
 *   Calibration this quarter:
 *     Brier 0.18 (was 0.22 90d ago — improving).
 *     Right on early-stage tactics, late on macro by 18 months.
 *     Over-confident on team execution; under-calibrated on regulatory risk.
 *
 *   Threads you opened and never came back to:
 *     · AI search platform differentiation         (17 months silent)
 *     · International expansion playbook           (12 months silent)
 *
 * Cold-brain branch: returns empty string when no profile or
 * insufficient resolved takes. The caller decides whether to prepend
 * the block; cold-brain absence is the cleanest non-event.
 *
 * v0.36.1.0 ship state: opt-in via `gbrain recall --show-calibration`
 * to keep R3 regression posture (existing recall text shape unchanged
 * for users who don't pass the flag). v0.37 defaults to on.
 *
 * Trend computation: v0.36.1.0 has only ONE profile snapshot (the most
 * recent generation). Trend ("was X 90d ago — improving/declining")
 * arrives when we accumulate generated_at history.
 */

import type { CalibrationProfileRow } from '../../commands/calibration.ts';

export interface AbandonedThreadSummary {
  claim: string;
  monthsSilent: number;
}

export interface RecallFooterOpts {
  profile: CalibrationProfileRow | null;
  abandonedThreads?: AbandonedThreadSummary[];
  /** Width hint for column alignment on threads. Default 50. */
  threadColumnWidth?: number;
}

export function buildRecallCalibrationFooter(opts: RecallFooterOpts): string {
  const { profile, abandonedThreads } = opts;
  if (!profile) return '';
  if (profile.total_resolved < 5) return '';

  const lines: string[] = [];
  lines.push('Calibration this quarter:');

  // Brier line. v0.36.1.0 has only the current snapshot — no 90d comparison.
  if (profile.brier !== null) {
    lines.push(`  Brier ${profile.brier.toFixed(2)} ${trendNote(profile.brier)}`);
  }
  // Up to 4 pattern statements. Indent for readability.
  for (const p of profile.pattern_statements.slice(0, 4)) {
    lines.push(`  ${p}`);
  }

  if (abandonedThreads && abandonedThreads.length > 0) {
    lines.push('');
    lines.push('Threads you opened and never came back to:');
    const colWidth = opts.threadColumnWidth ?? 50;
    for (const t of abandonedThreads.slice(0, 5)) {
      const claim = t.claim.length > colWidth ? t.claim.slice(0, colWidth - 1) + '…' : t.claim;
      const padded = claim.padEnd(colWidth, ' ');
      lines.push(`  · ${padded}(${t.monthsSilent} months silent)`);
    }
  }

  return lines.join('\n');
}

function trendNote(brier: number): string {
  // Map Brier to a conversational anchor. No history yet so we describe
  // the absolute value rather than trend.
  if (brier <= 0.1) return '(strong calibration).';
  if (brier <= 0.2) return '(solid).';
  if (brier <= 0.25) return '(near baseline).';
  return '(worse than always-50% baseline — review your high-conviction calls).';
}
