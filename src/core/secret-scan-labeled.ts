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
 * Wave 12 W4.1 adds: a CLI flag value (`--password X`, `--pass "a b"`;
 * `--password-file` and other suffixed flags are not labels), an env name
 * with a suffix after the label (`PASSWORD_DB=`, `FOO_PASSWORD_BAR=`; a
 * stoplisted suffix such as `_FILE`, `_MIN_LENGTH` or `_HINT` is not a
 * credential), a SINGLE label that ends its line with the value alone on the
 * next line (`password:` then `hunter2`, validated as a single label), and
 * Markdown table cells (`tableCredentialCells`): every cell of a column whose
 * header is a password label, and the value cell of a `| password | X |`
 * key/value row, with escaped pipes, rows without outer pipes and several
 * credential columns.
 *
 * Accepted misses: an unquoted multi-word passphrase (`login: alice / pass
 * word`), a delimiter-free single label (`the password is hunter2`), a pair
 * split by anything but one line break, a concatenated short flag
 * (`mysql -phunter2`: `-p` is a port flag elsewhere) and a meeting link's
 * `?pwd=` passcode (part of a shareable invite URL).
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
const LABEL_SUFFIX = '(?:_[A-Za-z0-9]{1,16}){0,2}';
const SINGLE_HEAD = `${LEFT}[A-Za-z0-9_]{0,32}${SINGLE_LABEL}${LABEL_SUFFIX}${LABEL_END}${BOLD}${QUOTE}?\\s{0,4}${DELIM}${BOLD}\\s{0,4}`;
const CLI_HEAD = '(?:^|\\s)--?(?!(?:no|skip|ask|prompt|reset|show|print|change|check|require)[-_])(?:[A-Za-z0-9]{1,16}[-_]){0,3}(?:pass(?:word|wd|phrase)?|pwd|pw)(?![A-Za-z0-9_=-])\\s{1,4}';
/** openssl's `-passin pass:X` / `-passout pass:X`. */
const OPENSSL_PASS_HEAD = '(?:^|\\s)-pass(?:in|out)\\s{1,4}pass:';

export interface LabeledPattern {
  source: string;
  /** `cli`: a single label written as a command-line flag, whose value never starts with `-` (that is the next flag). */
  form: 'single' | 'pair' | 'cli';
  /** Runs only on the line after one that ends in a dangling label of this form. */
  continuation?: 'single' | 'pair';
}

/** Group 1 = everything before the value, group 2 = the value (the scanner's shape). */
export const LABELED_CREDENTIAL_PATTERNS: readonly LabeledPattern[] = [
  { form: 'single', source: `(${SINGLE_HEAD}${QUOTE})(${QUOTED_VALUE})(?=${QUOTE})` },
  { form: 'single', source: `(${SINGLE_HEAD})(${BARE_VALUE})${BARE_END}` },
  { form: 'pair', source: `(${PAIR_HEAD}${PAIR_USER}${PAIR_SEP}${QUOTE})(${QUOTED_VALUE})(?=${QUOTE})` },
  { form: 'pair', source: `(${PAIR_HEAD}${PAIR_USER}${PAIR_SEP})(${BARE_PASS})${BARE_END}` },
  { form: 'pair', continuation: 'pair', source: `(^\\s{0,8}${QUOTE}?)(${BARE_PASS})${BARE_END}` },
  { form: 'cli', source: `(${CLI_HEAD}${QUOTE})(${QUOTED_VALUE})(?=${QUOTE})` },
  { form: 'cli', source: `(${CLI_HEAD})(${BARE_VALUE})${BARE_END}` },
  { form: 'cli', source: `(${OPENSSL_PASS_HEAD})(${BARE_VALUE})${BARE_END}` },
  // The whole next line is the value (optionally quoted), so prose under a `Password:` heading is never claimed.
  { form: 'single', continuation: 'single', source: `(^\\s{0,8}${QUOTE})(${QUOTED_VALUE})(?=${QUOTE}[,;]?\\s*$)` },
  { form: 'single', continuation: 'single', source: `(^\\s{0,8})(${BARE_VALUE})(?=[.,;]?\\s*$)` },
];

/** Cheap gate before the label regexes run on a line. */
export const LABELED_PRECHECK_RE = /pass|pwd|\bpw\b|log-?in|cred/i;

// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- compile-time literal; bounded quantifiers
const PAIR_DANGLING_RE = new RegExp(`${PAIR_HEAD}${PAIR_USER}\\s{0,4}/\\s{0,4}$`, 'i');
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- compile-time literal; bounded quantifiers
const SINGLE_DANGLING_RE = new RegExp(`${SINGLE_HEAD}$`, 'i');

/** True when `line` ends in a pair label and user name with the password on the next line. */
export function endsWithDanglingPair(line: string): boolean {
  return line.includes('/') && LABELED_PRECHECK_RE.test(line) && PAIR_DANGLING_RE.test(line);
}

/**
 * The label form `line` leaves dangling for the next line: `pair` (`login:
 * alice /`), `single` (`password:` with nothing after it), or null. Only the
 * last 128 characters are tested, so a long line costs constant work.
 */
export function danglingLabel(line: string): 'single' | 'pair' | null {
  if (!LABELED_PRECHECK_RE.test(line)) return null;
  if (endsWithDanglingPair(line)) return 'pair';
  const tail = line.length > 128 ? line.slice(-128) : line;
  return SINGLE_DANGLING_RE.test(tail) ? 'single' : null;
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

/** Env-name suffixes after a password label that name a setting, not the credential (`PASSWORD_FILE`, `PASSWORD_MIN_LENGTH`). */
const SETTING_SUFFIX_RE = /(?:pass(?:word|wd|code|phrase)?|pwd)((?:_[A-Za-z0-9]{1,16}){1,2})(?![A-Za-z0-9_-])[^A-Za-z0-9]*$/i;
const SETTING_SUFFIXES: ReadonlySet<string> = new Set([
  'file', 'path', 'dir', 'hint', 'length', 'len', 'min', 'max', 'policy', 'prompt', 'reset', 'required', 'enabled', 'disabled',
  'cmd', 'command', 'env', 'var', 'name', 'field', 'label', 'url', 'rule', 'rules', 'regex', 'pattern', 'expiry', 'expires',
  'ttl', 'age', 'rounds', 'cost', 'algo', 'algorithm', 'hash', 'salt', 'chars', 'strength', 'history', 'attempts', 'retries', 'auth', 'mode',
]);

/** True when the label in `head` carries a setting suffix (`PASSWORD_MIN_LENGTH=`), so its value is not a credential. */
function settingSuffix(head: string): boolean {
  const m = SETTING_SUFFIX_RE.exec(head);
  return !!m && m[1]!.split('_').some((part) => SETTING_SUFFIXES.has(part.toLowerCase()));
}

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
export function labeledValueIsCredential(value: string, form: 'single' | 'pair' | 'cli', head = ''): boolean {
  if (value.length < 3 || isStopword(value)) return false;
  // A flag's "value" starting with `-` is the next flag; a typed password may start with `-` (W12 S1).
  if (form === 'cli' && value.startsWith('-')) return false;
  // Only a single env-style label carries a setting suffix (`PASSWORD_FILE=`); a pair's user half may look like one (W12 S2).
  if (form === 'single' && settingSuffix(head)) return false;
  if (head.endsWith('`') && closesCodeSpan(head)) return false;
  if (QUERY_PWD_RE.test(head)) return false;
  if (PLACEHOLDER_PREFIX_RE.test(value) || MASK_RE.test(value) || URL_RE.test(value) || PATH_RE.test(value)) return false;
  if (value.includes('(') || DOTTED_IDENTIFIER_RE.test(value)) return false;
  const digitless = !/[0-9]/.test(value);
  if (IDENTIFIER_RE.test(value) && digitless && (LABEL_WORD_RE.test(value) || COMPOUND_IDENTIFIER_RE.test(value))) return false;
  if (form !== 'pair') return true;
  const user = PAIR_USER_TAIL_RE.exec(head)?.[1];
  if (user !== undefined && isStopword(user)) return false;
  return value.length >= 4 && LETTER_RE.test(value) && PAIR_SYMBOL_RE.test(value) && !VERSION_RE.test(value);
}

/** Echo floor for labeled values: long enough and not a common word. */
export function labeledEchoEligible(value: string): boolean {
  return value.length >= ECHO_MIN_CHARS_LABELED && !isStopword(value) && !/\s/.test(value);
}

/** A password-label column header or key cell (`Password`, `DB password`, `pwd`), after stripping Markdown emphasis and a colon. */
const TABLE_LABEL_RE = /^(?:[a-z0-9]{1,32}[ _-])?(?:pass(?:word|wd|code|phrase)|pwd|pw)$/;
const TABLE_SEPARATOR_CELL_RE = /^:?-+:?$/;

interface TableCell { start: number; text: string }

/** Cells of a pipe-table row (escaped `\|` is not a separator); null when the line has no unescaped pipe. */
function tableCells(line: string): TableCell[] | null {
  const cells: TableCell[] = [];
  let from = 0;
  let pipes = 0;
  for (let k = 0; k <= line.length; k++) {
    if (k < line.length && (line[k] !== '|' || (k > 0 && line[k - 1] === '\\'))) continue;
    if (k < line.length) pipes++;
    cells.push({ start: from, text: line.slice(from, k) });
    from = k + 1;
  }
  if (pipes === 0) return null;
  // Outer pipes leave an empty first/last cell.
  if (cells.length > 1 && cells[0]!.text.trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]!.text.trim() === '') cells.pop();
  return cells;
}

function isSeparatorRow(cells: TableCell[] | null): boolean {
  return !!cells && cells.length > 0 && cells.every((c) => TABLE_SEPARATOR_CELL_RE.test(c.text.trim()));
}

function isLabelCell(text: string): boolean {
  // A trailing qualifier names the same column (`Password (prod)`).
  return TABLE_LABEL_RE.test(text.replace(/[*_`]/g, ' ').trim().replace(/:$/, '').replace(/\s*\([^()]{0,64}\)$/, '').replace(/\s+/g, ' ').toLowerCase());
}

/** The value inside a cell: trimmed, without one pair of surrounding backticks or quotes. */
function cellValue(cell: TableCell): { start: number; value: string } | null {
  const lead = cell.text.length - cell.text.trimStart().length;
  let value = cell.text.trim();
  let start = cell.start + lead;
  const q = value[0];
  if (value.length >= 2 && (q === '`' || q === '"' || q === "'") && value[value.length - 1] === q) {
    value = value.slice(1, -1);
    start += 1;
  }
  return value ? { start, value } : null;
}

/** Per-scan table state for `tableCredentialCells`: the credential column indexes of the table the scan is in. */
export interface TableScanState { columns: number[] | null; previous: TableCell[] | null }

export function newTableScanState(): TableScanState {
  return { columns: null, previous: null };
}

/**
 * Credential values in Markdown table row `line` (W4.1): cells under a
 * password-label header column, and the value cell right after a password
 * key cell in a row that is not itself a header. `next` is the following
 * line (a header row is the one above a separator). Linear in the line.
 */
export function tableCredentialCells(line: string, next: string | undefined, state: TableScanState): Array<{ start: number; value: string }> {
  const cells = line.includes('|') ? tableCells(line) : null;
  const out: Array<{ start: number; value: string }> = [];
  if (!cells) {
    state.columns = null;
    state.previous = null;
    return out;
  }
  if (isSeparatorRow(cells)) {
    const header = state.previous;
    state.columns = header ? header.flatMap((c, k) => (isLabelCell(c.text) ? [k] : [])) : null;
    state.previous = null;
    return out;
  }
  state.previous = cells;
  const claim = (cell: TableCell | undefined): void => {
    const v = cell ? cellValue(cell) : null;
    if (v && !isLabelCell(v.value) && labeledValueIsCredential(v.value, 'single')) out.push(v);
  };
  // One Set per row keeps the key/value pass linear in cells (W12 S3).
  const columns = new Set(state.columns ?? []);
  for (const k of columns) claim(cells[k]);
  if (next === undefined || !isSeparatorRow(tableCells(next))) {
    for (let k = 0; k + 1 < cells.length; k++) {
      if (isLabelCell(cells[k]!.text) && !columns.has(k + 1)) claim(cells[k + 1]);
    }
  }
  return out;
}
