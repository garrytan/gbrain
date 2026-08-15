// src/core/onboard/types.ts
// v0.41.18.0 (T12). Onboard-surface-specific types layered on top of the
// shared remediation library (src/core/remediation/). Onboard reframes
// the same RemediationStep objects as "onboarding opportunities" with
// extra prompt-text + apply-policy metadata.

import type { RemediationStep } from '../remediation-step.ts';

/**
 * One onboard recommendation. Layered on RemediationStep with extras
 * specific to the onboarding UX:
 *   - apply_policy controls autopilot behavior (A8 tiered)
 *   - prompt_text is the human-readable nudge ("Embed 3K stale chunks?")
 *   - migration_id is a stable identifier for cross-version tracking
 */
export interface OnboardRecommendation extends RemediationStep {
  /**
   * A8 tiered apply policy:
   *   'auto_apply'      — autopilot may run unattended; runs under --auto
   *   'prompt_required' — autopilot must skip; runs under --auto --yes
   *   'manual_only'     — never runs unattended; CLI prompts user
   * Default 'prompt_required' when omitted.
   */
  apply_policy?: 'auto_apply' | 'prompt_required' | 'manual_only';
  /** Human-readable nudge text. Default falls back to RemediationStep.rationale. */
  prompt_text?: string;
  /**
   * Stable id for cross-version tracking. Defaults to RemediationStep.id.
   * Used by onboard --history to group runs of the same migration over time.
   */
  migration_id?: string;
}

/** Stable JSON envelope for `gbrain onboard --json`. */
export interface OnboardReport {
  schema_version: 1;
  /** brain_id from engine.getHealth(). Identifies the brain across runs. */
  brain_id?: string;
  recommendations: OnboardRecommendation[];
  summary: {
    total: number;
    auto_eligible: number;
    prompt_required: number;
    manual_only: number;
    /** Estimated total dollar cost if every recommendation runs. */
    est_total_usd: number;
  };
  /** Reverse-chronological migration_impact_log entries. */
  history?: Array<{
    remediation_id: string;
    metric_name: string;
    metric_before: number | null;
    metric_after: number | null;
    delta: number | null;
    applied_at: string;
  }>;
}

export interface OnboardOpts {
  /** Target brain_score (default 90). Forwarded to computeRemediationPlan. */
  targetScore?: number;
  /** Output mode. */
  mode?: 'check' | 'auto' | 'history';
  /** Cap on autopilot spend. Required for --auto runs (CLI enforces). */
  maxUsd?: number;
  /** Caller-supplied OAuth client_id (MCP path); threads via job.data. */
  clientId?: string;
}
