/**
 * [CX-P0.5] Keyless capability probe — config-plane only, no network.
 *
 * Bootstrap must work with ZERO API keys (the harness agent is the
 * subsidized LLM; search degrades to BM25 keyword; facts come from
 * agent-authored `## Facts` fences and explicit write ops). This module
 * answers "what can this install actually do?" from configuration alone:
 *
 *   - embeddings  → can we compute vectors? (drives semantic vs keyword search)
 *   - extraction  → can we call a chat model? (drives auto facts/enrichment
 *                   and the corpus-ingest pass of the maintenance sweep)
 *
 * Detection mirrors the provider picker (src/commands/init-provider-picker.ts
 * `envReady`) and the gateway's availability predicate
 * (src/core/ai/gateway.ts `isAvailable` / `diagnoseEmbedding`): a touchpoint
 * is available when its model's recipe exists, declares the touchpoint, and
 * every `auth_env.required` var is present in the merged env. The merged env
 * folds file-plane config keys exactly the way
 * `src/core/ai/build-gateway-config.ts` does (that module is the canonical
 * mapping — update BOTH if a new provider key seam is added), then overlays
 * real process-env values (env wins, empty strings dropped, #1249).
 *
 * Deliberately NOT routed through the gateway module: the gateway's
 * `_config` is process-global mutable state set at engine connect, and this
 * probe must be callable from `bootstrap verify` / the runbook / the sweep
 * without booting providers. Config + env injection keeps tests hermetic.
 */

import { loadConfig, type GBrainConfig } from './config.ts';
import { RECIPES } from './ai/recipes/index.ts';
import type { Recipe } from './ai/types.ts';
import { DEFAULT_EMBEDDING_MODEL } from './ai/defaults.ts';

// Extraction probes the SAME effective-model resolution the gateway's
// reconfigure fallback uses (resolveEffectiveChatModel) — runtime routing and
// this report cannot diverge by construction. Known accepted limitation:
// DB-plane overrides (`models.default`, `facts.extraction_model`) are
// invisible to this engine-less probe; the runtime gate in facts/extract.ts
// and the engine-aware pre-enqueue gate in facts/backstop.ts are the
// backstops.
import { resolveEffectiveChatModel } from './model-config.ts';
import { mergedProviderEnv } from './ai/provider-env.ts';

export interface TouchpointCapability {
  available: boolean;
  /** Provider (recipe id) serving the touchpoint when available. */
  provider?: string;
}

export interface CapabilityReport {
  embeddings: TouchpointCapability;
  extraction: TouchpointCapability;
  /** 'semantic' when embeddings are available; BM25 'keyword-only' otherwise. */
  search: 'semantic' | 'keyword-only';
  /** 'keyless' when NO paid touchpoint is configured — the CX-P0.5 posture. */
  mode: 'keyed' | 'keyless';
}

export interface DetectCapabilitiesOpts {
  /**
   * File-plane config. `undefined` = load via loadConfig(); explicit `null`
   * = "no config file" (fresh install). Injected by tests.
   */
  config?: GBrainConfig | null;
  /** Env to probe. Defaults to process.env. Injected by tests. */
  env?: Record<string, string | undefined>;
}

// The provider-key/env fold lives in src/core/ai/provider-env.ts
// (mergedProviderEnv) — one canonical mapping shared with buildGatewayConfig
// and the key-aware model resolution. This probe additionally sees the Azure
// endpoint/deployment fields the old local copy omitted.

/** `envReady` twin (src/commands/providers.ts:52) — auth-env readiness only. */
function recipeReady(recipe: Recipe, env: Record<string, string>): boolean {
  const required = recipe.auth_env?.required ?? [];
  if (required.length === 0) return true; // e.g. local Ollama
  return required.every(k => !!env[k]);
}

function probeTouchpoint(
  modelStr: string | undefined,
  touchpoint: 'embedding' | 'chat',
  env: Record<string, string>,
): TouchpointCapability {
  if (!modelStr) return { available: false };
  const providerId = modelStr.includes(':') ? modelStr.slice(0, modelStr.indexOf(':')) : modelStr;
  const recipe = RECIPES.get(providerId);
  if (!recipe) return { available: false };
  const tp = recipe.touchpoints[touchpoint];
  if (!tp) return { available: false };
  if (!recipeReady(recipe, env)) return { available: false };
  return { available: true, provider: recipe.id };
}

/**
 * Detect what this install can do, from config + env alone. Never touches
 * the network, the DB, or the gateway's process-global state.
 */
export function detectCapabilities(opts: DetectCapabilitiesOpts = {}): CapabilityReport {
  let cfg: GBrainConfig | null;
  if (opts.config !== undefined) {
    cfg = opts.config;
  } else {
    try {
      cfg = loadConfig();
    } catch {
      cfg = null; // unreadable config = fresh-install posture, not a crash
    }
  }
  const rawEnv = opts.env ?? process.env;
  const env = mergedProviderEnv(cfg, rawEnv);

  const embeddings = probeTouchpoint(
    cfg?.embedding_model ?? DEFAULT_EMBEDDING_MODEL,
    'embedding',
    env,
  );
  // Probe the model extraction will ACTUALLY use: GBRAIN_MODEL > servable
  // file pin > key-aware tier default — the same shared resolution the
  // gateway's reconfigure fallback applies (so a stale unservable pin
  // degrades identically here and at runtime).
  const extraction = probeTouchpoint(
    resolveEffectiveChatModel(cfg, rawEnv).model,
    'chat',
    env,
  );

  return {
    embeddings,
    extraction,
    search: embeddings.available ? 'semantic' : 'keyword-only',
    mode: embeddings.available || extraction.available ? 'keyed' : 'keyless',
  };
}

/**
 * Human-readable capability report — used by `bootstrap verify` and the
 * runbook (CX-P0.5: verify prints an honest capability report). One line
 * per touchpoint plus the keyless upsell when applicable.
 */
export function renderCapabilityReport(caps: CapabilityReport): string {
  const lines: string[] = [];
  lines.push(`gbrain capabilities: ${caps.mode} mode`);
  lines.push(
    caps.embeddings.available
      ? `  embeddings: available via ${caps.embeddings.provider} — semantic (hybrid vector + keyword) search`
      : '  embeddings: not configured — search runs keyword-only (BM25)',
  );
  lines.push(
    caps.extraction.available
      ? `  extraction: available via ${caps.extraction.provider} — automatic facts/enrichment + corpus ingest`
      : '  extraction: not configured — memory comes from agent-authored ## Facts fences and write ops',
  );
  if (caps.mode === 'keyless') {
    lines.push(
      'keyless mode: keyword search, agent-authored memory; one optional key upgrades ' +
      'capabilities — OpenAI: semantic search + auto-extraction; Voyage: semantic search; ' +
      'Anthropic: auto-extraction (see `gbrain providers list` for env-ready options).',
    );
  }
  return lines.join('\n');
}
