/**
 * v0.40.4.0 — shared audit-writer primitive.
 *
 * Replaces the 5 hand-rolled JSONL audit modules (rerank-audit,
 * shell-audit, supervisor-audit, audit-slug-fallback, phantom-audit)
 * that all duplicated the same ISO-week filename math, the same
 * best-effort write loop, and the same read-current-and-previous-week
 * loop. Each refactored module keeps its typed event shape and any
 * special wrappers (severity stamping, dual stderr emission,
 * supervisor_pid injection) — they delegate the file I/O to the
 * primitive built here.
 *
 * Design constraints (codex outside-voice + plan D5=B):
 *
 *   1. NO behavior change for existing consumers. Filename format,
 *      JSONL line format, mkdirSync recursive, appendFileSync utf8,
 *      stderr-on-failure semantics MUST be byte-identical so the
 *      existing tests pass unchanged.
 *
 *   2. ISO-8601 week numbering. The shared algorithm lives here in
 *      `computeIsoWeekFilename(prefix, now)`. Year-boundary edge
 *      case: 2027-01-01 is ISO week 53 of year 2026 → filename
 *      `<prefix>-2026-W53.jsonl`.
 *
 *   3. Audit dir resolution. Honors `GBRAIN_AUDIT_DIR` env override
 *      ahead of the default `~/.gbrain/audit/`. Trim whitespace; an
 *      env value of `"   "` is treated as unset.
 *
 *   4. Best-effort writes. Append failures go to stderr but never
 *      throw. The caller's import / cycle / supervisor / submission
 *      continues regardless. A disk-full attacker can silently disable
 *      the trail — this is documented in every refactored module's
 *      header as "operational trace, not forensic insurance."
 *
 *   5. Read-back walks the current + previous ISO week so a 7-day
 *      window straddling Monday-midnight stays covered. Corrupt rows
 *      / missing files are skipped silently — the audit trail is
 *      informational and must not block any consumer.
 *
 * Honest scope: this is filesystem JSONL. Codex flagged in plan review
 * (#15) that error counts in JSONL won't surface in remote-server
 * deploys (HTTP MCP server, OAuth-fronted brain). T-todo-3 captures
 * the v0.41+ work to route fail-open events to a DB table for
 * cross-deploy observability. Until then, doctor + search-stats show
 * full metrics on local-only deploys and success-only metrics on
 * remote deploys.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { gbrainPath } from '../config.ts';

/**
 * Resolve the audit dir. Honors `GBRAIN_AUDIT_DIR` for container /
 * sandbox deploys where `$HOME` is read-only. Defaults to
 * `~/.gbrain/audit/`.
 *
 * Shared across every audit module. The previous home (shell-audit.ts)
 * re-exports this so existing imports continue to work.
 */
export function resolveAuditDir(): string {
  const override = process.env.GBRAIN_AUDIT_DIR;
  if (override && override.trim().length > 0) return override;
  return gbrainPath('audit');
}

/**
 * Compute `<prefix>-YYYY-Www.jsonl` using ISO-8601 week numbering.
 *
 * Algorithm: copy date, shift to the nearest Thursday (ISO week
 * anchor), then count weeks since the year's first Thursday.
 *
 * Year-boundary edge: 2027-01-01 is ISO week 53 of year 2026 → returns
 * `<prefix>-2026-W53.jsonl`. This is correct per the ISO standard.
 *
 * Centralizing the math means a fix to the week calculation (e.g. a
 * leap-year edge case) lands once and applies to every feature's audit
 * trail simultaneously.
 */
export function computeIsoWeekFilename(prefix: string, now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to Thursday
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `${prefix}-${isoYear}-W${ww}.jsonl`;
}

export interface AuditWriterOpts {
  /**
   * Filename prefix WITHOUT the date/extension suffix. The full
   * filename becomes `<featureName>-YYYY-Www.jsonl`.
   *
   * Examples: `'rerank-failures'`, `'shell-jobs'`, `'supervisor'`,
   * `'slug-fallback'`, `'phantoms'`, `'graph-signals-failures'`.
   */
  featureName: string;
  /**
   * Label used in the stderr warning when a write fails. Defaults to
   * `featureName`. Existing modules use slightly different labels
   * (`'shell-audit'` vs `'gbrain'` vs `'supervisor-audit'`) so the
   * label is overridable per refactor without changing operator-
   * visible behavior.
   */
  errorLabel?: string;
  /**
   * Qualifier inserted between the label and "write failed". For
   * pre-v0.40.4 byte-identical preservation of operator-grep patterns:
   *   - rerank-audit: 'rerank-failure audit '
   *   - audit-slug-fallback: 'slug-fallback audit '
   *   - phantom-audit: 'phantom audit '
   *   - shell-audit + supervisor-audit + slug-fallback: '' (label is
   *     already the qualifier in their pre-v0.40.4 stderr messages).
   *
   * Defaults to '' (no qualifier). Module-specific qualifiers preserve
   * operator log-grep patterns from before the refactor.
   */
  errorMessagePrefix?: string;
  /**
   * Trailing phrase on the stderr warning, after the error message.
   * Existing modules use: `'; submission continues'`,
   * `'; import continues'`, `'; cycle continues'`,
   * `'; search continues'`, `'; continuing'`. Default: `''`
   * (no trailer).
   */
  errorTrailer?: string;
}

export interface AuditWriter<T extends { ts: string }> {
  /**
   * Append one event. Best-effort: stderr-warns on failure but never
   * throws. The caller may pre-populate `ts` (some callers compose
   * the event upstream and want stable timestamps for batching); when
   * omitted, the writer stamps `new Date().toISOString()` at log time.
   */
  log(event: Omit<T, 'ts'> & { ts?: string }): void;
  /**
   * Read back events from current + previous ISO week, filtered by
   * `days` window (default 7). Missing files / corrupt rows skipped
   * silently. Returns oldest-first within each file, current-week
   * file appended after previous-week file (callers that need strict
   * chronological ordering should sort by ts).
   */
  readRecent(days?: number, now?: Date): T[];
  /**
   * Compute the filename for a given Date. Exposed so tests can pin
   * the year-boundary edge cases and so downstream consumers (doctor,
   * search-stats) can derive the expected path without recomputing
   * the algorithm.
   */
  computeFilename(now?: Date): string;
  /** Resolve the audit directory (honors GBRAIN_AUDIT_DIR override). */
  resolveDir(): string;
}

/**
 * Build a typed audit writer for a given feature.
 *
 * Usage:
 *   ```ts
 *   const writer = createAuditWriter<MyEvent>({
 *     featureName: 'my-feature',
 *     errorLabel: 'my-feature-audit',
 *     errorTrailer: '; continuing',
 *   });
 *   writer.log({ ...eventFields });
 *   const recent = writer.readRecent(7);
 *   ```
 */
export function createAuditWriter<T extends { ts: string }>(
  opts: AuditWriterOpts,
): AuditWriter<T> {
  const { featureName } = opts;
  const errorLabel = opts.errorLabel ?? featureName;
  const errorMessagePrefix = opts.errorMessagePrefix ?? '';
  const errorTrailer = opts.errorTrailer ?? '';

  function computeFilename(now: Date = new Date()): string {
    return computeIsoWeekFilename(featureName, now);
  }

  function log(event: Omit<T, 'ts'> & { ts?: string }): void {
    const ts = event.ts ?? new Date().toISOString();
    // The event shape is opaque to the writer; we serialize the merged
    // payload verbatim. Callers control field ordering by destructuring
    // before calling — but since JSON object key order doesn't matter
    // for consumers (parsers don't preserve it), this is fine.
    const row = { ...event, ts };
    const dir = resolveAuditDir();
    // File path is derived from the event's ts (not wall-clock now) so
    // back-dated events land in their own ISO week's file. Otherwise a
    // test (or any caller) passing a historical ts would have its event
    // routed to the current-week file, then readRecent — which walks
    // current + previous week by `now` — would miss it. Fixes the CI
    // flake where wall-clock week-of-test-run drifted past the test's
    // synthetic now and emptied the readRecent window.
    const eventDate = new Date(ts);
    const fileDate = Number.isFinite(eventDate.getTime()) ? eventDate : new Date();
    const file = path.join(dir, computeFilename(fileDate));
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[${errorLabel}] ${errorMessagePrefix}write failed (${msg})${errorTrailer}\n`);
    }
  }

  function readRecent(days = 7, now: Date = new Date()): T[] {
    const dir = resolveAuditDir();
    const cutoff = now.getTime() - days * 86400000;
    const out: T[] = [];
    // Walk current + previous ISO week so a 7-day window straddling
    // Monday-midnight stays covered. Order: current week first, then
    // previous — matches the pre-v0.40.4 behavior of every refactored
    // module (rerank-audit, slug-fallback, phantom-audit). Callers
    // wanting strict chronological order sort by ts.
    const filenames = [
      computeFilename(now),
      computeFilename(new Date(now.getTime() - 7 * 86400000)),
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
          const ev = JSON.parse(line) as T;
          const ts = Date.parse(ev.ts);
          if (Number.isFinite(ts) && ts >= cutoff) out.push(ev);
        } catch {
          // Corrupt row — skip.
        }
      }
    }
    return out;
  }

  return {
    log,
    readRecent,
    computeFilename,
    resolveDir: resolveAuditDir,
  };
}
