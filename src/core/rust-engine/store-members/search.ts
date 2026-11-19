/**
 * Keyword search (BrainEngine searchKeyword) moved to keyword.ts, where it ranks with the ported `ts_rank`
 * (RUST_ENGINE.md, D5) and runs the hybrid arm's retries as PGLite does. This module exports no member now, so the
 * member has one definition; index.ts still spreads it so a later search member needs no wiring.
 */
export {};
