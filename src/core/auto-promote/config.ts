import type { RestrictedRunnerKind } from '../runners/runner-registry.ts';

export type AutoPromoteSensitivity = 'public' | 'work' | 'personal';
export type AutoPromoteEvidenceKind = 'direct_user_statement' | 'source_extracted';

export interface AutoPromoteConfig {
  enabled: boolean;
  runner_priority: RestrictedRunnerKind[];
  first_pass_model: string | null;
  escalation_model: string | null;
  confidence_threshold: number;
  eligibility: {
    evidence_kinds: AutoPromoteEvidenceKind[];
    sensitivities: AutoPromoteSensitivity[];
    allow_contradictions: boolean;
    require_verification: boolean;
  };
  escalation: { enabled: boolean; max_per_cycle: number };
  dry_run: boolean;
}

const ALLOWED_SENSITIVITIES: ReadonlySet<string> = new Set(['public', 'work', 'personal']);
const ALLOWED_EVIDENCE: ReadonlySet<string> = new Set(['direct_user_statement', 'source_extracted']);
const ALLOWED_RUNNERS: ReadonlySet<string> = new Set(['claude_code', 'codex', 'local_model', 'remote_model', 'deterministic_fallback']);

export function defaultAutoPromoteConfig(): AutoPromoteConfig {
  return {
    enabled: false,
    runner_priority: ['claude_code', 'codex', 'local_model', 'deterministic_fallback'],
    first_pass_model: null,
    escalation_model: null,
    confidence_threshold: 0.8,
    eligibility: {
      evidence_kinds: ['direct_user_statement', 'source_extracted'],
      sensitivities: ['public', 'work'],
      allow_contradictions: false,
      require_verification: false,
    },
    escalation: { enabled: true, max_per_cycle: 20 },
    dry_run: false,
  };
}

export function normalizeAutoPromoteConfig(input: Partial<AutoPromoteConfig> | null | undefined): AutoPromoteConfig {
  const d = defaultAutoPromoteConfig();
  const i = input ?? {};
  const elig = i.eligibility ?? {};
  return {
    enabled: i.enabled ?? d.enabled,
    runner_priority: Array.isArray(i.runner_priority) && i.runner_priority.length
      ? (i.runner_priority.filter((r) => ALLOWED_RUNNERS.has(r)) as RestrictedRunnerKind[])
      : d.runner_priority,
    first_pass_model: typeof i.first_pass_model === 'string' ? i.first_pass_model : d.first_pass_model,
    escalation_model: typeof i.escalation_model === 'string' ? i.escalation_model : d.escalation_model,
    confidence_threshold: clamp01(i.confidence_threshold ?? d.confidence_threshold),
    eligibility: {
      evidence_kinds: filterEnum((elig as AutoPromoteConfig['eligibility']).evidence_kinds, ALLOWED_EVIDENCE, d.eligibility.evidence_kinds) as AutoPromoteEvidenceKind[],
      sensitivities: filterEnum((elig as AutoPromoteConfig['eligibility']).sensitivities, ALLOWED_SENSITIVITIES, d.eligibility.sensitivities) as AutoPromoteSensitivity[],
      allow_contradictions: (elig as AutoPromoteConfig['eligibility']).allow_contradictions ?? d.eligibility.allow_contradictions,
      require_verification: (elig as AutoPromoteConfig['eligibility']).require_verification ?? d.eligibility.require_verification,
    },
    escalation: {
      enabled: i.escalation?.enabled ?? d.escalation.enabled,
      max_per_cycle: Math.max(0, Math.floor(i.escalation?.max_per_cycle ?? d.escalation.max_per_cycle)),
    },
    dry_run: i.dry_run ?? d.dry_run,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function filterEnum(value: unknown, allowed: ReadonlySet<string>, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const kept = value.filter((v): v is string => typeof v === 'string' && allowed.has(v));
  return kept.length ? kept : [...fallback];
}
