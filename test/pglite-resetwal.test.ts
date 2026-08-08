/**
 * Unit tests for the pg_resetwal port (src/core/pglite-resetwal.ts).
 *
 * Everything here runs on SYNTHETIC PG17 layouts (hand-built pg_control
 * buffers) — fast, parallel-safe, no PGLite. The real-engine proof (corrupt a
 * real brain's WAL → reopen → row readable) lives in
 * test/pglite-wal-repair.serial.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resetWal,
  crc32c,
  parseWalSegNo,
  xlogFileName,
  WalResetUnsupportedError,
} from '../src/core/pglite-resetwal.ts';

const SEG_SIZE = 1024 * 1024; // 1MB — valid (power of two, divides 2^32), fast to write

const OFF = {
  systemIdentifier: 0,
  pgControlVersion: 8,
  state: 16,
  checkPoint: 32,
  checkPointCopyRedo: 40,
  checkPointCopyThisTimeLineID: 48,
  xlogBlcksz: 224,
  xlogSegSize: 228,
  crc: 288,
} as const;

function makeControl(opts?: { version?: number; segSize?: number; blcksz?: number; tli?: number; redoSegNo?: bigint }): Buffer {
  const control = Buffer.alloc(8192);
  control.writeBigUInt64LE(0x1122334455667788n, OFF.systemIdentifier);
  control.writeUInt32LE(opts?.version ?? 1700, OFF.pgControlVersion);
  control.writeUInt32LE(opts?.tli ?? 1, OFF.checkPointCopyThisTimeLineID);
  control.writeUInt32LE(opts?.blcksz ?? 8192, OFF.xlogBlcksz);
  control.writeUInt32LE(opts?.segSize ?? SEG_SIZE, OFF.xlogSegSize);
  const redoSegNo = opts?.redoSegNo ?? 3n;
  control.writeBigUInt64LE(redoSegNo * BigInt(opts?.segSize ?? SEG_SIZE) + 40n, OFF.checkPointCopyRedo);
  control.writeUInt32LE(crc32c([control.subarray(0, OFF.crc)]), OFF.crc); // valid CRC
  return control;
}

function makeLayout(opts?: Parameters<typeof makeControl>[0] & { pgVersion?: string; segments?: string[] }): string {
  const dir = mkdtempSync(join(tmpdir(), 'resetwal-'));
  writeFileSync(join(dir, 'PG_VERSION'), `${opts?.pgVersion ?? '17'}\n`);
  mkdirSync(join(dir, 'global'), { recursive: true });
  writeFileSync(join(dir, 'global', 'pg_control'), makeControl(opts));
  mkdirSync(join(dir, 'base'), { recursive: true });
  mkdirSync(join(dir, 'pg_wal', 'archive_status'), { recursive: true });
  for (const seg of opts?.segments ?? []) {
    writeFileSync(join(dir, 'pg_wal', seg), Buffer.alloc(1024, 0xaa));
  }
  return dir;
}

describe('resetWal — validation refusals (fail-closed)', () => {
  test('refuses PG_VERSION 16', async () => {
    const dir = makeLayout({ pgVersion: '16' });
    await expect(resetWal(dir)).rejects.toThrow(WalResetUnsupportedError);
  });

  test('refuses missing PG_VERSION', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resetwal-'));
    await expect(resetWal(dir)).rejects.toThrow(WalResetUnsupportedError);
  });

  test('refuses wrong pg_control size', async () => {
    const dir = makeLayout();
    writeFileSync(join(dir, 'global', 'pg_control'), Buffer.alloc(100));
    await expect(resetWal(dir)).rejects.toThrow(/pg_control size/);
  });

  test('refuses wrong pg_control version', async () => {
    const dir = makeLayout({ version: 1600 });
    await expect(resetWal(dir)).rejects.toThrow(/pg_control version/);
  });

  test('refuses non-power-of-two WAL segment size', async () => {
    const dir = makeLayout({ segSize: 3 * 1024 * 1024 });
    await expect(resetWal(dir)).rejects.toThrow(/segment size/);
  });

  test('refuses unsupported WAL block size', async () => {
    const dir = makeLayout({ blcksz: 4096 });
    await expect(resetWal(dir)).rejects.toThrow(/block size/);
  });

  test('refuses a pg_control whose stored CRC does not verify (F6: no laundering corrupt counters)', async () => {
    const dir = makeLayout();
    // A structurally-valid control (right size/version/seg/block) but with a
    // damaged checkpoint copy and a STALE crc — real pg_resetwal refuses this.
    const control = readFileSync(join(dir, 'global', 'pg_control'));
    control.writeBigUInt64LE(0xdeadbeefn, 56); // trash a checkpointCopy field
    // leave the old CRC in place → mismatch
    writeFileSync(join(dir, 'global', 'pg_control'), control);
    await expect(resetWal(dir)).rejects.toThrow(/CRC mismatch/);
  });
});

describe('resetWal — byte surgery on a synthetic PG17 layout', () => {
  test('resets WAL: pid removed, old segments gone, fresh checkpoint segment + CRC-valid control', async () => {
    const oldSegs = [xlogFileName(1, 3n, SEG_SIZE), xlogFileName(1, 4n, SEG_SIZE)];
    const dir = makeLayout({ redoSegNo: 3n, segments: oldSegs });
    writeFileSync(join(dir, 'postmaster.pid'), '12345\n');
    writeFileSync(join(dir, 'pg_wal', 'archive_status', `${oldSegs[0]}.ready`), '');
    mkdirSync(join(dir, 'pg_wal', 'summaries'), { recursive: true });
    writeFileSync(join(dir, 'pg_wal', 'summaries', `${'0'.repeat(40)}.summary`), '');

    const result = await resetWal(dir);

    // Stale run state + old WAL removed.
    expect(existsSync(join(dir, 'postmaster.pid'))).toBe(false);
    for (const seg of oldSegs) {
      expect(existsSync(join(dir, 'pg_wal', seg))).toBe(false);
    }
    expect(readdirSync(join(dir, 'pg_wal', 'archive_status'))).toEqual([]);
    expect(readdirSync(join(dir, 'pg_wal', 'summaries'))).toEqual([]);

    // newSegNo = max(redo=3, existing max=4) + 1 = 5.
    expect(result.resetSegment).toBe(xlogFileName(1, 5n, SEG_SIZE));
    expect(result.timelineId).toBe(1);
    expect(result.walSegSize).toBe(SEG_SIZE);

    const segPath = join(dir, 'pg_wal', result.resetSegment);
    expect(existsSync(segPath)).toBe(true);
    expect(statSync(segPath).size).toBe(SEG_SIZE);
    const wal = readFileSync(segPath);
    expect(wal.readUInt16LE(0)).toBe(0xd116); // XLOG_PAGE_MAGIC
    expect(wal.readUInt16LE(2) & 0x0002).toBe(0x0002); // XLP_LONG_HEADER

    // Control: shutdown state + self-consistent CRC32C over bytes 0..288.
    const control = readFileSync(join(dir, 'global', 'pg_control'));
    expect(control.length).toBe(8192);
    expect(control.readInt32LE(OFF.state)).toBe(1); // DB_SHUTDOWNED
    expect(control.readUInt32LE(OFF.crc)).toBe(crc32c([control.subarray(0, OFF.crc)]));
    // checkPoint points into the new segment.
    const checkPoint = control.readBigUInt64LE(OFF.checkPoint);
    expect(checkPoint / BigInt(SEG_SIZE)).toBe(5n);

    // No torn tmp files left behind (atomic-write hygiene).
    expect(readdirSync(join(dir, 'pg_wal')).filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(readdirSync(join(dir, 'global')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  test('works on an EMPTY pg_wal (the whole-dir-rename backup path) and numbers off pg_control alone', async () => {
    const dir = makeLayout({ redoSegNo: 7n, segments: [] });
    const result = await resetWal(dir);
    // No existing segments — newSegNo = redo(7) + 1.
    expect(result.resetSegment).toBe(xlogFileName(1, 8n, SEG_SIZE));
    expect(existsSync(join(dir, 'pg_wal', 'archive_status'))).toBe(true);
  });

  test('is idempotent: a second run converges (numbering keeps moving forward)', async () => {
    const dir = makeLayout({ redoSegNo: 3n });
    const first = await resetWal(dir);
    const second = await resetWal(dir);
    const firstNo = parseWalSegNo(first.resetSegment, SEG_SIZE)!;
    const secondNo = parseWalSegNo(second.resetSegment, SEG_SIZE)!;
    expect(secondNo).toBeGreaterThan(firstNo);
    // Exactly one segment remains after each run.
    const segs = readdirSync(join(dir, 'pg_wal')).filter((f) => /^[0-9A-F]{24}$/.test(f));
    expect(segs).toEqual([second.resetSegment]);
  });
});

describe('WAL segment name helpers', () => {
  test('parseWalSegNo / xlogFileName round-trip', () => {
    for (const segNo of [0n, 1n, 255n, 4096n, 0x1_0000_0000n / BigInt(SEG_SIZE) + 7n]) {
      const name = xlogFileName(1, segNo, SEG_SIZE);
      expect(name).toMatch(/^[0-9A-F]{24}$/);
      expect(parseWalSegNo(name, SEG_SIZE)).toBe(segNo);
    }
  });

  test('parseWalSegNo rejects non-segment names', () => {
    expect(parseWalSegNo('archive_status', SEG_SIZE)).toBeNull();
    expect(parseWalSegNo('000000010000000000000001.partial', SEG_SIZE)).toBeNull();
    expect(parseWalSegNo('lowercase0000000000000001', SEG_SIZE)).toBeNull();
  });

  test('crc32c matches a known vector', () => {
    // CRC-32C of ASCII "123456789" is 0xE3069283 (Castagnoli test vector).
    expect(crc32c([Buffer.from('123456789')])).toBe(0xe3069283);
  });
});
