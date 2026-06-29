export interface AgentTrustExplainReport {
  installed_surface: {
    command: string;
    mcp_registrations: string[];
    prompt_rules_version: string | null;
    claude_stop_hook: 'installed' | 'missing' | 'invalid' | 'not_applicable';
  };
  memory_behavior: {
    answer_authority: string[];
    hint_only_surfaces: string[];
    writeback_route: string;
    read_context_evidence_boundary: true;
    canonical_write_requirements: [
      'canonical_write_allowed',
      'target_snapshot_hash',
      'write_session_id',
      'expected_content_hash',
    ];
    graph_frontier_default: 'off';
  };
  proof: {
    status: 'pass' | 'fail';
    scenarios: string[];
    authority_violations: number;
    mutations: number;
  };
  self_service_analytics: {
    docs_manifest_resources: string[];
    trust_footer_contract: 'retrieve_context_and_read_context';
    eval_ledger: 'context_eval_runs_assertions_corrections';
  };
  next_actions: string[];
  limitations: string[];
}
