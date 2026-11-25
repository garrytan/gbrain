/**
 * Multi-user mode of the Rust engine (I-0 in docs/designs/rust-engine/multi-user-server.md): one switch,
 * `GBRAIN_RUST_MULTIUSER=1`, default off. Off, every path, record and output is what it was before the mode existed.
 * On, the store keeps a commit log and stamps write origins (rust/docs/store/commit-log.md); the addon reads the
 * sub-switches (`GBRAIN_RUST_COMMIT_LOG=0`, `GBRAIN_RUST_WRITE_ORIGIN=0`) only while this one is on.
 *
 * This is the one reader of the switch on the TypeScript side; every lane's code asks it.
 */

/** True when `GBRAIN_RUST_MULTIUSER=1` is set. Reads that one variable by name. */
export function rustMultiuserRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GBRAIN_RUST_MULTIUSER === '1';
}
