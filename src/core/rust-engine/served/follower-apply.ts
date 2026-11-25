/**
 * The served follower path (multi-user Rust): protocol v3 follower frames (follower-frames.ts) wired to lane L2's
 * napi follower (`Follower#applyRaw`, `#installSnapshot`) and the primary's `Brain#readCommitLogRaw` / `#snapshotTo`.
 * NOT WIRED YET: every entry point refuses (the fail-first stage of the end-to-end test).
 */
export interface FollowerNapi {
  applyRaw(brainId: string, lineage: unknown, records: Array<{ sequence: number; index: number; bytes: Buffer }>): Promise<unknown>;
  installSnapshot(dir: string, manifest: unknown): Promise<unknown>;
}
export class FollowerApplier {
  constructor(..._args: unknown[]) {}
  async onFrame(_header: Record<string, unknown>, _tail: Buffer | null): Promise<Array<{ header: Record<string, unknown>; tail: Buffer | null }>> {
    throw new Error('the served follower path is not wired');
  }
  async close(): Promise<void> {}
}
export async function primaryRecordsFrame(..._args: unknown[]): Promise<{ header: Record<string, unknown>; tail: Buffer } | null> {
  throw new Error('the served follower path is not wired');
}
export async function primarySnapshotFrames(..._args: unknown[]): Promise<Array<{ header: Record<string, unknown>; tail: Buffer | null }>> {
  throw new Error('the served follower path is not wired');
}
