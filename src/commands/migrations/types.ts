/**
 * Shared types for the migration registry + orchestrators.
 *
 * Each migration is a module that exports a `Migration` object; the registry
 * at `./index.ts` lists them in version order. Compiled binaries ship the
 * registry directly — no filesystem walk of `skills/migrations/*.md` is
 * needed at runtime.
 */

import type { Effect } from '../../core/agent-output.ts';

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
  dbOnlyExport?: {
    root: string;
    sourceId: string;
    confirmQuiesced: boolean;
    backup?: 'operator_verified' | 'acknowledged_unprotected';
    /** The runner's own orchestration lease, which the quiescence check ignores. */
    ownLeaseToken?: string;
  };
}

export interface OrchestratorPhaseResult {
  name: string;
  status: 'complete' | 'skipped' | 'failed';
  detail?: string;
  /** The exact command that resolves or inspects what this phase left open; printed by the runner and kept in the ledger. */
  argv?: string[];
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
  preview?: (opts: OrchestratorOpts) => Promise<unknown>;
  reconcile?: boolean;
  /**
   * Consent effects the orchestrator performs (agent operator contract A4);
   * apply-migrations asks for them before running it. `persistent_install`
   * is skipped (and not asked) under --no-autopilot-install or on PGLite.
   */
  effects?: readonly Effect[];
  /**
   * True only when the orchestrator changes nothing on a brain `gbrain init`
   * just created: schema already current, no data to backfill, no files,
   * preferences or services to write. Init records these as complete
   * (`fresh_install: true` ledger entries, `./fresh-install.ts`); every other
   * migration lists as `pending_fresh_install` until it runs. Each flagged
   * migration is proven by test/migrations-fresh-install-audit.serial.test.ts.
   */
  fresh_install_noop?: true;
}
