/**
 * Output-boundary credential redaction for search and query results.
 *
 * Code repositories and transcripts legitimately contain credential-shaped
 * test fixtures. Retrieval must treat those bytes as sensitive anyway: an
 * agent cannot tell a synthetic fixture from a live key after the value has
 * already reached its transcript. Ranking still uses the original indexed
 * text; only the value returned by CLI/MCP transports is copied and scrubbed.
 */

import type { SearchResult } from '../types.ts';

interface CredentialPattern {
  kind: string;
  pattern: RegExp;
}

// Length caps are deliberately absent. An upper bound followed by `\b` does not
// truncate a longer token — it makes the whole match fail, so a token one
// character past the cap was printed in full.
const CREDENTIAL_PATTERNS: ReadonlyArray<CredentialPattern> = [
  // PEM bodies are matched as "anything that does not start another fence",
  // never as a lazy scan for the END fence. The lazy form was quadratic: a text
  // of N BEGIN fences with no END made each one scan to the end of the text and
  // fail, and the unanchored search then retried from the next one. This body
  // stops at the next BEGIN or END, so the total work is linear in the text.
  //
  // An excerpt can cut a private key before its END fence, and truncation is
  // ordinary here (snippet caps, exact-lookup excerpts), so END is optional for
  // a private key: the key material is removed up to the next fence or the end
  // of the text. It must be preceded by actual key material — optional RFC 1421
  // header lines, then a run of base64 — so a document that merely QUOTES the
  // marker string is not erased from that point on. Runs first, so the complete
  // block below cannot leave a half-matched remainder.
  {
    kind: 'pem_private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[ \t]*\r?\n(?:[A-Za-z][A-Za-z0-9-]*:[^\r\n]*\r?\n)*\s*[A-Za-z0-9+/=]{16,}(?:(?!-----(?:BEGIN|END) )[\s\S])*(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----)?/g,
  },
  // Certificates and public keys keep END as mandatory: truncating one leaks
  // nothing secret, so there is no reason to erase text on a partial match.
  {
    kind: 'pem_key_material',
    pattern: /-----BEGIN [A-Z0-9 ]*(?:PUBLIC KEY|CERTIFICATE|PGP PUBLIC KEY BLOCK)-----(?:(?!-----(?:BEGIN|END) )[\s\S])*-----END [A-Z0-9 ]*(?:PUBLIC KEY|CERTIFICATE|PGP PUBLIC KEY BLOCK)-----/g,
  },
  { kind: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github_fine_grained_token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { kind: 'gitlab_token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'anthropic_api_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai_api_key', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}/g },
  { kind: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'google_api_key', pattern: /\bAIza[A-Za-z0-9_-]{35}/g },
  { kind: 'stripe_live_key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { kind: 'npm_token', pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g },
  { kind: 'huggingface_token', pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: 'sendgrid_api_key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { kind: 'digitalocean_token', pattern: /\bdo[pro]_v1_[a-f0-9]{64}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // `Basic` carries base64 credentials exactly as `Bearer` carries a token, and
  // valid ones can be short (`u:p` is `dTpw`). Inside an actual Authorization
  // header the scheme is unambiguous, so four characters suffice there; the bare
  // `Basic x` / `Bearer x` form keeps a 16-character floor so prose such as
  // "Basic concepts" or "Bearer of bad news" is left alone.
  { kind: 'authorization_credentials', pattern: /\bAuthorization:[ \t]*(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]{4,}/gi },
  { kind: 'authorization_credentials', pattern: /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]{16,}/gi },
  // Only the key material. What follows it on the line is a free-form comment,
  // and in one-line JSON "the rest of the line" is every unrelated field after it.
  {
    kind: 'ssh_public_key',
    pattern: /\b(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/=]{40,}/g,
  },
  // The value is any run of non-space, non-quote characters: a password may start
  // with, or contain, punctuation — including `<`. Unbounded, so a long value
  // leaves no tail. The one thing it will not consume is a marker an earlier
  // pattern already wrote (`<REDACTED:`), which is what keeps redaction
  // idempotent; excluding every `<` for that purpose leaked the rest of any
  // password containing one.
  {
    kind: 'assigned_secret',
    pattern: /["']?\b(?:[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)|token|secret|password|api[_-]?key|private[_-]?key)\b["']?\s*[:=]\s*["']?(?:(?!<REDACTED:)[^\s"'`]){8,}["']?/gi,
  },
  { kind: 'url_credentials', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/gi },
];

export function redactCredentialLikeText(text: string): string {
  if (text.length === 0) return text;
  let redacted = text;
  for (const { kind, pattern } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, `<REDACTED:${kind}>`);
  }
  return redacted;
}

function redactValue<T>(value: T): T {
  if (typeof value === 'string') {
    return redactCredentialLikeText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry)) as T;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactValue(entry);
    }
    return output as T;
  }
  return value;
}

/** Return a redacted copy. Never mutate engine-owned result objects. */
export function redactSearchResults(results: readonly SearchResult[]): SearchResult[] {
  return results.map((result) => redactValue(result));
}

export function credentialRedactionKinds(): readonly string[] {
  return CREDENTIAL_PATTERNS.map(({ kind }) => kind);
}
