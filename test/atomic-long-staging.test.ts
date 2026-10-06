import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicStagingPath, atomicWriteFileSync, validateAtomicStagingPath } from '../src/core/atomic-write.ts';
import { assertRecoveryStagingAbsent, cleanupRecoveryStaging } from '../src/core/persistence/staging.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'gbrain-long-stage-')); dirs.push(dir); return dir; }

test('journaled publication replaces a valid 215-byte target name (#5861)', () => {
  const dir = fixture();
  const target = join(dir, 'm'.repeat(212) + '.md');
  writeFileSync(target, 'original');
  const stage = atomicStagingPath(target);
  expect(Buffer.byteLength(basename(stage))).toBeLessThan(255);
  let flushed = false;
  atomicWriteFileSync(target, 'replacement', { stagingPath: stage, durable: true, afterStagingFlush() {
    flushed = true;
    expect(readFileSync(stage, 'utf8')).toBe('replacement');
    expect(readFileSync(target, 'utf8')).toBe('original');
  } });
  expect(flushed).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe('replacement');
  expect(readdirSync(dir)).toEqual([basename(target)]);
});

test('ordinary atomic writes replace a valid 253-byte target name (#5861)', () => {
  const dir = fixture();
  const target = join(dir, 'm'.repeat(250) + '.md');
  writeFileSync(target, 'original');
  atomicWriteFileSync(target, 'replacement');
  expect(readFileSync(target, 'utf8')).toBe('replacement');
  expect(readdirSync(dir)).toEqual([basename(target)]);
});

test('short stages stay bound to one target and historical stages stay valid', () => {
  const dir = fixture();
  const target = join(dir, 'page.md');
  const stage = atomicStagingPath(target);
  expect(() => validateAtomicStagingPath(target, stage)).not.toThrow();
  expect(() => validateAtomicStagingPath(join(dir, 'other.md'), stage)).toThrow();
  expect(() => validateAtomicStagingPath(target, join(fixture(), basename(stage)))).toThrow();
  expect(() => validateAtomicStagingPath(target, `${target}.tmp.00000000-0000-0000-0000-000000000000`)).not.toThrow();
  expect(() => validateAtomicStagingPath(target, `${stage}.extra`)).toThrow();
});

test('recovery cleanup removes matching short stages, keeps foreign bytes, and treats impossible legacy leaves as absent', () => {
  const dir = fixture();
  const target = join(dir, 'm'.repeat(212) + '.md');
  writeFileSync(target, 'prior');
  const stage = atomicStagingPath(target);
  const hash = createHash('sha256').update('ready').digest('hex');
  const record = { path: target, root: dir, staging: { publication: { path: stage, hash, bytes: 5 } } };
  writeFileSync(stage, 'wrong');
  expect(() => cleanupRecoveryStaging(record)).toThrow('unexpected');
  expect(readFileSync(stage, 'utf8')).toBe('wrong');
  writeFileSync(stage, 'ready');
  cleanupRecoveryStaging(record);
  expect(() => assertRecoveryStagingAbsent(record)).not.toThrow();
  const legacy = { ...record, staging: { publication: { ...record.staging.publication,
    path: `${target}.tmp.00000000-0000-0000-0000-000000000000` } } };
  expect(() => cleanupRecoveryStaging(legacy)).not.toThrow();
  expect(() => assertRecoveryStagingAbsent(legacy)).not.toThrow();
  expect(readFileSync(target, 'utf8')).toBe('prior');
});
