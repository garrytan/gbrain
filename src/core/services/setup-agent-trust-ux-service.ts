import { join } from 'path';
import type {
  SetupAgentAction,
  SetupAgentActionStatus,
  SetupAgentDiffEntry,
  SetupAgentEffect,
  SetupAgentTargetKind,
  SetupAgentTrustClient,
  SetupAgentTrustMode,
  SetupAgentTrustUxReport,
} from '../types/setup-agent-trust-ux.ts';

export const SETUP_AGENT_RULES_MARKER_START = '<!-- MBRAIN:RULES:START -->';
export const SETUP_AGENT_RULES_MARKER_END = '<!-- MBRAIN:RULES:END -->';
const MARKER_VERSION_RE = /<!-- mbrain-agent-rules-version: ([\d.]+) -->/;
const CLAUDE_STOP_HOOK_COMMAND = 'bash "$HOME/.claude/scripts/hooks/stop-mbrain-check.sh"';
const CLAUDE_PROMPT_HOOK_COMMAND = 'bash "$HOME/.claude/scripts/hooks/prompt-mbrain-context.sh"';
const CLAUDE_SESSIONSTART_HOOK_COMMAND = 'bash "$HOME/.claude/scripts/hooks/sessionstart-mbrain-activation.sh"';

export interface SetupAgentPlanningClient {
  client: SetupAgentTrustClient;
  config_dir: string;
  target_file: string;
  mcp_registered: boolean;
  prompt_content: string | null;
  mcp_scope?: string;
  claude_stop_hook_content?: string | null;
  claude_prompt_hook_content?: string | null;
  claude_sessionstart_hook_content?: string | null;
  claude_relevance_lib_content?: string | null;
  claude_skip_dirs_content?: string | null;
  claude_settings_content?: string | null;
  claude_legacy_hooks_content?: string | null;
  codex_stop_hook_content?: string | null;
}

export interface SetupAgentPlanningInput {
  mode: Extract<SetupAgentTrustMode, 'preview' | 'diff'>;
  version: string;
  rules_content: string;
  skip_mcp: boolean;
  claude_mcp_scope: 'user' | 'local';
  clients: SetupAgentPlanningClient[];
  compatibility_alias?: boolean;
  expected_claude_stop_hook: string;
  expected_claude_prompt_hook: string;
  expected_claude_sessionstart_hook: string;
  expected_claude_relevance_lib: string;
  expected_claude_skip_dirs: string;
  expected_codex_stop_hook: string;
}

export function planSetupAgentTrustUx(input: SetupAgentPlanningInput): SetupAgentTrustUxReport {
  const clients = input.clients.map((client) => {
    const actions = planClientActions(input, client);
    return {
      client: client.client,
      detected: true,
      ...(client.client === 'claude' ? { mcp_scope: client.mcp_scope ?? input.claude_mcp_scope } : {}),
      actions,
    };
  });
  const actions = clients.flatMap((client) => client.actions);
  const wouldChange = actions.some((action) => actionWouldChange(action.status));

  return {
    status: 'ok',
    version: input.version,
    mode: input.mode,
    mutating: false,
    ...(input.compatibility_alias === undefined ? {} : { compatibility_alias: input.compatibility_alias }),
    changed: false,
    would_change: wouldChange,
    clients,
    ...(input.mode === 'diff' ? { diffs: actions.filter((action) => actionWouldChange(action.status)).map(formatDiff) } : {}),
    warnings: [],
    managed_only: true,
  };
}

export function formatSetupAgentTrustUxReport(report: SetupAgentTrustUxReport): string {
  const lines = [
    `MBrain setup-agent ${report.mode} (zero-write: no changes made)`,
    `would_change=${String(report.would_change ?? false)}`,
  ];

  for (const client of report.clients) {
    lines.push('');
    lines.push(`${client.client}:`);
    for (const action of client.actions) {
      lines.push(`  Would ${action.status} ${action.target_kind} (${action.reason_codes.join(', ')})`);
    }
  }

  if (report.diffs && report.diffs.length > 0) {
    lines.push('');
    lines.push('Diffs:');
    for (const diff of report.diffs) {
      lines.push(diff.unified_diff);
    }
  }

  lines.push('');
  lines.push('No files written. No chmod. No MCP registration commands run. No hook settings edited.');
  lines.push('Run mbrain setup-agent --apply to make these changes.');

  return lines.join('\n') + '\n';
}

export function formatSetupAgentRulesBlock(rulesContent: string): string {
  return `${SETUP_AGENT_RULES_MARKER_START}\n${rulesContent}\n${SETUP_AGENT_RULES_MARKER_END}`;
}

export function extractSetupAgentRulesVersion(content: string): string | null {
  const startIdx = content.indexOf(SETUP_AGENT_RULES_MARKER_START);
  const endIdx = content.indexOf(SETUP_AGENT_RULES_MARKER_END);
  const region = (startIdx !== -1 && endIdx !== -1) ? content.slice(startIdx, endIdx) : content;
  const match = region.match(MARKER_VERSION_RE);
  return match ? match[1] : null;
}

function planClientActions(
  input: SetupAgentPlanningInput,
  client: SetupAgentPlanningClient,
): SetupAgentAction[] {
  const actions: SetupAgentAction[] = [
    buildAction({
      client: client.client,
      target_kind: 'mcp_registration',
      command: mcpRegistrationCommand(client.client, input.claude_mcp_scope),
      status: mcpStatus(client.mcp_registered, input.skip_mcp),
      effects: mcpEffects(client.mcp_registered, input.skip_mcp),
      reason_codes: mcpReasonCodes(client.mcp_registered, input.skip_mcp),
    }),
    buildAction({
      client: client.client,
      target_kind: 'prompt_rules',
      target_path: client.target_file,
      status: promptRulesStatus(client.prompt_content, input.rules_content),
      effects: ['reads_user_config', 'filesystem_write'],
      reason_codes: promptRulesReasonCodes(client.prompt_content, input.rules_content),
    }),
  ];

  if (client.client === 'claude') {
    actions.push(
      buildAction({
        client: client.client,
        target_kind: 'claude_stop_hook',
        target_path: join(client.config_dir, 'scripts', 'hooks', 'stop-mbrain-check.sh'),
        status: claudeStopHookStatus(client, input),
        effects: ['reads_user_config', 'filesystem_write', 'chmod'],
        reason_codes: claudeStopHookReasonCodes(client, input),
      }),
      buildAction({
        client: client.client,
        target_kind: 'claude_prompt_hook',
        target_path: join(client.config_dir, 'scripts', 'hooks', 'prompt-mbrain-context.sh'),
        status: claudePromptHookStatus(client, input),
        effects: ['reads_user_config', 'filesystem_write', 'chmod'],
        reason_codes: claudePromptHookReasonCodes(client, input),
      }),
      buildAction({
        client: client.client,
        target_kind: 'claude_sessionstart_hook',
        target_path: join(client.config_dir, 'scripts', 'hooks', 'sessionstart-mbrain-activation.sh'),
        status: claudeSessionStartHookStatus(client, input),
        effects: ['reads_user_config', 'filesystem_write', 'chmod'],
        reason_codes: claudeSessionStartHookReasonCodes(client, input),
      }),
      buildAction({
        client: client.client,
        target_kind: 'skip_dirs',
        target_path: join(client.config_dir, 'mbrain-skip-dirs'),
        status: skipDirsStatus(client.claude_skip_dirs_content ?? null),
        effects: ['reads_user_config', 'filesystem_write'],
        reason_codes: skipDirsReasonCodes(
          client.claude_skip_dirs_content ?? null,
          input.expected_claude_skip_dirs,
        ),
      }),
      buildAction({
        client: client.client,
        target_kind: 'legacy_hook_cleanup',
        target_path: join(client.config_dir, 'hooks', 'hooks.json'),
        status: legacyCleanupStatus(client.claude_legacy_hooks_content ?? null),
        effects: ['reads_user_config', 'filesystem_write'],
        reason_codes: legacyCleanupReasonCodes(client.claude_legacy_hooks_content ?? null),
      }),
    );
  }

  if (client.client === 'codex') {
    actions.push(
      buildAction({
        client: client.client,
        target_kind: 'codex_stop_hook',
        target_path: join(client.config_dir, 'scripts', 'hooks', 'stop-mbrain-capture.sh'),
        status: codexStopHookStatus(client, input),
        effects: ['reads_user_config', 'filesystem_write', 'chmod'],
        reason_codes: managedFileReasonCodes(client.codex_stop_hook_content ?? null, input.expected_codex_stop_hook, 'codex_stop_hook'),
      }),
    );
  }

  return actions;
}

function buildAction(input: {
  client: SetupAgentTrustClient;
  target_kind: SetupAgentTargetKind;
  status: SetupAgentActionStatus;
  effects: SetupAgentEffect[];
  reason_codes: string[];
  target_path?: string;
  command?: string;
}): SetupAgentAction {
  return {
    id: `${input.client}:${input.target_kind}`,
    client: input.client,
    target_kind: input.target_kind,
    ...(input.target_path ? { target_path: input.target_path } : {}),
    ...(input.command ? { command: input.command } : {}),
    status: input.status,
    mutating: actionWouldChange(input.status),
    reason_codes: input.reason_codes,
    effects: input.effects,
  };
}

function mcpRegistrationCommand(client: SetupAgentTrustClient, claudeScope: 'user' | 'local'): string {
  return client === 'claude'
    ? `claude mcp add -s ${claudeScope} mbrain -- mbrain serve`
    : 'codex mcp add mbrain -- mbrain serve';
}

function mcpStatus(registered: boolean, skipMcp: boolean): SetupAgentActionStatus {
  if (skipMcp) return 'skip';
  return registered ? 'already_current' : 'create';
}

function mcpReasonCodes(registered: boolean, skipMcp: boolean): string[] {
  if (skipMcp) return ['mcp_registration_skipped'];
  return registered ? ['mcp_registration_current'] : ['mcp_registration_missing'];
}

function mcpEffects(registered: boolean, skipMcp: boolean): SetupAgentEffect[] {
  if (skipMcp) return [];
  return registered ? ['runs_external_probe'] : ['runs_external_probe', 'external_mutation'];
}

function promptRulesStatus(content: string | null, rulesContent: string): SetupAgentActionStatus {
  if (content === null) return 'create';
  if (!content.includes(SETUP_AGENT_RULES_MARKER_START)) return 'create';
  const startIdx = content.indexOf(SETUP_AGENT_RULES_MARKER_START);
  const endIdx = content.indexOf(SETUP_AGENT_RULES_MARKER_END);
  if (endIdx === -1 || endIdx < startIdx) return 'update';
  return extractSetupAgentRulesVersion(content) === extractSetupAgentRulesVersion(rulesContent)
    ? 'already_current'
    : 'update';
}

function promptRulesReasonCodes(content: string | null, rulesContent: string): string[] {
  if (content === null) return ['prompt_rules_missing'];
  if (!content.includes(SETUP_AGENT_RULES_MARKER_START)) return ['managed_rules_block_missing'];
  const startIdx = content.indexOf(SETUP_AGENT_RULES_MARKER_START);
  const endIdx = content.indexOf(SETUP_AGENT_RULES_MARKER_END);
  if (endIdx === -1 || endIdx < startIdx) return ['managed_rules_block_malformed'];
  return extractSetupAgentRulesVersion(content) === extractSetupAgentRulesVersion(rulesContent)
    ? ['prompt_rules_current']
    : ['prompt_rules_version_stale'];
}

function claudeStopHookStatus(
  client: SetupAgentPlanningClient,
  input: SetupAgentPlanningInput,
): SetupAgentActionStatus {
  const hook = managedFileStatus(client.claude_stop_hook_content ?? null, input.expected_claude_stop_hook);
  const lib = managedFileStatus(client.claude_relevance_lib_content ?? null, input.expected_claude_relevance_lib);
  const settings = claudeSettingsStatus(client.claude_settings_content ?? null, 'Stop', 'stop:mbrain-check', CLAUDE_STOP_HOOK_COMMAND);
  if (hook === 'create' || lib === 'create' || settings === 'create') return 'create';
  if (hook === 'update' || lib === 'update' || settings === 'update') return 'update';
  return 'already_current';
}

function claudeStopHookReasonCodes(
  client: SetupAgentPlanningClient,
  input: SetupAgentPlanningInput,
): string[] {
  const reasons = [
    ...managedFileReasonCodes(client.claude_stop_hook_content ?? null, input.expected_claude_stop_hook, 'stop_hook'),
    ...managedFileReasonCodes(client.claude_relevance_lib_content ?? null, input.expected_claude_relevance_lib, 'stop_hook_lib'),
    ...claudeSettingsReasonCodes(client.claude_settings_content ?? null, 'Stop', 'stop:mbrain-check', CLAUDE_STOP_HOOK_COMMAND, 'claude_stop_hook'),
  ];
  return [...new Set(reasons)];
}

function claudePromptHookStatus(
  client: SetupAgentPlanningClient,
  input: SetupAgentPlanningInput,
): SetupAgentActionStatus {
  const hook = managedFileStatus(client.claude_prompt_hook_content ?? null, input.expected_claude_prompt_hook);
  const lib = managedFileStatus(client.claude_relevance_lib_content ?? null, input.expected_claude_relevance_lib);
  const settings = claudeSettingsStatus(client.claude_settings_content ?? null, 'UserPromptSubmit', 'prompt:mbrain-context', CLAUDE_PROMPT_HOOK_COMMAND);
  if (hook === 'create' || lib === 'create' || settings === 'create') return 'create';
  if (hook === 'update' || lib === 'update' || settings === 'update') return 'update';
  return 'already_current';
}

function claudePromptHookReasonCodes(
  client: SetupAgentPlanningClient,
  input: SetupAgentPlanningInput,
): string[] {
  const reasons = [
    ...managedFileReasonCodes(client.claude_prompt_hook_content ?? null, input.expected_claude_prompt_hook, 'prompt_hook'),
    ...managedFileReasonCodes(client.claude_relevance_lib_content ?? null, input.expected_claude_relevance_lib, 'prompt_hook_lib'),
    ...claudeSettingsReasonCodes(client.claude_settings_content ?? null, 'UserPromptSubmit', 'prompt:mbrain-context', CLAUDE_PROMPT_HOOK_COMMAND, 'claude_prompt_hook'),
  ];
  return [...new Set(reasons)];
}

function claudeSessionStartHookStatus(
  client: SetupAgentPlanningClient,
  input: SetupAgentPlanningInput,
): SetupAgentActionStatus {
  const hook = managedFileStatus(client.claude_sessionstart_hook_content ?? null, input.expected_claude_sessionstart_hook);
  const lib = managedFileStatus(client.claude_relevance_lib_content ?? null, input.expected_claude_relevance_lib);
  const settings = claudeSettingsStatus(client.claude_settings_content ?? null, 'SessionStart', 'sessionstart:mbrain-activation', CLAUDE_SESSIONSTART_HOOK_COMMAND);
  if (hook === 'create' || lib === 'create' || settings === 'create') return 'create';
  if (hook === 'update' || lib === 'update' || settings === 'update') return 'update';
  return 'already_current';
}

function claudeSessionStartHookReasonCodes(
  client: SetupAgentPlanningClient,
  input: SetupAgentPlanningInput,
): string[] {
  const reasons = [
    ...managedFileReasonCodes(client.claude_sessionstart_hook_content ?? null, input.expected_claude_sessionstart_hook, 'sessionstart_hook'),
    ...managedFileReasonCodes(client.claude_relevance_lib_content ?? null, input.expected_claude_relevance_lib, 'sessionstart_hook_lib'),
    ...claudeSettingsReasonCodes(client.claude_settings_content ?? null, 'SessionStart', 'sessionstart:mbrain-activation', CLAUDE_SESSIONSTART_HOOK_COMMAND, 'claude_sessionstart_hook'),
  ];
  return [...new Set(reasons)];
}

function codexStopHookStatus(
  client: SetupAgentPlanningClient,
  input: SetupAgentPlanningInput,
): SetupAgentActionStatus {
  return managedFileStatus(client.codex_stop_hook_content ?? null, input.expected_codex_stop_hook);
}

function managedFileStatus(content: string | null, expected: string): SetupAgentActionStatus {
  if (content === null) return 'create';
  return content === expected ? 'already_current' : 'update';
}

function managedFileReasonCodes(content: string | null, expected: string, label: string): string[] {
  if (content === null) return [`${label}_missing`];
  return content === expected ? [`${label}_current`] : [`${label}_differs`];
}

function claudeSettingsStatus(
  content: string | null,
  event: string,
  entryId: string,
  command: string,
): SetupAgentActionStatus {
  if (content === null) return 'create';
  const parsed = parseJsonObject(content);
  const hooks = parsed && typeof parsed.hooks === 'object' && parsed.hooks
    ? parsed.hooks as Record<string, unknown>
    : {};
  const entries = Array.isArray(hooks[event]) ? hooks[event] as any[] : [];
  const existing = entries.find((entry) => entry?.id === entryId);
  if (!existing) return 'create';
  return existing.hooks?.[0]?.command === command ? 'already_current' : 'update';
}

function claudeSettingsReasonCodes(
  content: string | null,
  event: string,
  entryId: string,
  command: string,
  label: string,
): string[] {
  if (content === null) return ['claude_settings_missing'];
  const status = claudeSettingsStatus(content, event, entryId, command);
  if (status === 'create') return [`${label}_settings_missing`];
  if (status === 'update') return [`${label}_settings_stale`];
  return [`${label}_settings_current`];
}

function skipDirsStatus(content: string | null): SetupAgentActionStatus {
  // The skip-dirs file is user-editable; apply only creates it when missing.
  return content === null ? 'create' : 'already_current';
}

function skipDirsReasonCodes(content: string | null, expected: string): string[] {
  if (content === null) return ['skip_dirs_missing'];
  return content === expected ? ['skip_dirs_current'] : ['skip_dirs_user_modified_preserved'];
}

function legacyCleanupStatus(content: string | null): SetupAgentActionStatus {
  if (content === null) return 'skip';
  const parsed = parseJsonObject(content);
  const hooks = parsed && typeof parsed.hooks === 'object' && parsed.hooks
    ? parsed.hooks as Record<string, unknown>
    : {};
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop as any[] : [];
  return stop.some((entry) => entry?.id === 'stop:mbrain-check') ? 'remove' : 'skip';
}

function legacyCleanupReasonCodes(content: string | null): string[] {
  return legacyCleanupStatus(content) === 'remove'
    ? ['legacy_stop_hook_entry_present']
    : ['legacy_stop_hook_entry_absent'];
}

function actionWouldChange(status: SetupAgentActionStatus): boolean {
  return status === 'create' || status === 'update' || status === 'remove';
}

function formatDiff(action: SetupAgentAction): SetupAgentDiffEntry {
  const target = action.target_path ?? action.command ?? `${action.client}:${action.target_kind}`;
  return {
    target_kind: action.target_kind,
    ...(action.target_path ? { target_path: action.target_path } : {}),
    ...(action.command ? { command: action.command } : {}),
    redacted: true,
    unified_diff: [
      `--- ${target}`,
      `+++ ${target}`,
      `@@ mbrain managed ${action.target_kind} @@`,
      '- current: redacted',
      `+ planned_status: ${action.status}`,
      `+ reason_codes: ${action.reason_codes.join(',')}`,
    ].join('\n'),
  };
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
