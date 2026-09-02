/**
 * Engine-plane wrapper around the pure `rerankerReadiness` leaf — the ONE place
 * doctor (`reranker_health`) and `gbrain search modes` build the env snapshot,
 * so the two surfaces cannot drift apart.
 *
 * Plane precedence: when the gateway is configured (every CLI command after
 * connectEngine), use ITS env + base_urls — that is exactly what `rerank()`
 * consults, so the verdict can never disagree with search (and a mounted
 * brain's DB-plane config, which the CLI deliberately never folds into the
 * gateway, cannot steer it either). When no gateway is configured (unit tests,
 * early paths), fall back to the same plane the CLI would build: process env >
 * file config > DB-plane provider keys + `provider_base_urls`
 * (`loadConfigWithEngine`), file plane alone if the DB read fails. `init` does
 * NOT use this (it runs before any engine plane exists).
 */

import { loadConfig, loadConfigWithEngine, type GBrainConfig } from '../config.ts';
import type { DbPlaneEngineReader } from '../config-db-merge.ts';
import { mergedProviderEnv } from './provider-env.ts';
import { requireConfig } from './gateway.ts';
import { rerankerReadiness, type RerankerReadiness } from './reranker-readiness.ts';

export interface EngineReadiness {
  readiness: RerankerReadiness;
  /** Which plane answered: the live gateway snapshot, or the file+DB merge. */
  plane: 'gateway' | 'config';
}

export async function rerankerReadinessForEngine(
  engine: DbPlaneEngineReader,
  model: string,
  opts: { now?: Date } = {},
): Promise<EngineReadiness> {
  try {
    const gw = requireConfig();
    return {
      plane: 'gateway',
      readiness: rerankerReadiness(model, gw.env ?? {}, { now: opts.now, baseUrlOverrides: gw.base_urls ?? null }),
    };
  } catch {
    // Gateway not configured — build the plane the CLI would.
  }
  let fileCfg: GBrainConfig | null = null;
  try { fileCfg = loadConfig(); } catch { fileCfg = null; }
  let mergedCfg: GBrainConfig | null = fileCfg;
  try { mergedCfg = await loadConfigWithEngine(engine, fileCfg); } catch { mergedCfg = fileCfg; }
  return {
    plane: 'config',
    readiness: rerankerReadiness(model, mergedProviderEnv(mergedCfg, process.env), {
      now: opts.now,
      baseUrlOverrides: mergedCfg?.provider_base_urls ?? null,
    }),
  };
}
