/**
 * `LLMS_REPO_BASE`, the fork override for documentation links (W4.12): the
 * base URL every rendered `docs` link, `llms.txt` entry and portable skill
 * link starts with. Agents read those links as fix instructions, so only a
 * plain `https://host/path` base is accepted: no other scheme, no
 * credentials, query or fragment, and no whitespace or control characters.
 */

/** The override with trailing slashes removed; null when unset or blank; `{ invalid }` when it is not a plain https URL. */
export function parseRepoBase(raw: string | undefined): string | null | { invalid: string } {
  const value = raw?.trim().replace(/\/+$/, '');
  if (!value) return null;
  if (/[\s\x00-\x1f\x7f]/.test(value)) return { invalid: value };
  let url: URL;
  try { url = new URL(value); } catch { return { invalid: value }; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return { invalid: value };
  return value;
}

/** Build scripts: the override, or `fallback` when unset; an invalid value throws. */
export function repoBaseOrThrow(raw: string | undefined, fallback: string): string {
  const parsed = parseRepoBase(raw);
  if (parsed === null) return fallback;
  if (typeof parsed === 'string') return parsed;
  throw new Error(`LLMS_REPO_BASE must be a plain https URL such as https://raw.githubusercontent.com/<org>/<repo>/<branch> (no credentials, query or fragment); got ${JSON.stringify(parsed.invalid)}`);
}
