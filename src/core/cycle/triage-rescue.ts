/**
 * triage-rescue.ts — verified-segment rescue for the dream triage gate (F2,
 * eval write-path fix wave).
 *
 * The buried-signal failure mode: a transcript that hides one deeply
 * synthesis-worthy passage inside routine chatter legitimately reads MEDIUM
 * under the whole-transcript rubric (0.30–0.69) and lands under the 0.5 gate
 * — the distiller never fires, and everything salient in that session is
 * lost. Measured on the Cat 35 corpus: every emission miss was this class
 * (scores 0.32–0.42; pure-routine transcripts max ~0.15 and never reach the
 * band).
 *
 *   verdict ──▶ score ≥ threshold ────────────────▶ PASS
 *      │             │ no
 *      │             ▼
 *      │    score ∈ [rescue_floor, threshold)? ──no──▶ REJECT
 *      │             │ yes
 *      │             ▼
 *      │    content_type ∈ allowed AND
 *      │    ≥ min_segments VERIFIED segments? ──no──▶ REJECT (rescue_checked)
 *      │             │ yes
 *      └──────▶ RESCUE PASS (rescued: true)
 *
 * "Verified" is mechanical and $0: a segment counts only when its quote is a
 * normalized substring of the transcript (normalizeForGrounding — the same
 * primitive the quote-repair pass uses), so fabricated judge output can never
 * trigger a rescue. content_type gates out routine/technical; the synthesis
 * prompt's rule D ("write nothing if still routine") is the downstream
 * backstop for the residual false-fire risk.
 *
 * THE ONE GATE RULE: every consumer of the triage decision — runTriagePass
 * (reports/`worth`/telemetry/dry-run), the synthesize fan-out, and
 * `dream retriage` (reconcile-queue cancels + --audit-rejects sampling) —
 * reads passesTriageGate. A second hand-rolled `score >= threshold` check is
 * how an operator sweep ends up cancelling exactly the jobs the rescue
 * admitted.
 *
 * Kill switch: `dream.triage.rescue_min_segments = 0` disables the band
 * entirely (the gate degenerates to the plain threshold check).
 */

import { normForGrounding } from './synthesize-verify.ts';

export const DEFAULT_RESCUE_FLOOR = 0.30;
export const DEFAULT_RESCUE_MIN_SEGMENTS = 2;
/** content_type values eligible for rescue — 'mixed' + borderline score is
 * precisely the buried-signal signature; routine/technical never rescue. */
export const DEFAULT_RESCUE_CONTENT_TYPES: readonly string[] =
  ['mixed', 'reflection', 'idea', 'strategy', 'people'];
/** A "substantive" segment: at least this many normalized chars. Shorter
 * verified quotes (a name, a greeting) are not evidence of buried signal. */
export const MIN_RESCUE_SEGMENT_NORM_CHARS = 40;

export interface RescueConfig {
  /** Band floor (inclusive). Scores below never rescue. */
  floor: number;
  /** Verified-substantive-segment minimum; 0 = rescue disabled. */
  minSegments: number;
  /** Lowercased content_type allowlist. */
  contentTypes: readonly string[];
}

export const DEFAULT_RESCUE_CONFIG: RescueConfig = {
  floor: DEFAULT_RESCUE_FLOOR,
  minSegments: DEFAULT_RESCUE_MIN_SEGMENTS,
  contentTypes: DEFAULT_RESCUE_CONTENT_TYPES,
};

/**
 * Assemble a RescueConfig from the flat SynthTriageConfig knobs — the ONE
 * place the three fields map, so a consumer can't forget one and silently
 * fall back to defaults (the config-side counterpart of the one-gate rule).
 */
export function rescueConfigOf(triage: { rescueFloor: number; rescueMinSegments: number; rescueContentTypes: readonly string[] }): RescueConfig {
  return {
    floor: triage.rescueFloor,
    minSegments: triage.rescueMinSegments,
    contentTypes: triage.rescueContentTypes,
  };
}

/** The verdict fields the gate reads — satisfied by DreamVerdict rows and
 * fresh TriageResult objects alike. */
export interface RescueVerdictLike {
  score: number | null;
  content_type: string | null;
  segments?: ReadonlyArray<{ quote: string }> | null;
}

export interface GateDecision {
  pass: boolean;
  /** True only when the pass came from the rescue band, not the threshold. */
  rescued: boolean;
  /** Verified substantive segments counted (0 when the band never engaged). */
  verified_segments: number;
}

/**
 * Rescue check alone (band + content_type + verified segments). Fail-closed
 * on every malformed shape: null score, missing segments, non-string quotes
 * — no rescue, never a throw.
 */
export function applyTriageRescue(
  v: RescueVerdictLike,
  transcriptContent: string,
  threshold: number,
  cfg: RescueConfig = DEFAULT_RESCUE_CONFIG,
): GateDecision {
  const no = { pass: false, rescued: false, verified_segments: 0 };
  if (cfg.minSegments <= 0) return no;                       // kill switch
  if (v.score === null || !Number.isFinite(v.score)) return no;
  if (v.score >= threshold) return no;                       // band only — at/above is the plain gate's job
  if (v.score < cfg.floor) return no;
  const ct = (v.content_type ?? '').toLowerCase();
  if (!ct || !cfg.contentTypes.includes(ct)) return no;
  const segments = Array.isArray(v.segments) ? v.segments : [];
  if (segments.length === 0) return no;
  const tNorm = normForGrounding(transcriptContent);
  if (tNorm.length === 0) return no;
  // Dedupe by normalized quote: a judge that emits the same passage twice
  // has ONE piece of evidence, not two.
  const seenQuotes = new Set<string>();
  let verified = 0;
  for (const s of segments) {
    if (!s || typeof s.quote !== 'string') continue;
    const q = normForGrounding(s.quote);
    if (q.length >= MIN_RESCUE_SEGMENT_NORM_CHARS && !seenQuotes.has(q) && tNorm.includes(q)) {
      seenQuotes.add(q);
      verified++;
    }
  }
  return { pass: verified >= cfg.minSegments, rescued: verified >= cfg.minSegments, verified_segments: verified };
}

/**
 * THE triage gate. Threshold pass first (cheap, no transcript scan);
 * otherwise the rescue band.
 */
export function passesTriageGate(
  v: RescueVerdictLike,
  transcriptContent: string,
  threshold: number,
  cfg: RescueConfig = DEFAULT_RESCUE_CONFIG,
): GateDecision {
  if (v.score !== null && Number.isFinite(v.score) && v.score >= threshold) {
    return { pass: true, rescued: false, verified_segments: 0 };
  }
  return applyTriageRescue(v, transcriptContent, threshold, cfg);
}
