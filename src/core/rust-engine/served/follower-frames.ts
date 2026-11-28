/**
 * Protocol v3 frames that carry a follower's replication (multi-user Rust, lane L2's `gbrain_store::follower`;
 * docs/designs/rust-engine/multi-user-server.md, "Follower frames"). Sent by follower-serve.ts under capability
 * `follower`, which a session offers only when asked by an owner server token; every other hello and every existing
 * v2/v3 frame is unchanged.
 *
 * Start, follower -> primary: { t: 'repl_follow', id, cursor: { sequence, index } | null, replica?, lineage? }
 * (follower-serve.ts). `replica` (an id) makes the follower a registered replica the primary's writes wait for (multi-user
 * Rust; rust/docs/store/commit-log.md, "Replica acks"); `lineage` lets its cursor count as an ack on (re)connect.
 *
 * Replica acks, only on a connection whose repl_follow carried `replica` (an older follower never sees them):
 *   primary -> follower  { t: 'repl_mark', acked: { sequence, index } }   what the primary counts as this replica's ack
 *   follower -> primary  { t: 'repl_detach', replica, reason }            stop waiting for `replica` (any owner-token
 *                                                                         connection that asked for `follower`)
 *   primary -> follower  { t: 'repl_detached', replica, detached }        whether a detach was committed
 *
 * Records, primary -> follower (the three arguments of `Follower::apply_raw`):
 *   { t: 'repl_records', id, seq, brain_id, lineage: [{ id, from: { sequence, index } }],
 *     records: [{ sequence, index, off, len }], tail_len }   + tail: the records' bytes, concatenated in order
 *   follower -> primary
 *   { t: 'repl_ack', id, seq, ok: true, applied, skipped, cursor: { sequence, index } }
 *   { t: 'repl_ack', id, seq, ok: false, error }   (`snapshot_required` or `invalid_state` from the store)
 * Record bytes are the store's raw record values, shipped unchanged (I-4.v2): this module never parses one. Positions
 * strictly increase; the slices tile the tail exactly (no gap, no overlap, nothing left over).
 *
 * Snapshot, primary -> follower, sized for a whole brain:
 *   { t: 'repl_snap_begin', id, xfer, manifest, chunk_bytes, files: [{ name, bytes, sha256 }] }
 *   { t: 'repl_snap_chunk', id, xfer, file, off, tail_len }   + tail: bytes [off, off + tail_len) of `file`
 *   { t: 'repl_snap_end', id, xfer }
 *   follower -> primary
 *   { t: 'repl_snap_window', id, xfer, file, through }   bytes of `file` durably written so far (flow control: the
 *                                                         primary keeps at most SNAPSHOT_WINDOW_BYTES unacknowledged)
 *   { t: 'repl_ack', id, seq: 0, ok, cursor | error }      after `Follower::install_snapshot`
 * The manifest (`SnapshotManifest`, the store's SNAPSHOT.json) is checked before any byte is accepted: its shape as the
 * store validates it, and its brain id against the brain the follower expects. `files` is exactly SNAPSHOT_FILES, in
 * order, SNAPSHOT.json last; chunks arrive in that order, each file from offset 0 with no gap. At the end each file's
 * size and sha256 must match, SNAPSHOT.json must equal the begin manifest, and only then is SNAPSHOT.json written (a
 * snapshot directory without it is incomplete, snapshot.rs). The store makes the final check on install.
 */
import { createHash, type Hash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, writeSync, fsyncSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { opError } from '../../ops/contract.ts';

/** The capability under which a session offers these frames (follower-serve.ts): only to an owner server token. */
export const FOLLOWER_CAP = 'follower';
export const REPL_FRAME_TYPES = [
  'repl_follow', 'repl_records', 'repl_ack', 'repl_snap_begin', 'repl_snap_chunk', 'repl_snap_window', 'repl_snap_end',
] as const;
/** Replica-ack frames on the same follower connection: sent only to or by a follower that names a `replica`. */
export const REPLICA_FRAME_TYPES = ['repl_mark', 'repl_detach', 'repl_detached'] as const;
/** A replica id: what `Store::attach_replica` keys on (letters, digits, `.`, `_`, `:`, `-`; at most 128 bytes). */
export const REPLICA_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** The files of a store snapshot directory, in the order they cross (format.rs RECORDS_FILE, FORMAT, snapshot.rs MANIFEST_FILE). */
export const SNAPSHOT_FILES = ['records.redb', 'FORMAT', 'SNAPSHOT.json'] as const;
export const SNAPSHOT_MANIFEST_VERSION = 1;
/** Default and largest chunk; a chunk frame stays far under the 128 MiB frame cap. */
export const SNAPSHOT_CHUNK_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_CHUNK_MAX_BYTES = 32 * 1024 * 1024;
/** Bytes the primary may send past the follower's last window frame. */
export const SNAPSHOT_WINDOW_BYTES = 64 * 1024 * 1024;

export interface CommitPositionWire { sequence: number; index: number }
export interface TimelineWire { id: string; from: CommitPositionWire }
export interface RawRecord { position: CommitPositionWire; bytes: Buffer }
export interface SnapshotManifestWire {
  version: number; brain_id: string; generation: number; engine_format_version: number; schema_version: number;
  keys: number; bytes: number; tags: Record<string, { keys: number; sha256: string }>;
  relations?: Record<string, { rows: number; sha256: string }>; created_at_us: number;
}
export interface SnapshotFileWire { name: string; bytes: number; sha256: string }

/** A replication frame or transfer this follower refuses; nothing of it is applied or installed. */
const bad = (why: string): never => {
  throw opError('owner_ipc_protocol', `A replication frame was refused (${why}), so nothing of it was applied or installed.`,
    'Start the transfer again from the primary; if it repeats, the two hosts run different gbrain builds.',
    { reason: 'frame_malformed', retryable: false, detail: `member=follower via=served why=${why}` });
};
const U32_MAX = 0xffff_ffff;
const isU64 = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isI64 = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isHex = (v: unknown, len: number): v is string => typeof v === 'string' && v.length === len && /^[0-9a-f]+$/.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const before = (a: CommitPositionWire, b: CommitPositionWire) => a.sequence < b.sequence || (a.sequence === b.sequence && a.index < b.index);

function position(v: unknown, what: string): CommitPositionWire {
  if (!isObject(v) || !isU64(v.sequence) || !isU64(v.index) || (v.index as number) > U32_MAX) return bad(`${what} is not a commit position`);
  return { sequence: v.sequence as number, index: v.index as number };
}

function lineageOf(v: unknown): TimelineWire[] {
  if (!Array.isArray(v)) return bad('lineage');
  return v.map((t, i) => {
    if (!isObject(t) || typeof t.id !== 'string' || t.id === '') return bad(`lineage[${i}]`);
    return { id: t.id, from: position(t.from, `lineage[${i}].from`) };
  });
}

// ---- records ----

export function encodeReplRecords(input: { id: number; seq: number; brainId: string; lineage: TimelineWire[]; records: RawRecord[] }):
  { header: Record<string, unknown>; tail: Buffer } {
  let off = 0;
  const records = input.records.map(r => { const slot = { sequence: r.position.sequence, index: r.position.index, off, len: r.bytes.length }; off += r.bytes.length; return slot; });
  return {
    header: { t: 'repl_records', id: input.id, seq: input.seq, brain_id: input.brainId,
      lineage: input.lineage.map(t => ({ id: t.id, from: { sequence: t.from.sequence, index: t.from.index } })), records },
    tail: Buffer.concat(input.records.map(r => r.bytes)),
  };
}

/** The arguments of `Follower::apply_raw`, or a refusal; record bytes are views of the frame's tail, unchanged. */
export function decodeReplRecords(header: Record<string, unknown>, tail: Buffer | null):
  { id: number; seq: number; brainId: string; lineage: TimelineWire[]; records: RawRecord[] } {
  if (header.t !== 'repl_records') return bad('type');
  if (!isU64(header.id) || !isU64(header.seq)) return bad('id or seq');
  if (typeof header.brain_id !== 'string' || header.brain_id === '') return bad('brain_id');
  const lineage = lineageOf(header.lineage);
  if (!Array.isArray(header.records) || header.records.length === 0) return bad('records');
  const body = tail ?? Buffer.alloc(0);
  let next = 0;
  let last: CommitPositionWire | null = null;
  const records = header.records.map((r, i): RawRecord => {
    const p = position(r, `records[${i}]`);
    const slot = r as Record<string, unknown>;
    if (!isU64(slot.off) || !isU64(slot.len)) return bad(`records[${i}] slice`);
    if (slot.off !== next) return bad(`records[${i}] does not start where the last one ended`);
    if ((slot.off as number) + (slot.len as number) > body.length) return bad(`records[${i}] is past the tail`);
    if (last && !before(last, p)) return bad(`records[${i}] is not after the record before it`);
    last = p;
    next = (slot.off as number) + (slot.len as number);
    return { position: p, bytes: body.subarray(slot.off as number, next) };
  });
  if (next !== body.length) return bad('the records do not cover the tail');
  return { id: header.id as number, seq: header.seq as number, brainId: header.brain_id, lineage, records };
}

export function encodeReplAck(input: { id: number; seq: number } & ({ ok: true; applied?: number; skipped?: number; cursor: CommitPositionWire } | { ok: false; error: unknown })): Record<string, unknown> {
  return { t: 'repl_ack', ...input };
}

// ---- replica acks ----

export function encodeReplFollow(input: { id: number; cursor: CommitPositionWire | null; replica?: string; lineage?: TimelineWire[] }): Record<string, unknown> {
  return {
    t: 'repl_follow', id: input.id, cursor: input.cursor ? { sequence: input.cursor.sequence, index: input.cursor.index } : null,
    ...(input.replica !== undefined ? { replica: input.replica } : {}),
    ...(input.lineage !== undefined ? { lineage: input.lineage.map(t => ({ id: t.id, from: { sequence: t.from.sequence, index: t.from.index } })) } : {}),
  };
}

/** `repl_follow`, or a refusal. A frame without `replica` / `lineage` (an older follower) decodes with them absent. */
export function decodeReplFollow(header: Record<string, unknown>): { cursor: CommitPositionWire | null; replica?: string; lineage?: TimelineWire[] } {
  if (header.t !== 'repl_follow') return bad('type');
  const cursor = header.cursor === null || header.cursor === undefined ? null : position(header.cursor, 'cursor');
  if (header.replica !== undefined && (typeof header.replica !== 'string' || !REPLICA_ID.test(header.replica))) return bad('replica');
  const lineage = header.lineage === undefined || header.lineage === null ? undefined : lineageOf(header.lineage);
  return { cursor, ...(header.replica !== undefined ? { replica: header.replica as string } : {}), ...(lineage ? { lineage } : {}) };
}

export function encodeReplMark(acked: CommitPositionWire): Record<string, unknown> {
  return { t: 'repl_mark', acked: { sequence: acked.sequence, index: acked.index } };
}

export function decodeReplMark(header: Record<string, unknown>): CommitPositionWire {
  if (header.t !== 'repl_mark') return bad('type');
  return position(header.acked, 'acked');
}

export function encodeReplDetach(replica: string, reason: string): Record<string, unknown> {
  return { t: 'repl_detach', replica, reason };
}

/** `repl_detach`, or a refusal: a replica id and a reason of at most 512 characters. */
export function decodeReplDetach(header: Record<string, unknown>): { replica: string; reason: string } {
  if (header.t !== 'repl_detach') return bad('type');
  if (typeof header.replica !== 'string' || !REPLICA_ID.test(header.replica)) return bad('replica');
  if (typeof header.reason !== 'string' || header.reason === '' || header.reason.length > 512) return bad('reason');
  return { replica: header.replica, reason: header.reason };
}

// ---- snapshot ----

/** The store's `SnapshotManifest::validate`, plus the store's unknown-field refusal, on the wire form. */
export function checkManifest(v: unknown): SnapshotManifestWire {
  if (!isObject(v)) return bad('manifest');
  const allowed = new Set(['version', 'brain_id', 'generation', 'engine_format_version', 'schema_version', 'keys', 'bytes', 'tags', 'relations', 'created_at_us']);
  for (const key of Object.keys(v)) if (!allowed.has(key)) return bad(`manifest field ${key}`);
  if (v.version !== SNAPSHOT_MANIFEST_VERSION) return bad('manifest version');
  if (typeof v.brain_id !== 'string' || v.brain_id === '') return bad('manifest brain_id');
  for (const key of ['generation', 'keys', 'bytes'] as const) if (!isU64(v[key])) return bad(`manifest ${key}`);
  for (const key of ['engine_format_version', 'schema_version'] as const) if (!isU64(v[key]) || (v[key] as number) > U32_MAX) return bad(`manifest ${key}`);
  if (!isI64(v.created_at_us)) return bad('manifest created_at_us');
  if (!isObject(v.tags)) return bad('manifest tags');
  let total = 0;
  for (const [tag, digest] of Object.entries(v.tags)) {
    if (!isHex(tag, 2) || !isObject(digest) || !isU64(digest.keys) || !isHex(digest.sha256, 64) || Object.keys(digest).length !== 2) return bad('manifest tags');
    total += digest.keys as number;
  }
  if (total !== v.keys) return bad('manifest keys');
  if (v.relations !== undefined) {
    if (!isObject(v.relations)) return bad('manifest relations');
    for (const [name, digest] of Object.entries(v.relations)) {
      if (name === '' || !isObject(digest) || !isU64(digest.rows) || !isHex(digest.sha256, 64) || Object.keys(digest).length !== 2) return bad('manifest relations');
    }
  }
  return v as unknown as SnapshotManifestWire;
}

export function encodeSnapshotBegin(input: { id: number; xfer: string; manifest: SnapshotManifestWire; chunkBytes?: number; files: SnapshotFileWire[] }): Record<string, unknown> {
  return { t: 'repl_snap_begin', id: input.id, xfer: input.xfer, manifest: input.manifest, chunk_bytes: input.chunkBytes ?? SNAPSHOT_CHUNK_BYTES, files: input.files };
}

export function decodeSnapshotBegin(header: Record<string, unknown>):
  { id: number; xfer: string; manifest: SnapshotManifestWire; chunkBytes: number; files: SnapshotFileWire[] } {
  if (header.t !== 'repl_snap_begin' || !isU64(header.id)) return bad('type or id');
  if (typeof header.xfer !== 'string' || header.xfer === '' || header.xfer.length > 64) return bad('xfer');
  const manifest = checkManifest(header.manifest);
  if (!isU64(header.chunk_bytes) || header.chunk_bytes === 0 || (header.chunk_bytes as number) > SNAPSHOT_CHUNK_MAX_BYTES) return bad('chunk_bytes');
  if (!Array.isArray(header.files) || header.files.length !== SNAPSHOT_FILES.length) return bad('files');
  const files = header.files.map((f, i): SnapshotFileWire => {
    if (!isObject(f) || f.name !== SNAPSHOT_FILES[i] || !isU64(f.bytes) || !isHex(f.sha256, 64)) return bad(`files[${i}]`);
    return { name: f.name as string, bytes: f.bytes as number, sha256: f.sha256 as string };
  });
  return { id: header.id as number, xfer: header.xfer, manifest, chunkBytes: header.chunk_bytes as number, files };
}

export function encodeSnapshotChunk(input: { id: number; xfer: string; file: string; off: number; bytes: Buffer }): { header: Record<string, unknown>; tail: Buffer } {
  return { header: { t: 'repl_snap_chunk', id: input.id, xfer: input.xfer, file: input.file, off: input.off }, tail: input.bytes };
}

export function decodeSnapshotChunk(header: Record<string, unknown>, tail: Buffer | null): { id: number; xfer: string; file: string; off: number; bytes: Buffer } {
  if (header.t !== 'repl_snap_chunk' || !isU64(header.id) || typeof header.xfer !== 'string' || typeof header.file !== 'string' || !isU64(header.off)) return bad('chunk header');
  return { id: header.id as number, xfer: header.xfer, file: header.file, off: header.off as number, bytes: tail ?? Buffer.alloc(0) };
}

export function encodeSnapshotEnd(input: { id: number; xfer: string }): Record<string, unknown> {
  return { t: 'repl_snap_end', id: input.id, xfer: input.xfer };
}

export function encodeSnapshotWindow(input: { id: number; xfer: string; file: string; through: number }): Record<string, unknown> {
  return { t: 'repl_snap_window', id: input.id, xfer: input.xfer, file: input.file, through: input.through };
}

/**
 * The follower side of one snapshot transfer: writes each file into `dir` (which must be empty), in order, checking
 * sizes and digests, and writes SNAPSHOT.json last. `end` returns the directory and manifest for
 * `Follower::install_snapshot(dir, Some(&manifest))`. Any refusal leaves the directory for the caller to remove; nothing
 * is installed.
 */
export class SnapshotReceiver {
  private plan: ReturnType<typeof decodeSnapshotBegin> | null = null;
  private fileIndex = 0;
  private written = 0;
  private hash: Hash | null = null;
  private fd: number | null = null;
  private manifestBytes: Buffer[] = [];
  private failed = false;

  constructor(private readonly opts: { dir: string; expectBrainId: string; maxBytes: number }) {}

  begin(plan: ReturnType<typeof decodeSnapshotBegin>): void {
    if (this.plan) return bad('a second begin');
    if (plan.manifest.brain_id !== this.opts.expectBrainId) return bad('the snapshot is of another brain');
    const total = plan.files.reduce((sum, f) => sum + f.bytes, 0);
    if (total > this.opts.maxBytes) return bad(`the snapshot is ${total} bytes, over the ${this.opts.maxBytes} this follower accepts`);
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    if (readdirSync(this.opts.dir).length) return bad('the staging directory is not empty');
    this.plan = plan;
    this.open();
  }

  /** What the follower has written of the current file (for `repl_snap_window`). */
  window(): { file: string; through: number } | null {
    return this.plan && this.fileIndex < this.plan.files.length ? { file: this.plan.files[this.fileIndex]!.name, through: this.written } : null;
  }

  chunk(c: ReturnType<typeof decodeSnapshotChunk>): void {
    try {
      const plan = this.plan ?? bad('a chunk before begin');
      if (this.failed) bad('the transfer already failed');
      if (c.xfer !== plan.xfer) bad('a chunk of another transfer');
      if (c.bytes.length > plan.chunkBytes) bad('a chunk larger than chunk_bytes');
      // Advance past files that are complete (an empty file has no chunk of its own beyond offset 0).
      while (this.fileIndex < plan.files.length && c.file !== plan.files[this.fileIndex]!.name && this.written === plan.files[this.fileIndex]!.bytes) this.finishFile();
      const file = plan.files[this.fileIndex] ?? bad('a chunk after the last file');
      if (c.file !== file.name) bad(`a chunk of ${c.file} while ${file.name} is incomplete`);
      if (c.off !== this.written) bad(`a chunk at ${c.off} of ${file.name}, which is written to ${this.written}`);
      if (this.written + c.bytes.length > file.bytes) bad(`a chunk past the end of ${file.name}`);
      this.hash!.update(c.bytes);
      if (file.name === 'SNAPSHOT.json') this.manifestBytes.push(Buffer.from(c.bytes));
      else for (let at = 0; at < c.bytes.length;) at += writeSync(this.fd!, c.bytes, at, c.bytes.length - at, this.written + at);
      this.written += c.bytes.length;
    } catch (error) { this.failed = true; this.closeFd(); throw error; }
  }

  end(frame: Record<string, unknown>): { dir: string; manifest: SnapshotManifestWire } {
    try {
      const plan = this.plan ?? bad('end before begin');
      if (frame.t !== 'repl_snap_end' || frame.xfer !== plan.xfer) bad('end of another transfer');
      if (this.failed) bad('the transfer already failed');
      while (this.fileIndex < plan.files.length) this.finishFile();
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(this.manifestBytes).toString('utf8')); } catch { parsed = null; }
      if (JSON.stringify(sortKeys(parsed)) !== JSON.stringify(sortKeys(plan.manifest))) bad('SNAPSHOT.json is not the begin manifest');
      // SNAPSHOT.json last: a directory without it is an incomplete snapshot.
      writeFileSync(join(this.opts.dir, 'SNAPSHOT.json'), Buffer.concat(this.manifestBytes), { mode: 0o600, flag: 'wx' });
      return { dir: this.opts.dir, manifest: plan.manifest };
    } catch (error) { this.failed = true; this.closeFd(); throw error; }
  }

  private open(): void {
    const file = this.plan!.files[this.fileIndex]!;
    this.hash = createHash('sha256');
    this.written = 0;
    this.fd = file.name === 'SNAPSHOT.json' ? null : openSync(join(this.opts.dir, file.name), 'wx', 0o600);
  }

  private finishFile(): void {
    const file = this.plan!.files[this.fileIndex]!;
    if (this.written !== file.bytes) bad(`${file.name} is ${this.written} bytes, not ${file.bytes}`);
    if (this.hash!.digest('hex') !== file.sha256) bad(`${file.name} does not match its sha256 digest`);
    if (this.fd !== null) { fsyncSync(this.fd); this.closeFd(); }
    this.fileIndex++;
    if (this.fileIndex < this.plan!.files.length) this.open();
  }

  private closeFd(): void { if (this.fd !== null) { closeSync(this.fd); this.fd = null; } }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObject(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
}
