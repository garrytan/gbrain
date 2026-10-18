/**
 * Short codes (2 or 3 characters) an entity page declares for itself: "Also
 * called JOF in my notes", "Acme Example, a.k.a. ACX", "Account code: ACX".
 * Names under 4 characters are otherwise never derived or linked (too many
 * false matches), so a code is kept only when its own page declares it with
 * an explicit alias cue or label (mentions/aliases.ts) and it passes this
 * shape and stoplist. It then links case-sensitively, as a whole token, like
 * every single-token declared alias (by-mention.ts).
 *
 * Leaf module: aliases.ts and by-mention.ts both read it, and aliases.ts
 * imports by-mention.ts.
 */

/** 2-3 letters or digits with at least one capital letter: `JOF`, `A1`, `Wx`, `3M`. */
const SHORT_CODE_RE = /^(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{2,3}$/;

/**
 * Capitalized English words, everyday abbreviations and business acronyms
 * that read as a code but name no particular entity. Compared upper-cased, so
 * `It`, `Us` and `Ok` are rejected too.
 */
export const SHORT_CODE_STOPLIST: ReadonlySet<string> = new Set([
  'AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'GO', 'HE', 'IF', 'IN', 'IS', 'IT', 'ME', 'MY', 'NO', 'OF', 'OH', 'OK', 'ON', 'OR',
  'SO', 'TO', 'UP', 'US', 'WE', 'AND', 'ANY', 'ARE', 'BUT', 'CAN', 'FOR', 'HER', 'HIM', 'HIS', 'HOW', 'ITS', 'NEW', 'NOT',
  'NOW', 'OLD', 'ONE', 'OUR', 'OUT', 'SHE', 'THE', 'TWO', 'WAS', 'WHO', 'WHY', 'YES', 'YOU',
  'AI', 'ML', 'IT', 'HR', 'PR', 'QA', 'VP', 'GM', 'PM', 'AM', 'ID', 'IP', 'OS', 'TV', 'UI', 'UX', 'CS', 'EU', 'UK', 'UN',
  'USA', 'CEO', 'CFO', 'CTO', 'COO', 'CMO', 'CPO', 'CRO', 'SVP', 'EVP', 'API', 'SDK', 'SSO', 'SOC', 'PDF', 'FAQ', 'ETA',
  'FYI', 'TBD', 'ARR', 'MRR', 'KPI', 'OKR', 'NDA', 'LOI', 'IPO', 'B2B', 'B2C', 'SLA', 'CRM', 'ERP', 'SEO', 'ROI', 'MVP',
  'URL', 'APP', 'DM', 'PO', 'HQ', 'EOD', 'EOW', 'OOO', 'ASAP',
]);

/** Whether `text` is a short code that may become a declared alias (shape and stoplist). */
export function isShortCode(text: string): boolean {
  return SHORT_CODE_RE.test(text) && !SHORT_CODE_STOPLIST.has(text.toUpperCase());
}
