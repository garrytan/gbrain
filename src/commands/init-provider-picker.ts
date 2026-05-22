/**
 * v0.37.x — interactive provider picker for `gbrain init`.
 *
 * Mirrors the `init-mode-picker.ts` (v0.32.3) pattern. Runs from
 * `initPGLite()` BEFORE `engine.initSchema()` when env detection finds
 * zero or multiple env-ready providers for the embedding touchpoint
 * (D1=hybrid). Reuses `formatRecipeTable()` from `providers.ts` so the
 * picker's UI and `gbrain providers list` can't drift.
 *
 * Trust contract:
 *  - TTY-only. Callers must not invoke this in non-TTY contexts; D3 says
 *    non-TTY with zero keys exits 1 from `resolveAIOptions` before we
 *    reach here. A defensive guard returns null if no TTY anyway.
 *  - Filters candidates to env-ready recipes (codex finding #3). The
 *    picker is for choosing among providers the user CAN run, not for
 *    walking them through key setup.
 *  - On Ctrl-D / EOF / timeout: returns null, caller treats as exit 1.
 *  - When the user picks a non-Anthropic chat-capable recipe AND
 *    `ANTHROPIC_API_KEY` is missing, prints the subagent caveat from D7
 *    BEFORE returning the choice so the user sees the implication.
 */

import { listRecipes } from '../core/ai/recipes/index.ts';
import { envReady, formatRecipeTable } from './providers.ts';
import { readLineSafe } from './init.ts';
import type { Recipe } from '../core/ai/types.ts';

export interface PickedProvider {
  recipeId: string;
  modelId: string;
  /** Full `provider:model` string, ready for configureGateway. */
  fullModel: string;
  /** Resolved dim (recipe's `default_dims`). */
  dim: number;
  /** Whether the recipe also covers chat/expansion (informational). */
  hasChat: boolean;
  hasExpansion: boolean;
}

export interface PickProviderOpts {
  /** Touchpoint the picker is selecting for. Embedding is the primary use case. */
  touchpoint: 'embedding' | 'expansion' | 'chat';
  /** Process env to probe. Defaults to process.env (injected for tests). */
  env?: NodeJS.ProcessEnv;
  /** TTY override for tests. Defaults to process.stdin.isTTY. */
  isTTY?: boolean;
  /** Stderr override for tests (capturing prompts). Defaults to process.stderr.write. */
  writeStderr?: (s: string) => void;
}

/**
 * Surface the subagent-Anthropic caveat (D7) when the user picks a
 * non-Anthropic chat-capable recipe without `ANTHROPIC_API_KEY` set.
 *
 * Exported so `initPGLite` can reuse the same message in its post-init
 * stderr summary path (auto-pick branch doesn't run the picker but still
 * needs to surface the caveat). One source of truth keeps the message
 * format aligned across the three D7 surfaces (picker / init summary /
 * doctor).
 */
export function printSubagentAnthropicCaveat(write: (s: string) => void): void {
  write(
    '\n' +
    'Note: subagent features (gbrain dream, gbrain agent run, gbrain autopilot)\n' +
    '      require ANTHROPIC_API_KEY regardless of which chat model you pick.\n' +
    '      Chat alone (gbrain think, gbrain query expansion) works without it.\n' +
    '      Set ANTHROPIC_API_KEY before running those commands.\n\n',
  );
}

/**
 * Filter recipes to those env-ready for the given touchpoint. Returns the
 * filtered list and whether the touchpoint exists on each. Picker UI uses
 * this to refuse picking a recipe whose env isn't ready (codex finding #3).
 */
function readyRecipesForTouchpoint(
  recipes: Recipe[],
  touchpoint: 'embedding' | 'expansion' | 'chat',
  env: NodeJS.ProcessEnv,
): Recipe[] {
  return recipes.filter(r => {
    const tp = r.touchpoints[touchpoint];
    if (!tp) return false;
    // Embedding + chat must have at least one model; expansion just needs to exist.
    if (touchpoint === 'embedding' || touchpoint === 'chat') {
      if (!Array.isArray(tp.models) || tp.models.length === 0) return false;
    }
    return envReady(r, env);
  });
}

/**
 * Pick a provider interactively from env-ready recipes.
 *
 * Returns null when the picker can't proceed (no TTY, no ready recipes,
 * user aborted via Ctrl-D, or readLineSafe timeout). Caller exits 1 on
 * null and prints the no-key fail-loud message itself.
 */
export async function pickProvider(opts: PickProviderOpts): Promise<PickedProvider | null> {
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? process.stdin.isTTY ?? false;
  const writeStderr = opts.writeStderr ?? ((s: string) => process.stderr.write(s));

  if (!isTTY) {
    // Defensive — caller should have handled non-TTY before reaching us.
    return null;
  }

  const all = listRecipes();
  const ready = readyRecipesForTouchpoint(all, opts.touchpoint, env);

  if (ready.length === 0) {
    writeStderr(`\nNo ${opts.touchpoint}-capable providers are env-ready.\n`);
    writeStderr('Set one of the env vars below and re-run init:\n\n');
    writeStderr(formatRecipeTable(all, env) + '\n\n');
    return null;
  }

  writeStderr(`\nPick a ${opts.touchpoint} provider (env-ready providers shown):\n\n`);
  writeStderr(formatRecipeTable(ready, env) + '\n\n');

  // Build numbered options
  const lines = ready.map((r, i) => {
    const tp = r.touchpoints[opts.touchpoint];
    let label = `  ${i + 1}) ${r.id}`;
    if (opts.touchpoint === 'embedding' && tp && 'default_dims' in tp) {
      label += `  (${tp.default_dims}d)`;
    }
    if (tp && 'models' in tp && Array.isArray(tp.models) && tp.models.length > 0) {
      label += `  ${tp.models[0]}`;
    }
    return label;
  });
  writeStderr(lines.join('\n') + '\n\n');

  const answer = await readLineSafe(
    `Choice [1-${ready.length}, default 1]: `,
    '1',
    /* timeoutMs */ 60_000,
  );

  const choice = parseInt(answer.trim(), 10);
  if (!Number.isFinite(choice) || choice < 1 || choice > ready.length) {
    writeStderr(`\nInvalid choice "${answer}". Aborting.\n`);
    return null;
  }

  const picked = ready[choice - 1];
  const tp = picked.touchpoints[opts.touchpoint];
  if (!tp) return null;

  // Pick first model in the recipe's list (callers can override via flag).
  const modelId = ('models' in tp && Array.isArray(tp.models) && tp.models.length > 0)
    ? tp.models[0]
    : '';
  if (!modelId) {
    writeStderr(`\nRecipe "${picked.id}" declares no models for ${opts.touchpoint}. Aborting.\n`);
    return null;
  }

  // D7: surface the subagent-Anthropic caveat when picking a non-Anthropic
  // chat-capable recipe without ANTHROPIC_API_KEY set.
  const isChatTouchpoint = opts.touchpoint === 'chat';
  const isAnthropic = picked.id === 'anthropic';
  const anthropicKeySet = !!env.ANTHROPIC_API_KEY;
  if (isChatTouchpoint && !isAnthropic && !anthropicKeySet) {
    printSubagentAnthropicCaveat(writeStderr);
  }

  const dim =
    opts.touchpoint === 'embedding' && 'default_dims' in tp
      ? (tp as { default_dims: number }).default_dims
      : 0;

  return {
    recipeId: picked.id,
    modelId,
    fullModel: `${picked.id}:${modelId}`,
    dim,
    hasChat: !!picked.touchpoints.chat && (picked.touchpoints.chat.models?.length ?? 0) > 0,
    hasExpansion: !!picked.touchpoints.expansion,
  };
}
