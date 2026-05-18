/**
 * skillpack/harvest-lint.ts — privacy linter for `gbrain skillpack harvest`.
 *
 * Reads `~/.gbrain/harvest-private-patterns.txt` (one regex per line,
 * user-maintained) plus a small built-in default list of patterns that
 * commonly leak when harvesting from a personal fork into gbrain core:
 *
 *   - `\bWintermute\b` — the canonical private fork name (CLAUDE.md
 *     explicitly bans this from gbrain core)
 *   - common email regex
 *   - common Slack channel pattern (`#channel-name`)
 *
 * Matches → throws `PrivacyLintError` with `hits[]` listing each
 * `file:line: matched-pattern` entry. The harvest runner rolls back
 * the copy on this signal.
 *
 * Malformed regex in the patterns file → fail loud at load time so
 * the user fixes their config before any harvest.
 */

import { existsSync, readFileSync } from 'fs';

export class PrivacyLintError extends Error {
  constructor(
    message: string,
    public hits: string[],
  ) {
    super(message);
    this.name = 'PrivacyLintError';
  }
}

export class PrivacyLintConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyLintConfigError';
  }
}

/** Default patterns shipped with gbrain (CLAUDE.md responsible-disclosure rule). */
export const DEFAULT_PRIVATE_PATTERNS: string[] = [
  String.raw`\bWintermute\b`,
  // Email regex (RFC-5322-lite — good enough for harvest-time scrubbing).
  String.raw`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`,
  // Slack channel: whitespace/line-start, then `#alnum-with-dashes` (len ≥ 3).
  String.raw`(?:^|\s)#[a-z0-9][a-z0-9_\-]{2,}\b`,
];

/**
 * Load patterns: user file (if present) + defaults. Each pattern
 * compiled to a global RegExp; malformed regex throws at load time.
 */
export function loadPatterns(patternsPath?: string): Array<{ regex: RegExp; source: string }> {
  const lines: string[] = [];
  if (patternsPath && existsSync(patternsPath)) {
    const raw = readFileSync(patternsPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith('#')) continue; // line comment
      lines.push(trimmed);
    }
  }
  // Append defaults AFTER user patterns so user-defined ones can be
  // tried first (e.g. for performance on patterns the user knows will
  // hit). Order otherwise doesn't matter — we report all hits.
  lines.push(...DEFAULT_PRIVATE_PATTERNS);

  return lines.map(line => {
    try {
      return { regex: new RegExp(line, 'g'), source: line };
    } catch (err) {
      throw new PrivacyLintConfigError(
        `Malformed regex in ${patternsPath ?? '<defaults>'}: ${line} — ${(err as Error).message}`,
      );
    }
  });
}

/**
 * Run the privacy linter against a list of harvested file paths.
 * Throws `PrivacyLintError` (with `hits[]`) on any match. No-op when
 * patterns + files yield zero hits.
 */
export function runPrivacyLint(
  filePaths: string[],
  patternsPath?: string,
): void {
  const patterns = loadPatterns(patternsPath);
  if (patterns.length === 0) return;

  const hits: string[] = [];
  for (const file of filePaths) {
    if (!existsSync(file)) continue;
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, source } of patterns) {
        // Reset lastIndex for global regex re-use across lines.
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          hits.push(`${file}:${i + 1}: matched /${source}/`);
        }
      }
    }
  }

  if (hits.length > 0) {
    throw new PrivacyLintError(
      `Privacy lint found ${hits.length} match(es) in harvested content. Harvest rolled back. Edit your skill, run the editorial genericization, or add a pattern exception to ${patternsPath ?? '~/.gbrain/harvest-private-patterns.txt'}.`,
      hits,
    );
  }
}
