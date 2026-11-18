/**
 * Group 5 facts statements, purge, withdrawal, relink and fence repair (docs/research/rust-cli-contract-map.md, "Facts queries, purge and unlinked-fact
 * checks"). Each function runs the statement its caller ran through `executeRaw`, with the same text and parameters, on
 * the engine's own `executeRaw`; only its home moved.
 */
export type { EngineRawRead } from './cli-reads-ops.ts';
