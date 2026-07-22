// src/core/remediation/context.ts
// v0.41.18.0 (A1, codex finding #2). Extracted verbatim from
// src/commands/doctor.ts:loadRecommendationContext so both the doctor
// CLI shell AND the new gbrain onboard / MCP run_onboard surfaces
// build the same context object.
//
// Pure read; no side effects.

import type { BrainEngine } from '../engine.ts';
import type { RecommendationContext } from '../brain-score-recommendations.ts';

// Re-export so consumers can `import { RecommendationContext } from '../remediation'`
// — the canonical RecommendationContext type still lives in
// brain-score-recommendations.ts (it's also the input to computeRecommendations).
export type { RecommendationContext };

/**
 * Build RecommendationContext from engine + config. Pure read; no
 * side effects. Used by computeRemediationPlan, runRemediation, and
 * the doctor CLI surface.
 */
export async function loadRecommendationContext(
  engine: BrainEngine,
): Promise<RecommendationContext> {
  // v0.37 fix wave (Lane E.4 + CDX2-11): read schema-sizing fields from
  // gateway, not DB. The DB plane is schema-applied metadata; the file
  // plane is the gateway runtime source. Pre-fix this context produced
  // stale recommendations on fresh installs whose DB rows hadn't been
  // populated.
  //
  // Also extended the API-key check to recognize the ZE key alongside
  // OpenAI (was OpenAI-only). After Lane C.3, zeroentropy_api_key lives
  // in GBrainConfig + propagates to the gateway env dict.
  const repoPath = await engine.getConfig('sync.repo_path');
  let embeddingModel: string | undefined;
  let embeddingDimensions: number | undefined;
  try {
    const gw = await import('../ai/gateway.ts');
    embeddingModel = gw.getEmbeddingModel();
    embeddingDimensions = gw.getEmbeddingDimensions();
  } catch {
    // Gateway unconfigured — fall back to DB plane as a best-effort hint
    // (preserves doctor running before any engine.connect()).
    const dbModel = await engine.getConfig('embedding_model');
    const dbDims = await engine.getConfig('embedding_dimensions');
    embeddingModel = dbModel ?? undefined;
    embeddingDimensions = dbDims ? Number(dbDims) : undefined;
  }
  // v0.40.x: recipe-aware provider check, shared with autopilot.ts via
  // embeddingProviderConfigured(). Local providers (ollama, llama-server —
  // empty auth_env.required) need no hosted key; hosted providers check
  // their OWN required key (so a Voyage brain is judged by VOYAGE_API_KEY,
  // not by whether an OpenAI/ZE key happens to exist — the pre-fix wart).
  // fileCfg loads synchronously, so the resolveKey closure is sync.
  const { loadConfigFileOnly } = await import('../config.ts');
  const fileCfg = loadConfigFileOnly();
  const { embeddingProviderConfigured, HOSTED_EMBED_KEY_CONFIG } = await import(
    '../brain-score-recommendations.ts'
  );
  const embeddingConfigured = embeddingProviderConfigured(embeddingModel, (envVar) => {
    const cfgField = HOSTED_EMBED_KEY_CONFIG[envVar];
    const fromCfg = cfgField ? (fileCfg as Record<string, unknown> | null)?.[cfgField] : undefined;
    return !!(process.env[envVar] || fromCfg);
  });
  return {
    repoPath: repoPath ?? undefined,
    embeddingModel,
    embeddingDimensions,
    embeddingProviderConfigured: embeddingConfigured,
    hasChatApiKey: !!(process.env.ANTHROPIC_API_KEY || fileCfg?.anthropic_api_key),
  };
}
