/**
 * Lock skips that stay safe when the Rust engine's explicit transactions run optimistically (multi-user mode, interface
 * I-1; docs/designs/rust-engine/multi-user-server.md, "Appendix: skip guarantees under multi-user mode").
 *
 * A TypeScript lock skip asserts `serialized_transactions` first (errors.ts `assertSerializedTransactions`,
 * store-members/common.ts `assertStoreSerializedTransactions`). With multi-user mode off the store's explicit
 * transactions hold the writer and every skip passes. With it on, a skip passes only when its site is listed here with
 * the guarantee that replaces the lock and the test that proves it under `GBRAIN_RUST_MULTIUSER=1`; every other site
 * refuses `engine_capability_missing`. test/serialized-transactions-guard.test.ts checks each row names a marked site
 * and an existing test. The Rust-side sites have their own table (rust/crates/gbrain-store/src/lock_skips.rs).
 */

/** What replaces the skipped lock once explicit transactions run optimistically. */
export type LockSkipGuarantee =
  /** Every key the transaction read through its handle is validated at commit; a changed read reruns the callback. */
  | 'read-set'
  /** A revision compare inside the transaction (a read of the row, so validated at commit). */
  | 'cas'
  /** The keys are held in the brain's single-flight table (lockPageKeys) until commit or rollback. */
  | 'single_flight'
  /** Commutative counter operations whose admission check is re-evaluated at commit. */
  | 'counter';

export interface ProvenLockSkip {
  readonly guarantee: LockSkipGuarantee;
  /** The test that proves the guarantee with multi-user mode on: `<file>::<test name>`. */
  readonly test: string;
}

/** The TypeScript-side sites proven under multi-user mode, by site id. */
export const MULTIUSER_PROVEN: Readonly<Record<string, ProvenLockSkip>> = {};

/** Whether `site` may skip its lock while explicit transactions run optimistically. */
export function provenUnderMultiuser(site: string): boolean {
  return Object.prototype.hasOwnProperty.call(MULTIUSER_PROVEN, site);
}
