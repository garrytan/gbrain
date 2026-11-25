/**
 * The fence a protected call carries on a Rust brain in multi-user mode (lane L5; rust/crates/gbrain-store/src/leases.rs):
 * the lease name, the epoch the holder took and its token. A type only, so the engine interfaces can name it in their
 * options without importing the Rust engine. The SQL engines (PGLite, Postgres) ignore it: they fence with their own
 * row locks and tokens.
 */
export interface LeaseToken { name: string; epoch: number; token: string }

/** The options of a protected call: `{ fence }` on a registered host, nothing otherwise (`fenceOpts` in persistence/host-fence.ts). */
export interface FenceOpts { fence?: LeaseToken }
