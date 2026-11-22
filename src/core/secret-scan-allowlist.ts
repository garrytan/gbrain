/**
 * The secret-scan allowlist (peeled from secret-scan.ts, wave 16 G4.1, so the scanner stays under the module-size
 * cap): `<workspaceRoot>/.gbrain-scan-allow` entries, the shared glob dialect, and the fingerprint / path checks.
 * `secret-scan.ts` re-exports every public name, so importers of either module see the same surface.
 */
import { existsSync, readFileSync } from 'fs';
import { join, sep } from 'path';

/** Name of the per-workspace allowlist override file. */
export const SCAN_ALLOW_FILENAME = '.gbrain-scan-allow';

/**
 * Load `<workspaceRoot>/.gbrain-scan-allow`: one glob-or-fingerprint per
 * line, `#` comments and blank lines ignored. Absent/unreadable file → []
 * (the shipped default allowlist is EMPTY [CX2-15]).
 */
export function loadWorkspaceAllowlist(workspaceRoot: string): string[] {
  try {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- workspaceRoot is the operator's own workspace path and the file name is a constant; no caller-supplied segment (moved unchanged from secret-scan.ts in wave 16)
    const p = join(workspaceRoot, SCAN_ALLOW_FILENAME);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Minimal anchored glob → RegExp. `**` crosses `/`, `*` stays within a path
 * segment, `?` is one non-slash char. Shared by the scan allowlist and the
 * workspace-push deny-glob backstop (one glob dialect everywhere).
 */
const GLOB_REGEX_CACHE = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(glob);
  if (cached) return cached;
  let g = glob;
  if (g.endsWith('/')) g += '**'; // `foo/` means everything under foo/
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          re += '(?:.*/)?';
          i++;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `re` is built here from the operator's workspace allowlist glob with every non-wildcard character escaped (`*` → `[^/]*`, `**` → `.*`, `?` → `[^/]`); no caller input reaches it (moved unchanged from secret-scan.ts in wave 16)
  const compiled = new RegExp(`^${re}$`);
  GLOB_REGEX_CACHE.set(glob, compiled);
  return compiled;
}

/**
 * Gitignore-flavored match: a glob WITHOUT `/` matches the basename at any
 * depth (`*.pem` catches `sub/dir/key.pem`); a glob WITH `/` is anchored at
 * the workspace root (`.gbrain/**`). Paths are normalized to `/` separators.
 */
export function matchesGlob(glob: string, relPath: string): boolean {
  const norm = relPath.split(sep).join('/');
  if (!glob.includes('/')) {
    const base = norm.slice(norm.lastIndexOf('/') + 1);
    return globToRegExp(glob).test(base);
  }
  return globToRegExp(glob).test(norm);
}

function isFingerprintEntry(entry: string): boolean {
  return entry.startsWith('sha256:');
}

/**
 * Minimum fingerprint-prefix length (hex chars) an allowlist entry must carry
 * to suppress a finding. 16 hex = 64 bits: an 8-hex (32-bit) floor was low
 * enough that a short allowlist entry could collide with an UNRELATED secret's
 * hash and silently un-report it. The emitted fingerprint is exactly 16 hex,
 * so a copy-pasted fingerprint still matches at the floor.
 */
export const ALLOWLIST_FINGERPRINT_MIN_HEX = 16;

/**
 * True when the full sha256 hex of a matched value is allowlisted (≥16-hex
 * prefix). Exported so the sensitivity scan (context/sensitivity-scan.ts)
 * honors the SAME `.gbrain-scan-allow` fingerprint mechanics for its
 * non-secret families (PII, blocklist, pattern-file) — one escape hatch,
 * one dialect.
 */
export function valueAllowlisted(fullHex: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    if (!isFingerprintEntry(entry)) continue;
    const prefix = entry.slice('sha256:'.length).toLowerCase();
    if (prefix.length >= ALLOWLIST_FINGERPRINT_MIN_HEX && fullHex.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * A rule entry, `path:<glob> pattern:<rule>`, allows one named rule in the files the glob matches (the same glob
 * dialect as a path entry); every other rule still applies there. One rule per line. A line that starts with
 * `pattern:`, or with `path:` and holds whitespace, is read only as a rule entry: when it is malformed or names an
 * unknown rule it allows nothing and `allowlistProblems` reports it.
 */
const RULE_ENTRY_RE = /^path:(\S+)\s+pattern:([a-z0-9_]+)$/;

function isRuleEntry(entry: string): boolean {
  return entry.startsWith('pattern:') || (entry.startsWith('path:') && /\s/.test(entry));
}

/** True when a file path is allowlisted by any glob entry. */
export function pathAllowlisted(relPath: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => !isFingerprintEntry(entry) && !isRuleEntry(entry) && matchesGlob(entry, relPath));
}

/** The rule entry that allows `pattern` in `relPath`, or null. */
export function ruleAllowEntry(relPath: string, pattern: string, allowlist: string[]): string | null {
  for (const entry of allowlist) {
    const m = RULE_ENTRY_RE.exec(entry);
    if (m && m[2] === pattern && matchesGlob(m[1]!, relPath)) return entry;
  }
  return null;
}

/** A finding a rule entry allowed, with the entry that allowed it; never the matched value. */
export interface AllowedHit { pattern: string; line: number; fingerprint: string; entry: string }

/** `findings` of the file at `relPath` without those a rule entry allows; each allowed one goes to `onAllowed`. */
export function withoutRuleAllowed<F extends { pattern: string; line: number; fingerprint: string }>(
  findings: F[], relPath: string, allowlist: string[], onAllowed?: (hit: AllowedHit) => void,
): F[] {
  return findings.filter((f) => {
    const entry = ruleAllowEntry(relPath, f.pattern, allowlist);
    if (entry === null) return true;
    onAllowed?.({ pattern: f.pattern, line: f.line, fingerprint: f.fingerprint, entry });
    return false;
  });
}

export interface AllowlistProblem { entry: string; problem: string }

/** Entries that allow nothing, or something other than they seem to: malformed rule entries and unknown rule names. */
export function allowlistProblems(allowlist: string[], knownRules: readonly string[]): AllowlistProblem[] {
  const problems: AllowlistProblem[] = [];
  for (const entry of allowlist) {
    if (isRuleEntry(entry)) {
      const m = RULE_ENTRY_RE.exec(entry);
      if (!m) problems.push({ entry, problem: 'malformed rule entry, so it allows nothing: write path:<glob> pattern:<rule>, one rule per line' });
      else if (!knownRules.includes(m[2]!)) problems.push({ entry, problem: `unknown rule ${m[2]}, so it allows nothing; the rules are ${knownRules.join(', ')}` });
    } else if (entry.startsWith('path:')) {
      problems.push({ entry, problem: 'read as a path glob for files whose name starts with path:, which skips every rule for them; to allow one rule, add a space and pattern:<rule>' });
    }
  }
  return problems;
}
