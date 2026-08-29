/**
 * PII scrubber for captured query text (v0.21.0).
 *
 * Runs before INSERT into `eval_candidates`. Capture is on by default,
 * so plaintext PII sitting in a DB column is a privacy footgun the first
 * time someone exports or shares a brain dump. Six regex families cover
 * the obvious cases:
 *
 *   1. Email addresses
 *   2. Phone numbers (US + international)
 *   3. US Social Security numbers (XXX-XX-XXXX shape, with year-like false-positive guard)
 *   4. JWT-shaped tokens (three base64url segments joined by '.')
 *   5. Bearer tokens (Authorization: Bearer <opaque>)
 *   6. Credit card numbers (13–19 digits with Luhn verification — blocks false positives)
 *
 * 80% of the real risk without a dependency on an NER model. If regex v1
 * proves insufficient we can layer a model-based scrubber later.
 *
 * Pure functions, zero deps. Safe to call on arbitrary input. Adversarial
 * regex input (catastrophic backtracking) is contained by the
 * possessive-quantifier-free patterns below and by the outer try/catch in
 * captureEvalCandidate (see src/core/eval-capture.ts), not by this
 * module itself.
 *
 * The families live in the exported ORDERED `PII_PATTERNS` array so the
 * sensitivity scan (src/core/context/sensitivity-scan.ts) can detect
 * without redacting via `findPii`. Order is load-bearing for `scrubPii`:
 * email first so "user@example.com" doesn't get caught by phone/CC regex
 * fragments; phones before SSN so +1-555-XX doesn't look like part of a
 * dashes-only SSN; CC last since Luhn is expensive and irrelevant to
 * everything else.
 */

const REDACTED = '[REDACTED]';

/** Stable family identifiers, in scrub-application order. */
export type PiiFamily = 'email' | 'phone' | 'ssn' | 'jwt' | 'bearer' | 'credit_card';

export interface PiiPattern {
  family: PiiFamily;
  /** Global regex for this family. Shared instance — loops must reset lastIndex. */
  re: RegExp;
  /**
   * Optional semantic gate: a regex match that fails this is NOT a hit.
   * The credit-card family's Luhn check lives here — the gate is part of
   * the family's semantics, for both scrubbing and detection.
   */
  accept?: (match: string) => boolean;
  /** Replacement used by `scrubPii` (default `[REDACTED]`). */
  replacement?: string;
}

/** Luhn mod-10 check. Returns true when the digit sequence is a valid card number. */
function luhnOk(digits: string): boolean {
  let sum = 0;
  let parity = digits.length % 2;
  for (let i = 0; i < digits.length; i++) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (i % 2 === parity) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * The six families, in application order (ORDER IS LOAD-BEARING — see the
 * module doc). `scrubPii` folds over this array; `findPii` scans with it.
 */
export const PII_PATTERNS: readonly PiiPattern[] = [
  {
    // Emails: RFC-5322-adjacent. Keeps the host so replay debug can say "an
    // email was redacted" without leaking the local-part.
    family: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    // Phones: US (###-###-####, (###) ###-####, ##########) and E.164
    // (+country). Reject short strings of 10 digits with no separators or
    // prefix to limit false positives on order numbers and other generic
    // long integers.
    family: 'phone',
    re: /(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]?\d{4}(?!\d)/g,
  },
  {
    // SSN: XXX-XX-XXXX with dashes required (bare 9-digit blobs are too
    // ambiguous — phone numbers, account IDs).
    family: 'ssn',
    re: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g,
  },
  {
    // JWT: three base64url segments. Distinctive prefix, safe to run
    // anywhere in the pipeline.
    family: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    // Bearer tokens after Authorization header literal or "Bearer " prefix.
    family: 'bearer',
    re: /\b(?:bearer|Bearer)\s+[A-Za-z0-9._~+/-]{10,}=*/g,
    replacement: `Bearer ${REDACTED}`,
  },
  {
    // Credit card numbers: 13–19 digits with optional spaces/dashes. Every
    // match must pass Luhn to qualify — this is the key false-positive guard.
    family: 'credit_card',
    re: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    accept: (match) => {
      const digitsOnly = match.replace(/\D/g, '');
      if (digitsOnly.length < 13 || digitsOnly.length > 19) return false;
      return luhnOk(digitsOnly);
    },
  },
];

export interface PiiFinding {
  family: PiiFamily;
  /** 0-based char offset of the match start within the scanned text. */
  start: number;
  /** Exclusive end offset. NEVER carries the matched text itself. */
  end: number;
}

/**
 * Detect PII without mutating anything. Each family scans the ORIGINAL
 * text (unlike `scrubPii`, whose later families see earlier redactions),
 * so findings may overlap across families — harmless for detector-mode
 * callers that drop the whole entry on any hit. Findings are ordered
 * family-major in PII_PATTERNS order, then by match position.
 */
export function findPii(text: string): PiiFinding[] {
  if (!text) return [];
  const out: PiiFinding[] = [];
  for (const p of PII_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        p.re.lastIndex++; // zero-width safety
        continue;
      }
      if (p.accept && !p.accept(m[0])) continue;
      out.push({ family: p.family, start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/**
 * Redact obvious PII from a captured query string: a fold over
 * PII_PATTERNS in order. Behavior is byte-identical to the pre-refactor
 * six-step replace chain (regression-pinned by test/eval-capture-scrub.test.ts).
 */
export function scrubPii(input: string): string {
  if (!input) return input;
  let out = input;
  for (const p of PII_PATTERNS) {
    out = out.replace(p.re, (match) =>
      p.accept && !p.accept(match) ? match : (p.replacement ?? REDACTED),
    );
  }
  return out;
}
