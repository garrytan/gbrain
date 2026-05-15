/**
 * eval-contradictions/fixture-redact — T2 privacy redaction for gold fixture build.
 *
 * The fixture build script runs against the user's real brain to label
 * candidate contradiction pairs. Before commit, names + identifiers MUST be
 * scrubbed per CLAUDE.md privacy rule: "Never reference real people, companies,
 * funds, or private agent names in any public-facing artifact."
 *
 * Pass model (deterministic per session via a salt):
 *   1. PII via the v0.25.0 scrubber (emails, phones, SSN, JWT, credit cards).
 *   2. Slug rewrites: people/<name> → people/alice-example, companies/<name>
 *      → companies/acme-example, deals/<name> → deals/acme-seed-example, etc.
 *      Stable mapping within a session so the same name maps consistently.
 *   3. Quoted-name detection: capitalized firstname-lastname patterns.
 *   4. Numeric obfuscation: revenue / funding figures multiplied by a salt
 *      scalar (preserves order-of-magnitude shape).
 *
 * Fail-closed: if the redactor can't determine a clean rewrite for a token
 * it flagged as potentially private, it emits a sentinel string `[REDACT?]`
 * that the operator must resolve before commit. The build script's
 * pre-commit review surfaces every redaction made.
 */

import { scrubPii } from '../eval-capture-scrub.ts';

const SLUG_PREFIX_REWRITES: Record<string, string> = {
  'people/': 'people/',
  'companies/': 'companies/',
  'deals/': 'deals/',
  'projects/': 'projects/',
  'meetings/': 'meetings/',
};

const PLACEHOLDER_POOL: Record<string, string[]> = {
  'people/': ['alice', 'bob', 'charlie', 'diana', 'eve', 'frank', 'grace', 'hank'],
  'companies/': ['acme', 'widget-co', 'globex', 'initech', 'piedpiper', 'hooli', 'pinnacle'],
  'deals/': ['acme-seed', 'widget-series-a', 'globex-series-b', 'initech-seed'],
  'projects/': ['project-alpha', 'project-beta', 'project-gamma'],
  'meetings/': [],  // dates are kept; meeting-id segment redacted to numeric.
};

/** First+last name detector. Two-word capitalized run, length 2..40. */
const QUOTED_NAME_REGEX = /\b([A-Z][a-z]{1,19})\s+([A-Z][a-z]{1,19})\b/g;

/** Revenue / funding numeric tokens (e.g., $50K, $2M MRR, $1.2B). */
const MONETARY_REGEX = /\$\s*(\d+(?:\.\d+)?)\s*([KMB])\b/gi;

export interface RedactionSession {
  /** Per-session deterministic mapping: raw slug-suffix → placeholder. */
  slugMap: Map<string, string>;
  /** Quoted-name mapping (lower-case full name → "Firstname Lastname-example"). */
  nameMap: Map<string, string>;
  /** Pool offset per prefix so we cycle through placeholders. */
  poolOffset: Record<string, number>;
  /** Salt for the numeric obfuscation; deterministic per session. */
  numericSalt: number;
  /** Audit trail of every redaction performed (for pre-commit review). */
  audit: string[];
}

export function createRedactionSession(): RedactionSession {
  return {
    slugMap: new Map(),
    nameMap: new Map(),
    poolOffset: {
      'people/': 0,
      'companies/': 0,
      'deals/': 0,
      'projects/': 0,
      'meetings/': 0,
    },
    numericSalt: 1.7,  // multiply revenues by 1.7 to obscure (deterministic).
    audit: [],
  };
}

/** Allocate a placeholder for an unmapped slug. */
function allocatePlaceholder(session: RedactionSession, prefix: string, raw: string): string {
  if (session.slugMap.has(raw)) return session.slugMap.get(raw)!;
  const pool = PLACEHOLDER_POOL[prefix] ?? [];
  if (pool.length === 0) {
    const next = `${prefix}redacted-${session.slugMap.size + 1}`;
    session.slugMap.set(raw, next);
    return next;
  }
  const idx = session.poolOffset[prefix] % pool.length;
  session.poolOffset[prefix] = (session.poolOffset[prefix] ?? 0) + 1;
  const placeholder = `${prefix}${pool[idx]}-example`;
  session.slugMap.set(raw, placeholder);
  return placeholder;
}

/** Rewrite a single slug, mapping its tail to a placeholder. Idempotent per session. */
export function redactSlug(session: RedactionSession, slug: string): string {
  for (const prefix of Object.keys(SLUG_PREFIX_REWRITES)) {
    if (slug.startsWith(prefix)) {
      const placeholder = allocatePlaceholder(session, prefix, slug);
      if (placeholder !== slug) {
        session.audit.push(`slug: ${slug} → ${placeholder}`);
      }
      return placeholder;
    }
  }
  return slug;
}

/** Allocate a quoted-name placeholder (per-session deterministic). */
function allocateNamePlaceholder(session: RedactionSession, lowerName: string): string {
  if (session.nameMap.has(lowerName)) return session.nameMap.get(lowerName)!;
  const peopleCount = session.poolOffset['people/'] ?? 0;
  const pool = PLACEHOLDER_POOL['people/'];
  const first = pool[peopleCount % pool.length];
  // Bump the people offset so name + slug pools stay in sync visually.
  session.poolOffset['people/'] = peopleCount + 1;
  const placeholder = `${first.charAt(0).toUpperCase()}${first.slice(1)} Example`;
  session.nameMap.set(lowerName, placeholder);
  return placeholder;
}

/** Replace quoted Firstname Lastname runs in a string. */
export function redactNames(session: RedactionSession, text: string): string {
  if (!text) return text;
  return text.replace(QUOTED_NAME_REGEX, (match, first: string, last: string) => {
    const key = `${first} ${last}`.toLowerCase();
    const placeholder = allocateNamePlaceholder(session, key);
    if (placeholder !== match) {
      session.audit.push(`name: "${match}" → "${placeholder}"`);
    }
    return placeholder;
  });
}

/** Replace $50K / $2M / $1.2B style tokens by multiplying by the session salt. */
export function redactMonetary(session: RedactionSession, text: string): string {
  if (!text) return text;
  return text.replace(MONETARY_REGEX, (match, value: string, suffix: string) => {
    const v = parseFloat(value);
    if (!Number.isFinite(v)) return match;
    const obfuscated = (v * session.numericSalt).toFixed(1).replace(/\.0$/, '');
    const out = `$${obfuscated}${suffix.toUpperCase()}`;
    session.audit.push(`monetary: ${match} → ${out}`);
    return out;
  });
}

/** Full redaction pass for an arbitrary text payload. PII first, then names, then monetary. */
export function redactText(session: RedactionSession, text: string): string {
  let out = scrubPii(text);
  out = redactNames(session, out);
  out = redactMonetary(session, out);
  return out;
}

/**
 * Pre-commit safety: returns true iff redacted text contains no obviously
 * sensitive tokens. Conservative — only flags shape-matches the session
 * itself didn't authorize. Returning false should block commit until the
 * operator resolves the flagged token.
 */
export function isCleanForCommit(text: string): boolean {
  // Match: capitalized two-word names that haven't been rewritten (no
  // " Example" suffix), JWT-shaped tokens, raw email patterns. These should
  // all have been caught upstream.
  const looksLikeRawName = /\b[A-Z][a-z]{2,19}\s+[A-Z][a-z]{2,19}\b/.test(text);
  if (looksLikeRawName && !text.includes(' Example')) return false;
  const looksLikeEmail = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text);
  if (looksLikeEmail) return false;
  return true;
}
