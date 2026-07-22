/**
 * Operator-extensible literal-substring loader for the content-sanity gate.
 *
 * Reads `~/.gbrain/junk-substrings.txt` (operator-maintained) and returns
 * `OperatorLiteral[]` for `assessContentSanity` to evaluate alongside the
 * built-in junk patterns.
 *
 * Why literals, not regex (D16 + Codex r1 #10):
 *   - JavaScript RegExp has no atomic groups or possessive quantifiers,
 *     so the conventional ReDoS escape hatch isn't available. A reliable
 *     catastrophic-backtracking shape detector is hard to implement.
 *   - Literal substring matching covers the realistic operator use cases
 *     ("add LinkedIn auth wall" = `"sign in to your account"`; "add
 *     Reddit blocked" = `"you're being blocked from accessing"`). No
 *     ReDoS surface. No regex parsing concerns.
 *   - Built-in patterns stay regex because they're hand-vetted; never
 *     run the linter against the operator file shape.
 *
 * Failure handling (D11):
 *   - Missing file (ENOENT) → return empty list. Operator may not have
 *     a file; most don't. Silent fall-through to built-ins only.
 *   - Empty file or all-comments → empty list. Same outcome.
 *   - Malformed line is structurally impossible: every non-comment line
 *     is a valid literal substring. Even regex metacharacters in the
 *     line stay literal at match time (no `new RegExp()` call).
 *
 * File format:
 *   - Blank lines and `#`-prefixed comments ignored.
 *   - Optional directives on the comment line IMMEDIATELY before each
 *     literal: `# name=...`, `# applies_to=body|title|both`. Directives
 *     persist until the next literal is read.
 *   - One literal substring per non-comment line.
 *
 * Example file:
 *
 *     # name=linkedin_auth_wall
 *     # applies_to=body
 *     Sign in to your account to continue
 *
 *     # name=reddit_blocked
 *     You're being blocked from accessing
 *
 *     # name=substack_paywall
 *     # applies_to=both
 *     This post is for paid subscribers
 *
 * Best-effort: a malformed directive (e.g. `# applies_to=invalid`)
 * falls back to the default `'both'` scope without throwing — the
 * operator file is a soft input, not a config file.
 *
 * Default `applies_to` is `'both'` (title AND body head-slice).
 * Default `name` when none is declared is `operator_literal_<index>`
 * so audit JSONL has a stable identifier even for un-named entries.
 */

import { existsSync, readFileSync } from 'fs';
import type { OperatorLiteral } from './content-sanity.ts';

/** Path to the operator literals file. Honors `GBRAIN_HOME` via
 *  `gbrainPath`. Resolved at load time so test fixtures can set
 *  `GBRAIN_HOME` to a tempdir per the test-isolation conventions in
 *  CLAUDE.md. */
function resolveLiteralsPath(): string {
  // Lazy-import to avoid loading config.ts surface for the pure
  // assessor's consumers that only need built-ins.
  const { gbrainPath } = require('./config.ts');
  return gbrainPath('junk-substrings.txt');
}

interface ParsedDirective {
  name?: string;
  applies_to?: 'body' | 'title' | 'both';
}

/** Parse one comment line for known directives. Unknown directives
 *  are ignored (operator file is soft input). Returns empty object
 *  on no match. */
function parseDirectiveLine(line: string): ParsedDirective {
  const stripped = line.replace(/^#\s*/, '').trim();
  // Match `key=value` shape. Allow multiple per line eventually if
  // someone asks; for now one per line is the documented format.
  const m = stripped.match(/^([a-z_]+)\s*=\s*(.+)$/i);
  if (!m) return {};
  const key = m[1].toLowerCase();
  const value = m[2].trim();
  if (key === 'name') return { name: value };
  if (key === 'applies_to') {
    if (value === 'body' || value === 'title' || value === 'both') {
      return { applies_to: value };
    }
  }
  return {};
}

/**
 * Load operator literals. Pure function over file content — the
 * filesystem read is the only side effect. Returns empty list on
 * any failure mode (missing, unreadable, empty, all-comments).
 *
 * Tests pass `content` directly via `parseLiteralsContent` to bypass
 * the FS layer.
 */
export function loadOperatorLiterals(path?: string): OperatorLiteral[] {
  const resolved = path ?? resolveLiteralsPath();
  if (!existsSync(resolved)) return [];
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf-8');
  } catch {
    // Permission denied, transient FS error — treat as missing.
    return [];
  }
  return parseLiteralsContent(raw);
}

/** Pure parser exposed for unit tests. */
export function parseLiteralsContent(raw: string): OperatorLiteral[] {
  const literals: OperatorLiteral[] = [];
  let pending: ParsedDirective = {};
  let unnamedIndex = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      // Blank line: directive scope resets so an empty line between
      // a directive block and a literal doesn't bind the directives.
      // (If you want sticky directives, omit the blank line.)
      pending = {};
      continue;
    }
    if (trimmed.startsWith('#')) {
      // Merge directives so a `# name=...` then `# applies_to=...`
      // pair both bind to the next literal.
      const parsed = parseDirectiveLine(trimmed);
      pending = { ...pending, ...parsed };
      continue;
    }
    // Non-comment, non-blank → literal substring line.
    const name = pending.name ?? `operator_literal_${unnamedIndex++}`;
    literals.push({
      name,
      substring: trimmed,
      applies_to: pending.applies_to ?? 'both',
    });
    // Consume the pending directives so they don't bind to a
    // subsequent literal unless re-declared.
    pending = {};
  }

  return literals;
}
