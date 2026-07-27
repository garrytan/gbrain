/**
 * skill-frontmatter.ts — Single content-based parser for SKILL.md YAML
 * frontmatter, shared by `filing-audit.ts` (writes_pages / writes_to audit)
 * and `skill-brain-first.ts` (brain_first compliance check).
 *
 * The pre-existing `parseFrontmatter` in `filing-audit.ts` was private +
 * path-based (took an absolute path, returned `SkillFrontmatter` or null).
 * Two problems for v0.36.x brain-first work:
 *   1. Path-based callers can't unit-test against in-memory fixtures
 *      without temp directories. Content-based parsing keeps tests pure.
 *   2. The two consumers grew different field needs (`tools:` for brain-
 *      first, `writes_pages`/`writes_to` for filing). One parser is the
 *      right abstraction; duplicating it across modules guarantees drift.
 *
 * Behavior:
 *   - Tolerant on unknown keys (returns what it parses; ignores the rest).
 *   - STRICT on the v0.36.x `brain_first:` field: only the canonical
 *     `brain_first: exempt` (lowercase snake_case key, lowercase unquoted
 *     value) sets `brain_first`. Near-misses (`brain-first`, `BrainFirst`,
 *     `brain_first: 'exempt'`) populate `brain_first_typo` for doctor to
 *     surface as a paste-ready fix hint.
 *   - Returns null when no frontmatter fence is present (no `---`).
 *
 * Strictness rationale (Q3 + F3 from /plan-eng-review 2026-05-19): silent
 * typos are the worst kind. A developer who writes `brain-first: exempt`
 * thinking it works deserves a loud hint pointing at the canonical form,
 * not a silent failure to exempt.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedFrontmatter {
  /** Raw YAML between the `---` fences. Empty string when no fence found. */
  raw: string;
  /** Skill name; the `name:` field. */
  name?: string;
  /** Does this skill write brain pages? */
  writes_pages?: boolean;
  /** Allowed brain-page filing directories. */
  writes_to?: string[];
  /** Does this skill have side effects? Distinct from writes_pages. */
  mutating?: boolean;
  /** Skill tool inventory (e.g. ['search', 'query', 'put_page']). */
  tools?: string[];
  /** Routing triggers list. */
  triggers?: string[];
  /**
   * v0.36.x brain-first declarative opt-out. Only the literal canonical
   * value `'exempt'` (no quotes, lowercase, snake_case key) populates this.
   * Anything else is a typo and goes into `brain_first_typo`.
   */
  brain_first?: 'exempt';
  /**
   * Surfaces near-miss declarations for the doctor typo hint. Examples
   * the typo detector catches:
   *   - `brain-first: exempt`     (kebab-case key)
   *   - `BrainFirst: Exempt`       (camelCase key, capitalized value)
   *   - `brain_first: "exempt"`    (quoted value)
   *   - `brain_first: required`    (unknown value — flagged so we can
   *                                 communicate "only 'exempt' is supported")
   */
  brain_first_typo?: {
    /** Original key as written by the author. */
    key: string;
    /** Original value as written by the author. */
    value: string;
    /** Why this isn't the canonical form. */
    reason: 'noncanonical_key' | 'quoted_value' | 'unknown_value' | 'capitalized_value';
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse SKILL.md content. Returns null when no YAML frontmatter is found.
 *
 * Content-based (no I/O) so callers control how they load files. Pair with
 * `readFileSync(path, 'utf-8')` at the boundary.
 */
export function parseSkillFrontmatter(content: string): ParsedFrontmatter | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const raw = fmMatch[1];
  const out: ParsedFrontmatter = { raw };

  // --- name ---
  const nameMatch = raw.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
  if (nameMatch) out.name = nameMatch[1].trim();

  // --- writes_pages / mutating (booleans) ---
  const wpMatch = raw.match(/^writes_pages:\s*(true|false)\s*$/m);
  if (wpMatch) out.writes_pages = wpMatch[1] === 'true';

  const mutMatch = raw.match(/^mutating:\s*(true|false)\s*$/m);
  if (mutMatch) out.mutating = mutMatch[1] === 'true';

  // --- writes_to / tools / triggers (arrays, inline or block) ---
  out.writes_to = parseArrayField(raw, 'writes_to');
  out.tools = parseArrayField(raw, 'tools');
  out.triggers = parseArrayField(raw, 'triggers');

  // --- brain_first (strict canonical) ---
  parseBrainFirst(raw, out);

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an array-shaped YAML field that may appear inline (`field: [a, b]`)
 * or as a block list:
 *   field:
 *     - a
 *     - b
 *
 * Returns undefined if the field is absent. Returns [] for an explicitly-
 * empty list (`field: []`).
 *
 * The block matcher uses `^\s+- ` so it won't capture comments or other
 * top-level fields below it. Stops at the first non-indented line.
 */
function parseArrayField(raw: string, field: string): string[] | undefined {
  // Inline form: `field: [a, b, c]` or `field: []`
  const inlineRe = new RegExp(`^${field}:\\s*\\[([^\\]]*)\\]\\s*$`, 'm');
  const inlineMatch = raw.match(inlineRe);
  if (inlineMatch) {
    const inner = inlineMatch[1].trim();
    if (inner.length === 0) return [];
    return inner
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  // Block form: `field:` + indented `- value` lines on subsequent lines.
  const blockRe = new RegExp(`^${field}:\\s*\\n((?:[ \\t]+-[ \\t]+[^\\n]+\\n?)+)`, 'm');
  const blockMatch = raw.match(blockRe);
  if (blockMatch) {
    return blockMatch[1]
      .split('\n')
      .map(l => l.replace(/^[ \t]+-[ \t]+/, '').replace(/^["']|["']$/g, '').trim())
      .filter(Boolean);
  }
  return undefined;
}

/**
 * Strict canonical match for `brain_first:` field. Populates either
 * `out.brain_first = 'exempt'` (canonical hit) or `out.brain_first_typo`
 * (near-miss the developer probably meant to declare).
 *
 * The typo scan is intentionally permissive on the KEY so we catch
 * `brain-first`, `BrainFirst`, etc. — that's where the surprise lives.
 * But the canonical match is strict: only `brain_first: exempt` (case-
 * sensitive key, lowercase unquoted value) sets the typed field.
 */
function parseBrainFirst(raw: string, out: ParsedFrontmatter): void {
  // Scan every line that looks like a brain_first declaration (case-
  // insensitive key, any value). The first match wins; subsequent
  // duplicates are ignored (YAML loaders also take the last; we
  // pick the first for determinism and to make the typo hint specific
  // to what the developer wrote first).
  const typoRe = /^(brain[-_]?first)\s*:\s*(.+?)\s*$/im;
  const typoMatch = raw.match(typoRe);
  if (!typoMatch) return;

  const key = typoMatch[1];
  const valueRaw = typoMatch[2];

  // Canonical key + canonical value?
  if (key === 'brain_first' && valueRaw === 'exempt') {
    out.brain_first = 'exempt';
    return;
  }

  // Key is wrong (case or separator).
  if (key !== 'brain_first') {
    out.brain_first_typo = {
      key,
      value: valueRaw,
      reason: 'noncanonical_key',
    };
    return;
  }

  // Key is canonical; value is wrong. Classify the value.
  // Strip outer quotes for comparison so we can detect quoted variants.
  const unquoted = valueRaw.replace(/^["']|["']$/g, '');
  const wasQuoted = unquoted !== valueRaw;

  if (wasQuoted && unquoted === 'exempt') {
    out.brain_first_typo = {
      key,
      value: valueRaw,
      reason: 'quoted_value',
    };
    return;
  }

  if (unquoted.toLowerCase() === 'exempt') {
    // Capitalized: `Exempt` or `EXEMPT`
    out.brain_first_typo = {
      key,
      value: valueRaw,
      reason: 'capitalized_value',
    };
    return;
  }

  // Some other value (e.g. `required`, `n/a`, `true`). v0.36 ships only
  // 'exempt'; flag everything else as an unknown-value typo so the doctor
  // hint can explain the supported value set.
  out.brain_first_typo = {
    key,
    value: valueRaw,
    reason: 'unknown_value',
  };
}

/**
 * Build a paste-ready fix hint string from a `brain_first_typo` field.
 * Returns null when typo is undefined. The doctor message and the
 * stderr typo warning both consume this so phrasing stays consistent.
 */
export function formatBrainFirstTypoHint(typo: ParsedFrontmatter['brain_first_typo']): string | null {
  if (!typo) return null;
  switch (typo.reason) {
    case 'noncanonical_key':
      return `Found '${typo.key}: ${typo.value}' — did you mean 'brain_first: exempt'? (snake_case key required)`;
    case 'quoted_value':
      return `Found 'brain_first: ${typo.value}' — drop the quotes: 'brain_first: exempt'`;
    case 'capitalized_value':
      return `Found 'brain_first: ${typo.value}' — value must be lowercase: 'brain_first: exempt'`;
    case 'unknown_value':
      return `Found 'brain_first: ${typo.value}' — v0.36 ships only 'brain_first: exempt' (declarative opt-out)`;
  }
}
