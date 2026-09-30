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
 * #5609: `extract --stale` refuses without the active schema pack, so a
 * recommendation would dispatch a job that fails every cycle. Shared by doctor
 * and autopilot so both planners withhold it together.
 */
export async function staleExtractionBlocked(engine: BrainEngine, sourceId?: string): Promise<string | undefined> {
  const { loadActivePackForLocalEngine } = await import('../schema-pack/best-effort.ts');
  const { LINK_EXTRACTOR_VERSION_TS } = await import('../link-extraction.ts');
  const sourceIds = sourceId ? [sourceId]
    : (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE NOT archived ORDER BY id')).map(row => row.id);
  for (const id of sourceIds) {
    if (await loadActivePackForLocalEngine(engine, { sourceId: id })) continue;
    if (!sourceId && !await engine.countStalePagesForExtraction({ sourceId: id, versionTs: LINK_EXTRACTOR_VERSION_TS })) continue;
    return `active schema pack is unavailable for source ${id}; extract --stale cannot run until \`gbrain doctor\` schema-pack checks pass`;
  }
  return undefined;
}

/**
 * Build RecommendationContext from engine + config. Pure read; no
 * side effects. Used by computeRemediationPlan, runRemediation, and
 * the doctor CLI surface.
 */
export async function loadRecommendationContext(
  engine: BrainEngine,
): Promise<RecommendationContext> {
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
  const { loadConfigFileOnly } = await import('../config.ts');
  const fileCfg = loadConfigFileOnly();
  const { embeddingProviderConfigured, HOSTED_EMBED_KEY_CONFIG, chatApiKeyConfigured } = await import(
    '../brain-score-recommendations.ts'
  );
  const embeddingConfigured = embeddingProviderConfigured(embeddingModel, (envVar) => {
    const cfgField = HOSTED_EMBED_KEY_CONFIG[envVar];
    const fromCfg = cfgField ? (fileCfg as Record<string, unknown> | null)?.[cfgField] : undefined;
    return !!(process.env[envVar] || fromCfg);
  });
  // D12: NULL-signature cohort (embedded chunks on pages with no recorded
  // embedding signature — pre-v108 or never stamped). computeRecommendations
  // is sync/engine-less, so the ENGINE-holding upstream probes it and threads
  // it through the context. Fail OPEN to 0: a probe bug must never kill
  // remediation (it just falls back to the plain stale run).
  let nullSignatureCohort = 0;
  try {
    const { currentEmbeddingSignature } = await import('../embedding.ts');
    const sig = currentEmbeddingSignature();
    if (sig) {
      const wide = await engine.countStaleChunks({ signature: sig, includeNullSignature: true });
      const narrow = await engine.countStaleChunks({ signature: sig });
      nullSignatureCohort = Math.max(0, wide - narrow);
    }
  } catch {
    nullSignatureCohort = 0;
  }
  return {
    repoPath: repoPath ?? undefined,
    embeddingModel,
    embeddingDimensions,
    embeddingProviderConfigured: embeddingConfigured,
    // #3944: shared env+file-plane probe (same helper as autopilot's
    // dispatch loop, so the two planners can never disagree on this).
    hasChatApiKey: chatApiKeyConfigured(fileCfg),
    nullSignatureCohort,
    // Fail open like the cohort probe: a probe bug must never hide remediation.
    staleExtractionBlocked: await staleExtractionBlocked(engine).catch(() => undefined),
  };
}
