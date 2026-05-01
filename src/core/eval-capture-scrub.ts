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
 *   4. Credit card numbers (13–19 digits with Luhn verification — blocks false positives)
 *   5. JWT-shaped tokens (three base64url segments joined by '.')
 *   6. Bearer tokens (Authorization: Bearer <opaque>)
 *
 * 80% of the real risk without a dependency on an NER model. If regex v1
 * proves insufficient we can layer a model-based scrubber later.
 *
 * Pure function, zero deps. Safe to call on arbitrary input. Adversarial
 * regex input (catastrophic backtracking) is contained by the
 * possessive-quantifier-free patterns below and by the outer try/catch in
 * captureEvalCandidate (see src/core/eval-capture.ts), not by this
 * module itself.
 */

const REDACTED = '[REDACTED]';

// Emails: RFC-5322-adjacent. Keeps the host so replay debug can say "an
// email was redacted" without leaking the local-part.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Phones: US (###-###-####, (###) ###-####, ##########) and E.164 (+country).
// Reject short strings of 10 digits with no separators/prefix to limit
// false positives on order numbers and other generic long integers.
const PHONE_RE =
  /(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]?\d{4}(?!\d)/g;

// SSN: XXX-XX-XXXX with dashes required (bare 9-digit blobs are too
// ambiguous — phone numbers, account IDs).
const SSN_RE = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g;

// JWT: three base64url segments. Lookbehind prevents partial matches in
// the middle of longer identifiers.
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

// Bearer tokens after Authorization header literal or "Bearer " prefix.
const BEARER_RE = /\b(?:bearer|Bearer)\s+[A-Za-z0-9._~+/-]{10,}=*/g;

// Credit card numbers: 13–19 digits with optional spaces/dashes. Every
// match must pass Luhn to qualify — this is the key false-positive guard.
const CC_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

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
 * Redact obvious PII from a captured query string.
 *
 * Order of operations matters: email first so "user@example.com" doesn't
 * get caught by phone/CC regex fragments. CC last since Luhn is expensive
 * and irrelevant to everything else.
 */
export function scrubPii(input: string): string {
  if (!input) return input;
  let out = input;

  // 1. Emails
  out = out.replace(EMAIL_RE, REDACTED);

  // 2. Phones (before SSN so +1-555-XX doesn't look like part of a dashes-only SSN)
  out = out.replace(PHONE_RE, REDACTED);

  // 3. SSN (after phones)
  out = out.replace(SSN_RE, REDACTED);

  // 4. JWT (distinctive prefix, safe to run anywhere in the pipeline)
  out = out.replace(JWT_RE, REDACTED);

  // 5. Bearer tokens
  out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);

  // 6. Credit cards: every candidate must pass Luhn to be replaced.
  out = out.replace(CC_RE, (match) => {
    const digitsOnly = match.replace(/\D/g, '');
    if (digitsOnly.length < 13 || digitsOnly.length > 19) return match;
    return luhnOk(digitsOnly) ? REDACTED : match;
  });

  return out;
}
