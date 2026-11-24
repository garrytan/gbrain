/**
 * The mention pass's statements (src/core/mentions/pass.ts), each with the text and parameters the pass ran through
 * `executeRaw`; only their home moved. Each member runs on the engine it is called on, so a member called on a
 * transaction's engine runs in that transaction, as the statement did. The Rust engine answers the same members from
 * its store (rust/crates/gbrain-store/src/mention_state.rs, rust/docs/store/mention-state.md).
 */

/** The engine's own `executeRaw`, so each statement takes the path it took before (Postgres counts the raw gauge). */
export interface MentionRaw {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}
