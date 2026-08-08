/**
 * pg_resetwal for PGLite NodeFS data dirs, in TypeScript.
 *
 * Ported from electric-sql/pglite PR #994 by @yestheboxer (Apache-2.0,
 * https://github.com/electric-sql/pglite/pull/994 — closed upstream as
 * "should be a separate tool"; gbrain is that tool). The byte surgery is
 * regression-tested upstream (create DB → insert → corrupt WAL → reopen →
 * row readable) and deliberately NOT "improved" here.
 *
 * What it does: for a data dir whose WAL/checkpoint state is torn (unclean
 * shutdown — the #223/#1670/#2575 class), rewrite `global/pg_control` with a
 * fresh shutdown checkpoint and emit one replacement WAL segment containing
 * that checkpoint record, so Postgres-in-WASM can start without replaying the
 * torn WAL. Data files are preserved; transactions not checkpointed before
 * the corruption are lost (the standard pg_resetwal caveat).
 *
 * LAYOUT COUPLING: the `OFF` table below is the PostgreSQL 17 ControlFileData
 * layout (`PG_CONTROL_VERSION` 1700) that @electric-sql/pglite 0.4.x ships.
 * Any pglite bump PAST PG17 must revisit this file together with the
 * `./vector` export blocker — see the TODOS.md "pglite upgrade blocker" entry.
 * Every unsupported shape throws `WalResetUnsupportedError` (fail-closed).
 *
 * gbrain adaptation on top of the upstream port: both file writes (the new
 * WAL segment AND pg_control) go through tmp-file + fsync(tmp) + rename +
 * fsync(parent dir) instead of upstream's in-place `writeFileSynced` — a
 * mid-write kill (SIGKILL, `process.exit(124)` from a read-only command
 * timeout) leaves old-or-new per file, never a torn file. Write ORDER stays
 * upstream's (segment first, control last): the pair is not atomic across
 * files, but a kill between them leaves pg_control pointing at old state, so
 * startup still fails and the next repair attempt re-runs this (idempotent).
 * A torn pair can never claim success.
 */
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Exported: pglite-repair.ts validates against the same layout literals — the
// PG17 coupling the TODOS "pglite upgrade blocker" entry says moves together.
export const PG_CONTROL_FILE_SIZE = 8192;
const WAL_SEGMENT_RE = /^[0-9A-F]{24}(?:\.partial)?$/;
/** Is this filename a WAL segment (incl. `.partial`)? Shared layout predicate. */
export function isWalSegmentName(name: string): boolean {
  return WAL_SEGMENT_RE.test(name);
}
const PG_CONTROL_VERSION = 1700;
const DB_SHUTDOWNED = 1;
const XLOG_BLCKSZ = 8192;
const MIN_WAL_SEG_SIZE = 1024 * 1024;
// Postgres-general max is 1GB, but this port targets pglite (ships 16MB
// segments). A corrupt-but-plausible control field must not be able to drive
// a 1GB zero-fill allocation + write on the repair path (perf review) — cap
// at 64MB and fail closed above it.
const MAX_WAL_SEG_SIZE = 64 * 1024 * 1024;
const SIZE_OF_XLOG_LONG_PHD = 40;
const SIZE_OF_XLOG_RECORD = 24;
const SIZE_OF_CHECKPOINT = 88;
const XLOG_PAGE_MAGIC = 0xd116;
const XLP_LONG_HEADER = 0x0002;
const XLOG_CHECKPOINT_SHUTDOWN = 0x00;
const XLR_BLOCK_ID_DATA_SHORT = 255;
const RM_XLOG_ID = 0;

// PostgreSQL 17 ControlFileData offsets (pglite 0.4.x layout).
const OFF = {
  systemIdentifier: 0,
  pgControlVersion: 8,
  state: 16,
  time: 24,
  checkPoint: 32,
  checkPointCopy: 40,
  checkPointCopyRedo: 40,
  checkPointCopyThisTimeLineID: 48,
  checkPointCopyTime: 104,
  minRecoveryPoint: 136,
  minRecoveryPointTLI: 144,
  backupStartPoint: 152,
  backupEndPoint: 160,
  backupEndRequired: 168,
  walLevel: 172,
  walLogHints: 176,
  maxConnections: 180,
  maxWorkerProcesses: 184,
  maxWalSenders: 188,
  maxPreparedXacts: 192,
  maxLocksPerXact: 196,
  trackCommitTimestamp: 200,
  xlogBlcksz: 224,
  xlogSegSize: 228,
  crc: 288,
} as const;

/** The dir does not look like a PG17 pglite layout — refuse to touch it. */
export class WalResetUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalResetUnsupportedError';
  }
}

export interface WalResetResult {
  /** Filename of the replacement WAL segment written (24 hex chars). */
  resetSegment: string;
  timelineId: number;
  walSegSize: number;
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  crcTable[i] = crc >>> 0;
}

export function crc32c(chunks: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const chunk of chunks) {
    for (const byte of chunk) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUInt64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

function writeUInt64LE(buf: Buffer, value: bigint, offset: number): void {
  buf.writeBigUInt64LE(value, offset);
}

export function parseWalSegNo(fileName: string, walSegSize: number): bigint | null {
  if (!/^[0-9A-F]{24}$/.test(fileName)) return null;
  const log = BigInt(`0x${fileName.slice(8, 16)}`);
  const seg = BigInt(`0x${fileName.slice(16, 24)}`);
  return log * (0x100000000n / BigInt(walSegSize)) + seg;
}

export function xlogFileName(tli: number, segNo: bigint, walSegSize: number): string {
  const segmentsPerXlogId = 0x100000000n / BigInt(walSegSize);
  const log = segNo / segmentsPerXlogId;
  const seg = segNo % segmentsPerXlogId;
  return [
    tli.toString(16).toUpperCase().padStart(8, '0'),
    log.toString(16).toUpperCase().padStart(8, '0'),
    seg.toString(16).toUpperCase().padStart(8, '0'),
  ].join('');
}

async function unlinkIfExists(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/**
 * Atomic + durable single-file write: tmp in the same dir → fsync(tmp) →
 * rename over the target → fsync(parent dir). A kill at any instant leaves
 * either the old file or the new file, never a torn one; the dir fsync makes
 * the rename itself survive power loss. (Directory fsync is best-effort —
 * some filesystems refuse it; the rename is still atomic without it.)
 */
export async function writeFileAtomicSynced(dir: string, name: string, data: Buffer): Promise<void> {
  const tmpName = `.${name}.tmp-${process.pid}`;
  const tmpPath = join(dir, tmpName);
  // 'wx' (exclusive create, never follows an existing symlink) after clearing
  // any stale tmp: a pre-planted symlink at the predictable tmp path must not
  // redirect the write (security review).
  await unlinkIfExists(tmpPath);
  const file = await open(tmpPath, 'wx');
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmpPath, join(dir, name));
  try {
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Best-effort: some platforms/filesystems reject fsync on a directory fd.
  }
}

/**
 * Reset WAL in place for a PG17 pglite NodeFS data dir. Preserves data files;
 * discards the (torn) WAL tail. Throws `WalResetUnsupportedError` when the
 * layout does not match what this port understands; throws raw fs errors on
 * I/O failure. Idempotent: re-running after a partial attempt converges.
 */
export async function resetWal(rootDir: string): Promise<WalResetResult> {
  await unlinkIfExists(join(rootDir, 'postmaster.pid'));

  let pgVersion: string;
  try {
    pgVersion = (await readFile(join(rootDir, 'PG_VERSION'), 'utf8')).trim();
  } catch {
    throw new WalResetUnsupportedError(`No readable PG_VERSION in ${rootDir}`);
  }
  if (pgVersion !== '17') {
    throw new WalResetUnsupportedError(`Cannot reset WAL for unsupported PG_VERSION ${pgVersion}`);
  }

  const controlPath = join(rootDir, 'global', 'pg_control');
  let control: Buffer;
  try {
    control = Buffer.from(await readFile(controlPath));
  } catch {
    throw new WalResetUnsupportedError(`No readable global/pg_control in ${rootDir}`);
  }
  if (control.length !== PG_CONTROL_FILE_SIZE) {
    throw new WalResetUnsupportedError(`Unexpected pg_control size ${control.length}`);
  }
  if (control.readUInt32LE(OFF.pgControlVersion) !== PG_CONTROL_VERSION) {
    throw new WalResetUnsupportedError('Unsupported pg_control version');
  }
  // Verify the STORED CRC before trusting (and re-signing) the checkpoint copy
  // (adversarial review F6): a torn pg_control with an intact version field
  // but garbage checkpoint counters (nextXid/nextOid/...) would otherwise be
  // preserved verbatim and laundered under a fresh valid CRC — Postgres then
  // starts and corrupts silently (xid-wraparound class). Real pg_resetwal
  // refuses on CRC mismatch; so do we → the caller falls to the rebuild rung.
  const storedCrc = control.readUInt32LE(OFF.crc);
  if (crc32c([control.subarray(0, OFF.crc)]) !== storedCrc) {
    throw new WalResetUnsupportedError(
      'pg_control CRC mismatch — the control file itself is damaged; WAL reset ' +
      'would launder corrupt checkpoint counters. Rebuild the brain instead ' +
      '(`gbrain reinit-pglite`).',
    );
  }

  const walSegSize = control.readUInt32LE(OFF.xlogSegSize);
  const xlogBlcksz = control.readUInt32LE(OFF.xlogBlcksz);
  if (
    walSegSize < MIN_WAL_SEG_SIZE ||
    walSegSize > MAX_WAL_SEG_SIZE ||
    (walSegSize & (walSegSize - 1)) !== 0 ||
    0x100000000 % walSegSize !== 0
  ) {
    throw new WalResetUnsupportedError(`Unsupported WAL segment size ${walSegSize}`);
  }
  if (xlogBlcksz !== XLOG_BLCKSZ) {
    throw new WalResetUnsupportedError(`Unsupported WAL block size ${xlogBlcksz}`);
  }

  const tli = control.readUInt32LE(OFF.checkPointCopyThisTimeLineID);
  let newSegNo = readUInt64LE(control, OFF.checkPointCopyRedo) / BigInt(walSegSize);
  const walDir = join(rootDir, 'pg_wal');
  // Recreates pg_wal/archive_status when the whole pg_wal dir was renamed
  // away into the repair backup (pglite-repair.ts) — resetWal then starts
  // from an empty WAL dir and numbers the fresh segment off pg_control alone.
  await mkdir(join(walDir, 'archive_status'), { recursive: true });
  for (const file of await readdir(walDir)) {
    const segNo = parseWalSegNo(file, walSegSize);
    if (segNo !== null && segNo > newSegNo) {
      newSegNo = segNo;
    }
  }
  newSegNo += 1n;

  const redo = newSegNo * BigInt(walSegSize) + BigInt(SIZE_OF_XLOG_LONG_PHD);
  const now = BigInt(Math.floor(Date.now() / 1000));

  writeUInt64LE(control, redo, OFF.checkPointCopyRedo);
  writeUInt64LE(control, now, OFF.checkPointCopyTime);
  control.writeInt32LE(DB_SHUTDOWNED, OFF.state);
  writeUInt64LE(control, now, OFF.time);
  writeUInt64LE(control, redo, OFF.checkPoint);
  writeUInt64LE(control, 0n, OFF.minRecoveryPoint);
  control.writeUInt32LE(0, OFF.minRecoveryPointTLI);
  writeUInt64LE(control, 0n, OFF.backupStartPoint);
  writeUInt64LE(control, 0n, OFF.backupEndPoint);
  control.writeUInt8(0, OFF.backupEndRequired);
  control.writeInt32LE(0, OFF.walLevel);
  control.writeUInt8(0, OFF.walLogHints);
  control.writeInt32LE(100, OFF.maxConnections);
  control.writeInt32LE(8, OFF.maxWorkerProcesses);
  control.writeInt32LE(10, OFF.maxWalSenders);
  control.writeInt32LE(0, OFF.maxPreparedXacts);
  control.writeInt32LE(64, OFF.maxLocksPerXact);
  control.writeUInt8(0, OFF.trackCommitTimestamp);
  control.writeUInt32LE(crc32c([control.subarray(0, OFF.crc)]), OFF.crc);

  for (const file of await readdir(walDir)) {
    if (isWalSegmentName(file)) {
      await unlink(join(walDir, file));
    }
  }

  const archiveStatusDir = join(walDir, 'archive_status');
  if (existsSync(archiveStatusDir)) {
    for (const file of await readdir(archiveStatusDir)) {
      if (/^[0-9A-F]{24}(?:\.partial)?\.(?:ready|done)$/.test(file)) {
        await unlink(join(archiveStatusDir, file));
      }
    }
  }
  const walSummaryDir = join(walDir, 'summaries');
  if (existsSync(walSummaryDir)) {
    for (const file of await readdir(walSummaryDir)) {
      if (/^[0-9A-F]{40}\.summary$/.test(file)) {
        await unlink(join(walSummaryDir, file));
      }
    }
  }

  const wal = Buffer.alloc(walSegSize);
  wal.writeUInt16LE(XLOG_PAGE_MAGIC, 0);
  wal.writeUInt16LE(XLP_LONG_HEADER, 2);
  wal.writeUInt32LE(tli, 4);
  writeUInt64LE(wal, redo - BigInt(SIZE_OF_XLOG_LONG_PHD), 8);
  wal.writeUInt32LE(0, 16);
  writeUInt64LE(wal, readUInt64LE(control, OFF.systemIdentifier), 24);
  wal.writeUInt32LE(walSegSize, 32);
  wal.writeUInt32LE(XLOG_BLCKSZ, 36);

  const recordOffset = SIZE_OF_XLOG_LONG_PHD;
  const recordTotalLength = SIZE_OF_XLOG_RECORD + 2 + SIZE_OF_CHECKPOINT;
  wal.writeUInt32LE(recordTotalLength, recordOffset);
  wal.writeUInt32LE(0, recordOffset + 4);
  writeUInt64LE(wal, 0n, recordOffset + 8);
  wal.writeUInt8(XLOG_CHECKPOINT_SHUTDOWN, recordOffset + 16);
  wal.writeUInt8(RM_XLOG_ID, recordOffset + 17);
  wal.writeUInt16LE(0, recordOffset + 18);
  wal.writeUInt8(XLR_BLOCK_ID_DATA_SHORT, recordOffset + SIZE_OF_XLOG_RECORD);
  wal.writeUInt8(SIZE_OF_CHECKPOINT, recordOffset + SIZE_OF_XLOG_RECORD + 1);
  control.copy(
    wal,
    recordOffset + SIZE_OF_XLOG_RECORD + 2,
    OFF.checkPointCopy,
    OFF.checkPointCopy + SIZE_OF_CHECKPOINT,
  );

  const record = wal.subarray(recordOffset, recordOffset + recordTotalLength);
  const recordCrc = crc32c([
    record.subarray(SIZE_OF_XLOG_RECORD),
    record.subarray(0, 20),
  ]);
  wal.writeUInt32LE(recordCrc, recordOffset + 20);

  const resetSegment = xlogFileName(tli, newSegNo, walSegSize);
  // Segment FIRST, control LAST (upstream order — see header comment).
  await writeFileAtomicSynced(walDir, resetSegment, wal);
  await writeFileAtomicSynced(join(rootDir, 'global'), 'pg_control', control);

  return { resetSegment, timelineId: tli, walSegSize };
}
