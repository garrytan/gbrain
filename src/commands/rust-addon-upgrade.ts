/**
 * Keeping the Rust engine addon current across upgrades, for a brain that uses Rust (the engine, or shadow mode).
 * Kept apart from `engine-install.ts` so the upgrade and autopilot modules that import it do not take on the install
 * command's flags. The two upgrade steps are best effort and never throw.
 */
import { loadConfig } from '../core/config.ts';
import type { EngineConfig } from '../core/types.ts';
import { shadowStateFor } from '../shadow/state.ts';
import { execFileSync } from '../core/spawn.ts';

/** True when the configured brain runs on the Rust engine or has Rust engine shadow mode on. Reads files only. */
export function configuredBrainUsesRust(config: EngineConfig | null = loadConfig() as EngineConfig | null): boolean {
  return !!config && (config.engine === 'rust' || !!shadowStateFor(config));
}

/**
 * What autopilot does after a settled `gbrain upgrade --swap-only` (whose relaunch runs no post-upgrade), before it
 * relaunches: for a brain that uses Rust, run the NEW binary's `gbrain engine install rust`, so the addon matches the
 * version it installed. It runs after the swap is settled, under its own 120 s bound, so a slow download can never
 * turn a good swap into a failed one. Best effort: a failure prints the install command. Any other brain runs nothing.
 */
export function installAddonWithInstalledBinary(
  env: NodeJS.ProcessEnv,
  run: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: 'ignore'; timeout: number }) => unknown = execFileSync,
  usesRust: () => boolean = () => configuredBrainUsesRust(),
): boolean {
  try {
    if (!usesRust()) return false;
    run('gbrain', ['engine', 'install', 'rust', '--json'], { env, stdio: 'ignore', timeout: 120_000 });
    return true;
  } catch (err) {
    console.error(`Rust engine addon not installed after the upgrade: ${err instanceof Error ? err.message : String(err)}. Run gbrain engine install rust.`);
    return false;
  }
}

/** What `gbrain post-upgrade` runs: the best-effort addon refresh, for a brain that uses Rust only. */
export async function refreshRustAddonForConfiguredBrain(): Promise<string | null> {
  const { refreshRustAddonAfterUpgrade } = await import('../core/rust-engine/addon-install.ts');
  return refreshRustAddonAfterUpgrade(() => configuredBrainUsesRust());
}
