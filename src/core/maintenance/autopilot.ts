export const AUTOPILOT_MODES = ['launchd', 'systemd', 'cron', 'manual'] as const;

export type AutopilotMode = typeof AUTOPILOT_MODES[number];

export interface AutopilotConfig {
  enabled: boolean;
  mode: AutopilotMode;
  schedule: string;
  allow_llm: boolean;
  allow_local_runner: boolean;
  source_consent_defaults: 'deny_raw_until_granted' | 'allow_registered_sources';
  cycle_timeout_ms: number;
  phase_timeout_ms?: number;
  governed_recompile_enabled?: boolean;
}

export interface AutopilotWarning {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  queue_depth?: number;
}

export function defaultAutopilotConfig(): AutopilotConfig {
  return {
    enabled: false,
    mode: 'manual',
    schedule: '*/15 * * * *',
    allow_llm: false,
    allow_local_runner: false,
    source_consent_defaults: 'deny_raw_until_granted',
    cycle_timeout_ms: 30 * 60 * 1000,
  };
}

export function slotForAutopilotCycle(nowIso: string, slotMinutes = 15): string {
  const date = new Date(nowIso);
  const slotMs = Math.max(1, slotMinutes) * 60 * 1000;
  const rounded = Math.floor(date.getTime() / slotMs) * slotMs;
  return new Date(rounded).toISOString().replace(/:00\.000Z$/, 'Z');
}

export function redactDsn(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^:\s]+):([^@\s]+)@/, '://$1:***@');
  }
}
