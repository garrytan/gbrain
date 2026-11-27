/**
 * The op_checkpoints op names of the per-source git hold summary row and of the managed sync pass row. A leaf module, so a reader that needs only the
 * name (engine-sql/doctor-search.ts) does not pull the persistence journal's import closure into the engine bundle,
 * which the embedded-WASM chunker smoketest (scripts/check-wasm-embedded.sh) compiles from src/ alone.
 */
export const GIT_HOLD_SUMMARY_OP = 'sync-hold-summary';
/** The op_checkpoints op of a source incarnation's managed sync pass row (persistence/sync-pass-row.ts re-exports it). Here, in the leaf, so the journal reads and the pass row never import each other in a cycle. */
export const MANAGED_SYNC_PASS_OP = 'managed-sync-pass';
