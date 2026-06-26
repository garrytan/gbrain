// src/core/remediation/context.ts
// v0.41.18.0 (A1, codex finding #2). Extracted verbatim from
// src/commands/doctor.ts:loadRecommendationContext so both the doctor
// CLI shell AND the new gbrain onboard / MCP run_onboard surfaces
// build the same context object.
//
// Pure read; no side effects.

import type { BrainEngine } from '../engine.ts';
import type { RecommendationContext } from '../brain-score-recommendations.ts';
import { CHUNKER_VERSION } from '../chunkers/code.ts';
import { isSourceUnchangedSinceSync } from '../git-head.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../link-extraction.ts';

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
  opts: { repoPath?: string; sourceScoped?: boolean } = {},
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
  const repoPath = opts.repoPath ?? await engine.getConfig('sync.repo_path');
  let sourceId: string | undefined;
  let repoNeedsSync = false;
  let staleExtractionPages = 0;

  if (repoPath) {
    try {
      const rows = await engine.executeRaw<{
        id: string;
        local_path: string | null;
        last_commit: string | null;
        chunker_version: string | number | null;
      }>(
        `SELECT id, local_path, last_commit, chunker_version
           FROM sources
          WHERE local_path = $1
          ORDER BY id
          LIMIT 1`,
        [repoPath],
      );
      const source = rows[0];
      if (source) {
        if (opts.sourceScoped === true) sourceId = source.id;
        const gitFresh = isSourceUnchangedSinceSync(source.local_path, source.last_commit, {
          requireCleanWorkingTree: 'ignore-untracked',
        });
        const chunkerFresh = String(source.chunker_version ?? '') === String(CHUNKER_VERSION);
        repoNeedsSync = !(gitFresh && chunkerFresh);
      } else {
        repoNeedsSync = true;
      }
    } catch {
      // Older or partially migrated schemas should still be able to render a
      // remediation plan; stale extraction below is best-effort for the same reason.
    }
  }

  try {
    staleExtractionPages = await engine.countStalePagesForExtraction({
      sourceId,
      versionTs: LINK_EXTRACTOR_VERSION_TS,
    });
  } catch {
    staleExtractionPages = 0;
  }

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
    sourceId,
    repoPath: repoPath ?? undefined,
    repoNeedsSync,
    staleExtractionPages,
    embeddingModel,
    embeddingDimensions,
    embeddingProviderConfigured: embeddingConfigured,
    hasChatApiKey: !!(process.env.ANTHROPIC_API_KEY || fileCfg?.anthropic_api_key),
  };
}
