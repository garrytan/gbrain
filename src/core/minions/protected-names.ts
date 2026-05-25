/**
 * Protected job names — side-effect-free constant module.
 *
 * Names in this set require an explicit `trusted.allowProtectedSubmit: true` opt-in
 * when passed to `MinionQueue.add()`. The CLI path and the `submit_job` operation
 * (when `ctx.remote === false`) set the flag; MCP callers never do. Defense-in-depth
 * against in-process handlers that programmatically submit a shell child via
 * `queue.add('shell', ...)`.
 *
 * This file must stay pure — no imports from handlers, no filesystem, no env reads.
 * Queue core imports it; if this module grew side effects, every queue user would
 * pay them at module load.
 */

export const PROTECTED_JOB_NAMES: ReadonlySet<string> = new Set([
  'shell',
  // v0.15: subagent + aggregator are protected because they call the
  // Anthropic API. MCP callers can't submit them directly; only the
  // `gbrain agent run` CLI path (which sets allowProtectedSubmit) or a
  // trusted local `submit_job` (ctx.remote=false) can insert these rows.
  'subagent',
  'subagent_aggregator',
  // v0.36+ brain-health-100 wave (D11 from outside-voice review):
  // synthesize, patterns, consolidate are cycle phases that internally
  // submit `subagent` children with allowProtectedSubmit=true. Treating
  // them as "data-quality maintenance" was a misread — they CAN run
  // Sonnet loops costing user money. Protected ensures only trusted
  // local callers (CLI, autopilot, doctor --remediate) can submit them;
  // an OAuth-scoped MCP client can't burn the user's API budget by
  // submitting a synthesize job over HTTP.
  'synthesize',
  'patterns',
  'consolidate',
  // v0.40.3.0 — per-chunk Haiku contextual retrieval backfill. Each job
  // potentially calls Haiku 1-50 times per page; an MCP/OAuth-scoped
  // caller submitting this in bulk could drain the user's Anthropic
  // budget. Only trusted local callers (the mode-switch hook in
  // commands/config.ts, reindex sweep, doctor --remediate) can submit.
  'contextual_reindex_per_chunk',
]);

/** Check a job name against the protected set. Normalizes whitespace first. */
export function isProtectedJobName(name: string): boolean {
  return PROTECTED_JOB_NAMES.has(name.trim());
}
