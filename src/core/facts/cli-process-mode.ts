/**
 * Local patch 2026-06-11 — short-lived-CLI marker for the facts backstop.
 *
 * Root cause: every `gbrain capture`/`put` from a one-shot CLI process
 * enqueues the facts:absorb chat call into the in-process FactsQueue, then
 * cli.ts's exit teardown drains background work for 1-2s and ABORTS the
 * in-flight chat (the extraction call takes 5-30s). Result: a
 * `pipeline_error: [chat(...)] The operation was aborted.` ingest_log row on
 * every CLI-written eligible page since the v0.42.20.0 drain-then-abort
 * teardown landed, and no facts ever extracted for those pages.
 *
 * Fix: cli.ts marks one-shot processes via markShortLivedCliProcess();
 * runFactsBackstop's queue mode checks isShortLivedCliProcess() and submits
 * a durable `facts-absorb` minion job (processed by the long-lived
 * `gbrain jobs work` daemon) instead of the doomed in-process enqueue.
 *
 * A marker (not argv heuristics) so tests and embedded/server callers are
 * never affected: only cli.ts sets it, and never for daemon commands
 * (serve / jobs / autopilot).
 */

let _shortLivedCli = false;

export function markShortLivedCliProcess(): void {
  _shortLivedCli = true;
}

export function isShortLivedCliProcess(): boolean {
  return _shortLivedCli;
}

/** @internal — test seam */
export function __resetShortLivedCliForTests(): void {
  _shortLivedCli = false;
}
