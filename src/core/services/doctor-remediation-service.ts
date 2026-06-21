import type { DoctorCheck, DoctorInputs } from './doctor-service.ts';

export type DoctorRemediationPriority = 'p0' | 'p1' | 'p2';
export type DoctorRemediationCategory =
  | 'agent_setup'
  | 'runtime_config'
  | 'database_schema'
  | 'embedding'
  | 'sync'
  | 'memory_governance'
  | 'process_lifecycle'
  | 'manual_investigation';

export interface DoctorRemediationCommand {
  kind: 'inspect' | 'preview' | 'manual' | 'apply';
  command: string;
  mutating: boolean;
  requires_user_confirmation: boolean;
  effects: string[];
}

export interface DoctorRemediationAction {
  id: string;
  check_name: string;
  check_status: 'warn' | 'fail';
  category: DoctorRemediationCategory;
  priority: DoctorRemediationPriority;
  cause_rank: number;
  downstream_of?: string[];
  title: string;
  rationale: string;
  commands: DoctorRemediationCommand[];
  safety: {
    auto_apply_allowed: false;
    reason_codes: string[];
    canonical_write: false;
    external_mutation: boolean;
    filesystem_write: boolean;
  };
  verification: Array<{
    command: string;
    expected: string;
  }>;
}

export interface DoctorRemediationPlan {
  schema_version: 1;
  mode: 'report_only';
  summary: {
    action_count: number;
    highest_priority: DoctorRemediationPriority | 'none';
    auto_apply_supported: false;
  };
  actions: DoctorRemediationAction[];
}

interface ActionTemplate {
  id: string;
  category: DoctorRemediationCategory;
  priority: DoctorRemediationPriority;
  causeRank: number;
  title: string;
  rationale: string;
  commands: DoctorRemediationCommand[];
  reasonCodes: string[];
  externalMutation?: boolean;
  filesystemWrite?: boolean;
  downstreamOf?: string[];
  verification?: Array<{ command: string; expected: string }>;
}

export function buildDoctorRemediationPlan(
  _input: DoctorInputs,
  checks: DoctorCheck[],
): DoctorRemediationPlan {
  const actions = checks
    .filter((check): check is DoctorCheck & { status: 'warn' | 'fail' } => check.status !== 'ok')
    .map((check) => buildRemediationAction(check))
    .filter((action): action is DoctorRemediationAction => action !== null)
    .sort((left, right) => left.cause_rank - right.cause_rank || compareAscii(left.check_name, right.check_name));

  return {
    schema_version: 1,
    mode: 'report_only',
    summary: {
      action_count: actions.length,
      highest_priority: highestPriority(actions),
      auto_apply_supported: false,
    },
    actions,
  };
}

function buildRemediationAction(
  check: DoctorCheck & { status: 'warn' | 'fail' },
): DoctorRemediationAction | null {
  const template = templateForCheck(check.name);
  if (!template) return null;
  return {
    id: template.id,
    check_name: check.name,
    check_status: check.status,
    category: template.category,
    priority: template.priority,
    cause_rank: template.causeRank,
    ...(template.downstreamOf ? { downstream_of: template.downstreamOf } : {}),
    title: template.title,
    rationale: template.rationale,
    commands: template.commands,
    safety: {
      auto_apply_allowed: false,
      reason_codes: ['report_only', 'no_auto_apply', ...template.reasonCodes],
      canonical_write: false,
      external_mutation: template.externalMutation ?? false,
      filesystem_write: template.filesystemWrite ?? false,
    },
    verification: template.verification ?? [verifyDoctorJson()],
  };
}

function templateForCheck(checkName: string): ActionTemplate | null {
  if (checkName.startsWith('agent:')) {
    return {
      id: `doctor.${checkName.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.setup_agent_preview`,
      category: 'agent_setup',
      priority: 'p1',
      causeRank: 40,
      title: 'Preview managed agent setup changes',
      rationale: 'Agent readiness checks should be repaired through setup-agent preview/diff before any explicit apply.',
      commands: [
        command('preview', 'mbrain setup-agent --preview', false, [
          'shows planned prompt, MCP, and hook changes without writing files',
        ]),
        command('inspect', 'mbrain setup-agent --diff', false, [
          'shows redacted managed diff for agent setup files',
        ]),
      ],
      reasonCodes: ['agent_setup_preview_only', 'external_agent_surface'],
      verification: [
        { command: 'mbrain doctor --agent --json', expected: 'agent readiness check is ok or no worse than before' },
      ],
    };
  }

  switch (checkName) {
    case 'connection':
      return {
        id: 'doctor.connection.inspect_runtime',
        category: 'runtime_config',
        priority: 'p0',
        causeRank: 10,
        title: 'Restore database connectivity',
        rationale: 'Most doctor checks depend on a reachable runtime database; fix connectivity before downstream symptoms.',
        commands: [
          command('inspect', 'mbrain doctor --json', false, [
            're-runs health checks after verifying database/runtime availability',
          ]),
        ],
        reasonCodes: ['runtime_unavailable', 'blocks_downstream_checks'],
        externalMutation: true,
        verification: [
          { command: 'mbrain doctor --json', expected: 'connection check reports ok' },
        ],
      };
    case 'runtime_db_identity':
      return {
        id: 'doctor.runtime_db_identity.inspect_config',
        category: 'runtime_config',
        priority: 'p0',
        causeRank: 11,
        title: 'Inspect Postgres runtime identity configuration',
        rationale: 'Runtime identity failures mean CLI, MCP, or automation may not be pointing at a valid target database.',
        commands: [
          command('inspect', 'mbrain config show', false, [
            'prints redacted runtime configuration for manual inspection',
          ]),
        ],
        reasonCodes: ['runtime_identity_invalid'],
        verification: [
          { command: 'mbrain doctor --json', expected: 'runtime_db_identity check reports ok' },
        ],
      };
    case 'schema_version':
      return {
        id: 'doctor.schema_version.manual_migration',
        category: 'database_schema',
        priority: 'p1',
        causeRank: 20,
        title: 'Run the configured schema migration manually',
        rationale: 'Schema migrations are database mutations and must remain explicitly user-triggered.',
        commands: [
          command('manual', 'mbrain init --non-interactive', true, [
            'runs pending migrations against the configured database',
          ]),
        ],
        reasonCodes: ['schema_migration_manual_only'],
        externalMutation: true,
        verification: [
          { command: 'mbrain doctor --json', expected: 'schema_version check reports ok' },
        ],
      };
    case 'pgvector':
      return {
        id: 'doctor.pgvector.manual_database_setup',
        category: 'database_schema',
        priority: 'p1',
        causeRank: 21,
        title: 'Inspect pgvector extension setup',
        rationale: 'pgvector changes are database-level setup and must not be auto-applied by doctor.',
        commands: [
          command('manual', 'enable pgvector in the configured Postgres database', true, [
            'changes database extension state outside canonical memory',
          ]),
        ],
        reasonCodes: ['database_extension_manual_only'],
        externalMutation: true,
        verification: [
          { command: 'mbrain doctor --json', expected: 'pgvector check reports ok' },
        ],
      };
    case 'rls':
      return {
        id: 'doctor.rls.manual_policy_review',
        category: 'database_schema',
        priority: 'p1',
        causeRank: 22,
        title: 'Review row-level security policy state manually',
        rationale: 'RLS policy repair is security-sensitive and must stay outside automatic doctor actions.',
        commands: [
          command('manual', 'review configured Postgres RLS policies', true, [
            'changes database security policy only after explicit user review',
          ]),
        ],
        reasonCodes: ['database_security_manual_only'],
        externalMutation: true,
        verification: [
          { command: 'mbrain doctor --json', expected: 'rls check reports ok' },
        ],
      };
    case 'target_runtime':
      return {
        id: 'doctor.target_runtime.plan_postgres_migration',
        category: 'runtime_config',
        priority: 'p1',
        causeRank: 25,
        title: 'Plan migration to the Postgres target runtime',
        rationale: 'SQLite and PGLite are compatibility profiles; target-runtime capabilities require Postgres.',
        commands: [
          command('inspect', 'mbrain config show', false, [
            'prints redacted current runtime configuration',
          ]),
          command('manual', 'mbrain init --profile homebrew-postgres', true, [
            'initializes the configured Postgres target runtime after user confirmation',
          ]),
        ],
        reasonCodes: ['legacy_runtime_profile'],
        externalMutation: true,
        filesystemWrite: true,
        verification: [
          { command: 'mbrain doctor --json', expected: 'target_runtime check reports ok' },
        ],
      };
    case 'memory_runtime':
      return {
        id: 'doctor.memory_runtime.manual_investigation',
        category: 'memory_governance',
        priority: 'p1',
        causeRank: 30,
        title: 'Investigate memory runtime queue health',
        rationale: 'Dead jobs, stuck locks, prompt-injection flags, and purge candidates require governed review.',
        commands: [
          command('inspect', 'mbrain memory-report --json', false, [
            'summarizes governed memory review pressure without applying changes',
          ]),
        ],
        reasonCodes: ['memory_runtime_manual_only', 'governance_sensitive'],
        verification: [
          { command: 'mbrain doctor --json', expected: 'memory_runtime check reports ok or warn is understood' },
        ],
      };
    case 'autopilot':
      return {
        id: 'doctor.autopilot.inspect_status',
        category: 'process_lifecycle',
        priority: 'p1',
        causeRank: 31,
        title: 'Inspect autopilot lifecycle status',
        rationale: 'Autopilot failures can leave maintenance work stale and should be investigated before restarting automation.',
        commands: [
          command('inspect', 'mbrain autopilot status', false, [
            'shows scheduled maintenance status without changing jobs',
          ]),
        ],
        reasonCodes: ['autopilot_manual_only'],
        verification: [
          { command: 'mbrain doctor --json', expected: 'autopilot check reports ok or no stale cycle' },
        ],
      };
    case 'system_of_record':
      return {
        id: 'doctor.system_of_record.inspect_reconciliation',
        category: 'memory_governance',
        priority: 'p1',
        causeRank: 32,
        title: 'Inspect projection reconciliation state',
        rationale: 'System-of-record repair must preserve canonical source authority and remain manually governed.',
        commands: [
          command('inspect', 'mbrain doctor --json', false, [
            're-reads projection health before choosing a governed repair path',
          ]),
        ],
        reasonCodes: ['system_of_record_manual_only', 'projection_repair_governed'],
        verification: [
          { command: 'mbrain doctor --json', expected: 'system_of_record check reports ok' },
        ],
      };
    case 'embedding_provider':
      return {
        id: 'doctor.embedding_provider.inspect_profile',
        category: 'runtime_config',
        priority: 'p2',
        causeRank: 50,
        title: 'Inspect embedding provider availability',
        rationale: 'Provider availability affects future embedding work but should be fixed through runtime configuration.',
        commands: [
          command('inspect', 'mbrain doctor --json', false, [
            'confirms whether the provider is available after configuration changes',
          ]),
        ],
        reasonCodes: ['provider_configuration_required'],
        verification: [
          { command: 'mbrain doctor --json', expected: 'embedding_provider check reports ok' },
        ],
      };
    case 'query_rewrite_provider':
      return {
        id: 'doctor.query_rewrite_provider.inspect_profile',
        category: 'runtime_config',
        priority: 'p2',
        causeRank: 51,
        title: 'Inspect query rewrite provider availability',
        rationale: 'Rewrite provider availability affects retrieval quality but should be fixed through runtime configuration.',
        commands: [
          command('inspect', 'mbrain doctor --json', false, [
            'confirms whether the provider is available after configuration changes',
          ]),
        ],
        reasonCodes: ['provider_configuration_required'],
        verification: [
          { command: 'mbrain doctor --json', expected: 'query_rewrite_provider check reports ok' },
        ],
      };
    case 'offline_profile':
      return {
        id: 'doctor.offline_profile.inspect_execution_envelope',
        category: 'runtime_config',
        priority: 'p2',
        causeRank: 52,
        title: 'Inspect execution envelope profile',
        rationale: 'Execution-envelope warnings should be reviewed before assuming all optional capabilities are available.',
        commands: [
          command('inspect', 'mbrain doctor --json', false, [
            'prints execution envelope and provider status',
          ]),
        ],
        reasonCodes: ['execution_envelope_review'],
        verification: [
          { command: 'mbrain doctor --json', expected: 'offline_profile warning is understood or resolved' },
        ],
      };
    case 'contract_surface':
      return {
        id: 'doctor.contract_surface.inspect_capabilities',
        category: 'runtime_config',
        priority: 'p2',
        causeRank: 53,
        title: 'Inspect unsupported contract surfaces',
        rationale: 'Unsupported contract surfaces should be reviewed against the active runtime profile.',
        commands: [
          command('inspect', 'mbrain doctor --json', false, [
            'shows contract surface support by runtime profile',
          ]),
        ],
        reasonCodes: ['contract_surface_unsupported'],
        verification: [
          { command: 'mbrain doctor --json', expected: 'contract_surface check reports ok or accepted unsupported surfaces' },
        ],
      };
    case 'unsupported_capabilities':
      return {
        id: 'doctor.unsupported_capabilities.inspect_profile',
        category: 'runtime_config',
        priority: 'p2',
        causeRank: 54,
        downstreamOf: ['contract_surface'],
        title: 'Inspect unsupported runtime capabilities',
        rationale: 'Capability warnings are downstream of the active execution envelope and runtime profile.',
        commands: [
          command('inspect', 'mbrain doctor --json', false, [
            'shows unsupported capability details',
          ]),
        ],
        reasonCodes: ['capability_unsupported'],
        verification: [
          { command: 'mbrain doctor --json', expected: 'unsupported_capabilities check reports ok or accepted profile limits' },
        ],
      };
    case 'embeddings':
      return {
        id: 'doctor.embeddings.embed_stale',
        category: 'embedding',
        priority: 'p1',
        causeRank: 60,
        title: 'Refresh missing or stale embeddings',
        rationale: 'Embedding coverage directly affects retrieval quality and can be repaired without canonical memory writes.',
        commands: [
          command('apply', 'mbrain embed --stale', true, [
            'writes missing or stale embedding vectors for existing pages/chunks',
          ]),
        ],
        reasonCodes: ['embedding_backfill', 'non_canonical_write'],
        verification: [
          { command: 'mbrain doctor --json', expected: 'embeddings check reports ok or improved coverage' },
        ],
      };
    case 'sync_recency':
      return {
        id: 'doctor.sync_recency.run_sync',
        category: 'sync',
        priority: 'p2',
        causeRank: 71,
        title: 'Run a foreground sync',
        rationale: 'A recent explicit sync refreshes durable source state before further diagnosis.',
        commands: [
          command('apply', 'mbrain sync', true, [
            'pulls and imports configured sync sources',
          ]),
        ],
        reasonCodes: ['sync_manual_trigger'],
        externalMutation: true,
        filesystemWrite: true,
        verification: [
          { command: 'mbrain doctor --json', expected: 'sync_recency check reports ok or fresher last run' },
        ],
      };
    case 'sync_watch':
      return {
        id: 'doctor.sync_watch.restart_or_clear',
        category: 'sync',
        priority: 'p1',
        causeRank: 70,
        title: 'Restart or clear the live sync watcher failure',
        rationale: 'The live watcher stopped after repeated failures; restart only after checking the failure reason.',
        commands: [
          command('apply', 'mbrain sync --watch', true, [
            'starts the live sync watcher after user confirmation',
          ]),
          command('apply', 'mbrain sync --clear-failure', true, [
            'clears the recorded watcher failure after user confirmation',
          ]),
        ],
        reasonCodes: ['sync_watch_manual_restart'],
        externalMutation: true,
        filesystemWrite: true,
        verification: [
          { command: 'mbrain doctor --json', expected: 'sync_watch warning is absent after watcher recovery' },
        ],
      };
    case 'memory_inbox_backlog':
      return {
        id: 'doctor.memory_inbox_backlog.review_report',
        category: 'memory_governance',
        priority: 'p2',
        causeRank: 80,
        title: 'Review staged Memory Inbox candidates',
        rationale: 'Backlog pressure should be handled through the daily memory report review surface.',
        commands: [
          command('inspect', 'mbrain memory-report', false, [
            'shows staged candidates and review pressure without promoting them',
          ]),
        ],
        reasonCodes: ['memory_inbox_review_required', 'canonical_write_forbidden'],
        verification: [
          { command: 'mbrain doctor --json', expected: 'memory_inbox_backlog check reports ok or reduced pressure' },
        ],
      };
    case 'serve_processes':
      return {
        id: 'doctor.serve_processes.restart_agent_clients',
        category: 'process_lifecycle',
        priority: 'p2',
        causeRank: 90,
        title: 'Restart agent clients to relaunch stale MCP servers',
        rationale: 'Long-lived serve processes hold old code and config until the owning agent client restarts.',
        commands: [
          command('manual', 'restart agent clients (Claude Code/Codex)', true, [
            'relaunches mbrain serve processes with current code and config',
          ]),
        ],
        reasonCodes: ['process_lifecycle_manual_only'],
        externalMutation: true,
        verification: [
          { command: 'mbrain doctor --json', expected: 'serve_processes check reports ok or no stale process' },
        ],
      };
    default:
      return null;
  }
}

function command(
  kind: DoctorRemediationCommand['kind'],
  commandText: string,
  mutating: boolean,
  effects: string[],
): DoctorRemediationCommand {
  return {
    kind,
    command: commandText,
    mutating,
    requires_user_confirmation: mutating,
    effects,
  };
}

function verifyDoctorJson() {
  return { command: 'mbrain doctor --json', expected: 'the related check reports ok or the warning is explicitly understood' };
}

function highestPriority(actions: DoctorRemediationAction[]): DoctorRemediationPriority | 'none' {
  if (actions.some((action) => action.priority === 'p0')) return 'p0';
  if (actions.some((action) => action.priority === 'p1')) return 'p1';
  if (actions.some((action) => action.priority === 'p2')) return 'p2';
  return 'none';
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
