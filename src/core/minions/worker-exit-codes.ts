/**
 * Reserved worker process exit codes — single source of truth shared by the
 * worker (which sets them) and the supervisor / CLI (which classify them).
 *
 * Why a dedicated code for the RSS watchdog drain: before v0.42.5.0 the
 * watchdog called `gracefulShutdown('watchdog')` which set `running=false` and
 * let the process exit via natural cleanup → **exit code 0**. The supervisor
 * classifies code 0 as `clean_exit` and does NOT increment `crashCount`, so a
 * watchdog drain was indistinguishable from a healthy queue-drain. On a box
 * where the embed working set legitimately needs ~10GB but the cap is 2048MB,
 * that produced a silent ~400×/24h respawn loop whose only visible symptom was
 * the downstream DB-connection cascade from the worker being drained mid-cycle
 * (issue #1678). A distinct, reserved exit code makes the watchdog drain
 * self-identifying: `worker_exited likely_cause=rss_watchdog` instead of
 * `clean_exit`, and lets the supervisor apply a cause-keyed backoff + loud
 * operator alert.
 *
 * Range choice: small single-digit-teens integer, deliberately outside
 * {0 clean, 1 runtime_error} and the 128+N signal-derived range. 12 has no
 * other meaning in this codebase.
 */

/** Worker drained itself because RSS crossed the watchdog cap. */
export const WORKER_EXIT_RSS_WATCHDOG = 12;
