/**
 * v0.36.0.0 — `gbrain ze-switch` CLI lever for the ZeroEntropy default switch.
 *
 * Subcommands / flags:
 *   gbrain ze-switch                        Run the interactive prompt
 *   gbrain ze-switch --dry-run              Plan only; change nothing
 *   gbrain ze-switch --json                 Machine-readable envelope
 *   gbrain ze-switch --non-interactive      Switch without prompting
 *                                           (errors if ZEROENTROPY_API_KEY missing
 *                                            unless --ignore-missing-key is also set)
 *   gbrain ze-switch --resume               Finish a half-applied switch (recovery)
 *   gbrain ze-switch --force                Bypass the `prompt_shown` gate
 *                                           (use after `n` / never-ask-again)
 *   gbrain ze-switch --undo                 Reverse: restore prior model + dim
 *                                           + reranker state. Cost-warning prompt
 *                                           appears before any change.
 *   gbrain ze-switch --undo --non-interactive --confirm-reembed
 *                                           Scripted undo path (also pays for re-embed)
 */

import type { BrainEngine } from '../core/engine.ts';
import {
  planRetrievalUpgrade,
  applyRetrievalUpgrade,
  resumeRetrievalUpgrade,
  undoRetrievalUpgrade,
} from '../core/retrieval-upgrade-planner.ts';
import {
  runRetrievalUpgradePrompt,
  runUndoPrompt,
} from '../core/retrieval-upgrade-prompt.ts';

interface Flags {
  dryRun: boolean;
  json: boolean;
  nonInteractive: boolean;
  resume: boolean;
  force: boolean;
  undo: boolean;
  confirmReembed: boolean;
  ignoreMissingKey: boolean;
}

function parseFlags(args: string[]): Flags {
  return {
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
    nonInteractive: args.includes('--non-interactive') || args.includes('--yes'),
    resume: args.includes('--resume'),
    force: args.includes('--force'),
    undo: args.includes('--undo'),
    confirmReembed: args.includes('--confirm-reembed'),
    ignoreMissingKey: args.includes('--ignore-missing-key'),
  };
}

function printHelp() {
  process.stdout.write(`Usage: gbrain ze-switch [flags]

Switch the brain's embedding + reranker defaults to ZeroEntropy.

Flags:
  --dry-run              Plan only; change nothing.
  --json                 Machine-readable output.
  --non-interactive      Skip prompts; apply directly (CI / scripts).
  --resume               Finish a half-applied switch (crash recovery).
  --force                Bypass the prompt_shown gate (use after --undo or "never ask").
  --undo                 Reverse the switch: restore prior model + dim + reranker.
  --confirm-reembed      Required with --undo --non-interactive (re-embed pays cost).
  --ignore-missing-key   Allow --non-interactive without ZEROENTROPY_API_KEY set.
  --help                 Show this help.
`);
}

export async function runZeSwitch(args: string[], engine: BrainEngine): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const flags = parseFlags(args);

  try {
    // --dry-run: just plan, never apply.
    if (flags.dryRun) {
      const plan = await planRetrievalUpgrade(engine);
      if (flags.json) {
        console.log(JSON.stringify({ status: 'planned', plan }, null, 2));
      } else {
        console.log(`Current model: ${plan.current_embedding_model} (${plan.current_dim}d)`);
        console.log(`Target model:  ${plan.target_embedding_model ?? '(no change)'}`);
        console.log(`Target dim:    ${plan.target_dim ?? '(no change)'}`);
        console.log(`Pages pending: chunker=${plan.pages_pending_chunker}, dim=${plan.pages_pending_dim}`);
        console.log(`Est cost:      $${plan.est_cost_usd.toFixed(2)}`);
        console.log(`Est minutes:   ${plan.est_minutes}`);
        console.log(`Schema change: ~${plan.est_schema_change_seconds}s`);
        console.log(`Offered:       ${plan.ze_switch_offered}`);
      }
      return;
    }

    // --resume: complete a half-applied switch.
    if (flags.resume) {
      const result = await resumeRetrievalUpgrade(engine);
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Resume status: ${result.status}`);
      }
      process.exit(result.status === 'applied' || result.status === 'skipped_already_applied' ? 0 : 1);
    }

    // --undo: reverse switch.
    if (flags.undo) {
      if (flags.nonInteractive) {
        if (!flags.confirmReembed) {
          console.error('--undo --non-interactive requires --confirm-reembed (undo re-embeds at the prior width — costs real money).');
          process.exit(1);
        }
        const result = await undoRetrievalUpgrade(engine);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Undo status: ${result.status}`);
        }
        process.exit(result.status === 'undone' ? 0 : 1);
      }
      // Interactive undo: shows cost-warning prompt.
      const result = await runUndoPrompt(engine);
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      }
      process.exit(result.status === 'undone' ? 0 : 1);
    }

    // --non-interactive: apply without prompting.
    if (flags.nonInteractive) {
      if (!process.env.ZEROENTROPY_API_KEY && !flags.ignoreMissingKey) {
        const config = await engine.getConfig('zeroentropy_api_key');
        if (!config) {
          console.error('ZEROENTROPY_API_KEY not set. Pass --ignore-missing-key to switch anyway (embeddings will fail until you set a key).');
          process.exit(1);
        }
      }
      const plan = await planRetrievalUpgrade(engine);
      const result = await applyRetrievalUpgrade(engine, plan);
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Switch status: ${result.status}`);
      }
      process.exit(
        result.status === 'applied' || result.status === 'skipped_already_applied' || result.status === 'skipped_no_work'
          ? 0
          : 1,
      );
    }

    // Interactive mode.
    const result = await runRetrievalUpgradePrompt(engine, { force: flags.force });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    process.exit(result.status === 'applied' || result.status === 'declined_this_run' || result.status === 'declined_forever' || result.status === 'non_tty_skip' || result.status === 'not_offered' ? 0 : 1);
  } finally {
    // Engine lifecycle is owned by the dispatcher.
  }
}
