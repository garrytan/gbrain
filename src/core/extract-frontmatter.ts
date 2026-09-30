/**
 * `autopilot.incremental_extract_include_frontmatter` — one answer for every
 * extraction path: the cycle, sync's inline extract, the GitHub/Google source
 * inline extracts, the `extract_stale` minion, `gbrain maintain`, and
 * `gbrain extract --stale` without an explicit flag.
 *
 * The knob shipped in v0.42 but only the cycle read it. Every other path
 * extracted body links only AND then stamped `links_extracted_at`, so with the
 * knob on a page came out of an unattended sync marked fresh without its
 * frontmatter edges, and the cycle's stale drain (the one path that honoured
 * the knob) never revisited it. The siblings defeated the documented knob.
 *
 * Both planes, file wins (same precedence as loadConfigWithEngine). `gbrain
 * config set` writes the DB plane, so a file-only read would make the
 * documented enable command a silent no-op (#2120 class). A non-boolean
 * file-plane value is not an answer — it falls through to the DB plane. Fails
 * closed: absent, garbled or unreadable values yield false.
 */

import { isConfigTruthy, loadConfig } from './config.ts';

export const INCLUDE_FRONTMATTER_KEY = 'autopilot.incremental_extract_include_frontmatter';

/**
 * `explicit` (a `--include-frontmatter` flag) wins; otherwise file plane, then
 * DB plane via `getConfig` (truthiness through isConfigTruthy, so `1`/`yes`/`on`
 * work as for every other boolean key); otherwise false.
 */
export async function resolveIncludeFrontmatter(
  engine: { getConfig(key: string): Promise<string | null> } | null | undefined,
  explicit?: boolean,
): Promise<boolean> {
  if (explicit !== undefined) return explicit;
  const fileVal = loadConfig()?.autopilot?.incremental_extract_include_frontmatter;
  // Only a real boolean is a file-plane answer; a hand-edited "true"/1 used to
  // resolve false AND shadow the DB plane (silent `config set` no-op, #2120 class).
  if (typeof fileVal === 'boolean') return fileVal;
  if (!engine) return false;
  try {
    return isConfigTruthy(await engine.getConfig(INCLUDE_FRONTMATTER_KEY));
  } catch {
    return false; // config table unreadable → default off
  }
}
