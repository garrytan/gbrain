export const RESTRICTED_RUNNER_KINDS = [
  'claude_code',
  'codex',
  'local_model',
  'remote_model',
  'deterministic_fallback',
] as const;

export type RestrictedRunnerKind = typeof RESTRICTED_RUNNER_KINDS[number];
export type RestrictedRunnerWorkspaceAccess = 'none' | 'read_only';

export interface RestrictedRunnerCandidate {
  kind: RestrictedRunnerKind;
  label: string;
  priority: number;
  available: boolean;
  reason: string;
  command: string | null;
  runner_version: string | null;
  model: string | null;
  provider: string | null;
  workspace_access: RestrictedRunnerWorkspaceAccess;
  can_execute_shell: false;
  can_access_connector_credentials: false;
  llm_or_runner_used: boolean;
}

export interface RestrictedRunnerAvailability {
  priority: RestrictedRunnerKind[];
  candidates: RestrictedRunnerCandidate[];
  selected: RestrictedRunnerCandidate | null;
}

export interface RestrictedRunnerProbe {
  commandExists?: (command: string) => boolean | Promise<boolean>;
  env?: Record<string, string | undefined>;
  runnerVersions?: Partial<Record<RestrictedRunnerKind, string | null>>;
  localModelAvailable?: boolean;
  remoteProviderAvailable?: boolean;
}

export interface DetectRestrictedRunnersOptions {
  priority?: readonly RestrictedRunnerKind[];
  enabled?: Partial<Record<RestrictedRunnerKind, boolean>>;
  probe?: RestrictedRunnerProbe;
}

export const DEFAULT_RESTRICTED_RUNNER_PRIORITY: RestrictedRunnerKind[] = [
  'claude_code',
  'codex',
  'local_model',
  'remote_model',
  'deterministic_fallback',
];

const RUNNER_COMMANDS: Partial<Record<RestrictedRunnerKind, string>> = {
  claude_code: 'claude',
  codex: 'codex',
  local_model: 'ollama',
};

export async function detectRestrictedRunners(
  options: DetectRestrictedRunnersOptions = {},
): Promise<RestrictedRunnerAvailability> {
  const priority = normalizePriority(options.priority);
  const probe = options.probe ?? {};
  const env = probe.env ?? process.env;
  const candidates: RestrictedRunnerCandidate[] = [];

  for (const kind of priority) {
    candidates.push(await buildCandidate(kind, priority.indexOf(kind), probe, env, options.enabled));
  }

  return {
    priority,
    candidates,
    selected: chooseRestrictedRunner(candidates, priority),
  };
}

export function chooseRestrictedRunner(
  candidates: readonly RestrictedRunnerCandidate[],
  priority: readonly RestrictedRunnerKind[] = DEFAULT_RESTRICTED_RUNNER_PRIORITY,
): RestrictedRunnerCandidate | null {
  for (const kind of priority) {
    const candidate = candidates.find((entry) => entry.kind === kind);
    if (candidate?.available) return candidate;
  }
  return null;
}

function normalizePriority(priority: readonly RestrictedRunnerKind[] | undefined): RestrictedRunnerKind[] {
  const seen = new Set<RestrictedRunnerKind>();
  const normalized: RestrictedRunnerKind[] = [];
  for (const kind of priority ?? DEFAULT_RESTRICTED_RUNNER_PRIORITY) {
    if (seen.has(kind)) continue;
    if (!RESTRICTED_RUNNER_KINDS.includes(kind)) continue;
    seen.add(kind);
    normalized.push(kind);
  }
  for (const kind of DEFAULT_RESTRICTED_RUNNER_PRIORITY) {
    if (!seen.has(kind)) normalized.push(kind);
  }
  return normalized;
}

async function buildCandidate(
  kind: RestrictedRunnerKind,
  priority: number,
  probe: RestrictedRunnerProbe,
  env: Record<string, string | undefined>,
  enabled: Partial<Record<RestrictedRunnerKind, boolean>> | undefined,
): Promise<RestrictedRunnerCandidate> {
  if (enabled?.[kind] === false && kind !== 'deterministic_fallback') {
    return baseCandidate(kind, priority, false, 'runner_disabled', probe, env);
  }

  if (kind === 'remote_model') {
    const available = probe.remoteProviderAvailable ?? hasRemoteProviderEnv(env);
    return baseCandidate(kind, priority, available, available ? 'remote_provider_configured' : 'remote_provider_unavailable', probe, env);
  }

  if (kind === 'deterministic_fallback') {
    return baseCandidate(kind, priority, true, 'deterministic_report_only_available', probe, env);
  }

  if (kind === 'local_model' && probe.localModelAvailable === true) {
    return baseCandidate(kind, priority, true, 'local_model_configured', probe, env);
  }

  const command = RUNNER_COMMANDS[kind];
  const safeCommand = command && /^[a-z0-9_-]+$/i.test(command) ? command : null;
  const commandExists = safeCommand && probe.commandExists
    ? await probe.commandExists(safeCommand)
    : false;
  return baseCandidate(
    kind,
    priority,
    Boolean(commandExists),
    commandExists ? 'local_runner_available' : 'local_runner_unavailable',
    probe,
    env,
  );
}

function baseCandidate(
  kind: RestrictedRunnerKind,
  priority: number,
  available: boolean,
  reason: string,
  probe: RestrictedRunnerProbe,
  env: Record<string, string | undefined>,
): RestrictedRunnerCandidate {
  return {
    kind,
    label: runnerLabel(kind),
    priority,
    available,
    reason,
    command: RUNNER_COMMANDS[kind] ?? null,
    runner_version: probe.runnerVersions?.[kind] ?? null,
    model: modelForKind(kind, env),
    provider: providerForKind(kind, env),
    workspace_access: kind === 'deterministic_fallback' || kind === 'remote_model' || kind === 'local_model'
      ? 'none'
      : 'read_only',
    can_execute_shell: false,
    can_access_connector_credentials: false,
    llm_or_runner_used: kind !== 'deterministic_fallback',
  };
}

function hasRemoteProviderEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.GEMINI_API_KEY || env.MBRAIN_RUNNER_PROVIDER);
}

function providerForKind(kind: RestrictedRunnerKind, env: Record<string, string | undefined>): string | null {
  if (kind === 'remote_model') {
    if (env.MBRAIN_RUNNER_PROVIDER) return env.MBRAIN_RUNNER_PROVIDER;
    if (env.OPENAI_API_KEY) return 'openai';
    if (env.ANTHROPIC_API_KEY) return 'anthropic';
    if (env.GEMINI_API_KEY) return 'gemini';
  }
  if (kind === 'local_model') return env.MBRAIN_LOCAL_MODEL_PROVIDER ?? 'ollama';
  return null;
}

function modelForKind(kind: RestrictedRunnerKind, env: Record<string, string | undefined>): string | null {
  if (kind === 'local_model') return env.MBRAIN_LOCAL_MODEL ?? null;
  if (kind === 'remote_model') return env.MBRAIN_RUNNER_MODEL ?? null;
  return null;
}

function runnerLabel(kind: RestrictedRunnerKind): string {
  switch (kind) {
    case 'claude_code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'local_model':
      return 'Local model';
    case 'remote_model':
      return 'Remote model provider';
    case 'deterministic_fallback':
      return 'Deterministic report-only fallback';
  }
}
