/**
 * Write secret guard: an opt-in refusal of remote page writes whose text holds a credential.
 *
 * A brain served to a team over MCP is read by everyone the brain serves and sent to its model providers, so a
 * credential an agent pastes into a page is exposed to all of them. A gateway in front of the brain can scan each
 * tool call, but not a page uploaded in parts (begin_page_upload / upload_page_part / commit_page_upload): a secret
 * split across two parts is in neither call. This guard runs inside gbrain instead, on what the write would store:
 * every string a remote page write's admission carries (preparePageAdmission: put_page, put_pages, edit_page,
 * append_page, capture, add_timeline_entry, takes_*, ...) and the assembled body of an upload at commit, before it
 * is journaled. A refused upload is aborted, so no partial page exists.
 *
 * Off by default. `gbrain config set secrets.on_write refuse` turns it on (DB plane, read per write, no restart);
 * `GBRAIN_SECRETS_ON_WRITE=refuse` turns it on from the environment and can only tighten. Local CLI writes, sync and
 * imports are not guarded: the operator's own files, and the pre-push scan (secrets.on_push) guards what reaches Git.
 *
 * The patterns aim at real credentials, not at writing about them, so environment variable names (SENTRY_DSN),
 * placeholders (<redacted>, ***, xoxb-..., AKIA...EXAMPLE) and code references (password=settings.db) pass. This is
 * deliberately narrower than secret-scan.ts, the push gate's scanner, whose job is to never let a key out: a write
 * refusal that fires on documentation would stop people writing about their own systems. A refusal names only the
 * pattern type, never the matched text.
 */
import { opError, type OperationError } from './ops/contract.ts';

export const SECRETS_ON_WRITE_KEY = 'secrets.on_write';
/** The environment twin of `secrets.on_write`; its one value is `refuse` (it can only tighten). */
export const SECRETS_ON_WRITE_ENV = 'GBRAIN_SECRETS_ON_WRITE';
const DOCS = 'docs/guides/write-refusals.md#secret_in_write';

export interface WriteSecretPattern {
  type: string;
  label: string;
  regex: RegExp;
  /** Given the match, true when it is a real-looking secret (not a placeholder). */
  isReal: (m: RegExpExecArray) => boolean;
}

/** Substrings that mark a value as a placeholder rather than a real secret. */
const PLACEHOLDER_WORDS = ['redacted', 'example', 'placeholder', 'your', 'dummy', 'sample', 'changeme', '<', '>', '{', '}'];

export function isPlaceholder(value: string): boolean {
  const v = value.trim().replace(/^['"`]+|['"`]+$/g, '').trim();
  if (!v) return true;
  const low = v.toLowerCase();
  if (PLACEHOLDER_WORDS.some(word => low.includes(word))) return true;
  if (/^[$%@&]/.test(v) || v.includes('...') || v.includes('…')) return true;
  // ***, xxxxx, ----, 00000: one repeated character (masking).
  return new Set(low.replace(/[-_]/g, '')).size <= 1;
}

const tokenBodyReal = (prefixLength: number) => (m: RegExpExecArray) => !isPlaceholder(m[0].slice(prefixLength));
const always = () => true;

const CODE_REFERENCE = new RegExp('^(?:[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)+' // settings.db_password
  + '|[A-Za-z_][A-Za-z0-9_.]*\\(.*' // getpass(), os.getenv(...)
  + '|[a-z][a-z0-9]*(?:_[a-z0-9]+)+' // db_password (a variable)
  + '|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+' // DB_PASSWORD (an environment variable name)
  + '|str|int|bool|none|null|true|false|optional\\[str\\]|secretstr|string|required|bytes)$', 'i');
const TRIVIAL_PASSWORDS = new Set(['password', 'passwd', 'secret', 'pass', 'pwd', 'test', 'admin', 'postgres', 'user']);

function passwordReal(m: RegExpExecArray): boolean {
  const value = (m.groups?.value ?? '').replace(/^['"`]+|['"`]+$/g, '');
  if (value.length < 6 || isPlaceholder(value) || TRIVIAL_PASSWORDS.has(value.toLowerCase())) return false;
  // A code reference is a whole-value match (Python's re.match on a ^...$ pattern behaves the same).
  return !CODE_REFERENCE.test(value);
}

function uriPasswordReal(m: RegExpExecArray): boolean {
  const value = m.groups?.password ?? '';
  return !(isPlaceholder(value) || TRIVIAL_PASSWORDS.has(value.toLowerCase()));
}

export const WRITE_SECRET_PATTERNS: readonly WriteSecretPattern[] = [
  { type: 'slack_webhook', label: 'a Slack webhook URL',
    regex: /https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{8,}/g,
    // A webhook path has no placeholder form worth allowing: https://hooks.slack.com/services/T000/B000/XXXXXXXX is refused too.
    isReal: m => !isPlaceholder(m[0].split('hooks.slack.com/')[1]!.split('/').slice(1).join('/')) },
  { type: 'slack_token', label: 'a Slack token', regex: /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g, isReal: tokenBodyReal(5) },
  { type: 'sentry_dsn', label: 'a Sentry DSN with its key', regex: /https?:\/\/[0-9a-f]{16,}(?::[0-9a-f]+)?@[A-Za-z0-9.-]*sentry\.io/gi, isReal: always },
  { type: 'sentry_auth_token', label: 'a Sentry auth token', regex: /(?<![A-Za-z0-9])sntry[su]_[A-Za-z0-9+/=_-]{20,}/g, isReal: tokenBodyReal(6) },
  { type: 'github_token', label: 'a GitHub token', regex: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g,
    isReal: m => !isPlaceholder(m[0].startsWith('gh') ? m[0].slice(m[0].indexOf('_') + 1) : m[0].slice(11)) },
  { type: 'google_api_key', label: 'a Google API key', regex: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, isReal: tokenBodyReal(4) },
  { type: 'private_key', label: 'a private key block', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{0,200}?[A-Za-z0-9+/]{40,}/g, isReal: always },
  { type: 'aws_access_key', label: 'an AWS access key', regex: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g, isReal: tokenBodyReal(4) },
  { type: 'jwt', label: 'a JSON Web Token', regex: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, isReal: always },
  { type: 'database_uri_credentials', label: 'a database URI with an inline password',
    regex: /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|mariadb|redis|rediss|amqps?):\/\/(?<user>[^:/\s@]+):(?<password>[^@\s/]+)@/gi, isReal: uriPasswordReal },
  { type: 'password_assignment', label: 'a password assignment',
    regex: /(?<![A-Za-z0-9_])["']?(?:password|passwd|pwd|db_password|db_pass)["']?\s*[:=]\s*(?<value>"[^"\n]*"|'[^'\n]*'|[^\s"',;}[\])]+)/gi, isReal: passwordReal },
];

/** The first pattern found in `text`, or null. */
export function findWriteSecret(text: string): WriteSecretPattern | null {
  for (const pattern of WRITE_SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (let m = pattern.regex.exec(text); m; m = pattern.regex.exec(text)) {
      if (pattern.isReal(m)) { pattern.regex.lastIndex = 0; return pattern; }
      if (m[0].length === 0) pattern.regex.lastIndex++;
    }
  }
  return null;
}

/** Every string in a write's parameters, nested objects and arrays included (keys are not scanned). */
function* strings(value: unknown, depth = 0): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (depth < 16 && Array.isArray(value)) for (const v of value) yield* strings(v, depth + 1);
  else if (depth < 16 && value && typeof value === 'object') for (const v of Object.values(value)) yield* strings(v, depth + 1);
}

/** The first pattern found in any string of a write's parameters, or null. */
export function findWriteSecretIn(params: unknown): WriteSecretPattern | null {
  for (const text of strings(params)) {
    const hit = findWriteSecret(text);
    if (hit) return hit;
  }
  return null;
}

/** A window and the overlap kept from the previous one: longer than any pattern's match, so a seam never hides one. */
const STREAM_WINDOW_CHARS = 1 << 20;
const STREAM_OVERLAP_CHARS = 8192;

/**
 * The first pattern found in a body streamed in byte parts (a page upload's staged parts), or null. Parts are decoded
 * as one UTF-8 stream (a character split across parts is joined) and scanned in overlapping windows, so a secret cut
 * across two parts is found without holding the whole page as one string.
 */
export async function findWriteSecretInParts(parts: AsyncIterable<Uint8Array | null>): Promise<WriteSecretPattern | null> {
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  for await (const part of parts) {
    if (!part) break;
    pending += decoder.decode(part, { stream: true });
    if (pending.length >= STREAM_WINDOW_CHARS) {
      const hit = findWriteSecret(pending);
      if (hit) return hit;
      pending = pending.slice(-STREAM_OVERLAP_CHARS);
    }
  }
  return findWriteSecret(pending + decoder.decode());
}

/** Whether the guard is on: GBRAIN_SECRETS_ON_WRITE=refuse, or `secrets.on_write` set to `refuse` in the brain's config. */
export async function writeSecretGuardOn(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  if (process.env[SECRETS_ON_WRITE_ENV] === 'refuse') return true;
  // A failed config read fails the write (it is not read as "guard off").
  return (await engine.getConfig(SECRETS_ON_WRITE_KEY))?.trim() === 'refuse';
}

/** The refusal: names the pattern type and what to do, never the matched text. */
export function secretInWriteError(pattern: WriteSecretPattern, operation: string): OperationError {
  return opError('secret_in_write', `${operation}: the write contains what looks like ${pattern.label} (${pattern.type}), so nothing was written. This brain refuses secrets in pages (secrets.on_write).`,
    'Remove the secret: name the environment variable or secret-manager entry that holds it, or write <redacted>, then send the write again with a new request_id.',
    { reason: pattern.type, docs: DOCS, why: 'Pages are read by everyone this brain serves and sent to its model providers, so a credential stored in one is exposed to all of them.' });
}

/** Refuses a remote write whose parameters hold a secret while the guard is on. A no-op for local callers. */
export async function assertNoSecretInWrite(ctx: { remote?: boolean; engine: { getConfig(key: string): Promise<string | null> } },
  operation: string, params: unknown): Promise<void> {
  if (ctx.remote === false || !await writeSecretGuardOn(ctx.engine)) return;
  const hit = findWriteSecretIn(params);
  if (hit) throw secretInWriteError(hit, operation);
}
