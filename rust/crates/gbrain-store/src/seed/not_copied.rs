//! The primary tables the seed does not copy on purpose: job queue, telemetry, caches and
//! machine-local state, each with the read that differs on a seeded store. This is the only list
//! of tables the seed may leave behind. A table on the list can still hold rows that are brain
//! state ([`GapRows`]): those rows are counted as a gap of their own. Every other primary table that the seed does not copy is a
//! gap: the seed counts its rows (`unseeded_gap_rows` in `seed.json`), and a swap to the seeded
//! store is refused while any gap count is above zero. A table added to the schema is a gap until
//! the seed copies it or this list names it.

use serde::Serialize;

/// Why the seed leaves a table behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LossKind {
    /// The job queue and its runtime: a swap runs on a drained queue.
    Jobs,
    /// Logs and counters that start again from zero.
    Telemetry,
    /// Caches that the next read or run rebuilds.
    Cache,
    /// State of one machine or one run: locks, leases, checkpoints, the write path.
    MachineLocal,
    /// The segments of segmented page bodies: the page and its body columns are copied, its text
    /// is not.
    SegmentedBody,
    /// Rows that exist only to be locked: a write inserts the row, then selects it `FOR UPDATE`, so
    /// the row holds no data and no read returns it. The store holds the same lock on the page
    /// key (`transactions.rs` `hold_page_keys`).
    LockAnchor,
}

/// The rows of a not-copied table that are brain state, not machine state: the rows whose
/// `column` equals `equals`. The seed counts them as the gap `gap`, so a swap is refused while any
/// exist, until a relation copies them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GapRows {
    pub gap: &'static str,
    pub column: &'static str,
    pub equals: &'static str,
}

/// One table the seed does not copy.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NotCopied {
    pub table: &'static str,
    pub kind: LossKind,
    /// The read that differs on the seeded store.
    pub read: &'static str,
    /// Rows of the table that are a gap, not a loss.
    pub gap_rows: Option<GapRows>,
}

const fn t(table: &'static str, kind: LossKind, read: &'static str) -> NotCopied {
    NotCopied {
        table,
        kind,
        read,
        gap_rows: None,
    }
}

use LossKind::{Cache, Jobs, LockAnchor, MachineLocal, SegmentedBody, Telemetry};

/// Sorted by table.
pub const NOT_COPIED: &[NotCopied] = &[
    t(
        "chat_usage_log",
        Telemetry,
        "get_usage cost totals start at zero",
    ),
    t(
        "code_traversal_cache",
        Cache,
        "the first code traversal of each query runs again",
    ),
    t(
        "conversation_parser_llm_cache",
        Cache,
        "the first parse of each conversation calls the model again",
    ),
    t(
        "dream_verdicts",
        Cache,
        "each transcript is triaged again (a paid call) before dream synthesis",
    ),
    t(
        "engine_writer_coverage_gaps",
        MachineLocal,
        "swap eligibility's writer gap rows of the primary start empty",
    ),
    t(
        "engine_writer_observations",
        MachineLocal,
        "swap eligibility's writer observations of the primary start empty",
    ),
    t(
        "engine_writer_sessions",
        MachineLocal,
        "swap eligibility's writing connections of the primary start empty",
    ),
    t(
        "eval_candidates",
        Telemetry,
        "captured eval candidates start empty",
    ),
    t(
        "eval_capture_failures",
        Telemetry,
        "eval capture failures start empty",
    ),
    t(
        "eval_contradictions_cache",
        Cache,
        "contradiction probes run again",
    ),
    t(
        "eval_contradictions_runs",
        Telemetry,
        "past contradiction runs are not listed",
    ),
    t(
        "eval_takes_quality_runs",
        Telemetry,
        "past takes-quality runs are not listed",
    ),
    t(
        "extract_atoms_page_state",
        MachineLocal,
        "atom extraction checks every page again",
    ),
    t(
        "extract_atoms_transcript_state",
        MachineLocal,
        "atom extraction checks every transcript again",
    ),
    t(
        "extract_rollup_7d",
        Cache,
        "the 7-day extraction rollup is recomputed",
    ),
    t(
        "file_migration_ledger",
        MachineLocal,
        "the Postgres file storage migration ledger",
    ),
    t(
        "gbrain_cycle_locks",
        MachineLocal,
        "a cycle lock held at the swap is released",
    ),
    t(
        "ingest_log",
        Telemetry,
        "gbrain ingest history starts empty",
    ),
    t(
        "mcp_request_log",
        Telemetry,
        "per-client request history in gbrain auth starts empty; lifetime totals carry in mcp_request_log_rollup",
    ),
    t(
        "mention_gazetteer_entries",
        Cache,
        "the next mention pass rescans every page, not only the pages a name change touches",
    ),
    t(
        "mention_index_status",
        MachineLocal,
        "the mention index is rebuilt",
    ),
    t(
        "migration_impact_log",
        Telemetry,
        "past migration impact notes are not listed",
    ),
    t(
        "minion_attachments",
        Jobs,
        "attachments of jobs go with the jobs",
    ),
    t(
        "minion_budget_log",
        Jobs,
        "gbrain jobs watch shows no earlier budget spend",
    ),
    t(
        "minion_inbox",
        Jobs,
        "messages between jobs go with the jobs",
    ),
    t(
        "minion_jobs",
        Jobs,
        "gbrain jobs list is empty; the seed counts non-terminal jobs, so swap on a drained queue",
    ),
    t(
        "minion_lease_pressure_log",
        Jobs,
        "gbrain jobs stats shows no lease pressure for the last hour",
    ),
    t(
        "minion_self_fix_log",
        Jobs,
        "earlier job self-fix attempts are not listed",
    ),
    t(
        "op_checkpoint_paths",
        MachineLocal,
        "an interrupted bulk operation starts again",
    ),
    NotCopied {
        table: "op_checkpoints",
        kind: MachineLocal,
        read: "an interrupted bulk operation starts again",
        // A pending rename repair (src/core/sync-identity-downgrades.ts): the purge of deleted
        // pages holds the old page of such a record, and the rename repair reads it.
        gap_rows: Some(GapRows {
            gap: "sync_identity_downgrades",
            column: "op",
            equals: "sync-identity-downgrade",
        }),
    },
    t(
        "page_body_manifest",
        SegmentedBody,
        "a segmented page reads as its shell, without its text",
    ),
    t(
        "page_body_staging_parts",
        SegmentedBody,
        "a body write in flight at the swap is not carried",
    ),
    t(
        "page_body_staging_texts",
        SegmentedBody,
        "a body write in flight at the swap is not carried",
    ),
    t(
        "page_body_stagings",
        SegmentedBody,
        "a body write in flight at the swap is not carried",
    ),
    t(
        "page_generation_clock",
        Cache,
        "cached query results recompute (the query cache is not copied, and no store read uses this clock)",
    ),
    t(
        "page_mention_state",
        MachineLocal,
        "mention scanning checks every page again",
    ),
    t(
        "page_retrievals",
        Telemetry,
        "page retrieval counts start at zero",
    ),
    t(
        "page_segment_derivation_purge_pages",
        SegmentedBody,
        "segment derivation purges are not listed",
    ),
    t(
        "page_segment_derivation_purges",
        SegmentedBody,
        "segment derivation purges are not listed",
    ),
    t(
        "page_segment_derivations",
        SegmentedBody,
        "segment derivations are made again",
    ),
    t(
        "page_segment_texts",
        SegmentedBody,
        "a segmented page reads as its shell, without its text",
    ),
    t(
        "page_view_digests",
        Cache,
        "view sizes and digests of segmented pages are recomputed by the next read",
    ),
    t(
        "page_write_guards",
        LockAnchor,
        "none: the rows only anchor the page write lock (insert, then SELECT ... FOR UPDATE) and no read returns them; the store holds that lock on the page key",
    ),
    t(
        "persistence_brain",
        MachineLocal,
        "the write path of the primary brain",
    ),
    t(
        "persistence_consumers",
        MachineLocal,
        "the write path of the primary brain",
    ),
    t(
        "persistence_counters",
        MachineLocal,
        "the write path of the primary brain",
    ),
    t(
        "persistence_effects",
        MachineLocal,
        "the write path of the primary brain",
    ),
    t(
        "persistence_graduation",
        MachineLocal,
        "the write path of the primary brain",
    ),
    t(
        "persistence_host_bindings",
        MachineLocal,
        "the write path of the primary brain",
    ),
    t(
        "persistence_local_writers",
        MachineLocal,
        "the write path of the primary brain",
    ),
    t(
        "persistence_requests",
        MachineLocal,
        "gbrain write-request receipts of the primary are not listed",
    ),
    t(
        "persistence_source_bindings",
        MachineLocal,
        "the write path of the primary brain",
    ),
    t(
        "persistence_topology_changes",
        MachineLocal,
        "the write path of the primary brain",
    ),
    t(
        "persistence_worktree_refreshes",
        MachineLocal,
        "the write path of the primary brain",
    ),
    t(
        "persistence_worktrees",
        MachineLocal,
        "the write path of the primary brain",
    ),
    t(
        "persistence_writer_protocols",
        MachineLocal,
        "the write path of the primary brain",
    ),
    t(
        "planner_stats_deltas",
        MachineLocal,
        "PGLite planner accounting",
    ),
    t(
        "planner_stats_state",
        MachineLocal,
        "PGLite planner accounting",
    ),
    t(
        "query_cache",
        Cache,
        "the first run of each cached query runs again",
    ),
    t(
        "reason_purge_tombstones",
        MachineLocal,
        "purge reasons of the primary are not listed",
    ),
    t(
        "retrieval_event_links",
        Telemetry,
        "retrieval event history starts empty",
    ),
    t(
        "retrieval_event_pages",
        Telemetry,
        "retrieval event history starts empty",
    ),
    t(
        "retrieval_events",
        Telemetry,
        "retrieval event history starts empty",
    ),
    t(
        "search_telemetry",
        Telemetry,
        "gbrain search stats starts at zero",
    ),
    t(
        "session_context_state",
        MachineLocal,
        "each agent session starts a new context window",
    ),
    t(
        "subagent_messages",
        Jobs,
        "gbrain agent logs shows no earlier subagent runs",
    ),
    t(
        "subagent_rate_leases",
        Jobs,
        "subagent rate leases start again",
    ),
    t(
        "subagent_tool_executions",
        Jobs,
        "gbrain agent logs shows no earlier tool calls",
    ),
    t(
        "sync_notifier_leases",
        MachineLocal,
        "the sync notifier of the primary",
    ),
    t(
        "sync_notifier_sources",
        MachineLocal,
        "the sync notifier of the primary",
    ),
    t(
        "sync_wanted_markers",
        MachineLocal,
        "sync markers of the primary",
    ),
    t("take_grade_cache", Cache, "takes are graded again"),
    t(
        "take_nudge_log",
        Telemetry,
        "earlier take nudges are not listed, so a nudge can repeat",
    ),
    t(
        "think_ab_results",
        Telemetry,
        "past think A/B results are not listed",
    ),
    t(
        "trust_policy_state",
        MachineLocal,
        "each engine keeps its own trust policy generation counter; it is never copied",
    ),
    t(
        "wake_subscriptions",
        Jobs,
        "open watches are not carried and never wake; a watch copied without its job or write request would wake on the first tick",
    ),
    t(
        "write_gate_holds",
        MachineLocal,
        "write gate holds of the primary are released",
    ),
    t(
        "write_gate_receipts",
        MachineLocal,
        "write gate receipts of the primary are not listed",
    ),
];
