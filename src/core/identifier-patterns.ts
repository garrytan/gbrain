/**
 * Identifier pattern classes for the canonical scanner (`secret-scan.ts`):
 * the `identifier` class (structured personal and health identifiers) and
 * the `contact` class (email, phone). Both are OFF unless a caller passes
 * `ScanOpts.classes`; the scanner's default stays the `credential` class, so
 * every existing consumer (push gate, bootstrap, retrieval output, transcript
 * ingest) is byte-identical. Policy lives in `redaction-policy.ts`.
 *
 * Every rule follows the `CorePattern` contract: group 1 = anchor, group 2 =
 * value, bounded quantifiers, a `precheck` substring gate where the anchor is
 * a keyword, and a `validate` for the shapes that carry a check digit. The
 * guards are the point: a bare digit run is not an identifier. Context words
 * (`SSN`, `NPI`, `MRN`, `member id`, `DOB`) are part of the anchor and are
 * never claimed as the value, so a redaction leaves `MRN: <REDACTED:mrn>`.
 *
 * Deliberately NOT here: ICD-10 codes (a diagnosis code is content, and a
 * clinic brain searches by it) and bare IP addresses. Credit cards and JWTs
 * belong to the credential class already. Free-text names need a model tier;
 * the regex floor stops at structured identifiers.
 *
 * The rules and their guards were ported from a standalone shadow-mode
 * provider for the observe-only guardrail seam, with its synthetic fixtures.
 */

/** The gbrain version that added the identifier and contact classes. */
export const IDENTIFIER_CLASS_SINCE = '0.60.183.0';

export const IDENTIFIER_PATTERN_NAMES = ['ssn', 'npi', 'dea', 'medicare_mbi', 'mrn', 'dob', 'health_plan_id'] as const;
export const CONTACT_PATTERN_NAMES = ['email', 'phone'] as const;

/** Mirrors `CorePattern` in secret-scan.ts (kept structural so this module imports nothing from it). */
export interface IdentifierPattern {
  name: string;
  source: string;
  prebuilt?: boolean;
  flags?: string;
  precheck?: (line: string) => boolean;
  validate?: (value: string) => boolean;
  since?: string;
}

/** Luhn mod-10 over a digit string (payload + check digit). */
export function luhnOk(digits: string): boolean {
  let sum = 0;
  const parity = digits.length % 2;
  for (let i = 0; i < digits.length; i++) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (i % 2 === parity) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/** NPI check digit: Luhn over the ten digits behind the `80840` issuer prefix. */
export function npiOk(tenDigits: string): boolean {
  return tenDigits.length === 10 && luhnOk('80840' + tenDigits);
}

/** DEA registration checksum: (d1+d3+d5) + 2*(d2+d4+d6), last digit equals d7. */
export function deaOk(value: string): boolean {
  const d = value.slice(-7);
  if (!/^\d{7}$/.test(d)) return false;
  const n = (i: number) => d.charCodeAt(i) - 48;
  return (n(0) + n(2) + n(4) + 2 * (n(1) + n(3) + n(5))) % 10 === n(6);
}

/** A labelled identifier value must carry real digits; `pending` or `n/a` after `member id:` is not one. */
function hasDigits(min: number): (value: string) => boolean {
  return (value) => (value.match(/\d/g)?.length ?? 0) >= min;
}

const B = '(?:^|[^A-Za-z0-9_])';
const SSN_VALUE = '(?!000|666|9\\d\\d)\\d{3}[- ]?(?!00)\\d{2}[- ]?(?!0000)\\d{4}';
// MBI letter positions exclude B, I, L, O, S and Z (the CMS character set).
const MBI_L = '[ACDEFGHJKMNPQRTUVWXY]';
const MBI_AN = '[ACDEFGHJKMNPQRTUVWXY0-9]';

export const IDENTIFIER_PATTERNS: ReadonlyArray<IdentifierPattern> = [
  // Labelled first so `SSN 078051120` (no separators) is claimed; the dashed shape below needs no label.
  {
    name: 'ssn',
    source: `(${B}(?:ssn|social security(?: number| no\\.?| #)?)\\s*[:#]?\\s*)(${SSN_VALUE})(?![0-9-])`,
    prebuilt: true, flags: 'gi',
    precheck: (line) => /ssn|social/i.test(line),
    since: IDENTIFIER_CLASS_SINCE,
  },
  {
    name: 'ssn',
    source: `(^|[^A-Za-z0-9_-])((?!000|666|9\\d\\d)\\d{3}-(?!00)\\d{2}-(?!0000)\\d{4})(?![0-9-])`,
    prebuilt: true,
    precheck: (line) => line.includes('-'),
    since: IDENTIFIER_CLASS_SINCE,
  },
  {
    name: 'npi',
    source: `(${B}npi\\s*(?:#|number|no\\.?)?\\s*[:#=-]?\\s*)(\\d{10})(?![0-9])`,
    prebuilt: true, flags: 'gi',
    precheck: (line) => /npi/i.test(line),
    validate: npiOk,
    since: IDENTIFIER_CLASS_SINCE,
  },
  {
    // Registrant-type letter, a letter or 9, seven digits with the checksum digit last.
    name: 'dea',
    source: '[ABFGMPRX][A-Z9][0-9]{7}(?![0-9A-Za-z])',
    validate: deaOk,
    since: IDENTIFIER_CLASS_SINCE,
  },
  {
    name: 'medicare_mbi',
    source: `[1-9]${MBI_L}${MBI_AN}\\d-?${MBI_L}${MBI_AN}\\d-?${MBI_L}${MBI_L}\\d{2}(?![0-9A-Za-z])`,
    since: IDENTIFIER_CLASS_SINCE,
  },
  {
    name: 'mrn',
    source: `(${B}(?:mrn|medical record(?: (?:number|no\\.?|#))?|patient id|chart (?:number|no\\.?|#))[\\s:#-]*)([A-Z]{0,3}\\d{4,12})(?![0-9A-Za-z])`,
    prebuilt: true, flags: 'gi',
    precheck: (line) => /mrn|medical record|patient id|chart/i.test(line),
    since: IDENTIFIER_CLASS_SINCE,
  },
  {
    name: 'dob',
    source: `(${B}(?:dob|date of birth|birth ?date)[\\s:]*)(\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})|(?:19|20)\\d{2}-\\d{1,2}-\\d{1,2}|[A-Za-z]{3,9} \\d{1,2},? (?:19|20)\\d{2})(?![0-9])`,
    prebuilt: true, flags: 'gi',
    precheck: (line) => /dob|birth/i.test(line),
    since: IDENTIFIER_CLASS_SINCE,
  },
  {
    name: 'health_plan_id',
    source: `(${B}(?:member id|policy (?:number|no\\.?|#)|group (?:number|no\\.?|#)|subscriber id|beneficiary (?:id|number)|medicaid (?:id|number)|insurance id)[\\s:#-]*)([A-Za-z0-9][A-Za-z0-9-]{4,16})(?![0-9A-Za-z])`,
    prebuilt: true, flags: 'gi',
    precheck: (line) => /member|policy|group|subscriber|beneficiary|medicaid|insurance/i.test(line),
    validate: hasDigits(3),
    since: IDENTIFIER_CLASS_SINCE,
  },
];

export const CONTACT_PATTERNS: ReadonlyArray<IdentifierPattern> = [
  {
    name: 'email',
    source: '(^|[^A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\\.[A-Za-z]{2,24})(?![A-Za-z0-9_%+-])',
    prebuilt: true,
    precheck: (line) => line.includes('@'),
    since: IDENTIFIER_CLASS_SINCE,
  },
  {
    // Separators required: a bare ten-digit run is an order number as often as a phone.
    name: 'phone',
    source: '(^|[^0-9A-Za-z])((?:\\+\\d{1,3}[\\s.-]?)?(?:\\(\\d{3}\\)\\s?|\\d{3}[\\s.-])\\d{3}[\\s.-]?\\d{4})(?![0-9])',
    prebuilt: true,
    precheck: (line) => /\d{3}/.test(line),
    since: IDENTIFIER_CLASS_SINCE,
  },
];
