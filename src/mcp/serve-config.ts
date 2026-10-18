import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, loadConfigWithEngine, type GBrainConfig } from '../core/config.ts';
import { isEngineDegraded } from '../core/degraded-marker.ts';

/**
 * #6589: the two config views an HTTP server reads once at startup. `fileConfig` is the file plane
 * (advertised surface, strict params); `operationConfig` is the CLI's effective config (file + env over
 * the DB plane) that operations and resources see, so a `gbrain config set` change applies after a
 * serve restart (D18). A degraded engine keeps the file plane.
 */
export async function loadServeConfigs(engine: BrainEngine): Promise<{ fileConfig: GBrainConfig | null; operationConfig: GBrainConfig | undefined }> {
  const fileConfig = loadConfig();
  const operationConfig = isEngineDegraded(engine) ? fileConfig
    : await loadConfigWithEngine(engine, fileConfig ?? { engine: engine.kind } as GBrainConfig);
  return { fileConfig, operationConfig: operationConfig ?? undefined };
}
