/**
 * Process exit statuses with a contract beyond "0 ok / 1 failed". One home so
 * a new status cannot silently reuse a value a caller already branches on.
 *
 * Agent operator contract v1 table (docs/guides/exit-codes.md):
 *   0 ok · 1 failed (class/retryable in JSON) · 2 usage / invalid input ·
 *   3 confirmation_required (its ONLY meaning) · 10 write pending ·
 *   11 resumable budget stop · 13 harness wired, verification pending ·
 *   14 harness wired, shared-skills/token cleanup pending ·
 *   69 serve exited unhealthy · 75 migration
 *   lock held · 124 timeout · 130 interrupted. `test/exit-codes.test.ts` enumerates every literal
 *   exit 3 in src/ so a new one cannot reuse it.
 */

export const OK_EXIT_CODE = 0;
export const FAILED_EXIT_CODE = 1;
/** Usage error or invalid input (`invalid_params`, `unknown_flag`). */
export const USAGE_EXIT_CODE = 2;
/**
 * The command needs the user's authorization and ran nothing
 * (`confirmation_required`; `--json` prints the consent payload). Agents stop
 * and ask. `mcp expose` and `google` also use 2 for this under v1 (legacy).
 */
export const CONFIRMATION_REQUIRED_EXIT_CODE = 3;
/** The command's own deadline elapsed; work may still be running elsewhere. */
export const TIMEOUT_EXIT_CODE = 124;
/** Interrupted by a signal (SIGINT). */
export const INTERRUPTED_EXIT_CODE = 130;

/** A runner refused because another runner holds the migration lock (EX_TEMPFAIL). */
export const MIGRATIONS_RUNNING_EXIT_CODE = 75;

/**
 * #5232 (O-ENG-1): the write was admitted and is still pending; it may commit
 * later. Distinct from 75, which `gbrain upgrade` reads as "another
 * migration runner holds the lock". Exit 0 means committed; pass
 * `--accept-pending` (or GBRAIN_ACCEPT_PENDING=1) to map pending to 0.
 */
export const PENDING_WRITE_EXIT_CODE = 10;

/**
 * A bounded run stopped at its time budget with work left (`gbrain embed
 * --stale`). Partial and resumable: stdout names the remaining count and the
 * exact resume command. Distinct from 1, which means something failed, and
 * from 3, which agent-facing commands reserve for "ask the user first".
 */
export const BUDGET_STOP_EXIT_CODE = 11;

/**
 * #6661: `gbrain bootstrap harness --token` on a PGLite brain wired every
 * target while no serve answered (`pending_verify`): nothing failed, nothing
 * verified yet. The JSON `fix` names the re-run that completes it once
 * `gbrain serve --http` runs; `--status` stays partial until then.
 */
export const HARNESS_PENDING_VERIFY_EXIT_CODE = 13;

/**
 * #6743: `gbrain bootstrap harness` wired and verified the harness, but the
 * cleanup of earlier shared-skills enrollments or carried token ids is still
 * pending (`bootstrap_cleanup_pending`). The JSON lists each id's state; its
 * `fix` re-runs the command when every id can converge, or names the owner's
 * revoke or leave step when one cannot.
 */
export const HARNESS_CLEANUP_PENDING_EXIT_CODE = 14;

/**
 * #6543: `gbrain serve` exited on its own because its persistence consumer
 * reported `restart_required` continuously for `GBRAIN_SERVE_RESTART_REQUIRED_EXIT_SECONDS`
 * (`serve_unhealthy_exit`). EX_UNAVAILABLE: a supervisor restarts it.
 */
export const SERVE_UNHEALTHY_EXIT_CODE = 69;
