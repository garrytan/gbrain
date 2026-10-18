/**
 * Deterministic work counters for the secret scanner (wave 16 G4.1; the
 * write gate's `WriteGateWork` shape, #6490). A caller passes `work` on
 * `ScanOpts`/`RedactOpts` and reads back what the scan did, counted at the
 * sites that do the work: each regex `exec`, each candidate a pattern
 * returned, each character handed to the entropy gate (inside
 * `correctedEntropy`, so a second entropy call per candidate doubles
 * `gateChars`), each validate call, each claimed span, each union split and
 * each echo sweep. The same text gives the same counts on every machine, so
 * a test can pin them exactly where a wall-clock bound could only flake.
 * Per-character cost inside one call (the entropy histogram, a regex's
 * backtracking) is not countable here; the perf file's absolute bounds are
 * the only guard for that.
 */
export interface ScanWork {
  /** Lines the per-line loop looked at (after the short-line skip). */
  linesScanned: number;
  /** Characters of those lines. */
  lineChars: number;
  /** Regex `exec` calls over the per-line patterns, matches and the final null alike. */
  regexExecs: number;
  /** Matches a pattern returned, per pattern name, before any gate. */
  candidates: Record<string, number>;
  /** Characters handed to `correctedEntropy`. */
  gateChars: number;
  /** Candidates that passed the entropy gate. */
  gatePassed: number;
  /** `validate` calls. */
  validateCalls: number;
  /** Spans claimed on a line (reported or not). */
  claims: number;
  /** Candidates that overlapped an earlier claim and were split into their unclaimed sub-ranges. */
  unionSplits: number;
  /** `applyRedaction` echo sweeps started (one per call with a non-empty dictionary). */
  echoSweeps: number;
}

export function createScanWork(): ScanWork {
  return { linesScanned: 0, lineChars: 0, regexExecs: 0, candidates: {}, gateChars: 0, gatePassed: 0, validateCalls: 0, claims: 0, unionSplits: 0, echoSweeps: 0 };
}
