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
  next_actions: string[];
  limitations: string[];
}
