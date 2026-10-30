/**
 * The connect-time re-merge of DB-plane config into the selected config and the AI gateway, run by the CLI's
 * completeEngineStartup (main.ts) after migrations. GBRA-133: one config snapshot serves the merge and the gateway
 * re-stamp, which each read the whole config table.
 */
import { buildGatewayConfig } from '../core/ai/build-gateway-config.ts';
import { configureGateway, reconfigureGatewayWithEngine } from '../core/ai/gateway.ts';
import { loadConfigWithEngine, type GBrainConfig } from '../core/config.ts';
import { keepCommandStartupConfig, requestConfigRows, withRequestConfigSnapshot } from '../core/config-snapshot.ts';
import { seedWriteSwitchSnapshot } from '../core/persistence/switches.ts';
import type { BrainEngine } from '../core/engine.ts';

export async function mergeDbPlaneConfig(engine: BrainEngine, config: GBrainConfig, MERGED_CONFIG_BY_ENGINE: WeakMap<BrainEngine, GBrainConfig>): Promise<void> {
  // v0.27.1 (F3 fix): re-merge DB-plane config now that the engine is up.
  // Flags like `embedding_multimodal` are user-mutable via `gbrain config set`
  // (DB plane) and need to flow into the gateway after connect. Schema-sizing
  // fields (embedding_dimensions etc.) keep their pre-connect file/env values
  // — those drove initSchema and the merged config respects file/env first.
  try {
    // GBRA-133: the DB-plane merge and the gateway re-stamp each read the whole config table; one snapshot serves both.
    await withRequestConfigSnapshot(engine, async () => {
      const merged = await loadConfigWithEngine(engine, config);
      if (merged) {
        // #1475 — hand the merged config to makeContext instead of letting it
        // re-derive one. See MERGED_CONFIG_BY_ENGINE (main.ts): the op-side gates read
        // ctx.config, and re-running the merge there would double this
        // function's per-key config reads on every command (the cost #3980 is
        // about). Keyed on the engine so a mounted brain cannot be served the
        // host brain's merge.
        MERGED_CONFIG_BY_ENGINE.set(engine, merged);
        // Stash gate flags on process.env for downstream readers (import-file.ts
        // dispatches on GBRAIN_EMBEDDING_MULTIMODAL, gates OCR on GBRAIN_EMBEDDING_IMAGE_OCR).
        // The OCR *model* reaches the gateway via the re-configure below (#4107); its
        // env stash stays so subprocesses re-fold it through loadConfig's env merge.
        if (merged.embedding_multimodal !== undefined) {
          process.env.GBRAIN_EMBEDDING_MULTIMODAL = String(merged.embedding_multimodal);
        }
        if (merged.embedding_image_ocr !== undefined) {
          process.env.GBRAIN_EMBEDDING_IMAGE_OCR = String(merged.embedding_image_ocr);
        }
        if (merged.embedding_image_ocr_model !== undefined) {
          process.env.GBRAIN_EMBEDDING_IMAGE_OCR_MODEL = merged.embedding_image_ocr_model;
        }
        // Always re-configure with merged values when DB merge succeeded. The
        // trigger used to be field-name-gated (only when embedding_multimodal_model
        // was set); that coupled the gate to the field set and would silently
        // miss future DB-mutable gateway fields. One extra cache+shrinkState
        // clear per startup is microseconds, no hot path.
        configureGateway(buildGatewayConfig(merged));
      }
      // v0.31.12: re-resolve gateway defaults through resolveModel so
      // `models.tier.*` and `models.default` overrides apply to expansion +
      // chat. Per Codex F3 — configureGateway is sync; this is the async
      // re-stamp seam after engine.connect() makes config reads possible.
      await reconfigureGatewayWithEngine(engine);
      // GBRA-156: the same table read serves the command's source resolution and its write switches.
      const rows = await requestConfigRows(engine);
      if (rows) { keepCommandStartupConfig(engine, rows); seedWriteSwitchSnapshot(engine, rows); }
    });
  } catch {
    // Non-fatal. Pre-v39 brains may not have a usable config table yet.
  }
}

