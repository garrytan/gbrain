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
 *  - TTY-only. Callers must not invoke this in non-TTY contexts (non-TTY
 *    zero-key resolves keyless in `resolveEmbeddingByEnv` before reaching
 *    here). A defensive guard returns null if no TTY anyway.
 *  - Filters candidates to env-ready recipes (codex finding #3), and
 *    probe-gates LOCAL daemons (ollama): daemon-up ≠ model-pulled, so an
 *    unreachable daemon is dropped and a missing model is annotated with
 *    its `ollama pull` fix inline.
 *  - Embedding pickers always offer `0) none — continue keyless`. When no
 *    KEYED provider is ready, keyless is the DEFAULT (bare Enter / 60s
 *    timeout / EOF all resolve to 0 → null), so a local daemon is never
 *    auto-selected. When a keyed provider IS ready the default is `1`, so an
 *    unattended timeout picks that first keyed provider — NOT null; explicit
 *    `0` is still keyless.
 *  - Returns null on the keyless choice (and on invalid input); the embedding
 *    caller continues keyless with a loud notice on BOTH the zero-key and the
 *    multi-key paths (other touchpoints treat null as no-pick).
 *  - When the user picks a non-Anthropic chat-capable recipe AND
 *    `ANTHROPIC_API_KEY` is missing, prints the subagent caveat from D7
 *    BEFORE returning the choice so the user sees the implication.
 */

import { listRecipes } from '../core/ai/recipes/index.ts';
import { envReady, formatRecipeTable } from './providers.ts';
import { readLineSafe } from './init.ts';
import { probeOllama, type ProbeResult } from '../core/ai/probes.ts';
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
  /** Local-daemon probe seam (injected for tests; defaults to probeOllama).
   *  Keeps the unit suite off the network — and off any REAL ollama that
   *  happens to be running on the test machine. */
  probeLocal?: () => Promise<ProbeResult>;
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
  let ready = readyRecipesForTouchpoint(all, opts.touchpoint, env);

  // v0.46.3: never OFFER a provider whose hosted API has an announced shutdown
  // (recipe.sunset) — a fresh install must not be steered onto a dying
  // provider. Explicit --embedding-model still works (with a loud warning)
  // until the removal release.
  ready = ready.filter((r) => !r.sunset);

  // Probe-gate the ollama daemon: `envReady` treats no-key-required as
  // ready, but daemon-up ≠ model-pulled — the exact trap that let a keyless
  // Enter "choose" a broken ollama config and continue silently degraded.
  // Drop ollama when its daemon doesn't answer; annotate it when the daemon
  // answers but hasn't pulled the recipe's model. Scoped to ollama — other
  // local recipes (claude-cli) have no daemon to probe.
  const localHints = new Map<string, string>();
  const localRecipes = ready.filter((r) => r.id === 'ollama');
  if (localRecipes.length > 0) {
    const probe = opts.probeLocal ?? probeOllama;
    let probeResult: ProbeResult;
    try {
      probeResult = await probe();
    } catch {
      probeResult = { reachable: false };
    }
    if (!probeResult.models_endpoint_valid) {
      ready = ready.filter((r) => r.id !== 'ollama');
    } else {
      for (const r of localRecipes) {
        const tp = r.touchpoints[opts.touchpoint];
        const wanted = tp && 'models' in tp && Array.isArray(tp.models) ? tp.models[0] : undefined;
        const served = probeResult.models ?? [];
        if (wanted && !served.some((m) => m === wanted || m.startsWith(`${wanted}:`))) {
          localHints.set(r.id, `model not pulled — run: ollama pull ${wanted}`);
        }
      }
    }
  }

  // Keyless is always a valid embedding choice — the brain works with
  // keyword search + agent-authored memory. Offer it explicitly instead of
  // forcing a keypress through a provider menu.
  const keylessOption = opts.touchpoint === 'embedding';

  if (ready.length === 0 && !keylessOption) {
    writeStderr(`\nNo ${opts.touchpoint}-capable providers are env-ready.\n`);
    writeStderr('Set one of the env vars below and re-run init:\n\n');
    writeStderr(formatRecipeTable(all, env) + '\n\n');
    return null;
  }

  // Article-aware: touchpoint is 'embedding' | 'expansion' | 'chat' — a
  // hardcoded article renders "an chat provider".
  const article = /^[aeiou]/i.test(opts.touchpoint) ? 'an' : 'a';
  writeStderr(`\nPick ${article} ${opts.touchpoint} provider (env-ready providers shown):\n\n`);
  if (ready.length > 0) writeStderr(formatRecipeTable(ready, env) + '\n\n');

  // Build numbered options (0 = keyless skip for embedding).
  const lines = ready.map((r, i) => {
    const tp = r.touchpoints[opts.touchpoint];
    let label = `  ${i + 1}) ${r.id}`;
    if (opts.touchpoint === 'embedding' && tp && 'default_dims' in tp) {
      label += `  (${tp.default_dims}d)`;
    }
    if (tp && 'models' in tp && Array.isArray(tp.models) && tp.models.length > 0) {
      // v0.46.3: show the canonical model (default_model), not array position —
      // the displayed row must match what a pick actually selects.
      label += `  ${('default_model' in tp && tp.default_model) || tp.models[0]}`;
    }
    const hint = localHints.get(r.id);
    if (hint) label += `  [${hint}]`;
    return label;
  });
  if (keylessOption) {
    lines.unshift('  0) none — continue keyless (keyword search; add a key later)');
  }
  writeStderr(lines.join('\n') + '\n\n');

  // Default: keyless when no remote (keyed) provider is ready — a bare Enter
  // must never select a local daemon the user didn't ask for.
  const hasKeyedReady = ready.some((r) => (r.auth_env?.required ?? []).length > 0);
  const defaultChoice = keylessOption && !hasKeyedReady ? '0' : '1';
  const low = keylessOption ? 0 : 1;

  const answer = await readLineSafe(
    `Choice [${low}-${ready.length}, default ${defaultChoice}]: `,
    defaultChoice,
    /* timeoutMs */ 60_000,
  );

  const choice = parseInt(answer.trim(), 10);
  if (!Number.isFinite(choice) || choice < low || choice > ready.length) {
    writeStderr(`\nInvalid choice "${answer}".\n`);
    return null;
  }
  if (keylessOption && choice === 0) {
    return null; // caller continues keyless with its own notice
  }

  const picked = ready[choice - 1];
  const tp = picked.touchpoints[opts.touchpoint];
  if (!tp) return null;

  // v0.46.3: pick the recipe's canonical model (default_model), falling back to
  // array position (callers can override via flag).
  const modelId = ('models' in tp && Array.isArray(tp.models) && tp.models.length > 0)
    ? (('default_model' in tp && tp.default_model) || tp.models[0])
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
