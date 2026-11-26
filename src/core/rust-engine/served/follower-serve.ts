/**
 * Following a Rust primary over protocol v3 (multi-user Rust). NOT WIRED YET: the fail-first stage of the served
 * follower test. The primary offers nothing (no `follower` capability) and a follower cannot connect.
 */
export interface FollowerServeOptions { pollMs?: number; maxRecords?: number; chunkBytes?: number; windowBytes?: number; stagingDir?: string }
export interface FollowerLink { close(): Promise<void>; drop(): void; readonly connections: number }
export async function followPrimary(_opts: Record<string, unknown>): Promise<FollowerLink> {
  throw new Error('following a primary is not wired');
}
