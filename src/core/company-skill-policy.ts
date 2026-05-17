import type { Operation } from './operations.ts';

export type CompanySkillMode = 'enabled' | 'admin_only' | 'disabled';

export interface CompanySkillProfile {
  version: 1;
  role: 'company';
  resolver: string;
  enabled: string[];
  admin_only: string[];
  disabled: string[];
  remote_mcp_tools: string[];
}

export const COMPANY_ENABLED_SKILLS = [
  'brain-ops',
  'query',
  'data-research',
  'perplexity-research',
  'concept-synthesis',
  'strategic-reading',
  'briefing',
  'reports',
  'maintain',
  'frontmatter-guard',
  'citation-fixer',
  'skillpack-check',
  'smoke-test',
  'ask-user',
] as const;

export const COMPANY_ADMIN_ONLY_SKILLS = [
  'setup',
  'cold-start',
  'migrate',
  'cron-scheduler',
  'minion-orchestrator',
  'webhook-transforms',
  'skill-creator',
  'skillify',
  'testing',
  'publish',
  'brain-pdf',
  'soul-audit',
  'functional-area-resolver',
] as const;

export const COMPANY_DISABLED_SKILLS = [
  'ingest',
  'idea-ingest',
  'media-ingest',
  'meeting-ingestion',
  'enrich',
  'repo-architecture',
  'daily-task-manager',
  'daily-task-prep',
  'cross-modal-review',
  'book-mirror',
  'article-enrichment',
  'archive-crawler',
  'academic-verify',
  'voice-note-ingest',
] as const;

const COMPANY_REMOTE_MCP_OPERATION_NAMES = new Set([
  'get_page',
  'list_pages',
  'search',
  'query',
  'get_tags',
  'get_links',
  'get_backlinks',
  'traverse_graph',
  'get_timeline',
  'get_stats',
  'get_health',
  'run_doctor',
  'get_brain_identity',
  'whoami',
  'sources_list',
  'sources_status',
  'recall',
  'get_recent_salience',
  'find_anomalies',
  'find_experts',
  'find_contradictions',
]);

export function companySkillProfile(): CompanySkillProfile {
  return {
    version: 1,
    role: 'company',
    resolver: 'skills/COMPANY_RESOLVER.md',
    enabled: [...COMPANY_ENABLED_SKILLS],
    admin_only: [...COMPANY_ADMIN_ONLY_SKILLS],
    disabled: [...COMPANY_DISABLED_SKILLS],
    remote_mcp_tools: [...COMPANY_REMOTE_MCP_OPERATION_NAMES].sort(),
  };
}

export function isCompanyRemoteOperationAllowed(op: Operation): boolean {
  if (op.localOnly) return false;
  return COMPANY_REMOTE_MCP_OPERATION_NAMES.has(op.name);
}

export function filterOperationsForBrainRole(
  ops: Operation[],
  role: 'individual' | 'company',
): Operation[] {
  if (role !== 'company') return ops;
  return ops.filter(isCompanyRemoteOperationAllowed);
}
