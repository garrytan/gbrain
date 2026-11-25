/**
 * Commit positions on protocol v3 (interfaces I-2 and I-7). The server reads the brain's published position after a
 * write settles and returns it on the write's result; a read that names `min_position` waits until the published
 * position reaches it, bounded by its deadline.
 *
 * Until per-transaction positions land (lane L2) the published position is the store's durable commit sequence with
 * index 0, which is exact only on the single-writer store (every commit alone in its batch). On the optimistic store
 * `exact` is false: the server then returns no position, and a read with a token refuses rather than compare
 * positions it cannot order (review finding F7 of the L3 plan).
 */
import { comparePositions, type CommitPositionWire } from '../owner-ipc/protocol.ts';

export interface PublishedPosition extends CommitPositionWire { exact: boolean }

/** Reads the published position of a server engine, or null when the engine has no store that can say. */
export type PositionReader = () => Promise<PublishedPosition | null>;

/** A reader over a Rust engine's open store (`Brain.commitPosition`); null for any other engine. */
export function storePositionReader(engine: object): PositionReader {
  return async () => {
    const open = (engine as { openStoreIfOpen?: (member: string) => { brain: { commitPosition?: () => Promise<PublishedPosition> } } | null })
      .openStoreIfOpen?.('commitPosition');
    const read = open?.brain.commitPosition;
    if (typeof read !== 'function') return null;
    const position = await read.call(open!.brain);
    return { sequence: Number(position.sequence), index: Number(position.index), exact: position.exact === true };
  };
}

const POLL_MS = 5;

/**
 * Waits until `read` reports a position at or past `wanted`, or `deadlineAt` passes. Resolves the published position
 * it saw last and whether it was reached. One server writes the brain, so a token a client holds came from a commit
 * this server already published; the wait matters for tokens from another connection's in-flight answer and, later,
 * for followers.
 */
export async function waitForPosition(read: PositionReader, wanted: CommitPositionWire, deadlineAt: number,
  signal?: AbortSignal): Promise<{ reached: boolean; published: PublishedPosition | null }> {
  for (;;) {
    const published = await read();
    if (published && comparePositions(published, wanted) >= 0) return { reached: true, published };
    if (Date.now() >= deadlineAt || signal?.aborted) return { reached: false, published };
    await new Promise(r => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadlineAt - Date.now()))));
  }
}
