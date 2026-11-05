/**
 * secret-scan-assignment.ts: the opt-in `high_entropy_assignment` rule's
 * shapes and gates (`ScanOpts.highEntropy`), split out of secret-scan.ts at
 * its 1500-line module cap (#7978). secret-scan.ts compiles these sources,
 * plain and behind its ESCAPE_BOUNDARY, and runs the gates; nothing else
 * imports this module.
 */

// Opt-in: `secret|token|password|api key`-shaped assignment whose value has
// high Shannon entropy. Keyword-anchored (compiled inline below so the group
// layout matches the core patterns: group 1 = anchor, group 2 = value).
//
// The left boundary is [^A-Za-z0-9] rather than the core patterns'
// [^A-Za-z0-9_]: `_` has to read as a SEPARATOR here, or `api_access_token`
// and `SMTP_PASSWORD` cannot match their own keyword. The core patterns keep
// `_` as a word character on purpose (a vendor prefix inside a longer
// identifier must not fire); this rule is keyword-anchored, so the same
// reasoning inverts. The keyword is also allowed trailing identifier
// segments before the assignment, or `AWS_SECRET_ACCESS_KEY=` cannot match:
// the keyword `SECRET` is not adjacent to the `=`, `_ACCESS_KEY` is. The
// entropy gate still decides, so a wider anchor costs nothing on prose.
//
// The value floor is 12, not 20. A 16-character SMTP password sat under the
// old floor and stayed plaintext in the receipt on disk even once the keyword
// matched — the value length was doing gating the entropy check is there to
// do. Real passwords are frequently 12-16 characters; secrets that long with
// 3.5 bits/char of entropy are not prose.
//
// The value must ALSO contain at least one digit. Identifier-shaped values
// (`DefaultAzureCredential`, `/usr/local/bin/aws-vault`, an env-var NAME
// assigned to an `apiKeyEnvVar`) clear the entropy gate on mixed case and
// separators alone and were being redacted out of ordinary code. Real
// machine-minted secrets essentially always carry digits; a digitless
// passphrase is the accepted miss. A 40-hex git sha assigned to a `token:`
// key still redacts (digits + entropy) — documented, acceptable.
//
// Both quantifiers after the keyword are BOUNDED. The trailing identifier
// segments used to be `[A-Za-z0-9_-]*`: because the left boundary admits `-`
// and `_` and that class contains them too, every `-`/`_` in a run like
// `-apikey-apikey…` or `_token_token…` was a fresh keyword start whose
// suffix ran to end-of-line and backtracked — quadratic (210 KB of
// `-apikey` took ~35 s, 180 KB of `_token` ~15 s). At `{0,64}` a start does
// constant work; no real credential key carries 64 identifier characters
// after its keyword. The value is capped at 4096 for the same
// constant-work-per-occurrence guarantee (the jwt segments share the cap):
// a value longer than that is redacted only through its first 4096 chars —
// the accepted miss, well above any real token or base64 key blob.
//
// The 3.5 bits/char floor is judged on the bias-corrected (Miller-Madow)
// estimate, not the raw per-character Shannon entropy. The raw figure of an
// n-character string can never exceed log2(n) (3.58 at 12 characters, 3.91
// at 15) and drops sharply with a single repeated character, so the raw
// floor rejected 68% of uniformly random 12-character alphanumeric secrets,
// 9% at 15 and 5% at 16: exactly the 12-16 character passwords the 12-char
// value floor exists to catch (a 15-character value such as `!dcG4Gmw1qGRbR3`
// after a password key stayed plaintext).
// Miller-Madow adds (distinct - 1) / (2 n ln 2), which cuts those misses
// below 1% at every length from 12 up and is negligible on long values.
// Because the correction can lift an all-digit value past the floor, the
// value must also carry a non-digit: counters, timestamps and numeric ids
// (`token_count=1234567890123`) never reached 3.5 raw bits (log2(10) = 3.32)
// and still never redact.
export const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 3.5;
export const HIGH_ENTROPY_REQUIRES_DIGIT_RE = /[0-9]/;
export const HIGH_ENTROPY_REQUIRES_NON_DIGIT_RE = /[^0-9]/;

// PUNCTUATED VALUES. The rule is two compiled patterns sharing the name and
// the group-2-is-value contract. QUOTED: after an opening `"` or `'`, the
// value is any run of non-quote, non-whitespace characters (a password like
// `ab!#%…<…` is one value). UNQUOTED: the legacy class plus the password
// punctuation `!#$%*@^~.?<>` — not `&` (it would swallow sibling query
// parameters), not `()[]{}` (so `token = getToken(x)` never matches), not `:`,
// and not `,` / `;` (the false-positive measurement found SQL `SET` lists
// such as `execution_token=NULL,claim_expires_at=NULL,error_code=$3` read as
// one value; a password carrying them is matched only when quoted) — and the
// last character excludes `.?!`, so `TOKEN=<tok>.` claims the token without
// the sentence's full stop and its bare echoes still scrub.
// Both keep the 12-4096 bounds and the digit + entropy gates. Each also has
// an ESCAPE_BOUNDARY twin (#7978): `\\npassword=…` in escaped tool output.
export const assignmentKey = (boundary: string) =>
  `${boundary}(?:secret|token|passwd|password|passphrase|credential|api[_-]?key|apikey)[A-Za-z0-9_-]{0,64}["']?\\s*[:=]\\s*`;
export const ASSIGNMENT_QUOTED_SOURCE = (key: string) => `(${key}["'])([^"'\\s]{12,4096})`;
export const ASSIGNMENT_UNQUOTED_SOURCE = (key: string) =>
  `(${key})([A-Za-z0-9+/_=\\-!#$%*@^~.?<>]{11,4095}[A-Za-z0-9+/_=\\-#$%*@^~<>])`;
/** The legacy (pre-punctuation) value class, whole-value form. */
const LEGACY_ASSIGNMENT_VALUE_RE = /^[A-Za-z0-9+/_=-]+$/;
/** A dotted member path in code (`process.env.DB_PASSWORD_2`): every segment an identifier. */
const DOTTED_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

/**
 * Assignment-value validate: reject values that are references, not secrets
 * — a URL (`scheme://`), a relative or home path (`./`, `~/`), a shell
 * expansion (`${`, `$(`), an already-redacted token, an absolute path (`/`
 * plus a character outside the legacy class, such as the `.` of a file
 * name), and a dotted member path whose every segment is an identifier
 * (`process.env.X`, `config.secrets.key2`: the `.` admitted for passwords
 * would otherwise turn code into a value). A leading `/` on a pure base64
 * value still fires: one random base64 secret in 64 starts with `/`, and the
 * legacy rule redacted those. A dotted password whose every segment starts
 * with a letter is the accepted miss.
 */
export function assignmentValueIsSecretShaped(value: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\//.test(value)) return false;
  if (value.startsWith('./') || value.startsWith('~/') || value.startsWith('${') || value.startsWith('$(')) return false;
  if (value.startsWith('<REDACTED:') || DOTTED_IDENTIFIER_RE.test(value)) return false;
  return !(value.startsWith('/') && !LEGACY_ASSIGNMENT_VALUE_RE.test(value));
}
