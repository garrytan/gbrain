/**
 * Output-side redaction for shell-job stdout/stderr (v0.36.5.0).
 *
 * Honest defense for the documented limitation: `inherit:` keeps values out
 * of the JOB ROW INPUT fields (`data.cmd`, `data.argv`, `data.env`), but if
 * the script prints the value to stdout or stderr, it lands in
 * `result.stdout_tail` / `result.stderr_tail` / `error_text` and from there
 * into `minion_jobs.result` plaintext.
 *
 * This module scrubs resolved inherit values out of output text before the
 * shell handler returns or throws. Opt-in via `redact_secrets: true` on the
 * job params (or `--redact-secrets` on the CLI).
 *
 * What gets redacted: only the resolved values of names listed in `inherit:`.
 * The agent identified those by name as "secret"-class. Caller-supplied
 * `env:` values are NOT redacted — those are the agent's chosen "I'm fine
 * with this in the row" channel.
 *
 * Heuristic, not perfect: a determined script can encode-then-print
 * (base64, hex-split, character-by-character) and bypass the literal-string
 * replace. The agent + script are in the same trust domain, so this layer
 * defends against accidental echo (the common case), not adversarial print.
 *
 * Replacement token: `<REDACTED:name>` (the inherit name, human-readable)
 * so the operator inspecting the row knows WHICH secret was scrubbed.
 */

/**
 * Scrub every resolved inherit value out of the given text. Returns the
 * scrubbed text; original is not mutated.
 *
 * @param text     The stdout/stderr/error text to scrub.
 * @param secrets  Map of inherit-name → resolved value. Empty values are skipped.
 *                 Order doesn't matter (each value is independently replaced).
 */
export function redactSecretsInText(
  text: string,
  secrets: ReadonlyMap<string, string>,
): string {
  if (text.length === 0 || secrets.size === 0) return text;
  let result = text;
  for (const [name, value] of secrets) {
    if (value.length === 0) continue;
    // String-mode replaceAll: no regex interpretation, so special chars in
    // the value (?, *, +, parens, etc.) replace as literal substrings. This
    // matches the threat model: the value is whatever the worker had in
    // config; we want the exact byte sequence scrubbed.
    result = result.replaceAll(value, `<REDACTED:${name}>`);
  }
  return result;
}
