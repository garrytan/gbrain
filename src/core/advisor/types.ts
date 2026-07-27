/**
 * advisor/types.ts — shared types for `gbrain advisor`.
 *
 * The advisor is a read-only, brain-state-aware recommender: it computes a
 * ranked list of high-leverage actions for THIS brain right now, each with a
 * severity, a one-line why-it-matters, and the exact fix command. It never
 * mutates (the CLI `--apply` path runs a fix only behind an explicit, local-only
 * confirm; see commands/advisor.ts). Same print-never-execute discipline as
 * post-install-advisory.ts.
 */

import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';

export type AdvisorSeverity = 'critical' | 'warn' | 'info';

/** A fix the advisor recommends. */
export interface AdvisorFix {
  /**
   * The fix as a structured argv (e.g. ['gbrain','apply-migrations','--yes']).
   * Never a shell string — `--apply` executes via an allowlisted dispatcher, not
   * a shell, so source-derived names can't inject (#10/C5). Null when there is
   * no single mechanical fix.
   */
  command_argv: string[] | null;
  /**
   * Allowlisted dispatch key for `gbrain advisor --apply <id>`. Present only on
   * findings whose fix is safe to run via the local-only dispatcher.
   */
  dispatch_id?: string;
}

export interface AdvisorFinding {
  /** Stable id (e.g. 'version_drift', 'pending_migration'). */
  id: string;
  severity: AdvisorSeverity;
  /** One-line why-it-matters. */
  title: string;
  /** Optional extra context. */
  detail?: string;
  fix: AdvisorFix;
  /** Which collector emitted it. */
  collector: string;
  /** Print-never-execute: the harness asks the user before acting. */
  ask_user: boolean;
  /**
   * A1: true when the finding depends on the agent's local WORKSPACE (installed
   * skills) rather than brain state. These no-op over MCP (no workspace on the
   * server side) — runAdvisor drops them when ctx.remote !== false.
   */
  workspace_dependent?: boolean;
}

export interface AdvisorContext {
  engine: BrainEngine;
  config: GBrainConfig;
  /** Serving gbrain version (src/version.ts VERSION). */
  version: string;
  /** Agent workspace root (CLI only; null over MCP). */
  workspace: string | null;
  /** Resolved skills dir (CLI only; null over MCP). */
  skillsDir: string | null;
  now: Date;
  /** True when invoked over MCP (untrusted/no-workspace); false for local CLI. */
  remote: boolean;
}

export interface AdvisorCollector {
  id: string;
  collect: (ctx: AdvisorContext) => Promise<AdvisorFinding[]>;
}

export interface AdvisorReport {
  version: string;
  generated_at: string;
  findings: AdvisorFinding[];
  /** Highest severity present, for exit-code mapping (E2). */
  worst: AdvisorSeverity | null;
}
