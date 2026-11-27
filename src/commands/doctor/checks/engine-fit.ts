/**
 * Engine-fit check cluster — the doctor half of the db-availability loop.
 *
 *   - pglite_scale: makes `gbrain init`'s one-shot 1000-file Supabase
 *     suggestion re-evaluable for the LIFE of the brain (init counts .md
 *     files in a pre-init directory; a live brain is measured in pages).
 *   - db_repair_recurrence: reads the db-repair receipts JSONL. ENGINE-FREE
 *     on purpose — it must run in doctor's dead-DB filesystem lane, which is
 *     exactly when repairs are repeating. Only `outcome:'applied'` rows with
 *     the SAME reason for the SAME brain_id count (diagnose/refused rows and
 *     cross-brain rows never sum toward one threshold).
 *
 * pglite_scale's fix is the read-only graduation plan (`gbrain migrate --to
 * postgres --plan --json`, which proposes a target when none is given) and
 * names the stay-on-PGLite alternative, `gbrain mcp expose`.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { readReceipts } from '../../../core/db-repair-receipts.ts';

/** Pages-only, warn-only (CEO-review E2 pinned semantics). */
export const PGLITE_SCALE_PAGE_THRESHOLD = 1000;

/** The read-only graduation plan pglite_scale points at. */
export const PGLITE_SCALE_PLAN_ARGV = ['gbrain', 'migrate', '--to', 'postgres', '--plan', '--json'];

export async function pgliteScaleCheck(engine: BrainEngine): Promise<Check | null> {
  if (engine.kind === 'rust') return rustScaleCheck(engine);
  if (engine.kind !== 'pglite') return null;
  try {
    const stats = await engine.getStats();
    if (stats.page_count >= PGLITE_SCALE_PAGE_THRESHOLD) {
      return {
        name: 'pglite_scale',
        status: 'warn',
        message:
          `PGLite brain has ${stats.page_count} pages (threshold ${PGLITE_SCALE_PAGE_THRESHOLD}). ` +
          `Postgres gives faster search and concurrent access at this size. ` +
          `Preview the move (read-only): gbrain migrate --to postgres --plan --json; or stay on PGLite and share it with other machines: gbrain mcp expose.`,
        fix: {
          argv: PGLITE_SCALE_PLAN_ARGV, consent: [], actor: 'agent', requires_exclusive: false,
          verify: { argv: ['gbrain', 'doctor', '--only', 'pglite_scale', '--json'] }, docs: 'docs/guides/move-to-postgres.md',
          why: `At ${stats.page_count} pages Postgres searches faster and serves several machines at once. The plan is read-only: it lists what moves, what stays, the blockers and the exact run command (export the user's Postgres URL as GBRAIN_TARGET_URL and add --url-env GBRAIN_TARGET_URL; without one it proposes a target). Staying on PGLite is fine too: \`gbrain mcp expose\` shares this brain without moving it.`,
          user_message: `Your brain has ${stats.page_count} pages, the size where Postgres gets faster and lets several machines share it. Should I preview a move to Postgres (nothing changes yet), or keep it on this computer and share it over MCP with gbrain mcp expose?`,
        },
      };
    }
    return { name: 'pglite_scale', status: 'ok', message: `PGLite at ${stats.page_count} pages — comfortable below the ${PGLITE_SCALE_PAGE_THRESHOLD}-page threshold` };
  } catch {
    return null; // stats unavailable — other checks own that failure
  }
}

/**
 * The same engine-fit signal for a Rust brain: one local file, one process, the same page threshold.
 * The graduation plan reads a PGLite brain only, so the Rust warning names no `migrate --to postgres`
 * fix; it names the stay-local alternative, `gbrain mcp expose`.
 */
async function rustScaleCheck(engine: BrainEngine): Promise<Check | null> {
  try {
    const stats = await engine.getStats();
    if (stats.page_count >= PGLITE_SCALE_PAGE_THRESHOLD) {
      return {
        name: 'pglite_scale',
        status: 'warn',
        message:
          `Rust brain has ${stats.page_count} pages (threshold ${PGLITE_SCALE_PAGE_THRESHOLD}). ` +
          `Postgres gives faster search and concurrent access at this size; the move plan reads PGLite brains only. ` +
          `To share this brain with other machines without moving it: gbrain mcp expose.`,
      };
    }
    return { name: 'pglite_scale', status: 'ok', message: `Rust at ${stats.page_count} pages — comfortable below the ${PGLITE_SCALE_PAGE_THRESHOLD}-page threshold` };
  } catch {
    return null; // stats unavailable — other checks own that failure
  }
}

const RECURRENCE_WINDOW_MS = 7 * 24 * 3600 * 1000;
const RECURRENCE_THRESHOLD = 3;

export function dbRepairRecurrenceCheck(now: number = Date.now()): Check | null {
  const rows = readReceipts().filter(
    (r) => r.outcome === 'applied' && r.reason !== 'undo' && now - r.ts < RECURRENCE_WINDOW_MS,
  );
  if (rows.length === 0) return null; // no repairs on record — say nothing

  // Count per (brain_id, reason): three unrelated transient reasons in a week
  // is normal life, not a genesis problem.
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.brain_id}::${r.reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const recurring = [...counts.entries()].filter(([, n]) => n >= RECURRENCE_THRESHOLD);
  if (recurring.length === 0) {
    return { name: 'db_repair_recurrence', status: 'ok', message: `${rows.length} db-repair fix(es) applied in the last 7 days, none recurring` };
  }
  const worst = recurring.sort((a, b) => b[1] - a[1])[0];
  const [key, n] = worst;
  const reason = key.split('::')[1];
  return {
    name: 'db_repair_recurrence',
    status: 'warn',
    message:
      `db-repair applied the same fix ${n}x in 7 days (reason: ${reason}) — repeat repairs are a genesis problem, ` +
      `not bad luck. Find what keeps breaking access (server restarts? pooler caps? paused project?) instead of re-repairing.`,
    details: { reason, applied_count: n, window_days: 7 },
  };
}
