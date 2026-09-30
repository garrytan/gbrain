import type { Migration } from './types.ts';

export const v131: Migration = {
  version: 131,
  name: 'drop_job_wide_subagent_tool_use_id_unique',
  // #4155 — tool_use_id stores the RAW provider id, and some providers
  // legitimately reuse the same short id on every turn (claude-cli spawns a
  // fresh subprocess per turn from an id-stripped transcript, so the model
  // re-invents ids like "toolu_01"). The job-wide UNIQUE (job_id,
  // tool_use_id) constraint encoded the false assumption that provider ids
  // are unique within a job; a reuse collided (this was never any INSERT's
  // conflict target) and dead-lettered the job. Row identity is already
  // carried by subagent_tool_executions_stable_id UNIQUE (job_id,
  // message_idx, ordinal); readers resolve executions by (message_idx,
  // tool_use_id). A narrower unique (e.g. adding message_idx) would still
  // dead-letter a turn that reuses one id twice, so no replacement
  // constraint is added. Same SQL on both engines; DROP CONSTRAINT IF
  // EXISTS makes re-runs a no-op (v82 pglite precedent).
  // (Authored as v129; renumbered to v131 after #4152 and #4145 landed
  // 129/130 first — same renumber pattern as v130 itself.)
  // Mixed-version fleets: an OLD binary still naming this constraint as an
  // ON CONFLICT target errors (SQLSTATE 42P10) on every tool persist once
  // the drop runs — fail-loud, not corrupting. Multi-worker Postgres
  // deployments should stop `jobs work` daemons before upgrading and
  // restart them on the new binary (release-noted in v0.46.14.0).
  idempotent: true,
  sql: `
      ALTER TABLE subagent_tool_executions
        DROP CONSTRAINT IF EXISTS uniq_subagent_tools_use_id;
    `,
};
