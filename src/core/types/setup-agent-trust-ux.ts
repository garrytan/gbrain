export type SetupAgentTrustMode = 'preview' | 'diff' | 'apply' | 'uninstall';

export type SetupAgentTrustClient = 'claude' | 'codex';

export type SetupAgentActionStatus =
  | 'create'
  | 'update'
  | 'remove'
  | 'skip'
  | 'already_current'
  | 'unsupported';

export type SetupAgentTargetKind =
  | 'mcp_registration'
  | 'prompt_rules'
  | 'claude_stop_hook'
  | 'claude_prompt_hook'
  | 'claude_sessionstart_hook'
  | 'skip_dirs'
  | 'legacy_hook_cleanup';

export type SetupAgentEffect =
  | 'reads_user_config'
  | 'runs_external_probe'
  | 'filesystem_write'
  | 'chmod'
  | 'external_mutation'
  | 'canonical_write';

export interface SetupAgentAction {
  id: string;
  client: SetupAgentTrustClient;
  target_kind: SetupAgentTargetKind;
  target_path?: string;
  command?: string;
  status: SetupAgentActionStatus;
  mutating: boolean;
  reason_codes: string[];
  effects: SetupAgentEffect[];
}

export interface SetupAgentTrustClientReport {
  client: SetupAgentTrustClient;
  detected: boolean;
  mcp?: string;
  rules?: string;
  mcp_scope?: string;
  actions: SetupAgentAction[];
}

export interface SetupAgentDiffEntry {
  target_kind: SetupAgentTargetKind;
  target_path?: string;
  command?: string;
  unified_diff: string;
  redacted: boolean;
}

export interface SetupAgentTrustUxReport {
  status: 'ok' | 'warn' | 'fail';
  version: string;
  mode: SetupAgentTrustMode;
  mutating: boolean;
  compatibility_alias?: boolean;
  changed: boolean;
  would_change?: boolean;
  clients: SetupAgentTrustClientReport[];
  diffs?: SetupAgentDiffEntry[];
  warnings: string[];
  managed_only: boolean;
}
