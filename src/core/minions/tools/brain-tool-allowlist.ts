/**
 * v0.15 brain-tool allow-list. Review carefully when extending. Op names
 * verified against origin/master:src/core/operations.ts (post shell-jobs +
 * Knowledge Runtime).
 *
 * Read-only (all safe):
 *   query, search, get_page, list_pages,
 *   get_backlinks, traverse_graph, resolve_slugs, get_ingest_log
 *
 * Conditional write:
 *   put_page (namespace-enforced by the tool schema + server-side check)
 *
 * Every name below MUST exist in src/core/operations.ts OPERATIONS; the
 * brain-allowlist test pins this invariant so an upstream rename fails CI
 * instead of silently dropping a tool.
 */
export const BRAIN_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'query',
  'search',
  'get_page',
  'list_pages',
  'get_backlinks',
  'traverse_graph',
  // v114 (#1941): read-only provenance discovery. Edge-WRITE ops (add_link /
  // remove_link) are deliberately NOT allowlisted — exposing graph writes to
  // subagents is a separate trust decision.
  'list_link_sources',
  'resolve_slugs',
  'get_ingest_log',
  'put_page',
  // #2778: the canonical timeline-write op. Fenced exactly like put_page —
  // operations.ts:enforceSubagentSlugFence confines the target slug to the
  // trusted-workspace allow-list (or the wiki/agents/<id>/ namespace) when
  // ctx.viaSubagent=true, so a subagent can only append timeline entries to
  // pages it could have written anyway.
  'add_timeline_entry',
  // v0.29 — Salience + Anomaly Detection. Both read-only. `get_recent_transcripts`
  // is intentionally NOT included: subagent calls always have ctx.remote=true,
  // and the v0.29 trust gate rejects remote callers — adding it here would be
  // a footgun (subagent calls op, gets permission_denied, looks like a bug).
  // The cycle synthesize phase already calls discoverTranscripts directly.
  'get_recent_salience',
  'find_anomalies',
]);
