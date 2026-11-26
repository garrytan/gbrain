/**
 * The purge stores the Rust store keeps no rows of, read by the fact purge's probes (purge-plan.ts) and the page purge
 * receipt (purge-receipt.ts). Constants, not members: index.ts spreads every export of a member module into
 * STORE_MEMBERS, so they live outside one.
 */
/** Inventory tables the store keeps no rows of: a probe of one finds nothing. */
export const STORE_ABSENT_PROBE_TABLES: ReadonlySet<string> = new Set([
  'conversation_parser_llm_cache', 'drift_decisions',
  'eval_takes_quality_runs', 'link_edge_proposals', 'memory_proposals', 'migration_impact_log', 'persistence_graduation',
  'persistence_worktree_refreshes', 'session_context_state', 'shared_skill_revisions',
  'source_ingestion_receipts', 'sync_notifier_sources', 'take_grade_cache', 'think_ab_results',
  // The store keeps no raw upload parts and no retrieval event, feedback or weight record.
  'page_body_staging_parts', 'retrieval_event_links', 'retrieval_event_pages', 'retrieval_feedback',
  'retrieval_weights',
  // The store keeps no learning ledger (master's v334 learning_items; the nightly learning pass is TypeScript-only).
  'learning_items',
]);

/**
 * The slug-keyed stores of a page purge receipt the store keeps no rows of, so a probe of one finds nothing:
 * the retrieval event, link, feedback and weight stores (reserved keyspaces that hold no record). The store keeps the gazetteer and the push-context log `context_volunteer_events`, so their probes run there.
 * `query_cache` is the same:
 * the store keeps no query cache, as `clearQueryCache` answering 0 says.
 */
export const RECEIPT_ABSENT_SLUG_STORES: ReadonlySet<string> = new Set([
  'retrieval_event_pages', 'retrieval_event_links', 'retrieval_feedback', 'retrieval_weights',
]);
