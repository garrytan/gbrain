/**
 * The op_checkpoints op name of the per-source git hold summary row. A leaf module, so a reader that needs only the
 * name (engine-sql/doctor-search.ts) does not pull the persistence journal's import closure into the engine bundle,
 * which the embedded-WASM chunker smoketest (scripts/check-wasm-embedded.sh) compiles from src/ alone.
 */
export const GIT_HOLD_SUMMARY_OP = 'sync-hold-summary';
