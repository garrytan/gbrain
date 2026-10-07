/**
 * secret-scan-labeled.ts: the transcript-lane `labeled_credential` detector
 * (#6147 idea, widened). A low-entropy password typed into a conversation
 * (`password: hunter2`, `login alice / hunter2`) clears neither the vendor
 * shapes nor the entropy-gated assignment heuristic, so it reached the
 * searchable conversation page verbatim.
 *
 * OPT-IN (`ScanOpts.labeledCredentials`): only the transcript page lane and
 * the read-only `gbrain transcripts audit-secrets` audit turn it on. The push
 * gate and every other surface keep it off, because a label is a much weaker
 * signal than a credential's wire shape.
 *
 * Two label classes, each with a bare and a quoted value form:
 *   - SINGLE: `password|passwd|passcode|passphrase|pwd` (optionally behind an
 *     identifier prefix such as `DB_` and inside a quoted JSON key) followed
 *     by `:`, `=` or the full-width `：`. The value after the label is the
 *     secret.
 *   - PAIR: `login|log-in|credentials|creds|user/pass|username/password|…`
 *     followed by `:`, `=`, `：`, ` - ` or nothing, then `<user> / <pass>` or
 *     `<user>:<pass>`. Only the password half is claimed, so the user name
 *     stays readable. A pair whose password starts the next line
 *     (`login: alice /` then `hunter2`) is claimed through the continuation
 *     pattern, which runs only on the line after a dangling pair.
 *
 * False positives are cut by `labeledValueIsCredential`: placeholders,
 * masks, templating, paths, URLs, code references and type names, and a
 * documented stoplist of prose and code words never redact. A pair's password
 * must also carry a letter plus a digit or a symbol, so prose such as
 * `login: Google/GitHub SSO` or `credentials: docs/auth.md` stays intact.
 * Accepted misses: an unquoted multi-word passphrase (`login: alice / pass
 * word`), a delimiter-free single label (`the password is hunter2`), a pair
 * split by anything but one line break, and a meeting link's `?pwd=`
 * passcode (part of a shareable invite URL).
 *
 * Every quantifier is bounded so each candidate start does constant work
 * (pinned in test/secret-scan-perf.test.ts).
 */

const LEFT = '(?:^|[^A-Za-z0-9])';
const LABEL_END = '(?![A-Za-z0-9_-])';
const SINGLE_LABEL = '(?:pass(?:word|wd|code|phrase)|pwd)';
const PAIR_LABEL = '(?:(?:user(?:name)?|login|email)\\s{0,2}/\\s{0,2}pass(?:word|wd)?|log-?in|credentials?|creds)';
const DELIM = '(?:[:=]|\\uFF1A)(?![=>])';
const QUOTE = '["\'`]';
const BARE_VALUE = '[^\\s"\'`]{0,255}[^\\s"\'`.,;:!?)\\]}]';
const BARE_PASS = '[^\\s"\'`/]{0,255}[^\\s"\'`/.,;:!?)\\]}]';
const BARE_END = '(?=[.,;:!?)\\]}]{0,8}(?:\\s|$))';
const QUOTED_VALUE = '[^"\'`\\n]{1,256}';
const BOLD = '(?:\\*{1,2}|_{2})?';
const PAIR_HEAD = `${LEFT}${PAIR_LABEL}${LABEL_END}${BOLD}${QUOTE}?\\s{0,4}(?:${DELIM}|-(?=\\s))?${BOLD}\\s{0,4}`;
const PAIR_USER = `(?:${QUOTE}[^"'\`\\n/]{1,128}${QUOTE}|[^\\s/:"'\`]{1,128})`;
const PAIR_SEP = '(?:\\s{0,4}/\\s{0,4}|:(?![/\\s]))';
const SINGLE_HEAD = `${LEFT}[A-Za-z0-9_]{0,32}${SINGLE_LABEL}${LABEL_END}${BOLD}${QUOTE}?\\s{0,4}${DELIM}${BOLD}\\s{0,4}`;

export interface LabeledPattern {
  source: string;
  form: 'single' | 'pair';
  /** Runs only on the line after one that ends in a dangling pair. */
  continuation?: true;
}

/** Group 1 = everything before the value, group 2 = the value (the scanner's shape). */
export const LABELED_CREDENTIAL_PATTERNS: readonly LabeledPattern[] = [
  { form: 'single', source: `(${SINGLE_HEAD}${QUOTE})(${QUOTED_VALUE})(?=${QUOTE})` },
  { form: 'single', source: `(${SINGLE_HEAD})(${BARE_VALUE})${BARE_END}` },
  { form: 'pair', source: `(${PAIR_HEAD}${PAIR_USER}${PAIR_SEP}${QUOTE})(${QUOTED_VALUE})(?=${QUOTE})` },
  { form: 'pair', source: `(${PAIR_HEAD}${PAIR_USER}${PAIR_SEP})(${BARE_PASS})${BARE_END}` },
  { form: 'pair', continuation: true, source: `(^\\s{0,8}${QUOTE}?)(${BARE_PASS})${BARE_END}` },
];

/** Cheap gate before the label regexes run on a line. */
export const LABELED_PRECHECK_RE = /pass|pwd|log-?in|cred/i;

// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- compile-time literal; bounded quantifiers
const PAIR_DANGLING_RE = new RegExp(`${PAIR_HEAD}${PAIR_USER}\\s{0,4}/\\s{0,4}$`, 'i');

/** True when `line` ends in a pair label and user name with the password on the next line. */
export function endsWithDanglingPair(line: string): boolean {
  return line.includes('/') && LABELED_PRECHECK_RE.test(line) && PAIR_DANGLING_RE.test(line);
}

/**
 * Words that follow a credential label in prose or code without being the
 * credential. Documented in docs/guides/data-ingestion.md ("Credential
 * redaction"). Matched case-insensitively against the whole value.
 */
export const LABELED_STOPLIST: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'not', 'no', 'yes', 'ok', 'okay', 'none', 'null', 'nil', 'n/a', 'na', 'tbd', 'todo',
  'empty', 'blank', 'unknown', 'unset', 'set', 'same', 'hidden', 'redacted', 'masked', 'secret', 'private',
  'required', 'optional', 'missing', 'invalid', 'incorrect', 'wrong', 'expired', 'changed', 'change', 'reset',
  'forgot', 'forgotten', 'updated', 'update', 'new', 'old', 'current', 'default', 'see', 'below', 'above',
  'here', 'there', 'it', 'its', "it's", 'is', 'was', 'be', 'this', 'that', 'these', 'those', 'my', 'your',
  'our', 'their', 'his', 'her', 'any', 'some', 'all', 'one', 'two', 'true', 'false', 'on', 'off', 'enabled',
  'disabled', 'flow', 'page', 'form', 'field', 'screen', 'prompt', 'dialog', 'modal', 'button', 'link', 'email',
  'password', 'passwd', 'passcode', 'passphrase', 'pwd', 'login', 'username', 'user', 'users', 'credentials',
  'creds', 'manager', 'policy', 'rules', 'strength', 'length', 'hint', 'protected', 'protection', 'auth',
  'oauth', 'sso', 'saml', 'ldap', 'mfa', '2fa', 'otp', 'token', 'tokens', 'key', 'keys', 'hash', 'hashed',
  'salt', 'salted', 'encrypted', 'plaintext', 'string', 'str', 'text', 'number', 'int', 'integer', 'bool',
  'boolean', 'bytes', 'object', 'undefined', 'varchar', 'char', 'secretstr', 'type', 'value', 'values',
  'input', 'output', 'example', 'placeholder', 'stdin', 'env', 'environment', 'vault', 'keychain', 'keyring',
  'please', 'enter', 'provide', 'use', 'via', 'from', 'with', 'without', 'for', 'to', 'in', 'of', 'by', 'as',
  'at', 'if', 'when', 'then', 'only', 'also', 'just', 'still', 'again', 'later', 'now', 'needed', 'need',
  'works', 'working', 'failed', 'fails', 'failing', 'error', 'errors', 'broken', 'issue', 'issues', 'support',
  'supported', 'unsupported', 'configured', 'stored', 'saved', 'sent', 'shared', 'rotated', 'rotate', 'revoked',
  'style', 'format', 'syntax', 'mode', 'option', 'options', 'parameter', 'param', 'argument', 'arg',
  'await', 'async', 'function', 'fn', 'lambda', 'return', 'yield', 'typeof', 'const', 'let', 'var', 'def',
  'self', 'cls', 'getpass', 'require', 'import', 'readline', 'ask', 'read',
]);

const PLACEHOLDER_PREFIX_RE = /^(?:<|\[|\{|\$|%|\\|@\{|#\{|\)|\]|\})/;
const MASK_RE = /^[*xX•·.#_-]+$/;
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\//;
const PATH_RE = /^(?:\.{1,2}\/|~\/|\/|[A-Za-z]:[\\/])/;
const DOTTED_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const COMPOUND_IDENTIFIER_RE = /[a-z][A-Z]|_[A-Za-z]/;
const LABEL_WORD_RE = /pass|pwd/i;
const VERSION_RE = /^v?\d+(?:\.\d+)+$/;
const PAIR_SYMBOL_RE = /[0-9!@#$%^&*+=?~]/;
const LETTER_RE = /[A-Za-z]/;

/** Minimum length before a labeled value joins the session-wide echo list. */
export const ECHO_MIN_CHARS_LABELED = 8;

function isStopword(value: string): boolean {
  return LABELED_STOPLIST.has(value.toLowerCase());
}

/** A meeting link's `?pwd=` passcode is part of a shareable invite URL, not a typed credential. */
const QUERY_PWD_RE = /[?&]pwd=$/i;
const LABEL_START_RE = /pass|pwd|log-?in|cred|user|email/i;

/**
 * True when a backtick-"quoted" value is really the close of a code span
 * that holds the label (`` `password=` `` in prose), not a quoted value.
 */
function closesCodeSpan(head: string): boolean {
  const before = head.slice(0, Math.max(0, head.search(LABEL_START_RE)));
  return (before.split('`').length - 1) % 2 === 1;
}

const PAIR_USER_TAIL_RE = /([^\s/:"'`*]+)["'`]?\s*[/:]\s*["'`]?$/;

/**
 * Validate a labeled match's value (`head` is the match text before it):
 * reject placeholders, masks, templating, URLs, paths, code references, code
 * identifiers, type names and stoplisted words. A pair's password (the
 * weaker label) must also be at least 4 characters with a letter and a digit
 * or symbol, and its user half must not be a stoplisted word
 * (`login page / step2`).
 */
export function labeledValueIsCredential(value: string, form: 'single' | 'pair', head = ''): boolean {
  if (value.length < 3 || isStopword(value)) return false;
  if (head.endsWith('`') && closesCodeSpan(head)) return false;
  if (QUERY_PWD_RE.test(head)) return false;
  if (PLACEHOLDER_PREFIX_RE.test(value) || MASK_RE.test(value) || URL_RE.test(value) || PATH_RE.test(value)) return false;
  if (value.includes('(') || DOTTED_IDENTIFIER_RE.test(value)) return false;
  const digitless = !/[0-9]/.test(value);
  if (IDENTIFIER_RE.test(value) && digitless && (LABEL_WORD_RE.test(value) || COMPOUND_IDENTIFIER_RE.test(value))) return false;
  if (form === 'single') return true;
  const user = PAIR_USER_TAIL_RE.exec(head)?.[1];
  if (user !== undefined && isStopword(user)) return false;
  return value.length >= 4 && LETTER_RE.test(value) && PAIR_SYMBOL_RE.test(value) && !VERSION_RE.test(value);
}

/** Echo floor for labeled values: long enough and not a common word. */
export function labeledEchoEligible(value: string): boolean {
  return value.length >= ECHO_MIN_CHARS_LABELED && !isStopword(value) && !/\s/.test(value);
}
