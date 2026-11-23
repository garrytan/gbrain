/**
 * `rust_engine_addon`: whether the Rust engine addon loads on this machine, for a brain with Rust engine shadow mode
 * on (`gbrain engine shadow start`). Not applicable otherwise. It loads the addon the way the shadow child does,
 * with no network call (src/shadow/addon.ts): the development override or the addon already installed in the gbrain
 * home. A refusal reports its code (`rust_engine_addon_missing` or `rust_engine_addon_mismatch`), reason and
 * message; while it fails, the shadow child records every comparison as addon_unavailable. Reads no database.
 */
import { loadConfig } from '../../../core/config.ts';
import type { EngineConfig } from '../../../core/types.ts';
import type { RustEngineAddonLoad } from '../../../core/rust-engine/addon-loader.ts';
import { loadRustEngineAddonOffline } from '../../../shadow/addon.ts';
import { shadowStateFor } from '../../../shadow/state.ts';
import type { Check } from '../../doctor.ts';
import { infoCheck } from '../check-fix.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';

export const RUST_ENGINE_ADDON_CHECK = 'rust_engine_addon';

/** The check for a config, with the loader injectable for tests. */
export async function rustEngineAddonCheck(
  config: EngineConfig | null,
  load: () => Promise<RustEngineAddonLoad> = () => loadRustEngineAddonOffline(),
): Promise<Check> {
  if (!config || !shadowStateFor(config)) {
    return infoCheck(RUST_ENGINE_ADDON_CHECK, 'Not applicable: Rust engine shadow mode is off for this brain.', 'not_applicable');
  }
  const result = await load();
  if (result.ok) {
    const { target, engineAbi, engineBuild } = result.addon;
    return {
      name: RUST_ENGINE_ADDON_CHECK, status: 'ok',
      message: `Rust engine addon loads (target ${target}, engine ABI ${engineAbi}, build ${engineBuild}); shadow mode can compare reads.`,
      details: { target, engine_abi: engineAbi, engine_build: engineBuild },
    };
  }
  return {
    name: RUST_ENGINE_ADDON_CHECK, status: 'fail',
    message: `${result.code} (${result.reason}): ${result.message} Shadow mode records every comparison as addon_unavailable until it loads; gbrain engine shadow stop turns shadow mode off.`,
    details: { code: result.code, reason: result.reason },
  };
}

async function runRustEngineAddon(_ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  let config: EngineConfig | null;
  try { config = loadConfig() as EngineConfig | null; } catch { return checks; }
  checks.push({ ...(await rustEngineAddonCheck(config)), name: 'rust_engine_addon' });
  return checks;
}

export const rustEngineAddonEntry: DoctorEntry = {
  name: 'rust_engine_addon',
  emits: ['rust_engine_addon'],
  run: runRustEngineAddon,
};
