import type { AgentTrustExplainReport } from '../types/agent-trust-explain.ts';
import type { ProofAgentReport } from '../types.ts';
import type {
  InstalledAgentCheck,
  InstalledAgentReadinessReport,
} from './installed-agent-readiness-service.ts';

export interface BuildAgentTrustExplainInput {
  command: string;
  installedAgent: InstalledAgentReadinessReport;
  expectedRulesVersion: string;
  proof: ProofAgentReport;
}

const CANONICAL_WRITE_REQUIREMENTS = [
  'canonical_write_allowed',
  'target_snapshot_hash',
  'expected_content_hash',
] as const;

export function buildAgentTrustExplainReport(
  input: BuildAgentTrustExplainInput,
): AgentTrustExplainReport {
  return {
    installed_surface: {
      command: input.command,
      mcp_registrations: summarizeMcpRegistrations(input.installedAgent.checks),
      prompt_rules_version: detectPromptRulesVersion(input.installedAgent.checks, input.expectedRulesVersion),
      claude_stop_hook: summarizeClaudeStopHook(input.installedAgent.checks),
    },
    memory_behavior: {
      answer_authority: [
        'read_context canonical reads',
        'reviewed compiled truth',
        'explicitly scoped personal/profile memory',
      ],
      hint_only_surfaces: [
        'retrieve_context search/query chunks',
        'Memory Inbox candidates',
        'graph paths',
        'raw episodes',
        'Dream outputs',
      ],
      writeback_route: 'route_memory_writeback',
      read_context_evidence_boundary: true,
      canonical_write_requirements: [...CANONICAL_WRITE_REQUIREMENTS],
      graph_frontier_default: 'off',
    },
    proof: {
      status: input.proof.status,
      scenarios: input.proof.scenarios.map((scenario) => scenario.id),
      authority_violations: input.proof.authority_violations.length,
      mutations: input.proof.mutations.length,
    },
    next_actions: buildNextActions(input.installedAgent, input.proof),
    limitations: [
      'This report is read-only; it does not run setup, uninstall, capture, sync, promotion, Dream apply, or canonical writes.',
      'Candidates, graph paths, Dream outputs, and raw episodes are not answer authority by default.',
      'Graph frontier remains off unless an explicit graph planning mode enables it.',
    ],
  };
}

function summarizeMcpRegistrations(checks: InstalledAgentCheck[]): string[] {
  return checks
    .filter((check) => check.name === 'codex_mcp_registration' || check.name === 'claude_mcp_registration')
    .map((check) => `${check.name.replace('_mcp_registration', '')}: ${check.status}`);
}

function detectPromptRulesVersion(
  checks: InstalledAgentCheck[],
  expectedRulesVersion: string,
): string | null {
  const promptChecks = checks.filter((check) =>
    check.name === 'codex_prompt_rules' || check.name === 'claude_prompt_rules'
  );
  const installedPrompt = promptChecks.find((check) => check.status === 'ok');
  return installedPrompt ? expectedRulesVersion : null;
}

function summarizeClaudeStopHook(
  checks: InstalledAgentCheck[],
): AgentTrustExplainReport['installed_surface']['claude_stop_hook'] {
  const check = checks.find((candidate) => candidate.name === 'claude_stop_hook');
  if (!check) return 'not_applicable';
  if (check.status === 'ok') return 'installed';
  if (check.status === 'warn') return 'missing';
  return 'invalid';
}

function buildNextActions(
  installedAgent: InstalledAgentReadinessReport,
  proof: ProofAgentReport,
): string[] {
  const actions = new Set<string>();
  if (installedAgent.status === 'fail') {
    actions.add('Fix failed installed-agent readiness checks before relying on agent memory behavior.');
  }
  if (hasMcpReadinessIssue(installedAgent.checks)) {
    actions.add('Run mbrain setup-agent --preview to inspect MCP registration changes.');
  }
  if (hasCheckWithPrefix(installedAgent.checks, 'codex_prompt_rules', ['warn', 'fail'])
    || hasCheckWithPrefix(installedAgent.checks, 'claude_prompt_rules', ['warn', 'fail'])
    || hasCheckWithPrefix(installedAgent.checks, 'agent_prompt_rules', ['warn', 'fail'])) {
    actions.add('Run mbrain setup-agent --preview to inspect prompt rule changes.');
  }
  if (proof.status === 'fail') {
    actions.add('Run mbrain proof-agent --verbose to inspect failed proof scenarios.');
  }

  return actions.size > 0 ? [...actions] : ['No action required.'];
}

function hasCheckWithPrefix(
  checks: InstalledAgentCheck[],
  prefix: string,
  statuses: Array<InstalledAgentCheck['status']>,
): boolean {
  return checks.some((check) => check.name.startsWith(prefix) && statuses.includes(check.status));
}

function hasMcpReadinessIssue(checks: InstalledAgentCheck[]): boolean {
  return checks.some((check) =>
    (check.name.startsWith('mcp_') || check.name.endsWith('_mcp_registration'))
    && (check.status === 'warn' || check.status === 'fail')
  );
}
