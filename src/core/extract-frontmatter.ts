/**
 * Frontmatter link-extraction opt-in — one answer for every extraction path.
 *
 * v0.42 added `autopilot.incremental_extract_include_frontmatter` so the
 * incremental cycle could keep externally-edited frontmatter edges fresh, but
 * only `runPhaseExtract` ever read it. performSync's inline extract, the
 * `extract_stale` minion and `gbrain maintain` each hardcoded `false` with no
 * way to opt in, so any unattended sync — cron, webhook, git hook — imported
 * pages and left their frontmatter relationships unextracted.
 *
 * For a schema pack that keeps relationships in `related:` frontmatter rather
 * than body wikilinks, that is silent data loss: `traverse_graph` returns
 * nothing, and "not recorded" is indistinguishable from "nothing depends on
 * it". The failure never surfaces as an error.
 *
 * Lives beside config.ts rather than inside it because the resolution is
 * engine-aware; config.ts stays the plain file/key plane.
 */

import { isConfigTruthy, loadConfig } from './config.ts';

/** Only `getConfig` is consulted, so callers can pass any engine-shaped object. */
type ConfigReader = { getConfig(key: string): Promise<string | null> };

/** General key; applies to every extraction path. */
export const INCLUDE_FRONTMATTER_KEY = 'extract.include_frontmatter';
/** Path-specific predecessor, still honoured so existing installs keep working. */
export const LEGACY_INCLUDE_FRONTMATTER_KEY = 'autopilot.incremental_extract_include_frontmatter';

/**
 * Resolve whether extraction should read `related:` frontmatter.
 *
 * Precedence, first defined wins:
 *   1. explicit per-call value (a `--include-frontmatter` flag)
 *   2. `extract.include_frontmatter`                       — file plane, then DB plane
 *   3. `autopilot.incremental_extract_include_frontmatter`  — legacy, same order
 *   4. false (the historical default)
 *
 * Truthiness goes through {@link isConfigTruthy}, so `1`/`yes`/`on` work here as
 * they do for every other boolean key — the cycle's previous bespoke
 * `=== 'true'` comparison silently rejected those spellings.
 *
 * Fails closed: absent, garbled or unreadable values yield false, so existing
 * installs keep their current behaviour until they opt in.
 */
export async function resolveIncludeFrontmatter(
  engine: ConfigReader | null | undefined,
  explicit?: boolean,
): Promise<boolean> {
  if (explicit !== undefined) return explicit;

  const file = loadConfig();
  const fileGeneral = file?.extract?.include_frontmatter;
  if (fileGeneral !== undefined) return fileGeneral === true;
  const fileLegacy = file?.autopilot?.incremental_extract_include_frontmatter;
  if (fileLegacy !== undefined) return fileLegacy === true;

  if (!engine) return false;
  for (const key of [INCLUDE_FRONTMATTER_KEY, LEGACY_INCLUDE_FRONTMATTER_KEY]) {
    try {
      const raw = await engine.getConfig(key);
      if (raw != null) return isConfigTruthy(raw);
    } catch {
      return false; // config table unreadable → default off
    }
  }
  return false;
}
