import { isSourceFederated, parseSourceConfig, type SourceRow } from './sources-load.ts';

export type SourceRole =
  | 'company_knowledge'
  | 'public_site'
  | 'runtime_ops'
  | 'measurement'
  | 'daily_front_door'
  | 'memory_engine'
  | 'agent_runtime'
  | 'workflow_lab'
  | 'default_inbox'
  | 'repo_memory';

export interface SourcePlanInput extends SourceRow {
  page_count: number;
}

export interface SourcePlanEntry {
  id: string;
  name: string;
  local_path: string | null;
  role: SourceRole;
  label: string;
  responsibility: string;
  federated: boolean;
  page_count: number;
  last_sync_at: string | null;
  search_behavior: string;
  next_action: string;
}

export interface SourcePlanReport {
  schema_version: 1;
  topology: {
    brain: 'host';
    shape: 'single_host_multi_source';
    summary: string;
  };
  counts: {
    sources: number;
    federated: number;
    isolated: number;
    pages: number;
  };
  sources: SourcePlanEntry[];
  gaps: string[];
  next_actions: string[];
}

interface RoleInfo {
  role: SourceRole;
  label: string;
  responsibility: string;
}

const ROLE_INFO: Record<SourceRole, Omit<RoleInfo, 'role'>> = {
  company_knowledge: {
    label: 'Company knowledge',
    responsibility: 'Business context, strategy, decisions, research, and durable company memory.',
  },
  public_site: {
    label: 'Public site execution',
    responsibility: 'Public pages, SEO copy, stays, landing surfaces, and customer-facing site work.',
  },
  runtime_ops: {
    label: 'Runtime and operators',
    responsibility: 'Workers, alerts, operator workflows, delivery state, and runtime receipts.',
  },
  measurement: {
    label: 'Measurement',
    responsibility: 'Analytics, attribution, dashboards, metrics, and evidence for business decisions.',
  },
  daily_front_door: {
    label: 'Daily front door',
    responsibility: 'Today, open loops, receipts, next actions, and Sawyer-facing operating context.',
  },
  memory_engine: {
    label: 'Memory engine',
    responsibility: 'GBrain product/runtime code and the memory system itself.',
  },
  agent_runtime: {
    label: 'Agent runtime',
    responsibility: 'Agent host behavior, runtime front door, and assistant execution surfaces.',
  },
  workflow_lab: {
    label: 'Workflow lab',
    responsibility: 'Benchmarks, evals, repeatable loops, and workflow-quality experiments.',
  },
  default_inbox: {
    label: 'Default inbox',
    responsibility: 'Fallback or legacy/default source. Should stay deliberate so it does not become a junk drawer.',
  },
  repo_memory: {
    label: 'Repo memory',
    responsibility: 'Repository-specific memory that agents can search when working in that repo.',
  },
};

export function classifySourceRole(source: Pick<SourcePlanInput, 'id' | 'name' | 'local_path'>): RoleInfo {
  const haystack = `${source.id} ${source.name} ${source.local_path ?? ''}`.toLowerCase();
  let role: SourceRole = 'repo_memory';

  if (source.id === 'default') role = 'default_inbox';
  else if (haystack.includes('seascape-hub')) role = 'company_knowledge';
  else if (haystack.includes('seascape-vacations-site') || haystack.includes('vacations-site')) role = 'public_site';
  else if (haystack.includes('seascape-ops')) role = 'runtime_ops';
  else if (haystack.includes('seascape-analytics')) role = 'measurement';
  else if (haystack.includes('sawyer-hub')) role = 'daily_front_door';
  else if (
    source.id === 'gbrain' ||
    /(?:^|\/)gbrain(?:$|[-_a-z0-9]+)/.test(source.local_path ?? '') ||
    /^gbrain(?:$|[-_a-z0-9]+)/.test(source.id)
  ) role = 'memory_engine';
  else if (haystack.includes('hermes')) role = 'agent_runtime';
  else if (haystack.includes('codex-quality-lab')) role = 'workflow_lab';

  return { role, ...ROLE_INFO[role] };
}

export function buildSourcePlanReport(sources: SourcePlanInput[]): SourcePlanReport {
  const entries = sources.map((source) => {
    const config = parseSourceConfig(source.config);
    const role = classifySourceRole(source);
    const federated = isSourceFederated(config);
    const lastSync = source.last_sync_at ? new Date(source.last_sync_at).toISOString() : null;

    return {
      id: source.id,
      name: source.name,
      local_path: source.local_path,
      role: role.role,
      label: role.label,
      responsibility: role.responsibility,
      federated,
      page_count: source.page_count,
      last_sync_at: lastSync,
      search_behavior: federated
        ? 'Included in cross-source default search.'
        : 'Searched when the source is resolved by path or explicitly named.',
      next_action: nextActionForSource(source, role.role, federated),
    } satisfies SourcePlanEntry;
  });

  const federatedCount = entries.filter((s) => s.federated).length;
  const gaps = buildGaps(entries);

  return {
    schema_version: 1,
    topology: {
      brain: 'host',
      shape: 'single_host_multi_source',
      summary: 'One host brain indexes multiple repo sources. GBrain is the memory/search layer above them, not the owner of each repo source of truth.',
    },
    counts: {
      sources: entries.length,
      federated: federatedCount,
      isolated: entries.length - federatedCount,
      pages: entries.reduce((sum, s) => sum + s.page_count, 0),
    },
    sources: entries,
    gaps,
    next_actions: buildNextActions(entries, gaps),
  };
}

function nextActionForSource(source: SourcePlanInput, role: SourceRole, federated: boolean): string {
  if (source.page_count === 0) {
    return 'Sync or remove this source; empty sources make search behavior harder to trust.';
  }
  if (role === 'company_knowledge' && !federated) {
    return 'Consider federating if this should answer broad company-context questions.';
  }
  if (role === 'daily_front_door' && !federated) {
    return 'Consider federating if daily/open-loop context should appear in broad searches.';
  }
  if (role === 'default_inbox') {
    return 'Keep this intentional: use it as a fallback inbox only, not as canon for owned repos.';
  }
  if (role === 'memory_engine') {
    return 'Keep as engine/runtime memory; promote durable behavior changes through repo docs or code.';
  }
  if (role === 'workflow_lab') {
    return 'Use as eval/workflow evidence; promote only proven reusable loops into owning repos.';
  }
  return federated
    ? 'Healthy shape for broad retrieval; keep canon edits in the owning repo.'
    : 'Healthy as an isolated lane; use --source or path routing when agents need it.';
}

function buildGaps(entries: SourcePlanEntry[]): string[] {
  const gaps: string[] = [];
  const roles = new Set(entries.map((s) => s.role));

  if (!roles.has('company_knowledge')) gaps.push('No company-knowledge source detected.');
  if (!roles.has('daily_front_door')) gaps.push('No daily-front-door source detected.');
  if (!roles.has('runtime_ops')) gaps.push('No runtime/ops source detected.');
  if (!roles.has('measurement')) gaps.push('No measurement source detected.');

  const defaultEntry = entries.find((s) => s.role === 'default_inbox');
  if (defaultEntry && defaultEntry.page_count > 0 && !defaultEntry.federated) {
    gaps.push('The default inbox has pages but is isolated; verify this is intentional and not old source drift.');
  }

  const cryptic = entries.filter((s) => /^gstack-code-[a-z0-9-]+/.test(s.id));
  if (cryptic.length > 0) {
    gaps.push('Some source ids are machine-generated; use display names or a source plan when explaining them to operators.');
  }

  return gaps;
}

function buildNextActions(entries: SourcePlanEntry[], gaps: string[]): string[] {
  const actions: string[] = [];

  actions.push('Use GBrain as the cross-repo memory/search layer; keep source-of-truth edits in the owning repo.');

  if (gaps.length > 0) {
    actions.push('Resolve the source-map gaps before adding more automation.');
  }

  if (entries.some((s) => s.role === 'daily_front_door')) {
    actions.push('Build a daily Needs Attention brief from these sources: what changed, what is stale, and what needs Sawyer next.');
  }

  if (entries.some((s) => s.role === 'company_knowledge')) {
    actions.push('Make writeback recommendations explicit: save to company knowledge, daily front door, owning runtime repo, or do not save.');
  }

  actions.push('Use doctor/status as the proof gate before trusting broader automation.');
  return actions;
}
