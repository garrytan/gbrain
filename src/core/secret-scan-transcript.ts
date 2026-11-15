/**
 * secret-scan-transcript.ts: the transcript-lane-only (`ScanOpts.transcriptRules`, GST-2768) labeled patterns, compiled
 * for `buildPatterns` in secret-scan.ts. Moved out of secret-scan.ts at its 1500-line module cap; the shapes and their
 * checks live in secret-scan-labeled.ts.
 */
import {
  TRANSCRIPT_LABELED_PATTERNS,
  NETRC_PRECHECK_RE,
  keyLabelValueIsCredential,
  labeledValueIsCredential,
  neutralizeRedactionMarkers,
  type DanglingForm,
} from './secret-scan-labeled.ts';

/** A compiled transcript-lane pattern, in the shape of secret-scan.ts's `CompiledPattern`. */
export interface CompiledTranscriptPattern {
  name: 'labeled_credential';
  re: RegExp;
  continuation?: DanglingForm;
  precheck?: (line: string) => boolean;
  validate: (value: string, head: string) => boolean;
  subject: (line: string) => string;
}

/** `TRANSCRIPT_LABELED_PATTERNS` compiled as `labeled_credential` rules, appended after every other rule. */
export function compileTranscriptPatterns(): CompiledTranscriptPattern[] {
  const out: CompiledTranscriptPattern[] = [];
  for (const p of TRANSCRIPT_LABELED_PATTERNS) {
    out.push({
      name: 'labeled_credential',
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- compile-time literal; bounded quantifiers, pinned by test/secret-scan-perf.test.ts
      re: new RegExp(p.source, 'gi'),
      ...(p.continuation ? { continuation: p.continuation } : { precheck: (line: string) => NETRC_PRECHECK_RE.test(line) }),
      validate: p.form === 'key' ? keyLabelValueIsCredential : (value: string, head: string) => labeledValueIsCredential(value, 'single', head),
      subject: neutralizeRedactionMarkers,
    });
  }
  return out;
}
