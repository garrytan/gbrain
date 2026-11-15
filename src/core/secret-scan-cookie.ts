/**
 * secret-scan-cookie.ts: the transcript-lane `cookie_header` rule (GST-2768).
 * A session cookie pasted into an agent session (a curl `-H 'Cookie: …'` or
 * `-b` argument, raw request or response headers, a browser devtools copy, a
 * copy-as-fetch JSON blob) is not a known token shape, so no other rule
 * claimed it and it reached the conversation page verbatim.
 *
 * OPT-IN (`ScanOpts.transcriptRules`): only the transcript page lane and
 * `gbrain transcripts audit-secrets` turn it on; the push gate and every other
 * surface keep it off.
 *
 * After a `Cookie:` header (any case, optionally quoted or JSON-escaped) or a
 * curl `-b` / `--cookie` argument (only after `curl` earlier on the line, so
 * `git checkout -b name=value` is not one), each `name=value` pair separated by `;` is
 * read; only the values are claimed, so cookie names stay readable. After
 * `Set-Cookie:` only the first pair is a cookie: the attributes that follow
 * (`Path=/`, `Max-Age=3600`) are kept. Parsing stops at the first segment
 * that is not `name=value`, so prose (`Cookie: chocolate chip`) is never
 * claimed. Values shorter than 8 characters (preference flags such as
 * `theme=dark`), placeholders (`<…>`, `$VAR`, `{…}`) and masks (`...`, `***`)
 * are left alone. Every quantifier is bounded; the parse is linear in the line.
 */

const COOKIE_HEAD_RE = /(?:(?:^|[^A-Za-z0-9_-])(set-)?cookie\\?["'`]?\s{0,4}:|(?:^|\s)(-b|--cookie)(?=[\s=]))[\s=]{0,4}\\?["'`]?/gi;
const COOKIE_PAIR_RE = /([!#$%&*+.^_|~0-9A-Za-z-]{1,128})=("?)([^\s;"',\\]{0,4096})/y;
const COOKIE_SEP_RE = /\s{0,4};\s{0,4}/y;
const PLACEHOLDER_RE = /^[<$%{[]/;
const CURL_BEFORE_RE = /(?:^|[^A-Za-z0-9_-])curl(?:\.exe)?(?:\s|$)/i;
const MASK_RE = /^[.*xX•_-]+$/;

/** Minimum cookie value length claimed. */
export const COOKIE_VALUE_MIN_CHARS = 8;

/** Cheap gate before the header regex runs on a line. */
export const COOKIE_PRECHECK_RE = /cookie|-b\s/i;

/** The cookie values on `line`: `start` of the value, the value, and `from`, where its header starts. */
export function cookieHeaderValues(line: string): Array<{ start: number; value: string; from: number }> {
  const out: Array<{ start: number; value: string; from: number }> = [];
  COOKIE_HEAD_RE.lastIndex = 0;
  for (let head = COOKIE_HEAD_RE.exec(line); head !== null; head = COOKIE_HEAD_RE.exec(line)) {
    const setCookie = head[1] !== undefined;
    let at = COOKIE_HEAD_RE.lastIndex;
    if (head[2] !== undefined && !CURL_BEFORE_RE.test(line.slice(Math.max(0, head.index - 512), head.index))) continue;
    for (;;) {
      COOKIE_PAIR_RE.lastIndex = at;
      const m = COOKIE_PAIR_RE.exec(line);
      if (m === null) break;
      const quoted = m[2] === '"';
      if (quoted && line[COOKIE_PAIR_RE.lastIndex] !== '"') break;
      const value = m[3]!;
      if (value.length >= COOKIE_VALUE_MIN_CHARS && !PLACEHOLDER_RE.test(value) && !MASK_RE.test(value)) {
        out.push({ start: m.index + m[1]!.length + 1 + m[2]!.length, value, from: head.index });
      }
      if (setCookie) break;
      COOKIE_SEP_RE.lastIndex = COOKIE_PAIR_RE.lastIndex + (quoted ? 1 : 0);
      if (COOKIE_SEP_RE.exec(line) === null) break;
      at = COOKIE_SEP_RE.lastIndex;
    }
    COOKIE_HEAD_RE.lastIndex = Math.max(COOKIE_HEAD_RE.lastIndex, at);
  }
  return out;
}
