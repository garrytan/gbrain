/**
 * The served follower path (multi-user Rust): protocol v3 follower frames (follower-frames.ts) wired to lane L2's
 * napi follower (`Follower#applyRaw`, `#installSnapshot`) and the primary's `Brain#readCommitLogRaw` / `#snapshotTo`
 * (rust/crates/gbrain-napi/src/families/follower.rs). Not yet offered on a connection: the `follower` capability stays
 * off the server's list, so every hello is unchanged; a session that offers it wires these functions to its frames.
 *
 * Primary side: `primaryRecordsFrame` turns one page of the commit log into a `repl_records` frame, the record bytes as
 * the store holds them; `primarySnapshotFrames` copies the brain with `snapshotTo` and turns the copy into
 * `repl_snap_begin`, chunks and `repl_snap_end`.
 *
 * Follower side: `FollowerApplier.onFrame` takes one frame and answers with the frames to send back. Records go to
 * `applyRaw`; a snapshot goes through a SnapshotReceiver into a private staging directory, then to
 * `installSnapshot(dir, manifest)`. Every store refusal (`snapshot_required`, `invalid_state`, ...) crosses back in
 * `repl_ack` unchanged; a frame the codecs refuse answers `owner_ipc_protocol` `frame_malformed`. The applier never
 * opens the follower: its owner opens it with `Follower.open`, which checks the format on a recovered copy.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, openSync, readSync, closeSync, fstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { encodeError } from '../owner-ipc/codec.ts';
import {
  SNAPSHOT_CHUNK_BYTES, SNAPSHOT_FILES, SnapshotReceiver, decodeReplRecords, decodeSnapshotBegin, decodeSnapshotChunk,
  encodeReplAck, encodeReplRecords, encodeSnapshotBegin, encodeSnapshotChunk, encodeSnapshotEnd, encodeSnapshotWindow,
  type CommitPositionWire, type SnapshotManifestWire, type TimelineWire,
} from './follower-frames.ts';
import type { RustStore } from '../store.ts';

type Frame = { header: Record<string, unknown>; tail: Buffer | null };

/** What the applier needs of L2's napi `Follower`. */
export interface FollowerNapi {
  applyRaw(brainId: string, lineage: TimelineWire[], records: Array<{ sequence: number; index: number; bytes: Buffer }>):
    Promise<{ applied: number; skipped: number; cursor: CommitPositionWire }>;
  installSnapshot(dir: string, manifest: SnapshotManifestWire | null): Promise<CommitPositionWire>;
}

interface RawLogPage {
  brainId?: string; brain_id?: string; lineage: TimelineWire[]; newest: CommitPositionWire | null;
  snapshotRequired?: boolean; snapshot_required?: boolean;
  records: Array<{ sequence: number; index: number; bytes: Buffer }>;
}

/**
 * One `repl_records` frame: up to `max` records of the primary's commit log after `after` (null: from the log's start).
 * Null when there is nothing after `after`. Throws the store's `snapshot_required` when `after` cannot be continued.
 */
export async function primaryRecordsFrame(store: RustStore, after: CommitPositionWire | null, max: number, id: number, seq: number):
  Promise<{ header: Record<string, unknown>; tail: Buffer } | null> {
  const page = await store.brain.readCommitLogRaw(after, max) as RawLogPage;
  if (page.snapshotRequired ?? page.snapshot_required) {
    throw Object.assign(new Error('the follower\'s position cannot be continued from the commit log: send a snapshot'), { code: 'snapshot_required' });
  }
  if (!page.records.length) return null;
  return encodeReplRecords({
    id, seq, brainId: String(page.brainId ?? page.brain_id), lineage: page.lineage,
    records: page.records.map(r => ({ position: { sequence: r.sequence, index: r.index }, bytes: Buffer.from(r.bytes) })),
  });
}

/**
 * A whole snapshot of the primary as frames: `snapshotTo` into a private directory under `stagingDir`, each file read
 * in `chunkBytes` pieces. The copy is removed before this returns.
 */
export async function primarySnapshotFrames(store: RustStore, opts: { id: number; xfer: string; chunkBytes?: number; stagingDir: string }): Promise<Frame[]> {
  const parent = mkdtempSync(join(opts.stagingDir, 'snap-'));
  const dir = join(parent, 'copy');
  try {
    await store.snapshotTo(dir, { opId: opts.xfer });
    const chunk = opts.chunkBytes ?? SNAPSHOT_CHUNK_BYTES;
    const files = SNAPSHOT_FILES.map(name => {
      const bytes = readFileSync(join(dir, name));
      return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    const manifest = JSON.parse(readFileSync(join(dir, 'SNAPSHOT.json'), 'utf8')) as SnapshotManifestWire;
    const frames: Frame[] = [{ header: encodeSnapshotBegin({ id: opts.id, xfer: opts.xfer, manifest, chunkBytes: chunk, files }), tail: null }];
    for (const name of SNAPSHOT_FILES) {
      const fd = openSync(join(dir, name), 'r');
      try {
        const size = fstatSync(fd).size;
        for (let off = 0; off < size; off += chunk) {
          const piece = Buffer.alloc(Math.min(chunk, size - off));
          let at = 0;
          while (at < piece.length) { const n = readSync(fd, piece, at, piece.length - at, off + at); if (n === 0) break; at += n; }
          const { header, tail } = encodeSnapshotChunk({ id: opts.id, xfer: opts.xfer, file: name, off, bytes: piece });
          frames.push({ header, tail });
        }
      } finally { closeSync(fd); }
    }
    frames.push({ header: encodeSnapshotEnd({ id: opts.id, xfer: opts.xfer }), tail: null });
    return frames;
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

/** The follower side of the replication frames on one connection (module docs). */
export class FollowerApplier {
  private transfer: { id: number; xfer: string; receiver: SnapshotReceiver; dir: string } | null = null;

  constructor(private readonly follower: FollowerNapi, private readonly opts: { brainId: string; stagingDir: string; maxBytes: number }) {}

  async onFrame(header: Record<string, unknown>, tail: Buffer | null): Promise<Frame[]> {
    const id = typeof header.id === 'number' ? header.id : 0;
    switch (header.t) {
      case 'repl_records': return [await this.records(header, tail, id)];
      case 'repl_snap_begin': return this.snapshotStep(id, 0, () => {
        const plan = decodeSnapshotBegin(header);
        this.dropTransfer();
        const dir = join(mkdtempSync(join(this.opts.stagingDir, 'recv-')), 'snapshot');
        const receiver = new SnapshotReceiver({ dir, expectBrainId: this.opts.brainId, maxBytes: this.opts.maxBytes });
        this.transfer = { id: plan.id, xfer: plan.xfer, receiver, dir };
        receiver.begin(plan);
        return [];
      });
      case 'repl_snap_chunk': return this.snapshotStep(id, 0, () => {
        const t = this.transferFor(header);
        t.receiver.chunk(decodeSnapshotChunk(header, tail));
        const window = t.receiver.window();
        return window ? [{ header: encodeSnapshotWindow({ id: t.id, xfer: t.xfer, ...window }), tail: null }] : [];
      });
      case 'repl_snap_end': return this.snapshotStep(id, 0, async () => {
        const t = this.transferFor(header);
        try {
          const { dir, manifest } = t.receiver.end(header);
          const cursor = await this.follower.installSnapshot(dir, manifest);
          return [{ header: encodeReplAck({ id: t.id, seq: 0, ok: true, cursor }), tail: null }];
        } finally { this.dropTransfer(); }
      });
      default: return [];
    }
  }

  async close(): Promise<void> { this.dropTransfer(); }

  private async records(header: Record<string, unknown>, tail: Buffer | null, id: number): Promise<Frame> {
    const seq = typeof header.seq === 'number' ? header.seq : 0;
    try {
      const decoded = decodeReplRecords(header, tail);
      const out = await this.follower.applyRaw(decoded.brainId, decoded.lineage,
        decoded.records.map(r => ({ sequence: r.position.sequence, index: r.position.index, bytes: r.bytes })));
      return { header: encodeReplAck({ id: decoded.id, seq: decoded.seq, ok: true, applied: out.applied, skipped: out.skipped, cursor: out.cursor }), tail: null };
    } catch (error) {
      return { header: encodeReplAck({ id, seq, ok: false, error: encodeError(error) }), tail: null };
    }
  }

  /** Runs one snapshot step; a refusal ends the transfer and answers `repl_ack` with the error unchanged. */
  private async snapshotStep(id: number, seq: number, step: () => Frame[] | Promise<Frame[]>): Promise<Frame[]> {
    try { return await step(); }
    catch (error) {
      this.dropTransfer();
      return [{ header: encodeReplAck({ id, seq, ok: false, error: encodeError(error) }), tail: null }];
    }
  }

  private transferFor(header: Record<string, unknown>): NonNullable<FollowerApplier['transfer']> {
    if (!this.transfer || header.xfer !== this.transfer.xfer) {
      throw Object.assign(new Error('a snapshot frame of a transfer this follower is not receiving'), { code: 'owner_ipc_protocol', reason: 'frame_malformed' });
    }
    return this.transfer;
  }

  private dropTransfer(): void {
    if (!this.transfer) return;
    rmSync(join(this.transfer.dir, '..'), { recursive: true, force: true });
    this.transfer = null;
  }
}
