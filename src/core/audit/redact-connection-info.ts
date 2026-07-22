/**
 * Shared connection-info redactor (v0.41.22.2).
 *
 * Strips DSNs, credentials, hostnames, and IPv4 octets from text before
 * it lands in an audit JSONL or any other operator-facing surface.
 *
 * Risk model: Postgres errors during connection failures often embed the
 * connection string into the error message:
 *   - `connection to server at "db.example.supabase.com" (1.2.3.4), port 5432 failed: ...`
 *   - `FATAL: password authentication failed for user "postgres"`
 *   - `could not connect to server: postgresql://user:pass@host:5432/db`
 *
 * If an operator pastes a JSONL audit dump into a GitHub issue or Slack,
 * those errors leak credentials. The project's audit-as-debug-tool
 * convention is explicit (`tail -F ~/.gbrain/audit/*`), so the audit
 * channel must be safe to share by construction.
 *
 * Pure function, no I/O. Idempotent (running twice produces same output).
 * Regex compiled once at module load; safe for hot-path use.
 *
 * Wired into BOTH new `lock-renewal-audit.ts` AND existing
 * `batch-retry-audit.ts` (privacy backfill — same risk class).
 */

interface RedactPattern {
  kind: string;
  re: RegExp;
}

/**
 * Pattern order is load-bearing: URL forms come first so substrings
 * inside URLs (`password=`, `host=`) don't get double-redacted by the
 * bare-field matchers. Each pattern uses the global flag so all
 * occurrences in a single string get redacted.
 */
const PATTERNS: ReadonlyArray<RedactPattern> = [
  // postgres:// and postgresql:// URLs. Includes user:pass@host:port/db
  // shapes plus query-string variants. Terminator is whitespace or
  // common JSON/markdown delimiters.
  { kind: 'pg_url', re: /postgres(?:ql)?:\/\/[^\s"'>)]+/gi },

  // password=secret OR pwd=secret. Both Postgres conninfo forms in
  // common use. Value terminates at whitespace, quote, or & (for
  // URL-form query strings already-matched-above as `pg_url`).
  { kind: 'password', re: /(?:password|pwd)\s*=\s*[^\s"'&)]+/gi },

  // user=postgres. Allow lead-by-whitespace OR start-of-string so
  // `user=` isn't false-matched inside arbitrary words like
  // `superuser=...` (which isn't a real conninfo key but defends
  // against future ambiguity).
  { kind: 'user', re: /(?:^|\s)user\s*=\s*[^\s"'&)]+/gi },

  // host=db.example.com. Same lead-anchor rule as `user`.
  { kind: 'host', re: /(?:^|\s)host\s*=\s*[^\s"'&)]+/gi },

  // IPv4 octet pattern. The negative-lookbehind / negative-lookahead
  // for `[\w.@-]` is the load-bearing false-positive defense:
  //   - `v3.1.4.0` — `v` is in `\w`, lookbehind fails, no match.
  //   - `tree-sitter@0.26.3.1` — `@` is in our exclusion set,
  //     lookbehind fails, no match.
  //   - `(192.168.1.42),` — `(` is NOT in `[\w.@-]`, lookbehind
  //     succeeds, `,` is NOT in the exclusion set, lookahead succeeds,
  //     match fires. (Real PG error shape.)
  // The exclusion characters cover the common version-string contexts
  // (word chars, dots, @, -) while leaving whitespace + brackets +
  // parens + commas as legitimate IP delimiters.
  { kind: 'ipv4', re: /(?<![\w.@-])(?:\d{1,3}\.){3}\d{1,3}(?![\w.@-])/g },
];

/**
 * Redact connection info from text. Pure, idempotent, hot-path-safe.
 *
 * @param text - arbitrary string (typically an error message)
 * @returns string with all matched patterns replaced by `<REDACTED:kind>`
 *
 * @example
 * redactConnectionInfo('FATAL: password=hunter2 user=postgres')
 * // → 'FATAL: <REDACTED:password> <REDACTED:user>'
 */
export function redactConnectionInfo(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const { kind, re } of PATTERNS) {
    // Reset lastIndex on each pattern because /g regexes mutate state
    // across calls. Defensive — String.prototype.replace doesn't actually
    // depend on lastIndex, but a future refactor to matchAll() would.
    re.lastIndex = 0;
    out = out.replace(re, ` <REDACTED:${kind}>`);
  }
  return out;
}

/**
 * Exported for tests that want to verify the pattern set hasn't drifted
 * silently. Returning a copy of `kind` labels so a test can assert
 * specific patterns are present without testing the regex internals.
 */
export function getRedactionKinds(): ReadonlyArray<string> {
  return PATTERNS.map((p) => p.kind);
}
