/**
 * #9389: opt-in redaction of sign-in secrets in Gmail message bodies. With
 * `google.gmail.redact_credentials` on (default off), the sweep rewrites each
 * body as it is fetched, before it is rendered into a page, chunked, indexed,
 * versioned or quoted into an open loop, so every re-sync writes the same
 * placeholders again. Four kinds, each only where the mail says what it is:
 *   - `[redacted:otp]`: a code next to a one-time-code label ("verification
 *     code", "one-time passcode", "PIN", "Use 739201 to sign in"); a bare
 *     "code" label counts only in a message about signing in or verifying.
 *   - `[redacted:login-link]`: a whole URL that carries a token, in a message
 *     about signing in, resetting a password or verifying an address;
 *     unsubscribe and preference links are kept.
 *   - `[redacted:credential]`: any credential shape the shared secret scanner
 *     (secret-scan.ts) claims.
 *   - `[redacted:password]`: a labelled password (the scanner's
 *     `labeled_credential` rule, plus "your temporary password is X").
 * Matched values are never logged or returned.
 */
import type { BrainEngine } from '../engine.ts';
import { scanTextSpans } from '../secret-scan.ts';
import type { GmailThreadData } from './types.ts';

export const GMAIL_REDACT_CREDENTIALS_KEY = 'google.gmail.redact_credentials';
const ON = new Set(['true', '1', 'on', 'yes']);
const OFF = new Set(['false', '0', 'off', 'no']);

type Kind = 'otp' | 'login-link' | 'credential' | 'password';

const QUALIFIER = String.raw`(?:verification|verify|security|sign[- ]?in|log[- ]?in|login|one[- ]time|single[- ]use|authentication|auth|access|2fa|mfa|otp|two[- ]factor|two[- ]step|2[- ]step)`;
const LABEL = String.raw`(?:${QUALIFIER}\s+(?:pass)?code|one[- ]time\s+(?:password|pin)|passcode|otp|pin(?:\s+code)?)`;
const NOT_OTP_CODE = String.raw`(?:zip|postal|post|area|country|promo|promotional|discount|coupon|voucher|gift|referral|error|status|reference|ref|tracking|product|item|order|booking|confirmation|source|tax|bar|qr|swift|sort|bank|routing|airport|currency|offer|invite|invitation|access)`;
const VALUE = String.raw`(?<v>[A-Za-z]{1,3}-\d{4,10}|\d{2,4}(?:[ -]\d{2,4}){1,2}|(?=[A-Za-z]*\d)[A-Za-z0-9]{4,12})(?![A-Za-z0-9]|[.,:/-]\d)`;
const GAP = String.raw`(?:[^\S\n]+(?:for|from)\b[^\d\n:]{1,40}?)?(?:[^\S\n]*(?:is|was|below|here|:|=|-|–|—))*[^\S\n]*(?:\n[^\S\n]*){0,2}[*_\x60"'“]{0,2}`;
const VALUE_START = String.raw`(?<![A-Za-z0-9#$.,/-])`;
/** `context`: a bare `code` label needs a sign-in or verification message; a reverse form needs that or a qualifier. */
const OTP_PATTERNS: Array<{ re: RegExp; context: 'none' | 'message' | 'qualifier' }> = [
  { re: new RegExp(String.raw`\b${LABEL}\b${GAP}${VALUE}`, 'gid'), context: 'none' },
  { re: new RegExp(String.raw`(?<!\b${NOT_OTP_CODE}[- ]?)\bcode\b${GAP}${VALUE}`, 'gid'), context: 'message' },
  { re: new RegExp(String.raw`${VALUE_START}${VALUE}\s+is\s+(?:your|the)\s+(?:[\w.'-]+\s+){0,3}?(?<q>${QUALIFIER}\s+)?(?:pass)?code\b`, 'gid'), context: 'qualifier' },
  { re: new RegExp(String.raw`\b(?:use|enter|type|input|paste)\s+(?:the\s+|this\s+)?(?:(?:${QUALIFIER}\s+)?code\s+)?${VALUE}\s+(?:to|as|for|when|on|in)\s+(?:[\w'-]+\s+){0,3}?(?:sign|log|verify|confirm|complete|continue|finish|authenticate|reset|access|activate|validate|unlock|(?:pass)?code)`, 'gid'), context: 'none' },
];
const OTP_CONTEXT_RE = /\b(?:verif\w*|sign(?:ing)?[- ]?in|log(?:ging)?[- ]?in|login|one[- ]time|2fa|mfa|two[- ](?:factor|step)|2[- ]step|authenticat\w*|passcode|otp|security code)\b/i;

const LOGIN_CONTEXT_RE = /\b(?:sign(?:ing)?[- ]?in|log(?:ging)?[- ]?in|login|magic[- ]link|reset(?:ting)?\s+(?:your\s+)?password|password\s+reset|forgot\s+(?:your\s+)?password|verify\s+(?:your\s+)?(?:e-?mail|account|address|identity)|confirm\s+(?:your\s+)?(?:e-?mail|account|address|registration|sign[- ]?up)|activate\s+(?:your\s+)?account|e-?mail\s+verification)\b/i;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`()[\]{}]+/gi;
const NOT_LOGIN_LINK_RE = /unsub|opt[-_]?out|preferences|email[-_]?settings|notification[-_]?settings|manage[-_]?(?:subscriptions?|emails?|notifications?)|list-manage/i;
const TOKEN_PARAM_RE = /^(?:token|code|otp|key|auth|sig|signature|hash|nonce|ticket|oobcode|magic|.*(?:token|secret|session).*)$/i;

const PASSWORD_IS_RE = /\b(?:temporary|temp|one[- ]time|initial|new|default|generated)\s+password\s+(?:is|will be)\s*:?\s*(?<v>[^\s"'`]{4,64}?)(?=[.,;:!?)]*(?:\s|$))/gid;

/** Null when `value` is a boolean `config set` accepts for the key; otherwise the refusal (nothing is written). */
export function gmailRedactValueRefusal(value: string): string | null {
  const v = value.trim().toLowerCase();
  return ON.has(v) || OFF.has(v) ? null
    : `${GMAIL_REDACT_CREDENTIALS_KEY} must be true or false (default false: Gmail bodies are stored as they are; got "${value}"). Nothing was written.`;
}

/** Whether this brain redacts Gmail bodies (default off). A failed read throws, so the sweep never writes a body it was told to redact. */
export async function gmailRedactionOn(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  return ON.has(String((await engine.getConfig(GMAIL_REDACT_CREDENTIALS_KEY)) ?? '').trim().toLowerCase());
}

function codeShaped(v: string): boolean {
  const digits = v.replace(/\D/g, '').length;
  if (/^[\d -]+$/.test(v)) return digits >= 4 && digits <= 10;
  if (/^[A-Za-z]{1,3}-\d+$/.test(v)) return true;
  return /\d/.test(v) && /[A-Z]/.test(v) && !/[a-z]/.test(v);
}

function tokenish(v: string): boolean {
  if (v.length < 16 || !/^[A-Za-z0-9_\-.~+=]+$/.test(v) || !/\d/.test(v) || !/[A-Za-z]/.test(v)) return false;
  return !v.split(/[-._]/).some((part) => /^[A-Za-z]{3,}$/.test(part));
}

function isLoginLink(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (NOT_LOGIN_LINK_RE.test(u.pathname + u.search)) return false;
  for (const [k, v] of [...u.searchParams, ...new URLSearchParams(u.hash.slice(1))]) {
    if (/^utm_/i.test(k)) continue;
    if ((TOKEN_PARAM_RE.test(k) && v.length >= 8) || tokenish(v)) return true;
  }
  return u.pathname.split('/').some(tokenish);
}

/**
 * `text` with every labelled one-time code, sign-in link, credential and labelled password replaced by its placeholder.
 * `context` (the subject) only helps decide what the message is about; it is never rewritten.
 */
export function redactMailSecrets(text: string, context = ''): string {
  const about = `${context}\n${text}`;
  const spans: Array<{ start: number; end: number; kind: Kind }> = [];
  const take = (start: number, end: number, kind: Kind): void => {
    if (!spans.some((s) => start < s.end && s.start < end)) spans.push({ start, end, kind });
  };
  if (LOGIN_CONTEXT_RE.test(about)) {
    for (const m of text.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:!?*_]+$/, '');
      if (isLoginLink(url)) take(m.index, m.index + url.length, 'login-link');
    }
  }
  const otpContext = OTP_CONTEXT_RE.test(about);
  for (const { re, context } of OTP_PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (!codeShaped(m.groups!.v!)) continue;
      if (context !== 'none' && !otpContext && (context === 'message' || m.groups!.q === undefined)) continue;
      const [start, end] = m.indices!.groups!.v!;
      take(start, end, 'otp');
    }
  }
  for (const s of scanTextSpans(text, { labeledCredentials: true })) {
    if (s.finding) take(s.start, s.end, s.finding.pattern === 'labeled_credential' ? 'password' : 'credential');
  }
  for (const m of text.matchAll(PASSWORD_IS_RE)) {
    const v = m.groups!.v!;
    if (!/\d|[^A-Za-z0-9-]/.test(v)) continue;
    const [start, end] = m.indices!.groups!.v!;
    take(start, end, 'password');
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + `[redacted:${s.kind}]`;
    at = s.end;
  }
  return out + text.slice(at);
}

/** With `on`, a copy of `thread` whose message bodies went through `redactMailSecrets`; otherwise `thread` itself. */
export function redactThreadBodies(thread: GmailThreadData, on: boolean | undefined): GmailThreadData {
  if (!on) return thread;
  return { ...thread, messages: thread.messages.map((m) => ({ ...m, bodyText: redactMailSecrets(m.bodyText, m.subject) })) };
}
