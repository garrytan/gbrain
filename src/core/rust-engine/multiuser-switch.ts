/**
 * The one switch of the multi-user Rust build (interface I-0, docs/designs/rust-engine/multi-user-server.md):
 * `GBRAIN_RUST_MULTIUSER=1` in the environment, or the brain's own config row `engine.rust.multiuser` set to `true`
 * or `1`. Default off; off, every path is the path it was before the switch existed.
 *
 * The environment half is resolved here and passed to the store at open (`StoreOpenOptions.multiuser`); the config
 * half is read by the store itself from the brain's records at open, so each brain resolves its own mode and two
 * brains in one process never share it. What the store decided comes back in the open info (`multiuser: true`, absent
 * when off) and is the answer every caller uses (`RustStore.multiuser`). Sub-switches of lanes are read only when this
 * switch is on.
 */

/** The environment variable of the switch. */
export const RUST_MULTIUSER_ENV = 'GBRAIN_RUST_MULTIUSER';

/** The config row of the switch (`gbrain_store::MULTIUSER_CONFIG_KEY`). */
export const RUST_MULTIUSER_CONFIG_KEY = 'engine.rust.multiuser';

type Env = Readonly<Record<string, string | undefined>>;

/** The process environment: the switch's one world read (scripts/core-world-reads-baseline.tsv). */
function processEnv(): Env { return process.env; }

/** True when the environment turns multi-user mode on (exactly `1`). */
export function rustMultiuserFromEnv(env: Env = processEnv()): boolean {
  return env[RUST_MULTIUSER_ENV] === '1';
}

/**
 * The hello capability an owner lists exactly when its store runs in multi-user mode (it then applies the remote check
 * to marked frames: owner-ipc/remote-check.ts re-exports it as OWNER_REMOTE_CHECK_CAP).
 */
export const OWNER_MULTIUSER_HELLO_CAP = 'remote_check';

/**
 * The brain's mode as a client of its owner sees it (a client holds no store, so it cannot read the config row): on
 * when the owner's hello lists OWNER_MULTIUSER_HELLO_CAP, which follows the owner's store (the environment switch or
 * the brain's config row). The client's own environment switch also counts, as it always did.
 */
export function rustMultiuserOfOwner(ownerCapabilities: readonly string[], env: Env = processEnv()): boolean {
  return ownerCapabilities.includes(OWNER_MULTIUSER_HELLO_CAP) || rustMultiuserFromEnv(env);
}

/** True for a config value that turns multi-user mode on (`true` or `1`), as the store reads it. */
export function rustMultiuserConfigOn(value: string | null | undefined): boolean {
  return value === 'true' || value === '1';
}

/**
 * The switch for a brain whose Rust store is not open yet, read through the engine the brain runs on now: the
 * environment switch OR that brain's own config row. The engine swap reads it this way (engine-swap.ts, plan.ts): its
 * destination is the shadow store, which no process opens before the cutover, and the shadow replays the source brain's
 * `config` rows into it (src/shadow/write-map.ts), so the source's row is the destination's row as of the last replay.
 */
export async function rustMultiuserOfBrain(engine: { getConfig(key: string): Promise<string | null> }, env: Env = processEnv()): Promise<boolean> {
  return rustMultiuserFromEnv(env) || rustMultiuserConfigOn(await engine.getConfig(RUST_MULTIUSER_CONFIG_KEY));
}

/**
 * A lane sub-switch (`GBRAIN_RUST_COMMIT_LOG`, ...), read only while the brain runs in multi-user mode, else always
 * false. `store` is the store's resolved answer (`RustStore.multiuser`: the environment switch OR the brain's config
 * row), so a brain that is on only through its config row gets its sub-switches too (I-0.v2).
 */
export function rustMultiuserSubSwitch(name: string, store: { readonly multiuser: boolean }, env: Env = processEnv()): boolean {
  return store.multiuser === true && env[name] === '1';
}
