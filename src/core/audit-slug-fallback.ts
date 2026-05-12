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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAuditDir } from './minions/handlers/shell-audit.ts';

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

/** ISO-week-rotated filename: `slug-fallback-YYYY-Www.jsonl`. */
export function computeSlugFallbackAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `slug-fallback-${isoYear}-W${ww}.jsonl`;
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
  const event: SlugFallbackAuditEvent = {
    ts: new Date().toISOString(),
    slug,
    source_path: sourcePath,
    severity: 'info',
    code: 'SLUG_FALLBACK_FRONTMATTER',
  };
  const dir = resolveAuditDir();
  const file = path.join(dir, computeSlugFallbackAuditFilename());
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] slug-fallback audit write failed (${msg}); import continues\n`);
  }
}

/**
 * Read recent (`days` window, default 7) slug-fallback events from the
 * latest week's JSONL. Used by `gbrain doctor`'s slug_fallback_audit check.
 * Missing file / corrupt rows are skipped silently — the audit trail is
 * informational and shouldn't block doctor.
 */
export function readRecentSlugFallbacks(days = 7, now: Date = new Date()): SlugFallbackAuditEvent[] {
  const dir = resolveAuditDir();
  const cutoff = now.getTime() - days * 86400000;
  const out: SlugFallbackAuditEvent[] = [];
  // Walk the current + previous ISO week so a 7-day window straddling
  // Monday-midnight stays covered.
  const filenames = [
    computeSlugFallbackAuditFilename(now),
    computeSlugFallbackAuditFilename(new Date(now.getTime() - 7 * 86400000)),
  ];
  for (const filename of filenames) {
    const file = path.join(dir, filename);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      try {
        const ev = JSON.parse(line) as SlugFallbackAuditEvent;
        const ts = Date.parse(ev.ts);
        if (Number.isFinite(ts) && ts >= cutoff) out.push(ev);
      } catch {
        // Corrupt row — skip.
      }
    }
  }
  return out;
}
