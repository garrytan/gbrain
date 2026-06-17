/**
 * Shared types for the migration registry + orchestrators.
 *
 * Each migration is a module that exports a `Migration` object; the registry
 * at `./index.ts` lists them in version order. Compiled binaries ship the
 * registry directly — no filesystem walk of `skills/migrations/*.md` is
 * needed at runtime.
 */

export interface FeaturePitch {
  /** One-line headline printed post-upgrade. */
  headline: string;
  /** Optional multi-line description. */
  description?: string;
  /** Optional integration recipe name printed as a follow-up. */
  recipe?: string;
}

/**
 * Options passed to every orchestrator. The orchestrator must be idempotent:
 * re-running after a partial run must complete missed phases without
 * duplicating side-effects.
 */
export interface OrchestratorOpts {
  /** Non-interactive: skip prompts, use defaults with explicit print. */
  yes: boolean;
  /** Explicit minion_mode override (bypasses the Phase C prompt). */
  mode?: 'always' | 'pain_triggered' | 'off';
  /** Dry-run: print intended actions, take no side effects. */
  dryRun: boolean;
  /** Include $PWD in host-file walk (default: $HOME/.claude + $HOME/.openclaw). */
  hostDir?: string;
  /** Skip autopilot install (Phase F). */
  noAutopilotInstall: boolean;
}

export interface OrchestratorPhaseResult {
  name: string;
  status: 'complete' | 'skipped' | 'failed';
  detail?: string;
}

export interface OrchestratorResult {
  version: string;
  status: 'complete' | 'partial' | 'failed';
  phases: OrchestratorPhaseResult[];
  files_rewritten?: number;
  autopilot_installed?: boolean;
  install_target?: string;
  pending_host_work?: number;
}

export interface Migration {
  /** Semver string, e.g. "0.11.0". */
  version: string;
  /** Agent-readable feature pitch printed by runPostUpgrade. */
  featurePitch: FeaturePitch;
  /** Run the migration. Must be idempotent. */
  orchestrator: (opts: OrchestratorOpts) => Promise<OrchestratorResult>;
}
