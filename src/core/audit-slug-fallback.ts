/**
 * v0.32.7 CJK wave — slug-fallback audit trail.
 *
 * Writes info-severity rows to `~/.gbrain/audit/slug-fallback-YYYY-Www.jsonl`
 * (ISO-week rotation, mirrors `subagent-audit.ts`). Fired when import-file's
 * empty-path-slug + frontmatter-fallback path resolves a slug that wouldn't
 * otherwise derive from the file path (emoji, Thai, Arabic, etc. filenames
 * whose slugifyPath() returns empty even after the CJK ranges land).
 *
 * Why a separate JSONL instead of `~/.gbrain/sync-failures.jsonl`:
 *   - sync-failures.jsonl carries commit-attribution semantics that gate
 *     bookmark advancement; importFromFile doesn't know the commit.
 *   - Fallback events are informational, NOT failures. Routing them through
 *     the failure surface would force doctor / classifyErrorCode /
 *     acknowledgeSyncFailures to grow a severity tier they weren't designed
 *     for. Codex outside-voice C7 caught this drift.
 *
 * Best-effort writes. Write failures go to stderr but the import continues.
 *
 * 2026-05-16 refactored to use the shared `createAuditLogger` primitive
 * from `audit-jsonl.ts`. The cross-layer import of `resolveAuditDir` from
 * `minions/handlers/shell-audit.ts` is gone — both now resolve through the
 * core layer where they belong.
 */

import { createAuditLogger, computeIsoWeekFilename } from './audit-jsonl.ts';

export interface SlugFallbackAuditEvent {
  ts: string;
  /** Resolved slug (the frontmatter slug that overrode the empty path slug). */
  slug: string;
  /** Repo-relative path that produced an empty slugifyPath(). */
  source_path: string;
  /** Always 'info' — keeps the schema explicit for future severity tiers. */
  severity: 'info';
  /** Stable code consumed by `gbrain doctor`'s slug_fallback_audit check. */
  code: 'SLUG_FALLBACK_FRONTMATTER';
}

const logger = createAuditLogger<SlugFallbackAuditEvent>({
  prefix: 'slug-fallback',
  stderrTag: '[gbrain]',
  continueMessage: 'import continues',
});

/** ISO-week-rotated filename: `slug-fallback-YYYY-Www.jsonl`. */
export function computeSlugFallbackAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('slug-fallback', now);
}

/**
 * Append a slug-fallback event to the current week's audit JSONL.
 *
 * Also emits one stderr line per call for operator visibility (per D7 dual
 * logging). Write failure to the JSONL is logged but does NOT throw — the
 * import succeeds either way.
 */
export function logSlugFallback(slug: string, sourcePath: string): void {
  process.stderr.write(`[gbrain] slug fallback: ${sourcePath} → ${slug} (frontmatter slug; path slugified empty)\n`);
  logger.log({
    slug,
    source_path: sourcePath,
    severity: 'info',
    code: 'SLUG_FALLBACK_FRONTMATTER',
  });
}

/**
 * Read recent (`days` window, default 7) slug-fallback events. Used by
 * `gbrain doctor`'s slug_fallback_audit check. Missing file / corrupt rows
 * are skipped silently — the audit trail is informational and shouldn't
 * block doctor.
 */
export function readRecentSlugFallbacks(days = 7, now: Date = new Date()): SlugFallbackAuditEvent[] {
  return logger.readRecent(days, now);
}
