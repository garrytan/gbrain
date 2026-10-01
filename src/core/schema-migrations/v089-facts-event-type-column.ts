import type { Migration } from './types.ts';

export const v089: Migration = {
  version: 89,
  name: 'facts_event_type_column',
  // v0.40.2.0 — trajectory routing wave.
  //
  // Adds nullable `event_type TEXT` to facts so the existing typed-claim
  // substrate (v0.35.4 / v67) can carry event-shaped rows (e.g.
  // event_type='meeting', 'job_change', 'location_change') alongside
  // metric-shaped rows (claim_metric / claim_value etc). Temporal-
  // reasoning LongMemEval questions ask about event chronology that the
  // metric-only shape couldn't carry; this column is the minimum
  // schema extension that lets `findTrajectory` surface event rows
  // alongside metric rows in one chronological stream.
  //
  // Column-only, no index. Existing callers (founder-scorecard,
  // eval-trajectory, gbrain think) already defensively skip NULL-metric
  // rows in their per-metric math, so event-only rows ride through
  // invisibly. Structured event fields (object/actor/location) are
  // deferred to v0.40.3+ once usage shows what fields are needed.
  //
  // ADD COLUMN with no DEFAULT (NULL) is metadata-only on Postgres 11+
  // and PGLite; instant on tables of any size. No bootstrap probe
  // needed (no index, no FK references this column) — exemption pinned
  // in test/schema-bootstrap-coverage.test.ts COLUMN_EXEMPTIONS.
  //
  // Renumbered v81→v82→v86→v87→v89 across four master merges:
  //   v81 claimed by v0.38.0.0 (pages_provenance_columns).
  //   v82-v85 claimed by v0.38.1.0 (subagent_tool_executions_stable_id,
  //   mcp_spend_reservations, oauth_clients_budget_usd_per_day,
  //   oauth_clients_agent_binding).
  //   v86 claimed by v0.39.0.0 (page_links_view_alias).
  //   v87-v88 claimed by v0.39.1.0 (takes_kind_drop_check,
  //   eval_candidates_schema_pack_per_source).
  idempotent: true,
  sql: `
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS event_type TEXT;
    `,
};
