/**
 * The one switch of multi-user Rust (docs/designs/rust-engine/multi-user-server.md, interface I-0).
 *
 * `GBRAIN_RUST_MULTIUSER=1` turns it on for a process; a server also reads the brain config key
 * `engine.rust.multiuser` (true). Off is the default, and off means every code path, frame and output is the one the
 * Rust engine had before multi-user work began. Development sub-switches are read only while the main switch is on,
 * so a stray sub-switch alone changes nothing.
 */

export const RUST_MULTIUSER_ENV = 'GBRAIN_RUST_MULTIUSER';
export const RUST_MULTIUSER_CONFIG_KEY = 'engine.rust.multiuser';

/** True when this process runs with multi-user Rust on (environment only; no engine needed). */
export function rustMultiuserOn(env: Record<string, string | undefined> = process.env): boolean {
  return env[RUST_MULTIUSER_ENV] === '1';
}

/**
 * True when multi-user Rust is on for a server engine: the environment switch, or the brain config key set to true.
 * A config read that fails counts as off (fail closed: the server then speaks only protocol v2).
 */
export async function rustMultiuserOnFor(
  engine: { getConfig?: (key: string) => Promise<string | null> },
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (rustMultiuserOn(env)) return true;
  if (typeof engine.getConfig !== 'function') return false;
  try { return (await engine.getConfig(RUST_MULTIUSER_CONFIG_KEY))?.trim() === 'true'; } catch { return false; }
}

/** A development sub-switch: read only while the main switch is on. */
export function rustMultiuserSubSwitch(name: string, env: Record<string, string | undefined> = process.env): boolean {
  return rustMultiuserOn(env) && env[name] === '1';
}

/**
 * Test-only: run interactive transactions over the wire on today's serialized transaction before optimistic explicit
 * transactions (lane L1) exist. Protocol evidence only; the final gate runs with it off.
 */
export const RUST_SERVED_SERIAL_TXN_ENV = 'GBRAIN_RUST_SERVED_SERIAL_TXN';
