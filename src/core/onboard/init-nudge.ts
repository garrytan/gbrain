// src/core/onboard/init-nudge.ts
// v0.41.18.0 (A4 + A18 + A20, T14). Post-initSchema summary that runs
// the 4 onboard checks against a 3-second wallclock budget and prints
// a one-line nudge if recommendations exist.
//
// Hard contract per A18: init MUST succeed even if the nudge crashes.
// Any throw in this module is caught + logged to stderr + suppressed.
// Per A20: the 3-second cap uses real cancellation via the AbortSignal
// extension on executeRaw (T5) — Promise.race against a timer was the
// codex #7 finding's wrong shape. Cancelled queries actually stop on
// Postgres; PGLite has a documented gap.
//
// Bypass: GBRAIN_NO_ONBOARD_NUDGE=1 short-circuits. Non-interactive callers
// (agents) get the same coaching as an [AGENT] block (agent contract F7).

import type { BrainEngine } from '../engine.ts';
import { writeCliNotices } from '../interop-notices.ts';

const NUDGE_BUDGET_MS = 3000;

/**
 * Post-initSchema nudge. Fail-open per A18.
 *
 * Returns silently when:
 *   - GBRAIN_NO_ONBOARD_NUDGE=1
 *   - All 4 onboard checks complete within 3s AND surface 0 recommendations
 *   - ANY error during check execution (logged to stderr, suppressed)
 *
 * Emits an `onboard_opportunities` coaching notice (stderr on a terminal,
 * an [AGENT] block on stdout for a non-interactive caller) when:
 *   - Recommendations exist within budget
 *   - Some checks ran but budget fired (partial-results path)
 */
export async function runInitNudge(engine: BrainEngine): Promise<void> {
  try {
    if (process.env.GBRAIN_NO_ONBOARD_NUDGE === '1') return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NUDGE_BUDGET_MS);

    let totalStale = 0;
    let totalEntities = 0;
    let linkedCount = 0;
    let timelineCount = 0;
    let takesCount = 0;
    // -1 = the page-count probe failed: fail-open sentinel, treat as non-empty
    // so current behavior is preserved when the count is unknown.
    let totalPages = -1;
    let checksRan = 0;
    let checksAttempted = 0;
    let partial = false;

    // Run 4 cheap counts in parallel against the 3s budget.
    const results = await Promise.allSettled([
      engine.executeRaw<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM content_chunks WHERE embedding IS NULL`,
        [],
        { signal: controller.signal },
      ),
      engine.executeRaw<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM pages
           WHERE type IN ('person', 'company', 'organization', 'entity')
             AND deleted_at IS NULL`,
        [],
        { signal: controller.signal },
      ),
      engine.executeRaw<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM pages p
           WHERE p.type IN ('person', 'company', 'organization', 'entity')
             AND p.deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)`,
        [],
        { signal: controller.signal },
      ),
      engine.executeRaw<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM pages p
           WHERE p.type IN ('person', 'company', 'organization', 'entity')
             AND p.deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id = p.id)`,
        [],
        { signal: controller.signal },
      ),
      engine.executeRaw<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM takes`,
        [],
        { signal: controller.signal },
      ),
      engine.executeRaw<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL`,
        [],
        { signal: controller.signal },
      ),
    ]);
    clearTimeout(timer);

    checksAttempted = results.length;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        partial = true;
        continue;
      }
      checksRan++;
      const n = r.value.length > 0 ? Number(r.value[0].count) : 0;
      if (i === 0) totalStale = n;
      else if (i === 1) totalEntities = n;
      else if (i === 2) linkedCount = n;
      else if (i === 3) timelineCount = n;
      else if (i === 4) takesCount = n;
      else if (i === 5) totalPages = n;
    }

    // A brand-new EMPTY brain has no "opportunities" — telling a fresh user
    // "0 takes" at the end of their first init is jargon-noise on the
    // activation surface. Suppress the ENTIRE nudge on empty (including the
    // partial-checks notice below).
    const brainEmpty = totalPages === 0;
    if (brainEmpty) return;

    // Aggregate: any non-zero metric triggers the nudge.
    const linkCoverage = totalEntities > 0 ? linkedCount / totalEntities : 1;
    const timelineCoverage = totalEntities > 0 ? timelineCount / totalEntities : 1;
    const hasRecommendations =
      totalStale > 0
      || (totalEntities > 0 && linkCoverage < 0.7)
      || (totalEntities > 0 && timelineCoverage < 0.9)
      || takesCount === 0;
    if (!hasRecommendations && !partial) return;

    // Emit one-line nudge. Be terse — init is the activation surface.
    const parts: string[] = [];
    if (totalStale > 0) parts.push(`${totalStale} stale chunks`);
    if (totalEntities > 0 && linkCoverage < 0.7) {
      parts.push(`link coverage ${Math.round(linkCoverage * 100)}%`);
    }
    if (totalEntities > 0 && timelineCoverage < 0.9) {
      parts.push(`timeline coverage ${Math.round(timelineCoverage * 100)}%`);
    }
    if (takesCount === 0) parts.push('0 takes');

    // Agent contract v1 (F7): a coaching notice on every surface — terminal
    // lines, an [AGENT] block for a non-interactive caller (no more silence
    // exactly when an agent runs init).
    const why = parts.length === 0
      ? `Init checks incomplete (${checksRan}/${checksAttempted}) — run 'gbrain onboard --check' for full recommendations.`
      : `Brain has opportunities: ${parts.join(', ')}. Run 'gbrain onboard --check' to see the plan.` +
        (partial ? ` (${checksRan}/${checksAttempted} checks complete; run gbrain onboard --check for full recommendations)` : '');
    writeCliNotices([{
      code: 'onboard_opportunities', kind: 'coaching', why,
      fix: { argv: ['gbrain', 'onboard', '--check'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists each recommendation with its command; read-only.' },
    }]);
  } catch (err) {
    // A18: NEVER crash init from the nudge. Log and continue.
    process.stderr.write(`[onboard] nudge skipped (${err instanceof Error ? err.message : String(err)})\n`);
  }
}

/**
 * Post-upgrade banner. Lighter than the init nudge — just highlights
 * that new onboard recommendations may exist. Fail-open identically.
 */
export async function runUpgradeBanner(_engine: BrainEngine): Promise<void> {
  try {
    if (process.env.GBRAIN_NO_ONBOARD_NUDGE === '1') return;
    writeCliNotices([{
      code: 'onboard_opportunities', kind: 'coaching',
      why: "Upgrade complete. Run 'gbrain onboard --check' to see if the new version surfaces any new opportunities.",
      fix: { argv: ['gbrain', 'onboard', '--check'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists each recommendation with its command; read-only.' },
    }]);
  } catch {
    // A18 posture for symmetry.
  }
}
