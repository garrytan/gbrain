/**
 * POSIX single-quote any arg that isn't already shell-safe, so `$()`, backticks,
 * etc. in a token are inert literals when the block is pasted into a shell
 * (double-quoting would still allow command substitution). A leaf module:
 * importing it adds no other module's text to a command's flag-registry scan.
 */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_.:/@-]+$/.test(arg)) return arg;
  return quotedWord(arg);
}

/**
 * A control character, a line or paragraph separator, a bidirectional embedding, override or isolate control
 * (U+202A-U+202E, U+2066-U+2069: F6, they reorder what a terminal shows), or an agent marker token: the text no plain
 * quote can carry.
 */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]|\[\/?(?:AGENT|SHOW USER|gbrain notice)/i;
/** What quotedWord writes as `\NNN` octal bytes: those characters, plus the quote, the backslash and `[` (so no marker forms). */
const ESCAPED = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069'\\[]/gu;

/**
 * GCH-02a: one shell word for a value that is not bare-safe. A value with a control character, a line break or a
 * marker token is written in ANSI-C quoting (`$'...'`) with those characters, `'`, `\\` and `[` as fixed three-digit
 * octal UTF-8 bytes (`\NNN`; a hex `\xHH` escape can take a following hex digit in older ksh93, and POSIX leaves
 * that unspecified). bash, zsh, ksh93, busybox sh and POSIX.1-2024 shells read the exact value, the text stays on
 * one line with no marker, and no raw apostrophe sits inside, so a shell without `$'...'` (dash) reads one literal
 * `$`-word and runs nothing from the value. Any other value is POSIX single-quoted as before. Both shellQuote
 * helpers (this one and the argv one in agent-output.ts) build their quoted words here.
 */
export function quotedWord(arg: string): string {
  if (!UNPRINTABLE.test(arg)) return `'${arg.replace(/'/g, "'\\''")}'`;
  return `$'${arg.replace(ESCAPED, octalBytes)}'`;
}

/** The fixed three-digit octal UTF-8 bytes of one character (`\033` for ESC); inertText escapes controls with it too. */
export function octalBytes(ch: string): string {
  return [...new TextEncoder().encode(ch)].map(b => `\\${b.toString(8).padStart(3, '0')}`).join('');
}
